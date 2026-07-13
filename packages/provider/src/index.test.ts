import { describe, it, expect } from 'vitest';
import { PROVIDER_PACKAGE_VERSION } from './index.js';

describe('provider package smoke', () => {
  it('exports version constant', () => {
    expect(PROVIDER_PACKAGE_VERSION).toBe('0.1.0');
  });
});
