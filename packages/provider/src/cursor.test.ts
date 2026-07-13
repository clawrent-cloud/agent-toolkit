import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { InMemoryCursorStore, FileCursorStore } from './cursor.js';

const TMP = './.tmp-cursor-test.json';

describe('InMemoryCursorStore', () => {
  it('returns null when no cursor set', () => {
    const s = new InMemoryCursorStore();
    expect(s.get('sess-1')).toBeNull();
  });
  it('set then get returns the value', () => {
    const s = new InMemoryCursorStore();
    s.set('sess-1', '2026-07-13T00:00:00.000Z');
    expect(s.get('sess-1')).toBe('2026-07-13T00:00:00.000Z');
  });
  it('set advances only forward', () => {
    const s = new InMemoryCursorStore();
    s.set('sess-1', '2026-07-13T05:00:00.000Z');
    s.set('sess-1', '2026-07-13T03:00:00.000Z'); // 更早,忽略
    expect(s.get('sess-1')).toBe('2026-07-13T05:00:00.000Z');
  });
});

describe('FileCursorStore', () => {
  beforeEach(() => { rmSync(TMP, { force: true }); });
  afterEach(() => { rmSync(TMP, { force: true }); });

  it('persists across instances', () => {
    const s1 = new FileCursorStore(TMP);
    s1.set('sess-1', '2026-07-13T01:00:00.000Z');
    const s2 = new FileCursorStore(TMP);
    expect(s2.get('sess-1')).toBe('2026-07-13T01:00:00.000Z');
  });
  it('tolerates missing file', () => {
    const s = new FileCursorStore(TMP);
    expect(s.get('sess-1')).toBeNull();
  });
});
