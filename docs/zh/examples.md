# TypeScript 使用示例

[English](../examples.md) · 简体中文

[文档首页](./README.md) · [核心 API](./core.md) · [Worker API](./browser.md) · [存储适配器](./storage.md)

## 保存 Worker 输出

在支持模块 Worker URL 的浏览器项目中，将 `remux.worker.ts` 和 `media-jobs.ts` 放在同一目录。如果项目有自己的 Worker 入口约定，可替换为项目现有的 Worker 工厂。

```ts
// remux.worker.ts
import { installMediaWorker } from 'media-remux/worker'

installMediaWorker()
```

下面的浏览器函数接收应用提供的目标文件句柄，将结果流式写入目标，再清理任务目录。

```ts
// media-jobs.ts
import { runMediaJob } from 'media-remux'
import type { MediaJob, MediaJobOptions, RemuxResult } from 'media-remux'

export async function saveMediaJob(
  job: MediaJob,
  destination: FileSystemFileHandle,
  options: Omit<MediaJobOptions, 'createWorker'> = {},
): Promise<RemuxResult> {
  const { file, dispose, ...result } = await runMediaJob(job, {
    ...options,
    createWorker: () =>
      new Worker(new URL('./remux.worker.ts', import.meta.url), {
        type: 'module',
      }),
  })

  try {
    await file.stream().pipeTo(await destination.createWritable())

    return result
  } finally {
    await dispose()
  }
}
```

