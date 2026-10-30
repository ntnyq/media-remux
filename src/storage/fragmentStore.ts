/* oxlint-disable no-await-in-loop -- Each positional I/O step depends on the preceding byte count. */

/**
 * Per-track write buffer and maximum read size in bytes, keeping I/O within 64 KiB.
 */
const FRAGMENT_PAGE_SIZE = 64 * 1024

/**
 * Backing file for one track of temporary fragment bytes.
 */
export interface FragmentStoreFile {
  /**
   * Writes bytes at an absolute file position before the file is sealed.
   *
   * @param data - Bytes to write; keep the buffer stable until completion.
   * @param position - Absolute destination byte offset.
   * @returns A promise resolving to the number of bytes written. Partial writes
   * are supported; nonempty writes must make positive progress.
   */
  write: (data: Uint8Array<ArrayBuffer>, position: number) => Promise<number>

  /**
   * Reads committed bytes into the supplied buffer after sealing.
   *
   * @param data - Destination buffer to fill from its first byte.
   * @param position - Absolute source byte offset.
   * @returns A promise resolving to the number of bytes read. Partial reads are
   * supported; nonempty reads must make positive progress.
   */
  read: (data: Uint8Array<ArrayBuffer>, position: number) => Promise<number>

  /**
   * Commits pending writes and prepares a stable file for subsequent reads.
   *
   * @returns A promise resolving when the file is readable and no longer writable.
   */
  seal: () => Promise<void>

  /**
   * Releases file resources, discarding any uncommitted writes.
   *
   * @returns A promise resolving when handles and read snapshots are released.
   */
  close: () => Promise<void>
}

/**
 * Append bytes, then read bounded pages after sealing the current file.
 */
export interface FragmentStore {
  /**
   * Appends temporary bytes to one track before that track enters its read phase.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param data - Bytes to append; keep them stable until the operation completes.
   * @returns A promise resolving when bytes are accepted into the buffered store.
   */
  append: (trackId: number, data: Uint8Array) => Promise<void>

  /**
   * Reads a bounded byte range, sealing buffered writes on the track's first read.
   * No further appends are allowed until the track is reset by its owning store.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param offset - Nonnegative safe integer byte offset from the track's start.
   * @param length - Byte count from 0 through 65536, within the appended range.
   * @returns A promise resolving to a new buffer containing exactly length bytes.
   */
  read: (
    trackId: number,
    offset: number,
    length: number,
  ) => Promise<Uint8Array<ArrayBuffer>>
}

interface TrackFile {
  file: FragmentStoreFile
  buffer: Uint8Array<ArrayBuffer>
  used: number
  written: number
  sealed: boolean
}

/**
 * Keeps one write page per track and serializes I/O with caller backpressure.
 * Reading seals that track; reset/disposal discard pending bytes and close
 * files. Each open must truncate the logical file, including after a reset.
 * Files open lazily; creating the store performs no I/O.
 *
 * Operations reject invalid track IDs (outside the unsigned 32-bit range starting
 * at one), unsafe offsets, reads over 64 KiB, and incomplete reads with RangeError.
 * Appending after sealing or using a disposed store rejects with InvalidStateError.
 * Opener/file failures propagate, and writes that make no progress reject.
 * The first failed operation poisons later queued work; disposal still attempts
 * to close every file and rejects if closing fails. The caller removes the files.
 *
 * @param open - Async track-file opener; each open must truncate that track
 * logical file, including after reset. Files must support positional reads and
 * writes, sealing for reads, and closure; byte counts may represent partial I/O.
 * @returns A serialized per-track store with append/read, reset, and
 * idempotent disposal. Await operations for backpressure; the first read seals
 * buffered writes, and reset permits reopening a track as a new empty file.
 */
