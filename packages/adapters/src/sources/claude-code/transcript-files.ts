import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

export interface FileStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDir: boolean
}

/**
 * Adapter-local port: the file operations the tailer needs. Lets the tailer be tested with an
 * in-memory file system and keeps Node fs details in one place.
 */
export interface TranscriptFiles {
  /** Entry names in a directory; [] when it doesn't exist or can't be read. */
  list(dir: string): Promise<string[]>
  stat(path: string): Promise<FileStat | undefined>
  /** Bytes [from, to) decoded as UTF-8. Throws when unreadable. */
  readRange(path: string, from: number, to: number): Promise<string>
  /** Whole small file (meta.json); undefined when missing. */
  readText(path: string): Promise<string | undefined>
  /** Streams lines of a (possibly large) file. */
  lines(path: string): AsyncIterable<string>
}

export class NodeTranscriptFiles implements TranscriptFiles {
  list(dir: string): Promise<string[]> {
    return readdir(dir).catch(() => [])
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const s = await stat(path).catch(() => undefined)
    return s && { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDir: s.isDirectory() }
  }

  async readRange(path: string, from: number, to: number): Promise<string> {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, to - from))
      await fh.read(buf, 0, buf.length, from)
      return buf.toString('utf8')
    } finally {
      await fh.close()
    }
  }

  readText(path: string): Promise<string | undefined> {
    return readFile(path, 'utf8').catch(() => undefined)
  }

  lines(path: string): AsyncIterable<string> {
    return createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  }
}

/** In-memory implementation for tests. Paths use '/' separators. */
export class MemoryTranscriptFiles implements TranscriptFiles {
  private files = new Map<string, { content: string; mtimeMs: number }>()
  private broken = new Set<string>()

  write(path: string, content: string, mtimeMs: number): void {
    this.files.set(path, { content, mtimeMs })
  }

  append(path: string, content: string, mtimeMs: number): void {
    this.write(path, (this.files.get(path)?.content ?? '') + content, mtimeMs)
  }

  failReads(path: string): void {
    this.broken.add(path)
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const names = new Set<string>()
    for (const p of this.files.keys())
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!)
    return [...names]
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const f = this.files.get(path)
    if (f)
      return { size: Buffer.byteLength(f.content), mtimeMs: f.mtimeMs, isFile: true, isDir: false }
    return (await this.list(path)).length
      ? { size: 0, mtimeMs: 0, isFile: false, isDir: true }
      : undefined
  }

  async readRange(path: string, from: number, to: number): Promise<string> {
    if (this.broken.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return Buffer.from(this.files.get(path)?.content ?? '')
      .subarray(from, to)
      .toString('utf8')
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path)?.content
  }

  async *lines(path: string): AsyncIterable<string> {
    if (this.broken.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    yield* (this.files.get(path)?.content ?? '').split('\n')
  }
}
