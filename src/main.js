const form = document.querySelector("#upload-form");
const input = document.querySelector("#audio-file");
const dropZone = document.querySelector("#drop-zone");
const fileMeta = document.querySelector("#file-meta");
const separateButton = document.querySelector("#separate-button");
const downloadAllButton = document.querySelector("#download-all-button");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const statusPill = document.querySelector("#status-pill");
const progressBar = document.querySelector("#progress-bar");
const fileName = document.querySelector("#file-name");
const fileDuration = document.querySelector("#file-duration");
const modelUsed = document.querySelector("#model-used");
const masterProgress = document.querySelector("#master-progress");
const stemsGrid = document.querySelector("#stems-grid");
const mergePanel = document.querySelector("#merge-panel");
const mergeToggleButton = document.querySelector("#merge-toggle-button");
const mergeStartButton = document.querySelector("#merge-start-button");
const mergeCopy = document.querySelector("#merge-copy");
const mergedPlayer = document.querySelector("#merged-player");
const mergedProgress = document.querySelector("#merged-progress");
const mergedTime = document.querySelector("#merged-time");
const mergedPlayButton = document.querySelector("#merged-play-button");
const mergedDownloadButton = document.querySelector("#merged-download-button");

const THREE_STEMS = ["vocal", "drum", "other"];
const STEM_META = {
  vocal: { label: "人声", icon: "🎤" },
  drum: { label: "鼓组", icon: "🥁" },
  other: { label: "其他", icon: "🎹" },
};

let selectedFile = null;
let currentJobId = null;
let currentStems = [];
let stemAudios = {};
let stemGains = {};
let stemSources = {};
let masterGain = null;
let audioContext = null;
let isSeeking = false;
let mergeMode = false;
let mergedAudio = null;
let mergedSource = null;
let mergedGain = null;
let mergedId = null;
let mergedSeeking = false;
let stemSyncTimer = null;
let threeStemJobId = null;
let threeStemUrls = {};

checkHealth();
renderStemCards(THREE_STEMS);
window.__demucsDebug = {
  getStemStates: () => Object.fromEntries(Object.entries(stemAudios).map(([stem, audio]) => [stem, {
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
    paused: audio.paused,
    readyState: audio.readyState,
  }])),
  getMergedState: () => mergedAudio ? {
    currentTime: mergedAudio.currentTime || 0,
    duration: mergedAudio.duration || 0,
    paused: mergedAudio.paused,
    readyState: mergedAudio.readyState,
  } : null,
};

input.addEventListener("change", () => setSelectedFile(input.files?.[0] || null));
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0] || null;
  if (file) {
    input.files = event.dataTransfer.files;
    setSelectedFile(file);
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (selectedFile) await startSeparation();
});

downloadAllButton.addEventListener("click", () => {
  if (threeStemJobId && Object.keys(threeStemUrls).length === 3) {
    downloadAllThreeStems();
  } else if (currentJobId) {
    triggerDownload(`/api/download/${encodeURIComponent(currentJobId)}/all?download=1`);
  }
});
document.getElementById("play-all-btn").addEventListener("click", playAllStems);
document.getElementById("stop-all-btn").addEventListener("click", stopAllStems);
document.getElementById("mute-all-btn").addEventListener("click", toggleMuteAll);
masterProgress.addEventListener("input", () => {
  isSeeking = true;
  syncProgressToAudios();
});
masterProgress.addEventListener("change", () => {
  syncProgressToAudios();
  isSeeking = false;
});

stemsGrid.addEventListener("click", (event) => {
  const target = event.target;
  const stem = target.dataset.stem;
  if (!stem) return;
  if (target.classList.contains("stem-play")) toggleStemPlayback(stem);
  if (target.classList.contains("stem-download")) downloadStem(stem);
  if (target.classList.contains("stem-mute")) toggleMute(stem);
});
stemsGrid.addEventListener("input", (event) => {
  const target = event.target;
  if (target.classList.contains("stem-volume")) setVolume(target.dataset.stem, target.value / 100);
  if (target.classList.contains("merge-check")) updateMergeButtonState();
});

