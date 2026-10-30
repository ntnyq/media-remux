# media-remux

[English](./README.md) | [简体中文](./README.zh-CN.md)

Disk-backed browser media remuxing, track combining, and segment concatenation without re-encoding. No runtime dependencies; the required patched Mediabunny source subset is included directly.

## Features

- `remuxMedia`: MP4/FLV primary H.264/AAC tracks → fragmented MP4; select AAC alone for M4A.
- `combineTracks`: combine H.264 video and AAC audio from separate files.
- `concatMedia`: join compatible segments in order, checking configurations/timelines before writing output.
- `runMediaJob`: dedicated Worker execution with OPFS, progress, cancellation, and temporary-file cleanup.
- Paged MP4 tables/TFRA/moof records; output descriptors, payloads, timestamp sorting, and fragment indexes on disk.

Inputs are complete `Blob`/`File` objects. Downloading, authentication, manifests, quality selection, transcoding, filters, DRM, and frame-accurate editing remain outside this package.

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
import { runMediaJob } from 'media-remux'

const controller = new AbortController()
const result = await runMediaJob(
  { operation: 'combine', video: videoFile, audio: audioFile },
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
const audioJob = {
  operation: 'remux',
  input: mp4File,
  tracks: 'audio',
} as const
const concatJob = {
  operation: 'concat',
  inputs: [firstFlv, secondFlv],
} as const
```

</details>

The job owns and terminates its Worker. Use a fresh Worker per call. Cancellation can interrupt synchronous parsing/I/O. Imports do not start jobs or install message listeners automatically. WXT/Vite hosts can use their existing Worker factories; neither framework is required.

Requires a secure context, OPFS, module Workers, and Worker-side synchronous OPFS handles. By default jobs create random subdirectories in the OPFS root; pass `directory` for an application-owned parent. Success removes spools, retaining output until `dispose()`. Failure/cancellation removes the entire job directory, retrying transient locks. Cleanup errors surface to the caller. Applications must remove abandoned directories after tab/browser crashes.

Consume/save `result.file` before disposing. Audio files have an `.m4a` name and `audio/mp4` MIME type; video files use `.mp4` and `video/mp4`. Disposal is idempotent and failed removal can be retried.

## Core and storage adapters

Core APIs accept a positioned stream and fresh stores. They do not create Workers or remove caller-owned files.

<details>
<summary>Core usage example and custom storage integration</summary>

```ts
import { createOpfsStorage, remuxMedia } from 'media-remux'
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
  await remuxMedia(inputFile, { writable, storage, signal, tracks: 'all' })
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

| Export                                 | Purpose                                                       | Returns                                             |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `runMediaJob(job, options)`            | Run an isolated browser Worker job with managed OPFS files.   | `Promise<MediaJobResult>`                           |
| `remuxMedia(input, options)`           | Copy selected tracks from one MP4/FLV into fMP4/M4A.          | `Promise<RemuxResult>`                              |
| `combineTracks(video, audio, options)` | Combine video and audio from separate files.                  | `Promise<RemuxResult>`                              |
| `concatMedia(inputs, options)`         | Join compatible segments in the supplied order.               | `Promise<RemuxResult>`                              |
| `createOpfsStorage(directory)`         | Create temporary stores for a core job in a dedicated Worker. | `DisposableRemuxStorage`                            |
| `createDiskFragmentStore(open)`        | Adapt positional files to a per-track byte store.             | Store with `append`, `read`, `reset`, and `dispose` |
| `createDiskFragmentIndex(open)`        | Alias of `createDiskFragmentStore` for fragment indexes.      | Same as `createDiskFragmentStore`                   |
| `createDiskFragmentSamples(open)`      | Adapt positional files to sample/payload/sorting storage.     | `FragmentSampleStore` with `dispose`                |
| `installMediaWorker(scope?)`           | Install the single-job Worker message listener.               | `() => void`                                        |

<details>
<summary><code>runMediaJob</code> — job variants, options, and output lifecycle</summary>

```ts
function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult>
```

`job` is a discriminated union selected by `operation`. Inputs must be complete, nonempty MP4/FLV `Blob` objects; `File` is also accepted because it extends `Blob`.

| `operation` | Required fields              | Optional fields | Behavior                                                                                        |
| ----------- | ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `'remux'`   | `input: Blob`                | `tracks`        | Copy selected primary tracks from one input.                                                    |
| `'combine'` | `video: Blob`, `audio: Blob` | None            | Use only primary H.264 video from `video` and primary AAC audio from `audio`.                   |
| `'concat'`  | `inputs: readonly Blob[]`    | `tracks`        | Join a nonempty list in playback order; selected layouts and decoder configurations must match. |

`tracks` is `'all'`, `'audio'`, or `'video'`, defaulting to `'all'`. `'all'` retains the available supported primary tracks; it does not require both audio and video. An explicit selection with no matching track fails. Combine jobs do not accept `tracks`.

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

Failures reject the promise. Worker job errors cross the message boundary as an `Error` preserving its name/message. Cancellation propagates the signal's original abort reason when cleanup succeeds. If the job and directory cleanup both fail, an `AggregateError` contains both errors. Cleanup retries transient filesystem locks; abandoned directories after a browser crash remain the application's responsibility.

</details>

<details>
<summary><code>remuxMedia</code>, <code>combineTracks</code>, and <code>concatMedia</code> — inputs and core options</summary>

```ts
function remuxMedia(input: Blob, options: RemuxOptions): Promise<RemuxResult>

function combineTracks(
  video: Blob,
  audio: Blob,
  options: Omit<RemuxOptions, 'tracks'>,
): Promise<RemuxResult>

function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult>
```

| Argument  | Used by         | Description                                                                                                                                            |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input`   | `remuxMedia`    | One complete, nonempty MP4/FLV `Blob` or `File`; selected primary tracks are copied without re-encoding.                                               |
| `video`   | `combineTracks` | MP4/FLV input supplying primary H.264 video; any audio in this input is ignored.                                                                       |
| `audio`   | `combineTracks` | MP4/FLV input supplying primary AAC audio; any video in this input is ignored.                                                                         |
| `inputs`  | `concatMedia`   | Nonempty array of complete MP4/FLV inputs in playback order. Compatibility and timing are checked for every selected segment before output is written. |
| `options` | All three       | Output stream, fresh stores, and optional hooks described below.                                                                                       |

| `RemuxOptions` field | Type                                | Required / default | Description                                                                                                                                                |
| -------------------- | ----------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`           | `WritableStream<MediaOutputChunk>`  | Required           | Must support absolute positioned writes, including revisiting earlier offsets. Awaited writes apply backpressure.                                          |
| `storage`            | `RemuxStorage`                      | Required           | Fresh, job-exclusive `fragmentIndex` and `fragmentSamples` stores. The caller disposes them in `finally` after success, failure, or cancellation.          |
| `tracks`             | `'all' \| 'audio' \| 'video'`       | Optional; `'all'`  | Select primary track kinds for remux/concat. Unsupported for `combineTracks`, which always selects one video and one audio track.                          |
| `signal`             | `AbortSignal`                       | Optional           | Checked during inspection, packet copying, and storage operations. Rejection uses the original abort reason.                                               |
| `onProgress`         | `(progress: RemuxProgress) => void` | Optional           | Synchronous notifications in the core API's execution context, without Worker throttling. Throwing fails the operation; returned promises are not awaited. |

These APIs return a summary, not a `File`. The caller owns the output destination and temporary files. Successful processing closes/unlocks `writable`; write-stage failure aborts/unlocks it. Preflight failure leaves the supplied stream untouched, so the caller must close or abort it as needed. Store disposal closes handles but does not remove files.

Remux and combine normalize the earliest selected presentation timestamp to zero, preserving relative A/V offsets. Concat places each normalized segment after the preceding presentation end. Missing tracks, incompatible segment configurations, malformed media/timing, or video without an initial keyframe reject the promise. I/O and callback errors also propagate.

</details>

<details>
<summary>Shared types — <code>RemuxResult</code>, <code>RemuxProgress</code>, <code>MediaOutputChunk</code>, and storage</summary>

`RemuxResult` is returned by all core operations and inherited by `MediaJobResult`.

| Field            | Type                         | Meaning                                                                                                                                             |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bytesProcessed` | `number`                     | Total copied encoded payload bytes, excluding container headers and indexes. This is not output file size.                                          |
| `duration`       | `number`                     | Output presentation span in seconds, from the earliest selected PTS to the latest selected packet end. Concatenation sums normalized segment spans. |
| `mimeType`       | `'video/mp4' \| 'audio/mp4'` | Video MIME type whenever a video track exists; audio MIME type otherwise.                                                                           |

`RemuxProgress` is passed to `onProgress`:

| Field            | Type                                 | Meaning                                                                                                                                                                        |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`          | `'inspect' \| 'remux' \| 'finalize'` | Validate inputs/timing, copy encoded packets, then finish container metadata.                                                                                                  |
| `bytesProcessed` | `number`                             | Cumulative copied payload bytes; zero during inspection. It excludes container overhead and has no total/percentage field.                                                     |
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

`open` is required and must return a distinct positional file for each `(trackId, kind)` pair. Track IDs are integers in `1…0xffffffff`. Each track lazily opens all four kinds and the adapter truncates them to zero: `records` holds descriptors, `media` holds encoded payload, and `sort-a`/`sort-b` are external-sort scratch files.

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
| `set(trackId, id, sample)`           | Update the descriptor without rewriting payload. Keep payload size/offset references valid. Released IDs are ignored by disk stores.                                                                                                                  |
| `sort(trackId, start, count)`        | Prepare ascending PTS for a retained sample range; `count` is a positive integer. Replaces previous sort results without changing sample IDs or decode order.                                                                                         |
| `sorted(trackId, index)`             | Return the timestamp in seconds at a zero-based position in the latest sort result.                                                                                                                                                                   |
| `readMedia(trackId, offset, length)` | Read retained payload at a logical byte offset; `length` is `0…65536`. Return exactly that many bytes.                                                                                                                                                |
| `release(trackId, before)`           | Release sample IDs strictly below `before` and their payload. The boundary ranges from the first retained ID through the next append ID, inclusive. Compact files, preserve surviving IDs/offsets, and clear sort results when the boundary advances. |

The interface allows immediate values or promises (`void` or `Promise<void>` for mutations); the disk adapter returns promises. Always await operations and keep append payloads stable until completion. Its additional `dispose()` stops new work, drains queued operations, discards buffers, and attempts to close every file. Disposal is idempotent and rejects on a close failure; file deletion remains caller-owned. Invalid samples/ranges, use after disposal, or I/O failures reject; the first operation failure poisons subsequent work.

Pass this adapter as `storage.fragmentSamples` alongside a fresh `createDiskFragmentIndex(openIndex)` as `storage.fragmentIndex`. No Node filesystem adapter is shipped.

</details>

## Timeline and compatibility

<details>
<summary>Track limits, segment compatibility, and timestamp rules</summary>

- Only primary tracks are used. Remux/concat accept `tracks: 'all' | 'audio' | 'video'` (default `all`). Combine selects video from its first input and audio from its second.
- MP4 supports H.264/AAC. FLV supports standard AVC and AAC-LC, including 960/1024-sample AAC frames. HE-AAC/SBR (including implicit signaling), unsupported/encrypted FLV tags, multiple MP4 sample descriptions, and changing FLV sequence headers are rejected.
- MP4 edit lists support leading empty edits followed by a single media edit at rate 1. Empty-only lists, additional edits after the media edit, non-unit media rates, video prefix edits hiding whole frames, and finite media edits that trim a sample's presentation end are rejected during preflight instead of silently changing playback. A zero-duration media edit remains open-ended; movie-timescale rounding is tolerated.
- Multiple track fragments (`traf`) for the same track within one `moof` are rejected during preflight instead of silently dropping packets.
- Jobs capture the submitted segment list and top-level job/options fields. Later changes to the caller's arrays or option fields do not alter an active job; the referenced signal and storage resources remain live.
- Selected encrypted MP4 tracks are rejected during preflight, including unsupported encryption schemes or missing sample encryption metadata. Unselected protected tracks can be discarded.
- Selected segments must match track layouts, codec strings, decoder-description bytes, dimensions/aspect/color configuration, sample rate/channel count, and video transformation. Every video segment must start with a keyframe. Matching is strict and can reject files needing normalization.
- Video sample aspect ratios remain exact across repeated remuxes. Compatibility compares reduced display aspect ratios, so proportional display dimensions match. Explicit MP4 `pasp` signaling takes precedence over SPS metadata regardless of box order.
- Each segment's earliest selected presentation timestamp becomes the preceding segment's presentation end, preserving internal A/V offsets and gaps. Single remux/combine also normalize earliest PTS to zero, including negative AAC pre-roll. Delay/padding remains; gapless audio is not guaranteed.
- Packet order stays decode order. B-frame PTS is not sorted before copying. Output timestamps round to their container timescale.
- Sample durations must fit unsigned 32-bit output track units; composition offsets must fit signed 32-bit output track units. Values outside these ranges reject the operation instead of wrapping.
- FLV DTS must increase within a track; rollover/discontinuities require separate segments. Video duration comes from the next DTS/end marker; the final frame uses the previous interval, or 1/30 second for a lone frame without an end marker. AAC duration comes from its configuration.
- Progress phases are `inspect`, `remux`, and `finalize`. `bytesProcessed` counts encoded payload, excluding container overhead. Worker packet progress is throttled to 250 ms; phase transitions always report. Inspection scans timing metadata before output is created.

</details>

## Memory, disk, and performance

<details>
<summary>Memory and disk usage, and performance measurement</summary>

Input tables/indexes are paged and padding is skipped by range. Output uses two 56 KiB descriptor pages and one 64 KiB media write page per track, a fixed sorting buffer, bounded external-sort pages, and paged fragment indexes. Completed prefixes are compacted; files are reused. MP4 Blob sources have a 4 MiB cache per input. Output writes are at most 1 MiB.

These are bounds on specific structures, not constant total memory or a process-peak guarantee. Individual packets, codec/metadata boxes, source caches, track count, caller inputs, and runtime overhead have separate costs. Long GOPs use temporary disk/sorting I/O. OPFS must accommodate inputs, output, and spools; actual quota/I/O errors are authoritative. There is no arbitrary maximum file size or disk-space reservation.

Remuxing copies encoded data without decoding/re-encoding. Throughput depends on payload size, packet count, metadata scans, GOP shape, and storage. Use `tests/browser/benchmark.html` to measure real OPFS/Worker timing for selected local files; input loading is excluded and startup, inspection, copying, and finalization are included. Results are machine/browser-specific. See the [measured baseline](./docs/performance.md).

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

Tests cover real byte-preserving output, B frames/AAC pre-roll, malformed FLV, cancellation/I/O failures, sparse >4 GiB MP4, regular/TFRA/moof paging, partial disk I/O, sorting, and cleanup failures. If installed, FFmpeg independently decodes real outputs.

For browser checks, build, serve the repository with a local static server, and open `tests/browser/index.html`. Its button checks actual Worker/OPFS remux/combine/concat, cancellation, Worker failures, concurrent jobs, and cleanup. `tests/browser/benchmark.html` measures selected files serially over three rounds.

Vendored code retains upstream notices and independent formatting; it remains fully checked by strict TypeScript. See [migration notes](./src/vendor/mediabunny/MIGRATION.md) and [third-party notices](./THIRD_PARTY_NOTICES.md).

</details>

## License

Original code: [MIT](./LICENSE), © 2026-PRESENT ntnyq. Included Mediabunny-derived files: [MPL-2.0](./src/vendor/mediabunny/LICENSE), © 2026-present Vanilagy and contributors. Both notices and the exact modified MPL source subset ship in the npm package.
