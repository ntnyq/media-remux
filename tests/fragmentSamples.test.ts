import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createDiskFragmentSamples } from '../src/storage/fragmentSamples'
import type { FragmentSample } from '../src/storage/fragmentSamples'
import { temporaryFragmentSamples } from './helpers/fragmentSamples'

function sample(
  timestamp: number,
  size = 1,
): Omit<FragmentSample, 'mediaOffset'> {
  return {
    timestamp,
    decodeTimestamp: timestamp,
    duration: 1 / 24,
    size,
    type: 'delta',
    timescaleUnitsToNextSample: 2400,
  }
}

test('updates paged records after eviction and compacts released prefixes with queued tails', async () => {
  const temporary = await temporaryFragmentSamples()
  const { store } = temporary
  try {
    for (let at = 0; at < 5003; at++) {
      assert.equal(
        await store.append(1, sample(at), Uint8Array.of(at % 251)),
        at,
      )
    }
    for (const id of [5002, 0, 4096, 1023, 1024, 3000]) {
      const row = await store.get(1, id)
      assert.equal(row.timestamp, id)
      await store.set(1, id, {
        ...row,
        decodeTimestamp: id - 0.25,
        timescaleUnitsToNextSample: 17,
      })
    }
    assert.equal((await store.get(1, 5002)).timescaleUnitsToNextSample, 17)
    await store.release(1, 4001)
    await store.set(1, 0, { ...sample(0), mediaOffset: 0 })
    assert.equal((await store.get(1, 4096)).decodeTimestamp, 4095.75)
    assert.deepEqual(
      await store.readMedia(1, 4001, 1002),
      Uint8Array.from({ length: 1002 }, (_, at) => (at + 4001) % 251),
    )
    assert.equal(
      await store.append(1, sample(6000, 3), Uint8Array.of(7, 8, 9)),
      5003,
    )
    assert.deepEqual(await store.readMedia(1, 5003, 3), Uint8Array.of(7, 8, 9))
    await store.release(1, 5004)
    assert.equal(await store.append(1, sample(7000), Uint8Array.of(10)), 5004)
    assert.equal((await store.get(1, 5004)).mediaOffset, 5006)
    assert.deepEqual(await store.readMedia(1, 5006, 1), Uint8Array.of(10))
  } finally {
    await temporary.dispose()
  }
})

test.each([1, 4096, 4097, 10_003])(
  'sorts %s GOP timestamps using bounded runs with ties and fractional times',
  async count => {
    const temporary = await temporaryFragmentSamples()
    const { store } = temporary
    try {
      for (let at = 0; at < 13; at++) {
        await store.append(1, sample(9999), Uint8Array.of(1))
      }
      const expected = []
      for (let at = 0; at < count; at++) {
        const timestamp = (Math.floor((count - at) / 7) - 500) / 24
        expected.push(timestamp)
        await store.append(1, sample(timestamp), Uint8Array.of(2))
      }
      await store.sort(1, 13, count)
      expected.sort((left, right) => left - right)
      for (let at = 0; at < count; at++) {
        assert.equal(await store.sorted(1, at), expected[at])
      }
      // Sorting must not reorder the descriptors in decode order.
      assert.equal(
        (await store.get(1, 13)).timestamp,
        (Math.floor(count / 7) - 500) / 24,
      )
      await store.sort(1, 13, 1)
      assert.equal(await store.sorted(1, 0), (await store.get(1, 13)).timestamp)
    } finally {
      await temporary.dispose()
    }
  },
)

function memoryFiles() {
  const files: {
    kind: string
    bytes: Uint8Array<ArrayBuffer>
    closed: number
  }[] = []
  let fail: 'read' | 'write' | 'truncate' | 'close' | undefined
  const failure = new DOMException('disk unavailable', 'QuotaExceededError')
  const store = createDiskFragmentSamples(async (_track, kind) => {
    const file = { kind, bytes: new Uint8Array(0), closed: 0 }
    files.push(file)
    return {
      async read(data, position) {
        if (fail === 'read') {
          throw failure
        }
        const count = Math.min(197, data.length, file.bytes.length - position)
        if (count > 0) {
          data.set(file.bytes.subarray(position, position + count))
        }
        return count
      },
      async write(data, position) {
        if (fail === 'write') {
          throw failure
        }
        const count = Math.min(211, data.length)
        if (position + count > file.bytes.length) {
          const bytes = new Uint8Array(position + count)
          bytes.set(file.bytes)
          file.bytes = bytes
        }
        file.bytes.set(data.subarray(0, count), position)
        return count
      },
      async truncate(length) {
        if (fail === 'truncate') {
          throw failure
        }
        const bytes = new Uint8Array(length)
        bytes.set(file.bytes.subarray(0, length))
        file.bytes = bytes
      },
      async close() {
        file.closed++
        if (fail === 'close') {
          throw failure
        }
      },
    }
  })
  return {
    store,
    files,
    failure,
    fail(operation: typeof fail) {
      fail = operation
    },
  }
}

