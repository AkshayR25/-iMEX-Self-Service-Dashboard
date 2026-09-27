// Builder sub-editors: rich text (WYSIWYG), value-colour rules, card style and dashboard theme.
// Each editor owns its DOM and reports changes through callbacks; the builder decides when to commit.
import type { ColorRule, RuleOp, CardStyle, DashboardTheme, Widget } from '../core/schema';
import { RULE_OP_LABELS, ICONS, FONTS, THEME_PRESETS } from '../core/schema';
import type { KeyMeta } from '../core/types';
import { esc, SWATCHES, PRESETS, loadFont, STATUS } from '../render/theme';
import { sanitizeHtml } from '../render/rich';
import { valueType, ValueType, matchRule, bandsToRules } from '../render/rules';
import { ICON_SVG } from '../render/icons';

const I = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TB_ICONS: Record<string, string> = {
  bold: '<b style="font-size:14px">B</b>',
  italic: '<i style="font-family:Georgia,serif;font-size:14px">I</i>',
  underline: '<u style="font-size:14px">U</u>',
  strike: '<s style="font-size:14px">S</s>',
  left: I('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  center: I('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  right: I('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  ul: I('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol: I('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5l1.5-1V9M3.5 13.5a1.5 1.5 0 0 1 3 .5c0 1-3 2-3 3h3"/>'),
  link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  clear: I('<path d="M5 5h12M11 5l-4 14M15 13l6 6M21 13l-6 6"/>'),
  quote: I('<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>'),
};

// ---------------------------------------------------------------- rich text

export interface RichOptions {
  html: string;
  placeholders?: { key: string; label: string }[];
  minHeight?: number;
  onChange(html: string): void;
}

/** WYSIWYG editor. Commits sanitised HTML on input (debounced) and on blur. */
export function richEditor(host: HTMLElement, o: RichOptions) {
  host.innerHTML = `<div class="dbb-rte">
    <div class="dbb-rte-bar">
      <select data-rc="block" title="Paragraph style"><option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="blockquote">Quote</option></select>
      <select data-rc="font" title="Font"><option value="">Font</option>${FONTS.map((f) => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('')}</select>
      <select data-rc="size" title="Size"><option value="">Size</option>${[11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
      <span class="sep"></span>
      <button data-rc="bold" title="Bold (Ctrl+B)">${TB_ICONS.bold}</button><button data-rc="italic" title="Italic (Ctrl+I)">${TB_ICONS.italic}</button><button data-rc="underline" title="Underline (Ctrl+U)">${TB_ICONS.underline}</button><button data-rc="strikeThrough" title="Strikethrough">${TB_ICONS.strike}</button>
      <label class="dbb-rte-col" title="Text colour"><span style="border-bottom:3px solid #d03b3b">A</span><input type="color" data-rc="foreColor" value="#d03b3b"/></label>
      <label class="dbb-rte-col" title="Highlight"><span style="background:#fde68a;padding:0 3px;border-radius:3px">H</span><input type="color" data-rc="hiliteColor" value="#fde68a"/></label>
      <span class="sep"></span>
      <button data-rc="justifyLeft" title="Align left">${TB_ICONS.left}</button><button data-rc="justifyCenter" title="Centre">${TB_ICONS.center}</button><button data-rc="justifyRight" title="Align right">${TB_ICONS.right}</button>
      <button data-rc="insertUnorderedList" title="Bulleted list">${TB_ICONS.ul}</button><button data-rc="insertOrderedList" title="Numbered list">${TB_ICONS.ol}</button>
      <button data-rc="link" title="Link">${TB_ICONS.link}</button><button data-rc="removeFormat" title="Clear formatting">${TB_ICONS.clear}</button>
      ${
        o.placeholders?.length
          ? `<select data-rc="ph" title="Insert a live value"><option value="">+ Live value</option>${o.placeholders.map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('')}</select>`
          : ''
      }
    </div>
    <div class="dbb-rte-link" hidden><input placeholder="https://…" data-l/><button class="dbb-btn sm primary" data-lok>Add link</button><button class="dbb-btn sm" data-lx>Cancel</button></div>
    <div class="dbb-rte-ed dbb-md" contenteditable="true" spellcheck="true" style="min-height:${o.minHeight ?? 110}px">${sanitizeHtml(o.html)}</div>
  </div>`;
  const ed = host.querySelector('.dbb-rte-ed') as HTMLElement;
  let saved: Range | null = null;
  let t: any = null;
  let last = sanitizeHtml(o.html);
  const commit = () => {
    clearTimeout(t);
    const html = sanitizeHtml(ed.innerHTML);
    if (html !== last) {
      last = html;
      o.onChange(html);
    }
  };
  const later = () => {
    clearTimeout(t);
    t = setTimeout(commit, 500);
  };
  const keep = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    ed.focus();
    if (saved) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  };
  const exec = (cmd: string, val?: string, css = true) => {
    restore();
    try {
      document.execCommand('styleWithCSS', false, css as any);
    } catch {
      /* old browsers */
    }
    document.execCommand(cmd, false, val);
    keep();
    later();
  };
  ed.addEventListener('keyup', keep);
  ed.addEventListener('mouseup', keep);
  ed.addEventListener('input', later);
  ed.addEventListener('blur', commit);
  ed.addEventListener('paste', (e) => {
    // paste as sanitised HTML
    const html = e.clipboardData?.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitizeHtml(html));
  });
  host.querySelectorAll<HTMLButtonElement>('.dbb-rte-bar button').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const c = b.dataset.rc!;
      if (c === 'link') {
        keep();
        const row = host.querySelector('.dbb-rte-link') as HTMLElement;
        row.hidden = false;
        (row.querySelector('[data-l]') as HTMLInputElement).focus();
        return;
      }
      exec(c);
    });
  });
  const linkRow = host.querySelector('.dbb-rte-link') as HTMLElement;
  linkRow.querySelector('[data-lok]')!.addEventListener('click', () => {
    const v = (linkRow.querySelector('[data-l]') as HTMLInputElement).value.trim();
    linkRow.hidden = true;
    if (/^(https?:\/\/|mailto:)/i.test(v)) exec('createLink', v);
  });
  linkRow.querySelector('[data-lx]')!.addEventListener('click', () => (linkRow.hidden = true));
  host.querySelectorAll<HTMLSelectElement | HTMLInputElement>('.dbb-rte-bar select, .dbb-rte-bar input').forEach((s) => {
    s.addEventListener('mousedown', keep);
    s.addEventListener('focus', keep);
    s.addEventListener(s.tagName === 'INPUT' ? 'input' : 'change', () => {
      const c = s.dataset.rc!;
      const v = s.value;
      if (c === 'block') exec('formatBlock', `<${v}>`);
      else if (c === 'font' && v) {
        loadFont(v);
        exec('fontName', `'${v}'`);
      } else if (c === 'size' && v) {
        exec('fontSize', '7', false);
        const made: HTMLElement[] = [];
        ed.querySelectorAll('font[size="7"]').forEach((f) => {
          const sp = document.createElement('span');
          sp.style.fontSize = `${v}px`;
          while (f.firstChild) sp.appendChild(f.firstChild);
          f.replaceWith(sp);
          made.push(sp);
        });
        if (made.length) {
          // keep the resized text selected so the next toolbar action applies to it
          const r = document.createRange();
          r.setStartBefore(made[0]);
          r.setEndAfter(made[made.length - 1]);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          saved = r.cloneRange();
        }
        later();
      } else if (c === 'foreColor' || c === 'hiliteColor') exec(c, v);
      else if (c === 'ph' && v) exec('insertText', `{{${v}}}`);
      if (s.tagName === 'SELECT' && c !== 'block') (s as HTMLSelectElement).value = '';
    });
  });
  return { flush: commit };
}

