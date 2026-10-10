/**
 * Rich text for text widgets and widget descriptions (DECISIONS D-019): a whitelist HTML
 * sanitiser plus `{{key}}` placeholder filling for live values.
 *
 * Runs in the browser inside the ThingsBoard widgets and in Node (unit tests, chat validation).
 *
 * Main exports and callers:
 * - `sanitizeHtml`: used by the builder's WYSIWYG editor (`builder/editors.ts`, on input, paste
 *   and blur), by `core/chat.ts` on chat-generated `html`/`description` settings, and by
 *   `render/widgets.ts` again at render time. Stored HTML is therefore never trusted as-is.
 * - `cleanStyle`: filters an inline `style` attribute.
 * - `placeholderKeys` / `fillPlaceholders` / `PLACEHOLDER_RE`: the text widget asks for the
 *   referenced keys' latest values and substitutes them (`render/widgets.ts`).
 * - `htmlToText`: plain-text version of rich text.
 *
 * Security model:
 * - Why string-based: it needs no DOM, so the same code runs in tests and in chat validation,
 *   and untrusted markup is never handed to a browser parser (no `innerHTML` on a detached
 *   element that could load images or run handlers) before it is clean.
 * - The input is scanned once, left to right. Output is REBUILT from scratch: every tag that
 *   survives is re-emitted with only the attributes we generate, all escaped. Nothing from the
 *   input is copied through verbatim except escaped text.
 * - Allowed: the tags in ALLOWED; the style properties in STYLE_PROPS with plain values;
 *   `href` on `<a>` only for http(s):// and mailto: (plus forced `target="_blank"` and
 *   `rel="noopener noreferrer"`); `align`, and `<font color/face/size>` converted to styles.
 * - Dropped: every other attribute (all `on*` handlers, `src`, `class`, `id`, `data-*`...),
 *   HTML comments, and unknown tags (their text content is kept, escaped). Tags in
 *   DROP_WITH_CONTENT are removed together with everything inside them.
 * - Output is well-formed: stray closing tags are ignored, closing a tag also closes tags opened
 *   inside it, and anything still open at the end is closed.
 * If you widen the whitelist, add a test and keep the "rebuild, never copy" rule.
 */

/** Tags kept (possibly renamed: font → span, strike → s). */
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'div', 'br', 'span', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre', 'hr', 'mark', 'font', 'sub', 'sup', 'small']);
/** Allowed tags that have no closing tag. */
const VOID = new Set(['br', 'hr']);
/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'textarea', 'select', 'noscript', 'title', 'head']);
/** CSS properties allowed in inline styles (text formatting only: no position, size or url()). */
const STYLE_PROPS = new Set([
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-align',
  'line-height',
  'letter-spacing',
  'padding-left',
  'margin-left',
]);
/** Pixel size for legacy `<font size="1..7">` (index = size attribute; 0 is unused). */
const FONT_SIZES = ['', '10px', '13px', '16px', '18px', '24px', '32px', '48px'];

/** Escapes text content. Existing entities (`&amp;`, `&#39;`...) are kept, not double-escaped. */
const escText = (s: string) => s.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Escapes a value for use inside a double-quoted attribute. */
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Parses the attribute part of a start tag into a lower-cased name → decoded value map.
 * Handles double-quoted, single-quoted, unquoted and value-less attributes. Values are
 * entity-decoded so later checks see what the browser would see (e.g. `javascript&#58;`).
 */
function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** D-028: out-of-range code points (e.g. `&#x110000;`) would throw a RangeError and break the whole page. */
const codePoint = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD');

/** Decodes numeric entities and the common named ones. `&amp;` is decoded last so `&amp;lt;` stays `&lt;`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => codePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Filters an inline style declaration list. Keeps only STYLE_PROPS whose value contains no
 * `url(`, `expression`, `javascript:`, backslash (CSS escapes), comment, `@import` or `<>{}`,
 * and uses only letters, digits, spaces and `# . , % ( ) ' " + -`. Invalid declarations are
 * dropped one by one; the rest are kept in order.
 * @param style Raw `style` attribute text.
 * @returns Normalised `prop: value; prop: value` string (empty if nothing survives).
 */