test('retries partial positional I/O across media pages and sorts independent tracks', async () => {
  const { store, files } = memoryFiles()
  try {
    const bytes = Uint8Array.from({ length: 65_539 }, (_, at) => at % 251)
    await store.append(1, sample(7, bytes.length), bytes)
    await store.append(2, sample(3), Uint8Array.of(4))
    await store.sort(1, 0, 1)
    await store.sort(2, 0, 1)
    assert.equal(await store.sorted(1, 0), 7)
    assert.equal(await store.sorted(2, 0), 3)
    assert.deepEqual(
      await store.readMedia(1, 0, 65_536),
      bytes.subarray(0, 65_536),
    )
    assert.deepEqual(
      await store.readMedia(1, 65_536, 3),
      bytes.subarray(65_536),
    )
    await store.release(1, 1)
    assert.deepEqual(await store.readMedia(2, 0, 1), Uint8Array.of(4))
  } finally {
    await store.dispose()
  }
  assert.equal(files.length, 8)
  assert.ok(files.every(file => file.closed === 1))
})

test.each(['read', 'write', 'truncate'] as const)(
  'preserves positional %s failures and closes all files',
  async operation => {
    const backing = memoryFiles()
    await backing.store.append(1, sample(0), Uint8Array.of(1))
    await backing.store.readMedia(1, 0, 1)
    backing.fail(operation)
    let pending: Promise<unknown>
    if (operation === 'read') {
      pending = backing.store.readMedia(1, 0, 1)
    } else if (operation === 'write') {
      pending = backing.store.append(
        1,
        sample(1, 65_536),
        new Uint8Array(65_536),
      )
    } else {
      pending = backing.store.release(1, 1)
    }
    await assert.rejects(pending, error => error === backing.failure)
    await assert.rejects(
      backing.store.get(1, 0),
      error => error === backing.failure,
    )
    await backing.store.dispose()
    assert.ok(backing.files.every(file => file.closed === 1))
  },
)

test('reports close failure after attempting all files and remains disposed', async () => {
  const backing = memoryFiles()
  await backing.store.append(1, sample(0), Uint8Array.of(1))
  backing.fail('close')
  await assert.rejects(
    backing.store.dispose(),
    error => error === backing.failure,
  )
  assert.ok(backing.files.every(file => file.closed === 1))
  await assert.rejects(backing.store.get(1, 0), { name: 'InvalidStateError' })
})

test('rejects oversized media reads and invalid record fields', async () => {
  for (const operation of ['read', 'field', 'reference'] as const) {
    const backing = memoryFiles()
    await backing.store.append(1, sample(0), Uint8Array.of(1))
    try {
      if (operation === 'read') {
        await assert.rejects(backing.store.readMedia(1, 0, 65_537), RangeError)
      }
      if (operation === 'field') {
        await assert.rejects(
          backing.store.append(1, sample(Number.NaN), Uint8Array.of(1)),
          RangeError,
        )
      }
      if (operation === 'reference') {
        await assert.rejects(backing.store.get(1, 1), RangeError)
      }
    } finally {
      await backing.store.dispose()
    }
  }
})

test('closes partially opened tracks without masking the original open error', async () => {
  const failure = new Error('open failed')
  let opened = 0
  let closed = 0
  const store = createDiskFragmentSamples(async () => {
    if (++opened === 3) {
      throw failure
    }
    return {
      async read(data) {
        return data.length
      },
      async write(data) {
        return data.length
      },
      async truncate() {},
      async close() {
        closed++
      },
    }
  })
  await assert.rejects(
    store.append(1, sample(0), Uint8Array.of(1)),
    error => error === failure,
  )
  assert.equal(closed, 2)
  await store.dispose()
  assert.equal(closed, 2)
})

test('rejects non-progressing writes and truncated sample-media reads', async () => {
  for (const writing of [true, false]) {
    const store = createDiskFragmentSamples(async () => ({
      async read() {
        return 0
      },
      async write(data) {
        return writing ? 0 : data.length
      },
      async truncate() {},
      async close() {},
    }))
    try {
      if (writing) {
        await assert.rejects(
          store.append(1, sample(0, 65_536), new Uint8Array(65_536)),
          RangeError,
        )
      } else {
        await store.append(1, sample(0), Uint8Array.of(1))
        await assert.rejects(store.readMedia(1, 0, 1), RangeError)
      }
    } finally {
      await store.dispose()
    }
  }
})
