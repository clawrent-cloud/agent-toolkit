import { describe, it, expect } from 'vitest';
import { diffSessionStates } from './helpers.js';
import type { SessionSummary } from './types.js';

describe('diffSessionStates', () => {
  const s = (id: string, status: string): SessionSummary => ({ sessionId: id, status });

  it('detects new pending sessions', () => {
    const diff = diffSessionStates([], [s('a', 'pending_approval')]);
    expect(diff.newPending.map(x => x.sessionId)).toEqual(['a']);
  });
  it('detects activation (pending → active)', () => {
    const diff = diffSessionStates([s('a', 'pending_approval')], [s('a', 'active')]);
    expect(diff.activated.map(x => x.sessionId)).toEqual(['a']);
  });
  it('detects ended (present → missing)', () => {
    const diff = diffSessionStates([s('a', 'active')], []);
    expect(diff.ended.map(x => x.sessionId)).toEqual(['a']);
  });
  it('ignores unchanged', () => {
    const diff = diffSessionStates([s('a', 'active')], [s('a', 'active')]);
    expect(diff.newPending).toEqual([]);
    expect(diff.activated).toEqual([]);
    expect(diff.ended).toEqual([]);
  });
});
