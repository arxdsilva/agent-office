import { readFile, stat } from 'node:fs/promises'

const SERVER = /^[A-Za-z0-9_.-]{1,100}$/
/** At most this many MCP servers are declared per provider. */
export const MAX_MCP_SERVERS = 24

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const keysOf = (v: unknown): string[] => (isObject(v) ? Object.keys(v) : [])

/**
 * Reads Claude Code's `~/.claude.json` for capability discovery. Returns **only the keys** of
 * `mcpServers` (top level and `projects[<cwd>]`); commands, args, URLs and env are never
 * returned or logged (PRIVACY_SECURITY rule).
 */
export class ClaudeConfigReader {
  constructor(
    private file: string,
    private opts: { maxBytes?: number } = {},
  ) {}

  async mcpServers(cwds: string[]): Promise<string[]> {
    const json = await this.load()
    if (!json) return []
    const projects = isObject(json.projects) ? json.projects : {}
    const names = [
      ...keysOf(json.mcpServers),
      ...cwds.flatMap((cwd) =>
        Object.hasOwn(projects, cwd) && isObject(projects[cwd])
          ? keysOf((projects[cwd] as Json).mcpServers)
          : [],
      ),
    ].filter((n) => SERVER.test(n))
    return [...new Set(names)].slice(0, MAX_MCP_SERVERS)
  }

  private async load(): Promise<Json | undefined> {
    try {
      const s = await stat(this.file)
      if (!s.isFile() || s.size > (this.opts.maxBytes ?? 32 * 1024 * 1024)) return undefined
      const json: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return isObject(json) ? json : undefined
    } catch {
      return undefined
    }
  }
}
