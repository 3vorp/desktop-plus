import { ISecureStore } from './stores'

/**
 * Windows Credential Manager rejects secrets over 2560 bytes, and a rotating
 * credential pair can be larger (Bitbucket tokens alone can exceed 2000
 * characters). Values over this size are split into several items.
 */
const maxItemBytes = 2048

const pointerPrefix = 'desktop-plus-chunked:'
const maxChunks = 64
const maxReadAttempts = 3

/**
 * `desktop-plus-chunked:1:<generation>:<count>:<length>`. The generation is
 * unique per write, so chunks of different writes are never combined.
 */
const pointerPattern =
  /^desktop-plus-chunked:1:([0-9a-f-]{1,64}):(\d{1,2}):(\d{1,15})$/

interface IChunkPointer {
  readonly generation: string
  readonly count: number
  readonly length: number
}

/**
 * Chunks are saved under a new generation before the main item points at
 * them, so readers see either the previous value or the new one in full.
 */
export class ChunkedSecureStore implements ISecureStore {
  public constructor(private readonly store: ISecureStore) {}

  public async getItem(key: string, login: string): Promise<string | null> {
    for (let attempt = 0; attempt < maxReadAttempts; attempt++) {
      const value = await this.store.getItem(key, login)
      const pointer = parsePointer(value)
      if (pointer === undefined) {
        return value
      }
      const chunks = await Promise.all(
        range(pointer.count).map(i =>
          this.store.getItem(key, chunkLogin(login, pointer.generation, i))
        )
      )
      const joined = chunks.every(c => c !== null) ? chunks.join('') : null
      if (joined !== null && joined.length === pointer.length) {
        return joined
      }
      // Another app window replaced this generation while it was being read.
    }
    throw new Error('Unable to read stored credentials. Please sign in again.')
  }

  public async setItem(key: string, login: string, value: string) {
    const previous = await this.tryReadPointer(key, login)
    if (
      Buffer.byteLength(value) <= maxItemBytes &&
      !value.startsWith(pointerPrefix)
    ) {
      await this.store.setItem(key, login, value)
      if (previous !== undefined) {
        await this.deleteChunks(key, login, previous)
      }
      return
    }

    const chunks = splitByBytes(value, maxItemBytes)
    if (chunks.length > maxChunks) {
      throw new Error('The credentials are too large to store.')
    }
    const pointer: IChunkPointer = {
      generation: crypto.randomUUID(),
      count: chunks.length,
      length: value.length,
    }
    try {
      // Settle every write before cleaning up, so none lands after it.
      const writes = await Promise.allSettled(
        chunks.map((chunk, i) =>
          this.store.setItem(
            key,
            chunkLogin(login, pointer.generation, i),
            chunk
          )
        )
      )
      for (const write of writes) {
        if (write.status === 'rejected') {
          throw write.reason
        }
      }
      await this.store.setItem(
        key,
        login,
        `${pointerPrefix}1:${pointer.generation}:${pointer.count}:${pointer.length}`
      )
    } catch (e) {
      await this.deleteChunks(key, login, pointer)
      throw e
    }

    if (previous !== undefined) {
      await this.deleteChunks(key, login, previous)
    }
    // A concurrent write from another window may have replaced this one.
    const current = await this.tryReadPointer(key, login)
    if (current !== undefined && current.generation !== pointer.generation) {
      await this.deleteChunks(key, login, pointer)
    }
  }

  public async deleteItem(key: string, login: string): Promise<boolean> {
    const previous = await this.tryReadPointer(key, login)
    const deleted = await this.store.deleteItem(key, login)
    if (previous !== undefined) {
      await this.deleteChunks(key, login, previous)
    }
    return deleted
  }

  private async tryReadPointer(key: string, login: string) {
    try {
      return parsePointer(await this.store.getItem(key, login))
    } catch {
      return undefined
    }
  }

  /** Best-effort cleanup: leftover chunks are unreachable once unreferenced. */
  private async deleteChunks(
    key: string,
    login: string,
    pointer: IChunkPointer
  ) {
    await Promise.all(
      range(pointer.count).map(async i => {
        try {
          await this.store.deleteItem(
            key,
            chunkLogin(login, pointer.generation, i)
          )
        } catch {
          log.warn('Unable to remove a stale credential chunk.')
        }
      })
    )
  }
}

/** Account names never contain ':', so chunk names never collide with them. */
function chunkLogin(login: string, generation: string, index: number) {
  return `${login}:chunk:${generation}:${index}`
}

function range(count: number) {
  return Array.from({ length: count }, (_, i) => i)
}

function parsePointer(value: string | null): IChunkPointer | undefined {
  if (value === null || !value.startsWith(pointerPrefix)) {
    return undefined
  }
  const match = pointerPattern.exec(value)
  const count = Number(match?.[2])
  const length = Number(match?.[3])
  if (match === null || count < 1 || count > maxChunks || length < 1) {
    // Never include the secure-store contents in an exception.
    throw new Error('Unable to read stored credentials. Please sign in again.')
  }
  return { generation: match[1], count, length }
}

/** Split without breaking characters, so each chunk is valid UTF-8 on its own. */
function splitByBytes(value: string, maxBytes: number): ReadonlyArray<string> {
  const chunks = new Array<string>()
  let chunk = ''
  let chunkBytes = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character)
    if (chunkBytes + bytes > maxBytes) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += character
    chunkBytes += bytes
  }
  chunks.push(chunk)
  return chunks
}
