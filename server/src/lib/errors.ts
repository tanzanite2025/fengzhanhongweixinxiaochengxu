/**
 * Explicit application error carrying HTTP status code and machine-readable code.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Critical blocking error for corrupted data, missing credentials, or invariant violations.
 */
export class CriticalError extends Error {
  public readonly statusCode = 500;
  public readonly code = 'CRITICAL_ERROR';

  constructor(message: string) {
    super(message.startsWith('[CRITICAL]') ? message : `[CRITICAL] ${message}`);
    this.name = 'CriticalError';
  }
}
