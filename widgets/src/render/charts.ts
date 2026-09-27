// Dependency-free SVG charts: line (crosshair tooltip), bar (per-bar tooltip), gauge.
import { esc, fmtNum, fmtTime, bandColor } from './theme';

export interface Series {
  name: string;
  color: string;
  unit?: string;
  decimals?: number;
  points: { ts: number; value: number }[];
}

const NS = 'http://www.w3.org/2000/svg';

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Decimals needed so adjacent tick labels differ. */
function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 1;
  const step = Math.abs(ticks[1] - ticks[0]) || 1;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

function tipAt(host: HTMLElement): HTMLDivElement {
  let t = host.querySelector(':scope > .dbb-tip') as HTMLDivElement | null;
  if (!t) {
    t = document.createElement('div');
    t.className = 'dbb-tip';
    t.style.display = 'none';
    host.appendChild(t);
  }
  return t;
}

function placeTip(host: HTMLElement, tip: HTMLElement, x: number, y: number) {
  tip.style.display = 'block';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + 12;
  if (left + w > host.clientWidth) left = x - w - 12;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, Math.min(y - h / 2, host.clientHeight - h))}px`;
}

export function lineChart(host: HTMLElement, series: Series[], opts: { startTs: number; endTs: number; showLegend?: boolean }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  const withData = series.filter((s) => s.points.length);
  if (!withData.length) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  if (series.length > 1 && opts.showLegend !== false) {
    const lg = document.createElement('div');
    lg.className = 'dbb-legend';
    lg.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    host.appendChild(lg);
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;flex:1;height:calc(100% - ' + (host.firstChild ? (host.firstChild as HTMLElement).offsetHeight : 0) + 'px)';
  host.appendChild(box);
  const W = Math.max(120, box.clientWidth || host.clientWidth);
  const H = Math.max(80, box.clientHeight || host.clientHeight - 20);
  const all = withData.flatMap((s) => s.points.map((p) => p.value));
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const dec = withData[0].decimals ?? 1;
  const tdec = tickDecimals(ticks);
  const labelW = Math.max(...ticks.map((t) => fmtNum(t, tdec).length)) * 6.5 + 8;
  const m = { l: labelW, r: 8, t: 6, b: 18 };
  const x = (ts: number) => m.l + ((ts - opts.startTs) / (opts.endTs - opts.startTs)) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
  const span = opts.endTs - opts.startTs;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.style.display = 'block';
  let g = '';
  for (const t of ticks) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="#efeeea"/>`;
    g += `<text x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" fill="#8a8983">${fmtNum(t, tdec)}</text>`;
  }
  void dec;
  const xt = 4;
  for (let i = 0; i <= xt; i++) {
    const ts = opts.startTs + (span * i) / xt;
    g += `<text x="${x(ts)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === xt ? 'end' : 'middle'}" font-size="10" fill="#8a8983">${esc(fmtTime(ts, span))}</text>`;
  }
  for (const s of withData) {
    // break the line on gaps > 3x median step so offline periods are visible
    const pts = s.points;
    const steps = pts.slice(1).map((p, i) => p.ts - pts[i].ts).sort((a, b) => a - b);
    const med = steps[Math.floor(steps.length / 2)] || 0;
    let d = '';
    pts.forEach((p, i) => {
      const gap = i > 0 && med > 0 && p.ts - pts[i - 1].ts > med * 3;
      d += `${i === 0 || gap ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`;
    });
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  g += `<line class="xh" y1="${m.t}" y2="${H - m.b}" stroke="#8a8983" stroke-dasharray="3 3" style="display:none"/>`;
  svg.innerHTML = g;
  box.appendChild(svg);

  const tip = tipAt(box);
  const xh = svg.querySelector('.xh') as SVGLineElement;
  const dots = withData.map((s) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', '4');
    c.setAttribute('fill', s.color);
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', '2');
    c.style.display = 'none';
    svg.appendChild(c);
    return c;
  });
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const ts = opts.startTs + ((px - m.l) / (W - m.l - m.r)) * span;
    let rows = '';
    let anyTs = 0;
    withData.forEach((s, i) => {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
      anyTs = best.ts;
      dots[i].setAttribute('cx', String(x(best.ts)));
      dots[i].setAttribute('cy', String(y(best.value)));
      dots[i].style.display = '';
      rows += `<div><span class="dbb-dot" style="background:${s.color};width:8px;height:8px"></span> ${esc(s.name)}: <b>${fmtNum(best.value, s.decimals ?? 1)}</b> ${esc(s.unit ?? '')}</div>`;
    });
    xh.setAttribute('x1', String(x(anyTs)));
    xh.setAttribute('x2', String(x(anyTs)));
    xh.style.display = '';
    tip.innerHTML = `<div style="opacity:.7;margin-bottom:3px">${esc(new Date(anyTs).toLocaleString())}</div>${rows}`;
    placeTip(box, tip, px, ev.clientY - r.top);
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    xh.style.display = 'none';
    dots.forEach((d) => (d.style.display = 'none'));
  });
}

