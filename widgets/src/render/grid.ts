// 12-column grid used for viewing (static) and editing (drag to move, corner to resize, drop from palette).
import type { Widget } from '../core/schema';
import { GRID_COLS } from '../core/schema';
import { renderWidget, RenderEnv, WidgetHandle } from './widgets';

export const ROW_H = 64;
export const GAP = 10;

export interface GridOptions {
  editable?: boolean;
  selectedId?: string | null;
  onSelect?(id: string | null): void;
  onChange?(widgets: Widget[]): void;
  /** Called when a palette item is dropped: type and target cell. */
  onDrop?(type: string, x: number, y: number): void;
  highlight?: Set<string>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Pushes widgets down so none overlap the moved one, then compacts upward. Pure. */
export function resolveCollisions<T extends Rect & { id: string }>(items: T[], movedId: string): T[] {
  const out = items.map((i) => ({ ...i }));
  const moved = out.find((i) => i.id === movedId);
  const order = out.filter((i) => i.id !== movedId).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: T[] = moved ? [moved] : [];
  for (const it of order) {
    while (placed.some((p) => overlaps(p, it))) it.y += 1;
    placed.push(it);
  }
  // compact upward (keep the moved one where the user put it)
  const sorted = [...out].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    if (it.id === movedId) continue;
    while (it.y > 0) {
      const probe = { ...it, y: it.y - 1 };
      if (out.some((o) => o.id !== it.id && overlaps(o, probe))) break;
      it.y -= 1;
    }
  }
  return out;
}

/** First free slot of size w x h, scanning rows top-down. Pure. */
export function firstFit(items: Rect[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < 500; y++)
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const r = { x, y, w, h };
      if (!items.some((i) => overlaps(i, r))) return { x, y };
    }
  return { x: 0, y: Math.max(0, ...items.map((i) => i.y + i.h)) };
}

