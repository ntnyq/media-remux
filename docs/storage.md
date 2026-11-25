# Temporary storage and file adapters

English · [简体中文](./zh/storage.md)

[Documentation](./README.md) · [Core API](./core.md) · [OPFS example](./examples.md#use-the-core-api-in-a-worker) · [Node example](./examples.md#implement-file-adapters-in-node)

Import the storage factories and types from `media-remux`. Core jobs need fresh, exclusive temporary storage. The browser helper `runMediaJob` manages these resources as part of the job.

## `RemuxStorage` and `DisposableRemuxStorage`

| Type                     | Member                                                 | Purpose                                                                                       |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `RemuxStorage`           | `fragmentIndex: FragmentIndexStore`                    | Stores track fragment random access (TFRA) index records for finished MP4 fragments.          |
| `RemuxStorage`           | `fragmentSamples: FragmentSampleStore`                 | Holds sample descriptors, encoded payload, and presentation timestamp sort results.           |
| `DisposableRemuxStorage` | Extends the two fields with `dispose(): Promise<void>` | Provides one cleanup operation. Await disposal after the job before deleting temporary files. |

## `createOpfsStorage`

```ts
function createOpfsStorage(
  directory: FileSystemDirectoryHandle,
): DisposableRemuxStorage
```

Pass a caller-owned OPFS directory reserved for the job. Use it in a dedicated Worker with synchronous OPFS access handles. The function returns synchronously and opens files on first use. Later operations can fail due to unavailable synchronous access, validation, quota, or I/O.

The shared `dispose()` attempts to close both stores and rejects with the first rejected result. Each store reuses its disposal result. The caller deletes directories and files after the handles close.

## `createDiskFragmentStore`

```ts
function createDiskFragmentStore(
  open: (trackId: number) => Promise<FragmentStoreFile>,
): FragmentStore & {
  reset: (trackId: number) => Promise<void>
  dispose: () => Promise<void>
}
```

The opener returns a separate temporary file for each integer track ID from `1` through `0xffffffff`. Each open must truncate the file, including a reopen after `reset()`. The factory returns synchronously and opens files on demand.

### `createDiskFragmentIndex`

A public alias of `createDiskFragmentStore` with the same signature, return value, and behavior. Use this name to make the purpose of a `storage.fragmentIndex` adapter clear.

### `FragmentStoreFile` and `FragmentIndexFile`

`FragmentIndexFile` is a type alias of `FragmentStoreFile`. The read and write buffers are `Uint8Array<ArrayBuffer>` and positions are absolute byte offsets. The adapter handles partial I/O by continuing with the remaining range. A nonempty request must make positive progress, and the returned count must fit within the requested length.

| Method                  | Return type       | Contract                                                                                           |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `write(data, position)` | `Promise<number>` | Writes at the given position before sealing. Keep the buffer stable until the operation completes. |
| `read(data, position)`  | `Promise<number>` | Reads at the given position after sealing, filling the buffer from its first byte.                 |
| `seal()`                | `Promise<void>`   | Commits pending data to make the file readable and ends the writing phase.                         |
| `close()`               | `Promise<void>`   | Releases handles and read snapshots, discarding uncommitted data.                                  |

### `FragmentStore` and `FragmentIndexStore`

`FragmentIndexStore` is a type alias of `FragmentStore`. Both declare `append` and `read`. Objects returned by the disk factories also expose `reset` and `dispose`.

| Method                          | Return type                        | Contract                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, data)`         | `Promise<void>`                    | Appends a `Uint8Array` before the first read of the track. Keep the source bytes stable until the operation completes.                                                                                                |
| `read(trackId, offset, length)` | `Promise<Uint8Array<ArrayBuffer>>` | The first read flushes writes and seals the track. `offset` is a nonnegative safe integer. `length` is `0…65536` bytes and the range must fit within the appended bytes. Returns a new buffer of exactly that length. |
| `reset(trackId)`                | `Promise<void>`                    | Closes and forgets the track. The next access opens a new logical file. Unknown track IDs are ignored.                                                                                                                |
| `dispose()`                     | `Promise<void>`                    | Stops accepting work, drains the queue, discards buffered bytes, and attempts to close every opened file. Repeated calls share the disposal promise.                                                                  |

## `createDiskFragmentSamples`

```ts
function createDiskFragmentSamples(
  open: (
    trackId: number,
    kind: (typeof FRAGMENT_SAMPLE_FILE_KIND)[keyof typeof FRAGMENT_SAMPLE_FILE_KIND],
  ) => Promise<FragmentSampleFile>,
): FragmentSampleStore & { dispose: () => Promise<void> }
```

Return a separate file for each track and [file role](./constants.md#fragment_sample_file_kind). The first access opens `records` and `media`. The `sort-a` and `sort-b` files open only for external sorting. The adapter calls `truncate(0)` when it opens each file.

### `FragmentSampleFile`

File methods can return immediately or return a promise. For reads and writes, `data` is a `Uint8Array<ArrayBuffer>` and `position` is an absolute byte offset. The adapter continues partial I/O and requires positive progress on nonempty requests.

| Method                  | Return type                 | Contract                                                                                                                                               |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read(data, position)`  | `number \| Promise<number>` | Fills the supplied buffer and returns the actual read count.                                                                                           |
| `write(data, position)` | `number \| Promise<number>` | Writes at the given position and returns the actual write count. Preserves unrelated bytes. Keep the supplied buffer stable until the write completes. |
| `truncate(size)`        | `void \| Promise<void>`     | Resizes the file in bytes. Pass `0` to clear the file.                                                                                                 |
| `close()`               | `void \| Promise<void>`     | Releases the handle and any exclusive access lock.                                                                                                     |

