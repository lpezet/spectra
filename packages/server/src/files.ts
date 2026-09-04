import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Write via a temp file so a crash mid-write cannot leave a half-written file on disk. */
export async function writeAtomic(target: string, contents: string): Promise<void> {
  const temp = `${target}.tmp`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, target)
}

/** Never overwrite an existing file — the caller gets `name-2.json` instead. */
export async function uniquePath(dir: string, file: string): Promise<string> {
  const extension = path.extname(file)
  const base = path.basename(file, extension)
  for (let attempt = 0; ; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? file : `${base}-${attempt + 1}${extension}`)
    try {
      await writeFile(candidate, '', { flag: 'wx' })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** `Spec them` → `spec-them`, for building a changeset id out of an option label. */
export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'option'
  )
}
