import { gateRunnerContract } from '@agent-office/core/testing'
import { ProcessGateRunner } from './validation-runner.ts'

gateRunnerContract('ProcessGateRunner', () => new ProcessGateRunner())
