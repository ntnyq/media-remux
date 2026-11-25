# Error handling

English · [简体中文](./zh/errors.md)

[Documentation](./README.md) · [Core API](./core.md) · [Worker API](./browser.md) · [Media compatibility](./compatibility.md)

## `isRemuxError`

```ts
function isRemuxError(value: unknown): value is RemuxError
```

Import from `media-remux`. The predicate accepts an `Error` instance with a recognized media code. When it returns `true`, TypeScript narrows the candidate to `RemuxError`.

## `RemuxError` and `RemuxErrorCode`

```ts
type RemuxErrorCode = (typeof REMUX_ERROR_CODE)[keyof typeof REMUX_ERROR_CODE]

interface RemuxError extends Error {
  readonly code: RemuxErrorCode
}
```

Use `code` to select localized messages or compatibility fallbacks, and `message` for diagnostics. Each code has a corresponding [`REMUX_ERROR_CODE`](./constants.md#remux_error_code) member.

| Code                        | Meaning                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNSUPPORTED_CONTAINER`     | The input container is unrecognized or unsupported.                                                                                                                       |
| `UNSUPPORTED_CODEC`         | A selected track uses an unsupported codec or configuration.                                                                                                              |
| `UNSUPPORTED_MEDIA_FEATURE` | A media feature or runtime capability is unsupported. Examples include certain MP4 edit lists, encryption on selected tracks, and missing WebCodecs AAC encoding support. |
| `INCOMPATIBLE_SEGMENTS`     | Selected track layouts or configurations cannot share one output.                                                                                                         |
| `INVALID_INPUT`             | The media is empty, malformed, or fails validation such as timing checks.                                                                                                 |
| `MISSING_REQUIRED_TRACK`    | The requested operation or track selection requires a track that is absent.                                                                                               |

## Other failures

- Invalid arguments can throw a `TypeError` without a media code. Examples include an empty concatenation list and nonfinite combine offsets.
- Stream, quota, storage I/O, Worker startup or messaging failures, and thrown progress callback errors also reject the job. Job errors serialized by the Worker are reconstructed as an `Error` with the original name, message, and media code when available.
- Core cancellation before output commit propagates the original `signal.reason`. Worker cancellation also propagates it if cleanup succeeds. If the job and directory cleanup both fail, inspect `AggregateError.errors` for both causes.

## Map recognized errors to UI messages

```ts
import { isRemuxError, REMUX_ERROR_CODE } from 'media-remux'

export function getMediaErrorMessage(error: unknown): string {
  if (isRemuxError(error)) {
    switch (error.code) {
      case REMUX_ERROR_CODE.incompatibleSegments:
        return 'The segments have incompatible track layouts or codec settings.'
      case REMUX_ERROR_CODE.missingRequiredTrack:
        return 'The input is missing the requested audio or video track.'
      default:
        return error.message
    }
  }

  return error instanceof Error ? error.message : String(error)
}
```

[Cancellation and disposal example](./examples.md#report-progress-and-cancel-a-job)
