# Public constants

English · [简体中文](./zh/constants.md)

[Documentation](./README.md) · [Core API](./core.md) · [Worker API](./browser.md) · [Storage adapters](./storage.md)

Import these named constants from `media-remux`. TypeScript preserves their readonly literal member types for constructing jobs and matching progress phases, output formats, or error codes.

## `MEDIA_JOB_OPERATION`

Used in [`MediaJob.operation`](./browser.md#mediajob).

| Member    | Value       | Operation                                                    |
| --------- | ----------- | ------------------------------------------------------------ |
| `remux`   | `'remux'`   | Remux one input.                                             |
| `combine` | `'combine'` | Combine primary video and audio tracks from separate inputs. |
| `concat`  | `'concat'`  | Join segments in playback order.                             |

## `REMUX_TRACK_SELECTION`

| Member                        | Value                               |
| ----------------------------- | ----------------------------------- |
| `all`                         | `'all'`                             |
| `video`                       | `'video'`                           |
| `audio`                       | `'audio'`                           |
| `videoWithOptionalAudio`      | `'video-with-optional-audio'`       |
| `firstVideoWithOptionalAudio` | `'first-video-with-optional-audio'` |

See [`RemuxTrackSelection`](./core.md#remuxtrackselection) for the selection rules.

## `REMUX_PROGRESS_PHASE`

| Member     | Value        | Phase                                                               |
| ---------- | ------------ | ------------------------------------------------------------------- |
| `inspect`  | `'inspect'`  | Check input, tracks, and timing.                                    |
| `remux`    | `'remux'`    | Write encoded packets.                                              |
| `finalize` | `'finalize'` | Finish writing container metadata and prepare to commit the output. |

See [`RemuxProgress`](./core.md#remuxprogress) for progress fields.

## `REMUX_MIME_TYPE`

| Member  | Value         | Output                        |
| ------- | ------------- | ----------------------------- |
| `audio` | `'audio/mp4'` | Audio-only M4A.               |
| `video` | `'video/mp4'` | MP4 containing a video track. |

Used in [`RemuxResult.mimeType`](./core.md#remuxresult).

## `REMUX_ERROR_CODE`

| Member                    | Value                         |
| ------------------------- | ----------------------------- |
| `unsupportedContainer`    | `'UNSUPPORTED_CONTAINER'`     |
| `unsupportedCodec`        | `'UNSUPPORTED_CODEC'`         |
| `unsupportedMediaFeature` | `'UNSUPPORTED_MEDIA_FEATURE'` |
| `incompatibleSegments`    | `'INCOMPATIBLE_SEGMENTS'`     |
| `invalidInput`            | `'INVALID_INPUT'`             |
| `missingRequiredTrack`    | `'MISSING_REQUIRED_TRACK'`    |

See [error handling](./errors.md) for the meaning of each code and a type narrowing example.

## `FRAGMENT_SAMPLE_TYPE`

Used in [`FragmentSample.type`](./storage.md#fragmentsample).

| Member  | Value     | Meaning                                        |
| ------- | --------- | ---------------------------------------------- |
| `key`   | `'key'`   | Sync sample that can be decoded independently. |
| `delta` | `'delta'` | Sample that depends on other samples.          |

## `FRAGMENT_SAMPLE_FILE_KIND`

Used by the file opener passed to [`createDiskFragmentSamples`](./storage.md#creatediskfragmentsamples).

| Member    | Value       | Purpose                                             |
| --------- | ----------- | --------------------------------------------------- |
| `records` | `'records'` | Fixed-size sample descriptors.                      |
| `media`   | `'media'`   | Encoded payload.                                    |
| `sortA`   | `'sort-a'`  | One scratch file for external merge sorting.        |
| `sortB`   | `'sort-b'`  | The second scratch file for external merge sorting. |
