const { spawn } = require("node:child_process");
const { appendFileSync, createReadStream, createWriteStream, mkdirSync, unlink, existsSync } = require("node:fs");
const { mkdir: mkdirAsync, stat, readdir } = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const archiver = require("archiver");
const Busboy = require("busboy");

const MODULE_ROOT = __dirname;
const APP_ROOT = process.pkg
  ? path.join(path.dirname(process.execPath), "assets")
  : MODULE_ROOT;
const PORT = Number(process.env.PORT || 8000);
const APP_DATA_ROOT = process.pkg
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DemucsSeperater")
  : path.join(MODULE_ROOT, ".runtime");
const RUNTIME_ROOT = process.pkg
  ? path.join(APP_DATA_ROOT, ".runtime")
  : path.join(MODULE_ROOT, ".runtime");
const UPLOAD_DIR = path.join(RUNTIME_ROOT, "uploads");
const SEPARATED_DIR = path.join(RUNTIME_ROOT, "separated");
const LOG_DIR = path.join(APP_DATA_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");
const TORCH_HOME = process.env.TORCH_HOME || path.join(APP_DATA_ROOT, "torch");
const DEMUCS_CMD = process.env.DEMUCS || (existsSync(path.join(MODULE_ROOT, "demucs_wrapper.py")) ? `python3 ${path.join(MODULE_ROOT, "demucs_wrapper.py")}` : "demucs");
const DEMUCS_ARGS = DEMUCS_CMD.startsWith("python3") ? DEMUCS_CMD.split(" ") : [DEMUCS_CMD];
const DEMUCS_BIN = DEMUCS_ARGS[0];
const DEMUCS_PRE_ARGS = DEMUCS_ARGS.length > 1 ? DEMUCS_ARGS.slice(1) : [];
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024;
const AUTO_DELETE_HOURS = 1;
const AVAILABLE_MODELS = [
  { id: "htdemucs", name: "htdemucs (标准)", stemCounts: [2, 4] },
  { id: "htdemucs_ft", name: "htdemucs_ft (Fine-tuned)", stemCounts: [2, 4] },
  { id: "htdemucs_6s", name: "htdemucs_6s (6 轨)", stemCounts: [2, 6] },
  { id: "hdemucs_mmi", name: "hdemucs_mmi", stemCounts: [2, 4] },
  { id: "mdx", name: "mdx (MDX 基础)", stemCounts: [2, 4] },
  { id: "mdx_q", name: "mdx_q (MDX 量化版)", stemCounts: [2, 4] },
  { id: "mdx_extra", name: "mdx_extra (MDX 增强)", stemCounts: [2, 4] },
  { id: "mdx_extra_q", name: "mdx_extra_q (MDX 增强量化)", stemCounts: [2, 4] },
];
const STEM_ORDER_BY_COUNT = {
  2: ["vocals", "no_vocals"],
  4: ["vocals", "drums", "bass", "other"],
  6: ["vocals", "drums", "bass", "guitar", "piano", "other"],
};

const jobs = new Map();

setupFileLogging();
console.log("[Startup] DemucsSeperater starting");
console.log(`[Startup] packaged=${Boolean(process.pkg)}`);
console.log(`[Startup] execPath=${process.execPath}`);
console.log(`[Startup] cwd=${process.cwd()}`);
console.log(`[Startup] appRoot=${APP_ROOT}`);
console.log(`[Startup] runtimeRoot=${RUNTIME_ROOT}`);
console.log(`[Startup] logFile=${LOG_FILE}`);
console.log(`[Startup] torchHome=${TORCH_HOME}`);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      return handleHealth(request, response);
    }

    if (request.method === "GET" && request.url === "/api/models") {
      return handleModels(request, response);
    }

    if (request.method === "POST" && request.url === "/api/stems") {
      return handleStems(request, response);
    }

    if (request.method === "POST" && request.url === "/api/separate") {
      return handleSeparate(request, response);
    }

    if (request.method === "POST" && request.url === "/api/merge") {
      return handleMerge(request, response);
    }

    if (request.method === "GET" && request.url.startsWith("/api/status/")) {
      const jobId = request.url.split("/")[3];
      return handleStatus(request, response, jobId);
    }

    if (request.method === "GET" && request.url.startsWith("/api/download/")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const jobId = pathParts[2];
      const stem = pathParts[3];
      return handleDownload(request, response, jobId, stem);
    }

    if (request.method === "GET" && request.url.startsWith("/api/download3/")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const jobId = pathParts[2];
      const stem = pathParts[3];
      return handleDownload3(request, response, jobId, stem);
    }

    return serveStatic(request, response);
  } catch (error) {
    console.error("Server error:", error);
    return sendJson(response, 500, {
      error: "internal_error",
      message: error.message || "服务器内部错误。",
    });
  }
});

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 2 * 60 * 1000;

