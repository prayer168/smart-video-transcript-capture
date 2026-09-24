const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawn } = require("node:child_process");
const extract = require("extract-zip");
const ffmpegPackagePath = require("ffmpeg-static");
const ffprobePackagePath = require("ffprobe-static").path;

const RUNTIME_VERSION = "0.2.0";
const WHISPER_VERSION = "v1.8.3";
const WHISPER_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const jobs = new Map();

function unpackedPath(value) {
  return value && value.includes("app.asar") ? value.replace("app.asar", "app.asar.unpacked") : value;
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || unpackedPath(ffmpegPackagePath) || "ffmpeg";
}

function ffprobePath() {
  return process.env.FFPROBE_PATH || unpackedPath(ffprobePackagePath) || "ffprobe";
}

function runtimeDir() {
  return path.join(app.getPath("userData"), "runtime");
}

function ensureDir(target) {
  return fsp.mkdir(target, { recursive: true });
}

function downloadFile(url, target, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const temp = `${target}.download`;
    const request = https.get(url, { headers: { "User-Agent": "SmartVideoTranscript/0.2.0" } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, target, onProgress).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下載失敗（HTTP ${response.statusCode}）：${url}`));
        return;
      }
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      const output = fs.createWriteStream(temp);
      response.on("data", chunk => {
        received += chunk.length;
        onProgress(total ? received / total : 0, received, total);
      });
      response.pipe(output);
      output.on("finish", async () => {
        output.close();
        try {
          await fsp.rename(temp, target);
          resolve(target);
        } catch (error) {
          reject(error);
        }
      });
      output.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(120000, () => request.destroy(new Error("下載逾時")));
  });
}

function sendProgress(event, payload) {
  if (!event.sender.isDestroyed()) event.sender.send("transcription-progress", payload);
}

function runCommand(command, args, options = {}) {
  const { cwd, job, onStdout = () => {}, onStderr = () => {} } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    if (job) job.children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); onStdout(chunk.toString()); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); onStderr(chunk.toString()); });
    child.on("error", error => { if (job) job.children.delete(child); reject(error); });
    child.on("close", code => {
      if (job) job.children.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} 執行失敗（${code}）：${stderr.trim().slice(-500) || stdout.trim().slice(-500)}`));
    });
  });
}

async function ensureYtDlp(event) {
  const dir = runtimeDir();
  const target = path.join(dir, "yt-dlp.exe");
  if (fs.existsSync(target)) return target;
  await ensureDir(dir);
  sendProgress(event, { phase: "runtime", message: "首次啟動：下載網址擷取元件…", progress: 5 });
  await downloadFile(YTDLP_URL, target, progress => sendProgress(event, { phase: "runtime", message: "下載 yt-dlp…", progress: 5 + progress * 15 }));
  return target;
}

async function findWhisperBinary(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findWhisperBinary(target);
      if (nested) return nested;
    } else if (["whisper-cli.exe", "main.exe"].includes(entry.name.toLowerCase())) {
      return target;
    }
  }
  return null;
}

async function ensureWhisper(event) {
  const dir = path.join(runtimeDir(), "whisper");
  await ensureDir(dir);
  let binary = await findWhisperBinary(dir);
  if (!binary) {
    const zip = path.join(runtimeDir(), "whisper-bin.zip");
    sendProgress(event, { phase: "runtime", message: "首次啟動：下載本機 Whisper 引擎…", progress: 20 });
    await downloadFile(WHISPER_ZIP_URL, zip, progress => sendProgress(event, { phase: "runtime", message: "下載 Whisper 引擎…", progress: 20 + progress * 25 }));
    await extract(zip, { dir });
    await fsp.rm(zip, { force: true });
    binary = await findWhisperBinary(dir);
  }
  if (!binary) throw new Error("找不到 Whisper 執行檔。請重新啟動 App 讓它重新下載。");
  return binary;
}