if (mergeToggleButton) {
  mergeToggleButton.addEventListener("click", () => {
    mergeMode = !mergeMode;
    stemsGrid.classList.toggle("is-merge-mode", mergeMode);
    mergeToggleButton.textContent = mergeMode ? "取消选择" : "选择合并轨道";
    updateMergeButtonState();
  });
}
if (mergeStartButton) {
  mergeStartButton.addEventListener("click", mergeSelectedStems);
}
if (mergedPlayButton) {
  mergedPlayButton.addEventListener("click", toggleMergedPlayback);
}
if (mergedDownloadButton) {
  mergedDownloadButton.addEventListener("click", () => {
    if (currentJobId && mergedId) triggerDownload(`/api/download/${encodeURIComponent(currentJobId)}/${encodeURIComponent(mergedId)}?download=1`);
  });
}
if (mergedProgress) {
  mergedProgress.addEventListener("input", () => {
    mergedSeeking = true;
    syncMergedProgressToAudio();
  });
  mergedProgress.addEventListener("change", () => {
    syncMergedProgressToAudio();
    mergedSeeking = false;
  });
}

function initAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
  }
  return audioContext;
}

async function ensureAudioContextRunning() {
  const ctx = initAudioContext();
  if (ctx.state !== "running") await ctx.resume();
}

function reportPlaybackError(prefix, error) {
  const reason = error?.message || String(error || "未知错误");
  console.error(prefix, error);
  setStatus("播放失败", "Error", `${prefix}: ${reason}`, 100, true);
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    setStatus(health.ok ? "服务可用" : "服务不可用", health.ok ? "Ready" : "Error", health.message, 0, !health.ok);
  } catch {
    setStatus("后端未连接", "Error", "无法连接到后端服务。", 0, true);
  }
}

function setSelectedFile(file) {
  selectedFile = file;
  currentJobId = null;
  threeStemJobId = null;
  threeStemUrls = {};
  resetStemStates();
  resetMergedTrack();
  if (!file) {
    fileMeta.hidden = true;
    separateButton.disabled = true;
    fileName.textContent = "--";
    fileDuration.textContent = "0:00";
    return;
  }
  fileMeta.hidden = false;
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  fileName.textContent = truncateFileName(file.name);
  separateButton.disabled = false;
  updateSelectionSummary();
  loadAudioPreview(file);
  setStatus("音频已选择", "Ready", "点击开始分轨后将分离为 Vocal / Drum / Other 三个音轨。", 0);
}

async function loadAudioPreview(file) {
  try {
    const ctx = initAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    fileDuration.textContent = formatTime(audioBuffer.duration);
    drawEmptyWaveforms();
  } catch (error) {
    console.error("Failed to load audio preview:", error);
    fileDuration.textContent = "Error";
  }
}

function updateSelectionSummary() {
  modelUsed.textContent = "3 轨";
}

function renderStemCards(stems) {
  currentStems = stems;
  stemsGrid.innerHTML = stems.map((stem) => {
    const meta = STEM_META[stem] || { label: stem, icon: "🎚" };
    return `
      <div class="stem-card" data-stem="${stem}">
        <div class="stem-card__header">
          <label class="merge-check-wrap" title="选择用于合并">
            <input type="checkbox" class="merge-check" data-stem="${stem}" disabled />
          </label>
          <span class="stem-icon">${meta.icon}</span>
          <h3>${meta.label}</h3>
          <button class="mute-btn stem-mute" data-stem="${stem}" title="静音" disabled>🔊</button>
          <input type="range" class="volume-slider stem-volume" data-stem="${stem}" min="0" max="100" value="80" title="音量" disabled>
        </div>
        <div class="stem-waveform" id="waveform-${stem}">
          <canvas id="canvas-${stem}" width="400" height="80"></canvas>
        </div>
        <div class="stem-controls">
          <button class="play-action stem-play" data-stem="${stem}" disabled>播放</button>
          <button class="secondary-action stem-download" data-stem="${stem}" disabled>下载</button>
        </div>
      </div>`;
  }).join("");
  drawEmptyWaveforms();
}

function drawEmptyWaveforms() {
  currentStems.forEach((stem) => {
    const canvas = document.getElementById(`canvas-${stem}`);
    if (canvas) drawWaveform(canvas, new Array(100).fill(0.1));
  });
}