server.on("error", (error) => {
  console.error("Server listen error:", error);
  if (error?.code === "EADDRINUSE") {
    console.error(`[Startup] Port ${PORT} is already in use. Opening the existing app URL.`);
    if (process.pkg && process.env.NO_AUTO_OPEN !== "1") {
      openBrowser(`http://127.0.0.1:${PORT}`);
    }
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (process.pkg) {
    setTimeout(() => process.exit(1), 5000);
  }
});

startServer();

async function startServer() {
  try {
    await mkdirAsync(UPLOAD_DIR, { recursive: true });
    await mkdirAsync(SEPARATED_DIR, { recursive: true });
    await mkdirAsync(TORCH_HOME, { recursive: true });
  } catch (error) {
    console.error("Startup directory initialization failed:", error);
    if (process.pkg) {
      setTimeout(() => process.exit(1), 5000);
    }
    return;
  }

  checkDemucsHealth();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Demucs Stems server listening on http://127.0.0.1:${PORT}`);
    if (process.pkg && process.env.NO_AUTO_OPEN !== "1") {
      openBrowser(`http://127.0.0.1:${PORT}`);
    }
  });
}

function setupFileLogging() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `\n===== ${new Date().toISOString()} =====\n`, "utf8");
  } catch (error) {
    console.error("Failed to initialize file logging:", error);
    return;
  }

  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const line = args
          .map((arg) => (arg instanceof Error ? `${arg.stack || arg.message}` : String(arg)))
          .join(" ");
        appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${method.toUpperCase()}] ${line}\n`, "utf8");
      } catch {}
    };
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("explorer.exe", [url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => {
        console.error("Failed to auto-open browser child process:", error);
      });
      child.unref();
      return;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", (error) => {
        console.error("Failed to auto-open browser child process:", error);
      });
      child.unref();
      return;
    }

    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      console.error("Failed to auto-open browser child process:", error);
    });
    child.unref();
  } catch (error) {
    console.error("Failed to auto-open browser:", error);
  }
}

let demucsStatus = { ok: false, version: "initializing", message: "Demucs 正在初始化..." };

async function checkDemucsHealth() {
  if (demucsStatus.ok) return demucsStatus;
  try {
    const result = await runCommand(DEMUCS_BIN, [...DEMUCS_PRE_ARGS, "--help"], HEALTH_CHECK_TIMEOUT_MS);
    if (result.code === 0) {
      demucsStatus = { ok: true, version: "available", message: "Demucs 可用" };
    } else if (result.error === "Command timeout") {
      demucsStatus = { ok: true, version: "initializing", message: "Demucs 正在初始化，首次加载可能较慢" };
    } else {
      demucsStatus = { ok: false, version: "not found", message: "未检测到 Demucs" };
    }
  } catch (error) {
    demucsStatus = { ok: false, version: "error", message: `Demucs 检查失败: ${error.message}` };
  }
  return demucsStatus;
}

async function handleHealth(request, response) {
  const status = await checkDemucsHealth();
  sendJson(response, 200, status);
}

async function handleModels(request, response) {
  sendJson(response, 200, {
    models: AVAILABLE_MODELS,
  });
}

async function handleStems(request, response) {
  try {
    const contentType = request.headers["content-type"] || "";
    const boundary = contentType.match(/boundary=(.+)$/)?.[1];

    if (!boundary) {
      return sendJson(response, 400, {
        error: "invalid_upload",
        message: "请求必须使用 multipart/form-data 上传音频。",
      });
    }

    const body = await readRequestBody(request, MAX_UPLOAD_BYTES);
    const file = await extractMultipartFile(body, boundary);
    const model = extractMultipartField(body, boundary, "model") || "htdemucs";
    const stemCount = Number(extractMultipartField(body, boundary, "stemCount") || 4);
    const validation = validateModelStemCount(model, stemCount);

    if (!validation.ok) {
      return sendJson(response, 400, {
        error: "invalid_model_stem_count",
        message: validation.message,
      });
    }

    if (!file) {
      return sendJson(response, 400, {
        error: "missing_file",
        message: "没有找到名为 file 的音频字段。",
      });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      status: "processing",
      progress: 0,
      fileName: file.fileName,
      model: model,
      stemCount,
      stems: {},
      merges: {},
      createdAt: Date.now(),
      inputPath: file.path,
      outputDir: path.join(SEPARATED_DIR, jobId),
    };
    jobs.set(jobId, job);

    runDemucs(job).catch((err) => {
      const j = jobs.get(jobId);
      if (j) {
        j.status = "error";
        j.error = err.message;
      }
    });

    sendJson(response, 202, {
      jobId,
      message: "分轨任务已创建，请使用 jobId 查询状态。",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.payload?.error || "stems_failed",
      message: error.message || "分轨处理失败。",
    });
  }
}

async function handleStatus(request, response, jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    return sendJson(response, 404, {
      error: "job_not_found",
      message: "未找到指定的任务或已过期。",
    });
  }

  sendJson(response, 200, {
    status: job.status,
    progress: job.progress,
    model: job.model,
    stemCount: job.stemCount,
    error: job.error,
    stems: job.stems,
    merges: job.merges,
    urls: job.urls, // 包含分离结果链接
    message: job.status === "completed" ? "分轨完成" : "处理中",
  });
}

async function handleDownload(request, response, jobId, stem) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const forceDownload = requestUrl.searchParams.get("download") === "1";
  const job = jobs.get(jobId) || await restoreCompletedThreeStemJob(jobId);

  if (!job || job.status !== "completed") {
    return sendJson(response, 404, {
      error: "not_ready",
      message: "分轨任务未完成或不存在。",
    });
  }

  if (stem === "all") {
    return serveAllStemsZip(response, job, forceDownload);
  }

  const filePath = stem?.startsWith("merged_") ? job.merges?.[stem]?.path : job.stems[stem];
  if (!filePath) {
    return sendJson(response, 404, {
      error: "stem_not_found",
      message: `未找到音轨: ${stem}`,
    });
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return sendJson(response, 404, {
      error: "file_not_found",
      message: "音轨文件不存在。",
    });
  }

  const rangeHeader = request.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileStat.size) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    response.writeHead(206, {
      "Content-Type": "audio/wav",
      "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
      "Content-Length": end - start + 1,
    });

    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
    "Accept-Ranges": "bytes",
    "Content-Length": fileStat.size,
  });

  createReadStream(filePath).pipe(response);
}

async function handleDownload3(request, response, jobId, stem) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const forceDownload = requestUrl.searchParams.get("download") === "1";
  const job = jobs.get(jobId) || await restoreCompletedThreeStemJob(jobId);

  console.log("[DEBUG] handleDownload3:", jobId, stem, "job found:", !!job, "status:", job?.status, "stems3:", !!job?.stems3);

  if (!job || job.status !== "completed" || !job.stems3) {
    return sendJson(response, 404, {
      error: "not_ready",
      message: "分轨任务未完成或不存在。",
    });
  }

  const validStems = ["vocal", "drum", "other"];
  if (!validStems.includes(stem)) {
    return sendJson(response, 404, {
      error: "stem_not_found",
      message: "未找到音轨。支持的音轨: vocal, drum, other",
    });
  }

  const filePath = job.stems3[stem];
  if (!filePath) {
    return sendJson(response, 404, {
      error: "file_not_found",
      message: "音轨文件不存在。",
    });
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return sendJson(response, 404, {
      error: "file_not_found",
      message: "音轨文件不存在。",
    });
  }

  const rangeHeader = request.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileStat.size) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    response.writeHead(206, {
      "Content-Type": "audio/wav",
      "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
      "Content-Length": end - start + 1,
    });

    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${stem}.wav"`,
    "Accept-Ranges": "bytes",
    "Content-Length": fileStat.size,
  });

  createReadStream(filePath).pipe(response);
}

