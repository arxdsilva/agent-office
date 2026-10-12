import { createServer } from 'node:net'
import { PortInUseError } from '@agent-office/core'
import { describe, expect, it } from 'vitest'
import { makeOffice } from '../../test/support.ts'
import { createAuth } from './auth.ts'
import { buildHttpApi } from './http-api.ts'
import { startHttpServer } from './server.ts'

const api = () => {
  const { office, scheduler } = makeOffice()
  scheduler.dispose()
  return buildHttpApi({ activity: office.activity, inbox: office.inbox, chat: office.chat, query: office.query }, createAuth({ token: 't'.repeat(64), port: 0 }))
}

describe('startHttpServer', () => {
  it('listens on an ephemeral port and closes', async () => {
    const s = await startHttpServer(api(), { host: '127.0.0.1', port: 0 })
    expect(s.port).toBeGreaterThan(0)
    await s.close()
  })

  it('maps EADDRINUSE to PortInUseError', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    await expect(startHttpServer(api(), { host: '127.0.0.1', port })).rejects.toBeInstanceOf(PortInUseError)
    blocker.close()
  })
})
