# media-remux

[![CI](https://github.com/ntnyq/media-remux/workflows/CI/badge.svg)](https://github.com/ntnyq/media-remux/actions)
[![NPM VERSION](https://img.shields.io/npm/v/media-remux.svg)](https://www.npmjs.com/package/media-remux)
[![NPM DOWNLOADS](https://img.shields.io/npm/dy/media-remux.svg)](https://www.npmjs.com/package/media-remux)
[![LICENSE](https://img.shields.io/github/license/ntnyq/media-remux.svg)](https://github.com/ntnyq/media-remux/blob/main/LICENSE)

[English](./README.md) | [简体中文](./README.zh-CN.md)

以磁盘为后端的浏览器媒体处理工具，支持重新封装、音视频轨道合并和媒体片段拼接，无需重新编码。没有运行时依赖；所需的 Mediabunny 源码子集及补丁已直接包含在项目中。

## 功能

- `remuxMedia`：将 MP4/FLV 中的主 H.264/AAC 轨道重新封装为分片 MP4；仅选择 AAC 音轨时输出 M4A。
- `combineTracks`：合并来自不同文件的 H.264 视频和 AAC 音频。
- `concatMedia`：按顺序拼接兼容的媒体片段，写入输出前检查配置和时间轴。
- `runMediaJob`：在专用 Worker 中执行任务，支持 OPFS、进度通知、取消和临时文件清理。
- 对 MP4 表、TFRA 和 moof 记录进行分页；将输出描述符、媒体数据、时间戳排序和分片索引存储在磁盘上。

输入必须是完整的 `Blob`/`File` 对象。本包不负责下载、身份验证、媒体清单、画质选择、转码、滤镜、DRM 或帧精确编辑。

## 安装

首次发布到 npm 后，可通过以下命令安装：

```sh
pnpm add media-remux
```

## 浏览器用法

按照所用打包工具的 Worker 约定，创建一个模块 Worker 入口：

<details>
<summary>完整示例：Worker 入口、合并音视频、提取音频和拼接任务</summary>

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
  await saveFile(result.file) // 由应用实现文件保存操作。
} finally {
  await result.dispose()
}
```

其他任务示例：

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

任务负责管理并终止其 Worker。每次调用都应创建新的 Worker。取消操作可以中断同步解析和 I/O。导入模块不会自动启动任务或安装消息监听器。WXT/Vite 应用可以使用现有的 Worker 工厂函数；本包不依赖这两个框架。

运行环境需要安全上下文、OPFS、模块 Worker，以及 Worker 中的 OPFS 同步访问句柄。默认情况下，任务会在 OPFS 根目录下创建随机子目录；可通过 `directory` 指定由应用管理的父目录。任务成功后会删除临时文件，保留输出文件直到调用 `dispose()`。任务失败或取消后会删除整个任务目录，并在遇到临时锁定时重试。清理错误会传递给调用方。标签页或浏览器崩溃后遗留的目录需要由应用清理。

请在释放资源前读取或保存 `result.file`。音频文件使用 `.m4a` 扩展名和 `audio/mp4` MIME 类型；视频文件使用 `.mp4` 和 `video/mp4`。释放操作具有幂等性，删除失败后可以重试。

## 核心 API 与存储适配器

核心 API 接收支持按位置写入的流，以及全新创建的存储实例。它们不会创建 Worker，也不会删除调用方拥有的文件。

<details>
<summary>核心调用示例与自定义存储接入</summary>

```ts
import { createOpfsStorage, remuxMedia } from 'media-remux'
import type { MediaOutputChunk } from 'media-remux'

// 在专用 Worker 中执行，并为此任务使用独占目录。
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
// 使用完输出文件后，删除任务目录。
```

`combineTracks(video, audio, options)` 和 `concatMedia(inputs, options)` 使用相同的存储与输出约定。`MediaOutputChunk` 的结构为 `{ type: 'write', position, data }`。写入操作可能回到较早的偏移位置，因此仅支持追加写入的目标无法满足要求。通过等待写入和存储操作完成来提供背压。成功时会关闭流并释放锁；写入阶段失败时会中止流并释放锁。预检查失败时，传入的流保持不变，仍由调用方负责管理。

如需支持其他运行时，可为 `createDiskFragmentIndex` 和 `createDiskFragmentSamples` 实现按位置读写文件的 I/O，再将创建的存储分别作为 `storage.fragmentIndex`/`storage.fragmentSamples` 传入。适配器会在部分读写时重试，保留首次失败的错误，并在释放资源时关闭所有已打开的句柄。每个任务都需要新的存储实例。项目已测试 Node 文件按位置读写的实现，但未提供 Node 文件系统适配器。

</details>

## API 参考

以下函数均为具名导出。`installMediaWorker` 及其 `MediaWorkerScope` 类型从 `media-remux/worker` 导入；其余函数和类型从 `media-remux` 导入。

| 导出方法                               | 用途                                                 | 返回值                                                 |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `runMediaJob(job, options)`            | 在独立浏览器 Worker 中运行任务，自动管理 OPFS 文件。 | `Promise<MediaJobResult>`                              |
| `remuxMedia(input, options)`           | 将单个 MP4/FLV 中所选轨道复制为 fMP4/M4A。           | `Promise<RemuxResult>`                                 |
| `combineTracks(video, audio, options)` | 合并不同文件中的视频和音频。                         | `Promise<RemuxResult>`                                 |
| `concatMedia(inputs, options)`         | 按传入顺序拼接兼容片段。                             | `Promise<RemuxResult>`                                 |
| `createOpfsStorage(directory)`         | 为专用 Worker 中的核心任务创建临时存储。             | `DisposableRemuxStorage`                               |
| `createDiskFragmentStore(open)`        | 将按位置读写的文件适配为按轨道组织的字节存储。       | 包含 `append`、`read`、`reset` 和 `dispose` 的存储对象 |
| `createDiskFragmentIndex(open)`        | `createDiskFragmentStore` 的别名，用于分片索引。     | 与 `createDiskFragmentStore` 相同                      |
| `createDiskFragmentSamples(open)`      | 将按位置读写的文件适配为采样、媒体数据及排序存储。   | 带有 `dispose` 的 `FragmentSampleStore`                |
| `installMediaWorker(scope?)`           | 安装处理单个任务的 Worker 消息监听器。               | `() => void`                                           |

<details>
<summary><code>runMediaJob</code>：任务类型、选项及输出生命周期</summary>

```ts
function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult>
```

`job` 是由 `operation` 区分的联合类型。输入必须是完整、非空的 MP4/FLV `Blob`；`File` 继承自 `Blob`，也可以直接传入。

| `operation` | 必填字段                     | 可选字段 | 行为                                                         |
| ----------- | ---------------------------- | -------- | ------------------------------------------------------------ |
| `'remux'`   | `input: Blob`                | `tracks` | 复制单个输入中所选的主轨道。                                 |
| `'combine'` | `video: Blob`、`audio: Blob` | 无       | 仅使用 `video` 的主 H.264 视频轨道和 `audio` 的主 AAC 音轨。 |
| `'concat'`  | `inputs: readonly Blob[]`    | `tracks` | 按播放顺序拼接非空列表；所选轨道布局和解码器配置必须一致。   |

`tracks` 可取 `'all'`、`'audio'` 或 `'video'`，默认为 `'all'`。`'all'` 保留可用且受支持的主轨道，不要求音视频同时存在；明确选择某类轨道但输入中没有对应轨道时会失败。合并任务不接受 `tracks`。

| `options` 字段 | 类型                                | 必填 / 默认值              | 说明                                                                                                                            |
| -------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `createWorker` | `() => Worker`                      | 必填                       | 返回全新的专用模块 Worker，其入口需要调用 `installMediaWorker()`。任务成功、失败或取消时都会终止该 Worker，请勿共享或复用。     |
| `directory`    | `FileSystemDirectoryHandle`         | 可选；当前源的 OPFS 根目录 | 用于创建唯一 `media-remux-…` 任务子目录的父目录。父目录本身会保留。                                                             |
| `signal`       | `AbortSignal`                       | 可选                       | 通过 `AbortController` 取消任务；会终止 Worker，包括同步解析和 I/O，并删除任务目录。                                            |
| `onProgress`   | `(progress: RemuxProgress) => void` | 可选                       | 在调用线程执行。Worker 的 `remux` 通知以 250 ms 为间隔节流，阶段切换始终通知。回调抛错会使任务失败；返回的 Promise 不会被等待。 |

Promise 会在 Worker 终止且临时文件清理完成后兑现。返回的 `MediaJobResult` 包含下文的全部 `RemuxResult` 字段，另有：

| 字段      | 类型                  | 说明                                                                                                                                 |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `file`    | `File`                | 含视频时为 `output.mp4` / `video/mp4`，否则为 `output.m4a` / `audio/mp4`。必须先读取或保存，再释放资源。                             |
| `dispose` | `() => Promise<void>` | 删除保留的任务目录及输出文件。成功后重复调用无副作用，并发调用共享清理过程，删除失败后可以重试。消费完 `file` 后务必调用并等待完成。 |

失败时 Promise 会拒绝。Worker 内部任务错误跨线程后表现为保留名称和消息的 `Error`。取消且清理成功时，保留 `signal` 的原始取消原因。如果任务和目录清理同时失败，则抛出包含两者的 `AggregateError`。清理会重试临时文件锁；浏览器崩溃后遗留的目录仍需应用自行清理。

</details>

<details>
<summary><code>remuxMedia</code>、<code>combineTracks</code> 和 <code>concatMedia</code>：输入与核心选项</summary>

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

| 参数      | 所属方法        | 说明                                                                                      |
| --------- | --------------- | ----------------------------------------------------------------------------------------- |
| `input`   | `remuxMedia`    | 单个完整、非空的 MP4/FLV `Blob` 或 `File`，直接复制所选主轨道，无需重新编码。             |
| `video`   | `combineTracks` | 提供主 H.264 视频轨道的 MP4/FLV 输入；其中的音轨会被忽略。                                |
| `audio`   | `combineTracks` | 提供主 AAC 音轨的 MP4/FLV 输入；其中的视频轨道会被忽略。                                  |
| `inputs`  | `concatMedia`   | 按播放顺序排列的非空 MP4/FLV 输入数组。写入输出前，会检查所有所选片段的兼容性和时间信息。 |
| `options` | 三者共用        | 输出流、全新存储及可选回调，详见下表。                                                    |

| `RemuxOptions` 字段 | 类型                                | 必填 / 默认值 | 说明                                                                                                               |
| ------------------- | ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `writable`          | `WritableStream<MediaOutputChunk>`  | 必填          | 必须支持按绝对位置写入，包括回写较早的偏移位置。等待写入完成提供背压。                                             |
| `storage`           | `RemuxStorage`                      | 必填          | 全新、由本任务独占的 `fragmentIndex` 和 `fragmentSamples`。无论成功、失败还是取消，调用方都应在 `finally` 中释放。 |
| `tracks`            | `'all' \| 'audio' \| 'video'`       | 可选；`'all'` | 选择重新封装或拼接时保留的主轨道类型。`combineTracks` 不接受该选项，始终选择一条视频轨道和一条音轨。               |
| `signal`            | `AbortSignal`                       | 可选          | 在检查、数据包复制及存储操作期间检查取消状态；拒绝时使用原始取消原因。                                             |
| `onProgress`        | `(progress: RemuxProgress) => void` | 可选          | 在核心 API 的执行上下文中同步通知，不做 Worker 层的节流。抛错会使操作失败；返回的 Promise 不会被等待。             |

这些方法返回处理摘要，不返回 `File`。输出目标及临时文件均由调用方管理。处理成功会关闭 `writable` 并释放锁；写入阶段失败会中止流并释放锁；预检查失败不会操作传入的流，调用方需按需关闭或中止它。释放存储只关闭句柄，不删除文件。

重新封装和合并会将所选轨道最早的呈现时间戳归零，保留音视频之间的相对偏移。拼接会将每个归零后的片段接到前一片段的呈现结束位置。缺少所选轨道、片段配置不兼容、媒体或时间信息异常、视频未以关键帧开头都会导致 Promise 拒绝；I/O 和回调错误也会向上传递。

</details>

<details>
<summary>共用类型：<code>RemuxResult</code>、<code>RemuxProgress</code>、<code>MediaOutputChunk</code> 与存储</summary>

所有核心方法返回 `RemuxResult`，`MediaJobResult` 也继承这些字段。

| 字段             | 类型                         | 含义                                                                                                   |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bytesProcessed` | `number`                     | 已复制的编码媒体数据总字节数，不含容器头和索引，不等于输出文件大小。                                   |
| `duration`       | `number`                     | 输出呈现跨度，单位为秒，等于所选轨道最晚的数据包结束时间减去最早的 PTS。拼接时累加各片段归零后的跨度。 |
| `mimeType`       | `'video/mp4' \| 'audio/mp4'` | 包含视频轨道时使用视频 MIME 类型，否则使用音频 MIME 类型。                                             |

`onProgress` 接收 `RemuxProgress`：

| 字段             | 类型                                 | 含义                                                                                                              |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `phase`          | `'inspect' \| 'remux' \| 'finalize'` | 依次表示检查输入和时间信息、复制编码数据包、完成容器元数据写入。                                                  |
| `bytesProcessed` | `number`                             | 累计复制的媒体数据字节数；检查阶段为零。不含容器开销，未提供总量或百分比字段。                                    |
| `segmentIndex`   | `number`                             | 检查及复制阶段为从零开始的片段索引；收尾阶段为已写入的片段数量，重新封装/合并通常为 `1`，拼接为 `inputs.length`。 |

`MediaOutputChunk` 描述一次按绝对位置写入的操作：

| 字段       | 类型                      | 含义                                   |
| ---------- | ------------------------- | -------------------------------------- |
| `type`     | `'write'`                 | 按位置写入文件的操作类型。             |
| `position` | `number`                  | 输出文件中的绝对字节偏移，不保证递增。 |
| `data`     | `Uint8Array<ArrayBuffer>` | 写入 `position` 位置的容器字节。       |

`RemuxStorage` 必须包含用于已完成分片 TFRA 记录的 `fragmentIndex: FragmentIndexStore`，以及用于描述符、媒体数据和时间戳排序的 `fragmentSamples: FragmentSampleStore`。`DisposableRemuxStorage` 在此基础上增加 `dispose(): Promise<void>`：即使某个存储释放失败，也会尝试释放另一个，并以首个被拒绝的结果作为错误。目录删除需要另行处理。

</details>

<details>
<summary><code>installMediaWorker</code>：Worker 入口与可选消息作用域</summary>

```ts
// 从 'media-remux/worker' 导入。
function installMediaWorker(scope?: MediaWorkerScope): () => void
```

`scope` 默认为 Worker 的 `globalThis`。自定义宿主或测试可传入 `MediaWorkerScope`，实现 `addEventListener('message', listener)`、`removeEventListener('message', listener)` 和发送协议响应的 `postMessage(message)`。

每个专用 Worker 入口调用一次。每次安装只接收一个任务，后续消息会被忽略；即使首条请求无效，也会占用该任务名额。执行过程中向父线程发送进度，临时存储关闭后报告完成，尝试清理后报告序列化的错误。仅导入 `media-remux/worker` 不会自动注册监听器。

返回的同步函数用于移除消息监听器，不会取消正在执行的任务，也不会终止 Worker；终止由 `runMediaJob` 负责。注册监听器失败会同步抛错，异步处理失败则通过 Worker 消息报告。

</details>

<details>
<summary><code>createOpfsStorage</code>：目录、惰性文件与资源释放</summary>

```ts
function createOpfsStorage(
  directory: FileSystemDirectoryHandle,
): DisposableRemuxStorage
```

`directory` 必填，必须由单个任务独占，用于存放临时文件。需要在支持 OPFS 同步访问句柄的专用 Worker 中使用。函数立即返回，不执行 I/O；存储在实际使用时才打开并截断文件，后续操作会传递不支持同步访问、校验、配额及 I/O 等错误。

返回值包含 `fragmentIndex`、`fragmentSamples` 和 `dispose()`。每个核心任务创建一个新实例，在 `finally` 中等待释放，再自行删除临时文件或目录。释放操作会尝试关闭两类存储的句柄，保留目录及文件条目。如果要在消费输出前删除临时目录，请将输出文件放在该目录之外。

</details>

<details>
<summary><code>createDiskFragmentStore</code> / <code>createDiskFragmentIndex</code>：文件打开器与字节存储约定</summary>

```ts
function createDiskFragmentStore(
  open: (trackId: number) => Promise<FragmentStoreFile>,
): FragmentStore & {
  reset: (trackId: number) => Promise<void>
  dispose: () => Promise<void>
}

// createDiskFragmentIndex 是别名，签名与行为相同。
```

`open` 必填，为 `1…0xffffffff` 范围内的整数 `trackId` 打开各自独立的逻辑文件。每次打开都必须截断文件，包括 `reset` 后重新打开。文件按需打开。`FragmentIndexFile` 是 `FragmentStoreFile` 的别名，`FragmentIndexStore` 是 `FragmentStore` 的别名。

| `FragmentStoreFile` 方法                 | 约定                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `write(data, position): Promise<number>` | 封存前按绝对偏移写入，返回实际写入字节数；支持部分写入并重试。完成前保持 `data` 不变。 |
| `read(data, position): Promise<number>`  | 封存后从绝对偏移读取到目标缓冲区，返回实际读取字节数；支持部分读取并重试。             |
| `seal(): Promise<void>`                  | 提交待写入数据，准备稳定的可读文件。封存后不能继续写入，需重置并重新打开。             |
| `close(): Promise<void>`                 | 释放资源并丢弃未提交的数据。文件删除仍由调用方负责。                                   |

| 返回的方法                      | 参数与结果                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, data)`         | 追加 `Uint8Array` 字节，返回 `Promise<void>`。完成前保持源数据不变。                                                                                  |
| `read(trackId, offset, length)` | 读取已追加的范围；`offset` 为非负安全整数，`length` 为 `0…65536`。返回长度恰为 `length` 的 `Promise<Uint8Array<ArrayBuffer>>`。首次读取会封存该轨道。 |
| `reset(trackId)`                | 关闭并遗忘轨道，下次访问时打开全新的空逻辑文件；忽略未知 ID。返回 `Promise<void>`。                                                                   |
| `dispose()`                     | 停止接收操作、等待队列结束、丢弃缓冲字节，并尝试关闭所有已打开文件。具有幂等性，返回 `Promise<void>`。                                                |

操作会串行执行，调用方必须等待。无效范围/ID 或不完整读取会失败；封存后追加、释放后操作会以 `InvalidStateError` 失败。非空 I/O 必须取得正数进度。首次操作失败会使后续排队操作继续失败，但释放仍会尝试关闭所有文件。可将 `createDiskFragmentIndex(open)` 用作 `storage.fragmentIndex`；通用字节存储本身不满足 `storage.fragmentSamples` 的要求。

</details>

<details>
<summary><code>createDiskFragmentSamples</code>：文件类型、采样字段及存储方法</summary>

```ts
function createDiskFragmentSamples(
  open: (
    trackId: number,
    kind: 'records' | 'media' | 'sort-a' | 'sort-b',
  ) => Promise<FragmentSampleFile>,
): FragmentSampleStore & { dispose: () => Promise<void> }
```

`open` 必填，必须为每个 `(trackId, kind)` 组合返回独立的按位置读写文件。轨道 ID 为 `1…0xffffffff` 范围内的整数。每条轨道按需打开四类文件，适配器会将它们截断为零：`records` 存放描述符，`media` 存放编码媒体数据，`sort-a` / `sort-b` 用于外部排序。

| `FragmentSampleFile` 方法 | 返回类型                    | 约定                                                                 |
| ------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `read(data, position)`    | `number \| Promise<number>` | 从绝对字节偏移读取到 `Uint8Array<ArrayBuffer>`，返回实际读取字节数。 |
| `write(data, position)`   | `number \| Promise<number>` | 按绝对字节偏移写入，不截断其他字节，返回实际写入字节数。             |
| `truncate(size)`          | `void \| Promise<void>`     | 按字节调整文件大小，传零清空文件。                                   |
| `close()`                 | `void \| Promise<void>`     | 释放文件句柄及锁。                                                   |

部分读写会被重试；非空操作必须取得正数进度。写入完成前保持缓冲区不变。该接口同时接受专用 Worker 句柄的同步 I/O，以及其他运行时的异步 I/O。

`FragmentSample` 描述一个编码采样：

| 字段                         | 类型 / 单位                | 约束                                                             |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `timestamp`                  | `number`，秒               | 有限的 PTS，可以为负数。                                         |
| `decodeTimestamp`            | `number`，秒               | 有限的 DTS，可以为负数。                                         |
| `duration`                   | `number`，秒               | 有限且非负。                                                     |
| `size`                       | `number`，字节             | `0…0xffffffff` 范围内的整数，追加时必须等于媒体数据长度。        |
| `type`                       | `'key' \| 'delta'`         | 可独立解码的采样或依赖其他采样的采样。                           |
| `timescaleUnitsToNextSample` | `number`，轨道时间刻度单位 | 非负安全整数；后续采样到达时可进一步修正。                       |
| `mediaOffset`                | `number`，字节             | 非负安全整数逻辑偏移，由追加操作分配，文件压缩整理后仍保持稳定。 |

| `FragmentSampleStore` 方法           | 参数与结果                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append(trackId, sample, data)`      | `sample` 不含 `mediaOffset`，`data` 为 `Uint8Array`。返回从零开始的轨道内采样 ID，持续递增，释放后不复用。                                              |
| `get(trackId, id)`                   | 返回尚未释放采样的 `FragmentSample` 描述符。                                                                                                            |
| `set(trackId, id, sample)`           | 更新描述符，不重写媒体数据；必须保留有效的媒体大小和偏移引用。磁盘存储会忽略已释放的 ID。                                                               |
| `sort(trackId, start, count)`        | 为保留范围准备升序 PTS，`count` 为正整数。替换上次排序结果，不改变采样 ID 或解码顺序。                                                                  |
| `sorted(trackId, index)`             | 按从零开始的位置读取最近排序结果中的时间戳，单位为秒。                                                                                                  |
| `readMedia(trackId, offset, length)` | 按逻辑字节偏移读取尚未释放的媒体数据，`length` 为 `0…65536`，返回恰好该长度的字节。                                                                     |
| `release(trackId, before)`           | 释放 ID 严格小于 `before` 的采样及媒体数据。边界可从首个保留 ID 取到下一次追加的 ID，包含两端。压缩文件、保留存活 ID/偏移，并在边界推进时清除排序结果。 |

接口允许立即返回值或 Promise，修改方法返回 `void` 或 `Promise<void>`；磁盘适配器的方法返回 Promise。始终等待操作完成，追加期间保持媒体数据不变。额外的 `dispose()` 会停止接收操作、等待队列结束、丢弃缓冲并尝试关闭所有文件。释放具有幂等性，关闭失败会拒绝；文件删除仍由调用方负责。无效采样/范围、释放后使用或 I/O 错误都会拒绝，首次操作失败会使后续操作继续失败。

将该适配器作为 `storage.fragmentSamples`，同时用全新的 `createDiskFragmentIndex(openIndex)` 提供 `storage.fragmentIndex`。本包未内置 Node 文件系统适配器。

</details>

## 时间轴与兼容性

<details>
<summary>轨道限制、片段兼容性和时间戳处理规则</summary>

- 仅使用主轨道。重新封装和拼接支持 `tracks: 'all' | 'audio' | 'video'`，默认为 `all`。合并操作从第一个输入中选择视频，从第二个输入中选择音频。
- MP4 支持 H.264/AAC。FLV 支持标准 AVC 和 AAC-LC，包括每帧 960/1024 个采样的 AAC。HE-AAC/SBR（含隐式声明）、不支持或已加密的 FLV 标签、包含多个采样描述的 MP4，以及序列头发生变化的 FLV 都会被拒绝。
- MP4 编辑列表支持前置空 edit，以及随后单个播放速率为 1 的媒体 edit。仅包含空 edit 的列表、媒体 edit 后的额外 edit、非单位媒体播放速率、隐藏完整视频帧的前部裁剪，以及会裁掉样本尾部播放内容的有限时长媒体 edit，会在预检阶段被拒绝，避免静默改变播放内容。时长为 0 的媒体 edit 视为开放区间，允许电影时间刻度带来的舍入误差。
- 同一 `moof` 内同一轨道的多个轨道片段（`traf`）会在预检阶段被拒绝，避免静默丢弃数据包。
- 任务会固定提交时的片段列表，以及任务和选项的顶层字段。调用方随后修改数组或选项字段，不会改变进行中的任务；引用的取消信号和存储资源仍保持活动状态。
- 所选的加密 MP4 轨道会在预检阶段被拒绝，包括不支持的加密方案或缺少采样加密信息的情况。未选择的受保护轨道可以被丢弃。
- 视频的像素宽高比在重复重新封装后仍保持精确值。兼容性检查比较约分后的显示宽高比，成比例的显示尺寸可正常匹配。MP4 中显式的 `pasp` 信息优先于 SPS 元数据，不受 box 顺序影响。
- 所选片段的轨道布局、编解码器字符串、解码器描述字节、尺寸/宽高比/色彩配置、采样率/声道数和视频变换必须一致。每个视频片段必须以关键帧开头。匹配规则严格，可能拒绝需要先做规范化处理的文件。
- 每个片段中所选轨道的最早呈现时间戳会对齐到前一个片段的呈现结束时间，同时保留片段内部的音视频偏移和间隙。单次重新封装或合并也会将最早的 PTS 归零，包括负时间戳的 AAC 预滚。延迟和填充仍会保留，不保证无缝音频播放。
- 数据包保持解码顺序。复制前不会按 B 帧的 PTS 排序。输出时间戳会按容器时间刻度取整。
- 采样时长必须处于输出轨道时间刻度下的无符号 32 位范围内，呈现时间与解码时间的偏移必须处于有符号 32 位范围内。超出范围会拒绝操作，避免数值回绕。
- 同一轨道内的 FLV DTS 必须递增；时间戳回绕或不连续的内容需要拆分为独立片段。视频帧时长由下一个 DTS 或结束标记确定；最后一帧沿用前一帧的间隔，如果只有一帧且没有结束标记，则使用 1/30 秒。AAC 时长由其配置确定。
- 进度阶段为 `inspect`、`remux` 和 `finalize`。`bytesProcessed` 统计编码后的媒体数据量，不包含容器开销。Worker 中的数据包进度通知以 250 ms 为间隔进行节流；阶段切换始终会通知。检查阶段会在创建输出前扫描时间元数据。

</details>

## 内存、磁盘与性能

<details>
<summary>内存与磁盘占用、性能测量说明</summary>

输入表和索引采用分页读取，并通过范围跳过填充数据。每条轨道的输出使用两个 56 KiB 描述符页和一个 64 KiB 媒体写入页，此外还使用固定的排序缓冲区、有界的外部排序页和分页分片索引。已完成的前缀数据会被压缩整理，文件会被复用。MP4 Blob 源为每个输入使用 4 MiB 缓存。单次输出写入最多为 1 MiB。

这些限制针对特定数据结构，并不代表总内存恒定，也不保证进程内存峰值。单个数据包、编解码器/元数据 box、源缓存、轨道数量、调用方输入和运行时开销各自还会消耗内存。长 GOP 会产生临时磁盘和排序 I/O。OPFS 需要有足够空间容纳输入、输出和临时文件；实际的配额或 I/O 错误以运行时返回为准。项目没有人为设置文件大小上限，也不会预留磁盘空间。

重新封装直接复制编码数据，无需解码或重新编码。吞吐量取决于媒体数据量、数据包数量、元数据扫描、GOP 结构和存储性能。可使用 `tests/browser/benchmark.html` 为选定的本地文件测量实际 OPFS/Worker 耗时；测量不包含输入加载，但包含启动、检查、复制和收尾阶段。结果取决于具体机器和浏览器。参见[实测性能基线](./docs/performance.md)。

</details>

## 开发

<details>
<summary>开发命令、测试范围与浏览器检查</summary>

```sh
pnpm install
pnpm release:check
pnpm build
pnpm pack --dry-run
```

测试覆盖真实媒体输出的字节保真、B 帧/AAC 预滚、异常 FLV、取消/I/O 失败、超过 4 GiB 的稀疏 MP4、常规索引/TFRA/moof 分页、部分磁盘 I/O、排序和清理失败。如果已安装 FFmpeg，还会使用它独立解码真实输出进行验证。

浏览器检查需要先构建项目，再通过本地静态服务器提供仓库文件，并打开 `tests/browser/index.html`。页面按钮会检查真实 Worker/OPFS 环境下的重新封装、合并、拼接、取消、Worker 失败、并发任务和清理行为。`tests/browser/benchmark.html` 会对所选文件串行执行三轮性能测量。

内置的第三方代码保留上游声明和独立的格式规范，同时仍接受完整的严格 TypeScript 检查。参见[迁移说明](./src/vendor/mediabunny/MIGRATION.md)和[第三方声明](./THIRD_PARTY_NOTICES.md)。

</details>

## 许可证

原创代码采用 [MIT](./LICENSE) 许可证，© 2026-PRESENT ntnyq。包含的 Mediabunny 衍生文件采用 [MPL-2.0](./src/vendor/mediabunny/LICENSE) 许可证，© 2026-present Vanilagy and contributors。npm 包同时包含两份许可证声明，以及经过修改的 MPL 源码子集的完整内容。
