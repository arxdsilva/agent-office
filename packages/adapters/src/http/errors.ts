import { DomainError, RateLimitedError, UnknownAgentError, ValidationError } from '@agent-office/core'

/** The one place domain errors become HTTP status codes. */
export function httpStatusFor(err: unknown): number {
  if (err instanceof UnknownAgentError) return 404
  if (err instanceof RateLimitedError) return 429
  if (err instanceof ValidationError) return 400
  if (err instanceof DomainError) return 409
  const status = (err as { statusCode?: number }).statusCode
  return typeof status === 'number' && status >= 400 && status < 500 ? status : 500
}
