import type { ValueOf } from '@ntnyq/utils'
import type {
  FRAGMENT_SAMPLE_FILE_KIND,
  FRAGMENT_SAMPLE_TYPE,
} from '../constants'

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

/**
 * Per-track backing file, pending write page, and read phase.
 */
export interface FragmentTrackFile {
  /**
   * Open backing file for positional reads and writes.
   */
  file: FragmentStoreFile

  /**
   * Reusable page holding pending append bytes.
   */
  buffer: Uint8Array<ArrayBuffer>

  /**
   * Number of pending bytes at the start of the write page.
   */
  used: number

  /**
   * Number of bytes written to the backing file, excluding buffered bytes.
   */
  written: number

  /**
   * Whether the file has been sealed for reading.
   */
  sealed: boolean
}

/**
 * Positional backing file for one track's TFRA index; uses FragmentStoreFile's
 * write, read, seal, and close contracts.
 */
export type FragmentIndexFile = FragmentStoreFile

/**
 * Per-track TFRA byte store; uses FragmentStore's append and bounded read contracts.
 */
export type FragmentIndexStore = FragmentStore

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
   * Whether the sample is independently decodable or depends on other samples.
   */
  type: ValueOf<typeof FRAGMENT_SAMPLE_TYPE>

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
   * @param sample - Updated descriptor with the original payload offset and size.
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
 * Role of a backing file within one track's sample store.
 */
export type FragmentSampleFileKind = ValueOf<typeof FRAGMENT_SAMPLE_FILE_KIND>

/**
 * The two temporary files that alternate as input and output during merge passes.
 */
export type FragmentSampleSortFileKind =
  | typeof FRAGMENT_SAMPLE_FILE_KIND.sortA
  | typeof FRAGMENT_SAMPLE_FILE_KIND.sortB

/**
 * Cached page of fixed-size sample descriptors.
 */
export interface FragmentSamplePage {
  /**
   * Zero-based page index relative to the current records file.
   */
  index: number

  /**
   * Buffer holding the serialized sample descriptors for the page.
   */
  bytes: Uint8Array<ArrayBuffer>

  /**
   * Whether the page contains changes pending a write to the records file.
   */
  dirty: boolean
}

/**
 * Backing files, cached pages, and logical sample ranges for one track.
 */
export interface FragmentSampleTrack {
  /**
   * Positional backing files for sample descriptors and encoded payloads.
   */
  files: Record<
    Exclude<FragmentSampleFileKind, FragmentSampleSortFileKind>,
    FragmentSampleFile
  >

  /**
   * Pair of merge files, opened on the first sort that exceeds the in-memory limit.
   */
  sortFiles: Record<FragmentSampleSortFileKind, FragmentSampleFile> | undefined

  /**
   * Up to two descriptor pages, ordered from least to most recently used.
   */
  pages: FragmentSamplePage[]

  /**
   * First retained logical sample ID, equal to end when the retained range is empty.
   */
  base: number

  /**
   * Exclusive upper sample ID bound and the ID assigned to the next append.
   */
  end: number

  /**
   * Logical sample ID at records file offset zero. It may precede the retained range.
   */
  recordFileBase: number

  /**
   * Byte extent of descriptors already written to the records file.
   */
  recordBytes: number

  /**
   * Lowest readable logical payload byte offset after releasing a sample prefix.
   */
  mediaBase: number

  /**
   * Exclusive logical payload byte end, including pending writes.
   */
  mediaEnd: number

  /**
   * Logical payload byte offset corresponding to media file offset zero.
   */
  mediaFileBase: number

  /**
   * Reusable page holding encoded bytes queued for the media file.
   */
  mediaBuffer: Uint8Array<ArrayBuffer>

  /**
   * Number of pending bytes at the start of the media page.
   */
  mediaUsed: number

  /**
   * Number of bytes written to the current media file, relative to mediaFileBase.
   */
  mediaWritten: number

  /**
   * Number of timestamps in the current sort result, or zero after invalidation.
   */
  sortedCount: number

  /**
   * Scratch buffer for sorted runs that also retains small sort results in memory.
   */
  sortedMemory: Float64Array<ArrayBuffer>

  /**
   * Whether the merge files contain external sort data to clear upon release.
   */
  externalSort: boolean

  /**
   * Merge file containing the final result when the current sort uses disk.
   */
  sortedFile: FragmentSampleSortFileKind

  /**
   * Most recently read page of the external sort result, if loaded.
   */
  sortedPage:
    | {
        /**
         * Absolute byte offset of the page in the selected merge file.
         */
        offset: number

        /**
         * Raw bytes of the sorted Float64 timestamps in this page.
         */
        bytes: Uint8Array<ArrayBuffer>
      }
    | undefined
}

/**
 * Caller-owned temporary stores; dispose them after every job.
 */
export interface RemuxStorage {
  /**
   * Per-track storage for completed-fragment TFRA index records.
   */
  fragmentIndex: FragmentIndexStore

  /**
   * Storage for sample metadata, encoded payloads, and sorted GOP timestamps.
   */
  fragmentSamples: FragmentSampleStore
}

/**
 * Caller-owned temporary remux stores with a shared resource cleanup operation.
 */
export interface DisposableRemuxStorage extends RemuxStorage {
  /**
   * Attempts to close both stores even if one fails. Repeated calls reuse each
   * store's disposal; removing the temporary directory remains the caller's job.
   *
   * @returns A promise resolving when both stores are disposed.
   * @throws The first rejected disposal result if either store fails to close.
   */
  dispose: () => Promise<void>
}

/**
 * Worker file handle supporting synchronous positional access to temporary files.
 */
export interface WorkerFileHandle extends FileSystemFileHandle {
  /**
   * Opens exclusive synchronous file access in a dedicated Worker.
   *
   * @returns A promise resolving to positional I/O and file lifecycle methods.
   */
  createSyncAccessHandle: () => Promise<{
    /**
     * Reads synchronously into a caller-owned buffer.
     *
     * @param data - Destination bytes to fill from the start of the buffer.
     * @param options - Positional read settings.
     * @param options.at - Absolute source byte offset in the file.
     * @returns Number of bytes read, which may be less than the buffer length.
     */
    read: (data: Uint8Array<ArrayBuffer>, options: { at: number }) => number

    /**
     * Writes synchronously at an explicit file position.
     *
     * @param data - Source bytes to write.
     * @param options - Positional write settings.
     * @param options.at - Absolute destination byte offset in the file.
     * @returns Number of bytes written, which may be less than the buffer length.
     */
    write: (data: Uint8Array<ArrayBuffer>, options: { at: number }) => number

    /**
     * Resizes the synchronous backing file.
     *
     * @param size - New file length in bytes.
     * @returns Nothing.
     */
    truncate: (size: number) => void

    /**
     * Releases the synchronous handle and its exclusive file lock.
     *
     * @returns Nothing.
     */
    close: () => void
  }>
}
