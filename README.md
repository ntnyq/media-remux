# media-remux

[![CI](https://github.com/ntnyq/media-remux/workflows/CI/badge.svg)](https://github.com/ntnyq/media-remux/actions)
[![NPM VERSION](https://img.shields.io/npm/v/media-remux.svg)](https://www.npmjs.com/package/media-remux)
[![NPM DOWNLOADS](https://img.shields.io/npm/dy/media-remux.svg)](https://www.npmjs.com/package/media-remux)
[![LICENSE](https://img.shields.io/github/license/ntnyq/media-remux.svg)](https://github.com/ntnyq/media-remux/blob/main/LICENSE)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Disk-backed browser media remuxing, track combining, and segment concatenation. The default mode copies encoded packets. The patched Mediabunny source subset is included directly, with no runtime dependencies.

## Features

- `remuxMedia`: MP4/FLV/MKV/MPEG-TS primary tracks → fragmented MP4; select an audio track alone for M4A.
- `combineTracks`: combine supported video and audio from separate files.
- `concatMedia`: join compatible segments in order, checking configurations/timelines before writing output.
- `runMediaJob`: dedicated Worker execution with OPFS, progress, cancellation, and temporary-file cleanup.
- Paged MP4 tables/TFRA/moof records; output descriptors, payloads, and fragment indexes on disk.

Inputs are complete `Blob`/`File` objects. Downloading, authentication, manifests, quality selection, video transcoding, filters, DRM, and frame-accurate video editing remain outside this package.

## Installation

After the first npm release:

```sh
pnpm add media-remux
```

## Browser usage

Create a module Worker entry using your bundler's Worker conventions:

<details>
<summary>Complete example: Worker entry, track combining, audio extraction, and concatenation jobs</summary>

```ts
// remux.worker.ts
import { installMediaWorker } from 'media-remux/worker'

installMediaWorker()
```

```ts
import { MEDIA_JOB_OPERATION, runMediaJob } from 'media-remux'

const controller = new AbortController()
const result = await runMediaJob(
  {
    operation: MEDIA_JOB_OPERATION.combine,
    video: videoFile,
    audio: audioFile,
  },
  {
    createWorker: () =>
      new Worker(new URL('./remux.worker.ts', import.meta.url), {
        type: 'module',
      }),
    signal: controller.signal,
    onProgress: progress => console.log(progress),
  },
)

try {
  await saveFile(result.file) // Your application's save operation.
} finally {
  await result.dispose()
}
```

Other jobs:

```ts
import { MEDIA_JOB_OPERATION, REMUX_TRACK_SELECTION } from 'media-remux'

const audioJob = {
  operation: MEDIA_JOB_OPERATION.remux,
  input: mp4File,
  tracks: REMUX_TRACK_SELECTION.audio,
} as const
const concatJob = {
  operation: MEDIA_JOB_OPERATION.concat,
  inputs: [firstFlv, secondFlv],
} as const
```

</details>

The job owns and terminates its Worker. Use a fresh Worker per call. Cancellation can interrupt synchronous parsing/I/O. Imports do not start jobs or install message listeners automatically. WXT/Vite hosts can use their existing Worker factories; neither framework is required.

Requires a secure context, OPFS, module Workers, and Worker-side synchronous OPFS handles. By default jobs create random subdirectories in the OPFS root. Pass `directory` for an application-owned parent. On browsers that cannot clone OPFS handles, the Worker reopens the job directory relative to its own OPFS root. Success removes spools, retaining output until `dispose()`. Failure/cancellation removes the entire job directory, retrying transient locks. Cleanup errors surface to the caller. Applications must remove abandoned directories after tab/browser crashes.

Consume/save `result.file` before disposing. Audio files have an `.m4a` name and `audio/mp4` MIME type; video files use `.mp4` and `video/mp4`. Disposal is idempotent and failed removal can be retried.

## Core and storage adapters

Core APIs accept a positioned stream and fresh stores. They do not create Workers or remove caller-owned files.

<details>
<summary>Core usage example and custom storage integration</summary>

```ts
import {
  createOpfsStorage,
  REMUX_TRACK_SELECTION,
  remuxMedia,
} from 'media-remux'
import type { MediaOutputChunk } from 'media-remux'

// Inside a dedicated Worker, with a directory exclusive to this job.
const storage = createOpfsStorage(jobDirectory)
const output = await outputHandle.createWritable()
const writable = new WritableStream<MediaOutputChunk>({
  write: chunk => output.write(chunk),
  close: () => output.close(),
  abort: reason => output.abort(reason),
})

try {
  await remuxMedia(inputFile, {
    writable,
    storage,
    signal,
    tracks: REMUX_TRACK_SELECTION.all,
  })
} finally {
  await storage.dispose()
}
// Remove the job directory after consuming its output.
```

`combineTracks(video, audio, options)` and `concatMedia(inputs, options)` use the same storage/output contract. `MediaOutputChunk` is `{ type: 'write', position, data }`. Writes may revisit earlier offsets; append-only sinks are insufficient. Awaited writes/storage operations provide backpressure. Success closes/unlocks the stream; write-stage failure aborts/unlocks it. Preflight failure leaves the supplied stream untouched and caller-owned.

For another runtime, implement positional file I/O for `createDiskFragmentIndex` and `createDiskFragmentSamples`, then pass their stores as `storage.fragmentIndex`/`storage.fragmentSamples`. The adapters retry partial I/O, preserve the first failure, and close all opened handles on disposal. Each job needs new stores. Node positional files are tested, but no Node filesystem adapter is shipped.

</details>

## API reference

All functions below are named exports. Import `installMediaWorker` and its `MediaWorkerScope` type from `media-remux/worker`; import the other functions and types from `media-remux`.

| Export                                 | Purpose                                                          | Returns                                             |
| -------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `runMediaJob(job, options)`            | Run an isolated browser Worker job with managed OPFS files.      | `Promise<MediaJobResult>`                           |
| `remuxMedia(input, options)`           | Copy selected tracks from one MP4/FLV/MKV/MPEG-TS into fMP4/M4A. | `Promise<RemuxResult>`                              |
| `combineTracks(video, audio, options)` | Combine video and audio from separate files.                     | `Promise<RemuxResult>`                              |
| `concatMedia(inputs, options)`         | Join compatible segments in the supplied order.                  | `Promise<RemuxResult>`                              |
| `createOpfsStorage(directory)`         | Create temporary stores for a core job in a dedicated Worker.    | `DisposableRemuxStorage`                            |
| `createDiskFragmentStore(open)`        | Adapt positional files to a per-track byte store.                | Store with `append`, `read`, `reset`, and `dispose` |
| `createDiskFragmentIndex(open)`        | Alias of `createDiskFragmentStore` for fragment indexes.         | Same as `createDiskFragmentStore`                   |
| `createDiskFragmentSamples(open)`      | Adapt positional files to sample/payload/sorting storage.        | `FragmentSampleStore` with `dispose`                |
| `installMediaWorker(scope?)`           | Install the single-job Worker message listener.                  | `() => void`                                        |

<details>
<summary><code>runMediaJob</code> — job variants, options, and output lifecycle</summary>

```ts
function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult>
```

`job` is a discriminated union selected by `operation`. `RemuxInput` accepts a nonempty MP4/FLV/MKV/MPEG-TS `Blob` (including `File`) or an [MPEG-TS segment descriptor](#mpeg-ts-segment-boundaries).

| `operation` | Required fields                          | Optional fields | Behavior                                                                                                |
| ----------- | ---------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `'remux'`   | `input: RemuxInput`                      | `tracks`        | Copy selected primary tracks from one input.                                                            |
| `'combine'` | `video: RemuxInput`, `audio: RemuxInput` | None            | Use only primary video from `video` and primary audio from `audio`.                                     |
| `'concat'`  | `inputs: readonly Blob[]`                | `tracks`        | Join a nonempty list in playback order. Copy mode requires matching layouts and decoder configurations. |

`tracks` defaults to `'all'`, which retains the available primary tracks. `'audio'` and `'video'` require and retain only the selected kind. Use `'video-with-optional-audio'` to require a primary video track in every input and keep its primary audio track when present. Use `'first-video-with-optional-audio'` to select the first video and first available audio in file order, matching FFmpeg's `-map 0:v:0 -map 0:a:0?`. Concat in copy mode requires matching track layouts. Combine jobs select video from the first input and audio from the second.

Set `normalizeAudio: true` on any job to encode the selected audio as one stereo, 48 kHz AAC-LC track. This allows segments with compatible video to have different audio configurations or omit audio. The output fills missing audio with silence, and video packets are copied. The browser must provide WebCodecs AAC encoding and decoding for the selected mono or stereo input. With leading-dependent H.264/MP3 MP4, this mode decodes the MP3 prefix so its bit reservoir is available before cropping the PCM at the retained audio start.

| `options` field | Type                                | Required / default           | Description                                                                                                                                                                     |
| --------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorker`  | `() => Worker`                      | Required                     | Return a fresh dedicated module Worker whose entry calls `installMediaWorker()`. The job terminates it on success, failure, or cancellation; do not share or reuse it.          |
| `directory`     | `FileSystemDirectoryHandle`         | Optional; origin's OPFS root | Parent for a unique `media-remux-…` job directory. The parent itself is retained.                                                                                               |
| `signal`        | `AbortSignal`                       | Optional                     | Abort with an `AbortController`; cancellation terminates the Worker, including synchronous parsing/I/O, and removes the job directory.                                          |
| `onProgress`    | `(progress: RemuxProgress) => void` | Optional                     | Runs on the calling thread. Worker `remux` updates are throttled to 250 ms; phase changes are always reported. A thrown error fails the job; returned promises are not awaited. |

The promise resolves after the Worker has terminated and temporary spools have been removed. The returned `MediaJobResult` includes all `RemuxResult` fields documented below, plus:

| Field     | Type                  | Description                                                                                                                                                                        |
| --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | `File`                | `output.mp4` / `video/mp4` when video exists; otherwise `output.m4a` / `audio/mp4`. Read or save it before disposal.                                                               |
| `dispose` | `() => Promise<void>` | Remove the retained job directory and output. Idempotent after success, shares concurrent attempts, and allows retry after failed removal. Always await it after consuming `file`. |

Failures reject the promise. Worker job errors cross the message boundary as an `Error` preserving its name, message, and any media error code. Cancellation propagates the signal's original abort reason when cleanup succeeds. If the job and directory cleanup both fail, an `AggregateError` contains both errors. Cleanup retries transient filesystem locks; abandoned directories after a browser crash remain the application's responsibility.

</details>

<details>
<summary><code>remuxMedia</code>, <code>combineTracks</code>, and <code>concatMedia</code> — inputs and core options</summary>

```ts
function remuxMedia(
  input: RemuxInput,
  options: RemuxOptions,
): Promise<RemuxResult>

function combineTracks(
  video: RemuxInput,
  audio: RemuxInput,
  options: Omit<RemuxOptions, 'tracks'>,
): Promise<RemuxResult>

function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult>
```

| Argument  | Used by         | Description                                                                                                                                                        |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input`   | `remuxMedia`    | Media `Blob` or MPEG-TS segment descriptor supplying the selected primary tracks.                                                                                  |
| `video`   | `combineTracks` | MP4/FLV/MKV/MPEG-TS input supplying the primary video track; any audio in this input is ignored.                                                                   |
| `audio`   | `combineTracks` | MP4/FLV/MKV/MPEG-TS input supplying primary audio; any video in this input is ignored.                                                                             |
| `inputs`  | `concatMedia`   | Nonempty array of complete MP4/FLV/MKV/MPEG-TS inputs in playback order. Compatibility and timing are checked for every selected segment before output is written. |
| `options` | All three       | Output stream, fresh stores, and optional hooks described below.                                                                                                   |

| `RemuxOptions` field | Type                                | Required / default | Description                                                                                                                                                |
| -------------------- | ----------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`           | `WritableStream<MediaOutputChunk>`  | Required           | Must support absolute positioned writes, including revisiting earlier offsets. Awaited writes apply backpressure.                                          |
| `storage`            | `RemuxStorage`                      | Required           | Fresh, job-exclusive `fragmentIndex` and `fragmentSamples` stores. The caller disposes them in `finally` after success, failure, or cancellation.          |
| `tracks`             | `RemuxTrackSelection`               | Optional; `'all'`  | Select primary track kinds for remux/concat. Unsupported for `combineTracks`, which always selects one video and one audio track.                          |
| `normalizeAudio`     | `boolean`                           | Optional; `false`  | Encode selected mono or stereo audio as continuous 48 kHz stereo AAC-LC via WebCodecs. The encoded audio is spooled before muxing.                         |
| `signal`             | `AbortSignal`                       | Optional           | Checked during inspection, packet copying, and storage operations. Rejection uses the original abort reason.                                               |
| `onProgress`         | `(progress: RemuxProgress) => void` | Optional           | Synchronous notifications in the core API's execution context, without Worker throttling. Throwing fails the operation; returned promises are not awaited. |

These APIs return a summary, not a `File`. The caller owns the output destination and temporary files. Successful processing closes/unlocks `writable`; write-stage failure aborts/unlocks it. Preflight failure leaves the supplied stream untouched, so the caller must close or abort it as needed. Cancellation can stop the job until the output stream starts closing. Once closing starts, the stream's commit result determines the outcome. Store disposal closes handles but does not remove files.

Remux and combine normalize the earliest playable timestamp to zero, preserving relative A/V offsets. Concat places each normalized segment after the preceding presentation end. H.264 MP4 with leading dependent frames starts at the first sync sample verified to contain an IDR picture. Whole audio packets with presentation timestamps before that picture are discarded. Copy mode rejects a cut where the first retained MP3 frame needs the discarded data. Use `normalizeAudio: true` for such cuts. Missing tracks, incompatible segment configurations, malformed media or timing, and video without a usable keyframe at the start of the retained segment reject the promise. I/O and callback errors also propagate.

</details>

<details>
<summary>Shared types — <code>RemuxResult</code>, <code>RemuxProgress</code>, <code>MediaOutputChunk</code>, and storage</summary>

`RemuxResult` is returned by all core operations and inherited by `MediaJobResult`.

| Field            | Type                         | Meaning                                                                                                                                                |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bytesProcessed` | `number`                     | Total encoded payload bytes written, excluding container headers and indexes.                                                                          |
| `duration`       | `number`                     | Output presentation span in seconds, from the first playable timestamp to the latest selected packet end. Concatenation sums normalized segment spans. |
| `mimeType`       | `'video/mp4' \| 'audio/mp4'` | Video MIME type whenever a video track exists; audio MIME type otherwise.                                                                              |

`RemuxProgress` is passed to `onProgress`:

| Field            | Type                                 | Meaning                                                                                                                                                                        |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`          | `'inspect' \| 'remux' \| 'finalize'` | Validate inputs/timing, copy encoded packets, then finish container metadata.                                                                                                  |
| `bytesProcessed` | `number`                             | Cumulative encoded payload bytes written. Zero during inspection.                                                                                                              |
| `segmentIndex`   | `number`                             | Zero-based segment index during inspection/copying. During finalization, the number of segments already written; normally `1` for remux/combine or `inputs.length` for concat. |

`MediaOutputChunk` describes one absolute output write:

| Field      | Type                      | Meaning                                                            |
| ---------- | ------------------------- | ------------------------------------------------------------------ |
| `type`     | `'write'`                 | Positioned filesystem write operation.                             |
| `position` | `number`                  | Absolute destination offset in bytes; positions need not increase. |
| `data`     | `Uint8Array<ArrayBuffer>` | Container bytes to write at `position`.                            |

`RemuxStorage` requires `fragmentIndex: FragmentIndexStore` for completed-fragment TFRA records and `fragmentSamples: FragmentSampleStore` for descriptors, payloads, and timestamp sorting. `DisposableRemuxStorage` extends it with `dispose(): Promise<void>`, which attempts both store disposals even if one fails and rejects with the first rejected result. Directory removal is separate.

</details>

<details>
<summary><code>installMediaWorker</code> — Worker entry and optional messaging scope</summary>

```ts
// Import from 'media-remux/worker'.
function installMediaWorker(scope?: MediaWorkerScope): () => void
```

`scope` defaults to the Worker's `globalThis`. Custom hosts/tests can supply a `MediaWorkerScope` implementing `addEventListener('message', listener)`, `removeEventListener('message', listener)`, and `postMessage(message)` for protocol responses.

Call once in each dedicated Worker entry. One job is accepted per installation; subsequent messages are ignored, and an invalid first request also consumes the slot. Progress is posted during processing; completion is reported after stores close, and serialized errors are reported after cleanup is attempted. Importing `media-remux/worker` alone does not register a listener.

The returned synchronous function unregisters the message listener. It does not cancel running work or terminate the Worker; `runMediaJob` owns termination. Listener-registration failures throw synchronously; asynchronous processing failures are reported through Worker messages.

</details>

<details>
<summary><code>createOpfsStorage</code> — directory, lazy files, and disposal</summary>

```ts
function createOpfsStorage(
  directory: FileSystemDirectoryHandle,
): DisposableRemuxStorage
```

`directory` is required and must be reserved exclusively for one job's temporary files. Use a dedicated Worker with OPFS synchronous access handles. The function returns immediately without I/O; stores open/truncate files lazily, and later operations propagate unsupported-access, validation, quota, and I/O errors.

The result contains `fragmentIndex`, `fragmentSamples`, and `dispose()`. Create a new instance for each core job. Await disposal in `finally`, then remove the temporary files/directory yourself. Disposal attempts both stores, closes handles, and leaves the directory and file entries in place. Keep output outside the temporary directory if you plan to remove that directory before consuming it.

</details>

<details>
<summary><code>createDiskFragmentStore</code> / <code>createDiskFragmentIndex</code> — opener and byte-store contract</summary>

```ts
function createDiskFragmentStore(
  open: (trackId: number) => Promise<FragmentStoreFile>,
): FragmentStore & {
  reset: (trackId: number) => Promise<void>
  dispose: () => Promise<void>
}

// createDiskFragmentIndex is an alias with the same signature and behavior.
```

`open` is required. It opens a distinct logical file for each integer `trackId` in `1…0xffffffff` and must truncate that file on every open, including reopening after `reset`. Opening is lazy. `FragmentIndexFile` aliases `FragmentStoreFile`, and `FragmentIndexStore` aliases `FragmentStore`.

| `FragmentStoreFile` method               | Contract                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write(data, position): Promise<number>` | Write bytes at an absolute offset before sealing. Return the actual written count; partial writes are retried. Keep `data` stable until completion. |
| `read(data, position): Promise<number>`  | Fill the destination buffer from an absolute offset after sealing. Return actual bytes read; partial reads are retried.                             |
| `seal(): Promise<void>`                  | Commit pending writes and make the file stably readable. No further writes until reset/reopen.                                                      |
| `close(): Promise<void>`                 | Release resources and discard uncommitted writes. File removal remains caller-owned.                                                                |

| Returned method                 | Parameters and result                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, data)`         | Append `Uint8Array` bytes; returns `Promise<void>`. Keep the source stable until completion.                                                                                                    |
| `read(trackId, offset, length)` | Read an appended range; `offset` is a nonnegative safe integer and `length` is `0…65536`. Returns `Promise<Uint8Array<ArrayBuffer>>` of exactly `length` bytes. The first read seals the track. |
| `reset(trackId)`                | Close/forget the track so later access opens a new empty logical file; unknown IDs are ignored. Returns `Promise<void>`.                                                                        |
| `dispose()`                     | Stop new work, drain queued work, discard buffered bytes, and attempt every open file's closure. Idempotent; returns `Promise<void>`.                                                           |

Operations are serialized and must be awaited. Invalid ranges/IDs and incomplete reads fail; appending after sealing or using a disposed store fails with `InvalidStateError`. A nonempty I/O operation must make positive progress. The first operation failure poisons later queued work; disposal still attempts every close. Use `createDiskFragmentIndex(open)` as `storage.fragmentIndex`; the generic byte store alone does not satisfy `storage.fragmentSamples`.

</details>

<details>
<summary><code>createDiskFragmentSamples</code> — file kinds, sample fields, and store methods</summary>

```ts
function createDiskFragmentSamples(
  open: (
    trackId: number,
    kind: 'records' | 'media' | 'sort-a' | 'sort-b',
  ) => Promise<FragmentSampleFile>,
): FragmentSampleStore & { dispose: () => Promise<void> }
```

`open` is required and must return a distinct positional file for each `(trackId, kind)` pair. Track IDs are integers in `1…0xffffffff`. A track opens `records` and `media` when first used, and opens `sort-a` and `sort-b` only when it needs external sorting. The adapter truncates each file to zero when it opens it.

| `FragmentSampleFile` method | Return type                 | Contract                                                                                        |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `read(data, position)`      | `number \| Promise<number>` | Fill `Uint8Array<ArrayBuffer>` from an absolute byte offset; return actual read count.          |
| `write(data, position)`     | `number \| Promise<number>` | Write at an absolute byte offset without truncating unrelated bytes; return actual write count. |
| `truncate(size)`            | `void \| Promise<void>`     | Resize in bytes; zero clears the file.                                                          |
| `close()`                   | `void \| Promise<void>`     | Release the file handle and locks.                                                              |

Partial reads/writes are retried; a nonempty operation must make positive progress. Keep write buffers stable until completion. The interface accepts synchronous I/O for dedicated Worker handles as well as asynchronous I/O for other runtimes.

`FragmentSample` describes one encoded sample:

| Field                        | Type / unit                     | Constraints                                                                                       |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `timestamp`                  | `number`, seconds               | Finite PTS; may be negative.                                                                      |
| `decodeTimestamp`            | `number`, seconds               | Finite DTS; may be negative.                                                                      |
| `duration`                   | `number`, seconds               | Finite and nonnegative.                                                                           |
| `size`                       | `number`, bytes                 | Integer `0…0xffffffff`; must equal payload length on append.                                      |
| `type`                       | `'key' \| 'delta'`              | Independently decodable or dependent sample.                                                      |
| `timescaleUnitsToNextSample` | `number`, track timescale units | Nonnegative safe integer; may be refined as subsequent samples arrive.                            |
| `mediaOffset`                | `number`, bytes                 | Nonnegative safe integer logical payload offset, assigned by append and stable across compaction. |

| `FragmentSampleStore` method         | Parameters and result                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, sample, data)`      | `sample` omits `mediaOffset`; `data` is a `Uint8Array`. Returns a track-local sample ID starting at zero; IDs increase and are not reused after release.                                                                                              |
| `get(trackId, id)`                   | Return a retained sample's `FragmentSample` descriptor.                                                                                                                                                                                               |
| `set(trackId, id, sample)`           | Update the descriptor without rewriting payload. Keep the original payload size and offset. Released IDs are ignored by disk stores.                                                                                                                  |
| `sort(trackId, start, count)`        | Prepare ascending PTS for a retained sample range; `count` is a positive integer. Replaces previous sort results without changing sample IDs or decode order.                                                                                         |
| `sorted(trackId, index)`             | Return the timestamp in seconds at a zero-based position in the latest sort result.                                                                                                                                                                   |
| `readMedia(trackId, offset, length)` | Read retained payload at a logical byte offset; `length` is `0…65536`. Return exactly that many bytes.                                                                                                                                                |
| `release(trackId, before)`           | Release sample IDs strictly below `before` and their payload. The boundary ranges from the first retained ID through the next append ID, inclusive. Compact files, preserve surviving IDs/offsets, and clear sort results when the boundary advances. |

The interface allows immediate values or promises (`void` or `Promise<void>` for mutations); the disk adapter returns promises. Always await operations and keep append payloads stable until completion. Its additional `dispose()` stops new work, drains queued operations, discards buffers, and attempts to close every file. Disposal is idempotent and rejects on a close failure; file deletion remains caller-owned. Invalid samples/ranges, use after disposal, or I/O failures reject; the first operation failure poisons subsequent work.

Pass this adapter as `storage.fragmentSamples` alongside a fresh `createDiskFragmentIndex(openIndex)` as `storage.fragmentIndex`. No Node filesystem adapter is shipped.

</details>

## Media errors

Use `isRemuxError(error)` from `media-remux` to narrow an error thrown by a core API or `runMediaJob` to `RemuxError`. Branch on `error.code` for fallback or localization. The message provides diagnostics.

| Code                        | Meaning                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `UNSUPPORTED_CONTAINER`     | The input container is unsupported or unrecognizable.                                                                          |
| `UNSUPPORTED_CODEC`         | A selected track uses an unsupported codec or profile.                                                                         |
| `UNSUPPORTED_MEDIA_FEATURE` | A recognized media feature exceeds the remuxer's capabilities, such as some MP4 edit lists or an AV1 gap before a delta frame. |
| `INCOMPATIBLE_SEGMENTS`     | The selected track layouts or decoder configurations differ between segments.                                                  |
| `INVALID_INPUT`             | A media validation check found malformed data, such as a truncated box or invalid packet timing.                               |
| `MISSING_REQUIRED_TRACK`    | An input lacks a track required by the operation or selection.                                                                 |

I/O, quota, cancellation, callback, and Worker infrastructure failures follow their existing error paths. For a compatibility fallback, allow only the codes the alternate backend can handle.

## Timeline and compatibility

<details>
<summary>Track limits, segment compatibility, and timestamp rules</summary>

- Remux and concat use primary tracks by default and offer file-order selection through `tracks`. Combine selects the primary video from the first input and the primary audio from the second.
- MP4 supports H.264, HEVC (`hvc1` and `hev1`), AV1 (`av01`), AAC, MP3, and AC-3 (`ac-3`). FLV supports standard AVC, AAC-LC with 960/1024-sample frames, and MP3 with complete Layer III frames at a signaled bitrate. HE-AAC/SBR (including implicit signaling), unsupported/encrypted FLV tags, and mid-stream decoder configuration changes are rejected. A selected MP4 track must have a single sample description and use media stored in the input file.
- MKV accepts one Matroska segment with selected H.264 and/or AAC-LC tracks and standard `CodecPrivate`. AAC lacing is supported. Selected tracks with content encodings or legacy offsets, laced video, video cropping, and blocks with codec changes, additions, or nonzero discard padding are rejected.
- MPEG-TS accepts a single program with 188-byte packets, Annex B H.264 starting at an IDR with SPS/PPS, and AAC-LC in ADTS. The reader preserves the shared audio and video clock through 33-bit timestamp rollover. Video is written as `avc3` with in-band parameter sets.
- MPEG-TS primary tracks prefer supported formats. File-order selection uses the first recognized video and audio entries in the program map. Selecting a recognized track with an unsupported codec returns `UNSUPPORTED_CODEC`.
- For consecutive TS downloads on one timeline with the same track PIDs and continuous transport counters, pass `new Blob(parts)` to `remuxMedia`. An internal part boundary can start on a dependent picture or fall within an access unit. Program changes and timestamp resets require external handling.
- AC-3 tracks require a valid `dac3` box, whose payload is copied to the output. Playback requires a browser with AC-3 decoding support. A 5.1-channel sample played with audio in Safari 27.0.1 on macOS.
- Chrome supports direct `<video src>` playback of H.264/MP3 MP4 files. MP3 support in MP4 varies by browser and playback API.
- HEVC and AV1 MP4 tracks require their codec configuration boxes (`hvcC` or `av1C`). The output preserves their sample entry type and configuration bytes.
- AV1 uses the same timestamp for decoding and presentation. Delayed video starts and gaps followed by a keyframe use the fragment's `tfdt` timestamp, preserving the gap without adding or extending video frames. Overlaps and gaps before a delta frame are rejected during preflight.
- MP4 edit lists support leading empty edits followed by a single media edit at rate 1. Audio starts at the edit's playable position. Copy mode drops complete audio packets before the edit. The first segment can retain an intersecting packet and hide its trimmed portion with an output edit. An edit that starts inside an audio packet in a later segment requires `normalizeAudio: true`. A tail edit can shorten the final presented video frame. Audio tail edits discard packets wholly outside the edit and shorten the final intersecting packet while retaining its payload. Selected tracks fail preflight for empty-only lists, additional edits after the media edit, non-unit rates, video prefix trims, and edits that exclude an entire video sample. A zero-duration media edit remains open-ended. Movie-timescale rounding is tolerated.
- Multiple track fragments (`traf`) for the same track within one `moof` are rejected during preflight instead of silently dropping packets.
- Jobs capture the submitted segment list and top-level job/options fields. Later changes to the caller's arrays or option fields do not alter an active job; the referenced signal and storage resources remain live.
- Selected encrypted MP4 tracks are rejected during preflight, including unsupported encryption schemes or missing sample encryption metadata. Unselected protected tracks can be discarded.
- Selected segments must match track layouts, codec strings, decoder-description bytes, dimensions/aspect/color configuration, sample rate/channel count, and video transformation. Each retained video segment starts with a keyframe. Matching is strict and can reject files needing normalization.
- MP4 numeric color identifiers from nclx or nclc and MKV Colour fields representable in nclx are carried into the output and used to compare segments.
- Video sample aspect ratios remain exact across repeated remuxes. Compatibility compares reduced display aspect ratios, so proportional display dimensions match. Explicit MP4 `pasp` signaling takes precedence over SPS metadata regardless of box order.
- Each segment's earliest playable timestamp becomes the preceding segment's presentation end, preserving internal A/V offsets and gaps. Single remux/combine normalize the earliest playable timestamp to zero. Codec delay and padding may remain where the input does not provide an edit. Gapless audio is not guaranteed.
- Packet order stays decode order. B-frame PTS is not sorted before copying. Output timestamps round to their container timescale.
- Preflight plans each track's decode lead across all segments. Output uses nonnegative composition offsets and media edits to preserve the shared presentation origin in players; header durations include the complete presentation tail.
- Sample durations and nonnegative composition offsets must fit unsigned 32-bit output track units. Values outside these ranges reject the operation instead of wrapping.
- FLV DTS must increase within a track; rollover/discontinuities require separate segments. Video duration comes from the next DTS/end marker; the final frame uses the previous interval, or 1/30 second for a lone frame without an end marker. AAC duration comes from its configuration. MP3 sample rate, channel count, and frame duration come from the MPEG audio header. A tag timestamps its first MP3 frame, and additional frames use successive frame durations.
- MKV block timestamps carry PTS. The output keeps decode order and applies the track timestamp scale and codec delay. Video uses block or track duration when declared. Missing durations use the final PTS interval, or 1/30 second with no such interval. AAC decode durations come from its configuration.
- Progress phases are `inspect`, `remux`, and `finalize`. `bytesProcessed` counts encoded payload, excluding container overhead. Worker packet progress is throttled to 250 ms; phase transitions always report. Inspection scans timing metadata before output is created.

</details>

### MPEG-TS segment boundaries

To remux HLS segments written in order into one TS file, record each segment's starting byte offset as you write it. Pass the file and offsets to `remuxMedia`, either input of `combineTracks`, or the corresponding Worker job.

```ts
const input = {
  blob: await tsFileHandle.getFile(),
  segmentOffsets,
  allowContinuityCounterReset: true,
} satisfies MpegTsInput
```

Offsets start at zero, strictly increase, align to 188-byte TS packets, and fall before the end of the file. The opt-in allows a counter jump on a PID's first payload in each later segment when it begins a valid PES and the previous PES passes its completeness check. The whole input uses one timeline, preserving the source PTS/DTS relationship, A/V offsets, and gaps with the usual output normalization to zero.

Plain Blobs and descriptors without the opt-in use strict continuity checking. In-segment jumps, jumps on PES continuations, and detectable PES truncation still fail. Packet-level errors on descriptor inputs include the zero-based segment index, PID, and absolute byte offset. A whole packet missing exactly where a reset is allowed can be indistinguishable from a legitimate reset when the next visible packet begins a valid PES. Detecting that case requires external integrity information such as a trusted segment length or checksum.

## Memory, disk, and performance

<details>
<summary>Memory and disk usage, and performance measurement</summary>

Input tables/indexes are paged and padding is skipped by range. Output uses two 56 KiB descriptor pages and one 64 KiB media write page per track, a fixed sorting buffer, bounded external-sort pages, and paged fragment indexes. Completed prefixes are compacted; files are reused. MP4 Blob sources have a 4 MiB cache per input. Output writes are at most 1 MiB.

These are bounds on specific structures, not constant total memory or a process-peak guarantee. Individual packets, codec/metadata boxes, source caches, track count, caller inputs, and runtime overhead have separate costs. Long GOPs use temporary disk/sorting I/O. OPFS must accommodate inputs, output, and spools; actual quota/I/O errors are authoritative. There is no arbitrary maximum file size or disk-space reservation.

Copy-mode throughput depends on payload size, packet count, metadata scans, GOP shape, and storage. Audio normalization adds a decode, resample, and encode pass and uses an additional temporary audio spool. Use `tests/browser/benchmark.html` to measure real OPFS/Worker timing for selected local files; input loading is excluded and startup, inspection, copying, and finalization are included. Results are machine/browser-specific. See the [measured baseline](./docs/performance.md).

</details>

## Development

<details>
<summary>Development commands, test coverage, and browser checks</summary>

```sh
pnpm install
pnpm release:check
pnpm build
pnpm pack --dry-run
```

Tests cover real byte-preserving output, B frames/AAC pre-roll, malformed FLV/MKV, AAC lacing, cancellation/I/O failures, sparse >4 GiB MP4, regular/TFRA/moof paging, partial disk I/O, sorting, and cleanup failures. If installed, FFmpeg independently decodes real outputs.

Run `pnpm build` and `pnpm test:browser` on macOS with Google Chrome installed to run the same Worker, OPFS, playback, and native AAC checks as CI. To run interactively, serve the repository with a local static server and open `tests/browser/index.html`. `tests/browser/benchmark.html` measures selected files serially over three rounds.

Vendored code retains upstream notices and independent formatting; it remains fully checked by strict TypeScript. See [migration notes](./src/vendor/mediabunny/MIGRATION.md) and [third-party notices](./THIRD_PARTY_NOTICES.md).

</details>

## License

Original code: [MIT](./LICENSE), © 2026-PRESENT ntnyq. Included Mediabunny-derived files: [MPL-2.0](./src/vendor/mediabunny/LICENSE), © 2026-present Vanilagy and contributors. Both notices and the exact modified MPL source subset ship in the npm package.
