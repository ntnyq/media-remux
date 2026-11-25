/**
 * Primary track kinds supported by the remuxer.
 */
export const MEDIA_TRACK_KIND = {
  /**
   * An audio track carrying AAC, MP3, or AC-3 packets.
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

  /**
   * Require the first video track and retain the first audio track when present.
   * Both are selected in file order.
   */
  firstVideoWithOptionalAudio: 'first-video-with-optional-audio',
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
   * Write encoded packets to the output container, including normalized audio
   * when enabled.
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

  /**
   * MPEG Layer III audio.
   */
  mp3: 'mp3',

  /**
   * Dolby Digital (AC-3) audio.
   */
  ac3: 'ac3',
} as const