async function restoreCompletedThreeStemJob(jobId) {
  const outputDir = path.join(SEPARATED_DIR, jobId);
  const stems3 = {
    vocal: path.join(outputDir, "vocals.wav"),
    drum: path.join(outputDir, "drums.wav"),
    other: path.join(outputDir, "other.wav"),
  };

  for (const filePath of Object.values(stems3)) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) return null;
  }

  const job = {
    id: jobId,
    status: "completed",
    progress: 100,
    stems: {},
    stems3,
    merges: {},
    outputDir,
  };
  jobs.set(jobId, job);
  return job;
}

async function handleMerge(request, response) {
  try {
    const body = await readRequestBody(request, 1024 * 1024);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const job = jobs.get(payload.jobId);
    const selectedStems = Array.isArray(payload.stems) ? payload.stems : [];

    if (!job || job.status !== "completed") {
      return sendJson(response, 404, {
        error: "job_not_ready",
        message: "分轨任务未完成或不存在。",
      });
    }

    const inputPaths = selectedStems.map((stem) => job.stems[stem]).filter(Boolean);
    if (inputPaths.length < 1) {
      return sendJson(response, 400, {
        error: "missing_stems",
        message: "请至少选择一个要合并的音轨。",
      });
    }

    const mergeId = `merged_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outputPath = path.join(job.outputDir, `${mergeId}.wav`);
    const args = [];
    for (const inputPath of inputPaths) {
      args.push("-i", inputPath);
    }
    args.push("-filter_complex", `amix=inputs=${inputPaths.length}:duration=longest:normalize=0`, "-y", outputPath);

    const result = await runCommand("ffmpeg", args, 600000);
    if (result.code !== 0) {
      throw new Error(`合并失败: ${result.stderr || result.stdout}`);
    }

    job.merges[mergeId] = {
      id: mergeId,
      stems: selectedStems,
      path: outputPath,
    };

    sendJson(response, 200, {
      mergeId,
      stems: selectedStems,
      url: `/api/download/${job.id}/${mergeId}`,
      message: "合并完成。",
    });
  } catch (error) {
    sendJson(response, 500, {
      error: "merge_failed",
      message: error.message || "合并失败。",
    });
  }
}

async function handleSeparate(request, response) {
  const contentType = request.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return handleSeparateByUrl(request, response, contentType);
  }

  if (contentType.includes("multipart/form-data")) {
    return handleSeparateByFile(request, response, contentType);
  }

  return sendJson(response, 400, {
    error: "invalid_content_type",
    message: "请求必须使用 application/json (含 url 字段) 或 multipart/form-data (含 file 字段)。",
  });
}

async function handleSeparateByUrl(request, response, contentType) {
  try {
    const body = await readRequestBody(request, 10 * 1024 * 1024);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const audioUrl = payload.url;

    if (!audioUrl || typeof audioUrl !== "string") {
      return sendJson(response, 400, {
        error: "missing_url",
        message: "JSON 请求必须包含 url 字段。",
      });
    }

    if (!/^https?:\/\//.test(audioUrl)) {
      return sendJson(response, 400, {
        error: "invalid_url",
        message: "url 必须是有效的 http(s) 链接。",
      });
    }

    const jobId = `sep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      status: "downloading",
      progress: 0,
      fileName: path.basename(new URL(audioUrl).pathname) || "audio",
      model: "htdemucs",
      stemCount: 3,
      stems: {},
      merges: {},
      createdAt: Date.now(),
      outputDir: path.join(SEPARATED_DIR, jobId),
    };

    const localPath = await downloadUrl(audioUrl, jobId);
    job.inputPath = localPath;
    job.fileName = path.basename(localPath);

    await mkdirAsync(job.outputDir, { recursive: true });

    jobs.set(jobId, job);

    // 立即返回 jobId
    sendJson(response, 200, { jobId });

    // 后台运行分离任务
    runDemucsForSeparate(job)
      .then((urls) => {
        job.status = "completed";
        job.progress = 100;
        job.urls = urls;
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err.message;
        console.error("[job failed]", jobId, err);
      });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.code || "separate_failed",
      message: error.message || "分轨处理失败。",
    });
  }
}