function drawWaveform(canvas, data) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const barWidth = width / data.length;
  const maxValue = Math.max(...data, 0.01);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0, 0, width, height);
  data.forEach((value, index) => {
    const barHeight = (value / maxValue) * (height - 10);
    const x = index * barWidth;
    const y = (height - barHeight) / 2;
    const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
    gradient.addColorStop(0, "#86efac");
    gradient.addColorStop(1, "#4338ca");
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth - 1, barHeight);
  });
}

async function startSeparation() {
  setBusy(true);
  currentJobId = null;
  threeStemJobId = null;
  threeStemUrls = {};
  resetStemStates();
  resetMergedTrack();
  updateSelectionSummary();
  setStatus("正在上传", "Uploading", "正在上传音频文件到服务器...", 5);
  try {
    const formData = new FormData();
    formData.append("file", selectedFile);
    const response = await fetch("/api/separate", { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "分轨任务创建失败。");

    threeStemJobId = data.jobId;
    threeStemUrls = {
      vocal: data.vocal,
      drum: data.drum,
      other: data.other,
    };

    handleThreeStemCompletion(data);
  } catch (error) {
    setStatus("分轨失败", "Error", error.message, 0, true);
    setBusy(false);
  }
}

function handleThreeStemCompletion(data) {
  setStatus("分轨完成", "Completed", "已分离为人声、鼓组、其他三个音轨。", 100);
  const stems = ["vocal", "drum", "other"].filter((s) => data[s]);
  if (!stems.length) {
    setStatus("分离完成", "Warning", "未能获取音轨文件，请刷新重试。", 100, true);
    setBusy(false);
    return;
  }
  renderStemCards(stems);
  stems.forEach((stem) => enableThreeStemControl(stem, data[stem]));
  downloadAllButton.disabled = false;
  document.getElementById("play-all-btn").disabled = false;
  document.getElementById("stop-all-btn").disabled = false;
  masterProgress.disabled = false;
  if (mergePanel) mergePanel.hidden = true;
  setBusy(false);
}

function enableThreeStemControl(stem, url) {
  document.querySelector(`.stem-play[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-download[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-mute[data-stem="${stem}"]`).disabled = false;
  document.querySelector(`.stem-volume[data-stem="${stem}"]`).disabled = false;
  initAudioContext();
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.playsInline = true;
  const gainNode = audioContext.createGain();
  const sourceNode = audioContext.createMediaElementSource(audio);
  gainNode.gain.value = 0.8;
  audio.src = url;
  sourceNode.connect(gainNode);
  gainNode.connect(masterGain);
  stemAudios[stem] = audio;
  stemGains[stem] = gainNode;
  stemSources[stem] = sourceNode;
  loadWaveformData(url).then((data) => {
    const canvas = document.getElementById(`canvas-${stem}`);
    if (canvas && data) drawWaveform(canvas, data);
  });
  audio.addEventListener("loadedmetadata", updateMasterTime);
  audio.addEventListener("timeupdate", updateMasterTime);
  audio.addEventListener("ended", updateMasterTime);
  audio.addEventListener("error", () => reportPlaybackError(`音轨 ${stem} 无法播放`, new Error(audio.error ? `媒体错误码 ${audio.error.code}` : "媒体加载失败")));
}

async function loadWaveformData(url) {
  if (!audioContext) return null;
  try {
    const response = await fetch(url);
    const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
    const rawData = audioBuffer.getChannelData(0);
    const samples = 100;
    const blockSize = Math.max(1, Math.floor(rawData.length / samples));
    const data = [];
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j] || 0);
      data.push(sum / blockSize);
    }
    const maxVal = Math.max(...data, 0.01);
    return data.map((value) => value / maxVal);
  } catch (error) {
    console.error("Failed to load waveform:", error);
    return null;
  }
}

async function playAllStems() {
  stopMergedPlayback();
  const hasAnyPlaying = Object.values(stemAudios).some((audio) => !audio.paused);
  if (hasAnyPlaying) {
    Object.values(stemAudios).forEach((audio) => audio.pause());
    stopStemSyncTimer();
    updateMasterTime();
    return;
  }
  try {
    await ensureAudioContextRunning();
    const audios = Object.values(stemAudios);
    await Promise.all(audios.map((audio) => waitForCanPlay(audio)));
    const currentTime = getMasterCurrentTime();
    syncStemTimes(currentTime);
    await Promise.all(audios.map((audio) => audio.play()));
    startStemSyncTimer();
    updateMasterTime();
  } catch (error) {
    reportPlaybackError("音频上下文启动失败", error);
  }
}

