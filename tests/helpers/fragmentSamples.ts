import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskFragmentSamples } from '../../src/storage/fragmentSamples'

/**
 * Real positional files for metadata, media and external sort passes.
 *
 * @returns The sample store, its temporary directory, and a disposer.
 */
export async function temporaryFragmentSamples() {
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-samples-'))
  const store = createDiskFragmentSamples(async (trackId, kind) => {
    const file = await open(join(directory, `${trackId}-${kind}.bin`), 'w+')
    return {
      /**
       * Reads sample-store bytes at an absolute file position.
       *
       * @param data - Destination buffer to fill.
       * @param position - Inclusive byte offset in the backing file.
       * @returns The number of bytes read.
       */
      async read(data, position) {
        const result = await file.read(data, 0, data.length, position)
        return result.bytesRead
      },

      /**
       * Writes sample-store bytes at an absolute file position.
       *
       * @param data - Bytes to write.
       * @param position - Inclusive byte offset in the backing file.
       * @returns The number of bytes written.
       */
      async write(data, position) {
        const result = await file.write(data, 0, data.length, position)
        return result.bytesWritten
      },

      /**
       * Resizes the backing file, discarding bytes beyond the new end.
       *
       * @param size - New file size in bytes.
       * @returns A promise that resolves when the file has been resized.
       */
      truncate: size => file.truncate(size),

      /**
       * Closes the backing file handle.
       *
       * @returns A promise that resolves when the handle has been closed.
       */
      close: () => file.close(),
    }
  })
  return {
    store,
    directory,

    /**
     * Disposes the sample store and removes its temporary directory even on failure.
     *
     * @returns A promise that resolves when cleanup has finished.
     */
    async dispose() {
      try {
        await store.dispose()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
