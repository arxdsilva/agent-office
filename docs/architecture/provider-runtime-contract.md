# Provider runtime contract

A provider is one agent runtime (`PROVIDER_IDS`), declared in `core/src/domain/providers.ts`
(`ProviderDecl`: label, id prefix, managed and observed caps, integration kind, tested version).
Managed sessions run through an `AgentRunner` (driven port): Claude Agent SDK, Codex app-server,
ACP (`AcpRunner` + one `AcpProfile` per runtime), HTTP, or CLI task mode. Every runner passes
`managedRuntimeContract`; every probe passes `providerProbeContract`. History comes from a
per-provider `HistorySource` (`HistorySources`). The runtime is not the model vendor
(`Agent.modelProvider`). Details: `docs/provider-integrations.md` §8.