async function handleSeparateByFile(request, response, contentType) {
  try {
    const contentLength = parseInt(request.headers["content-length"] || "0");
    const clientJobId = request.headers["x-job-id"];
    const jobId = clientJobId || `sep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[upload] request received, jobId=${jobId}, clientJobId=${clientJobId}, size=${contentLength}`);

    const job = {
      id: jobId,
      status: "uploading",
      progress: 0,
      fileName: "uploading...",
      model: "htdemucs",
      stemCount: 3,
      stems: {},
      merges: {},
      createdAt: Date.now(),
      uploadTotal: contentLength,
      uploadReceived: 0,
      inputPath: null,
      outputDir: path.join(SEPARATED_DIR, jobId),
    };

    await mkdirAsync(job.outputDir, { recursive: true });
    jobs.set(jobId, job);

    console.log("[upload] waiting for stream, jobId:", jobId);
    const fileInfo = await receiveUploadedFile(request, contentType, job, contentLength);
    console.log("[upload] stream done, file:", fileInfo?.path);

    if (!fileInfo) {
      job.status = "failed";
      job.error = "没有找到文件数据。";
      return sendJson(response, 400, {
        error: "missing_file",
        message: job.error,
      });
    }

    if (fileInfo.truncated) {
      job.status = "failed";
      job.error = "上传文件过大。";
      return sendJson(response, 413, {
        error: "file_too_large",
        message: job.error,
      });
    }

    if (response.destroyed) {
      return;
    }

    job.inputPath = fileInfo.path;
    job.status = "processing";
    job.progress = 50;

    sendJson(response, 200, { jobId });

    runDemucsForSeparate(job)
      .then((urls) => {
        job.status = "completed";
        job.progress = 100;
        job.urls = urls;
        console.log("[job completed]", jobId);
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err.message;
        console.error("[job failed]", jobId, err);
      });
  } catch (error) {
    console.error("[upload] handler error:", error);
    sendJson(response, error.statusCode || 500, {
      error: error.code || "separate_failed",
      message: error.message || "分轨处理失败。",
    });
  }
}

