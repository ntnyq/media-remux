# 浏览器 Worker API

[English](../browser.md) · 简体中文

[文档首页](./README.md) · [核心 API](./core.md) · [Worker 示例](./examples.md#保存-worker-输出)

## `runMediaJob`

```ts
function runMediaJob(
  job: MediaJob,
  options: MediaJobOptions,
): Promise<MediaJobResult>
```

从 `media-remux` 导入。每次调用在专用 Worker 中运行一个任务，创建独立的临时目录，并管理目录内的输出和中间文件。浏览器需支持安全上下文、模块 Worker、OPFS（源私有文件系统）及专用 Worker 中的 OPFS 同步访问句柄。

`runMediaJob` 会在成功、失败或取消时终止该任务的 Worker。成功后保留输出文件，供调用方读取或保存。失败或取消时移除整个任务子目录。任务在设置可用目录之后才创建 Worker。

## `MediaJob`

由 `operation` 区分的联合类型。可用 [`MEDIA_JOB_OPERATION`](./constants.md#media_job_operation) 构造任务，或给对象添加 `satisfies MediaJob` 来检查字段。

| `operation` | 必填字段                                 | 专属可选字段                   | 对应核心函数                               |
| ----------- | ---------------------------------------- | ------------------------------ | ------------------------------------------ |
| `'remux'`   | `input: RemuxInput`                      | `tracks?: RemuxTrackSelection` | [`remuxMedia`](./core.md#remuxmedia)       |
| `'combine'` | `video: RemuxInput`、`audio: RemuxInput` | `timeline?: CombineTimeline`   | [`combineTracks`](./core.md#combinetracks) |
| `'concat'`  | `inputs: readonly Blob[]`                | `tracks?: RemuxTrackSelection` | [`concatMedia`](./core.md#concatmedia)     |

三种任务都可传 `normalizeAudio?: boolean`，默认 `false`。缺省的 `tracks` 为 `'all'`，缺省的 `timeline` 保留相对时间。任务提交时会捕获字段和片段顺序。[音频规范化要求](./compatibility.md#拼接和音频规范化)

## `MediaJobOptions`

| 字段           | 类型                                | 说明                                                                                                                                 |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createWorker` | `() => Worker`                      | 必填。每次返回一个新建的专用 Worker，入口应调用 `installMediaWorker()`。Worker 由这次任务独占。                                      |
| `directory`    | `FileSystemDirectoryHandle`         | 可选，默认为当前源的 OPFS 根目录。库在下面创建唯一任务子目录，调用方继续管理父目录。                                                 |
| `signal`       | `AbortSignal`                       | 可选。取消会终止 Worker，包括正在进行的同步解析或 I/O，并触发目录清理。                                                              |
| `onProgress`   | `(progress: RemuxProgress) => void` | 可选。在调用线程收到通知，`remux` 消息在 Worker 内以 250 ms 间隔节流，阶段变化即时发送。同步抛错会使任务失败，异步返回值不会被等待。 |

部分浏览器无法结构化克隆文件句柄。遇到 `DataCloneError` 时，库尝试从 Worker 的 OPFS 根目录按路径重开任务目录。传入自定义父目录时，该回退要求任务目录可以通过同一 OPFS 根目录解析。

## `MediaJobResult`

继承 [`RemuxResult`](./core.md#remuxresult) 的 `duration`、`bytesProcessed` 和 `mimeType`，另有两个成员。

| 成员      | 类型                  | 说明                                                                                                             |
| --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `file`    | `File`                | 有视频时为 `output.mp4`（`video/mp4`），纯音频为 `output.m4a`（`audio/mp4`）。在释放任务目录前读取、播放或保存。 |
| `dispose` | `() => Promise<void>` | 删除任务目录及输出文件。并发释放共享一次清理，成功后可以重复调用，删除失败后可以重试。                           |

Promise 兑现时 Worker 已终止，临时存储已清理。消费 `file` 后，在 `finally` 中等待 `dispose()`。如果用对象 URL 播放，应在结束使用后撤销 URL，再释放任务目录。浏览器或标签页崩溃后遗留的目录由应用清理。

取消且清理成功时，Promise 以 `signal.reason` 拒绝。媒体错误跨线程后保留错误的名称、消息和可用错误码。任务与目录清理同时失败时，Promise 以包含两者的 `AggregateError` 拒绝。[错误处理](./errors.md)

## `installMediaWorker`

```ts
function installMediaWorker(scope?: MediaWorkerScope): () => void
```

从 `media-remux/worker` 导入，在专用 Worker 的入口调用一次，默认使用 Worker 的 `globalThis`。每次安装接收一条任务请求，首条无效消息也会占用这个名额。执行过程中向父线程发送进度，临时存储关闭后发送完成响应，失败则在尝试清理后发送错误响应。

返回的同步函数用于移除消息监听器。已经开始的任务继续执行，Worker 的终止由父线程管理。注册监听器失败会同步抛错。任务入口需要显式调用此函数来安装监听器。

### `MediaWorkerScope`

从 `media-remux/worker` 使用 `import type` 导入。自定义宿主和测试可提供最小消息接口。

| 成员                                  | 参数和约定                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `addEventListener(type, listener)`    | `type` 为 `'message'`，监听器类型为 `(event: MessageEvent<unknown>) => void`。同步注册。 |
| `removeEventListener(type, listener)` | 传同一个事件名和监听器引用，同步移除。                                                   |
| `postMessage(message)`                | 发送可结构化克隆的进度、完成或错误响应。返回 `void`，父线程异步收到消息。                |

业务代码使用 `runMediaJob` 与 Worker 通信。实现宿主时可通过 `Parameters<MediaWorkerScope['postMessage']>[0]` 引用接口的响应参数类型。
