import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sanitizeHtml, fillPlaceholders, placeholderKeys, cleanStyle } from '../src/render/rich';
import { matchRule, valueType, bandsToRules, thresholdLines, stateLabel } from '../src/render/rules';
import { Dashboard, checkDashboard, WIDGET_TYPES, WIDGET_GROUPS, WIDGET_CAPS, DEFAULT_SIZE } from '../src/core/schema';
import { TEMPLATES } from '../src/render/templates';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';

describe('rich text sanitiser', () => {
  it('keeps formatting and drops scripts, handlers and bad links', () => {
    const out = sanitizeHtml(
      '<h2 onclick="x()">Hi <b>there</b></h2><script>alert(1)</script><p style="color:#d03b3b;position:fixed;background-image:url(x)">t</p><a href="javascript:alert(1)">bad</a><a href="https://x.io">ok</a><img src=x onerror=alert(1)><iframe src="https://evil"></iframe>',
    );
    expect(out).toContain('<h2>Hi <b>there</b></h2>');
    expect(out).not.toMatch(/script|onclick|onerror|iframe|img|javascript|position|url\(/i);
    expect(out).toContain('<p style="color: #d03b3b">t</p>');
    expect(out).toContain('<a>bad</a>');
    expect(out).toContain('href="https://x.io" target="_blank" rel="noopener noreferrer"');
  });
  it('converts <font> to spans, closes open tags and escapes stray brackets', () => {
    expect(sanitizeHtml('<font color="#2a78d6" face="Inter" size="5">x</font>')).toBe('<span style="color: #2a78d6; font-family: Inter; font-size: 24px">x</span>');
    expect(sanitizeHtml('<b><i>open')).toBe('<b><i>open</i></b>');
    expect(sanitizeHtml('a < b > c &amp; d & e')).toBe('a &lt; b &gt; c &amp; d &amp; e');
    expect(sanitizeHtml('<p>x</b></p>')).toBe('<p>x</p>');
  });
  it('rejects style values with expressions or urls', () => {
    expect(cleanStyle('color: red; font-size: 18px; background-color: expression(alert(1)); width: 100px')).toBe('color: red; font-size: 18px');
  });
  it('fills placeholders with escaped values', () => {
    expect(placeholderKeys('{{dischargeTemp}} at {{machine}} {{ powerKw }}')).toEqual(['dischargeTemp', 'powerKw']);
    expect(fillPlaceholders('T={{t}} M={{m}}', { t: '<b>85</b>' })).toBe('T=<span class="dbb-ph-v">&lt;b&gt;85&lt;/b&gt;</span> M=<span class="dbb-ph-v">—</span>');
  });
});

describe('colour rules', () => {
  it('matches numbers, booleans and text, first match wins, key-scoped', () => {
    const rules = [
      { op: 'gt' as const, value: 90, color: 'red' },
      { op: 'gt' as const, value: 75, color: 'amber' },
      { op: 'between' as const, value: 0, value2: 75, color: 'green' },
    ];
    expect(matchRule(rules, 95)?.color).toBe('red');
    expect(matchRule(rules, '80')?.color).toBe('amber');
    expect(matchRule(rules, 10)?.color).toBe('green');
    expect(matchRule(rules, 'n/a')).toBeNull();
    expect(matchRule([{ op: 'isTrue', color: 'g' }, { op: 'isFalse', color: 'n' }], 1)?.color).toBe('g');
    expect(matchRule([{ op: 'isTrue', color: 'g' }, { op: 'isFalse', color: 'n' }], 'false')?.color).toBe('n');
    expect(matchRule([{ op: 'contains', value: 'fault', color: 'r' }], 'Motor FAULT')?.color).toBe('r');
    expect(matchRule([{ op: 'eq', value: 'Idle', color: 'y' }], 'idle')?.color).toBe('y');
    expect(matchRule([{ key: 'a', op: 'gt', value: 1, color: 'x' }], 5, 'b')).toBeNull();
  });
  it('infers value types and labels states', () => {
    expect(valueType({ key: 'runStatus', max: 1 })).toBe('boolean');
    expect(valueType({ key: 'dischargeTemp', max: 120 })).toBe('number');
    expect(valueType({ key: 'mode' }, 'AUTO')).toBe('string');
    expect(valueType({ key: 'x', type: 'string' }, 5)).toBe('string');
    expect(stateLabel(1, [{ op: 'isTrue', color: 'g', label: 'Running' }], { key: 'runStatus', max: 1 })).toBe('Running');
    expect(stateLabel(0, [], { key: 'runStatus', max: 1 })).toBe('Stopped');
    expect(stateLabel(1, [], { key: 'heaterOn', type: 'boolean' })).toBe('On');
  });
  it('converts legacy bands and extracts threshold lines', () => {
    const r = bandsToRules([
      { upTo: 7, color: 'g' },
      { upTo: 8, color: 'a' },
      { upTo: null, color: 'r' },
    ]);
    expect(matchRule(r, 6)?.color).toBe('g');
    expect(matchRule(r, 7.5)?.color).toBe('a');
    expect(matchRule(r, 9)?.color).toBe('r');
    expect(thresholdLines([{ op: 'gt', value: 8, color: 'r' }, { op: 'between', value: 2, value2: 4, color: 'b' }]).map((t) => t.value)).toEqual([2, 4, 8]);
  });
});

describe('schema for new widgets', () => {
  it('every widget type has caps, size and a palette group', () => {
    const grouped = new Set(WIDGET_GROUPS.flatMap((g) => g.types));
    for (const t of WIDGET_TYPES) {
      expect(WIDGET_CAPS[t]).toBeTruthy();
      expect(DEFAULT_SIZE[t]).toBeTruthy();
      expect(grouped.has(t)).toBe(true);
    }
  });
  it('accepts rules, styles and themes; rejects bad colours and http embeds', () => {
    const base: any = {
      schemaVersion: 1, id: 'd1', name: 'x', kind: 'device', profile: 'Compressor', timeRange: '24h', ownerId: 'u', ownerName: 'u', version: 0, updatedAt: 0, updatedBy: 'u',
      theme: { preset: 'dark', accent: '#3987e5', font: 'Inter', radius: 16 },
      widgets: [
        { id: 'a', type: 'kpi', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['p'], settings: { colorRules: [{ op: 'gt', value: 8, color: '#d03b3b', label: 'High' }], style: { icon: 'gauge', bg: '#184f95', gradient: true } } },
        { id: 'b', type: 'embed', title: '', x: 3, y: 0, w: 3, h: 2, binding: { mode: 'none' }, keys: [], settings: { url: 'http://x.io' } },
      ],
    };
    const ok = Dashboard.safeParse(base);
    expect(ok.success).toBe(true);
    expect(checkDashboard(ok.success ? ok.data : base).join(' ')).toMatch(/https/);
    const bad = JSON.parse(JSON.stringify(base));
    bad.widgets[0].settings.colorRules[0].color = 'red;background:url(x)';
    expect(Dashboard.safeParse(bad).success).toBe(false);
  });
});

describe('templates and chat with the new options', () => {
  let tb: FakeTB;
  const mem = new Map<string, string>();
  beforeEach(() => {
    tb = ithena();
    mem.clear();
    mem.set('jwt_token', 'x');
    vi.stubGlobal('fetch', tb.fetch);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  });

  it('every template builds a valid, non-overlapping compressor dashboard', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    for (const t of TEMPLATES) {
      const d = store.blankDashboard(ctx, t.name, 'Compressor');
      d.widgets = t.build(ctx, 'Compressor', 'pc');
      d.theme = t.theme;
      const p = Dashboard.safeParse(d);
      expect(p.success, `${t.id}: ${!p.success && JSON.stringify(p.error.issues.slice(0, 2))}`).toBe(true);
      expect(checkDashboard(d), t.id).toEqual([]);
      for (const a of d.widgets)
        for (const b of d.widgets) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${t.id}: ${a.title} overlaps ${b.title}`).toBe(false);
    }
  });

  it('chat can add a KPI with rules, a rich text note (sanitised) and set a dark theme', async () => {
    asUser(tb, 'u1', 'Admin', ['root']);
    const ctx = await scope.loadUserContext();
    const cat = chat.buildCatalog(ctx);
    const draft = store.blankDashboard(ctx, 'x', 'Compressor');
    const out = chat.normaliseToolInput({
      reply: 'ok',
      ops: [
        { op: 'addWidget', type: 'kpi', title: 'Temp', keys: ['dischargeTemp'], binding: { mode: 'current' }, settings: { colorRules: [{ op: 'gt', value: 95, color: '#d03b3b', label: 'Hot' }], style: { icon: 'thermometer' } } },
        { op: 'addWidget', type: 'text', title: '', settings: { html: '<h2>Hello {{machine}}</h2><script>x</script>' } },
        { op: 'addWidget', type: 'link', title: 'Back to sites', settings: { linkKind: 'state', linkState: 'default' } },
        { op: 'setTheme', theme: { preset: 'dark', font: 'Inter' } },
      ],
    });
    const res = chat.applyOps(ctx, draft, out, cat);
    expect(res.draft.theme).toEqual({ preset: 'dark', font: 'Inter' });
    const text = res.draft.widgets.find((w) => w.type === 'text')!;
    expect(text.settings.html).toBe('<h2>Hello {{machine}}</h2>');
    expect(text.binding).toEqual({ mode: 'none' });
    expect(res.draft.widgets.find((w) => w.type === 'link')!.binding).toEqual({ mode: 'none' });
    expect(res.draft.widgets.find((w) => w.type === 'kpi')!.settings.colorRules?.[0].label).toBe('Hot');
  });
});

import { WidgetSettings } from '../src/core/schema';
describe('image url limits', () => {
  it('accepts an uploaded data URI up to ~150 KB but caps web addresses', () => {
    expect(WidgetSettings.safeParse({ url: 'data:image/png;base64,' + 'A'.repeat(200000) }).success).toBe(true);
    expect(WidgetSettings.safeParse({ url: 'https://x.io/' + 'a'.repeat(2100) }).success).toBe(false);
  });
});
