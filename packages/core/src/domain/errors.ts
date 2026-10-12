/** Base class for rule violations; adapters map these to transport-specific errors. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
export class UnknownAgentError extends DomainError {
  constructor(readonly agentId: string) {
    super(`unknown agent: ${agentId}`)
  }
}
export class RateLimitedError extends DomainError {
  constructor() {
    super('too many messages')
  }
}
export class ValidationError extends DomainError {}
export class PortInUseError extends DomainError {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`)
  }
}
export type SessionStartCode = 'auth' | 'runtime' | 'folder' | 'limit' | 'other'
/** A managed session could not start; `code` picks the user-facing message. */
export class SessionStartError extends DomainError {
  constructor(
    readonly code: SessionStartCode,
    message = code,
  ) {
    super(message)
  }
}
/** The action is not allowed by the user's settings (e.g. bypass mode while it's disabled). */
export class NotAllowedError extends DomainError {}
