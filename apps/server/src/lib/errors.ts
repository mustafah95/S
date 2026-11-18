export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
export const locked = (message: string) => new AppError(423, 'locked', message);
export const upgradeRequired = (message: string) => new AppError(426, 'upgrade_required', message);
export const tooMany = (message: string) => new AppError(429, 'rate_limited', message);
export const serviceUnavailable = (message: string, code = 'service_unavailable') =>
  new AppError(503, code, message);

/** Message shown to staff when the database refuses an overlapping table allocation (critical test §81). */
export const TABLE_UNAVAILABLE_MESSAGE = 'Table no longer available. Please select another table/time.';

export const tableUnavailable = (details?: unknown) =>
  new AppError(409, 'table_unavailable', TABLE_UNAVAILABLE_MESSAGE, details);

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Drizzle wraps driver errors (DrizzleQueryError) — the PostgreSQL error is in `cause`. */
export function pgErrorOf(err: unknown): PgError | undefined {
  let e = err as (PgError & { cause?: unknown }) | undefined;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    e = e.cause as typeof e;
  }
  return undefined;
}

/** Translate PostgreSQL integrity errors into API errors. */
export function fromPgError(err: unknown): AppError | undefined {
  const e = pgErrorOf(err);
  if (!e || typeof e.code !== 'string') return undefined;
  switch (e.code) {
    case '23P01':
      if (e.constraint === 'table_allocations_no_overlap') return tableUnavailable();
      return conflict('exclusion_violation', 'Conflicting record');
    case '23505':
      return conflict('duplicate', 'A record with the same unique value already exists', { constraint: e.constraint });
    case '23503':
      return unprocessable('invalid_reference', 'Referenced record does not exist', { constraint: e.constraint });
    case '23514':
      return unprocessable('constraint_violation', 'Value violates a database rule', { constraint: e.constraint });
    case '22P02':
      return badRequest('Invalid identifier or value format');
    case '40001':
    case '40P01':
      return conflict('retry', 'Concurrent update detected, please retry');
    default:
      return undefined;
  }
}

export function isPgError(err: unknown, code: string): boolean {
  return pgErrorOf(err)?.code === code;
}