function stopAllStems() {
  Object.values(stemAudios).forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  stopStemSyncTimer();
  masterProgress.value = "0";
  updateMasterTime();
}

function toggleMuteAll() {
  const muted = !Object.values(stemGains).every((gain) => gain.gain.value === 0);
  Object.values(stemGains).forEach((gain) => { gain.gain.value = muted ? 0 : 0.8; });
  const muteBtn = document.getElementById("mute-all-btn");
  muteBtn.classList.toggle("is-muted", muted);
  muteBtn.querySelector(".btn-icon").textContent = muted ? "🔇" : "🔊";
  muteBtn.querySelector(".btn-text").textContent = muted ? "取消静音" : "静音";
  document.querySelectorAll(".stem-mute").forEach((btn) => {
    btn.classList.toggle("is-muted", muted);
    btn.textContent = muted ? "🔇" : "🔊";
  });
}

function toggleMute(stem) {
  const gain = stemGains[stem];
  const btn = document.querySelector(`.stem-mute[data-stem="${stem}"]`);
  if (!gain || !btn) return;
  const muted = gain.gain.value !== 0;
  gain.gain.value = muted ? 0 : Number(document.querySelector(`.stem-volume[data-stem="${stem}"]`)?.value || 80) / 100;
  btn.classList.toggle("is-muted", muted);
  btn.textContent = muted ? "🔇" : "🔊";
}

function setVolume(stem, value) {
  if (stemGains[stem]) stemGains[stem].gain.value = Math.max(0, Math.min(1, value));
}

async function toggleStemPlayback(stem) {
  const audio = stemAudios[stem];
  if (!audio) return;
  stopMergedPlayback();
  stopStemSyncTimer();
  if (audio.paused) {
    try {
      await ensureAudioContextRunning();
      await waitForCanPlay(audio);
      await audio.play();
    } catch (error) {
      reportPlaybackError(`音轨 ${stem} 播放失败`, error);
    }
  } else {
    audio.pause();
  }
  updateMasterTime();
}

function updateMasterTime() {
  const times = Object.values(stemAudios).map((audio) => audio.currentTime || 0);
  const durations = Object.values(stemAudios).map((audio) => audio.duration || 0);
  const maxTime = Math.max(...times, 0);
  const maxDuration = Math.max(...durations, 0);
  if (!isSeeking && maxDuration > 0) masterProgress.value = String(Math.round((maxTime / maxDuration) * 1000));
  document.getElementById("master-time").textContent = `${formatTime(maxTime)} / ${formatTime(maxDuration)}`;
  updatePlayButtons();
}

function syncProgressToAudios() {
  const maxDuration = Math.max(...Object.values(stemAudios).map((audio) => audio.duration || 0), 0);
  if (!maxDuration) return;
  const targetTime = (Number(masterProgress.value) / 1000) * maxDuration;
  Object.values(stemAudios).forEach((audio) => { audio.currentTime = targetTime; });
  updateMasterTime();
}

function syncStemTimes(targetTime) {
  Object.values(stemAudios).forEach((audio) => {
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(targetTime, Math.max(0, audio.duration - 0.05));
    }
  });
}

function startStemSyncTimer() {
  stopStemSyncTimer();
  stemSyncTimer = window.setInterval(() => {
    const playing = Object.values(stemAudios).filter((audio) => !audio.paused && !audio.ended);
    if (playing.length <= 1) {
      stopStemSyncTimer();
      return;
    }

    const masterTime = Math.min(...playing.map((audio) => audio.currentTime || 0));
    playing.forEach((audio) => {
      if (Math.abs((audio.currentTime || 0) - masterTime) > 0.08) {
        audio.currentTime = masterTime;
      }
    });
  }, 500);
}

function stopStemSyncTimer() {
  if (stemSyncTimer) {
    window.clearInterval(stemSyncTimer);
    stemSyncTimer = null;
  }
}

