/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Workers do not accept a window target origin. */

import { isUndefined, retry } from '@ntnyq/utils'
import {
  MEDIA_JOB_OPERATION,
  REMUX_MIME_TYPE,
  WORKER_MESSAGE_TYPE,
  JOB_OUTPUT_MP4_FILE,
  JOB_OUTPUT_M4A_FILE,
  JOB_SPOOL_DIRECTORY,
} from '../constants'
import type {
  RemuxResult,
  MediaJob,
  MediaJobOptions,
  MediaJobResult,
  WorkerRequest,
  WorkerResponse,
} from '../types'
import { checkAbort, withRemuxErrorCode } from '../utils'
import { isWorkerResponse } from './protocol'

/**
 * Captures job fields and segment order before asynchronous filesystem setup.
 *
 * @param job - Submitted operation, including inherited or accessor-backed fields.
 * @returns A plain job object sharing immutable input Blobs.
 * @throws {TypeError} If the operation is unsupported.
 */
function captureJob(job: MediaJob): MediaJob {
  const { normalizeAudio } = job
  const audioOptions = isUndefined(normalizeAudio) ? {} : { normalizeAudio }

  switch (job.operation) {
    case MEDIA_JOB_OPERATION.remux: {
      const { input, tracks } = job

      return {
        operation: MEDIA_JOB_OPERATION.remux,
        input,
        ...audioOptions,
        ...(isUndefined(tracks) ? {} : { tracks }),
      }
    }
    case MEDIA_JOB_OPERATION.concat: {
      const { inputs, tracks } = job

      return {
        operation: MEDIA_JOB_OPERATION.concat,
        inputs: [...inputs],
        ...audioOptions,
        ...(isUndefined(tracks) ? {} : { tracks }),
      }
    }
    case MEDIA_JOB_OPERATION.combine: {
      return {
        operation: MEDIA_JOB_OPERATION.combine,
        video: job.video,
        audio: job.audio,
        ...audioOptions,
      }
    }
    default: {
      throw new TypeError('Unsupported media operation.')
    }
  }
}

/**
 * Removes a job entry recursively, retrying transient Worker filesystem locks.
 *
 * @param directory - Parent directory containing the entry.
 * @param name - Child entry name to remove.
 * @returns A promise resolving when removal succeeds or the entry is already absent.
 * @throws If removal fails permanently or remains locked after five retries.
 */
async function removeJob(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await retry(
    async () => {
      try {
        await directory.removeEntry(name, { recursive: true })
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === 'NotFoundError')
        ) {
          throw error
        }
      }
    },
    {
      // Worker termination can precede release of its OPFS locks.
      maxAttempts: 6,
      backoff: (_error, { attempt }) => 50 * attempt,
      shouldRetry: error =>
        error instanceof DOMException &&
        ['NoModificationAllowedError', 'InvalidStateError'].includes(
          error.name,
        ),
    },
  )
}

/**
 * Runs one isolated OPFS job. Success retains only its output until dispose();
 * failure/cancellation terminates the Worker and removes the entire job folder.
 * The Worker is dedicated to this job and is terminated on completion as well.
 *
 * @param job - Remux, track-combining, or concatenation operation and its input
 * Blobs. Audio normalization is optional, and remuxing and concatenation
 * also allow track selection.
 * @param options - Dedicated Worker factory, optional parent directory (defaults
 * to the origin's OPFS root), cancellation signal, and progress callback.
 * @returns A promise resolving to the output File, duration in seconds, MIME
 * type, written encoded payload bytes, and an idempotent, retryable directory
 * disposer. Call dispose() after saving or reading the file.
 * @throws {Error} If OPFS is unavailable, Worker execution or messaging fails,
 * a response is invalid, or the output is empty. Also propagates filesystem,
 * Worker factory, and progress callback failures.
 * @throws {AggregateError} If a job fails and removing its directory also fails.
 * @throws The signal's abort reason if cancellation is detected and cleanup succeeds.
 */
