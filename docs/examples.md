# TypeScript examples

English · [简体中文](./zh/examples.md)

[Documentation](./README.md) · [Core API](./core.md) · [Worker API](./browser.md) · [Storage adapters](./storage.md)

## Save a Worker result

In a browser project with a bundler that supports module Worker URLs, create `remux.worker.ts` alongside `media-jobs.ts`. Use your project's Worker factory if it has a different entry point convention.

```ts
// remux.worker.ts
import { installMediaWorker } from 'media-remux/worker'

installMediaWorker()
```

The browser-side helper below takes a destination file handle supplied by your application. It streams the result to that destination and then cleans up the job directory.

```ts
// media-jobs.ts
import { runMediaJob } from 'media-remux'
import type { MediaJob, MediaJobOptions, RemuxResult } from 'media-remux'

export async function saveMediaJob(
  job: MediaJob,
  destination: FileSystemFileHandle,
  options: Omit<MediaJobOptions, 'createWorker'> = {},
): Promise<RemuxResult> {
  const { file, dispose, ...result } = await runMediaJob(job, {
    ...options,
    createWorker: () =>
      new Worker(new URL('./remux.worker.ts', import.meta.url), {
        type: 'module',
      }),
  })

  try {
    await file.stream().pipeTo(await destination.createWritable())

    return result
  } finally {
    await dispose()
  }
}
```

