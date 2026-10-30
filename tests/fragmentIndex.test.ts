import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createDiskFragmentIndex } from '../src/storage/fragmentIndex'
import type { FragmentIndexFile } from '../src/storage/fragmentIndex'

interface FileRecord {
  bytes: Uint8Array<ArrayBuffer>
  writes: number[]
  reads: number[]
  seals: number
  closes: number
}

function files(
  options: {
    shortWrite?: number
    shortRead?: number
    writeError?: Error | undefined
    readError?: Error | undefined
    sealError?: Error | undefined
    closeError?: Error | undefined
    zeroWrite?: boolean
    zeroRead?: boolean
  } = {},
) {
  const records = new Map<number, FileRecord>()
  const open = async (trackId: number): Promise<FragmentIndexFile> => {
    const record: FileRecord = {
      bytes: new Uint8Array(0),
      writes: [],
      reads: [],
      seals: 0,
      closes: 0,
    }
    records.set(trackId, record)
    return {
      async write(data, position) {
        if (options.writeError) {
          throw options.writeError
        }
        const count = options.zeroWrite
          ? 0
          : Math.min(data.length, options.shortWrite ?? data.length)
        record.writes.push(data.length)
        if (position + count > record.bytes.length) {
          const next = new Uint8Array(position + count)
          next.set(record.bytes)
          record.bytes = next
        }
        record.bytes.set(data.subarray(0, count), position)
        return count
      },
      async read(data, position) {
        if (options.readError) {
          throw options.readError
        }
        record.reads.push(data.length)
        const count = options.zeroRead
          ? 0
          : Math.min(
              data.length,
              options.shortRead ?? data.length,
              record.bytes.length - position,
            )
        data.set(record.bytes.subarray(position, position + count))
        return count
      },
      async seal() {
        record.seals++
        if (options.sealError) {
          throw options.sealError
        }
      },
      async close() {
        record.closes++
        if (options.closeError) {
          throw options.closeError
        }
      },
    }
  }
  return {
    records,
    open,
  }
}

function payload(length: number) {
  return Uint8Array.from({ length }, (_, at) => (at * 17) % 251)
}

test('spools full pages before sealing and rereads independent track bytes', async () => {
  const backing = files()
  const store = createDiskFragmentIndex(backing.open)
  const first = payload(28 * 5003)
  const second = Uint8Array.of(4, 8, 15, 16, 23, 42)
  try {
    await store.append(1, first.subarray(0, 65_535))
    assert.equal(backing.records.get(1)?.writes.length, 0)
    await store.append(2, second)
    await store.append(1, first.subarray(65_535))
    assert.equal(backing.records.get(1)?.writes.length, 2)
    assert.equal(backing.records.get(1)?.seals, 0)
    for (let offset = 0; offset < first.length; offset += 65_536) {
      const length = Math.min(65_536, first.length - offset)
      const page = await store.read(1, offset, length)
      assert.deepEqual(page, first.subarray(offset, offset + length))
      page.fill(255)
    }
    assert.deepEqual(
      await store.read(1, 65_530, 28),
      first.subarray(65_530, 65_558),
    )
    assert.deepEqual(await store.read(2, 0, second.length), second)
    assert.equal(backing.records.get(1)?.seals, 1)
    assert.ok(backing.records.get(1)?.writes.every(length => length <= 65_536))
    await assert.rejects(store.append(1, second), { name: 'InvalidStateError' })
  } finally {
    await store.dispose()
  }
  assert.equal(backing.records.get(1)?.closes, 1)
  assert.equal(backing.records.get(2)?.closes, 1)
})

test('retries partial reads/writes without losing bytes at page boundaries', async () => {
  const backing = files({ shortWrite: 4093, shortRead: 997 })
  const store = createDiskFragmentIndex(backing.open)
  const data = payload(65_536 + 29)
  try {
    await store.append(3, data)
    assert.deepEqual(await store.read(3, 0, 65_536), data.subarray(0, 65_536))
    assert.deepEqual(await store.read(3, 65_536, 29), data.subarray(65_536))
    assert.ok(backing.records.get(3)!.writes.length > 2)
    assert.ok(backing.records.get(3)!.reads.length > 2)
  } finally {
    await store.dispose()
  }
})

