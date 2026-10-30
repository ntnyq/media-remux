/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Workers do not accept a window target origin. */
import { remuxMedia, combineTracks, concatMedia } from '../core/remux'
import { createOpfsStorage } from '../storage'
import type { DisposableRemuxStorage } from '../storage'
import type {
  MediaOutputChunk,
  RemuxOptions,
  RemuxProgress,
  RemuxResult,
} from '../types'
import { isWorkerRequest } from './protocol'
import type { WorkerResponse } from './protocol'

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

/**
 * Installs the job protocol in a dedicated Worker entry. One job is accepted per
 * Worker. The parent owns termination, including interruption of synchronous I/O.
 * Progress, completion, and serialized errors are posted to the parent. Invalid
 * first requests consume the job slot too; subsequent messages are ignored.
 * Each accepted job closes its temporary stores before reporting completion.
 *
 * @param scope - Dedicated Worker messaging surface; defaults to globalThis.
 * @returns A synchronous function that removes the message listener. Removing
 * the listener does not cancel an already running job or terminate the Worker.
 * @throws If registering the message listener fails. Asynchronous job failures
 * are reported to the parent as error responses.
 */
export function installMediaWorker(
  scope: MediaWorkerScope = globalThis,
): () => void {
  let isRunning = false

  /**
   * Accepts the first parent message and ignores every subsequent request.
   *
   * @param event - Parent message containing an untrusted job request.
   * @returns A promise resolving after request handling, or immediately if busy.
   */
  const listener = async (event: MessageEvent<unknown>) => {
    if (isRunning) {
      return
    }

    isRunning = true
    await run(event.data)
  }

  /**
   * Validates and executes a job, disposing stores before reporting its result.
   * Failures trigger cleanup and a serialized error response to the parent.
   *
   * @param request - Untrusted first message received by this Worker.
   * @returns A promise resolving after completion or error reporting.
   * @throws If posting the error response to the parent fails.
   */
  async function run(request: unknown) {
    let storage: DisposableRemuxStorage | undefined
    let writer: FileSystemWritableFileStream | undefined

    try {
      if (!isWorkerRequest(request)) {
        throw new TypeError('Invalid media Worker request.')
      }

      writer = await request.handle.createWritable()
      const activeWriter = writer
      storage = createOpfsStorage(request.directory)
      const writable = new WritableStream<MediaOutputChunk>({
        /**
         * Forwards a positioned container write to the job's output file.
         *
         * @param chunk - Container bytes and absolute destination offset.
         * @returns A promise resolving when the filesystem write completes.
         */
        write: chunk => activeWriter.write(chunk),

        /**
         * Commits the output file after successful muxer finalization.
         *
         * @returns A promise resolving when the filesystem writer closes.
         */
        close: () => activeWriter.close(),

        /**
         * Aborts uncommitted output when stream processing fails.
         *
         * @param reason - Stream cancellation or failure reason.
         * @returns A promise resolving when the filesystem writer aborts.
         */
        abort: reason => activeWriter.abort(reason),
      })

      let lastProgressAt = -Infinity
      let lastPhase: RemuxProgress['phase'] = 'inspect'

      /**
       * Posts phase changes immediately and limits remux updates to one per 250 ms.
       *
       * @param progress - Current job phase, payload byte count, and segment position.
       * @returns Nothing; throttled remux updates are skipped.
       */
      const onProgress = (progress: RemuxProgress) => {
        const now = Date.now()
        if (
          progress.phase !== lastPhase ||
          progress.phase !== 'remux' ||
          now - lastProgressAt >= 250
        ) {
          lastProgressAt = now
          lastPhase = progress.phase
          scope.postMessage({ type: 'progress', progress })
        }
      }

      const options: RemuxOptions = {
        writable,
        storage,
        onProgress,
        ...('tracks' in request.job && request.job.tracks
          ? { tracks: request.job.tracks }
          : {}),
      }

      const { job } = request
      let result: RemuxResult

      switch (job.operation) {
        case 'remux': {
          result = await remuxMedia(job.input, options)
          break
        }

        case 'combine': {
          result = await combineTracks(job.video, job.audio, options)
          break
        }

        case 'concat': {
          result = await concatMedia(job.inputs, options)
          break
        }

        default: {
          throw new TypeError('Unsupported media operation.')
        }
      }

      // Release spool handles before reporting completion: the parent removes
      // the spool directory as soon as it receives this response.
      await storage.dispose()
      scope.postMessage({ type: 'complete', result })
    } catch (error) {
      const cleanup = await Promise.allSettled([
        storage?.dispose(),
        writer?.abort(),
      ])
      const cleanupError = cleanup.find(result => result.status === 'rejected')
      const message = error instanceof Error ? error.message : String(error)

      scope.postMessage({
        type: 'error',
        name: error instanceof Error ? error.name : 'Error',
        message:
          cleanupError?.status === 'rejected'
            ? `${message} (cleanup: ${String(cleanupError.reason)})`
            : message,
      })
    }
  }

  scope.addEventListener('message', listener)

  return () => scope.removeEventListener('message', listener)
}
