# 核心 API

[English](../core.md) · 简体中文

[文档首页](./README.md) · [浏览器 Worker API](./browser.md) · [示例](./examples.md)

从 `media-remux` 具名导入。核心函数在当前执行上下文中运行，接受调用方提供的按位置写入流与临时存储，并返回处理摘要。

## 函数

### `remuxMedia`

```ts
function remuxMedia(
  input: RemuxInput,
  options: RemuxOptions,
): Promise<RemuxResult>
```

从一个非空输入中选取主轨道，写入分片 MP4 或纯音频 M4A。通过 `options.tracks` 控制轨道选择。最早的可播放时间归零，保留轨道间偏移。以依赖帧开头的 H.264 MP4 会裁切到第一个确认含 IDR 图像的同步样本。[单文件与仅音频示例](./examples.md#任务示例)

### `combineTracks`

```ts
function combineTracks(
  video: RemuxInput,
  audio: RemuxInput,
  options: CombineOptions,
): Promise<RemuxResult>
```

从 `video` 取主视频轨道，从 `audio` 取主音轨。两者都必须存在，缺轨时报告 `MISSING_REQUIRED_TRACK`。输出为 `video/mp4`。输入共用时间轴时可使用默认行为，独立录制的文件可以通过 `timeline` 对齐或补偿偏移。[独立音视频示例](./examples.md#任务示例)

### `concatMedia`

```ts
function concatMedia(
  inputs: readonly Blob[],
  options: RemuxOptions,
): Promise<RemuxResult>
```

按传入顺序拼接非空数组。每个 `Blob` 都应包含可独立读取的媒体片段，函数在写入输出前检查各片段的所选轨道和时间信息，并将每段最早的可播放时间接到上一段的呈现末尾。复制模式下，轨道布局和解码配置必须匹配。启用音频规范化可放宽音轨的匹配要求。[拼接规则](./compatibility.md#拼接和音频规范化)

## `RemuxInput` 和 `MpegTsInput`

```ts
type RemuxInput = Blob | MpegTsInput

interface MpegTsInput {
  blob: Blob
  segmentOffsets: readonly number[]
  allowContinuityCounterReset?: boolean
}
```

| 输入                                      | 约定                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Blob`（含 `File`）                       | 非空的完整 MP4、FLV、MKV 或 MPEG-TS。容器根据字节内容识别。                                                      |
| `MpegTsInput.blob`                        | 由按顺序排列的 TS 分片组成的一条完整 MPEG-TS 字节流。                                                            |
| `MpegTsInput.segmentOffsets`              | 各分片在 `blob` 中的绝对字节起始位置。首项必须是 `0`，其余值严格递增，全部为小于 `blob.size` 的 188 字节整数倍。 |
| `MpegTsInput.allowContinuityCounterReset` | 可选，默认 `false`。启用后，满足 PES 完整性条件的分片边界允许所选 PID 的首个有效载荷重置连续计数器。             |

描述符可用于 `remuxMedia`、`combineTracks` 及其对应的 Worker 任务。拼接 API 的公开输入类型为 `readonly Blob[]`。[TS 分片边界规则](./compatibility.md#mpeg-ts-分片边界) · [构造描述符示例](./examples.md#保留-mpeg-ts-分片边界)

## `RemuxOptions`

| 字段             | 类型                                | 默认值及行为                                                                                                  |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `writable`       | `WritableStream<MediaOutputChunk>`  | 必填。接收按绝对位置写入的输出块，等待写入完成提供背压。                                                      |
| `storage`        | `RemuxStorage`                      | 必填。每个任务使用新建且独占的临时存储，由调用方释放。                                                        |
| `tracks`         | `RemuxTrackSelection`               | 可选，默认 `REMUX_TRACK_SELECTION.all`。用于重新封装和拼接。                                                  |
| `normalizeAudio` | `boolean`                           | 可选，默认 `false`。启用后将所选单声道或双声道音频编码为连续的 48 kHz 双声道 AAC-LC。视频仍走编码包复制路径。 |
| `signal`         | `AbortSignal`                       | 可选。在检查、复制、存储和提交之前检查取消，取消时传递原始 `signal.reason`。                                  |
| `onProgress`     | `(progress: RemuxProgress) => void` | 可选。在当前执行上下文中同步调用。抛错会使任务失败，回调返回的 Promise 不会被等待。                           |

任务开始时捕获顶层选项、输入列表及描述符偏移数组等配置。传入的信号、输出流和存储资源持续使用原有引用。

### `RemuxTrackSelection`

`RemuxTrackSelection` 是 `REMUX_TRACK_SELECTION` 各值的联合类型。

| 常量成员                       | 值                                  | 选择规则                                                                 |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------ |
| `.all`                         | `'all'`                             | 保留可用的主视频和主音轨。                                               |
| `.video`                       | `'video'`                           | 仅保留主视频，要求输入包含可用的视频轨道。                               |
| `.audio`                       | `'audio'`                           | 仅保留主音轨，要求输入包含可用的音轨。                                   |
| `.videoWithOptionalAudio`      | `'video-with-optional-audio'`       | 要求每个输入有主视频，存在主音轨时一并保留。                             |
| `.firstVideoWithOptionalAudio` | `'first-video-with-optional-audio'` | 按容器中的顺序选择首条视频和可选的首条音轨。选中的轨道仍须符合编码要求。 |

可选音轨表示单段可以缺音轨。复制模式下，各段所选轨道布局仍须匹配。[不同音轨或缺轨的拼接](./compatibility.md#拼接和音频规范化)

## `CombineOptions` 和 `CombineTimeline`

```ts
type CombineTimeline =
  | 'align-starts'
  | { videoOffset?: number; audioOffset?: number }

interface CombineOptions extends Omit<RemuxOptions, 'tracks'> {
  timeline?: CombineTimeline
}
```

| `timeline`                       | 时间处理                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 省略                             | 适合共用时间轴的输入。将最早可播放时间归零，并保留原有音视频偏移。                                                  |
| `'align-starts'`                 | 分别将两条轨道的可播放起点对齐到零，适合独立时间轴。视频起点以必要的关键帧裁切后为准。                              |
| `{ videoOffset?, audioOffset? }` | 将有限的有符号偏移量加到各自轨道的 PTS 和 DTS，单位为秒。字段默认 `0`，正值推迟该轨道。调整后将最早可播放时间归零。 |

在共用时间轴上进行 H.264 起点裁切时，音频也会按视频的可播放起点裁切。使用偏移对象时，以偏移后的时间确定裁切点。[时间戳与裁切规则](./compatibility.md#时间戳和裁切)

## `RemuxResult`

| 字段             | 类型                         | 说明                                                                                              |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `duration`       | `number`                     | 输出呈现跨度，单位为秒。拼接时为各段呈现跨度之和。                                                |
| `bytesProcessed` | `number`                     | 写入的编码载荷字节数，省略容器头和索引开销。对实际文件大小使用 `File.size` 或输出目标提供的大小。 |
| `mimeType`       | `'video/mp4' \| 'audio/mp4'` | 存在视频轨道时为 `video/mp4`，纯音频为 `audio/mp4`。                                              |

## `RemuxProgress`

| 字段             | 类型                                 | 说明                                                                                                      |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `phase`          | `'inspect' \| 'remux' \| 'finalize'` | 分别表示检查输入及时间信息、写入编码包、完成容器元数据。                                                  |
| `bytesProcessed` | `number`                             | 累计编码载荷字节数，`inspect` 阶段为零。                                                                  |
| `segmentIndex`   | `number`                             | 检查和写入阶段是从零开始的片段索引，`finalize` 阶段是已写入的片段数。单输入和轨道合并任务的收尾值为 `1`。 |

进度适合显示阶段和累计写入量。读取、时间轴预检、音频规范化和收尾还会消耗时间，输入文件大小只能作为业务侧估算的参考。

## `MediaOutputChunk` 与输出生命周期

```ts
interface MediaOutputChunk {
  type: 'write'
  position: number
  data: Uint8Array<ArrayBuffer>
}
```

`position` 是输出文件内的绝对字节偏移。写入可能回到较早的位置，目标须支持覆盖写入。`data` 是要写入该位置的容器字节。

- 成功时核心函数关闭流并释放锁，调用方可以读取输出。
- 预检失败时调用方负责关闭或中止已打开的目标。写入阶段失败时库尝试中止流并释放锁。
- 关闭流之前仍可取消。开始关闭之后，任务结果取决于输出目标的提交结果。
- 在 `finally` 中等待[临时存储](./storage.md)释放，并由调用方管理临时目录和输出文件。

失败时 Promise 拒绝，具体包括[媒体错误](./errors.md)、非法参数、取消、存储或输出 I/O 失败以及进度回调抛错。
