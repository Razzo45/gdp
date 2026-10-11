import { describe, expect, it } from 'vitest';
import { cachedGeminiUriDecision } from '@/domain/geminiFileCache';

describe('cached Gemini file handle', () => {
  it('keeps the row when status check fails or is still processing', () => {
    expect(cachedGeminiUriDecision({ getFailed: true })).toBe('keep');
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'PROCESSING' })).toBe('keep');
  });

  it('reuses an active URI and drops a failed one', () => {
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'ACTIVE', uri: 'files/abc' })).toBe('use');
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'FAILED' })).toBe('drop');
  });
});