export async function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult> {
  const {
    createWorker,
    directory: parentDirectory,
    signal,
    onProgress,
  } = options
  const settings = {
    createWorker,
    ...(isUndefined(parentDirectory) ? {} : { directory: parentDirectory }),
    ...(isUndefined(signal) ? {} : { signal }),
    ...(isUndefined(onProgress) ? {} : { onProgress }),
  }

  checkAbort(settings.signal)
  const submittedJob = captureJob(job)

  const directory =
    settings.directory ??
    (await globalThis.navigator?.storage?.getDirectory?.())

  if (!directory) {
    throw new Error(
      'OPFS is unavailable. Supply a directory or use the core APIs with a storage adapter.',
    )
  }

  checkAbort(settings.signal)
  const name = `media-remux-${crypto.randomUUID()}`
  const temporary = await directory.getDirectoryHandle(name, { create: true })
  let worker: Worker | undefined
  let isDisposed = false
  let disposal: Promise<void> | undefined

  /**
   * Removes this job's directory once, sharing concurrent attempts and allowing
   * a failed attempt to be retried.
   *
   * @returns A promise resolving after removal or immediately after prior success.
   * @throws If recursive directory removal fails after transient-lock retries.
   */
  const dispose = () => {
    if (isDisposed) {
      return Promise.resolve()
    }

    disposal ??= (async () => {
      try {
        await removeJob(directory, name)
        isDisposed = true
      } finally {
        disposal = undefined
      }
    })()

    return disposal
  }

  try {
    checkAbort(settings.signal)
    const handle = await temporary.getFileHandle(JOB_OUTPUT_MP4_FILE, {
      create: true,
    })
    const spools = await temporary.getDirectoryHandle(JOB_SPOOL_DIRECTORY, {
      create: true,
    })

    checkAbort(settings.signal)
    worker = settings.createWorker()
    const activeWorker = worker

    // Adapt Worker events to one completion promise, cleaning up every listener.
    const result = await new Promise<RemuxResult>((resolve, reject) => {
      let isSettled = false

      /**
       * Settles the job once, detaching listeners and terminating its Worker.
       *
       * @param error - Rejection reason used when no completion result is supplied.
       * @param completed - Optional successful result, taking precedence over error.
       * @returns Nothing; later settlement attempts are ignored.
       */
      function finish(error: unknown, completed?: RemuxResult) {
        if (isSettled) {
          return
        }

        isSettled = true
        activeWorker.removeEventListener('message', onMessage)
        activeWorker.removeEventListener('error', onError)
        activeWorker.removeEventListener('messageerror', onMessageError)
        settings.signal?.removeEventListener('abort', onAbort)
        activeWorker.terminate()

        if (completed) {
          resolve(completed)
        } else {
          reject(error)
        }
      }

      /**
       * Validates a Worker response and forwards progress or settles the job.
       *
       * @param event - Worker message containing an untrusted protocol response.
       * @returns Nothing; malformed responses and callback errors fail the job.
       */
      function onMessage(event: MessageEvent<unknown>) {
        if (!isWorkerResponse(event.data)) {
          finish(new Error('Invalid media Worker response.'))

          return
        }

        const response: WorkerResponse = event.data

        if (response.type === WORKER_MESSAGE_TYPE.progress) {
          try {
            settings.onProgress?.(response.progress)
          } catch (error) {
            finish(error)
          }
        } else if (response.type === WORKER_MESSAGE_TYPE.complete) {
          finish(undefined, response.result)
        } else if (response.type === WORKER_MESSAGE_TYPE.error) {
          const error = new Error(response.message)

          error.name = response.name
          finish(
            response.code ? withRemuxErrorCode(error, response.code) : error,
          )
        }
      }

      /**
       * Converts a Worker runtime error into the job's rejection reason.
       *
       * @param event - Worker error event with an optional diagnostic message.
       * @returns Nothing; the Worker is terminated through finish().
       */
      function onError(event: ErrorEvent) {
        finish(new Error(event.message || 'Media Worker failed.'))
      }

      /**
       * Rejects the job when a Worker message cannot be deserialized.
       *
       * @returns Nothing; the Worker is terminated through finish().
       */
      function onMessageError() {
        finish(new Error('Cannot deserialize media Worker message.'))
      }

      /**
       * Rejects the job with its signal's abort reason and terminates the Worker.
       *
       * @returns Nothing.
       */
      function onAbort() {
        finish(settings.signal?.reason)
      }

      activeWorker.addEventListener('message', onMessage)
      activeWorker.addEventListener('error', onError)
      activeWorker.addEventListener('messageerror', onMessageError)
      settings.signal?.addEventListener('abort', onAbort, { once: true })

      // An abort may have happened before listener registration. Check again
      // before posting so an already-cancelled job cannot start in the Worker.
      if (settings.signal?.aborted) {
        onAbort()

        return
      }

      const request: WorkerRequest = {
        type: WORKER_MESSAGE_TYPE.run,
        job: submittedJob,
        handle,
        directory: spools,
      }

      try {
        activeWorker.postMessage(request)
      } catch (error) {
        if (
          !(error instanceof DOMException) ||
          error.name !== 'DataCloneError'
        ) {
          finish(error)

          return
        }

        // Some WebKit versions reject structured cloning OPFS handles. Resolve
        // the job from the Worker's own root while retaining parent ownership.
        ;(async () => {
          const path = settings.directory
            ? await (
                await globalThis.navigator?.storage?.getDirectory?.()
              )?.resolve(temporary)
            : [name]

          if (!path?.length) {
            throw error
          }

          if (!isSettled) {
            activeWorker.postMessage({
              type: WORKER_MESSAGE_TYPE.run,
              job: submittedJob,
              path,
            } satisfies WorkerRequest)
          }
        })().catch(finish)
      }
    })

    checkAbort(settings.signal)
    await removeJob(temporary, JOB_SPOOL_DIRECTORY)

    const file = await handle.getFile()

    checkAbort(settings.signal)

    if (file.size === 0) {
      throw new Error('Media Worker produced an empty output.')
    }

    const outputFile = new File(
      [file],
      result.mimeType === REMUX_MIME_TYPE.audio
        ? JOB_OUTPUT_M4A_FILE
        : JOB_OUTPUT_MP4_FILE,
      { type: result.mimeType },
    )

    return { ...result, file: outputFile, dispose }
  } catch (error) {
    worker?.terminate()

    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Media job failed and its temporary directory could not be removed.',
        { cause: cleanupError },
      )
    }

    throw error
  }
}
