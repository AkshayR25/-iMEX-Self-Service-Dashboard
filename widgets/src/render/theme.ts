// Visual tokens. Categorical order and status colours from the validated reference palette
// (dataviz skill references/palette.md, light mode — ThingsBoard runs a light UI).

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#8a8983' };
export const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: STATUS.critical,
  MAJOR: STATUS.serious,
  MINOR: STATUS.warning,
  WARNING: STATUS.warning,
  INDETERMINATE: STATUS.neutral,
};

export const CSS = `
.dbb-root{--surface:#ffffff;--surface-2:#f6f6f4;--line:#e4e3df;--grid:#efeeea;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#8a8983;--accent:#2a78d6;--danger:#d03b3b;
  font-family:Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);font-size:13px;box-sizing:border-box}
.dbb-root *{box-sizing:border-box}
.dbb-card{background:var(--surface);border:1px solid var(--line);border-radius:8px;height:100%;display:flex;flex-direction:column;overflow:hidden}
.dbb-card-h{display:flex;align-items:center;gap:6px;padding:8px 10px 2px;min-height:28px}
.dbb-card-t{font-size:13px;font-weight:500;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.dbb-card-b{flex:1;min-height:0;padding:4px 10px 10px;position:relative}
.dbb-ph{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--ink-3);font-size:12px;padding:6px}
.dbb-value{display:flex;flex-direction:column;justify-content:center;height:100%}
.dbb-value .v{font-size:30px;font-weight:500;line-height:1.1;font-variant-numeric:tabular-nums}
.dbb-value .u{font-size:14px;color:var(--ink-2);margin-left:4px;font-weight:400}
.dbb-value .s{font-size:11px;color:var(--ink-3);margin-top:4px}
.dbb-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2)}
.dbb-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:none}
.dbb-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ink-2);padding-bottom:4px}
.dbb-legend span{display:inline-flex;align-items:center;gap:5px}
.dbb-legend i{width:12px;height:2px;border-radius:1px;display:inline-block}
.dbb-tip{position:absolute;pointer-events:none;background:#1a1a19;color:#fff;font-size:11px;padding:6px 8px;border-radius:6px;white-space:nowrap;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.dbb-tip b{font-weight:500}
.dbb-table{width:100%;border-collapse:collapse;font-size:12px}
.dbb-table th{text-align:left;color:var(--ink-3);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface)}
.dbb-table td{padding:5px 6px;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}
.dbb-table td.num{text-align:right}
.dbb-scroll{height:100%;overflow:auto}
.dbb-md h1,.dbb-md h2,.dbb-md h3{margin:0 0 4px;font-weight:500}
.dbb-md h1{font-size:20px}.dbb-md h2{font-size:16px}.dbb-md h3{font-size:14px}
.dbb-md p{margin:0 0 6px}.dbb-md ul{margin:0 0 6px;padding-left:18px}
.dbb-sev{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500}
.dbb-btn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dbb-btn:hover{background:var(--surface-2)}
.dbb-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.dbb-btn.primary:hover{filter:brightness(.95)}
.dbb-btn.danger{color:var(--danger)}
.dbb-btn:disabled{opacity:.5;cursor:default}
.dbb-banner{font-size:12px;padding:6px 10px;border-radius:6px;background:#eef4fc;color:#184f95}
.dbb-banner.warn{background:#fff5e0;color:#7a5200}
.dbb-banner.err{background:#fdecec;color:#8e2222}
`;

export function ensureCss(id: string, css: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function fmtNum(v: unknown, decimals = 1): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v == null ? '—' : String(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtTime(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 36 * 3600e3) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (spanMs <= 8 * 86400e3 ? ` ${d.toLocaleTimeString(undefined, { hour: '2-digit' })}` : '');
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') (e as any)[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Colour from bands: first band whose upTo >= value (null = infinity). */
export function bandColor(v: number, bands?: { upTo: number | null; color: string }[]): string | null {
  if (!bands?.length || !Number.isFinite(v)) return null;
  for (const b of bands) if (b.upTo === null || v <= b.upTo) return b.color;
  return bands[bands.length - 1].color;
}

/** Tiny safe markdown: headings, bold, italics, bullets, paragraphs. Escapes HTML first. */
export function miniMarkdown(src: string): string {
  const lines = esc(src).split(/\r?\n/);
  const out: string[] = [];
  let list = false;
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  for (const l of lines) {
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
