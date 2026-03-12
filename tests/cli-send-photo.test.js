import { describe, expect, it } from 'vitest';

import { parseNonNegativeInt } from '../cli.js';

describe('tgcli send photo CLI validation', () => {
  it('rejects fractional --retries values', () => {
    expect(() => parseNonNegativeInt('1.5', '--retries')).toThrow(
      '--retries must be a non-negative integer',
    );
  });
});