function receiveUploadedFile(request, contentType, job, contentLength) {
  return new Promise((resolve, reject) => {
    let fileInfo = null;
    let outputStream = null;
    let writeDone = null;
    let fileSize = 0;
    let settled = false;

    const finishOnce = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const busboy = Busboy({
      headers: { ...request.headers, "content-type": contentType },
      limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
    });

    busboy.on("file", (_fieldName, file, info) => {
      const safeName = path.basename(info.filename || "upload.audio").replace(/[^a-zA-Z0-9._-]/g, "_");
      const uploadPath = path.join(UPLOAD_DIR, `${Date.now()}-${safeName}`);

      job.fileName = safeName;
      fileInfo = { path: uploadPath, fileName: safeName, size: 0, truncated: false };
      outputStream = createWriteStream(uploadPath);
      writeDone = new Promise((resolveWrite, rejectWrite) => {
        outputStream.on("finish", resolveWrite);
        outputStream.on("error", rejectWrite);
      });

      file.on("data", (chunk) => {
        fileSize += chunk.length;
        job.uploadReceived = fileSize;
        if (contentLength > 0) {
          job.progress = Math.min(50, Math.round((fileSize / contentLength) * 50));
        }
      });

      file.on("limit", () => {
        fileInfo.truncated = true;
        file.resume();
      });

      writeDone.catch((error) => finishOnce(() => reject(error)));

      file.pipe(outputStream);
    });

    busboy.on("error", (error) => {
      finishOnce(() => reject(error));
    });

    request.on("aborted", () => {
      job.status = "failed";
      job.error = "上传已中断。";
      finishOnce(() => reject(new Error(job.error)));
    });

    request.on("error", (error) => {
      job.status = "failed";
      job.error = error.message === "aborted" ? "上传已中断。" : (error.message || "上传中断");
      finishOnce(() => reject(new Error(job.error)));
    });

    busboy.on("finish", () => {
      if (!writeDone) {
        finishOnce(() => resolve(null));
        return;
      }

      writeDone.then(() => {
        if (fileInfo) {
          fileInfo.size = fileSize;
        }
        finishOnce(() => resolve(fileInfo));
      }).catch((error) => finishOnce(() => reject(error)));
    });

    request.pipe(busboy);
  });
}

