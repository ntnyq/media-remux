/**
 * Encoded sample kinds used by packet readers and fragment storage.
 */
export const FRAGMENT_SAMPLE_TYPE = {
  /**
   * A sample marked as a sync sample in the encoded packet stream.
   */
  key: 'key',

  /**
   * A sample that depends on other samples for decoding.
   */
  delta: 'delta',
} as const

/**
 * Per-track files opened by disk-backed fragment sample storage.
 */
export const FRAGMENT_SAMPLE_FILE_KIND = {
  /**
   * Fixed-size sample metadata records.
   */
  records: 'records',

  /**
   * Encoded sample payload bytes.
   */
  media: 'media',

  /**
   * First scratch file for sorting presentation timestamps on disk.
   */
  sortA: 'sort-a',

  /**
   * Second scratch file, alternated with the first between merge passes.
   */
  sortB: 'sort-b',
} as const

/**
 * Per-track write buffer and maximum read size in bytes, keeping I/O within 64 KiB.
 */
export const FRAGMENT_PAGE_SIZE = 64 * 1024

/**
 * Descriptor size in bytes: six Float64 fields, a sample-type byte, and padding.
 */
export const FRAGMENT_SAMPLE_RECORD_SIZE = 56

/**
 * Number of descriptors per cache page; each track retains at most two pages.
 */
export const FRAGMENT_SAMPLE_RECORDS_PER_PAGE = 1024

/**
 * Descriptor page size in bytes, used for cache buffers and record-file offsets.
 */
export const FRAGMENT_SAMPLE_PAGE_SIZE =
  FRAGMENT_SAMPLE_RECORD_SIZE * FRAGMENT_SAMPLE_RECORDS_PER_PAGE

/**
 * Payload and sort-page transfer limit in bytes, bounding I/O buffers to 64 KiB.
 */
export const FRAGMENT_SAMPLE_IO_SIZE = 64 * 1024

/**
 * Maximum timestamps sorted in memory at once; larger ranges use disk merge passes.
 */
export const FRAGMENT_SAMPLE_SORT_RUN = 4096
