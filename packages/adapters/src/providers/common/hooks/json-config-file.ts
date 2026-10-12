import { copyFile, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { ValidationError, type JsonConfigStore } from '@agent-office/core'
import { writeFileAtomic } from '../../../fs/atomic.ts'

/**
 * A provider's JSON hook config (Cursor hooks.json, Gemini settings.json, a Copilot hooks file).
 * Backs up the existing file once (`<file>.agent-office.bak`, never overwritten), writes atomically
 * and refuses to read invalid JSON.
 */
export class JsonConfigFile implements JsonConfigStore {
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
      throw new ValidationError(`${this.file} is not valid JSON; fix it before installing hooks`)
    }
  }

  async write(json: Record<string, unknown>): Promise<void> {
    await copyFile(this.file, this.backupPath, constants.COPYFILE_EXCL).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT' && err.code !== 'EEXIST') throw err
      },
    )
    await writeFileAtomic(this.file, JSON.stringify(json, null, 2) + '\n')
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true })
  }
}
