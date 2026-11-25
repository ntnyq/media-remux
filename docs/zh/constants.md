# 公开常量

[English](../constants.md) · 简体中文

[文档首页](./README.md) · [核心 API](./core.md) · [Worker API](./browser.md) · [存储适配器](./storage.md)

所有常量均从 `media-remux` 具名导入。成员在 TypeScript 中保留只读字面量类型，可用于构造任务和匹配进度、输出格式或错误码。

## `MEDIA_JOB_OPERATION`

用于 [`MediaJob.operation`](./browser.md#mediajob)。

| 成员      | 值          | 用途                           |
| --------- | ----------- | ------------------------------ |
| `remux`   | `'remux'`   | 重新封装单个输入。             |
| `combine` | `'combine'` | 从两个输入合并主视频和主音轨。 |
| `concat`  | `'concat'`  | 拼接按播放顺序排列的片段。     |

## `REMUX_TRACK_SELECTION`

| 成员                          | 值                                  |
| ----------------------------- | ----------------------------------- |
| `all`                         | `'all'`                             |
| `video`                       | `'video'`                           |
| `audio`                       | `'audio'`                           |
| `videoWithOptionalAudio`      | `'video-with-optional-audio'`       |
| `firstVideoWithOptionalAudio` | `'first-video-with-optional-audio'` |

各成员的选轨规则见 [`RemuxTrackSelection`](./core.md#remuxtrackselection)。

## `REMUX_PROGRESS_PHASE`

| 成员       | 值           | 阶段                                 |
| ---------- | ------------ | ------------------------------------ |
| `inspect`  | `'inspect'`  | 检查输入、轨道与时间信息。           |
| `remux`    | `'remux'`    | 写入编码包。                         |
| `finalize` | `'finalize'` | 写入余下的容器元数据并准备提交输出。 |

进度字段见 [`RemuxProgress`](./core.md#remuxprogress)。

## `REMUX_MIME_TYPE`

| 成员    | 值            | 输出           |
| ------- | ------------- | -------------- |
| `audio` | `'audio/mp4'` | 纯音频 M4A。   |
| `video` | `'video/mp4'` | 含视频的 MP4。 |

用于 [`RemuxResult.mimeType`](./core.md#remuxresult)。

## `REMUX_ERROR_CODE`

| 成员                      | 值                            |
| ------------------------- | ----------------------------- |
| `unsupportedContainer`    | `'UNSUPPORTED_CONTAINER'`     |
| `unsupportedCodec`        | `'UNSUPPORTED_CODEC'`         |
| `unsupportedMediaFeature` | `'UNSUPPORTED_MEDIA_FEATURE'` |
| `incompatibleSegments`    | `'INCOMPATIBLE_SEGMENTS'`     |
| `invalidInput`            | `'INVALID_INPUT'`             |
| `missingRequiredTrack`    | `'MISSING_REQUIRED_TRACK'`    |

错误语义和窄化示例见[错误处理](./errors.md)。

## `FRAGMENT_SAMPLE_TYPE`

用于 [`FragmentSample.type`](./storage.md#fragmentsample)。

| 成员    | 值        | 含义                         |
| ------- | --------- | ---------------------------- |
| `key`   | `'key'`   | 标记为同步采样，可独立解码。 |
| `delta` | `'delta'` | 依赖其他采样。               |

## `FRAGMENT_SAMPLE_FILE_KIND`

用于 [`createDiskFragmentSamples`](./storage.md#creatediskfragmentsamples) 的文件打开器。

| 成员      | 值          | 用途                           |
| --------- | ----------- | ------------------------------ |
| `records` | `'records'` | 定长采样描述符。               |
| `media`   | `'media'`   | 编码载荷。                     |
| `sortA`   | `'sort-a'`  | 外部归并排序的临时文件之一。   |
| `sortB`   | `'sort-b'`  | 外部归并排序的另一个临时文件。 |
