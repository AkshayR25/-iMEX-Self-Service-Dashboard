// Rich text: a whitelist sanitiser (string-based, no DOM needed, so it runs in tests and in the browser)
// and {{placeholder}} filling for live values.

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'div', 'br', 'span', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre', 'hr', 'mark', 'font', 'sub', 'sup', 'small']);
const VOID = new Set(['br', 'hr']);
/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'textarea', 'select', 'noscript', 'title', 'head']);
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
const FONT_SIZES = ['', '10px', '13px', '16px', '18px', '24px', '32px', '48px'];

const escText = (s: string) => s.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function cleanStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !val) continue;
    if (/url\s*\(|expression|javascript:|\\|\/\*|@import|[<>{}]/i.test(val)) continue;
    if (!/^[#\w\s.,%()'"+-]+$/.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function safeHref(h: string): string | null {
  const v = h.trim();
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  return null;
}

/** Whitelist sanitiser for rich text coming from the editor (or chat). Returns safe HTML. */
export function sanitizeHtml(input: string): string {
  const src = String(input ?? '');
  let out = '';
  const stack: string[] = [];
  let dropDepth = 0;
  let dropTag = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src[i] === '<') {
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/.exec(src.slice(i));
      if (!m) {
        if (!dropDepth) out += '&lt;';
        i++;
        continue;
      }
      i += m[0].length;
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (dropDepth) {
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
      if (!ALLOWED.has(tag)) continue;
      const outTag = tag === 'font' ? 'span' : tag === 'strike' ? 's' : tag;
      if (closing) {
        if (VOID.has(tag)) continue;
        const at = stack.lastIndexOf(outTag);
        if (at < 0) continue;
        while (stack.length > at) out += `</${stack.pop()}>`;
        continue;
      }
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
        const h = a.href ? safeHref(a.href) : null;
        if (h) attrs += ` href="${escAttr(h)}" target="_blank" rel="noopener noreferrer"`;
      }
      out += `<${outTag}${attrs}>`;
      if (!VOID.has(tag)) stack.push(outTag);
      continue;
    }
    const next = src.indexOf('<', i);
    const text = src.slice(i, next < 0 ? src.length : next);
    if (!dropDepth) out += escText(text);
    i = next < 0 ? src.length : next;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** Plain text (for chat prompts and titles). */
export function htmlToText(html: string): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Keys referenced as {{key}} (excluding the built-ins machine / time / date). */
export function placeholderKeys(html: string): string[] {
  const out = new Set<string>();
  for (const m of String(html ?? '').matchAll(PLACEHOLDER_RE)) if (!['machine', 'time', 'date', 'type', 'location'].includes(m[1])) out.add(m[1]);
  return [...out];
}

/** Replaces {{key}} with already-formatted, escaped values. Unknown keys become an em dash. */
export function fillPlaceholders(html: string, values: Record<string, string>): string {
  return String(html ?? '').replace(PLACEHOLDER_RE, (_, k) => `<span class="dbb-ph-v">${escText(values[k] ?? '—')}</span>`);
}