export class Grid {
  private handles = new Map<string, WidgetHandle>();
  private boxes = new Map<string, HTMLElement>();
  private widgets: Widget[] = [];
  private colW = 0;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private env: RenderEnv, private opts: GridOptions = {}) {
    host.style.position = 'relative';
    this.ro = new ResizeObserver(() => this.layout(true));
    this.ro.observe(host);
    if (opts.editable) this.wireDrop();
    host.addEventListener('mousedown', (e) => {
      if (e.target === host) this.opts.onSelect?.(null);
    });
  }

  setEnv(env: RenderEnv) {
    this.env = env;
    this.render(this.widgets, true);
  }

  setOptions(o: Partial<GridOptions>) {
    Object.assign(this.opts, o);
    this.paintSelection();
  }

  /** Renders widgets; only (re)draws widgets whose config changed unless force. */
  render(widgets: Widget[], force = false) {
    const prev = new Map(this.widgets.map((w) => [w.id, JSON.stringify({ ...w, x: 0, y: 0, w: 0, h: 0 })]));
    this.widgets = widgets.map((w) => ({ ...w }));
    const ids = new Set(widgets.map((w) => w.id));
    for (const [id, h] of this.handles)
      if (!ids.has(id)) {
        h.destroy();
        this.handles.delete(id);
        this.boxes.get(id)?.remove();
        this.boxes.delete(id);
      }
    this.layout(false);
    for (const w of this.widgets) {
      let box = this.boxes.get(w.id);
      const sig = JSON.stringify({ ...w, x: 0, y: 0, w: 0, h: 0 });
      const sizeChanged = box && (box.dataset.w !== String(w.w) || box.dataset.h !== String(w.h));
      if (!box) {
        box = this.makeBox(w);
        this.boxes.set(w.id, box);
        this.host.appendChild(box);
      }
      this.place(box, w);
      if (force || !this.handles.has(w.id) || prev.get(w.id) !== sig || sizeChanged) {
        this.handles.get(w.id)?.destroy();
        const inner = box.querySelector('.dbb-gi') as HTMLElement;
        this.handles.set(w.id, renderWidget(inner, w, this.env));
      }
      box.dataset.w = String(w.w);
      box.dataset.h = String(w.h);
    }
    const rows = Math.max(4, ...this.widgets.map((w) => w.y + w.h)) + (this.opts.editable ? 3 : 0);
    this.host.style.minHeight = `${rows * (ROW_H + GAP)}px`;
    this.paintSelection();
  }

  refreshAll() {
    for (const h of this.handles.values()) void h.refresh();
  }

  destroy() {
    this.ro.disconnect();
    for (const h of this.handles.values()) h.destroy();
    this.host.innerHTML = '';
  }

  private layout(reflow: boolean) {
    const W = this.host.clientWidth;
    const colW = (W - GAP * (GRID_COLS + 1)) / GRID_COLS;
    const changed = Math.abs(colW - this.colW) > 1;
    this.colW = colW;
    if (reflow && changed) {
      for (const w of this.widgets) {
        const b = this.boxes.get(w.id);
        if (b) this.place(b, w);
      }
      for (const h of this.handles.values()) void h.refresh();
    }
  }

  private px(w: { x: number; y: number; w: number; h: number }) {
    return {
      left: GAP + w.x * (this.colW + GAP),
      top: GAP + w.y * (ROW_H + GAP),
      width: w.w * this.colW + (w.w - 1) * GAP,
      height: w.h * ROW_H + (w.h - 1) * GAP,
    };
  }

  private place(box: HTMLElement, w: Widget) {
    const p = this.px(w);
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
  }

  private makeBox(w: Widget): HTMLElement {
    const box = document.createElement('div');
    box.className = 'dbb-gbox';
    box.dataset.id = w.id;
    box.style.position = 'absolute';
    box.innerHTML = `<div class="dbb-gi" style="height:100%"></div>`;
    if (this.opts.editable) {
      const bar = document.createElement('div');
      bar.className = 'dbb-gdrag';
      bar.title = 'Drag to move';
      const rz = document.createElement('div');
      rz.className = 'dbb-gresize';
      rz.title = 'Drag to resize';
      box.appendChild(bar);
      box.appendChild(rz);
      box.addEventListener('mousedown', () => this.opts.onSelect?.(box.dataset.id!));
      this.wireDrag(box, bar, 'move');
      this.wireDrag(box, rz, 'resize');
    }
    return box;
  }

  private paintSelection() {
    for (const [id, b] of this.boxes) {
      b.classList.toggle('sel', id === this.opts.selectedId);
      b.classList.toggle('hl', !!this.opts.highlight?.has(id));
    }
  }

  private wireDrag(box: HTMLElement, handle: HTMLElement, kind: 'move' | 'resize') {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = box.dataset.id!;
      this.opts.onSelect?.(id);
      const w0 = this.widgets.find((w) => w.id === id)!;
      const start = { x: e.clientX, y: e.clientY };
      const cellW = this.colW + GAP;
      const cellH = ROW_H + GAP;
      let cur = { ...w0 };
      handle.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - start.x) / cellW);
        const dy = Math.round((ev.clientY - start.y) / cellH);
        if (kind === 'move') {
          cur = { ...w0, x: Math.min(GRID_COLS - w0.w, Math.max(0, w0.x + dx)), y: Math.max(0, w0.y + dy) };
        } else {
          cur = { ...w0, w: Math.min(GRID_COLS - w0.x, Math.max(1, w0.w + dx)), h: Math.min(20, Math.max(1, w0.h + dy)) };
        }
        this.place(box, cur);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        box.classList.remove('dragging');
        if (cur.x === w0.x && cur.y === w0.y && cur.w === w0.w && cur.h === w0.h) return;
        const next = resolveCollisions(
          this.widgets.map((w) => (w.id === id ? cur : w)),
          id,
        );
        this.opts.onChange?.(next);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private wireDrop() {
    const ghost = document.createElement('div');
    ghost.className = 'dbb-ghost';
    ghost.style.display = 'none';
    this.host.appendChild(ghost);
    const cell = (e: DragEvent) => {
      const r = this.host.getBoundingClientRect();
      const x = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((e.clientX - r.left - GAP) / (this.colW + GAP))));
      const y = Math.max(0, Math.floor((e.clientY - r.top - GAP) / (ROW_H + GAP)));
      return { x, y };
    };
    this.host.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/dbb-widget')) return;
      e.preventDefault();
      const c = cell(e);
      const p = this.px({ x: c.x, y: c.y, w: 3, h: 2 });
      Object.assign(ghost.style, { display: 'block', left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
    });
    this.host.addEventListener('dragleave', () => (ghost.style.display = 'none'));
    this.host.addEventListener('drop', (e) => {
      ghost.style.display = 'none';
      const t = e.dataTransfer?.getData('text/dbb-widget');
      if (!t) return;
      e.preventDefault();
      const c = cell(e);
      this.opts.onDrop?.(t, c.x, c.y);
    });
  }
}

export const GRID_CSS = `
.dbb-gbox{transition:left .12s,top .12s,width .12s,height .12s}
.dbb-gbox.dragging{transition:none;z-index:10;opacity:.9}
.dbb-gbox.sel .dbb-card{outline:2px solid var(--accent);outline-offset:1px}
.dbb-gbox.hl .dbb-card{box-shadow:0 0 0 3px #86b6ef}
.dbb-gdrag{position:absolute;left:0;right:28px;top:0;height:28px;cursor:move}
.dbb-gresize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#b8b7b1 50%,#b8b7b1 60%,transparent 60%,transparent 70%,#b8b7b1 70%,#b8b7b1 80%,transparent 80%);border-bottom-right-radius:8px}
.dbb-ghost{position:absolute;border:2px dashed var(--accent);border-radius:8px;background:rgba(42,120,214,.06);pointer-events:none}
`;
