# media-remux documentation

English · [简体中文](./zh/README.md)

media-remux writes primary tracks from MP4, FLV, MKV, or MPEG-TS inputs to fragmented MP4. By default it copies encoded packets. Audio-only output uses M4A. Enable WebCodecs audio normalization when concatenating segments with different audio configurations.

## Getting started

```sh
pnpm add media-remux
```

- In a browser application, start with the [Worker quickstart](./examples.md#save-a-worker-result). `runMediaJob` manages the Worker and OPFS temporary files.
- To manage your own output stream or storage, use the [core API](./core.md). See the [OPFS Worker example](./examples.md#use-the-core-api-in-a-worker) or [Node file adapter example](./examples.md#implement-file-adapters-in-node).
- Check [media compatibility](./compatibility.md) before choosing an operation. For local measurements, see the [browser performance baseline](./performance.md).

## Public exports

The package provides ESM and TypeScript declarations. Functions and constants are named exports. Import types with `import type`.

Package metadata is available at `media-remux/package.json`.

| Entry point          | Reference                                             | Exports                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media-remux`        | [Core functions](./core.md#functions)                 | `remuxMedia`, `combineTracks`, `concatMedia`                                                                                                                                             |
| `media-remux`        | [Core types](./core.md)                               | `RemuxInput`, `MpegTsInput`, `RemuxOptions`, `CombineOptions`, `CombineTimeline`, `RemuxTrackSelection`, `RemuxResult`, `RemuxProgress`, `MediaOutputChunk`                              |
| `media-remux`        | [Browser jobs](./browser.md)                          | `runMediaJob`, `MediaJob`, `MediaJobOptions`, `MediaJobResult`                                                                                                                           |
| `media-remux`        | [Storage factories](./storage.md)                     | `createOpfsStorage`, `createDiskFragmentStore`, `createDiskFragmentIndex`, `createDiskFragmentSamples`                                                                                   |
| `media-remux`        | [Storage types](./storage.md)                         | `RemuxStorage`, `DisposableRemuxStorage`, `FragmentStoreFile`, `FragmentStore`, `FragmentIndexFile`, `FragmentIndexStore`, `FragmentSampleFile`, `FragmentSample`, `FragmentSampleStore` |
| `media-remux`        | [Errors](./errors.md)                                 | `isRemuxError`, `RemuxError`, `RemuxErrorCode`                                                                                                                                           |
| `media-remux`        | [Constants](./constants.md)                           | `MEDIA_JOB_OPERATION`, `REMUX_TRACK_SELECTION`, `REMUX_PROGRESS_PHASE`, `REMUX_MIME_TYPE`, `REMUX_ERROR_CODE`, `FRAGMENT_SAMPLE_TYPE`, `FRAGMENT_SAMPLE_FILE_KIND`                       |
| `media-remux/worker` | [Worker entry point](./browser.md#installmediaworker) | `installMediaWorker`, `MediaWorkerScope`                                                                                                                                                 |

[Project README](../README.md) · [TypeScript examples](./examples.md)
