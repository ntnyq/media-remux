/**
 * Operations accepted by the browser media job API.
 */
export const MEDIA_JOB_OPERATION = {
  /**
   * Remux selected primary tracks from one input.
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

/** MP4 output file created in each Worker job directory. */
export const JOB_OUTPUT_MP4_FILE = 'output.mp4'

/** File name exposed for audio-only output. */
export const JOB_OUTPUT_M4A_FILE = 'output.m4a'

/** Subdirectory holding temporary storage for each Worker job. */
export const JOB_SPOOL_DIRECTORY = 'spools'
