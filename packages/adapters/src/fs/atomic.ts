import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Write to a temp file then rename, so readers never see a half-written file. */
export async function writeFileAtomic(file: string, contents: string, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, contents, mode === undefined ? undefined : { mode })
  await rename(tmp, file)
}
