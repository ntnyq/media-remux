import type { MEDIA_JOB_OPERATION, WORKER_MESSAGE_TYPE } from '../constants'
import type { RemuxErrorCode } from './errors'
import type {
  RemuxInput,
  RemuxProgress,
  RemuxResult,
  RemuxTrackSelection,
} from './remux'

/**
 * One isolated Worker operation, discriminated by operation. Inputs are MP4,
 * FLV, MKV, or MPEG-TS Blobs containing supported encoded video and/or audio.
 * Remux and combine jobs also accept MPEG-TS descriptors.
 */
export type MediaJob = {
  /**
   * Whether to normalize selected audio to continuous AAC-LC using WebCodecs.
   */
  normalizeAudio?: boolean
} & (
  | {
      /**
       * Copies selected tracks from a single media input.
       */
      operation: typeof MEDIA_JOB_OPERATION.remux

      /**
       * Nonempty source media Blob or MPEG-TS descriptor.
       */
      input: RemuxInput

      /**
       * Track kinds to retain; defaults to all supported primary tracks.
       */
      tracks?: RemuxTrackSelection
    }
  | {
      /**
       * Combines primary video and audio tracks from separate inputs.
       */
      operation: typeof MEDIA_JOB_OPERATION.combine

      /**
       * Media Blob or MPEG-TS descriptor supplying the primary video track.
       */
      video: RemuxInput

      /**
       * Media Blob or MPEG-TS descriptor supplying the primary audio track.
       */
      audio: RemuxInput
    }
  | {
      /**
       * Appends compatible media segments in playback order.
       */
      operation: typeof MEDIA_JOB_OPERATION.concat

      /**
       * Nonempty segment list with matching selected track layouts and decoder
       * configurations. Each Blob must contain nonempty MP4, FLV, MKV, or MPEG-TS media.
       */
      inputs: readonly Blob[]

      /**
       * Track kinds to retain from every segment; defaults to all primary tracks.
       */
      tracks?: RemuxTrackSelection
    }
)

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
   * @param progress - Current phase, encoded payload bytes, and segment position.
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

/**
 * Parent-to-Worker message requesting one job in an assigned temporary directory.
 */
export type WorkerRequest = {
  /**
   * Identifies a request to execute a media job.
   */
  type: typeof WORKER_MESSAGE_TYPE.run

  /**
   * Operation and source media inputs to process in the dedicated Worker.
   */
  job: MediaJob
} & (
  | {
      /**
       * Job directory path relative to the OPFS root. The Worker opens the
       * output file and spool directory from this path.
       */
      path: readonly string[]
    }
  | {
      /**
       * An absent or undefined path selects the supplied filesystem handles.
       */
      path?: undefined

      /**
       * Handle for the job's output file.
       */
      handle: FileSystemFileHandle

      /**
       * Directory reserved for the job's temporary storage files.
       */
      directory: FileSystemDirectoryHandle
    }
)

/**
 * Worker-to-parent progress, completion, or serialized failure message,
 * discriminated by type.
 */
export type WorkerResponse =
  | {
      /**
       * Identifies a nonterminal progress notification.
       */
      type: typeof WORKER_MESSAGE_TYPE.progress

      /**
       * Current phase, encoded payload bytes written, and segment position.
       */
      progress: RemuxProgress
    }
  | {
      /**
       * Identifies successful output finalization and temporary store disposal.
       */
      type: typeof WORKER_MESSAGE_TYPE.complete

      /**
       * Completed job's duration, MIME type, and written encoded payload byte count.
       */
      result: RemuxResult
    }
  | {
      /**
       * Identifies a terminal job failure after attempted resource cleanup.
       */
      type: typeof WORKER_MESSAGE_TYPE.error

      /**
       * Original Error name, or 'Error' when the thrown value was not an Error.
       */
      name: string

      /**
       * Failure description, including a cleanup failure suffix when applicable.
       */
      message: string

      /**
       * Stable media failure code when available.
       */
      code?: RemuxErrorCode
    }

/**
 * Minimal dedicated-Worker surface, also usable by hosts and tests.
 */
export interface MediaWorkerScope {
  /**
   * Registers a listener for parent-to-Worker messages.
   *
   * @param type - Dedicated Worker message event name.
   * @param listener - Callback receiving an untrusted request in event.data.
   * @returns Nothing; listener registration is synchronous.
   */
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) => void

  /**
   * Removes a previously registered parent-message listener.
   *
   * @param type - Dedicated Worker message event name.
   * @param listener - The same callback reference passed to addEventListener().
   * @returns Nothing; an already running callback is unaffected.
   */
  removeEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) => void

  /**
   * Posts a progress, completion, or error response to the parent thread.
   *
   * @param message - Structured-cloneable media Worker protocol response.
   * @returns Nothing; delivery to the parent is asynchronous.
   */
  postMessage: (message: WorkerResponse) => void
}