// ---------------------------------------------------------------- colour rules

const OPS_BY_TYPE: Record<ValueType, RuleOp[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq'],
  boolean: ['isTrue', 'isFalse'],
  string: ['eq', 'neq', 'contains'],
};

export interface RuleEditorOptions {
  widget: Widget;
  metas: KeyMeta[];
  /** Latest sample per key for type inference and the test box. */
  samples?: Record<string, unknown>;
  onChange(rules: ColorRule[] | undefined, extra?: Partial<Widget['settings']>): void;
}

export const CARD_TYPES = new Set(['value', 'kpi', 'gauge', 'progress', 'status', 'summary']);

/** Initial rules for a widget: explicit rules, else legacy bands / status map converted. */
export function initialRules(w: Widget): ColorRule[] {
  const s = w.settings;
  if (s.colorRules?.length) return s.colorRules.map((r) => ({ ...r }));
  if (s.bands?.length) return bandsToRules(s.bands).filter((r) => Number.isFinite(Number(r.value)));
  if (w.type === 'status' && s.statusMap?.length) return s.statusMap.map((m) => ({ op: 'eq' as const, value: m.value, color: m.color, label: m.label }));
  return [];
}

export function ruleEditor(host: HTMLElement, o: RuleEditorOptions) {
  const w = o.widget;
  const s = w.settings;
  let rules = initialRules(w);
  const multi = o.metas.length > 1;
  const metaOf = (k?: string) => o.metas.find((m) => m.key === k) ?? o.metas[0];
  const typeOf = (k?: string): ValueType => {
    const m = metaOf(k);
    return valueType(m, o.samples?.[m?.key ?? '']);
  };
  let forcedType: Record<string, ValueType> = {};
  const tOf = (k?: string) => forcedType[k ?? metaOf(k)?.key ?? ''] ?? typeOf(k);

  const emit = (extra?: Partial<Widget['settings']>) => o.onChange(rules.length ? rules.map(clean) : undefined, extra);
  const clean = (r: ColorRule): ColorRule => {
    const x: any = { ...r };
    if (!x.key) delete x.key;
    if (!x.label) delete x.label;
    if (['isTrue', 'isFalse'].includes(x.op)) {
      delete x.value;
      delete x.value2;
    }
    if (x.op !== 'between') delete x.value2;
    return x;
  };

  const render = () => {
    const k0 = multi ? undefined : o.metas[0]?.key;
    const vt = tOf(k0);
    const isCard = CARD_TYPES.has(w.type);
    const isChart = ['line', 'area', 'bar'].includes(w.type);
    host.innerHTML = `<div class="dbb-rules">
      <div class="dbb-hint">Colour ${isCard ? 'this card' : w.type === 'table' || w.type === 'multivalue' ? 'cells' : 'the chart'} by value. The first matching rule wins.</div>
      ${
        !multi && o.metas[0]
          ? `<div class="dbb-seg" role="radiogroup" aria-label="Value type">${(['number', 'boolean', 'string'] as ValueType[])
              .map((t) => `<button data-vt="${t}" class="${t === vt ? 'on' : ''}">${t === 'number' ? '123 Number' : t === 'boolean' ? 'On / off' : 'Abc Text'}</button>`)
              .join('')}</div>`
          : ''
      }
      <div class="dbb-rule-list">${rules.map((r, i) => row(r, i)).join('') || '<div class="dbb-hint" style="text-align:center;padding:8px">No rules yet.</div>'}</div>
      <div class="dbb-row wrap">
        <button class="dbb-btn sm" data-add>+ Add rule</button>
        ${vt === 'number' || multi ? `<button class="dbb-btn sm" data-preset="traffic">Traffic light</button>` : ''}
        ${vt === 'boolean' ? `<button class="dbb-btn sm" data-preset="onoff">Running / stopped</button>` : ''}
        ${rules.length ? `<button class="dbb-btn sm danger" data-clear>Clear</button>` : ''}
      </div>
      ${
        isCard && w.type !== 'gauge'
          ? `<label class="dbb-field"><span>Apply the colour to</span><select data-target>${[
              ['background', 'Card background (tint + bar)'],
              ['accent', 'Accent bar only'],
              ['value', 'Value text'],
              ['icon', 'Title icon'],
            ]
              .map(([v, l]) => `<option value="${v}" ${(s.colorTarget ?? 'background') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}</select></label>`
          : ''
      }
      ${w.type === 'gauge' ? `<label class="dbb-check"><input type="checkbox" data-gv ${s.colorTarget === 'value' ? 'checked' : ''}/> Colour the number too</label>` : ''}
      ${isChart ? `<label class="dbb-check"><input type="checkbox" data-thr ${s.showThresholds !== false ? 'checked' : ''}/> Draw number rules as threshold lines</label>` : ''}
      ${w.type === 'heatmap' ? `<div class="dbb-hint">Set <b>Colours → Use rules</b> in the Widget tab to colour cells by these rules.</div>` : ''}
      <div class="dbb-test"><span>Test a value</span><input data-test placeholder="${vt === 'boolean' ? 'true / 1 / off' : vt === 'number' ? 'e.g. 82' : 'e.g. Fault'}"/><span class="dbb-test-out"></span></div>
    </div>`;
    wire();
  };

  const row = (r: ColorRule, i: number) => {
    const t = tOf(r.key ?? (multi ? undefined : o.metas[0]?.key));
    const ops = OPS_BY_TYPE[t];
    const op = ops.includes(r.op) ? r.op : ops[0];
    const valBox =
      t === 'boolean'
        ? ''
        : t === 'number'
          ? `<input type="number" step="any" data-f="value" value="${esc(r.value ?? '')}" placeholder="value"/>${op === 'between' ? `<span class="dbb-muted">and</span><input type="number" step="any" data-f="value2" value="${esc(r.value2 ?? '')}" placeholder="value"/>` : ''}`
          : `<input data-f="value" value="${esc(r.value ?? '')}" placeholder="text"/>`;
    return `<div class="dbb-rule" data-i="${i}">
      <div class="dbb-rule-main">
        ${multi ? `<select data-f="key" title="Property"><option value="">Any property</option>${o.metas.map((m) => `<option value="${esc(m.key)}" ${r.key === m.key ? 'selected' : ''}>${esc(m.displayName)}</option>`).join('')}</select>` : ''}
        <select data-f="op" title="Condition">${ops.map((x) => `<option value="${x}" ${x === op ? 'selected' : ''}>${esc(RULE_OP_LABELS[x])}</option>`).join('')}</select>
        ${valBox}
        <label class="dbb-swatch" title="Colour" style="background:${esc(r.color)}"><input type="color" data-f="color" value="${esc(/^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#2a78d6')}"/></label>
        <button class="dbb-x" data-del title="Remove rule">✕</button>
      </div>
      <div class="dbb-rule-sub">
        <input data-f="label" value="${esc(r.label ?? '')}" placeholder="Label (optional), e.g. Too hot" maxlength="40"/>
        <span class="dbb-sw-row">${SWATCHES.slice(0, 9).map((c) => `<button data-sw="${c}" style="background:${c}" title="${c}"></button>`).join('')}</span>
      </div>
    </div>`;
  };

  let colorTimer: any;
  const wire = () => {
    host.querySelectorAll<HTMLElement>('[data-vt]').forEach((b) =>
      b.addEventListener('click', () => {
        forcedType = { [o.metas[0].key]: b.dataset.vt as ValueType };
        rules = rules.map((r) => ({ ...r, op: OPS_BY_TYPE[b.dataset.vt as ValueType].includes(r.op) ? r.op : OPS_BY_TYPE[b.dataset.vt as ValueType][0] }));
        render();
        if (rules.length) emit();
      }),
    );
    host.querySelectorAll<HTMLElement>('.dbb-rule').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((inp) =>
        inp.addEventListener(inp.type === 'color' ? 'input' : 'change', () => {
          const f = inp.dataset.f!;
          if (f === 'color') {
            rules[i].color = inp.value;
            (inp.parentElement as HTMLElement).style.background = inp.value;
            clearTimeout(colorTimer);
            colorTimer = setTimeout(() => emit(), 250);
            return;
          }
          const r: any = rules[i];
          if (f === 'value') r.value = tOf(r.key ?? o.metas[0]?.key) === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value;
          else if (f === 'value2') r.value2 = inp.value === '' ? undefined : Number(inp.value);
          else if (f === 'color') {
            r.color = inp.value;
            (inp.parentElement as HTMLElement).style.background = inp.value;
          } else r[f] = inp.value || undefined;
          if (f === 'op' || f === 'key') render();
          emit();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-sw]').forEach((b) =>
        b.addEventListener('click', () => {
          rules[i].color = b.dataset.sw!;
          render();
          emit();
        }),
      );
      el.querySelector('[data-del]')!.addEventListener('click', () => {
        rules.splice(i, 1);
        render();
        emit();
      });
    });
    host.querySelector('[data-add]')?.addEventListener('click', () => {
      const t = tOf(multi ? undefined : o.metas[0]?.key);
      const m = metaOf();
      const used = new Set(rules.map((r) => r.color));
      const color = [STATUS.critical, STATUS.warning, STATUS.good, '#2a78d6', '#4a3aa7'].find((c) => !used.has(c)) ?? '#2a78d6';
      rules.push(t === 'boolean' ? { op: rules.some((r) => r.op === 'isTrue') ? 'isFalse' : 'isTrue', color } : t === 'number' ? { op: 'gt', value: Math.round((m?.min ?? 0) + ((m?.max ?? 100) - (m?.min ?? 0)) * 0.8), color } : { op: 'eq', value: '', color });
      render();
      emit();
    });
    host.querySelector('[data-preset="traffic"]')?.addEventListener('click', () => {
      const m = metaOf();
      const span = (m?.max ?? 100) - (m?.min ?? 0) || 1;
      const r = (f: number) => Math.round(((m?.min ?? 0) + span * f) * 10) / 10;
      rules = [
        { op: 'gt', value: r(0.9), color: STATUS.critical, label: 'High' },
        { op: 'gt', value: r(0.75), color: STATUS.warning, label: 'Watch' },
        { op: 'lte', value: r(0.75), color: STATUS.good, label: 'Normal' },
      ];
      render();
      emit();
    });
    host.querySelector('[data-preset="onoff"]')?.addEventListener('click', () => {
      rules = [
        { op: 'isTrue', color: STATUS.good, label: 'Running' },
        { op: 'isFalse', color: STATUS.neutral, label: 'Stopped' },
      ];
      render();
      emit();
    });
    host.querySelector('[data-clear]')?.addEventListener('click', () => {
      rules = [];
      render();
      emit({ bands: undefined, statusMap: undefined });
    });
    host.querySelector<HTMLSelectElement>('[data-target]')?.addEventListener('change', (e) => emit({ colorTarget: (e.target as HTMLSelectElement).value as any }));
    host.querySelector<HTMLInputElement>('[data-gv]')?.addEventListener('change', (e) => emit({ colorTarget: (e.target as HTMLInputElement).checked ? 'value' : undefined }));
    host.querySelector<HTMLInputElement>('[data-thr]')?.addEventListener('change', (e) => emit({ showThresholds: (e.target as HTMLInputElement).checked ? undefined : false }));
    const test = host.querySelector<HTMLInputElement>('[data-test]');
    const out = host.querySelector('.dbb-test-out') as HTMLElement;
    test?.addEventListener('input', () => {
      if (!test.value) return void (out.innerHTML = '');
      const r = matchRule(rules, test.value, multi ? undefined : o.metas[0]?.key);
      out.innerHTML = r ? `<span class="dbb-dot" style="background:${esc(r.color)}"></span> ${esc(r.label ?? 'matches')}` : '<span class="dbb-muted">no rule matches</span>';
    });
  };
  render();
}

// ---------------------------------------------------------------- card style

export interface StyleEditorOptions {
  widget: Widget;
  onChange(style: CardStyle | undefined, extra?: Partial<Widget['settings']>): void;
  onCopyToAll(): void;
  descriptionHost(el: HTMLElement): void;
}

const colorInput = (f: string, v: string | undefined, fallback: string) =>
  `<span class="dbb-colf"><label class="dbb-swatch ${v ? '' : 'empty'}" style="${v ? `background:${esc(v)}` : ''}"><input type="color" data-st="${f}" value="${esc(v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)}"/></label>${v ? `<button class="dbb-x" data-unset="${f}" title="Use the theme default">✕</button>` : '<span class="dbb-muted">theme</span>'}</span>`;

export function styleEditor(host: HTMLElement, o: StyleEditorOptions) {
  const w = o.widget;
  const st: CardStyle = { ...(w.settings.style ?? {}) };
  const isValue = ['value', 'kpi', 'progress', 'summary', 'multivalue', 'gauge'].includes(w.type);
  /** Widgets whose values/labels can be aligned (charts and tables lay themselves out). */
  const hasLayout = ['value', 'kpi', 'progress', 'summary', 'multivalue', 'status'].includes(w.type);
  const seg = (f: keyof CardStyle, opts: [string, string][], cur: string | undefined, def: string) =>
    `<div class="dbb-seg sm">${opts.map(([v, l]) => `<button data-seg="${f}" data-v="${v}" class="${(cur ?? def) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  host.innerHTML = `<div class="dbb-form">
    <div class="dbb-sec">Title</div>
    <label class="dbb-check"><input type="checkbox" data-st="hideTitle" ${st.hideTitle ? '' : 'checked'}/> Show title</label>
    <div class="dbb-field"><span>Icon</span><div class="dbb-icons"><button data-icon="" class="${!st.icon ? 'on' : ''}" title="No icon">∅</button>${ICONS.map((n) => `<button data-icon="${n}" class="${st.icon === n ? 'on' : ''}" title="${n}">${ICON_SVG[n]}</button>`).join('')}</div></div>
    <div class="dbb-row"><div class="dbb-field half"><span>Icon colour</span>${colorInput('iconColor', st.iconColor, '#2a78d6')}</div><div class="dbb-field half"><span>Title colour</span>${colorInput('titleColor', st.titleColor, '#52514e')}</div></div>
    <div class="dbb-row">
      <label class="dbb-field half"><span>Title size</span><select data-st="titleSize"><option value="">Default</option>${[11, 12, 13, 14, 16, 18, 20, 24].map((n) => `<option ${st.titleSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="dbb-field half"><span>Weight</span><select data-st="titleWeight"><option value="">Default</option>${[['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold']].map(([v, l]) => `<option value="${v}" ${st.titleWeight === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="dbb-row">
      <label class="dbb-field half"><span>Title font</span><select data-st="titleFont"><option value="">Theme font</option>${FONTS.map((f) => `<option ${st.titleFont === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <div class="dbb-field half"><span>Align</span>${seg('titleAlign', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], st.titleAlign, 'left')}</div>
    </div>
    ${
      hasLayout
        ? `<div class="dbb-sec">Layout</div>
    <div class="dbb-field"><span>Values &amp; labels · horizontal</span>${seg('align', [['left', '⇤ Left'], ['center', '↔ Centre'], ['right', 'Right ⇥']], st.align, 'left')}</div>
    ${w.type === 'multivalue' ? '' : `<div class="dbb-field"><span>Values &amp; labels · vertical</span>${seg('valign', [['top', '⤒ Top'], ['middle', '↕ Middle'], ['bottom', 'Bottom ⤓']], st.valign, w.type === 'kpi' ? 'top' : 'middle')}</div>`}
    <div class="dbb-field"><span>Title position</span>${seg('titlePos', [['top', 'Above'], ['bottom', 'Below']], st.titlePos, 'top')}</div>`
        : `<div class="dbb-sec">Layout</div><div class="dbb-field"><span>Title position</span>${seg('titlePos', [['top', 'Above'], ['bottom', 'Below']], st.titlePos, 'top')}</div>`
    }
    <div class="dbb-sec">Card</div>
    <div class="dbb-row"><div class="dbb-field half"><span>Background</span>${colorInput('bg', st.bg, '#ffffff')}</div><div class="dbb-field half"><span>Accent bar</span>${colorInput('accentBar', st.accentBar, '#2a78d6')}</div></div>
    <label class="dbb-check"><input type="checkbox" data-st="gradient" ${st.gradient ? 'checked' : ''} ${st.bg ? '' : 'disabled'}/> Gradient background</label>
    <div class="dbb-field"><span>Border</span>${seg('border', [['none', 'None'], ['thin', 'Thin'], ['thick', 'Thick']], st.border, 'thin')}</div>
    <div class="dbb-field"><span>Border colour</span>${colorInput('borderColor', st.borderColor, '#e6e5e0')}</div>
    <div class="dbb-field"><span>Shadow</span>${seg('shadow', [['none', 'None'], ['soft', 'Soft'], ['strong', 'Lifted']], st.shadow, 'soft')}</div>
    <div class="dbb-field"><span>Padding</span>${seg('padding', [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']], st.padding, 'normal')}</div>
    <label class="dbb-field"><span>Corner radius · <b data-rv>${st.radius ?? 'theme'}</b></span><input type="range" min="0" max="28" data-st="radius" value="${st.radius ?? 12}"/></label>
    ${
      isValue
        ? `<div class="dbb-sec">Value</div>
    <label class="dbb-field"><span>Value size · <b data-vv>${st.valueSize ?? 'auto'}</b></span><input type="range" min="12" max="72" data-st="valueSize" value="${st.valueSize ?? 30}"/></label>
    <div class="dbb-row"><div class="dbb-field half"><span>Value colour</span>${colorInput('valueColor', st.valueColor, '#0b0b0b')}</div>
      <label class="dbb-field half"><span>Value font</span><select data-st="valueFont"><option value="">Theme font</option>${FONTS.map((f) => `<option ${st.valueFont === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
`
        : ''
    }
    <div class="dbb-sec">Help text</div>
    <div class="dbb-hint">Shown as an ⓘ tooltip next to the title.</div>
    <div data-desc></div>
    <label class="dbb-field"><span>Footer note</span><input data-footer maxlength="200" value="${esc(w.settings.footer ?? '')}" placeholder="e.g. Source: PLC tag DP-01"/></label>
    <div class="dbb-row wrap" style="margin-top:8px"><button class="dbb-btn sm" data-copyall>Copy this style to all widgets</button><button class="dbb-btn sm danger" data-reset>Reset style</button></div>
  </div>`;
  o.descriptionHost(host.querySelector('[data-desc]') as HTMLElement);
  const emit = () => {
    const clean: any = {};
    for (const [k, v] of Object.entries(st)) if (v !== undefined && v !== '' && v !== false) clean[k] = v;
    o.onChange(Object.keys(clean).length ? clean : undefined);
  };
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-st]').forEach((inp) => {
    const f = inp.dataset.st as keyof CardStyle;
    const ev = inp.type === 'color' || inp.type === 'range' ? 'input' : 'change';
    let tm: any;
    inp.addEventListener(ev, () => {
      const any: any = st;
      if (f === 'hideTitle') any.hideTitle = !(inp as HTMLInputElement).checked || undefined;
      else if (f === 'gradient') any.gradient = (inp as HTMLInputElement).checked || undefined;
      else if (f === 'radius' || f === 'valueSize' || f === 'titleSize') any[f] = inp.value === '' ? undefined : Number(inp.value);
      else any[f] = inp.value || undefined;
      if (f === 'titleFont' || f === 'valueFont') loadFont(inp.value);
      if (inp.type === 'color') {
        const sw = inp.parentElement as HTMLElement;
        sw.style.background = inp.value;
        sw.classList.remove('empty');
      }
      if (f === 'radius') (host.querySelector('[data-rv]') as HTMLElement).textContent = inp.value;
      if (f === 'valueSize') (host.querySelector('[data-vv]') as HTMLElement).textContent = inp.value;
      clearTimeout(tm);
      tm = setTimeout(emit, ev === 'input' ? 250 : 0);
    });
  });
  host.querySelectorAll<HTMLElement>('[data-unset]').forEach((b) =>
    b.addEventListener('click', () => {
      delete (st as any)[b.dataset.unset!];
      if (b.dataset.unset === 'bg') delete st.gradient;
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-seg]').forEach((b) =>
    b.addEventListener('click', () => {
      (st as any)[b.dataset.seg!] = b.dataset.v;
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-icon]').forEach((b) =>
    b.addEventListener('click', () => {
      st.icon = (b.dataset.icon || undefined) as any;
      emit();
    }),
  );
  host.querySelector<HTMLInputElement>('[data-footer]')!.addEventListener('change', (e) => o.onChange(w.settings.style, { footer: (e.target as HTMLInputElement).value.trim() || undefined }));
  host.querySelector('[data-reset]')!.addEventListener('click', () => o.onChange(undefined));
  host.querySelector('[data-copyall]')!.addEventListener('click', () => o.onCopyToAll());
}

// ---------------------------------------------------------------- dashboard theme

export function themeEditor(host: HTMLElement, theme: DashboardTheme | undefined, onChange: (t: DashboardTheme | undefined) => void, extra: { onTemplates(): void }) {
  const t: DashboardTheme = { ...(theme ?? {}) };
  const cur = t.preset ?? 'light';
  const seg = (f: keyof DashboardTheme, opts: [string, string][], v: string | undefined, def: string) =>
    `<div class="dbb-seg sm">${opts.map(([x, l]) => `<button data-tseg="${f}" data-v="${x}" class="${(v ?? def) === x ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  host.innerHTML = `<div class="dbb-form">
    <div class="dbb-banner" style="display:flex;align-items:center;gap:8px">Select a widget to edit it. These settings style the whole dashboard.</div>
    <button class="dbb-btn" data-tpl style="justify-content:center">✦ Start from a template…</button>
    <div class="dbb-sec">Theme</div>
    <div class="dbb-presets">${THEME_PRESETS.map((p) => {
      const P = PRESETS[p];
      return `<button data-preset="${p}" class="${cur === p ? 'on' : ''}" title="${P.label}"><span class="pv" style="background:${P.plane}"><i style="background:${P.surface};border-color:${P.line}"></i><i style="background:${P.surface};border-color:${P.line}"><b style="background:${P.accent}"></b></i></span><span>${P.label}</span></button>`;
    }).join('')}</div>
    <div class="dbb-row"><div class="dbb-field half"><span>Accent colour</span>${colorInputT('accent', t.accent, PRESETS[cur].accent)}</div>
      <label class="dbb-field half"><span>Font</span><select data-t="font"><option value="">Roboto (default)</option>${FONTS.filter((f) => f !== 'Roboto').map((f) => `<option ${t.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
    <div class="dbb-row"><div class="dbb-field half"><span>Page background</span>${colorInputT('bg', t.bg, PRESETS[cur].plane)}</div><div class="dbb-field half"><span>Card colour</span>${colorInputT('cardBg', t.cardBg, PRESETS[cur].surface)}</div></div>
    <label class="dbb-field"><span>Background image (https://…)</span><input data-t="bgImage" value="${esc(t.bgImage ?? '')}" placeholder="optional"/></label>
    <div class="dbb-sec">Cards</div>
    <label class="dbb-field"><span>Corner radius · <b data-rv>${t.radius ?? 12}</b></span><input type="range" min="0" max="28" data-t="radius" value="${t.radius ?? 12}"/></label>
    <div class="dbb-field"><span>Shadow</span>${seg('shadow', [['none', 'Flat'], ['soft', 'Soft'], ['strong', 'Lifted']], t.shadow, 'soft')}</div>
    <div class="dbb-field"><span>Density</span>${seg('density', [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']], t.density, 'normal')}</div>
    <div class="dbb-field"><span>Titles</span>${seg('titleAlign', [['left', 'Left'], ['center', 'Centred']], t.titleAlign, 'left')}</div>
    <button class="dbb-btn sm danger" data-treset style="align-self:flex-start;margin-top:6px">Reset theme</button>
  </div>`;
  const emit = () => {
    const c: any = {};
    for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== '') c[k] = v;
    onChange(Object.keys(c).length ? c : undefined);
  };
  host.querySelector('[data-tpl]')!.addEventListener('click', extra.onTemplates);
  host.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      t.preset = b.dataset.preset as any;
      delete t.bg;
      delete t.cardBg;
      emit();
    }),
  );
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-t]').forEach((inp) => {
    const f = inp.dataset.t as keyof DashboardTheme;
    let tm: any;
    inp.addEventListener(inp.type === 'color' || inp.type === 'range' ? 'input' : 'change', () => {
      (t as any)[f] = f === 'radius' ? Number(inp.value) : inp.value.trim() || undefined;
      if (f === 'font') loadFont(inp.value);
      if (f === 'radius') (host.querySelector('[data-rv]') as HTMLElement).textContent = inp.value;
      if (inp.type === 'color') (inp.parentElement as HTMLElement).style.background = inp.value;
      clearTimeout(tm);
      tm = setTimeout(emit, inp.type === 'color' || inp.type === 'range' ? 250 : 0);
    });
  });
  host.querySelectorAll<HTMLElement>('[data-tunset]').forEach((b) =>
    b.addEventListener('click', () => {
      delete (t as any)[b.dataset.tunset!];
      emit();
    }),
  );
  host.querySelectorAll<HTMLElement>('[data-tseg]').forEach((b) =>
    b.addEventListener('click', () => {
      (t as any)[b.dataset.tseg!] = b.dataset.v;
      emit();
    }),
  );
  host.querySelector('[data-treset]')!.addEventListener('click', () => onChange(undefined));
}

const colorInputT = (f: string, v: string | undefined, fallback: string) =>
  `<span class="dbb-colf"><label class="dbb-swatch" style="background:${esc(v ?? fallback)}"><input type="color" data-t="${f}" value="${esc(v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)}"/></label>${v ? `<button class="dbb-x" data-tunset="${f}" title="Use the preset colour">✕</button>` : '<span class="dbb-muted">preset</span>'}</span>`;