export function createDiskFragmentStore(
  open: (trackId: number) => Promise<FragmentStoreFile>,
) {
  const tracks = new Map<number, TrackFile>()
  let queue = Promise.resolve()
  let failure: { error: unknown } | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  /**
   * Serializes storage work and records the first failure for later operations.
   *
   * @template Result - Successful operation result.
   * @param operation - Deferred work to run after previously queued work settles.
   * @returns A promise resolving to the operation result or rejecting if the store
   * is disposed, an earlier operation failed, or this operation fails.
   */
  function enqueueOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (disposed) {
      return Promise.reject(
        new DOMException('Fragment storage is closed.', 'InvalidStateError'),
      )
    }

    const result = (async () => {
      await queue
      if (failure) {
        throw failure.error
      }

      return operation()
    })()

    // Keep the queue drainable for disposal while preserving the first failure
    // for later operations; a failed write must not be followed by more writes.
    queue = (async () => {
      try {
        await result
      } catch (error) {
        failure ??= { error }
      }
    })()

    return result
  }

  /**
   * Retrieves a track's state, opening its truncated backing file on first use.
   *
   * @param trackId - Integer track identifier from 1 through 0xffffffff.
   * @returns A promise resolving to the track's file, write page, and phase state.
   * @throws {RangeError} If the track ID is outside the supported range.
   * @throws If opening the backing file fails.
   */
  async function getTrack(trackId: number) {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 0xff_ff_ff_ff) {
      throw new RangeError('Invalid fragment track id.')
    }

    let track = tracks.get(trackId)
    if (!track) {
      const file = await open(trackId)
      track = {
        file,
        buffer: new Uint8Array(FRAGMENT_PAGE_SIZE),
        used: 0,
        written: 0,
        sealed: false,
      }

      tracks.set(trackId, track)
    }

    return track
  }

  /**
   * Writes the track's buffered bytes, advancing through partial file writes.
   *
   * @param track - Writable track whose pending page should be drained.
   * @returns A promise resolving when the page is fully written and marked empty.
   * @throws {Error} If a write returns an invalid count or makes no progress.
   * @throws If the backing file write fails.
   */
  async function flushTrack(track: TrackFile) {
    let offset = 0

    while (offset < track.used) {
      const data = track.buffer.subarray(offset, track.used)
      const written = await track.file.write(data, track.written)
      if (!Number.isInteger(written) || written <= 0 || written > data.length) {
        throw new Error('Fragment storage file write made no progress.')
      }

      offset += written
      track.written += written
    }

    track.used = 0
  }

  return {
    /**
     * Buffers bytes for a track, flushing full pages with queue backpressure.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param data - Source bytes, kept stable until the append completes.
     * @returns A promise resolving when all bytes are buffered or written.
     * @throws If the track is sealed, the size is unsafe, or queued I/O fails.
     */
    append(trackId: number, data: Uint8Array) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        if (track.sealed) {
          throw new DOMException(
            'Fragment storage has entered the read phase.',
            'InvalidStateError',
          )
        }

        if (!Number.isSafeInteger(track.written + track.used + data.length)) {
          throw new RangeError('Fragment storage file is too large.')
        }

        let offset = 0

        while (offset < data.length) {
          const length = Math.min(
            data.length - offset,
            FRAGMENT_PAGE_SIZE - track.used,
          )
          track.buffer.set(data.subarray(offset, offset + length), track.used)
          track.used += length
          offset += length
          if (track.used === FRAGMENT_PAGE_SIZE) {
            await flushTrack(track)
          }
        }
      })
    },

    /**
     * Commits the track on first read and fills an exact bounded byte range.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param offset - Nonnegative safe integer byte offset within appended data.
     * @param length - Integer read size from 0 through 65536.
     * @returns A promise resolving to a new buffer containing exactly length bytes.
     * @throws If the range is invalid, the file is incomplete, or queued I/O fails.
     */
    read(trackId: number, offset: number, length: number) {
      return enqueueOperation(async () => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(length) ||
          length < 0 ||
          length > FRAGMENT_PAGE_SIZE
        ) {
          throw new RangeError('Invalid fragment storage read range.')
        }

        const track = await getTrack(trackId)
        if (offset + length > track.written + track.used) {
          throw new RangeError('Fragment storage file is incomplete.')
        }

        if (!track.sealed) {
          await flushTrack(track)
          await track.file.seal()
          track.sealed = true
        }

        const data = new Uint8Array(length)
        let consumed = 0

        while (consumed < length) {
          const remaining = data.subarray(consumed)
          const count = await track.file.read(remaining, offset + consumed)
          if (
            !Number.isInteger(count) ||
            count <= 0 ||
            count > remaining.length
          ) {
            throw new RangeError('Fragment storage file read incomplete.')
          }

          consumed += count
        }

        return data
      })
    },

    /**
     * Closes and forgets an opened track so its next access starts with an empty file.
     *
     * @param trackId - Track whose current state should be discarded; unknown IDs
     * are ignored without opening a file.
     * @returns A promise resolving after closure and state removal.
     * @throws If the store is unavailable or closing the track file fails.
     */
    reset(trackId: number) {
      return enqueueOperation(async () => {
        const track = tracks.get(trackId)
        if (track) {
          await track.file.close()
          tracks.delete(trackId)
        }
      })
    },

    /**
     * Rejects new work, drains the queue, and attempts to close every opened file.
     * Buffered partial pages are discarded and repeat calls share one promise.
     *
     * @returns A promise resolving when every file closes successfully.
     * @throws The first file-close failure after all files have been attempted.
     */
    dispose() {
      disposed = true

      return (disposal ??= (async () => {
        await queue
        let closeFailure: { error: unknown } | undefined

        for (const track of tracks.values()) {
          try {
            await track.file.close()
          } catch (error) {
            closeFailure ??= { error }
          }
        }

        tracks.clear()
        if (closeFailure) {
          throw closeFailure.error
        }
      })())
    },
  }
}
