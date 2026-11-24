import { CriticalError } from './errors.js';

/**
 * Strictly parse a JSON string expected to be a string array.
 * Fails loudly instead of masking corrupted database fields with empty arrays.
 */
export function parseStringArrayJson(raw: string, fieldName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CriticalError(
      `Invalid JSON stored in ${fieldName}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new CriticalError(`Expected string[] JSON in ${fieldName}`);
  }
  return parsed;
}
