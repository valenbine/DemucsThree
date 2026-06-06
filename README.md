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

## API

| Method | Endpoint | 说明 |
|--------|----------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/separate` | 分离音轨（表单 / JSON） |
| GET | `/api/download3/{jobId}/{stem}` | 下载指定音轨 |
| GET | `/api/download/{jobId}/all?download=1` | 打包下载全部音轨 ZIP |