async function ensureModel(modelName, event) {
  const safeName = ["tiny", "base", "small", "medium"].includes(modelName) ? modelName : "base";
  const dir = path.join(runtimeDir(), "models");
  const target = path.join(dir, `ggml-${safeName}.bin`);
  if (fs.existsSync(target)) return { name: safeName, path: target };
  await ensureDir(dir);
  sendProgress(event, { phase: "runtime", message: `首次啟動：下載 Whisper ${safeName} 模型…`, progress: 45 });
  await downloadFile(`${MODEL_BASE_URL}/ggml-${safeName}.bin`, target, progress => sendProgress(event, { phase: "runtime", message: `下載 ${safeName} 模型…`, progress: 45 + progress * 35 }));
  return { name: safeName, path: target };
}

async function probeDuration(filePath, job) {
  const result = await runCommand(ffprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], { job });
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("無法取得影片長度；請確認檔案未損壞且包含可讀取的媒體串流。");
  return duration;
}

async function inspectLocal(filePath) {
  const duration = await probeDuration(filePath);
  const stat = await fsp.stat(filePath);
  return { title: path.basename(filePath), duration, size: stat.size, sourceType: "file" };
}

async function inspectRemote(url, event) {
  const ytDlp = await ensureYtDlp(event);
  const result = await runCommand(ytDlp, ["--dump-single-json", "--no-warnings", "--skip-download", "--no-playlist", url]);
  const data = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  return { title: data.title || data.fulltitle || "遠端影片", duration: Number(data.duration || 0), sourceType: "url", webpageUrl: data.webpage_url || url, extractor: data.extractor_key || "unknown" };
}

async function downloadRemote(url, job, event) {
  const ytDlp = await ensureYtDlp(event);
  const dir = path.join(os.tmpdir(), `smart-video-transcript-${job.id}`);
  await ensureDir(dir);
  const output = path.join(dir, "source.%(ext)s");
  sendProgress(event, { phase: "download", message: "正在擷取網址中的影片音訊…", progress: 8 });
  await runCommand(ytDlp, ["--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "wav", "--audio-quality", "0", "--ffmpeg-location", path.dirname(ffmpegPath()), "-o", output, url], { job, onStderr: text => {
    if (/downloading|destination/i.test(text)) sendProgress(event, { phase: "download", message: "正在下載影片音訊…", progress: 12 });
  } });
  const files = await fsp.readdir(dir);
  const source = files.find(name => /^source\./i.test(name) && !name.endsWith(".part"));
  if (!source) throw new Error("網址影片下載完成但找不到音訊檔。影片可能需要登入、含 DRM，或網站阻擋下載。");
  return path.join(dir, source);
}