async function runDemucsForSeparate(job) {
  job.status = "separating";
  job.progress = 20;

  console.log(`[debug] runDemucsForSeparate: input=${job.inputPath}, outputDir=${job.outputDir}`);

  const modelArg = "htdemucs";
  const args = ["-o", job.outputDir, "-n", modelArg, job.inputPath];
  console.log(`[debug] running: ${DEMUCS_BIN} ${DEMUCS_PRE_ARGS.join(" ")} ${args.join(" ")}`);

  const result = await runCommand(DEMUCS_BIN, [...DEMUCS_PRE_ARGS, ...args], 600000);

  console.log(`[debug] demucs result: code=${result.code}, stderr=${result.stderr?.slice(0, 200)}`);

  if (result.code !== 0) {
    throw new Error(`Demucs 执行失败: ${result.stderr || result.stdout}`);
  }

  job.status = "merging";
  job.progress = 80;

  const modelDir = path.join(job.outputDir, modelArg, path.basename(job.inputPath).replace(/\.[^.]+$/, ""));
  const vocalsPath = path.join(modelDir, "vocals.wav");
  const drumsPath = path.join(modelDir, "drums.wav");
  const bassPath = path.join(modelDir, "bass.wav");
  const otherPath = path.join(modelDir, "other.wav");

  const mergedOtherPath = path.join(job.outputDir, "other.wav");

  if (existsSync(bassPath) && existsSync(otherPath)) {
    const mergeResult = await runCommand("ffmpeg", [
      "-i", bassPath,
      "-i", otherPath,
      "-filter_complex", "amix=inputs=2:duration=longest:normalize=0",
      "-y", mergedOtherPath,
    ], 120000);

    if (mergeResult.code !== 0) {
      throw new Error(`合并 Bass+Other 失败: ${mergeResult.stderr || mergeResult.stdout}`);
    }
  } else if (existsSync(otherPath)) {
    const fs = require("node:fs/promises");
    await fs.copyFile(otherPath, mergedOtherPath);
  } else {
    throw new Error("未找到 other 音轨文件。");
  }

  try {
    await unlink(job.inputPath).catch(() => {});
  } catch {}

  const stemsMap = {
    vocal: path.join(job.outputDir, "vocals.wav"),
    drum: path.join(job.outputDir, "drums.wav"),
    other: mergedOtherPath,
  };

  const fs = require("node:fs/promises");

  for (const [name, src] of Object.entries({ vocals: vocalsPath, drums: drumsPath })) {
    const dest = stemsMap[name === "vocals" ? "vocal" : "drum"];
    if (existsSync(src)) {
      try {
        await fs.copyFile(src, dest);
      } catch {}
    }
  }

  job.status = "completed";
  job.progress = 100;

  for (const [stemName, stemPath] of Object.entries(stemsMap)) {
    if (!existsSync(stemPath)) {
      delete stemsMap[stemName];
    }
  }

  job.stems3 = stemsMap;

  const urls = {};
  for (const [name, stemPath] of Object.entries(stemsMap)) {
    urls[name] = `/api/download3/${job.id}/${name}`;
  }
  urls.jobId = job.id;

  cleanupJobLater(job, 3600000);

  return urls;
}

