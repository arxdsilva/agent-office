import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Best-effort fsync of a directory so a rename or a new file survives a crash (no-op on Windows). */
async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch {
    // Directories can't be opened on some platforms; the data itself is already synced.
  }
}

/** Like fs/atomic.ts, but fsyncs the temp file before the rename and the directory after it. */
export async function writeFileDurable(
  file: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  try {
    const fh = await open(tmp, 'wx', mode)
    try {
      await fh.writeFile(contents)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  await syncDir(dirname(file))
}

/**
 * Creates `file` atomically and only if it does not exist yet (temp + fsync + hard link), so a
 * concurrent creator can never be overwritten. Throws EEXIST when the file is already there.
 */
export function createFileExclusiveSync(file: string, contents: Buffer, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  try {
    const fd = openSync(tmp, 'wx', mode)
    try {
      writeSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Appends and fdatasyncs. */
export async function appendDurable(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const fh = await open(file, 'a', 0o600)
  try {
    await fh.appendFile(contents)
    await fh.datasync()
  } finally {
    await fh.close()
  }
}
