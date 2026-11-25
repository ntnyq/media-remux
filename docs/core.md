# Core API

English · [简体中文](./zh/core.md)

[Documentation](./README.md) · [Browser Worker API](./browser.md) · [Examples](./examples.md)

Import these functions from `media-remux`. They run in the current execution context, accept a caller-supplied positioned writable stream and temporary storage, and return an output summary.

## Functions

### `remuxMedia`

```ts
function remuxMedia(
  input: RemuxInput,
  options: RemuxOptions,
): Promise<RemuxResult>
```

Copies selected primary tracks from one nonempty input to fragmented MP4 or audio-only M4A. Choose the tracks with `options.tracks`. The earliest playable timestamp becomes zero, preserving offsets between tracks. If an H.264 MP4 starts with dependent frames, the video starts at the first sync sample verified to contain an IDR picture. [Single-input and audio-only examples](./examples.md#job-examples)

### `combineTracks`

```ts
function combineTracks(
  video: RemuxInput,
  audio: RemuxInput,
  options: CombineOptions,
): Promise<RemuxResult>
```

Takes the primary video track from `video` and the primary audio track from `audio`. Both are required. A missing track produces `MISSING_REQUIRED_TRACK`. The output MIME type is `video/mp4`. Use the default timeline for sources that share timestamps, or set `timeline` to align or offset independently timed sources. [Separate-input example](./examples.md#job-examples)

### `concatMedia`

```ts
function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult>
```

Joins a nonempty array in playback order. Each `Blob` should contain an independently readable segment. The function checks the selected tracks and timing in every segment before writing output, then places each segment's earliest playable timestamp at the previous segment's presentation end. Copy mode requires compatible track layouts and decoder configurations. Audio normalization relaxes those requirements for audio. [Concatenation rules](./compatibility.md#concatenation-and-audio-normalization)

## `RemuxInput` and `MpegTsInput`

```ts
type RemuxInput = Blob | MpegTsInput

interface MpegTsInput {
  blob: Blob
  segmentOffsets: readonly number[]
  allowContinuityCounterReset?: boolean
}
```

| Input                                     | Contract                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Blob` (including `File`)                 | A complete, nonempty MP4, FLV, MKV, or MPEG-TS input. Container detection uses the bytes.                                                                           |
| `MpegTsInput.blob`                        | One MPEG-TS byte stream assembled from ordered segments.                                                                                                            |
| `MpegTsInput.segmentOffsets`              | Absolute byte starts of all segments. The first value is `0`, the remaining values are strictly increasing, and every value is a multiple of 188 below `blob.size`. |
| `MpegTsInput.allowContinuityCounterReset` | Optional, defaults to `false`. At qualifying segment boundaries, allows the first payload on a selected PID to reset its continuity counter if the PES checks pass. |

Pass a descriptor to `remuxMedia`, either input of `combineTracks`, or the corresponding Worker job. Concatenation takes `readonly Blob[]`. [TS boundary rules](./compatibility.md#mpeg-ts-segment-boundaries) · [Descriptor example](./examples.md#preserve-mpeg-ts-segment-boundaries)

## `RemuxOptions`

| Field            | Type                                | Default and behavior                                                                                                                              |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`       | `WritableStream<MediaOutputChunk>`  | Required. Receives absolute-position output writes. Awaiting each write applies backpressure.                                                     |
| `storage`        | `RemuxStorage`                      | Required. Supply fresh storage reserved for this job and dispose of it afterward.                                                                 |
| `tracks`         | `RemuxTrackSelection`               | Optional, defaults to `REMUX_TRACK_SELECTION.all`. Used by remuxing and concatenation.                                                            |
| `normalizeAudio` | `boolean`                           | Optional, defaults to `false`. Encodes selected mono or stereo audio as continuous 48 kHz stereo AAC-LC. Video packets are copied.                |
| `signal`         | `AbortSignal`                       | Optional. Checked during inspection, copying, storage operations, and before output commit. Cancellation propagates the original `signal.reason`. |
| `onProgress`     | `(progress: RemuxProgress) => void` | Optional. Called synchronously in the current context. A thrown error fails the job. Returned promises are ignored.                               |

The job captures option fields, the input list, and descriptor offsets at submission. It keeps using the referenced signal, writable stream, and storage.

### `RemuxTrackSelection`

A union of the values in `REMUX_TRACK_SELECTION`.

| Constant member                | Value                               | Selection                                                                                                                                             |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.all`                         | `'all'`                             | Keep the available primary video and audio tracks.                                                                                                    |
| `.video`                       | `'video'`                           | Keep the primary video track. Each input must have a usable video track.                                                                              |
| `.audio`                       | `'audio'`                           | Keep the primary audio track. Each input must have a usable audio track.                                                                              |
| `.videoWithOptionalAudio`      | `'video-with-optional-audio'`       | Require primary video in every input and keep the primary audio track when present.                                                                   |
| `.firstVideoWithOptionalAudio` | `'first-video-with-optional-audio'` | Require the first video track in container order and keep the first audio track when present. The selected tracks must still meet codec requirements. |

Optional audio permits an input to omit its audio track. Copy-mode concatenation still requires matching selected track layouts. [Concatenating mixed or missing audio](./compatibility.md#concatenation-and-audio-normalization)

## `CombineOptions` and `CombineTimeline`

```ts
type CombineTimeline =
  | 'align-starts'
  | { videoOffset?: number; audioOffset?: number }

interface CombineOptions extends Omit<RemuxOptions, 'tracks'> {
  timeline?: CombineTimeline
}
```

| `timeline`                       | Timing behavior                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omitted                          | Use for a shared timeline. Rebase the earliest playable timestamp to zero and preserve the relative audio and video offset.                                                                 |
| `'align-starts'`                 | Align each track's playable start to zero. The video start accounts for any required keyframe trim.                                                                                         |
| `{ videoOffset?, audioOffset? }` | Add finite, signed offsets in seconds to each track's PTS and DTS. Each field defaults to `0`. A positive value delays its track. The earliest playable time after adjustment becomes zero. |

On a shared timeline, H.264 start trimming also trims audio relative to the playable video start. With the offset object, shifted timestamps determine the trim point. [Timestamp and trimming rules](./compatibility.md#timestamps-and-trimming)

## `RemuxResult`

| Field            | Type                         | Meaning                                                                                                                                  |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `duration`       | `number`                     | Output presentation span in seconds. For concatenation, the sum of segment presentation spans.                                           |
| `bytesProcessed` | `number`                     | Encoded payload bytes written, excluding container headers and indexes. For file size, read `File.size` or query the output destination. |
| `mimeType`       | `'video/mp4' \| 'audio/mp4'` | `video/mp4` if the output contains video, otherwise `audio/mp4`.                                                                         |

## `RemuxProgress`

| Field            | Type                                 | Meaning                                                                                                                                                                  |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`          | `'inspect' \| 'remux' \| 'finalize'` | Input and timing inspection, packet writing, and container finalization.                                                                                                 |
| `bytesProcessed` | `number`                             | Cumulative encoded payload bytes. Zero during `inspect`.                                                                                                                 |
| `segmentIndex`   | `number`                             | Zero-based segment index during inspection and writing, and the number of segments written during `finalize`. A single-input or combine job reports `1` at finalization. |

Display the phase and payload count as progress. Inspection, audio normalization, and finalization can take substantial time. Input size provides only a rough basis for application-level estimates.

## `MediaOutputChunk` and output lifecycle

```ts
interface MediaOutputChunk {
  type: 'write'
  position: number
  data: Uint8Array<ArrayBuffer>
}
```

`position` is the absolute byte offset in the output. The destination must support writes to earlier positions. `data` holds the container bytes to write at that position.

- On success, the library closes the stream and releases its lock. The caller can then read the output.
- If preflight fails, the caller handles closing or aborting any open destination. If writing fails, the library attempts to abort the stream and release its lock.
- Cancellation is honored before stream closure begins. Once closure starts, the destination's commit result determines the outcome.
- Await disposal of [temporary storage](./storage.md) in `finally`. The caller manages temporary directories and output files.

The promise can reject with a [media error](./errors.md), invalid arguments, cancellation, a storage or output error, or a thrown progress callback error.
