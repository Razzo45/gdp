import { describe, expect, it } from 'vitest';
import { cachedGeminiUriDecision } from '@/domain/geminiFileCache';

describe('cached Gemini file handle', () => {
  it('keeps the row when status check fails or is still processing', () => {
    expect(cachedGeminiUriDecision({ getFailed: true })).toBe('keep');
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'PROCESSING' })).toBe('keep');
  });

  it('drops the row when Gemini says the file is gone or belongs to another key', () => {
    expect(cachedGeminiUriDecision({ getFailed: true, status: 403 })).toBe('drop');
    expect(cachedGeminiUriDecision({ getFailed: true, status: 404 })).toBe('drop');
    expect(cachedGeminiUriDecision({ getFailed: true, status: 503 })).toBe('keep');
  });

  it('reuses an active URI and drops a failed one', () => {
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'ACTIVE', uri: 'files/abc' })).toBe('use');
    expect(cachedGeminiUriDecision({ getFailed: false, state: 'FAILED' })).toBe('drop');
  });
});
