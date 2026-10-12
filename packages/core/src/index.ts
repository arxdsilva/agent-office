// Public surface of the core: ports, domain types/errors and the use cases.
export * from './ports/driven.ts'
export * from './ports/driving.ts'
export * from './domain/errors.ts'
export { applyEvent, toDto, type AgentState, type SweepPolicy } from './domain/agent.ts'
export { HOOK_MARKER, addHooks, hookStatus, removeHooks } from './domain/hook-config.ts'
export type { Note } from './domain/attention.ts'
export type { TrayAction, TrayItem, TrayModel } from './domain/tray.ts'
export { createOffice, DEFAULT_SWEEP_POLICY, type OfficeCore, type OfficeDeps } from './application/office.ts'
// Individual use cases, for driving adapters that need just one (e.g. the hook CLI).
export { HookService } from './application/hook-service.ts'
