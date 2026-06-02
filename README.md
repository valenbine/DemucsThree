# Demucs Three

Demucs V4 三轨（3-stem）音频分离工具，将音乐分离为 **人声（Vocal）**、**鼓组（Drum）** 和 **其他（Other）** 三个独立音轨。

## 功能特点

- 3 条音轨：Vocal / Drum / Other（Bass 自动合并至 Other）
- 支持文件上传和远程 URL
- 在线播放、进度同步、音量调节、一键下载
- Node.js 后端 + Python / Demucs 推理

## 快速开始

```bash
cd DemucsThree
npm install
PORT=3000 node server.js
```

打开 `http://localhost:3000` 即可使用。

## API

| Method | Endpoint | 说明 |
|--------|----------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/separate` | 分离音轨（表单 / JSON） |
| GET | `/api/download3/{jobId}/{stem}` | 下载指定音轨 |