async function downloadUrl(url, jobId) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || ".mp3";
    const fileName = `${jobId}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const protocol = url.startsWith("https") ? https : http;

    protocol.get(url, { timeout: 300000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location, jobId).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        return;
      }

      const fileSize = parseInt(res.headers["content-length"] || "0", 10);
      if (fileSize > MAX_UPLOAD_BYTES) {
        reject(new Error("音频文件过大。"));
        res.destroy();
        return;
      }

      const writer = createWriteStream(filePath);
      res.pipe(writer);

      writer.on("finish", () => resolve(filePath));
      writer.on("error", (err) => reject(new Error(`写入文件失败: ${err.message}`)));
    }).on("error", (err) => reject(new Error(`下载失败: ${err.message}`)));
  });
}

function cleanupJobLater(job, delayMs) {
  setTimeout(async () => {
    try {
      for (const stemPath of Object.values(job.stems3 || {})) {
        await unlink(stemPath).catch(() => {});
      }
      await cleanupDir(job.outputDir).catch(() => {});
      jobs.delete(job.id);
    } catch {}
  }, delayMs);
}

async function serveAllStemsZip(response, job, forceDownload = true) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stems = job.stems3 && Object.keys(job.stems3).length ? job.stems3 : job.stems;

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="stems_${job.id}.zip"`,
  });

  archive.pipe(response);

  for (const [stemName, filePath] of Object.entries(stems || {})) {
    try {
      const statResult = await stat(filePath);
      if (statResult.isFile()) {
        archive.file(filePath, { name: `${stemName}.wav` });
      }
    } catch (e) {
      console.error(`Failed to add ${stemName}:`, e);
    }
  }

  archive.finalize();
}

async function runDemucs(job) {
  await mkdirAsync(job.outputDir, { recursive: true });

  job.status = "downloading";
  job.progress = 5;

  const modelArg = job.model || "htdemucs";
  const stemCount = job.stemCount || 4;
  const args = ["-o", job.outputDir, "-n", modelArg];
  if (stemCount === 2) {
    args.push("--two-stems", "vocals");
  }
  args.push(job.inputPath);
  const result = await runCommand(
    DEMUCS_BIN,
    [...DEMUCS_PRE_ARGS, ...args],
    600000,
  );

  if (result.code !== 0) {
    throw new Error(`Demucs 执行失败: ${result.stderr || result.stdout}`);
  }

  job.status = "completed";
  job.progress = 100;

  const modelDir = path.join(job.outputDir, modelArg, path.basename(job.inputPath).replace(/\.[^.]+$/, ""));
  const stems = {};

  for (const stem of STEM_ORDER_BY_COUNT[stemCount] || STEM_ORDER_BY_COUNT[4]) {
    const stemPath = path.join(modelDir, `${stem}.wav`);
    try {
      const statResult = await stat(stemPath);
      if (statResult.isFile()) {
        stems[stem] = stemPath;
      }
    } catch (e) {
      console.error(`Stem not found: ${stem}`);
    }
  }

  job.stems = stems;

  try {
    await unlink(job.inputPath).catch(() => {});
  } catch (e) {}

  scheduleCleanup(job);

  return stems;
}

