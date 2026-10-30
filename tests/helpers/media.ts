import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { openMediaInput } from '../../src/core/input/mediaInput'
import { createDiskFragmentIndex } from '../../src/storage/fragmentIndex'
import type { MediaOutputChunk, RemuxStorage } from '../../src/types'
import { temporaryFragmentSamples } from './fragmentSamples'

/**
 * Loads a binary fixture from the test fixtures directory.
 *
 * @param name - Fixture filename relative to tests/fixtures.
 * @returns A Blob containing the fixture bytes.
 */
export async function fixture(name: string): Promise<Blob> {
  return new Blob([
    await readFile(new URL(`../fixtures/${name}`, import.meta.url)),
  ])
}

/**
 * Creates disk-backed fragment index and sample stores for the current test.
 * Registers test-finished hooks to dispose both stores and remove temporary files.
 *
 * @returns Remux storage backed by temporary positional files.
 */
export async function diskStorage(): Promise<RemuxStorage> {
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-index-'))
  const fragmentIndex = createDiskFragmentIndex(async trackId => {
    const file = await open(join(directory, `${trackId}.index`), 'w+')
    return {
      /**
       * Writes index bytes at an absolute file offset.
       *
       * @param bytes - Bytes to write.
       * @param offset - Inclusive byte offset in the index file.
       * @returns The number of bytes written.
       */
      async write(bytes, offset) {
        const result = await file.write(bytes, 0, bytes.length, offset)
        return result.bytesWritten
      },

      /**
       * Reads index bytes at an absolute file offset.
       *
       * @param bytes - Destination buffer to fill.
       * @param offset - Inclusive byte offset in the index file.
       * @returns The number of bytes read.
       */
      async read(bytes, offset) {
        const result = await file.read(bytes, 0, bytes.length, offset)
        return result.bytesRead
      },

      /**
       * Completes the write phase; positional writes are already readable.
       *
       * @returns An already-resolved promise.
       */
      seal() {
        // Positional Node writes are immediately visible to reads on this handle.
        return Promise.resolve()
      },

      /**
       * Closes the index file handle.
       *
       * @returns A promise that resolves when the handle has been closed.
       */
      close: () => file.close(),
    }
  })
  onTestFinished(async () => {
    try {
      await fragmentIndex.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  const samples = await temporaryFragmentSamples()
  onTestFinished(() => samples.dispose())
  return { fragmentIndex, fragmentSamples: samples.store }
}

/**
 * Creates an in-memory output target that supports positional writes.
 *
 * @returns The writable stream, lifecycle and write-size probes, and a Blob reader.
 */
export function memoryTarget() {
  let bytes = new Uint8Array(0)
  const state = { isClosed: false, isAborted: false, writes: [] as number[] }
  return {
    state,
    writable: new WritableStream<MediaOutputChunk>({
      /**
       * Copies an output chunk into the target, growing its buffer as needed.
       *
       * @param chunk - Output bytes and their destination position.
       * @param chunk.data - Bytes to copy into the target.
       * @param chunk.position - Inclusive destination byte offset.
       * @returns Nothing.
       */
      write({ data, position }) {
        state.writes.push(data.byteLength)
        if (position + data.byteLength > bytes.length) {
          const next = new Uint8Array(position + data.byteLength)
          next.set(bytes)
          bytes = next
        }
        bytes.set(data, position)
      },

      /**
       * Records successful closure of the output stream.
       *
       * @returns Nothing.
       */
      close() {
        state.isClosed = true
      },

      /**
       * Records abortion of the output stream.
       *
       * @returns Nothing.
       */
      abort() {
        state.isAborted = true
      },
    }),

    /**
     * Takes a snapshot of all bytes written so far, including unwritten gaps.
     *
     * @returns A Blob containing the current output bytes.
     */
    blob: () => new Blob([bytes]),
  }
}

/**
 * Collects encoded packets from the first track of the requested kind.
 * Disposes the media input after collection, including when reading fails.
 *
 * @param blob - Media file to inspect.
 * @param kind - Track kind to collect.
 * @returns Packet bytes, types, timestamps, and durations, or an empty array if absent.
 */
export async function packets(blob: Blob, kind: 'video' | 'audio') {
  const input = await openMediaInput(blob)
  try {
    const track = input.tracks.find(candidate => candidate.kind === kind)
    if (!track) {
      return []
    }
    const encoded = []
    for await (const packet of track.packets()) {
      encoded.push({
        data: packet.data,
        type: packet.type,
        timestamp: packet.timestamp,
        duration: packet.duration,
      })
    }
    return encoded
  } finally {
    input.dispose()
  }
}
