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