function scheduleCleanup(job) {
  const delay = AUTO_DELETE_HOURS * 60 * 60 * 1000;
  console.log(`[Cleanup] Scheduled deletion of job ${job.id} in ${AUTO_DELETE_HOURS} hour(s)`);

  setTimeout(async () => {
    const j = jobs.get(job.id);
    if (j && j.status === "completed") {
      console.log(`[Cleanup] Deleting job ${job.id} files...`);
      try {
        await unlink(job.inputPath).catch(() => {});
        await cleanupDir(job.outputDir);
        jobs.delete(job.id);
        console.log(`[Cleanup] Job ${job.id} deleted`);
      } catch (e) {
        console.error(`[Cleanup] Failed to delete job ${job.id}:`, e);
      }
    }
  }, delay);
}

async function cleanupDir(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await cleanupDir(fullPath);
      } else {
        await unlink(fullPath).catch(() => {});
      }
    }
    await unlink(dirPath).catch(() => {});
  } catch (e) {}
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: APP_ROOT, env: { ...process.env, TORCH_HOME } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: -1, stdout, stderr, error: "Command timeout" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("上传文件过大。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function extractMultipartFile(body, boundary) {
  const boundaryText = `--${boundary}`;
  const sections = body.toString("latin1").split(boundaryText);

  for (const section of sections) {
    if (!section.includes('name="file"')) {
      continue;
    }

    const headerEnd = section.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      continue;
    }

    const headers = section.slice(0, headerEnd);
    const fileName = headers.match(/filename="([^"]+)"/)?.[1] || "upload.audio";
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const content = section.slice(headerEnd + 4).replace(/\r\n--$/, "").replace(/\r\n$/, "");
    const target = path.join(UPLOAD_DIR, `${Date.now()}-${safeName}`);

    await writeFileFromLatin1(target, content);
    return { path: target, fileName: safeName };
  }

  return null;
}

function extractMultipartField(body, boundary, fieldName) {
  const boundaryText = `--${boundary}`;
  const sections = body.toString("latin1").split(boundaryText);

  for (const section of sections) {
    if (!section.includes(`name="${fieldName}"`) || section.includes("filename=")) {
      continue;
    }

    const headerEnd = section.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      continue;
    }

    return section.slice(headerEnd + 4).replace(/\r\n--$/, "").replace(/\r\n$/, "").trim();
  }

  return "";
}

function validateModelStemCount(model, stemCount) {
  const modelInfo = AVAILABLE_MODELS.find((item) => item.id === model);
  if (!modelInfo) {
    return { ok: false, message: `未知模型: ${model}` };
  }

  if (!modelInfo.stemCounts.includes(stemCount)) {
    return { ok: false, message: `${model} 不支持 ${stemCount} 轨分离。` };
  }

  return { ok: true };
}

function writeFileFromLatin1(target, content) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(target);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(Buffer.from(content, "latin1"));
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(APP_ROOT, normalized);

  if (!filePath.startsWith(APP_ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    response.destroy();
  });

  response.writeHead(200, { "Content-Type": getContentType(filePath) });
  stream.pipe(response);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extension] || "application/octet-stream"
  );
}

function sendJson(response, statusCode, data) {
  const payload = data instanceof Error ? { message: data.message } : data;
  response.writeHead(data.statusCode || statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("beforeExit", (code) => {
  console.error(`[Lifecycle] beforeExit code=${code}`);
});

process.on("exit", (code) => {
  console.error(`[Lifecycle] exit code=${code}`);
});

const keepAliveTimer = setInterval(() => {
  console.log(`[Watchdog] Server running, jobs: ${jobs.size}, time: ${new Date().toISOString()}`);
}, 30000);
keepAliveTimer.ref();

console.log("[Watchdog] Server started with watchdog enabled");
console.log(`[Config] Auto-delete after ${AUTO_DELETE_HOURS} hour(s)`);