export function cleanStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !val) continue;
    // Blocklist first (clear intent), then the character whitelist as the real guard.
    if (/url\s*\(|expression|javascript:|\\|\/\*|@import|[<>{}]/i.test(val)) continue;
    if (!/^[#\w\s.,%()'"+-]+$/.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

/** Returns the link if it is http(s):// or mailto:, else null (blocks javascript:, data:, relative links). */
function safeHref(h: string): string | null {
  const v = h.trim();
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  return null;
}

/**
 * Whitelist sanitiser for rich text coming from the editor, stored dashboards or chat.
 * See the file header for what is allowed and dropped. Pure (no DOM, no side effects).
 * @param input Untrusted HTML; null/undefined are treated as ''.
 * @returns Safe, well-formed HTML suitable for `innerHTML`.
 */
export function sanitizeHtml(input: string): string {
  const src = String(input ?? '');
  // D-028: the same text is sanitised on every refresh of every card; keep the last results.
  const hit = SANITIZED.get(src);
  if (hit !== undefined) return hit;
  const res = sanitizeUncached(src);
  if (SANITIZED.size >= 200) SANITIZED.delete(SANITIZED.keys().next().value!);
  SANITIZED.set(src, res);
  return res;
}
const SANITIZED = new Map<string, string>();

function sanitizeUncached(src: string): string {
  let out = '';
  // Output tag names still open, innermost last.
  const stack: string[] = [];
  // While > 0 we are inside a DROP_WITH_CONTENT element; only nesting of the same tag is counted.
  let dropDepth = 0;
  let nextGt = -1;
  let dropTag = '';
  let i = 0;
  while (i < src.length) {
    // Comments are removed; an unterminated one swallows the rest of the input.
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src[i] === '<') {
      // A `>` inside a quoted attribute ends the match early; the remainder is then escaped as text.
      // D-028: look only up to the next '>' (found once and reused), so input with many '<' stays linear.
      if (nextGt < i) {
        const g = src.indexOf('>', i);
        nextGt = g < 0 ? src.length : g;
      }
      const m = nextGt >= src.length ? null : /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/.exec(src.slice(i, nextGt + 1));
      // Not a tag (e.g. "a < b"): emit an escaped `<`.
      if (!m) {
        if (!dropDepth) out += '&lt;';
        i++;
        continue;
      }
      i += m[0].length;
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (dropDepth) {
        // Self-closing (`<svg/>`) does not change the depth.
        if (tag === dropTag) dropDepth += closing ? -1 : /\/\s*$/.test(m[3]) ? 0 : 1;
        continue;
      }
      if (DROP_WITH_CONTENT.has(tag)) {
        if (!closing && !/\/\s*$/.test(m[3])) {
          dropDepth = 1;
          dropTag = tag;
        }
        continue;
      }
      // Unknown tag: drop the tag itself, keep its text (handled by the text branch below).
      if (!ALLOWED.has(tag)) continue;
      const outTag = tag === 'font' ? 'span' : tag === 'strike' ? 's' : tag;
      if (closing) {
        if (VOID.has(tag)) continue;
        // Close the nearest matching open tag and everything opened inside it; ignore strays.
        const at = stack.lastIndexOf(outTag);
        if (at < 0) continue;
        while (stack.length > at) out += `</${stack.pop()}>`;
        continue;
      }
      // Only style, align, font color/face/size and a[href] are read; everything else is ignored.
      const a = parseAttrs(m[3]);
      const styles: string[] = [];
      if (a.style) styles.push(cleanStyle(a.style));
      if (tag === 'font') {
        if (a.color) styles.push(cleanStyle(`color:${a.color}`));
        if (a.face) styles.push(cleanStyle(`font-family:${a.face}`));
        if (a.size && FONT_SIZES[Number(a.size)]) styles.push(`font-size: ${FONT_SIZES[Number(a.size)]}`);
      }
      if (a.align && /^(left|right|center|justify)$/i.test(a.align)) styles.push(`text-align: ${a.align.toLowerCase()}`);
      let attrs = '';
      const st = styles.filter(Boolean).join('; ');
      if (st) attrs += ` style="${escAttr(st)}"`;
      if (tag === 'a') {
        // An <a> with an unsafe or missing href is kept as a plain inline element.
        const h = a.href ? safeHref(a.href) : null;
        if (h) attrs += ` href="${escAttr(h)}" target="_blank" rel="noopener noreferrer"`;
      }
      out += `<${outTag}${attrs}>`;
      if (!VOID.has(tag)) stack.push(outTag);
      continue;
    }
    // Text run up to the next `<`: escaped, or skipped while inside a dropped element.
    const next = src.indexOf('<', i);
    const text = src.slice(i, next < 0 ? src.length : next);
    if (!dropDepth) out += escText(text);
    i = next < 0 ? src.length : next;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/**
 * Plain-text version of rich text (for chat prompts and titles): block ends and `<br>` become
 * line breaks, all tags are removed, entities decoded, and runs of 3+ newlines collapsed.
 * The result is NOT HTML-safe; escape it before inserting into markup.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Matches `{{key}}` (spaces inside the braces allowed); group 1 is the key. Global regex:
 * it is only used with `matchAll` / `replace`, which do not depend on `lastIndex`.
 */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Telemetry keys referenced as `{{key}}`, de-duplicated, in first-seen order. The built-ins
 * machine, time, date, type, location, machines and locations (D-053) are excluded (the renderer fills them itself).
 * The text widget fetches the latest values of the returned keys.
 */
export function placeholderKeys(html: string): string[] {
  const out = new Set<string>();
  for (const m of String(html ?? '').matchAll(PLACEHOLDER_RE)) if (!['machine', 'time', 'date', 'type', 'location', 'machines', 'locations'].includes(m[1])) out.add(m[1]);
  return [...out];
}

/**
 * Replaces each `{{key}}` with its value wrapped in `<span class="dbb-ph-v">`.
 * @param html Already-sanitised HTML.
 * @param values Formatted display strings (number + unit etc.) by key, built-ins included.
 *   They are HTML-escaped here, so pass plain text. Missing keys become an em dash.
 */
export function fillPlaceholders(html: string, values: Record<string, string>): string {
  // D-028: only in text between tags; a {{key}} inside an attribute (e.g. a link) stays as it is
  return String(html ?? '')
    .split(/(<[^>]*>)/)
    .map((part, i) => (i % 2 ? part : part.replace(PLACEHOLDER_RE, (_, k) => `<span class="dbb-ph-v">${escText(values[k] ?? '—')}</span>`)))
    .join('');
}