目标可以是应用管理的 OPFS 文件，也可以是用户选中的可写文件。纯音频任务使用 `.m4a`，含视频的任务使用 `.mp4`。关于库返回的文件名和生命周期，参见 [`MediaJobResult`](./browser.md#mediajobresult)。

## 任务示例

从应用传入 `File` 或 `Blob`。下列示例调用上面的保存函数。

```ts
import { MEDIA_JOB_OPERATION, REMUX_TRACK_SELECTION } from 'media-remux'
import type { MediaJob } from 'media-remux'
import { saveMediaJob } from './media-jobs'

export function remuxFile(input: File, destination: FileSystemFileHandle) {
  return saveMediaJob(
    { operation: MEDIA_JOB_OPERATION.remux, input },
    destination,
  )
}

export function extractAudio(input: File, destination: FileSystemFileHandle) {
  const job = {
    operation: MEDIA_JOB_OPERATION.remux,
    input,
    tracks: REMUX_TRACK_SELECTION.audio,
  } satisfies MediaJob

  return saveMediaJob(job, destination)
}

export function combineRecordings(
  video: File,
  audio: File,
  destination: FileSystemFileHandle,
) {
  return saveMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.combine,
      video,
      audio,
      timeline: 'align-starts',
    },
    destination,
  )
}

export function joinClips(
  inputs: readonly File[],
  destination: FileSystemFileHandle,
) {
  return saveMediaJob(
    {
      operation: MEDIA_JOB_OPERATION.concat,
      inputs,
      tracks: REMUX_TRACK_SELECTION.videoWithOptionalAudio,
      normalizeAudio: true,
    },
    destination,
  )
}
```

录制源共用时间轴时，可省略 `timeline`。需要按已知秒数调整轨道时，可传入偏移对象，例如 `{ audioOffset: 0.25 }`。拼接示例要求视频配置兼容，并可使用 WebCodecs 音频编码。片段的轨道布局和音频配置一致时，可省略 `normalizeAudio` 以直接复制音频编码包。[时间轴选项](./core.md#combineoptions-和-combinetimeline) · [拼接要求](./compatibility.md#拼接和音频规范化)

## 显示进度并取消任务

将取消按钮控制的信号传给任务，并在进度回调中更新状态元素。该信号作用于 Worker 任务。Worker 任务成功后，才开始写入目标文件。

```ts
import { MEDIA_JOB_OPERATION } from 'media-remux'
import { saveMediaJob } from './media-jobs'

export async function remuxWithProgress(
  input: File,
  destination: FileSystemFileHandle,
  cancelButton: HTMLButtonElement,
  status: HTMLElement,
) {
  const controller = new AbortController()
  const cancel = () => controller.abort()

  cancelButton.addEventListener('click', cancel)

  try {
    return await saveMediaJob(
      { operation: MEDIA_JOB_OPERATION.remux, input },
      destination,
      {
        signal: controller.signal,
        onProgress: ({ phase, bytesProcessed }) => {
          status.textContent = `${phase} · ${bytesProcessed.toLocaleString()} B`
        },
      },
    )
  } catch (error) {
    if (controller.signal.aborted && error === controller.signal.reason) {
      return
    }

    throw error
  } finally {
    cancelButton.removeEventListener('click', cancel)
  }
}
```

示例通过原始取消原因识别取消操作，清理失败仍会传递给调用方。参见[错误处理](./errors.md#其他失败)和[进度字段](./core.md#remuxprogress)。

## 保留 MPEG-TS 分片边界

将同一条流中按顺序排列的分片封装为 `MpegTsInput`。调用方可选择是否允许在提供的边界重置连续计数器。

```ts
import type { MpegTsInput } from 'media-remux'

export function describeTransportStream(
  parts: readonly Blob[],
  allowContinuityCounterReset = false,
): MpegTsInput {
  if (parts.length === 0) {
    throw new TypeError('Supply at least one TS segment.')
  }

  let length = 0
  const segmentOffsets = parts.map(part => {
    if (part.size === 0 || part.size % 188 !== 0) {
      throw new TypeError(
        'Each TS segment must be nonempty and packet-aligned.',
      )
    }

    const start = length
    length += part.size

    return start
  })

  return {
    blob: new Blob([...parts], { type: 'video/mp2t' }),
    segmentOffsets,
    allowContinuityCounterReset,
  }
}
```

可将描述符作为 `remux` 任务的 `input`、`combine` 任务的任一输入，或传给对应的核心函数。如果已经把分片顺序写入一个 OPFS 文件，将该文件作为 `blob`，并提供写入时记录的各分片起始偏移。[边界校验规则](./compatibility.md#mpeg-ts-分片边界)

## Worker 中直接调用核心 API

从自己的专用 Worker 调用此函数。为临时文件提供一个独占的 OPFS 目录，并将输出文件放在该目录之外，便于独立管理两者的生命周期。

```ts
import { createOpfsStorage, remuxMedia } from 'media-remux'
import type { MediaOutputChunk, RemuxInput } from 'media-remux'

export async function remuxToFile(
  input: RemuxInput,
  output: FileSystemFileHandle,
  spoolDirectory: FileSystemDirectoryHandle,
) {
  const storage = createOpfsStorage(spoolDirectory)

  try {
    const fileStream = await output.createWritable()
    const writable = new WritableStream<MediaOutputChunk>({
      write: chunk => fileStream.write(chunk),
      close: () => fileStream.close(),
      abort: reason => fileStream.abort(reason),
    })

    try {
      return await remuxMedia(input, { writable, storage })
    } catch (error) {
      await writable.abort(error)

      throw error
    }
  } finally {
    await storage.dispose()
  }
}
```

错误路径中的 `abort` 也能处理预检失败，此时核心 API 尚未打开包装后的流。函数结束后，由调用方删除临时目录。[输出生命周期](./core.md#mediaoutputchunk-与输出生命周期) · [OPFS 存储](./storage.md#createopfsstorage)

## 在 Node 中使用自定义文件适配器

这个 ESM 示例使用 Node 文件 API 复制编码轨道。它以文件为后端打开输入 Blob，以独占方式创建输出，并处理按位置写入时的部分写入。复制模式使用核心 API 和 Web Streams。请使用项目支持的 Node 版本。

```ts
import { openAsBlob } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDiskFragmentIndex,
  createDiskFragmentSamples,
  remuxMedia,
} from 'media-remux'
import type { MediaOutputChunk } from 'media-remux'

async function openTemporaryFile(path: string) {
  const file = await open(path, 'w+')

  return {
    async read(data: Uint8Array<ArrayBuffer>, position: number) {
      return (await file.read(data, 0, data.length, position)).bytesRead
    },
    async write(data: Uint8Array<ArrayBuffer>, position: number) {
      return (await file.write(data, 0, data.length, position)).bytesWritten
    },
    truncate: (size: number) => file.truncate(size),
    close: () => file.close(),
  }
}

export async function remuxNodeFile(inputPath: string, outputPath: string) {
  const input = await openAsBlob(inputPath)
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-'))
  const fragmentIndex = createDiskFragmentIndex(async trackId => ({
    ...(await openTemporaryFile(join(directory, `${trackId}.index`))),
    seal: () => Promise.resolve(),
  }))
  const fragmentSamples = createDiskFragmentSamples((trackId, kind) =>
    openTemporaryFile(join(directory, `${trackId}-${kind}.bin`)),
  )

  try {
    const output = await open(outputPath, 'wx')

    try {
      await using file = output
      const writable = new WritableStream<MediaOutputChunk>({
        async write({ data, position }) {
          let offset = 0

          while (offset < data.length) {
            const { bytesWritten } = await file.write(
              data,
              offset,
              data.length - offset,
              position + offset,
            )
            if (bytesWritten === 0) {
              throw new Error('Output write made no progress.')
            }
            offset += bytesWritten
          }
        },
      })

      return await remuxMedia(input, {
        writable,
        storage: { fragmentIndex, fragmentSamples },
      })
    } catch (error) {
      await rm(outputPath, { force: true })

      throw error
    }
  } finally {
    try {
      const results = await Promise.allSettled([
        fragmentIndex.dispose(),
        fragmentSamples.dispose(),
      ])
      const failure = results.find(result => result.status === 'rejected')

      if (failure) {
        throw failure.reason
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
```

Node 的按位置写入完成后，同一文件句柄可直接读取这些字节，索引的 `seal()` 因此可以立即兑现。`await using` 会在退出作用域时关闭输出句柄。目标路径必须尚未使用，任务期间应保持输入文件内容不变。[磁盘适配器约定](./storage.md#creatediskfragmentstore)
