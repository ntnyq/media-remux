# Browser Worker API

English · [简体中文](./zh/browser.md)

[Documentation](./README.md) · [Core API](./core.md) · [Worker examples](./examples.md#save-a-worker-result)

## `runMediaJob`

```ts
function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult>
```

Import from `media-remux`. Each call runs one job in a dedicated Worker and creates a unique directory for its output and temporary files. The browser needs a secure context, module Workers, OPFS (Origin Private File System), and synchronous OPFS access handles in a dedicated Worker.

`runMediaJob` terminates the Worker on success, failure, or cancellation. On success it retains the output for the caller to read or save. On failure or cancellation it removes the job directory.

## `MediaJob`

A union discriminated by `operation`. Use [`MEDIA_JOB_OPERATION`](./constants.md#media_job_operation) to construct jobs, or use `satisfies MediaJob` to check a job object.

| `operation` | Required fields                          | Operation-specific optional fields | Core equivalent                            |
| ----------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `'remux'`   | `input: RemuxInput`                      | `tracks?: RemuxTrackSelection`     | [`remuxMedia`](./core.md#remuxmedia)       |
| `'combine'` | `video: RemuxInput`, `audio: RemuxInput` | `timeline?: CombineTimeline`       | [`combineTracks`](./core.md#combinetracks) |
| `'concat'`  | `inputs: readonly Blob[]`                | `tracks?: RemuxTrackSelection`     | [`concatMedia`](./core.md#concatmedia)     |

All operations accept `normalizeAudio?: boolean`, which defaults to `false`. The default `tracks` is `'all'`. Omitting `timeline` preserves relative timestamps. The job captures fields and segment order at submission. [Audio normalization requirements](./compatibility.md#concatenation-and-audio-normalization)

## `MediaJobOptions`

| Field          | Type                                | Description                                                                                                                                                                                          |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorker` | `() => Worker`                      | Required. Return a fresh dedicated Worker whose entry calls `installMediaWorker()`. Each call takes exclusive ownership of its Worker.                                                               |
| `directory`    | `FileSystemDirectoryHandle`         | Optional, defaults to the origin's OPFS root. The library creates a unique job subdirectory, and the caller retains ownership of the parent.                                                         |
| `signal`       | `AbortSignal`                       | Optional. Aborting terminates the Worker, including any synchronous parsing or I/O in progress, and triggers directory cleanup.                                                                      |
| `onProgress`   | `(progress: RemuxProgress) => void` | Optional. Runs on the calling thread. The Worker throttles `remux` notifications to one per 250 ms and sends phase changes immediately. A thrown error fails the job. Returned promises are ignored. |

If structured cloning of filesystem handles throws `DataCloneError`, the library tries reopening the job directory by path from the Worker's OPFS root. A job using a custom parent directory can use this fallback when its directory resolves within that same OPFS root.

## `MediaJobResult`

Extends [`RemuxResult`](./core.md#remuxresult) with two members.

| Member    | Type                  | Description                                                                                                                                             |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | `File`                | `output.mp4` (`video/mp4`) when the result has video, or `output.m4a` (`audio/mp4`) for audio only. Read, play, or save it before disposal.             |
| `dispose` | `() => Promise<void>` | Removes the job directory and output. Concurrent calls share a cleanup attempt. Calls after success are idempotent, and failed deletion can be retried. |

By the time the promise resolves, the Worker has terminated and the temporary stores have been removed. Await `dispose()` in `finally` after consuming the file. If you use an object URL for playback, revoke it after playback before disposing of the result. The application is responsible for directories left by a tab or browser crash.

If cancellation and cleanup succeed, the promise rejects with `signal.reason`. Job errors sent across the Worker boundary retain their name, message, and media code when available. If the job and directory cleanup both fail, the promise rejects with an `AggregateError` containing both failures. [Error handling](./errors.md)

## `installMediaWorker`

```ts
function installMediaWorker(scope?: MediaWorkerScope): () => void
```

Import from `media-remux/worker` and call once in a dedicated Worker entry point. The scope defaults to the Worker's `globalThis`. Each installation accepts one request. An invalid first message also consumes that slot. The handler sends progress while processing, completion after closing temporary stores, and errors after attempting cleanup.

The return value is a synchronous listener removal function. An active job continues running and the parent owns Worker termination. Listener registration errors throw synchronously. Call the installer explicitly to register the listener.

### `MediaWorkerScope`

Use `import type` from `media-remux/worker`. Custom hosts and tests can provide this minimal messaging interface.

| Member                                | Parameters and behavior                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `addEventListener(type, listener)`    | Registers a `'message'` listener of type `(event: MessageEvent<unknown>) => void` synchronously.                                      |
| `removeEventListener(type, listener)` | Removes a listener synchronously using the same event name and function reference.                                                    |
| `postMessage(message)`                | Sends a structured-cloneable progress, completion, or error response. Returns `void`. The parent receives the message asynchronously. |

Applications communicate through `runMediaJob`. A custom host can use `Parameters<MediaWorkerScope['postMessage']>[0]` to reference the response parameter type.
