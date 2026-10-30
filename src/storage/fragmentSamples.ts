/* oxlint-disable no-await-in-loop -- Paged I/O and merge cursors advance sequentially with bounded memory. */

/**
 * One encoded sample descriptor persisted as a fixed 56-byte record.
 * Timestamps and duration are seconds; mediaOffset is a logical byte position.
 */
export interface FragmentSample {
  /**
   * Finite presentation timestamp in seconds, possibly negative.
   */
  timestamp: number

  /**
   * Finite decode timestamp in seconds, possibly negative.
   */
  decodeTimestamp: number

  /**
   * Finite, nonnegative presentation duration in seconds.
   */
  duration: number

  /**
   * Encoded payload byte count, an integer from 0 through 0xffffffff.
   */
  size: number

  /**
   * Whether the sample is independently decodable ('key') or dependent ('delta').
   */
  type: 'key' | 'delta'

  /**
   * Sample duration in the track's integer timescale units, refined as subsequent
   * samples arrive. Must be a nonnegative safe integer.
   */
  timescaleUnitsToNextSample: number

  /**
   * Nonnegative safe integer logical offset of the encoded payload in its track.
   * Surviving sample offsets remain unchanged when released prefixes are compacted.
   */
  mediaOffset: number
}

/**
 * Positioned sample metadata, external timestamp sorting, and encoded payload I/O.
 * Reads must return at most 64 KiB; callers must await every operation.
 */
export interface FragmentSampleStore {
  /**
   * Appends sample metadata and payload, assigning its logical media offset.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param sample - Descriptor without mediaOffset; size must equal data.length.
   * @param data - Encoded payload; keep it stable until the append completes.
   * @returns The track-local sample ID, or a promise resolving to it. Disk stores
   * assign monotonically increasing IDs starting at zero, without reusing released IDs.
   */
  append: (
    trackId: number,
    sample: Omit<FragmentSample, 'mediaOffset'>,
    data: Uint8Array,
  ) => number | Promise<number>

  /**
   * Retrieves a descriptor for a sample that has not been released.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param id - Track-local logical sample ID returned by append().
   * @returns The stored descriptor, or a promise resolving to it.
   */
  get: (trackId: number, id: number) => FragmentSample | Promise<FragmentSample>

  /**
   * Replaces a sample descriptor without rewriting its encoded payload. Disk
   * stores ignore updates to released IDs so later duration refinements are safe.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param id - Track-local logical sample ID to update.
   * @param sample - Updated descriptor; payload offsets and sizes must still
   * refer to the existing encoded media.
   * @returns Nothing, or a promise resolving when the descriptor update completes.
   */
  set: (
    trackId: number,
    id: number,
    sample: FragmentSample,
  ) => void | Promise<void>

  /**
   * Prepares ascending presentation timestamps for a contiguous sample range
   * without changing sample IDs or decode order. Replaces previous sort results.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param start - First retained sample ID in the range.
   * @param count - Positive integer number of consecutive retained samples to sort.
   * @returns Nothing, or a promise resolving when sorted timestamps are available.
   */
  sort: (trackId: number, start: number, count: number) => void | Promise<void>

  /**
   * Reads a timestamp from the most recent sort result for a track.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param index - Zero-based position within the last sorted range.
   * @returns A presentation timestamp in seconds, or a promise resolving to it.
   */
  sorted: (trackId: number, index: number) => number | Promise<number>

  /**
   * Reads a bounded range of retained encoded payload using logical media offsets.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param offset - Logical source byte offset, at or after the retained prefix.
   * @param length - Integer byte count from 0 through 65536, within retained media.
   * @returns Exactly length payload bytes, or a promise resolving to them.
   */
  readMedia: (
    trackId: number,
    offset: number,
    length: number,
  ) => Uint8Array | Promise<Uint8Array>

  /**
   * Releases samples preceding a boundary and their payloads. Disk stores compact
   * backing files while preserving surviving IDs and offsets, and clear sort results
   * when the retained prefix advances.
   *
   * @param trackId - Track identifier, an integer from 1 through 0xffffffff.
   * @param before - Exclusive sample ID boundary between the first retained ID
   * and the next ID that append() would assign, inclusive.
   * @returns Nothing, or a promise resolving when release and compaction complete.
   */
  release: (trackId: number, before: number) => void | Promise<void>
}

