# Demucs Three

Demucs V4 三轨（3-stem）音频分离工具，将音乐分离为 **人声（Vocal）**、**鼓组（Drum）** 和 **其他（Other）** 三个独立音轨。

## 功能特点

- 3 条音轨：Vocal / Drum / Other（Bass 自动合并至 Other）
- 支持文件上传和远程 URL
- 支持大文件流式上传，当前上传请求超时配置为 30 分钟
- 在线播放、进度同步、音量调节、一键下载 ZIP
- 结果文件保留期间，服务重启后可从磁盘恢复下载
- Node.js 后端 + Python / Demucs 推理

## 快速开始

```bash
cd DemucsThree
npm install
PORT=3000 node server.cjs
```

打开 `http://localhost:3000` 即可使用。

也可以使用 npm 脚本启动：

```bash
PORT=3000 npm run dev
```

## 大文件上传

文件上传接口使用 `busboy` 进行 multipart 流式解析，上传内容会直接写入 `.runtime/uploads`，避免把大文件整体读入内存。默认最大上传大小为 600MB，适合处理 400MB 级别音频文件。

上传完成后服务端返回 `jobId`，前端再通过 `/api/status/{jobId}` 轮询分轨进度。分轨完成后可下载单轨 WAV，也可通过 ZIP 一次性下载全部音轨。

## 下载结果

- 单轨下载：`/api/download3/{jobId}/{stem}`，其中 `stem` 可选 `vocal`、`drum`、`other`
- 全部下载：`/api/download/{jobId}/all?download=1`，返回包含三条音轨的 ZIP 文件
- 结果文件默认保留 1 小时，保留期间服务重启后仍可恢复下载

## API 使用说明

以下示例默认服务运行在 `http://localhost:3000`。

### 1. 健康检查

```bash
curl http://localhost:3000/api/health
```

成功响应：

```json
{
  "ok": true,
  "version": "available",
  "message": "Demucs 可用"
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | Demucs 是否可用 |
| `version` | string | 当前检测状态，例如 `available`、`initializing`、`not found` |
| `message` | string | 面向用户的状态说明 |

### 2. 获取可用模型

```bash
curl http://localhost:3000/api/models
```

响应示例：

```json
{
  "models": [
    {
      "id": "htdemucs",
      "name": "htdemucs (标准)",
      "stemCounts": [2, 4]
    }
  ]
}
```

当前 Web 页面默认使用 `htdemucs` 进行三轨输出：`vocal`、`drum`、`other`。

### 3. 上传本地文件并开始分轨

接口：`POST /api/separate`

请求类型：`multipart/form-data`

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | 音频文件，支持常见音频格式，例如 mp3、wav、m4a、ogg、flac |

示例：

```bash
curl -X POST http://localhost:3000/api/separate \
  -F "file=@/path/to/audio.wav"
```

成功响应：

```json
{
  "jobId": "sep_1780664859911_nnu9hb"
}
```

说明：

- 文件会以流式方式写入 `.runtime/uploads`。
- 默认最大上传大小为 600MB。
- 当前 HTTP 上传请求超时为 30 分钟。
- 返回 `jobId` 后，分轨任务在后台继续执行。
- 上传完成前，服务端会保持请求连接，适合前端显示上传进度。

### 4. 使用远程 URL 开始分轨

接口：`POST /api/separate`

请求类型：`application/json`

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 可公开访问的 `http` 或 `https` 音频地址 |

示例：

```bash
curl -X POST http://localhost:3000/api/separate \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/audio.mp3"}'
```

成功响应：

```json
{
  "jobId": "sep_1780664859911_nnu9hb"
}
```

说明：

- 服务端会先下载远程音频到本地，再执行分轨。
- 远程文件响应头中的 `Content-Length` 超过 600MB 时会被拒绝。

### 5. 查询任务状态

接口：`GET /api/status/{jobId}`

示例：

```bash
curl http://localhost:3000/api/status/sep_1780664859911_nnu9hb
```

处理中响应示例：

```json
{
  "status": "separating",
  "progress": 20,
  "model": "htdemucs",
  "stemCount": 3,
  "stems": {},
  "merges": {},
  "message": "处理中"
}
```

完成响应示例：

```json
{
  "status": "completed",
  "progress": 100,
  "model": "htdemucs",
  "stemCount": 3,
  "stems": {},
  "merges": {},
  "urls": {
    "vocal": "/api/download3/sep_1780664859911_nnu9hb/vocal",
    "drum": "/api/download3/sep_1780664859911_nnu9hb/drum",
    "other": "/api/download3/sep_1780664859911_nnu9hb/other",
    "jobId": "sep_1780664859911_nnu9hb"
  },
  "message": "分轨完成"
}
```

失败响应示例：

```json
{
  "status": "failed",
  "progress": 18,
  "error": "上传已中断。",
  "message": "处理中"
}
```

常见状态：

| 状态 | 说明 |
|------|------|
| `uploading` | 正在接收本地上传文件 |
| `downloading` | 正在下载远程 URL 文件 |
| `processing` | 文件已准备好，等待进入分轨流程 |
| `separating` | Demucs 正在分离音轨 |
| `merging` | 正在合并 Bass 和 Other 为三轨里的 Other |
| `completed` | 分轨完成，可以下载 |
| `failed` | 任务失败，查看 `error` 字段 |

### 6. 下载单条音轨

接口：`GET /api/download3/{jobId}/{stem}`

`stem` 可选值：

| stem | 说明 |
|------|------|
| `vocal` | 人声 |
| `drum` | 鼓组 |
| `other` | 其他，包含 Bass + Other 合并结果 |

在线播放或预览：

```bash
curl -L http://localhost:3000/api/download3/sep_1780664859911_nnu9hb/vocal -o vocal.wav
```

强制下载：

```bash
curl -L "http://localhost:3000/api/download3/sep_1780664859911_nnu9hb/vocal?download=1" -o vocal.wav
```

说明：

- 响应类型为 `audio/wav`。
- 支持 `Range` 请求，浏览器可以拖动播放进度。
- 结果文件保留期间，服务重启后仍可通过该接口恢复下载。

### 7. ZIP 下载全部音轨

接口：`GET /api/download/{jobId}/all?download=1`

示例：

```bash
curl -L "http://localhost:3000/api/download/sep_1780664859911_nnu9hb/all?download=1" -o stems.zip
```

ZIP 内容：

```text
vocal.wav
drum.wav
other.wav
```

说明：

- 响应类型为 `application/zip`。
- ZIP 文件名格式为 `stems_{jobId}.zip`。
- 三轨结果优先从 `job.stems3` 打包。
- 服务重启后，如果结果文件仍在 `.runtime/separated/{jobId}`，ZIP 下载可自动恢复。

### 8. 合并选中的音轨

接口：`POST /api/merge`

请求类型：`application/json`

用途说明：

- 该接口用于合并旧版 `/api/stems` 任务生成的音轨。
- 当前三轨 `/api/separate` 流程已经固定输出 `vocal`、`drum`、`other`，下载全部音轨请使用 ZIP 接口。
- `stems` 的值需要匹配 `/api/status/{jobId}` 响应里的 `stems` 字段名称。

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `jobId` | string | 是 | 已完成的任务 ID |
| `stems` | string[] | 是 | 要合并的音轨列表 |

示例：

```bash
curl -X POST http://localhost:3000/api/merge \
  -H "Content-Type: application/json" \
  -d '{"jobId":"job_1780664859911_nnu9hb","stems":["vocals","drums"]}'