function parseTimestamp(value) {
  if (typeof value === "number") return value > 10000 ? value / 1000 : value;
  const match = String(value || "").match(/(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || 0}`);
}

function normalizeWhisper(json, chunkStart, chunkDuration) {
  const list = Array.isArray(json?.transcription) ? json.transcription : Array.isArray(json?.segments) ? json.segments : [];
  return list.map((segment, index) => {
    const from = segment.offsets?.from ?? segment.start ?? segment.timestamps?.from;
    const to = segment.offsets?.to ?? segment.end ?? segment.timestamps?.to;
    const fromSeconds = segment.offsets?.from != null ? Number(from) / 1000 : parseTimestamp(from);
    const toSeconds = segment.offsets?.to != null ? Number(to) / 1000 : parseTimestamp(to);
    const start = chunkStart + fromSeconds;
    const end = chunkStart + (to == null ? Math.min(chunkDuration, fromSeconds + 8) : toSeconds);
    const text = String(segment.text || "").replace(/\s+/g, " ").trim();
    return { id: `${Math.round(start * 10)}-${index}`, start, end: Math.max(end, start + 0.2), speaker: segment.speaker || segment.speaker_id || "", text };
  }).filter(record => record.text);
}

async function transcribeChunk(binary, model, chunkPath, chunkStart, chunkDuration, options, job) {
  const outputBase = chunkPath.replace(/\.wav$/i, "");
  const args = ["-m", model, "-f", chunkPath, "-oj", "-of", outputBase];
  if (options.language && options.language !== "auto") args.push("-l", options.language);
  await runCommand(binary, args, { job });
  const jsonPath = `${outputBase}.json`;
  try {
    const json = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
    return normalizeWhisper(json, chunkStart, chunkDuration);
  } catch {
    const textPath = `${outputBase}.txt`;
    try {
      const text = (await fsp.readFile(textPath, "utf8")).trim();
      return text ? [{ start: chunkStart, end: chunkStart + chunkDuration, speaker: "", text }] : [];
    } catch {
      return [];
    }
  }
}

async function processTranscription(event, options) {
  const id = crypto.randomUUID();
  const job = { id, children: new Set(), cancelled: false };
  jobs.set(id, job);
  let workingDir = null;
  try {
    const chunkSeconds = Math.max(10, Math.min(300, Number(options.chunkSeconds) || 30));
    const retries = Math.max(0, Math.min(5, Number(options.retryCount) || 3));
    sendProgress(event, { jobId: id, phase: "prepare", message: "準備本機語音辨識環境…", progress: 1 });
    const binary = await ensureWhisper(event);
    const model = await ensureModel(options.model || "base", event);
    let sourcePath = options.filePath;
    let sourceName = sourcePath ? path.basename(sourcePath) : options.sourceUrl;
    if (options.sourceUrl) {
      sourcePath = await downloadRemote(options.sourceUrl, job, event);
      sourceName = options.sourceUrl;
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("找不到影片檔案。");
    const duration = await probeDuration(sourcePath, job);
    workingDir = path.join(os.tmpdir(), `smart-video-transcript-${id}`);
    await ensureDir(workingDir);
    const total = Math.ceil(duration / chunkSeconds);
    const records = [];
    for (let index = 0; index < total; index += 1) {
      if (job.cancelled) throw new Error("使用者停止處理；目前進度已保留。");
      const start = index * chunkSeconds;
      const length = Math.min(chunkSeconds, duration - start);
      const chunkPath = path.join(workingDir, `chunk-${String(index).padStart(5, "0")}.wav`);
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          sendProgress(event, { jobId: id, phase: "audio", message: `擷取片段 ${index + 1}/${total}…`, progress: 78 * index / total, index, total, start, duration });
          await runCommand(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(length), "-i", sourcePath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", chunkPath], { job });
          sendProgress(event, { jobId: id, phase: "transcribe", message: `辨識片段 ${index + 1}/${total}…`, progress: 78 * index / total + 18, index, total, start, duration, attempt });
          const chunkRecords = await transcribeChunk(binary, model.path, chunkPath, start, length, options, job);
          records.push(...chunkRecords);
          break;
        } catch (error) {
          lastError = error;
          if (job.cancelled) throw error;
          if (attempt < retries) sendProgress(event, { jobId: id, phase: "retry", message: `片段 ${index + 1} 失敗，正在重試（${attempt + 1}/${retries}）…`, progress: 78 * index / total + 18, index, total, attempt });
        }
      }
      if (lastError && !records.some(record => record.start >= start && record.start < start + length)) throw lastError;
      await fsp.rm(chunkPath, { force: true });
    }
    records.sort((a, b) => a.start - b.start);
    sendProgress(event, { jobId: id, phase: "done", message: "本機逐字稿完成", progress: 100, index: total, total, duration });
    return { jobId: id, title: sourceName, duration, records, model: model.name, local: true };
  } finally {
    jobs.delete(id);
    if (workingDir) await fsp.rm(workingDir, { recursive: true, force: true });
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: "#07111f",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("inspect-source", async (_event, options) => {
    if (options?.filePath) return inspectLocal(options.filePath);
    if (options?.sourceUrl) return inspectRemote(options.sourceUrl, _event);
    throw new Error("沒有可檢查的來源。");
  });
  ipcMain.handle("transcribe-source", (event, options) => processTranscription(event, options));
  ipcMain.handle("cancel-transcription", async (_event, jobId) => {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.cancelled = true;
    for (const child of job.children) {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill("SIGTERM");
    }
    return true;
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
