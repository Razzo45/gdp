import { describe, expect, it } from 'vitest';
import { shouldRetryWithoutSchema } from '@/domain/geminiSchema';

describe('shouldRetryWithoutSchema', () => {
  it('retries a generic INVALID_ARGUMENT 400 so seed calls can drop the schema', () => {
    expect(
      shouldRetryWithoutSchema({
        kind: 'refused',
        status: 400,
        message: '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
      }),
    ).toBe(true);
  });

  it('retries when Gemini names the schema as the problem', () => {
    expect(shouldRetryWithoutSchema({ kind: 'refused', message: 'Invalid response_json_schema' })).toBe(true);
  });

  it('does not retry a safety refusal or a rate limit', () => {
    expect(shouldRetryWithoutSchema({ kind: 'refused', message: 'Gemini refused to answer (SAFETY).' })).toBe(false);
    expect(shouldRetryWithoutSchema({ kind: 'rate_limit', status: 429, message: 'Gemini rate limit reached.' })).toBe(false);
  });
});