/**
 * Positional temporary file; implementations may use synchronous Worker I/O.
 */
export interface FragmentSampleFile {
  /**
   * Reads file bytes into a caller-provided buffer using positional I/O.
   *
   * @param data - Destination buffer to fill from its first byte.
   * @param position - Absolute source byte offset in the backing file.
   * @returns Bytes read, or a promise resolving to that count. Partial reads are
   * supported; nonempty reads must make positive progress.
   */
  read: (
    data: Uint8Array<ArrayBuffer>,
    position: number,
  ) => number | Promise<number>

  /**
   * Writes bytes at a position without truncating unrelated file contents.
   *
   * @param data - Source bytes; keep the buffer stable until completion.
   * @param position - Absolute destination byte offset in the backing file.
   * @returns Bytes written, or a promise resolving to that count. Partial writes
   * are supported; nonempty writes must make positive progress.
   */
  write: (
    data: Uint8Array<ArrayBuffer>,
    position: number,
  ) => number | Promise<number>

  /**
   * Resizes a backing file, discarding bytes beyond the new end when shrinking.
   *
   * @param size - New file length in bytes; zero clears the file before use.
   * @returns Nothing, or a promise resolving when resizing completes.
   */
  truncate: (size: number) => void | Promise<void>

  /**
   * Releases the backing file handle and any associated exclusive access lock.
   *
   * @returns Nothing, or a promise resolving when file resources are released.
   */
  close: () => void | Promise<void>
}

/**
 * Descriptor size in bytes: six Float64 fields, a sample-type byte, and padding.
 */
const RECORD_SIZE = 56

/**
 * Number of descriptors per cache page; each track retains at most two pages.
 */
const RECORDS_PER_PAGE = 1024

/**
 * Descriptor page size in bytes, used for cache buffers and record-file offsets.
 */
const PAGE_SIZE = RECORD_SIZE * RECORDS_PER_PAGE

/**
 * Payload and sort-page transfer limit in bytes, bounding I/O buffers to 64 KiB.
 */
const IO_SIZE = 64 * 1024

/**
 * Maximum timestamps sorted in memory at once; larger ranges use disk merge passes.
 */
const SORT_RUN = 4096

type FileKind = 'records' | 'media' | 'sort-a' | 'sort-b'

interface Page {
  index: number
  bytes: Uint8Array<ArrayBuffer>
  dirty: boolean
}

interface Track {
  files: Record<FileKind, FragmentSampleFile>
  pages: Page[]
  base: number
  end: number
  recordBytes: number
  mediaBase: number
  mediaEnd: number
  mediaBuffer: Uint8Array<ArrayBuffer>
  mediaUsed: number
  mediaWritten: number
  sortedCount: number
  sortedMemory: Float64Array<ArrayBuffer>
  externalSort: boolean
  sortedFile: 'sort-a' | 'sort-b'
  sortedPage: { offset: number; bytes: Uint8Array<ArrayBuffer> } | undefined
}

/**
 * Retrieves a timestamp from an in-memory sorted run or loaded sort page.
 *
 * @param values - Timestamp buffer to inspect.
 * @param index - Zero-based position within the buffer.
 * @returns The stored presentation timestamp in seconds.
 * @throws {RangeError} If no timestamp exists at the requested index.
 */
function readTimestamp(values: Float64Array, index: number): number {
  const timestamp = values[index]
  if (timestamp === undefined) {
    throw new RangeError('Invalid sorted timestamp reference.')
  }

  return timestamp
}

