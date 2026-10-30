import type { RemuxProgress, RemuxResult } from '../types'

/**
 * One isolated Worker operation, discriminated by operation. Inputs are MP4 or
 * FLV Blobs containing H.264 video and/or AAC audio; no re-encoding is performed.
 */
export type MediaJob =
  | {
      /**
       * Copies selected primary tracks from a single media input.
       */
      operation: 'remux'

      /**
       * Nonempty source MP4 or FLV Blob.
       */
      input: Blob

      /**
       * Track kinds to retain; defaults to all supported primary tracks.
       */
      tracks?: 'all' | 'audio' | 'video'
    }
  | {
      /**
       * Combines primary video and audio tracks from separate inputs.
       */
      operation: 'combine'

      /**
       * Nonempty MP4 or FLV Blob supplying the primary H.264 video track.
       */
      video: Blob

      /**
       * Nonempty MP4 or FLV Blob supplying the primary AAC audio track.
       */
      audio: Blob
    }
  | {
      /**
       * Appends compatible media segments in playback order.
       */
      operation: 'concat'

      /**
       * Nonempty segment list with matching selected track layouts and decoder
       * configurations. Each Blob must contain nonempty MP4 or FLV media.
       */
      inputs: readonly Blob[]

      /**
       * Track kinds to retain from every segment; defaults to all primary tracks.
       */
      tracks?: 'all' | 'audio' | 'video'
    }

/**
 * Worker ownership, temporary directory, cancellation, and progress for a browser job.
 * Top-level fields are captured when runMediaJob() is called.
 */
export interface MediaJobOptions {
  /**
   * Creates a dedicated Worker whose entry calls installMediaWorker().
   * The job owns and terminates this Worker, including on cancellation.
   *
   * @returns A fresh Worker reserved exclusively for this job.
   */
  createWorker: () => Worker

  /**
   * Optional cancellation signal. Aborting terminates the Worker and triggers
   * removal of the job's temporary directory.
   */
  signal?: AbortSignal

  /**
   * Receives Worker progress messages on the parent thread. Remux notifications
   * are throttled in the Worker; phase changes are always reported.
   *
   * @param progress - Current phase, copied payload bytes, and segment position.
   * @returns Nothing; asynchronous callback results are not awaited.
   */
  onProgress?: (progress: RemuxProgress) => void

  /**
   * Parent for unique job directories. Defaults to the origin's OPFS root.
   */
  directory?: FileSystemDirectoryHandle
}

/**
 * Completed browser job whose output remains available until explicit disposal.
 * Inherits duration, MIME type, and encoded payload byte count from RemuxResult.
 */
export interface MediaJobResult extends RemuxResult {
  /**
   * Output File named output.mp4 or output.m4a with the result's MIME type.
   * Save or read it before disposing the job's temporary directory.
   */
  file: File

  /**
   * Removes the output directory after the consumer has saved/read the file.
   * Idempotent; a failed removal can be retried.
   *
   * @returns A promise resolving when the directory is removed or already absent.
   * @throws If directory removal fails after retrying transient filesystem locks.
   */
  dispose: () => Promise<void>
}
