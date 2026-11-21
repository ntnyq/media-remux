/**
 * Primary track kinds supported by the remuxer.
 */
export const MEDIA_TRACK_KIND = {
  /**
   * An audio track carrying AAC packets.
   */
  audio: 'audio',

  /**
   * A video track carrying H.264, HEVC, or AV1 packets.
   */
  video: 'video',
} as const

/**
 * Primary tracks to retain when remuxing or concatenating.
 */
export const REMUX_TRACK_SELECTION = {
  ...MEDIA_TRACK_KIND,

  /**
   * Retain every available supported primary track.
   */
  all: 'all',

  /**
   * Require a primary video track in every input and retain audio when present.
   */
  videoWithOptionalAudio: 'video-with-optional-audio',
} as const

/**
 * Stages reported by a core or Worker media job.
 */
export const REMUX_PROGRESS_PHASE = {
  /**
   * Validate inputs, selected tracks, and packet timing.
   */
  inspect: 'inspect',

  /**
   * Copy encoded packets to the output container.
   */
  remux: 'remux',

  /**
   * Write the remaining container metadata.
   */
  finalize: 'finalize',
} as const

/**
 * MIME types for completed MP4 container output.
 */
export const REMUX_MIME_TYPE = {
  /**
   * Audio-only MP4 output.
   */
  audio: 'audio/mp4',

  /**
   * MP4 output containing a video track.
   */
  video: 'video/mp4',
} as const

/**
 * Operations accepted by the browser media job API.
 */
export const MEDIA_JOB_OPERATION = {
  /**
   * Copy selected primary tracks from one input.
   */
  remux: 'remux',

  /**
   * Combine primary video and audio from separate inputs.
   */
  combine: 'combine',

  /**
   * Append compatible segments in playback order.
   */
  concat: 'concat',
} as const

/**
 * Message kinds exchanged between the browser and its media Worker.
 */
export const WORKER_MESSAGE_TYPE = {
  /**
   * Request execution of one media job.
   */
  run: 'run',

  /**
   * Report a nonterminal progress snapshot.
   */
  progress: 'progress',

  /**
   * Report success after finalizing output and disposing temporary stores.
   */
  complete: 'complete',

  /**
   * Report a terminal failure after attempting resource cleanup.
   */
  error: 'error',
} as const

/**
 * Stable media error codes shared by the core and Worker APIs.
 */
export const REMUX_ERROR_CODE = {
  /**
   * The input is not a supported container.
   */
  unsupportedContainer: 'UNSUPPORTED_CONTAINER',

  /**
   * A selected track uses an unsupported codec.
   */
  unsupportedCodec: 'UNSUPPORTED_CODEC',

  /**
   * The input uses a media feature that the remuxer cannot copy safely.
   */
  unsupportedMediaFeature: 'UNSUPPORTED_MEDIA_FEATURE',

  /**
   * Segments differ in selected track layout or configuration.
   */
  incompatibleSegments: 'INCOMPATIBLE_SEGMENTS',

  /**
   * The input is empty, malformed, or contains invalid media data.
   */
  invalidInput: 'INVALID_INPUT',

  /**
   * The requested primary track selection cannot be satisfied.
   */
  missingRequiredTrack: 'MISSING_REQUIRED_TRACK',
} as const

/**
 * Codec families accepted by the encoded packet sources.
 */
export const MEDIA_CODEC = {
  /**
   * H.264 video.
   */
  avc: 'avc',

  /**
   * H.265 video.
   */
  hevc: 'hevc',

  /**
   * AV1 video.
   */
  av1: 'av1',

  /**
   * AAC audio.
   */
  aac: 'aac',
} as const

/**
 * Encoded sample kinds used by packet readers and fragment storage.
 */
export const FRAGMENT_SAMPLE_TYPE = {
  /**
   * An independently decodable sample.
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
