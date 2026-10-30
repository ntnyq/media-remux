/* oxlint-disable no-await-in-loop -- Directory retries must wait for Worker locks to be released. */
/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Workers do not accept a window target origin. */
import { checkAbort } from '../abort'
import type { RemuxResult } from '../types'
import type { WorkerRequest, WorkerResponse } from './protocol'
import { isWorkerResponse } from './protocol'
import type { MediaJob, MediaJobOptions, MediaJobResult } from './types'

/**
 * Captures job fields and segment order before asynchronous filesystem setup.
 *
 * @param job - Submitted operation, including inherited or accessor-backed fields.
 * @returns A plain job object sharing immutable input Blobs.
 * @throws {TypeError} If the operation is unsupported.
 */
function captureJob(job: MediaJob): MediaJob {
  switch (job.operation) {
    case 'remux': {
      const { input, tracks } = job
      return {
        operation: 'remux',
        input,
        ...(tracks === undefined ? {} : { tracks }),
      }
    }
    case 'concat': {
      const { inputs, tracks } = job
      return {
        operation: 'concat',
        inputs: [...inputs],
        ...(tracks === undefined ? {} : { tracks }),
      }
    }
    case 'combine': {
      return { operation: 'combine', video: job.video, audio: job.audio }
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
  for (let attempt = 0; ; attempt++) {
    try {
      await directory.removeEntry(name, { recursive: true })

      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return
      }

      if (
        !(error instanceof DOMException) ||
        !['NoModificationAllowedError', 'InvalidStateError'].includes(
          error.name,
        ) ||
        attempt >= 5
      ) {
        throw error
      }

      // Worker termination can precede release of its OPFS locks. Retry only
      // transient lock errors, with a bounded delay before each new attempt.
      // oxlint-disable-next-line promise/avoid-new
      await new Promise(resolve => {
        setTimeout(resolve, 50 * (attempt + 1))
      })
    }
  }
}

/**
 * Runs one isolated OPFS job. Success retains only its output until dispose();
 * failure/cancellation terminates the Worker and removes the entire job folder.
 * The Worker is dedicated to this job and is terminated on completion as well.
 *
 * @param job - Remux, track-combining, or concatenation operation and its input
 * Blobs, with optional track selection for remuxing or concatenation.
 * @param options - Dedicated Worker factory, optional parent directory (defaults
 * to the origin's OPFS root), cancellation signal, and progress callback.
 * @returns A promise resolving to the output File, duration in seconds, MIME
 * type, copied encoded payload bytes, and an idempotent, retryable directory
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
    ...(parentDirectory === undefined ? {} : { directory: parentDirectory }),
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onProgress }),
  }
  checkAbort(settings.signal)
  const submittedJob = captureJob(job)

  const directory =
    settings.directory ?? (await globalThis.navigator?.storage?.getDirectory())
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
    const handle = await temporary.getFileHandle('output.mp4', { create: true })
    const spools = await temporary.getDirectoryHandle('spools', {
      create: true,
    })

    checkAbort(settings.signal)
    worker = settings.createWorker()
    const activeWorker = worker

    // Adapt Worker events to one completion promise, cleaning up every listener.
    // oxlint-disable-next-line promise/avoid-new
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
        if (response.type === 'progress') {
          try {
            settings.onProgress?.(response.progress)
          } catch (error) {
            finish(error)
          }
        } else if (response.type === 'complete') {
          finish(undefined, response.result)
        } else if (response.type === 'error') {
          const error = new Error(response.message)
          error.name = response.name
          finish(error)
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
        type: 'run',
        job: submittedJob,
        handle,
        directory: spools,
      }

      try {
        activeWorker.postMessage(request)
      } catch (error) {
        finish(error)
      }
    })

    checkAbort(settings.signal)
    await removeJob(temporary, 'spools')

    const file = await handle.getFile()
    checkAbort(settings.signal)
    if (file.size === 0) {
      throw new Error('Media Worker produced an empty output.')
    }

    const outputFile = new File(
      [file],
      result.mimeType === 'audio/mp4' ? 'output.m4a' : 'output.mp4',
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