test('honors write backpressure and closes after already queued operations', async () => {
  const gate = Promise.withResolvers<null>()
  const entered = Promise.withResolvers<null>()
  let stored = new Uint8Array(65_537)
  let closed = 0
  const store = createDiskFragmentIndex(async () => ({
    async write(data, position) {
      entered.resolve(null)
      await gate.promise
      stored.set(data, position)
      return data.length
    },
    async read(data, position) {
      data.set(stored.subarray(position, position + data.length))
      return data.length
    },
    async seal() {},
    async close() {
      closed++
    },
  }))
  const first = store.append(1, new Uint8Array(65_536).fill(7))
  await entered.promise
  const second = store.append(1, Uint8Array.of(9))
  const reading = store.read(1, 65_535, 2)
  const disposal = store.dispose()
  assert.equal(closed, 0)
  await assert.rejects(store.append(1, Uint8Array.of(1)), {
    name: 'InvalidStateError',
  })
  gate.resolve(null)
  await Promise.all([first, second])
  assert.deepEqual(await reading, Uint8Array.of(7, 9))
  await disposal
  await store.dispose()
  assert.equal(closed, 1)
  stored = new Uint8Array(0)
})

test.each(['write', 'read', 'seal'] as const)(
  'preserves disk %s errors and still closes every opened track',
  async operation => {
    const diskError = new DOMException('disk full', 'QuotaExceededError')
    const options = {
      writeError: operation === 'write' ? diskError : undefined,
      readError: operation === 'read' ? diskError : undefined,
      sealError: operation === 'seal' ? diskError : undefined,
    }
    const backing = files(options)
    const store = createDiskFragmentIndex(backing.open)
    await store.append(2, Uint8Array.of(2))
    if (operation === 'write') {
      await assert.rejects(
        store.append(1, new Uint8Array(65_536)),
        error => error === diskError,
      )
    } else {
      await store.append(1, Uint8Array.of(1))
      await assert.rejects(store.read(1, 0, 1), error => error === diskError)
    }
    await assert.rejects(
      store.append(3, Uint8Array.of(3)),
      error => error === diskError,
    )
    await store.dispose()
    assert.equal(backing.records.get(1)?.closes, 1)
    assert.equal(backing.records.get(2)?.closes, 1)
    assert.equal(backing.records.has(3), false)
  },
)

test('rejects non-progressing writes and truncated reads', async () => {
  for (const zeroWrite of [true, false]) {
    const backing = files({ zeroWrite, zeroRead: !zeroWrite })
    const store = createDiskFragmentIndex(backing.open)
    try {
      if (zeroWrite) {
        await assert.rejects(
          store.append(1, new Uint8Array(65_536)),
          /[Ww]rite made no progress/u,
        )
      } else {
        await store.append(1, Uint8Array.of(1))
        await assert.rejects(store.read(1, 0, 1), /[Rr]ead incomplete/u)
      }
    } finally {
      await store.dispose()
    }
  }
})

test('limits read allocations and validates track IDs before opening files', async () => {
  for (const [offset, length] of [
    [-1, 1],
    [0, 65_537],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [0, -1],
  ] as const) {
    const backing = files()
    const store = createDiskFragmentIndex(backing.open)
    await assert.rejects(store.read(1, offset, length), RangeError)
    assert.equal(backing.records.size, 0)
    await store.dispose()
  }
  for (const track of [0, -1, 2 ** 32, 1.5]) {
    const backing = files()
    const store = createDiskFragmentIndex(backing.open)
    await assert.rejects(store.append(track, Uint8Array.of(1)), RangeError)
    assert.equal(backing.records.size, 0)
    await store.dispose()
  }
})

test('reports close failures after attempting every file', async () => {
  const closeError = new Error('close failed')
  const backing = files({ closeError })
  const store = createDiskFragmentIndex(backing.open)
  await store.append(1, Uint8Array.of(1))
  await store.append(2, Uint8Array.of(2))
  await assert.rejects(store.dispose(), error => error === closeError)
  assert.equal(backing.records.get(1)?.closes, 1)
  assert.equal(backing.records.get(2)?.closes, 1)
})