```

成功响应：

```json
{
  "mergeId": "merged_1780665000000_abcd12",
  "stems": ["vocals", "drums"],
  "url": "/api/download/job_1780664859911_nnu9hb/merged_1780665000000_abcd12",
  "message": "合并完成。"
}
```

### 9. 旧版四轨接口

接口：`POST /api/stems`

该接口用于按模型支持的 2 轨或 4 轨方式分离，返回 `202` 和 `jobId`。当前 Web 页面主要使用 `/api/separate` 的三轨流程。

请求字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | 音频文件 |
| `model` | string | 否 | 模型 ID，默认 `htdemucs` |
| `stemCount` | number | 否 | 轨道数，默认 `4` |

示例：

```bash
curl -X POST http://localhost:3000/api/stems \
  -F "file=@/path/to/audio.wav" \
  -F "model=htdemucs" \
  -F "stemCount=4"
```

### 10. 常见错误响应

| HTTP 状态 | error | 场景 |
|----------|-------|------|
| 400 | `invalid_upload` | `/api/stems` 请求不是 multipart 上传 |
| 400 | `invalid_model_stem_count` | `/api/stems` 的模型和轨道数量组合无效 |
| 400 | `invalid_content_type` | `/api/separate` 请求类型既不是 JSON，也不是 multipart |
| 400 | `missing_file` | multipart 请求中没有 `file` 字段 |
| 400 | `missing_url` | JSON 请求中没有 `url` 字段 |
| 400 | `invalid_url` | `url` 不是有效的 http(s) 地址 |
| 400 | `missing_stems` | `/api/merge` 没有提供可合并的音轨 |
| 404 | `job_not_found` | 查询的任务不存在或已过期 |
| 404 | `not_ready` | 分轨结果未完成或不存在 |
| 404 | `job_not_ready` | `/api/merge` 对应任务未完成或不存在 |
| 404 | `stem_not_found` | 请求的音轨名无效 |
| 404 | `file_not_found` | 音轨结果文件不存在 |
| 413 | `file_too_large` | 上传文件超过大小限制 |
| 500 | `separate_failed` | 上传、下载或分轨流程失败 |
| 500 | `stems_failed` | `/api/stems` 分轨流程失败 |
| 500 | `merge_failed` | 音轨合并失败 |

## 许可

本项目代码采用 MIT License，详见 [LICENSE](./LICENSE)。

本项目基于 Demucs 提供音频分离能力，通过本地 Python / Demucs 命令执行模型推理。Demucs 是由 Meta Platforms, Inc. and affiliates 发布的开源项目，同样采用 MIT License。

Demucs 上游项目：<https://github.com/facebookresearch/demucs>

使用、分发或打包本项目时，请同时遵守本项目许可、Demucs 上游许可，以及 PyTorch、FFmpeg、Node.js 依赖和模型权重各自适用的许可条款。
