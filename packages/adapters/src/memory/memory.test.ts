import { agentRepositoryContract, eventBusContract, messageRepositoryContract } from '@agent-office/core/testing'
import { InMemoryAgentRepository } from './agent-repository.ts'
import { InMemoryEventBus } from './event-bus.ts'
import { InMemoryMessageRepository } from './message-repository.ts'

agentRepositoryContract('InMemoryAgentRepository', () => new InMemoryAgentRepository())
messageRepositoryContract('InMemoryMessageRepository', (cap) => new InMemoryMessageRepository(cap))
eventBusContract('InMemoryEventBus', () => new InMemoryEventBus())