/**
 * Two descriptor pages per track, fixed-size external merge sorting, and
 * bounded media pages. Released prefixes are compacted so old fragments do not
 * accumulate. A failed operation poisons the store, while disposal always
 * attempts to close every opened file. Files open lazily and are truncated
 * before use; creating the store performs no I/O.
 *
 * Operations reject invalid track/sample/range values or incomplete I/O with
 * RangeError, reject use after disposal with InvalidStateError, and propagate
 * opener/file errors. The first failed operation poisons subsequent work;
 * idempotent disposal still attempts every close and rejects if any close fails.
 * Disposal discards buffered data; the caller owns temporary file removal.
 *
 * @param open - Async opener for each track and records/media/sort file kind;
 * return distinct files supporting positional I/O, truncation, and closure.
 * Each new track opens all four kinds and truncates each file to zero.
 * @returns A serialized sample store supporting append, get/set, bounded
 * timestamp sorting, media reads up to 64 KiB, prefix release, and disposal.
 * Sample IDs and media offsets remain logical references across compaction;
 * callers must await operations and keep append payloads stable until completion.
 */
export function createDiskFragmentSamples(
  open: (trackId: number, kind: FileKind) => Promise<FragmentSampleFile>,
) {
  const tracks = new Map<number, Track>()
  let queue = Promise.resolve()
  let failure: { error: unknown } | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  /**
   * Serializes sample operations and preserves the first failure for later work.
   *
   * @template Result - Successful operation result.
   * @param operation - Deferred sample operation to run after queued work settles.
   * @returns A promise resolving to the result or rejecting if the store is closed,
   * an earlier operation failed, or the supplied operation fails.
   */
  function enqueueOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (disposed) {
      return Promise.reject(
        new DOMException('Sample storage is closed.', 'InvalidStateError'),
      )
    }

    const result = (async () => {
      await queue
      if (failure) {
        throw failure.error
      }

      return operation()
    })()

    // Capture failures without leaving the queue rejected, so disposal can still
    // drain it and close files. Later operations rethrow the stored failure.
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
   * Completes an exact positional transfer by retrying partial reads or writes.
   *
   * @param file - Backing file providing positional I/O.
   * @param bytes - Source buffer when writing, otherwise the destination buffer.
   * @param position - Absolute starting byte offset in the backing file.
   * @param writing - Whether to write bytes rather than read into the buffer.
   * @returns A promise resolving when the entire buffer has been transferred.
   * @throws {RangeError} If I/O returns an invalid count or makes no progress.
   * @throws If the underlying file operation fails.
   */
  async function transferFileBytes(
    file: FragmentSampleFile,
    bytes: Uint8Array<ArrayBuffer>,
    position: number,
    writing: boolean,
  ) {
    let consumed = 0

    while (consumed < bytes.length) {
      const remaining = bytes.subarray(consumed)
      const count = await (writing
        ? file.write(remaining, position + consumed)
        : file.read(remaining, position + consumed))
      if (!Number.isInteger(count) || count <= 0 || count > remaining.length) {
        throw new RangeError('Sample storage file read or write incomplete.')
      }

      consumed += count
    }
  }

  /**
   * Gets track state, lazily opening and clearing all four backing files.
   * Partial opening failures trigger closure of every file already opened.
   *
   * @param trackId - Integer track identifier from 1 through 0xffffffff.
   * @returns A promise resolving to initialized record, media, and sort state.
   * @throws {RangeError} If the track ID is invalid.
   * @throws If opening or truncating a backing file fails.
   */
  async function getTrack(trackId: number) {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 0xff_ff_ff_ff) {
      throw new RangeError('Invalid sample track id.')
    }

    let track = tracks.get(trackId)
    if (track) {
      return track
    }

    const opened: FragmentSampleFile[] = []

    try {
      /**
       * Opens one track file, tracking it for cleanup before clearing its contents.
       *
       * @param kind - Record, media, or external-sort file role to open.
       * @returns A promise resolving to an empty positional file.
       * @throws If the caller's opener or file truncation fails.
       */
      const getFile = async (kind: FileKind) => {
        const file = await open(trackId, kind)
        opened.push(file)
        await file.truncate(0)

        return file
      }

      const files = {
        records: await getFile('records'),
        media: await getFile('media'),
        'sort-a': await getFile('sort-a'),
        'sort-b': await getFile('sort-b'),
      }

      track = {
        files,
        pages: [],
        base: 0,
        end: 0,
        recordBytes: 0,
        mediaBase: 0,
        mediaEnd: 0,
        mediaBuffer: new Uint8Array(IO_SIZE),
        mediaUsed: 0,
        mediaWritten: 0,
        sortedCount: 0,
        sortedMemory: new Float64Array(SORT_RUN),
        externalSort: false,
        sortedFile: 'sort-a',
        sortedPage: undefined,
      }

      tracks.set(trackId, track)

      return track
    } catch (error) {
      for (const file of opened) {
        try {
          await file.close()
        } catch {
          // Preserve the opener error while attempting to close every file.
        }
      }

      throw error
    }
  }

  /**
   * Persists the retained portion of a dirty descriptor page and marks it clean.
   *
   * @param track - Track owning the records file and logical sample bounds.
   * @param page - Cached descriptor page to flush; clean pages require no I/O.
   * @returns A promise resolving after any required record write completes.
   * @throws If the positional record transfer fails.
   */
  async function flushPage(track: Track, page: Page) {
    if (!page.dirty) {
      return
    }

    const length = Math.min(
      PAGE_SIZE,
      (track.end - track.base) * RECORD_SIZE - page.index * PAGE_SIZE,
    )
    if (length > 0) {
      await transferFileBytes(
        track.files.records,
        page.bytes.subarray(0, length),
        page.index * PAGE_SIZE,
        true,
      )
    }

    track.recordBytes = Math.max(
      track.recordBytes,
      page.index * PAGE_SIZE + length,
    )
    page.dirty = false
  }

  /**
   * Locates a retained sample's descriptor page in the two-page LRU cache.
   * Evicts and flushes the oldest page before loading another from disk.
   *
   * @param track - Track containing the sample and its cached descriptor pages.
   * @param id - Safe integer logical sample ID within the retained range.
   * @returns A promise resolving to the cached page, promoted to most recently used.
   * @throws {RangeError} If the sample reference is outside the retained range.
   * @throws If an evicted page write or requested page read fails.
   */
  async function getSamplePage(track: Track, id: number) {
    if (!Number.isSafeInteger(id) || id < track.base || id >= track.end) {
      throw new RangeError('Invalid sample storage reference.')
    }

    const index = Math.floor((id - track.base) / RECORDS_PER_PAGE)
    let page = track.pages.find(candidate => candidate.index === index)
    if (page) {
      track.pages.splice(track.pages.indexOf(page), 1)
      track.pages.push(page)

      return page
    }

    if (track.pages.length === 2) {
      const oldest = track.pages.shift()
      if (oldest) {
        await flushPage(track, oldest)
      }
    }

    page = { index, bytes: new Uint8Array(PAGE_SIZE), dirty: false }

    // The last record may be a just-appended slot not written yet.
    const written = Math.min(
      PAGE_SIZE,
      Math.max(0, track.recordBytes - index * PAGE_SIZE),
    )
    if (written > 0) {
      await transferFileBytes(
        track.files.records,
        page.bytes.subarray(0, written),
        index * PAGE_SIZE,
        false,
      )
    }

    track.pages.push(page)

    return page
  }

  /**
   * Creates a fixed-record view over an already located sample page.
   *
   * @param track - Track supplying the retained logical base ID.
   * @param page - Cached page known to contain the sample.
   * @param id - Valid logical sample ID corresponding to this page.
   * @returns A DataView covering exactly one 56-byte descriptor record.
   */
  function getSampleView(track: Track, page: Page, id: number) {
    return new DataView(
      page.bytes.buffer,
      ((id - track.base) % RECORDS_PER_PAGE) * RECORD_SIZE,
      RECORD_SIZE,
    )
  }

  /**
   * Checks whether a size, logical offset, or timescale count can be stored exactly.
   *
   * @param value - Numeric sample field to validate.
   * @returns Whether the value is a nonnegative safe integer.
   */
  function isNonnegativeSafeInteger(value: number) {
    return Number.isSafeInteger(value) && value >= 0
  }

  /**
   * Validates sample timing, integer sizes and offsets, and the encoded sample kind.
   *
   * @param sample - Descriptor to validate before encoding or after decoding.
   * @returns Nothing when every persisted field satisfies the storage constraints.
   * @throws {RangeError} If any persisted field is invalid or outside its range.
   */
  function assertValidSample(sample: FragmentSample) {
    if (
      ![sample.timestamp, sample.decodeTimestamp, sample.duration].every(
        value => Number.isFinite(value),
      ) ||
      sample.duration < 0 ||
      !isNonnegativeSafeInteger(sample.size) ||
      sample.size > 0xff_ff_ff_ff ||
      !isNonnegativeSafeInteger(sample.timescaleUnitsToNextSample) ||
      !isNonnegativeSafeInteger(sample.mediaOffset) ||
      !['key', 'delta'].includes(sample.type)
    ) {
      throw new RangeError('Invalid sample storage field.')
    }
  }

  /**
   * Decodes and validates one retained sample's fixed-size descriptor.
   *
   * @param track - Track containing the descriptor record.
   * @param id - Retained logical sample ID.
   * @returns A promise resolving to a newly decoded sample descriptor.
   * @throws {RangeError} If the reference, persisted kind, or descriptor is invalid.
   * @throws If loading the descriptor page fails.
   */
  async function get(track: Track, id: number): Promise<FragmentSample> {
    const page = await getSamplePage(track, id)
    const view = getSampleView(track, page, id)
    const type = view.getUint8(48)
    if (type > 1) {
      throw new RangeError('Invalid sample storage type.')
    }

    // Integer fields also use Float64 so safe integer offsets and timescale
    // counts survive round trips without 32-bit truncation.
    const sample: FragmentSample = {
      timestamp: view.getFloat64(0),
      decodeTimestamp: view.getFloat64(8),
      duration: view.getFloat64(16),
      size: view.getFloat64(24),
      timescaleUnitsToNextSample: view.getFloat64(32),
      mediaOffset: view.getFloat64(40),
      type: type ? 'key' : 'delta',
    }

    assertValidSample(sample)

    return sample
  }

  /**
   * Encodes a descriptor into its cached page, ignoring refinements to released IDs.
   *
   * @param track - Track owning the descriptor cache.
   * @param id - Logical sample ID to update.
   * @param sample - Valid replacement descriptor; payload bytes are not rewritten.
   * @returns A promise resolving after the page is updated and marked dirty, or
   * immediately when the ID was already released.
   * @throws If the retained reference, sample fields, or page I/O are invalid.
   */
  async function set(track: Track, id: number, sample: FragmentSample) {
    // A later GOP can refine the previous last duration after its fragment was
    // already emitted. That old mutation must not resurrect a released record.
    if (id < track.base) {
      return
    }

    assertValidSample(sample)
    const page = await getSamplePage(track, id)
    const view = getSampleView(track, page, id)

    view.setFloat64(0, sample.timestamp)
    view.setFloat64(8, sample.decodeTimestamp)
    view.setFloat64(16, sample.duration)
    view.setFloat64(24, sample.size)
    view.setFloat64(32, sample.timescaleUnitsToNextSample)
    view.setFloat64(40, sample.mediaOffset)
    view.setUint8(48, sample.type === 'key' ? 1 : 0)
    page.dirty = true
  }

  /**
   * Drains a track's pending encoded media page to its physical backing file.
   *
   * @param track - Track whose pending media bytes should be written.
   * @returns A promise resolving after the page is empty and physical write offset advances.
   * @throws If the positional media transfer fails.
   */
  async function flushMedia(track: Track) {
    if (!track.mediaUsed) {
      return
    }

    await transferFileBytes(
      track.files.media,
      track.mediaBuffer.subarray(0, track.mediaUsed),
      track.mediaWritten,
      true,
    )
    track.mediaWritten += track.mediaUsed
    track.mediaUsed = 0
  }

  /**
   * Moves retained bytes over a consumed prefix and truncates the file afterward.
   * Transfers at most one 64 KiB page at a time.
   *
   * @param file - Positional backing file to compact in place.
   * @param consumed - Physical prefix byte count to discard.
   * @param total - Current physical byte length, including the consumed prefix.
   * @returns A promise resolving when retained bytes start at zero and truncation completes.
   * @throws If reading, writing, or truncating the backing file fails.
   */
  async function compactFile(
    file: FragmentSampleFile,
    consumed: number,
    total: number,
  ) {
    const buffer = new Uint8Array(IO_SIZE)

    // Copy forward into the discarded prefix. Each source chunk is read before
    // its destination is overwritten, so overlapping ranges remain safe.
    for (let offset = consumed; offset < total; offset += IO_SIZE) {
      const bytes = buffer.subarray(0, Math.min(IO_SIZE, total - offset))
      await transferFileBytes(file, bytes, offset, false)
      await transferFileBytes(file, bytes, offset - consumed, true)
    }

    await file.truncate(total - consumed)
  }

  return {
    /**
     * Queues encoded media and a descriptor, assigning monotonically increasing
     * sample IDs and logical payload offsets for this track.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param sample - Descriptor without mediaOffset; size must equal data.length.
     * @param data - Encoded payload kept stable until append completion.
     * @returns A promise resolving to the new track-local logical sample ID.
     * @throws If sample fields, storage sizes, track opening, or queued I/O fail.
     */
    append(
      trackId: number,
      sample: Omit<FragmentSample, 'mediaOffset'>,
      data: Uint8Array,
    ) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        const record = { ...sample, mediaOffset: track.mediaEnd }
        assertValidSample(record)
        if (
          data.length !== sample.size ||
          !Number.isSafeInteger((track.end + 1) * RECORD_SIZE) ||
          !Number.isSafeInteger(track.mediaEnd + data.length)
        ) {
          throw new RangeError('Invalid sample storage size.')
        }

        for (let offset = 0; offset < data.length;) {
          const length = Math.min(
            data.length - offset,
            IO_SIZE - track.mediaUsed,
          )
          track.mediaBuffer.set(
            data.subarray(offset, offset + length),
            track.mediaUsed,
          )
          track.mediaUsed += length
          offset += length
          if (track.mediaUsed === IO_SIZE) {
            await flushMedia(track)
          }
        }

        track.mediaEnd += data.length
        const id = track.end++
        await set(track, id, record)

        return id
      })
    },

    /**
     * Queues retrieval of a retained sample descriptor.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param id - Retained logical sample ID returned by append().
     * @returns A promise resolving to the decoded and validated descriptor.
     * @throws If the reference is invalid or queued storage work fails.
     */
    get(trackId: number, id: number) {
      return enqueueOperation(async () => get(await getTrack(trackId), id))
    },

    /**
     * Queues a descriptor update without changing its encoded payload bytes.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param id - Logical sample ID; released IDs are ignored.
     * @param sample - Replacement sample descriptor.
     * @returns A promise resolving when the update or released-ID no-op completes.
     * @throws If retained references, descriptor fields, or queued storage work fail.
     */
    set(trackId: number, id: number, sample: FragmentSample) {
      return enqueueOperation(async () =>
        set(await getTrack(trackId), id, sample),
      )
    },

    /**
     * Sorts a retained range's presentation timestamps, using bounded external
     * merge passes for ranges larger than the in-memory run buffer.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param start - First retained sample ID in the range.
     * @param count - Positive safe integer count of consecutive samples to sort.
     * @returns A promise resolving when sorted() can access the new timestamp range.
     * @throws If the range is invalid or queued reads, writes, or truncations fail.
     */
    sort(trackId: number, start: number, count: number) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          start < track.base ||
          start + count > track.end
        ) {
          throw new RangeError('Invalid gop storage range.')
        }

        // Sort timestamps separately from descriptors: presentation order can
        // differ from decode order, which sample IDs must continue to preserve.
        track.sortedPage = undefined
        track.sortedCount = count

        if (count <= SORT_RUN) {
          for (let at = 0; at < count; at++) {
            track.sortedMemory[at] = (await get(track, start + at)).timestamp
          }

          track.sortedMemory.subarray(0, count).sort()

          return
        }

        // Seed the first sort file with independently sorted, bounded runs.
        track.externalSort = true
        let source: 'sort-a' | 'sort-b' = 'sort-a'
        let destination: 'sort-a' | 'sort-b' = 'sort-b'
        const values = track.sortedMemory

        for (let offset = 0; offset < count; offset += SORT_RUN) {
          const length = Math.min(SORT_RUN, count - offset)

          for (let at = 0; at < length; at++) {
            values[at] = (await get(track, start + offset + at)).timestamp
          }

          const run = values.subarray(0, length)
          run.sort()
          await transferFileBytes(
            track.files[source],
            new Uint8Array(run.buffer, run.byteOffset, run.byteLength),
            offset * 8,
            true,
          )
        }

        await track.files[source].truncate(count * 8)

        // Merge adjacent runs, doubling their width each pass. Alternate files
        // so output never overwrites timestamps still needed by input cursors.
        for (let width = SORT_RUN; width < count; width *= 2) {
          await track.files[destination].truncate(0)
          const output = new Float64Array(IO_SIZE / 8)
          let used = 0
          let written = 0
          const outputFile = track.files[destination]
          const inputFile = track.files[source]

          /**
           * Buffers one merged timestamp, flushing a full output page to disk.
           *
           * @param value - Next ascending presentation timestamp in seconds.
           * @returns A promise resolving after buffering or the required page write.
           * @throws If writing a full sort-output page fails.
           */
          const emit = async (value: number) => {
            output[used++] = value
            if (used === output.length) {
              await transferFileBytes(
                outputFile,
                new Uint8Array(
                  output.buffer,
                  output.byteOffset,
                  output.byteLength,
                ),
                written * 8,
                true,
              )
              written += used
              used = 0
            }
          }

          for (let offset = 0; offset < count; offset += width * 2) {
            /**
             * Creates a paged cursor over one sorted run in the current input file.
             *
             * @param first - Inclusive starting timestamp index in the file.
             * @param end - Exclusive ending timestamp index in the file.
             * @returns A cursor that reports remaining values, peeks, and advances.
             */
            const createSortCursor = (first: number, end: number) => {
              let at = first
              let loaded = 0
              let index = 0
              const bytes = new Uint8Array(IO_SIZE)
              const view = new Float64Array(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength / 8,
              )

              return {
                /**
                 * Checks whether this sorted run still contains an unread value.
                 *
                 * @returns Whether the cursor is before its exclusive end index.
                 */
                has: () => at < end,

                /**
                 * Loads a page when needed and reads without advancing the cursor.
                 *
                 * @returns A promise resolving to the current timestamp in seconds.
                 * @throws If reading the sort file or accessing the loaded value fails.
                 */
                async peek() {
                  if (index === loaded) {
                    loaded = Math.min(view.length, end - at)
                    index = 0
                    await transferFileBytes(
                      inputFile,
                      bytes.subarray(0, loaded * 8),
                      at * 8,
                      false,
                    )
                  }

                  return readTimestamp(view, index)
                },

                /**
                 * Advances one timestamp; callers must ensure has() is true.
                 *
                 * @returns Nothing.
                 */
                next() {
                  at++
                  index++
                },
              }
            }

            const left = createSortCursor(
              offset,
              Math.min(offset + width, count),
            )
            const right = createSortCursor(
              Math.min(offset + width, count),
              Math.min(offset + width * 2, count),
            )

            while (left.has() || right.has()) {
              if (
                !right.has() ||
                (left.has() && (await left.peek()) <= (await right.peek()))
              ) {
                await emit(await left.peek())
                left.next()
              } else {
                await emit(await right.peek())
                right.next()
              }
            }
          }

          // The last partial output page must reach disk before swapping files.
          if (used) {
            await transferFileBytes(
              track.files[destination],
              new Uint8Array(output.buffer, output.byteOffset, used * 8),
              written * 8,
              true,
            )
          }
          ;[source, destination] = [destination, source]
        }

        track.sortedFile = source
        track.sortedCount = count
      })
    },

    /**
     * Reads one sorted timestamp from memory or the cached external-sort page.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param index - Zero-based integer position in the most recent sorted range.
     * @returns A promise resolving to the presentation timestamp in seconds.
     * @throws If the index is invalid or queued sort-file reading fails.
     */
    sorted(trackId: number, index: number) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= track.sortedCount
        ) {
          throw new RangeError('Invalid sorted timestamp reference.')
        }

        if (track.sortedCount <= SORT_RUN) {
          return readTimestamp(track.sortedMemory, index)
        }

        // Align the byte offset to a page so sequential timestamp lookups reuse
        // one disk read rather than reading an individual Float64 each time.
        const offset = Math.floor((index * 8) / IO_SIZE) * IO_SIZE
        if (track.sortedPage?.offset !== offset) {
          const bytes = new Uint8Array(
            Math.min(IO_SIZE, track.sortedCount * 8 - offset),
          )
          await transferFileBytes(
            track.files[track.sortedFile],
            bytes,
            offset,
            false,
          )
          track.sortedPage = { offset, bytes }
        }

        const timestamps = new Float64Array(
          track.sortedPage.bytes.buffer,
          track.sortedPage.bytes.byteOffset,
          track.sortedPage.bytes.byteLength / 8,
        )

        return readTimestamp(timestamps, (index * 8 - offset) / 8)
      })
    },

    /**
     * Flushes pending media and reads a retained range using logical byte offsets.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param offset - Safe integer logical media offset at or after the retained base.
     * @param length - Integer byte count from 0 through 65536 within retained media.
     * @returns A promise resolving to a new buffer containing exactly length bytes.
     * @throws If the range is invalid or queued media I/O fails.
     */
    readMedia(trackId: number, offset: number, length: number) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        if (
          !Number.isSafeInteger(offset) ||
          offset < track.mediaBase ||
          !Number.isInteger(length) ||
          length < 0 ||
          length > IO_SIZE ||
          offset + length > track.mediaEnd
        ) {
          throw new RangeError('Invalid sample media read range.')
        }

        await flushMedia(track)
        const bytes = new Uint8Array(length)
        await transferFileBytes(
          track.files.media,
          bytes,
          offset - track.mediaBase,
          false,
        )

        return bytes
      })
    },

    /**
     * Discards a consumed sample prefix, compacts retained records and media,
     * and clears sort results when the retained boundary advances.
     *
     * @param trackId - Integer track identifier from 1 through 0xffffffff.
     * @param before - Exclusive logical sample ID boundary within the retained
     * range, including the next ID that append() would assign.
     * @returns A promise resolving after compaction, or immediately for an unchanged base.
     * @throws If the boundary is invalid or queued compaction and truncation fail.
     */
    release(trackId: number, before: number) {
      return enqueueOperation(async () => {
        const track = await getTrack(trackId)
        if (
          !Number.isSafeInteger(before) ||
          before < track.base ||
          before > track.end
        ) {
          throw new RangeError('Invalid sample release range.')
        }

        if (before === track.base) {
          return
        }

        // Flush dirty pages before moving bytes; cached page indices refer to
        // the old physical layout and must be discarded after the flush.
        const last = await get(track, before - 1)

        for (const page of track.pages) {
          await flushPage(track, page)
        }

        track.pages = []
        await flushMedia(track)
        await compactFile(
          track.files.records,
          (before - track.base) * RECORD_SIZE,
          (track.end - track.base) * RECORD_SIZE,
        )
        const mediaBase = last.mediaOffset + last.size
        await compactFile(
          track.files.media,
          mediaBase - track.mediaBase,
          track.mediaEnd - track.mediaBase,
        )

        // Only physical file positions change. Retained sample IDs and media
        // offsets stay logical, with the new bases translating them on access.
        track.recordBytes = (track.end - before) * RECORD_SIZE
        track.base = before
        track.mediaBase = mediaBase
        track.mediaWritten = track.mediaEnd - mediaBase
        track.sortedCount = 0
        track.sortedPage = undefined
        if (track.externalSort) {
          await track.files['sort-a'].truncate(0)
          await track.files['sort-b'].truncate(0)
          track.externalSort = false
        }
      })
    },

    /**
     * Rejects new work, drains the queue, and attempts to close every backing file.
     * Buffered data is discarded and repeat calls share the same disposal promise.
     *
     * @returns A promise resolving when all opened files have closed successfully.
     * @throws The first close failure after every opened file has been attempted.
     */
    dispose() {
      disposed = true

      return (disposal ??= (async () => {
        await queue
        let closeFailure: { error: unknown } | undefined

        for (const track of tracks.values()) {
          for (const file of Object.values(track.files)) {
            try {
              await file.close()
            } catch (error) {
              closeFailure ??= { error }
            }
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
