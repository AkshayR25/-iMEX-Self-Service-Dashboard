// D-054: the phone layout of read-only grids (render/grid.ts phoneLayout): 2 columns, reading order, no overlaps, no
// holes, minimum heights per widget type. Pure function; the Grid's switch at PHONE_W is covered by the E2E test.
import { describe, it, expect } from 'vitest';
import { phoneLayout, PHONE_COLS, PHONE_MIN_H, PHONE_W } from '../src/render/grid';

type It = { id: string; type: string; x: number; y: number; w: number; h: number; keys?: string[] };
const overlaps = (ws: It[]) => ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
/** Ids in the order they are read on the phone: top to bottom, left to right. */
const reading = (ws: It[]) => [...ws].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => w.id);
/** Every cell of the 2 columns from row 0 to the bottom is covered by exactly one widget. */
const noHoles = (ws: It[]) => {
  const bottom = Math.max(...ws.map((w) => w.y + w.h));
  for (let y = 0; y < bottom; y++)
    for (let x = 0; x < PHONE_COLS; x++) if (ws.filter((w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h).length !== 1) return false;
  return true;
};

// The machine page of the local app (Compressor dashboard): a KPI next to a Summary, three tiles, a row of
// value cards, a line chart next to a gauge.
const machine: It[] = [
  { id: 'kpi', type: 'kpi', x: 0, y: 0, w: 4, h: 2 },
  { id: 'sum', type: 'summary', x: 4, y: 0, w: 8, h: 2 },
  { id: 'hours', type: 'value', x: 0, y: 2, w: 2, h: 2 },
  { id: 'g1', type: 'gauge', x: 2, y: 2, w: 4, h: 3 },
  { id: 'g2', type: 'gauge', x: 6, y: 2, w: 4, h: 3 },
  { id: 'mv', type: 'multivalue', x: 0, y: 5, w: 4, h: 3, keys: ['a', 'b', 'c', 'd'] },
  { id: 'params', type: 'multivalue', x: 4, y: 5, w: 2, h: 3, keys: ['a', 'b', 'c', 'd'] },
  { id: 'alert', type: 'value', x: 6, y: 5, w: 2, h: 4 },
  { id: 'line', type: 'line', x: 0, y: 9, w: 8, h: 4 },
  { id: 'inlet', type: 'gauge', x: 8, y: 9, w: 4, h: 4 },
];

describe('phone layout (D-054)', () => {
  it('two columns: w >= 7 full width, anything else half', () => {
    const out = phoneLayout([
      { id: 'a', type: 'value', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', type: 'value', x: 6, y: 0, w: 6, h: 2 },
      { id: 'c', type: 'line', x: 0, y: 2, w: 7, h: 3 },
      { id: 'd', type: 'table', x: 0, y: 5, w: 12, h: 4 },
      { id: 'e', type: 'value', x: 0, y: 9, w: 1, h: 2 },
      { id: 'f', type: 'gauge', x: 1, y: 9, w: 3, h: 2 },
    ]);
    const by = Object.fromEntries(out.map((o) => [o.id, o]));
    expect([by.a.w, by.b.w, by.c.w, by.d.w, by.e.w, by.f.w]).toEqual([1, 1, 2, 2, 1, 1]);
    for (const o of out) {
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x + o.w).toBeLessThanOrEqual(PHONE_COLS);
    }
    expect([by.a.x, by.b.x, by.e.x, by.f.x]).toEqual([0, 1, 0, 1]);
  });

  it('keeps the reading order (y, then x), no overlaps, no holes', () => {
    const out = phoneLayout(machine);
    expect(out.map((o) => o.id)).toEqual(machine.map((m) => m.id)); // array order kept
    expect(reading(out)).toEqual(['kpi', 'sum', 'hours', 'g1', 'g2', 'mv', 'params', 'alert', 'line', 'inlet']);
    expect(overlaps(out)).toBe(false);
    expect(noHoles(out)).toBe(true);
    // stored layout untouched
    expect(machine[1]).toEqual({ id: 'sum', type: 'summary', x: 4, y: 0, w: 8, h: 2 });
  });

  it('reading order also from an unsorted list and stored rows with gaps', () => {
    const items: It[] = [
      { id: 'late', type: 'value', x: 6, y: 20, w: 6, h: 2 },
      { id: 'first', type: 'value', x: 0, y: 0, w: 3, h: 2 },
      { id: 'right', type: 'value', x: 9, y: 0, w: 3, h: 2 },
      { id: 'mid', type: 'bar', x: 0, y: 7, w: 12, h: 3 },
    ];
    const out = phoneLayout(items);
    expect(reading(out)).toEqual(['first', 'right', 'mid', 'late']);
    expect(overlaps(out)).toBe(false);
    expect(noHoles(out)).toBe(true);
    expect(out.find((o) => o.id === 'first')!.y).toBe(0);
  });

  it('minimum heights: charts, lists and tables 3 rows, value tiles and Summary 2, a KPI 3; taller ones kept', () => {
    const types = ['line', 'area', 'bar', 'donut', 'timeline', 'heatmap', 'table', 'alarms', 'value', 'summary', 'gauge', 'kpi'];
    const out = phoneLayout(types.map((t, i) => ({ id: t, type: t, x: 0, y: i, w: 12, h: 1 })));
    for (const o of out) expect(o.h).toBe(PHONE_MIN_H[o.type]);
    for (const t of ['line', 'area', 'bar', 'donut', 'timeline', 'heatmap', 'table', 'alarms']) expect(PHONE_MIN_H[t]).toBeGreaterThanOrEqual(3);
    expect(PHONE_MIN_H.summary).toBeGreaterThanOrEqual(2);
    expect(PHONE_MIN_H.value).toBeGreaterThanOrEqual(2);
    // taller than the minimum: kept; types without a minimum (text, image, link, embed, status) keep their height
    const tall = phoneLayout([
      { id: 'l', type: 'line', x: 0, y: 0, w: 12, h: 6 },
      { id: 't', type: 'text', x: 0, y: 6, w: 12, h: 1 },
      { id: 's', type: 'status', x: 0, y: 7, w: 12, h: 1 },
    ]);
    expect(tall.map((o) => o.h)).toEqual([6, 1, 1]);
    // a multi-value card: full width 3 rows with more than 3 values; at half width (name above value) rows for every value
    expect(phoneLayout([{ id: 'm', type: 'multivalue', x: 0, y: 0, w: 8, h: 2, keys: ['a', 'b', 'c', 'd'] }])[0].h).toBe(3);
    expect(phoneLayout([{ id: 'm', type: 'multivalue', x: 0, y: 0, w: 8, h: 2, keys: ['a', 'b'] }])[0].h).toBe(2);
    const half = (n: number) => phoneLayout([
      { id: 'm', type: 'multivalue', x: 0, y: 0, w: 4, h: 2, keys: Array.from({ length: n }, (_, i) => 'k' + i) },
      { id: 'v', type: 'value', x: 4, y: 0, w: 4, h: 2 },
    ])[0];
    expect([half(1).h, half(2).h, half(4).h, half(5).h]).toEqual([2, 3, 5, 6]);
    expect(half(4).w).toBe(1);
  });

  it('two half widgets share a row band at the taller height; a half widget without a partner fills the row', () => {
    const out = phoneLayout([
      { id: 'a', type: 'value', x: 0, y: 0, w: 4, h: 2 },
      { id: 'b', type: 'gauge', x: 4, y: 0, w: 4, h: 4 },
      { id: 'c', type: 'value', x: 8, y: 0, w: 4, h: 2 },
      { id: 'd', type: 'line', x: 0, y: 4, w: 12, h: 3 },
    ]);
    const by = Object.fromEntries(out.map((o) => [o.id, o]));
    expect([by.a.x, by.a.y, by.a.w, by.a.h]).toEqual([0, 0, 1, 4]);
    expect([by.b.x, by.b.y, by.b.w, by.b.h]).toEqual([1, 0, 1, 4]);
    expect([by.c.x, by.c.y, by.c.w, by.c.h]).toEqual([0, 4, 2, 2]); // alone before a full-width chart: full width
    expect([by.d.x, by.d.y, by.d.w]).toEqual([0, 6, 2]);
    expect(noHoles(out)).toBe(true);
  });

  it('empty and single-widget dashboards', () => {
    expect(phoneLayout([])).toEqual([]);
    expect(phoneLayout([{ id: 'a', type: 'value', x: 5, y: 3, w: 2, h: 2 }])[0]).toMatchObject({ x: 0, y: 0, w: 2, h: 2 });
  });

  it('a random 40-widget dashboard: valid widths, no overlaps, no holes, order kept', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const types = Object.keys(PHONE_MIN_H).concat(['text', 'image', 'status']);
    const items: It[] = Array.from({ length: 40 }, (_, i) => {
      const w = 1 + rnd(12);
      return { id: `w${i}`, type: types[rnd(types.length)], x: rnd(13 - w), y: rnd(30), w, h: 1 + rnd(5) };
    });
    const out = phoneLayout(items);
    expect(overlaps(out)).toBe(false);
    expect(noHoles(out)).toBe(true);
    const expected = [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => w.id);
    expect(reading(out)).toEqual(expected);
    for (const o of out) {
      expect([1, 2]).toContain(o.w);
      expect(o.h).toBeGreaterThanOrEqual(Math.max(items.find((i) => i.id === o.id)!.h, PHONE_MIN_H[o.type] ?? 1));
    }
  });

  it('the phone width is below the compact switch (D-040), so a phone never gets the 6-column layout', () => {
    expect(PHONE_W).toBe(600);
    expect(PHONE_COLS).toBe(2);
  });
});