function getMasterCurrentTime() {
  return Math.max(...Object.values(stemAudios).map((audio) => audio.currentTime || 0), 0);
}

function updatePlayButtons() {
  const anyPlaying = Object.values(stemAudios).some((audio) => !audio.paused);
  const playAllBtn = document.getElementById("play-all-btn");
  playAllBtn.querySelector(".btn-icon").textContent = anyPlaying ? "⏸" : "▶";
  playAllBtn.querySelector(".btn-text").textContent = anyPlaying ? "暂停" : "播放";
  playAllBtn.classList.toggle("is-active", anyPlaying);
  document.querySelectorAll(".stem-play").forEach((btn) => {
    const audio = stemAudios[btn.dataset.stem];
    btn.textContent = audio && !audio.paused ? "暂停" : "播放";
  });
}

function downloadStem(stem) {
  if (threeStemUrls[stem]) {
    triggerDownload(threeStemUrls[stem] + "?download=1");
  } else if (currentJobId) {
    triggerDownload(`/api/download/${encodeURIComponent(currentJobId)}/${encodeURIComponent(stem)}?download=1`);
  }
}

function downloadAllThreeStems() {
  for (const stem of ["vocal", "drum", "other"]) {
    if (threeStemUrls[stem]) {
      setTimeout(() => triggerDownload(threeStemUrls[stem] + "?download=1"), stem === "vocal" ? 0 : 500);
    }
  }
}

function triggerDownload(url) {
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = url;
  document.body.appendChild(iframe);
  window.setTimeout(() => iframe.remove(), 60000);
}

function updateMergeButtonState() {
  const count = getSelectedMergeStems().length;
  if (mergeStartButton) mergeStartButton.disabled = !currentJobId || count < 1;
  if (mergeCopy) mergeCopy.textContent = count ? `已选择 ${count} 条音轨，点击开始合并。` : "勾选需要合并的音轨，然后点击开始合并。";
}

function getSelectedMergeStems() {
  return [...document.querySelectorAll(".merge-check:checked")].map((input) => input.dataset.stem);
}

async function mergeSelectedStems() {
  const stems = getSelectedMergeStems();
  if (!currentJobId || !stems.length) return;
  stopAllStems();
  resetMergedTrack();
  if (mergeStartButton) mergeStartButton.disabled = true;
  if (mergeCopy) mergeCopy.textContent = "正在合并选中音轨...";
  let merged = false;
  try {
    const response = await fetch("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: currentJobId, stems }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "合并失败。");
    setupMergedTrack(data.mergeId);
    merged = true;
    if (mergeCopy) mergeCopy.textContent = `合并完成：${stems.join(", ")}`;
  } catch (error) {
    if (mergeCopy) mergeCopy.textContent = error.message;
  } finally {
    if (mergeStartButton) mergeStartButton.disabled = !merged && getSelectedMergeStems().length < 1;
  }
}

function setupMergedTrack(id) {
  mergedId = id;
  initAudioContext();
  mergedAudio = new Audio(`/api/download/${currentJobId}/${id}`);
  mergedAudio.crossOrigin = "anonymous";
  mergedAudio.preload = "auto";
  mergedAudio.playsInline = true;
  mergedGain = audioContext.createGain();
  mergedSource = audioContext.createMediaElementSource(mergedAudio);
  mergedSource.connect(mergedGain);
  mergedGain.connect(masterGain);
  mergedAudio.addEventListener("timeupdate", updateMergedTime);
  mergedAudio.addEventListener("loadedmetadata", updateMergedTime);
  mergedAudio.addEventListener("ended", updateMergedTime);
  if (mergedPlayer) mergedPlayer.hidden = false;
}

async function toggleMergedPlayback() {
  if (!mergedAudio) return;
  stopAllStems();
  if (mergedAudio.paused) {
    try {
      await ensureAudioContextRunning();
      await waitForCanPlay(mergedAudio);
      await mergedAudio.play();
    } catch (error) {
      reportPlaybackError("合并音轨播放失败", error);
      return;
    }
  } else {
    mergedAudio.pause();
  }
  updateMergedTime();
}

function stopMergedPlayback() {
  if (mergedAudio) mergedAudio.pause();
  updateMergedTime();
}

function waitForCanPlay(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      if (audio.readyState >= 2) {
        resolve();
      } else {
        reject(new Error("音频加载超时"));
      }
    }, 30000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("loadeddata", onCanPlay);
      audio.removeEventListener("canplaythrough", onCanPlay);
      audio.removeEventListener("error", onError);
    };
    const onCanPlay = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(audio.error ? `媒体错误码 ${audio.error.code}` : "音频加载失败"));
    };
    audio.addEventListener("canplay", onCanPlay, { once: true });
    audio.addEventListener("loadeddata", onCanPlay, { once: true });
    audio.addEventListener("canplaythrough", onCanPlay, { once: true });
    audio.addEventListener("error", onError, { once: true });
    if (audio.readyState === 0) audio.load();
  });
}

