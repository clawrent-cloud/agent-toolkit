import { describe, it, expect } from 'vitest';
import {
  evaluateServeRules,
  matchRule,
  type ServeRule,
  type SessionCtx,
} from './serve-rules.js';

const ctx = (over: Partial<SessionCtx> = {}): SessionCtx => ({ sessionId: 's1', ...over });

describe('evaluateServeRules — defaults', () => {
  it('returns serve when rules are null', () => {
    expect(evaluateServeRules(null, ctx())).toBe('serve');
  });
  it('returns serve when rules are undefined', () => {
    expect(evaluateServeRules(undefined, ctx())).toBe('serve');
  });
  it('returns serve when rules are empty', () => {
    expect(evaluateServeRules([], ctx())).toBe('serve');
  });
  it('returns serve when no rule matches', () => {
    const rules: ServeRule[] = [{ match: { sessionType: 'consultation' }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx({ sessionType: 'agent_to_agent' }))).toBe('serve');
  });
});

describe('evaluateServeRules — first match wins', () => {
  it('returns the first matching rule action (serve)', () => {
    const rules: ServeRule[] = [
      { match: { sessionType: 'consultation' }, action: 'skip' },
      { match: { sessionType: 'agent_to_agent' }, action: 'serve' },
    ];
    expect(evaluateServeRules(rules, ctx({ sessionType: 'agent_to_agent' }))).toBe('serve');
  });
  it('returns the first matching rule action (skip), ignoring later rules', () => {
    const rules: ServeRule[] = [
      { match: { peerAgentId: 'agt_evil' }, action: 'skip' },
      { match: { sessionType: 'agent_to_agent' }, action: 'serve' },
    ];
    expect(
      evaluateServeRules(rules, ctx({ sessionType: 'agent_to_agent', peerAgentIds: ['agt_evil', 'agt_ok'] })),
    ).toBe('skip');
  });
});

describe('evaluateServeRules — field semantics', () => {
  it('sessionType: equals', () => {
    const rules: ServeRule[] = [{ match: { sessionType: 'consultation' }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx({ sessionType: 'consultation' }))).toBe('skip');
    expect(evaluateServeRules(rules, ctx({ sessionType: 'agent_to_agent' }))).toBe('serve');
  });
  it('peerAgentId: any-of (contained in peerAgentIds)', () => {
    const rules: ServeRule[] = [{ match: { peerAgentId: 'agt_x' }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx({ peerAgentIds: ['agt_x'] }))).toBe('skip');
    expect(evaluateServeRules(rules, ctx({ peerAgentIds: ['agt_y', 'agt_z'] }))).toBe('serve');
  });
  it('peerParticipantType: any-of', () => {
    const rules: ServeRule[] = [{ match: { peerParticipantType: 'human' }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx({ peerParticipantTypes: ['agent'] }))).toBe('serve');
    expect(evaluateServeRules(rules, ctx({ peerParticipantTypes: ['human', 'agent'] }))).toBe('skip');
  });
  it('tags: non-empty intersection', () => {
    const rules: ServeRule[] = [{ match: { tags: ['blocked', 'spam'] }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx({ tags: ['blocked'] }))).toBe('skip');
    expect(evaluateServeRules(rules, ctx({ tags: ['vip', 'blocked'] }))).toBe('skip');
    expect(evaluateServeRules(rules, ctx({ tags: ['ok'] }))).toBe('serve');
  });
});

describe('evaluateServeRules — AND semantics', () => {
  it('a rule with multiple fields matches only if all hold', () => {
    const rules: ServeRule[] = [
      { match: { sessionType: 'consultation', peerAgentId: 'agt_x' }, action: 'skip' },
    ];
    // both hold → skip
    expect(evaluateServeRules(rules, ctx({ sessionType: 'consultation', peerAgentIds: ['agt_x'] }))).toBe('skip');
    // only sessionType holds → no match → default serve
    expect(evaluateServeRules(rules, ctx({ sessionType: 'consultation', peerAgentIds: ['agt_y'] }))).toBe('serve');
  });
});

describe('evaluateServeRules — defensive', () => {
  it('unknown match field never matches', () => {
    const rules: ServeRule[] = [{ match: { color: 'red' }, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx())).toBe('serve');
  });
});

describe('matchRule', () => {
  it('empty match matches everything (catch-all)', () => {
    expect(matchRule({}, ctx())).toBe(true);
    expect(matchRule({}, ctx({ sessionType: 'x', tags: ['y'] }))).toBe(true);
  });
  it('catch-all rule overrides default', () => {
    const rules: ServeRule[] = [{ match: {}, action: 'skip' }];
    expect(evaluateServeRules(rules, ctx())).toBe('skip');
  });
});
