import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest, type ErrorDetail } from './errors.js';

export function zodDetails(issues: { path: (string | number)[]; message: string }[]): ErrorDetail[] {
  return issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Parse untrusted input with a Zod schema; throws 400 VALIDATION_ERROR on failure. */
export function parse<O, I = O>(schema: ZodType<O, ZodTypeDef, I>, input: unknown, what = 'Request'): O {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest(`${what} validation failed`, zodDetails(r.error.issues));
  return r.data;
}
