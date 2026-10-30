import { createDiskFragmentStore } from '../fragmentStore'

/**
 * Uses temporary OPFS write streams, committing each track before paged reads.
 * Files open lazily and existing contents are truncated. Reading commits that
 * track's writable stream; reset/dispose abort pending writes and release File
 * snapshots. The caller removes the files or containing directory after disposal.
 * Store operations propagate OPFS errors and createDiskFragmentStore() validation
 * failures; creating this adapter performs no I/O.
 *
 * @param directory - Caller-owned temporary directory used for the backing
 * track files, exclusively owned by this job.
 * @param filename - Maps each track ID to a distinct valid filename within the
 * directory; the same track must map to the same filename when reopened.
 * @returns A lazy disk store using OPFS writable streams, with committed File
 * snapshots for reads of at most 64 KiB, per-track reset, and idempotent disposal.
 */
export function createOpfsFragmentStore(
  directory: FileSystemDirectoryHandle,
  filename: (trackId: number) => string,
) {
  return createDiskFragmentStore(async trackId => {
    const handle = await directory.getFileHandle(filename(trackId), {
      create: true,
    })

    let writer: FileSystemWritableFileStream | undefined =
      await handle.createWritable({ keepExistingData: false })
    let snapshot: File | undefined

    return {
      /**
       * Writes an entire positioned buffer to the active OPFS writable stream.
       *
       * @param data - Bytes to write.
       * @param position - Absolute file byte offset.
       * @returns A promise resolving to data.length after the write completes.
       * @throws If the writer is closed or the OPFS write fails.
       */
      async write(data, position) {
        if (!writer) {
          throw new DOMException(
            'Fragment storage write stream is closed.',
            'InvalidStateError',
          )
        }

        await writer.write({ type: 'write', position, data })

        return data.length
      },

      /**
       * Commits pending writes and obtains a File snapshot for positional reads.
       *
       * @returns A promise resolving when the committed snapshot is available.
       * @throws If closing the writer or obtaining its File snapshot fails.
       */
      async seal() {
        await writer?.close()
        writer = undefined
        snapshot = await handle.getFile()
      },

      /**
       * Copies committed snapshot bytes into a caller-provided buffer.
       *
       * @param data - Destination buffer filled from its first byte.
       * @param position - Absolute source offset in the committed snapshot.
       * @returns A promise resolving to the number of bytes copied.
       * @throws If no snapshot exists or reading the Blob slice fails.
       */
      async read(data, position) {
        if (!snapshot) {
          throw new DOMException(
            'Fragment storage has not been committed.',
            'InvalidStateError',
          )
        }

        const bytes = await snapshot
          .slice(position, position + data.length)
          .arrayBuffer()
        data.set(new Uint8Array(bytes))

        return bytes.byteLength
      },

      /**
       * Aborts any remaining writer and releases the committed snapshot reference.
       *
       * @returns A promise resolving after file resources are released.
       * @throws If aborting the writable stream fails.
       */
      async close() {
        await writer?.abort()
        writer = undefined
        snapshot = undefined
      },
    }
  })
}