function updateMergedTime() {
  if (!mergedAudio) return;
  if (!mergedSeeking && mergedAudio.duration > 0) {
    mergedProgress.value = String(Math.round((mergedAudio.currentTime / mergedAudio.duration) * 1000));
  }
  mergedTime.textContent = `${formatTime(mergedAudio.currentTime)} / ${formatTime(mergedAudio.duration)}`;
  mergedPlayButton.textContent = mergedAudio.paused ? "播放合并音轨" : "暂停合并音轨";
}

function syncMergedProgressToAudio() {
  if (!mergedAudio?.duration) return;
  mergedAudio.currentTime = (Number(mergedProgress.value) / 1000) * mergedAudio.duration;
  updateMergedTime();
}

function resetMergedTrack() {
  if (mergedProgress) mergedProgress.value = "0";
  if (mergedTime) mergedTime.textContent = "0:00 / 0:00";
  if (mergedPlayer) mergedPlayer.hidden = true;
  if (mergedAudio) {
    mergedAudio.pause();
    mergedAudio.src = "";
  }
  if (mergedSource) mergedSource.disconnect();
  if (mergedGain) mergedGain.disconnect();
  mergedAudio = null;
  mergedSource = null;
  mergedGain = null;
  mergedId = null;
}

function resetStemStates() {
  Object.values(stemAudios).forEach((audio) => {
    audio.pause();
    audio.src = "";
  });
  stopStemSyncTimer();
  Object.values(stemGains).forEach((gain) => gain.disconnect());
  Object.values(stemSources).forEach((source) => source.disconnect());
  stemAudios = {};
  stemGains = {};
  stemSources = {};
  currentStems = ["vocal", "drum", "other"];
  renderStemCards(currentStems);
  masterProgress.disabled = true;
  masterProgress.value = "0";
  document.getElementById("master-time").textContent = "0:00 / 0:00";
  document.getElementById("play-all-btn").disabled = true;
  document.getElementById("stop-all-btn").disabled = true;
  const muteBtn = document.getElementById("mute-all-btn");
  if (muteBtn) {
    muteBtn.classList.remove("is-muted");
    muteBtn.querySelector(".btn-icon").textContent = "🔊";
    muteBtn.querySelector(".btn-text").textContent = "静音";
  }
  downloadAllButton.disabled = true;
  if (mergePanel) mergePanel.hidden = true;
  if (mergeToggleButton) mergeToggleButton.disabled = true;
  if (mergeStartButton) mergeStartButton.disabled = true;
  if (mergeToggleButton) mergeToggleButton.textContent = "选择合并轨道";
  if (mergeCopy) mergeCopy.textContent = "勾选需要合并的音轨，然后点击开始合并。";
  mergeMode = false;
}

function setBusy(isBusy) {
  separateButton.disabled = isBusy || !selectedFile;
  input.disabled = isBusy;
}

function setStatus(title, pill, copy, progress, isError = false) {
  statusTitle.textContent = title;
  statusPill.textContent = pill;
  statusCopy.textContent = copy;
  statusCopy.classList.toggle("is-error", isError);
  progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const rest = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncateFileName(name, maxLength = 20) {
  if (name.length <= maxLength) return name;
  const ext = name.split(".").pop();
  const base = name.slice(0, name.length - ext.length - 1);
  return `${base.slice(0, maxLength - ext.length - 4)}...${ext}`;
}