The destination can be an application-owned OPFS file or a writable file selected by the user. Choose `.m4a` for audio-only jobs and `.mp4` for video. For the returned file name and lifetime, see [`MediaJobResult`](./browser.md#mediajobresult).

## Job examples

Use `File` or `Blob` inputs from your application. The examples use the helper above.

```ts
import { MEDIA_JOB_OPERATION, REMUX_TRACK_SELECTION } from 'media-remux'
import type { MediaJob } from 'media-remux'
import { saveMediaJob } from './media-jobs'

export function remuxFile(input: File, destination: FileSystemFileHandle) {
  return saveMediaJob(
    { operation: MEDIA_JOB_OPERATION.remux, input },
    destination,
  )
}

export function extractAudio(input: File, destination: FileSystemFileHandle) {
  const job = {
    operation: MEDIA_JOB_OPERATION.remux,
    input,
    tracks: REMUX_TRACK_SELECTION.audio,
  } satisfies MediaJob

  return saveMediaJob(job, destination)
}

export function combineRecordings(
  video: File,
  audio: File,
  destination: FileSystemFileHandle,
) {
  return saveMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.combine,
      video,
      audio,
      timeline: 'align-starts',
    },
    destination,
  )
}

export function joinClips(
  inputs: readonly File[],
  destination: FileSystemFileHandle,
) {
  return saveMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.concat,
      inputs,
      tracks: REMUX_TRACK_SELECTION.videoWithOptionalAudio,
      normalizeAudio: true,
    },
    destination,
  )
}
```

For recordings on a shared clock, omit `timeline`. To adjust a track by a known number of seconds, use an offset object such as `{ audioOffset: 0.25 }`. The concatenation example assumes compatible video and WebCodecs audio encoding support. For compatible clips with matching track layouts and audio configuration, omit `normalizeAudio` to copy audio packets. [Timeline options](./core.md#combineoptions-and-combinetimeline) · [Concatenation requirements](./compatibility.md#concatenation-and-audio-normalization)

## Report progress and cancel a job

Pass the signal used by the cancel button and update the status element from the progress callback. This signal covers the Worker job. Saving to the destination starts after the Worker job succeeds.

```ts
import { MEDIA_JOB_OPERATION } from 'media-remux'
import { saveMediaJob } from './media-jobs'

export async function remuxWithProgress(
  input: File,
  destination: FileSystemFileHandle,
  cancelButton: HTMLButtonElement,
  status: HTMLElement,
) {
  const controller = new AbortController()
  const cancel = () => controller.abort()

  cancelButton.addEventListener('click', cancel)

  try {
    return await saveMediaJob(
      { operation: MEDIA_JOB_OPERATION.remux, input },
      destination,
      {
        signal: controller.signal,
        onProgress: ({ phase, bytesProcessed }) => {
          status.textContent = `${phase} · ${bytesProcessed.toLocaleString()} B`
        },
      },
    )
  } catch (error) {
    if (controller.signal.aborted && error === controller.signal.reason) {
      return
    }

    throw error
  } finally {
    cancelButton.removeEventListener('click', cancel)
  }
}
```

This handles the original cancellation reason. A cleanup failure still propagates to the caller. See [error handling](./errors.md#other-failures) and [progress fields](./core.md#remuxprogress).

## Preserve MPEG-TS segment boundaries

Use an `MpegTsInput` descriptor for ordered parts from the same stream. The caller chooses whether to enable continuity-counter resets at the supplied boundaries.

```ts
import type { MpegTsInput } from 'media-remux'

export function describeTransportStream(
  parts: readonly Blob[],
  allowContinuityCounterReset = false,
): MpegTsInput {
  if (parts.length === 0) {
    throw new TypeError('Supply at least one TS segment.')
  }

  let length = 0
  const segmentOffsets = parts.map(part => {
    if (part.size === 0 || part.size % 188 !== 0) {
      throw new TypeError(
        'Each TS segment must be nonempty and packet-aligned.',
      )
    }

    const start = length
    length += part.size

    return start
  })

  return {
    blob: new Blob([...parts], { type: 'video/mp2t' }),
    segmentOffsets,
    allowContinuityCounterReset,
  }
}
```

Use the returned descriptor as a `remux` job's `input`, as one of the inputs to a `combine` job, or with the equivalent core functions. If the parts are already staged into a single OPFS file, supply that file as `blob` along with the offsets recorded during staging. [Boundary validation](./compatibility.md#mpeg-ts-segment-boundaries)

## Use the core API in a Worker

Call this function from your own dedicated Worker. Supply an exclusive OPFS directory for temporary files and an output handle outside that directory, so their lifetimes can be managed independently.

```ts
import { createOpfsStorage, remuxMedia } from 'media-remux'
import type { MediaOutputChunk, RemuxInput } from 'media-remux'

export async function remuxToFile(
  input: RemuxInput,
  output: FileSystemFileHandle,
  spoolDirectory: FileSystemDirectoryHandle,
) {
  const storage = createOpfsStorage(spoolDirectory)

  try {
    const fileStream = await output.createWritable()
    const writable = new WritableStream<MediaOutputChunk>({
      write: chunk => fileStream.write(chunk),
      close: () => fileStream.close(),
      abort: reason => fileStream.abort(reason),
    })

    try {
      return await remuxMedia(input, { writable, storage })
    } catch (error) {
      await writable.abort(error)

      throw error
    }
  } finally {
    await storage.dispose()
  }
}
```

The `abort` in the error path also handles a failure during preflight, when the core API has yet to open the wrapper stream. The caller removes the spool directory after the function settles. [Output lifecycle](./core.md#mediaoutputchunk-and-output-lifecycle) · [OPFS storage](./storage.md#createopfsstorage)

## Implement file adapters in Node

This ESM example copies encoded tracks using Node's file APIs. It opens the input as a file-backed Blob, opens the destination exclusively, and explicitly handles partial positioned writes. Copy mode only needs the core APIs and Web Streams. Use the Node versions supported by the project.

```ts
import { openAsBlob } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDiskFragmentIndex,
  createDiskFragmentSamples,
  remuxMedia,
} from 'media-remux'
import type { MediaOutputChunk } from 'media-remux'

async function openTemporaryFile(path: string) {
  const file = await open(path, 'w+')

  return {
    async read(data: Uint8Array<ArrayBuffer>, position: number) {
      return (await file.read(data, 0, data.length, position)).bytesRead
    },
    async write(data: Uint8Array<ArrayBuffer>, position: number) {
      return (await file.write(data, 0, data.length, position)).bytesWritten
    },
    truncate: (size: number) => file.truncate(size),
    close: () => file.close(),
  }
}

export async function remuxNodeFile(inputPath: string, outputPath: string) {
  const input = await openAsBlob(inputPath)
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-'))
  const fragmentIndex = createDiskFragmentIndex(async trackId => ({
    ...(await openTemporaryFile(join(directory, `${trackId}.index`))),
    seal: () => Promise.resolve(),
  }))
  const fragmentSamples = createDiskFragmentSamples((trackId, kind) =>
    openTemporaryFile(join(directory, `${trackId}-${kind}.bin`)),
  )

  try {
    const output = await open(outputPath, 'wx')

    try {
      await using file = output
      const writable = new WritableStream<MediaOutputChunk>({
        async write({ data, position }) {
          let offset = 0

          while (offset < data.length) {
            const { bytesWritten } = await file.write(
              data,
              offset,
              data.length - offset,
              position + offset,
            )
            if (bytesWritten === 0) {
              throw new Error('Output write made no progress.')
            }
            offset += bytesWritten
          }
        },
      })

      return await remuxMedia(input, {
        writable,
        storage: { fragmentIndex, fragmentSamples },
      })
    } catch (error) {
      await rm(outputPath, { force: true })

      throw error
    }
  } finally {
    try {
      const results = await Promise.allSettled([
        fragmentIndex.dispose(),
        fragmentSamples.dispose(),
      ])
      const failure = results.find(result => result.status === 'rejected')

      if (failure) {
        throw failure.reason
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
```

Positioned Node writes can be read on the same handle after they resolve, so the index's `seal()` can resolve immediately. The `await using` block closes the output handle on exit. The destination path must be unused, and the input file must stay unchanged during the task. [Disk adapter contracts](./storage.md#creatediskfragmentstore)