### `FragmentSample`

| Field                        | Type and constraints                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`                  | `number`. Finite presentation timestamp (PTS) in seconds. May be negative.                                                |
| `decodeTimestamp`            | `number`. Finite decode timestamp (DTS) in seconds. May be negative.                                                      |
| `duration`                   | `number`. Finite, nonnegative presentation duration in seconds.                                                           |
| `size`                       | `number`. Integer payload size in bytes from `0` through `0xffffffff`. Must equal the payload length on append.           |
| `type`                       | `'key' \| 'delta'`, corresponding to [`FRAGMENT_SAMPLE_TYPE`](./constants.md#fragment_sample_type).                       |
| `timescaleUnitsToNextSample` | `number`. Sample duration in track timescale units. A nonnegative safe integer that can be refined later.                 |
| `mediaOffset`                | `number`. Logical payload byte offset assigned on append. A nonnegative safe integer that remains valid after compaction. |

### `FragmentSampleStore`

Await each operation. The table shows interface return values. All methods on the disk implementation return promises. Track IDs use the same range as in the byte store.

| Method                               | Return type                                 | Contract                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, sample, data)`      | `number \| Promise<number>`                 | Takes an `Omit<FragmentSample, 'mediaOffset'>` and a `Uint8Array`. The disk adapter assigns monotonically increasing track-local IDs starting at zero, including after release.                                                                                      |
| `get(trackId, id)`                   | `FragmentSample \| Promise<FragmentSample>` | Reads the descriptor of a retained sample.                                                                                                                                                                                                                           |
| `set(trackId, id, sample)`           | `void \| Promise<void>`                     | Replaces a descriptor, preserving the original payload size and offset. The disk adapter ignores updates to released IDs.                                                                                                                                            |
| `sort(trackId, start, count)`        | `void \| Promise<void>`                     | Prepares ascending PTS values for a contiguous retained ID range. `count` is a positive integer. Replaces the previous result while preserving sample IDs and decode order.                                                                                          |
| `sorted(trackId, index)`             | `number \| Promise<number>`                 | Reads the timestamp in seconds at a zero-based index in the most recent sort result.                                                                                                                                                                                 |
| `readMedia(trackId, offset, length)` | `Uint8Array \| Promise<Uint8Array>`         | Reads by logical byte offset within the retained payload. `length` is `0…65536` bytes and the returned buffer has exactly that length.                                                                                                                               |
| `release(trackId, before)`           | `void \| Promise<void>`                     | Releases samples with IDs strictly below `before`. The boundary ranges from the first retained ID to the ID the next append would assign, inclusive. Compaction in the disk adapter preserves surviving IDs and offsets. Advancing the boundary clears sort results. |

The factory adds `dispose(): Promise<void>`, which drains the queue, discards buffered data, and attempts to close all files. Repeated calls share the disposal promise.

## Adapter errors and cleanup

Both disk factories serialize access. Invalid track IDs, samples, ranges, or incomplete reads cause operations to fail. Operations after disposal reject with `InvalidStateError`, as does an append to a sealed track in the byte store. The first queued operation failure also rejects subsequent operations. Always dispose of the store to attempt closure of every opened file, then delete the temporary files from the host.
