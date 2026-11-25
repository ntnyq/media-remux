/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Workers do not accept a window target origin. */
/* oxlint-disable no-await-in-loop -- OPFS path components resolve from parent to child. */

import { isUndefined } from '@ntnyq/utils'
import {
  MEDIA_JOB_OPERATION,
  REMUX_PROGRESS_PHASE,
  WORKER_MESSAGE_TYPE,
  JOB_OUTPUT_MP4_FILE,
  JOB_SPOOL_DIRECTORY,
} from '../constants'
import { remuxMedia, combineTracks, concatMedia } from '../core/remux'
import { createOpfsStorage } from '../storage'
import type {
  MediaOutputChunk,
  RemuxOptions,
  RemuxProgress,
  RemuxResult,
  DisposableRemuxStorage,
  MediaWorkerScope,
} from '../types'
import { isRemuxError } from '../utils'
import { isWorkerRequest } from './protocol'

/**
 * Opens the parent's existing OPFS job files using the Worker's own root.
 *
 * @param path - Job directory components relative to the OPFS root.
 * @returns A promise resolving to the output file handle and spool directory.
 * @throws If the OPFS root, the job directory, or its entries cannot be opened.
 */
async function openJobFiles(path: readonly string[]) {
  let temporary = await globalThis.navigator.storage.getDirectory()

  for (const component of path) {
    temporary = await temporary.getDirectoryHandle(component)
  }

  const [handle, directory] = await Promise.all([
    temporary.getFileHandle(JOB_OUTPUT_MP4_FILE),
    temporary.getDirectoryHandle(JOB_SPOOL_DIRECTORY),
  ])

  return { handle, directory }
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

      const { handle, directory } =
        request.path === undefined ? request : await openJobFiles(request.path)

      writer = await handle.createWritable()
      const activeWriter = writer

      storage = createOpfsStorage(directory)
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
      let lastPhase: RemuxProgress['phase'] = REMUX_PROGRESS_PHASE.inspect

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
          progress.phase !== REMUX_PROGRESS_PHASE.remux ||
          now - lastProgressAt >= 250
        ) {
          lastProgressAt = now
          lastPhase = progress.phase
          scope.postMessage({ type: WORKER_MESSAGE_TYPE.progress, progress })
        }
      }

      const options: RemuxOptions = {
        writable,
        storage,
        onProgress,
        ...(request.job.normalizeAudio ? { normalizeAudio: true } : {}),
        ...('tracks' in request.job && request.job.tracks
          ? { tracks: request.job.tracks }
          : {}),
      }

      const { job } = request
      let result: RemuxResult

      switch (job.operation) {
        case MEDIA_JOB_OPERATION.remux: {
          result = await remuxMedia(job.input, options)
          break
        }

        case MEDIA_JOB_OPERATION.combine: {
          result = await combineTracks(job.video, job.audio, {
            ...options,
            ...(isUndefined(job.timeline) ? {} : { timeline: job.timeline }),
          })
          break
        }

        case MEDIA_JOB_OPERATION.concat: {
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
      scope.postMessage({ type: WORKER_MESSAGE_TYPE.complete, result })
    } catch (error) {
      const cleanup = await Promise.allSettled([
        storage?.dispose(),
        writer?.abort(),
      ])
      const cleanupError = cleanup.find(result => result.status === 'rejected')
      const message = error instanceof Error ? error.message : String(error)

      scope.postMessage({
        type: WORKER_MESSAGE_TYPE.error,
        name: error instanceof Error ? error.name : 'Error',
        ...(isRemuxError(error) ? { code: error.code } : {}),
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
