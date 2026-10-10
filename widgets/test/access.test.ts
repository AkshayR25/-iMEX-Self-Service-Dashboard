// Access core (core/access.ts): runs every section of access-vectors.json (byte-identical copy of the App UI's
// tests/access-vectors.json, the contract shared with the JavaScript and Python copies), plus a few unit checks.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as A from '../src/core/access';

const V: any = JSON.parse(readFileSync(new URL('./access-vectors.json', import.meta.url), 'utf8'));
const plain = (x: any) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const treeOf = (name: string) => A.makeTree(V.trees[name]);
// the comparable part of an Access (as tests/access.test.mjs in the App UI repo)
function view(a: A.Access, c: any) {
  const p = plain(A.plain(a));
  const out: any = {};
  for (const k of ['devices', 'assets', 'nav', 'allRoots', 'unresolved', 'dropped', 'coversAll', 'sites']) out[k] = p[k];
  for (const k of ['has', 'hasAll', 'sees'] as const) if (c.expect[k]) out[k] = Object.fromEntries(Object.keys(c.expect[k]).map((id) => [id, a[k](id)]));
  return out;
}
const pick = (c: any, ks: string[]) => Object.fromEntries(ks.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

describe('access vectors (every runtime)', () => {
  it('parse', () => {
    for (const c of V.parse) expect(plain(A.parse(c.imexAccess, c.selectedNodes)), c.name).toEqual(c.expect);
  });
  it('normalize', () => {
    for (const c of V.normalize) expect(plain(A.normalize(c.grants, c.tree ? treeOf(c.tree) : undefined)), c.name).toEqual(c.expect);
  });
  it('resolve', () => {
    for (const c of V.resolve) expect(view(A.resolveTree(c.grants, treeOf(c.tree), pick(c, ['exists', 'notOwned', 'tops', 'maxDepth', 'names'])), c), c.name).toEqual(c.expect);
  });
  it('resolveUser', () => {
    for (const c of V.resolveUser) {
      const a = A.resolveUser(c.user, c.imexAccess, c.selectedNodes, treeOf(c.tree), pick(c, ['byName', 'notOwned', 'tops']));
      const got = view(a, c);
      got.unrestricted = a.unrestricted;
      got.source = a.source;
      got.warnings = plain(a.warnings);
      expect(got, c.name).toEqual(c.expect);
    }
  });
  it('pickByName and rootKey', () => {
    for (const c of V.pickByName) expect(plain(A.pickByName(c.cands)), c.name).toEqual(c.expect);
    for (const c of V.rootKey) expect(A.rootKey(c.userId, c.grants), c.name).toBe(c.expect);
  });
  it('every id in the file is a valid uuid, every section is there', () => {
    for (const id of Object.values<string>(V.ids)) expect(A.isUuid(id), id).toBe(true);
    for (const k of ['parse', 'normalize', 'resolve', 'resolveUser', 'pickByName', 'rootKey', 'selection', 'labels', 'compact', 'snapshot']) expect(V[k].length, k).toBeGreaterThan(0);
  });
});

describe('access vectors (the JavaScript-only sections, ported too)', () => {
  it('grantsFromSelection', () => {
    for (const c of V.selection) expect(plain(A.grantsFromSelection(treeOf(c.tree), c.selected, c.hints)), c.name).toEqual(c.expect);
  });
  it('summary lines and the compact form', () => {
    for (const c of V.labels) {
      const t = treeOf(c.tree);
      const editor = c.editor ? A.resolveTree(c.editor.grants, t) : undefined;
      expect(plain(A.summary(c.grants, t, { editor })), c.name).toEqual(c.expect);
    }
    for (const c of V.compact) {
      const t = treeOf(c.tree);
      const access = c.withAccess ? A.resolveTree(c.grants, t) : undefined;
      expect(A.compact(c.grants, t, { access }), c.name).toBe(c.expect);
    }
  });
  it('snapshot', () => {
    for (const c of V.snapshot) {
      const t = treeOf(c.tree);
      expect(plain(A.snapshot(A.resolveTree(c.grants, t), c.grants, t)), c.name).toEqual(c.expect);
    }
  });
});

describe('access core details', () => {
  it('sets, aliases, unrestricted; bad input is no access, never an error', () => {
    const a = A.resolveTree([{ id: V.ids.PUNE, type: 'ASSET', mode: 'all' }], treeOf('local'));
    expect(a.deviceIds).toBe(a.devices);
    expect(a.devices.size).toBe(3);
    expect(a.unrestricted).toBe(false);
    const u = A.unrestricted();
    expect(u.unrestricted).toBe(true);
    expect(u.has('anything')).toBe(true);
    expect(u.devices.size).toBe(0);
    expect(A.resolveTree(null, null).devices.size).toBe(0);
    expect(A.normalize(undefined)).toEqual([]);
  });
  it('more than 2000 grants: the first 2000, with a warning', () => {
    const many = Array.from({ length: 2005 }, (_, i) => ({ id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, type: 'DEVICE', mode: 'fixed' }));
    const p = A.parse({ v: 1, grants: many });
    expect(p.grants.length).toBe(2000);
    expect(p.warnings).toEqual(['grants.limit']);
  });
});
