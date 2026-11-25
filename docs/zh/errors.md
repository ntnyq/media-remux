# 错误处理

[English](../errors.md) · 简体中文

[文档首页](./README.md) · [核心 API](./core.md) · [Worker API](./browser.md) · [媒体兼容性](./compatibility.md)

## `isRemuxError`

```ts
function isRemuxError(value: unknown): value is RemuxError
```

从 `media-remux` 具名导入。候选值必须是带有已知媒体错误码的 `Error` 实例。返回 `true` 时，TypeScript 将其收窄为 `RemuxError`。

## `RemuxError` 和 `RemuxErrorCode`

```ts
type RemuxErrorCode = (typeof REMUX_ERROR_CODE)[keyof typeof REMUX_ERROR_CODE]

interface RemuxError extends Error {
  readonly code: RemuxErrorCode
}
```

调用方可以按 `code` 做本地化或选择兼容处理流程，`message` 用于诊断。每个错误码都有对应的 [`REMUX_ERROR_CODE`](./constants.md#remux_error_code) 成员。

| 错误码                      | 含义                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `UNSUPPORTED_CONTAINER`     | 输入容器无法识别或不受支持。                                                                     |
| `UNSUPPORTED_CODEC`         | 所选轨道的编码或编码配置不受支持。                                                               |
| `UNSUPPORTED_MEDIA_FEATURE` | 输入特性或运行时能力不受支持，例如某些 MP4 编辑列表、所选轨道加密或 WebCodecs AAC 编码能力缺失。 |
| `INCOMPATIBLE_SEGMENTS`     | 两个片段的所选轨道布局或配置无法写入同一输出。                                                   |
| `INVALID_INPUT`             | 输入为空、结构损坏或媒体时间等校验失败。                                                         |
| `MISSING_REQUIRED_TRACK`    | 缺少任务或轨道选项所要求的音轨或视频轨。                                                         |

## 其他失败

- 非法参数可能抛出未附媒体错误码的 `TypeError`，例如空的拼接列表或无效的合并偏移。
- 流、配额、存储 I/O、Worker 启动或通信失败以及进度回调异常也会使任务拒绝。跨 Worker 的任务错误表现为 `Error`，保留名称、消息及可用媒体错误码。
- 核心任务在输出提交前取消时传递原始 `signal.reason`。Worker 任务在清理成功时也传递该原因；如果任务和目录清理同时失败，可通过 `AggregateError.errors` 查看两项失败。

## 将已知错误映射为 UI 文案

```ts
import { isRemuxError, REMUX_ERROR_CODE } from 'media-remux'

export function getMediaErrorMessage(error: unknown): string {
  if (isRemuxError(error)) {
    switch (error.code) {
      case REMUX_ERROR_CODE.incompatibleSegments:
        return '片段的轨道或编码配置不兼容。'
      case REMUX_ERROR_CODE.missingRequiredTrack:
        return '输入缺少所选的音轨或视频轨。'
      default:
        return error.message
    }
  }

  return error instanceof Error ? error.message : String(error)
}
```

[结合取消和资源释放的示例](./examples.md#显示进度并取消任务)
