# media-remux 文档

[English](../README.md) · 简体中文

media-remux 将 MP4、FLV、MKV 或 MPEG-TS 中的主轨道写入分片 MP4。默认复制编码包，纯音频结果使用 M4A。需要拼接不同音频配置的片段时，可以启用 WebCodecs 音频规范化。

## 入门

```sh
pnpm add media-remux
```

- 浏览器应用可以从 [Worker 快速开始](./examples.md#保存-worker-输出) 入手，由 `runMediaJob` 管理 Worker 和 OPFS 临时文件。
- 自己管理输出流或存储时，使用[核心 API](./core.md)。参见 [Worker 中的 OPFS 接入](./examples.md#worker-中直接调用核心-api)和 [Node 文件适配示例](./examples.md#在-node-中使用自定义文件适配器)。
- 选择操作之前，参阅[媒体格式和兼容性](./compatibility.md)。性能测量见[浏览器性能基线](./performance.md)。

## 公开导出

包提供 ESM 和 TypeScript 类型声明。函数和常量使用具名导入，类型可用 `import type` 导入。

可以通过 `media-remux/package.json` 读取包元数据。

| 入口                 | 类别                                           | 导出                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media-remux`        | [核心函数](./core.md#函数)                     | `remuxMedia`、`combineTracks`、`concatMedia`                                                                                                                                             |
| `media-remux`        | [核心类型](./core.md)                          | `RemuxInput`、`MpegTsInput`、`RemuxOptions`、`CombineOptions`、`CombineTimeline`、`RemuxTrackSelection`、`RemuxResult`、`RemuxProgress`、`MediaOutputChunk`                              |
| `media-remux`        | [浏览器任务](./browser.md)                     | `runMediaJob`、`MediaJob`、`MediaJobOptions`、`MediaJobResult`                                                                                                                           |
| `media-remux`        | [存储工厂](./storage.md)                       | `createOpfsStorage`、`createDiskFragmentStore`、`createDiskFragmentIndex`、`createDiskFragmentSamples`                                                                                   |
| `media-remux`        | [存储类型](./storage.md)                       | `RemuxStorage`、`DisposableRemuxStorage`、`FragmentStoreFile`、`FragmentStore`、`FragmentIndexFile`、`FragmentIndexStore`、`FragmentSampleFile`、`FragmentSample`、`FragmentSampleStore` |
| `media-remux`        | [错误处理](./errors.md)                        | `isRemuxError`、`RemuxError`、`RemuxErrorCode`                                                                                                                                           |
| `media-remux`        | [常量](./constants.md)                         | `MEDIA_JOB_OPERATION`、`REMUX_TRACK_SELECTION`、`REMUX_PROGRESS_PHASE`、`REMUX_MIME_TYPE`、`REMUX_ERROR_CODE`、`FRAGMENT_SAMPLE_TYPE`、`FRAGMENT_SAMPLE_FILE_KIND`                       |
| `media-remux/worker` | [Worker 入口](./browser.md#installmediaworker) | `installMediaWorker`、`MediaWorkerScope`                                                                                                                                                 |

[项目 README](../../README.zh-CN.md) · [TypeScript 示例](./examples.md)
