# Chordino Web 和弦识别

这是一个音乐和弦识别 Web 应用。用户上传音频后，后端优先通过 `sonic-annotator` 调用原生 Vamp Chordino 插件输出和弦时间轴；如果后端依赖不可用，前端会自动回退到浏览器端 Chordino 风格 chroma 识别流程。

## 功能

- 上传浏览器可解码的音频文件，如 mp3、wav、m4a、ogg
- 后端调用原生 Vamp Chordino 插件进行分析
- 提供 `/api/health` 检查 sonic-annotator 和 Chordino 插件状态
- 后端不可用时自动回退到浏览器端分析
- 输出主要和弦、和弦片段数量、音频时长
- 识别完成后展示歌曲调性、BPM、拍号和数据来源
- 展示 chroma 能量分布和和弦时间轴
- 支持下载 JSON 识别结果

## 运行

```bash
# 启动前后端一体服务
npm start
```

然后访问 `http://127.0.0.1:8000/`。

## 后端依赖

原生 Chordino 模式需要当前机器安装：

- `sonic-annotator`
- Vamp NNLS Chroma/Chordino 插件，通常提供 `vamp:nnls-chroma:chordino:simplechord` 输出
- Python 依赖 `librosa`，用于本地识别调性和 BPM
- 可选但推荐的 Python 依赖 `essentia`，用于增强拍号估算；不可用时自动回退到 librosa 启发式估算

当前项目提供了工作区内安装脚本，会下载官方 `sonic-annotator` Linux 64 位包和 Vamp Plugin Pack，并提取 `nnls-chroma.so`：

```bash
# 安装 Chordino / NNLS-Chroma 原生工具链
scripts/setup-chordino.sh
```

安装完成后，`server.js` 默认会使用 `.runtime/tools/sonic-annotator-1.7.0-linux64-static/squashfs-root/usr/bin/sonic-annotator`，并把 `VAMP_PATH` 指向 `.runtime/vamp`。`.runtime/` 不纳入版本控制，可随时通过脚本重新生成。

可以通过环境变量覆盖命令和 transform：

```bash
# 使用自定义 sonic-annotator 路径
SONIC_ANNOTATOR=/path/to/sonic-annotator npm start

# 使用自定义 Chordino transform
CHORDINO_TRANSFORM=vamp:nnls-chroma:chordino:simplechord npm start
```

健康检查接口：

```bash
curl http://127.0.0.1:8000/api/health
```

Python 依赖安装：

```bash
# 安装 librosa
pip install --break-system-packages -r requirements.txt
```

## 本地音频特征分析

识别完成后，前端会调用 `/api/audio-features` 上传音频，后端通过 `analyze_audio.py` 使用 librosa 和可选 Essentia 分析：

1. 使用 `librosa.beat.beat_track` 估算 BPM。
2. 使用 `librosa.feature.chroma_cqt` 加 Krumhansl-Schmuckler key profile 匹配估算调性。
3. 优先使用 `essentia.standard.RhythmExtractor2013(method="multifeature")` 提取 beat 序列和 confidence。
4. 基于 beat 序列的重音周期在 `3/4`、`4/4`、`6/8` 候选中启发式估算拍号。
5. 如果 Essentia 未安装或分析失败，自动回退到 librosa beat 序列做拍号估算。
6. 前端再调用 `/api/song-meta` 合并文件名解析与本地分析来源展示。

说明：Essentia 提供更稳定的 beat/BPM 信息，但当前仍不是专门的 meter detection 模型；拍号会带来源和置信度展示。

项目不再调用 Spotify、SongBPM、iTunes 或 MusicBrainz。

## 识别流程

1. 前端将音频作为 `multipart/form-data` 提交到 `/api/analyze`。
2. 后端保存上传文件，并执行原生 `sonic-annotator -d vamp:nnls-chroma:chordino:simplechord -w csv --csv-stdout <file>`。
3. Chordino 使用 NNLS Chroma 和默认 HMM/Viterbi 平滑输出和弦估计，后端解析 CSV 并返回统一 JSON，包括 `mainChord`、`duration`、`timeline` 和 `globalChroma`。
4. 前端调用 `/api/audio-features` 用 librosa 本地分析调性和 BPM，并优先用 Essentia 增强拍号估算。
5. 前端调用 `/api/song-meta` 合并文件名解析与本地分析来源信息。
6. 如果 `/api/analyze` 返回依赖缺失或执行错误，前端使用 Web Audio 与 chroma 模板匹配流程回退识别。

## 说明

当前仓库不自动安装系统级音频分析依赖。若 `sonic-annotator` 或 Chordino 插件缺失，页面会展示后端不可用状态，并继续使用浏览器端回退算法。
