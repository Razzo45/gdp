/**
 * Structured JSON (`responseJsonSchema`) is rejected by some Gemini calls
 * with a generic 400, not a schema-named error. Retry those once without
 * the schema. Safety blocks are a different refusal — do not retry those.
 */
export function shouldRetryWithoutSchema(error: { kind: string; message: string; status?: number }): boolean {
  if (error.kind !== 'refused') return false;
  if (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(error.message)) return false;
  if (/schema|response_json_schema|responseJsonSchema/i.test(error.message)) return true;
  return error.status === 400 || /INVALID_ARGUMENT|invalid argument/i.test(error.message);
}
