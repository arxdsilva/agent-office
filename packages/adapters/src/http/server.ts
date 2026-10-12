import { PortInUseError } from '@agent-office/core'
import type { HttpApi } from './http-api.ts'

export interface RunningServer {
  port: number
  close(): Promise<void>
}

/** Starts the API; EADDRINUSE surfaces as the domain's PortInUseError. */
export async function startHttpServer(app: HttpApi, opts: { host: string; port: number }): Promise<RunningServer> {
  try {
    await app.listen({ host: opts.host, port: opts.port })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(opts.port)
    throw err
  }
  const port = (app.server.address() as { port: number }).port
  return { port, close: () => app.close() }
}
