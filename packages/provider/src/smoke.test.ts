import { describe, it, expect } from 'vitest';
import { ApiClient, SessionManager, StaffAgentClient, MechaDriver, loadConfig } from './index.js';

describe('provider package exports smoke', () => {
  it('ApiClient is a class', () => {
    expect(typeof ApiClient).toBe('function');
  });
  it('SessionManager is a class', () => {
    expect(typeof SessionManager).toBe('function');
  });
  it('StaffAgentClient is a class', () => {
    expect(typeof StaffAgentClient).toBe('function');
  });
  it('MechaDriver is a class', () => {
    expect(typeof MechaDriver).toBe('function');
  });
  it('loadConfig is a function', () => {
    expect(typeof loadConfig).toBe('function');
  });
});
