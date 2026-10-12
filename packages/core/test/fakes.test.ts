// The fakes are held to the same contracts as the real adapters.
import {
  FakeAgentRepository,
  FakeClaudeSettingsStore,
  FakeEventBus,
  FakeHookRunner,
  FakeMessageRepository,
  FakeSettingsRepository,
} from './fakes/index.ts'
import {
  agentRepositoryContract,
  eventBusContract,
  messageRepositoryContract,
} from './contracts/repositories.ts'
import {
  claudeSettingsStoreContract,
  hookRunnerContract,
  settingsRepositoryContract,
} from './contracts/stores.ts'

agentRepositoryContract('FakeAgentRepository', () => new FakeAgentRepository())
messageRepositoryContract('FakeMessageRepository', (cap) => new FakeMessageRepository(cap))
eventBusContract('FakeEventBus', () => new FakeEventBus())
settingsRepositoryContract('FakeSettingsRepository', async () => new FakeSettingsRepository())
claudeSettingsStoreContract('FakeClaudeSettingsStore', async (initial) => {
  const store = new FakeClaudeSettingsStore(initial)
  return { store, backup: async () => store.lastBackup }
})
hookRunnerContract('FakeHookRunner', async () => {
  const runner = new FakeHookRunner()
  return { runner, exists: async () => runner.installed }
})
