export interface ErrorDetail {
  path: string;
  message: string;
}

/** Application error rendered as `{ "error": { "code", "message", "details"? } }`. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') =>
  new AppError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Resource not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export function errorBody(code: string, message: string, details?: ErrorDetail[]) {
  return { error: { code, message, ...(details && details.length ? { details } : {}) } };
}
