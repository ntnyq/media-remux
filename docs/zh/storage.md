# 临时存储与文件适配器

[English](../storage.md) · 简体中文

[文档首页](./README.md) · [核心 API](./core.md) · [OPFS 示例](./examples.md#worker-中直接调用核心-api) · [Node 示例](./examples.md#在-node-中使用自定义文件适配器)

存储工厂和类型均从 `media-remux` 导入。核心 API 要求每个任务有独占的临时存储，浏览器的 `runMediaJob` 会直接管理这部分资源。

## `RemuxStorage` 和 `DisposableRemuxStorage`

| 类型                     | 成员                                          | 用途                                                       |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------- |
| `RemuxStorage`           | `fragmentIndex: FragmentIndexStore`           | 按轨道存放已完成 MP4 分片的随机访问索引（TFRA）。          |
| `RemuxStorage`           | `fragmentSamples: FragmentSampleStore`        | 存放采样描述符、编码载荷及呈现时间排序结果。               |
| `DisposableRemuxStorage` | 继承上述字段，增加 `dispose(): Promise<void>` | 统一关闭资源。调用方在任务结束后等待释放，再删除临时文件。 |

## `createOpfsStorage`

```ts
function createOpfsStorage(
  directory: FileSystemDirectoryHandle,
): DisposableRemuxStorage
```

`directory` 是调用方提供的任务专用 OPFS 目录。应在支持 OPFS 同步访问句柄的专用 Worker 中使用。函数同步返回，文件在第一次使用时打开。后续操作会传递同步访问不可用、校验、配额和 I/O 错误。

返回的 `dispose()` 即使遇到一个存储关闭失败，也会尝试关闭另一个，并以首个拒绝结果作为错误。两类存储各自复用释放结果。关闭句柄之后，由调用方按需删除目录和文件。

## `createDiskFragmentStore`

```ts
function createDiskFragmentStore(
  open: (trackId: number) => Promise<FragmentStoreFile>,
): FragmentStore & {
  reset: (trackId: number) => Promise<void>
  dispose: () => Promise<void>
}
```

`open` 为轨道打开独立的临时文件，每次打开都必须截断旧内容，包括 `reset()` 后的重新打开。轨道 ID 为 `1…0xffffffff` 范围内的整数。工厂同步返回并惰性打开文件。

### `createDiskFragmentIndex`

`createDiskFragmentStore` 的公开别名，签名、返回值和行为相同。为核心 API 提供 `storage.fragmentIndex` 时，可使用这个名字表明文件用途。

### `FragmentStoreFile` 和 `FragmentIndexFile`

`FragmentIndexFile` 是 `FragmentStoreFile` 的类型别名。读写缓冲区类型为 `Uint8Array<ArrayBuffer>`，位置为绝对字节偏移。读写可返回部分字节数，适配器会继续处理剩余范围。非空请求必须返回正数进度，且实际字节数不能超过请求长度。

| 方法                    | 返回类型          | 约定                                                       |
| ----------------------- | ----------------- | ---------------------------------------------------------- |
| `write(data, position)` | `Promise<number>` | 封存前按位置写入。任务应保持缓冲区内容稳定，直到操作完成。 |
| `read(data, position)`  | `Promise<number>` | 封存后从指定位置填充缓冲区，从缓冲区首字节开始写。         |
| `seal()`                | `Promise<void>`   | 提交待写数据，使其可稳定读取，结束文件写入阶段。           |
| `close()`               | `Promise<void>`   | 释放句柄及读取快照，丢弃尚未提交的数据。                   |

### `FragmentStore` 和 `FragmentIndexStore`

`FragmentIndexStore` 是 `FragmentStore` 的类型别名。两者声明 `append` 和 `read`。由磁盘工厂创建的对象还提供 `reset` 和 `dispose`。

| 方法                            | 返回类型                           | 约定                                                                                                                                      |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, data)`         | `Promise<void>`                    | 在该轨道首次读取前追加 `Uint8Array`。应保持源数据稳定，直到操作完成。                                                                     |
| `read(trackId, offset, length)` | `Promise<Uint8Array<ArrayBuffer>>` | 首次读取刷新缓冲并封存轨道。`offset` 是非负安全整数，`length` 为 `0…65536` 字节，范围必须落在已追加的数据内。返回恰好指定长度的新缓冲区。 |
| `reset(trackId)`                | `Promise<void>`                    | 关闭并忘记当前轨道，重新访问时使用新的空文件。未知轨道 ID 会被忽略。                                                                      |
| `dispose()`                     | `Promise<void>`                    | 停止接收操作，等待队列结束，丢弃缓冲字节并尝试关闭所有已打开的文件。重复调用共享释放 Promise。                                            |

## `createDiskFragmentSamples`

```ts
function createDiskFragmentSamples(
  open: (
    trackId: number,
    kind: (typeof FRAGMENT_SAMPLE_FILE_KIND)[keyof typeof FRAGMENT_SAMPLE_FILE_KIND],
  ) => Promise<FragmentSampleFile>,
): FragmentSampleStore & { dispose: () => Promise<void> }
```

`open` 必须为每个轨道和[文件角色](./constants.md#fragment_sample_file_kind)的组合打开独立文件。轨道首次使用时打开 `records` 和 `media`，只有在外部排序时才打开 `sort-a` 和 `sort-b`。适配器打开每个文件后会调用 `truncate(0)`。

### `FragmentSampleFile`

文件操作可以同步完成或返回 Promise。读写的 `data` 参数类型为 `Uint8Array<ArrayBuffer>`，`position` 为绝对字节偏移。适配器会继续处理部分读写的剩余范围，非空请求必须取得正数进度。

| 方法                    | 返回类型                    | 约定                                                                       |
| ----------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `read(data, position)`  | `number \| Promise<number>` | 填充传入缓冲区并返回实际读取字节数。                                       |
| `write(data, position)` | `number \| Promise<number>` | 按位置写入并返回实际写入字节数。保留其他字节，写入完成前保持源缓冲区稳定。 |
| `truncate(size)`        | `void \| Promise<void>`     | 以字节为单位调整文件长度，传 `0` 清空文件。                                |
| `close()`               | `void \| Promise<void>`     | 释放句柄以及对应的独占锁。                                                 |

### `FragmentSample`

| 字段                         | 类型及约束                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `timestamp`                  | `number`。有限的呈现时间戳（PTS），单位为秒，可以为负数。                                |
| `decodeTimestamp`            | `number`。有限的解码时间戳（DTS），单位为秒，可以为负数。                                |
| `duration`                   | `number`。有限且非负的呈现时长，单位为秒。                                               |
| `size`                       | `number`。`0…0xffffffff` 范围内的整数，单位为字节，追加时等于载荷长度。                  |
| `type`                       | `'key' \| 'delta'`，对应 [`FRAGMENT_SAMPLE_TYPE`](./constants.md#fragment_sample_type)。 |
| `timescaleUnitsToNextSample` | `number`。以轨道时间刻度计量的采样时长，非负安全整数，后续可以修正。                     |
| `mediaOffset`                | `number`。由追加操作分配的逻辑载荷字节偏移，非负安全整数，文件压缩后依然有效。           |

### `FragmentSampleStore`

每个方法都应等待完成。下表的返回值类型描述接口，磁盘工厂返回的方法均使用 Promise。轨道 ID 的范围同字节存储。

| 方法                                 | 返回类型                                    | 约定                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `append(trackId, sample, data)`      | `number \| Promise<number>`                 | `sample` 是 `Omit<FragmentSample, 'mediaOffset'>`，`data` 是 `Uint8Array`。磁盘适配器分配从零递增的轨道内逻辑采样 ID，释放后也继续递增。                                 |
| `get(trackId, id)`                   | `FragmentSample \| Promise<FragmentSample>` | 读取尚未释放的采样描述符。                                                                                                                                               |
| `set(trackId, id, sample)`           | `void \| Promise<void>`                     | 更新描述符，保留原载荷大小和偏移。磁盘适配器忽略对已释放 ID 的更新。                                                                                                     |
| `sort(trackId, start, count)`        | `void \| Promise<void>`                     | 对从 `start` 开始的连续保留 ID 范围准备升序 PTS，`count` 为正整数。替换上次结果，保留原采样 ID 和解码顺序。                                                              |
| `sorted(trackId, index)`             | `number \| Promise<number>`                 | 读取最近排序结果中从零开始的 `index` 对应的时间戳，单位为秒。                                                                                                            |
| `readMedia(trackId, offset, length)` | `Uint8Array \| Promise<Uint8Array>`         | 按逻辑载荷偏移读取保留范围，`length` 为 `0…65536` 字节，返回恰好指定长度。                                                                                               |
| `release(trackId, before)`           | `void \| Promise<void>`                     | 释放 ID 严格小于 `before` 的采样和载荷。边界取首个保留 ID 至下一次追加的 ID 之间的值，含两端。磁盘适配器压缩文件时保留存活采样的 ID 和偏移，并在边界推进时清除排序结果。 |

工厂的额外成员 `dispose(): Promise<void>` 会等待队列结束，丢弃缓冲数据，并尝试关闭所有打开的文件。重复释放共享同一个 Promise。

## 适配器的错误与清理

两个磁盘工厂都会串行处理操作。无效轨道、采样或范围及不完整读取会使操作失败。释放后调用会收到 `InvalidStateError`，字节存储封存后的追加也会收到该错误。队列中的首个失败会传递给后续操作。即使此前失败，也应调用 `dispose()`，以尝试关闭所有打开的句柄，然后自行删除临时文件。
