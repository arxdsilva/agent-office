import { copyFile, readFile } from 'node:fs/promises'
import { ValidationError, type ClaudeSettingsStore } from '@agent-office/core'
import { writeFileAtomic } from './atomic.ts'

/** Claude Code's settings.json. Backs up before every write; never overwrites a file it can't parse. */
export class ClaudeSettingsFile implements ClaudeSettingsStore {
  readonly backupPath: string

  constructor(private file: string) {
    this.backupPath = `${file}.agent-office.bak`
  }

  async read(): Promise<Record<string, unknown> | undefined> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    try {
      const json = JSON.parse(raw)
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object')
      return json as Record<string, unknown>
    } catch {
      throw new ValidationError(`${this.file} is not valid JSON; fix it before installing the hook`)
    }
  }

  async write(json: Record<string, unknown>): Promise<void> {
    await copyFile(this.file, this.backupPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    await writeFileAtomic(this.file, JSON.stringify(json, null, 2) + '\n')
  }
}
