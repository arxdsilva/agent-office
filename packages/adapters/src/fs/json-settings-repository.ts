import { readFile } from 'node:fs/promises'
import type { Logger, SettingsRepository } from '@agent-office/core'
import { SettingsSchema, type Settings } from '@agent-office/shared'
import { writeFileAtomic } from './atomic.ts'

/** App settings as JSON in the user-data directory. Invalid fields fall back to defaults. */
export class JsonFileSettingsRepository implements SettingsRepository {
  constructor(
    private file: string,
    private log?: Logger,
  ) {}

  async load(): Promise<Settings> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log?.warn(`settings file corrupt, using defaults`)
      return SettingsSchema.parse({})
    }
    const obj = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    const parsed = SettingsSchema.safeParse(obj)
    if (parsed.success) return parsed.data
    for (const issue of parsed.error.issues) delete obj[String(issue.path[0])]
    return SettingsSchema.parse(obj)
  }

  async save(s: Settings): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(s, null, 2) + '\n')
  }
}