export interface Bar {
  label: string;
  value: number | null;
  color: string;
  detail?: string;
}

export function barChart(host: HTMLElement, bars: Bar[], opts: { unit?: string; decimals?: number }) {
  host.innerHTML = '';
  host.style.position = 'relative';
  const vals = bars.map((b) => b.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) {
    host.innerHTML = '<div class="dbb-ph">No data in this time range</div>';
    return;
  }
  const W = Math.max(120, host.clientWidth);
  const H = Math.max(80, host.clientHeight);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const dec = opts.decimals ?? 1;
  const tdec = tickDecimals(ticks);
  const labelW = Math.max(...ticks.map((t) => fmtNum(t, tdec).length)) * 6.5 + 8;
  const m = { l: labelW, r: 6, t: 6, b: 18 };
  const y = (v: number) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / bars.length;
  const bw = Math.max(2, Math.min(40, slot - 2));
  let g = '';
  for (const t of ticks) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="#efeeea"/>`;
    g += `<text x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" fill="#8a8983">${fmtNum(t, tdec)}</text>`;
  }
  const every = Math.ceil(bars.length / Math.max(1, Math.floor((W - m.l) / 60)));
  bars.forEach((b, i) => {
    const cx = m.l + slot * i + slot / 2;
    if (b.value != null && Number.isFinite(b.value)) {
      const y0 = y(Math.max(0, yMin));
      const y1 = y(b.value);
      const top = Math.min(y0, y1);
      const h = Math.max(1, Math.abs(y0 - y1));
      const r = Math.min(4, bw / 2, h);
      // rounded data-end, square baseline
      g += `<path data-i="${i}" d="M${cx - bw / 2},${top + h} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${top + h} Z" fill="${b.color}"/>`;
    }
    if (i % every === 0)
      g += `<text x="${cx}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#8a8983">${esc(b.label.length > 12 ? b.label.slice(0, 11) + '…' : b.label)}</text>`;
  });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.style.display = 'block';
  svg.innerHTML = g;
  host.appendChild(svg);
  const tip = tipAt(host);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left - m.l) / slot);
    const b = bars[i];
    if (!b || b.value == null) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = `<div style="opacity:.7">${esc(b.detail ?? b.label)}</div><b>${fmtNum(b.value, dec)}</b> ${esc(opts.unit ?? '')}`;
    placeTip(host, tip, ev.clientX - r.left, ev.clientY - r.top);
  });
  svg.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}

export function gauge(
  host: HTMLElement,
  value: number | null,
  o: { min: number; max: number; unit?: string; decimals?: number; bands?: { upTo: number | null; color: string }[]; sub?: string },
) {
  const W = Math.max(100, host.clientWidth);
  const H = Math.max(70, host.clientHeight);
  const r = Math.min(W / 2 - 8, H - 26);
  const cx = W / 2;
  const cy = r + 6;
  const a = (v: number) => Math.PI * (1 - Math.min(1, Math.max(0, (v - o.min) / (o.max - o.min || 1))));
  const pt = (ang: number, rr: number) => `${(cx + rr * Math.cos(ang)).toFixed(1)},${(cy - rr * Math.sin(ang)).toFixed(1)}`;
  const arc = (v0: number, v1: number, color: string, wdt: number) => {
    const a0 = a(v0);
    const a1 = a(v1);
    return `<path d="M${pt(a0, r)} A${r},${r} 0 0 1 ${pt(a1, r)}" fill="none" stroke="${color}" stroke-width="${wdt}" stroke-linecap="butt"/>`;
  };
  let g = arc(o.min, o.max, '#efeeea', 10);
  if (o.bands?.length) {
    let lo = o.min;
    for (const b of o.bands) {
      const hi = b.upTo === null ? o.max : Math.min(o.max, b.upTo);
      if (hi > lo) g += arc(lo, hi, b.color, 3).replace('stroke-width="3"', `stroke-width="3" transform="translate(0,0)"`);
      lo = hi;
    }
  }
  const ok = value != null && Number.isFinite(value);
  if (ok) g += arc(o.min, Math.min(o.max, Math.max(o.min, value!)), bandColor(value!, o.bands) ?? '#2a78d6', 10);
  g += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="${Math.max(14, r / 3)}" font-weight="500" fill="#0b0b0b">${ok ? fmtNum(value, o.decimals ?? 1) : '—'}</text>`;
  g += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="11" fill="#52514e">${esc(o.unit ?? '')}</text>`;
  g += `<text x="${cx - r}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="#8a8983">${fmtNum(o.min, 0)}</text>`;
  g += `<text x="${cx + r}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="#8a8983">${fmtNum(o.max, 0)}</text>`;
  host.innerHTML = `<svg width="${W}" height="${H}" style="display:block">${g}</svg>${o.sub ? `<div style="text-align:center;font-size:11px;color:#8a8983;margin-top:-14px">${esc(o.sub)}</div>` : ''}`;
}
