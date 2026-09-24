(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const els = {
    file: $("#videoFile"), url: $("#videoUrl"), loadUrl: $("#loadUrlBtn"), dropzone: $("#dropzone"),
    fileMeta: $("#fileMeta"), video: $("#videoPreview"), language: $("#language"), modelSize: $("#modelSize"),
    chunkSeconds: $("#chunkSeconds"), retryCount: $("#retryCount"), diarization: $("#speakerDiarization"),
    outline: $("#generateOutline"), start: $("#startBtn"), stop: $("#stopBtn"), resume: $("#resumeCard"),
    resumeText: $("#resumeText"), resumeBtn: $("#resumeBtn"), clearResume: $("#clearResumeBtn"),
    overallStatus: $("#overallStatus"), overallProgress: $("#overallProgress"), liveStatus: $("#liveStatus"), transcribeDetail: $("#transcribeDetail"),
    segmentStatus: $("#segmentStatus"), errorLog: $("#errorLog"), transcriptList: $("#transcriptList"),
    transcriptEmpty: $("#transcriptEmpty"), transcriptCount: $("#transcriptCount"), summary: $("#summaryContent"),
    outlineContent: $("#outlineContent"), keywords: $("#keywordsContent"), downloads: $("#downloadGroup"),
  };

  const STEP_LABELS = { ingest: "取得影片", audio: "擷取音訊", transcribe: "語音辨識", outline: "生成大綱" };
  const CHECKPOINT_KEY = "smart-video-transcript-checkpoint-v1";
  const EXTENSIONS = ["mp4", "mkv", "mov", "avi", "webm"];
  const state = {
    file: null, filePath: "", sourceUrl: "", objectUrl: "", duration: 0, running: false, cancelled: false,
    records: [], completedChunks: 0, outline: null, checkpoint: null, jobId: null, audioContext: null, mediaStream: null, recorder: null, recognition: null,
  };
  const desktopMode = Boolean(window.desktopApi?.isDesktop);

  function mode() { return $("input[name=mode]:checked").value; }
  function formatTime(seconds, short = false) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"]; const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function setStep(name, status, detail = "") {
    const item = $(`[data-step="${name}"]`); if (!item) return;
    item.classList.toggle("active", status === "active"); item.classList.toggle("done", status === "done");
    $(".step-state", item).textContent = status === "done" ? "✓" : status === "active" ? "◌" : "○";
    $(`#${name}Detail`).textContent = detail || (status === "done" ? "已完成" : status === "active" ? "處理中" : "尚未開始");
  }
  function setOverall(status, progress, text) {
    els.overallStatus.className = `status-pill ${status}`; els.overallStatus.textContent = text;
    els.overallProgress.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
  function logError(message) { els.errorLog.hidden = false; els.errorLog.textContent = message; }
  function clearError() { els.errorLog.hidden = true; els.errorLog.textContent = ""; }
  function setLive(text, segment = "—") { els.liveStatus.textContent = text; els.segmentStatus.textContent = segment; }

  function setSourceTab(tab) {
    $$("[data-source-tab]").forEach(b => b.classList.toggle("active", b.dataset.sourceTab === tab));
    $$("[data-source-view]").forEach(v => v.classList.toggle("active", v.dataset.sourceView === tab));
  }
  $$('[data-source-tab]').forEach(button => button.addEventListener("click", () => setSourceTab(button.dataset.sourceTab)));
  $$('input[name="mode"]').forEach(input => input.addEventListener("change", () => {
    $$(".mode-card").forEach(card => card.classList.toggle("selected", $("input", card).checked));
    const localEngine = $("#localEngineGroup"); if (localEngine) localEngine.classList.toggle("hidden", mode() === "browser");
  }));

  function revealSource(name, sourceUrl = "") {
    state.file = name instanceof File ? name : null; state.filePath = state.file && desktopMode ? (window.desktopApi.getFilePath(state.file) || state.file.path || "") : ""; state.sourceUrl = sourceUrl; state.duration = 0; state.completedChunks = 0;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); state.objectUrl = "";
    const src = state.file ? (state.objectUrl = URL.createObjectURL(state.file)) : sourceUrl;
    if (!src) return;
    els.video.crossOrigin = "anonymous"; els.video.src = src; els.video.hidden = false; els.video.load();
    if (desktopMode && state.filePath) {
      window.desktopApi.inspectSource({ filePath: state.filePath }).then(meta => {
        state.duration = Number(meta.duration) || 0;
        els.fileMeta.classList.remove("empty"); els.fileMeta.innerHTML = `<strong>${escapeHtml(meta.title || state.file.name)}</strong><span>${formatTime(state.duration)} · ${formatBytes(meta.size)}</span>`;
        els.start.disabled = false; setStep("ingest", "done", `${formatTime(state.duration)} · 已就緒`); setLive("影片已就緒，可以開始處理"); checkCheckpoint();
      }).catch(error => { els.start.disabled = true; logError(error.message); });
    }
    els.video.onloadedmetadata = () => {
      state.duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
      const title = state.file ? state.file.name : new URL(sourceUrl).pathname.split("/").pop() || "遠端影片";
      els.fileMeta.classList.remove("empty"); els.fileMeta.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${formatTime(state.duration)} · ${state.file ? formatBytes(state.file.size) : "直接影片網址"}</span>`;
      els.start.disabled = false; setStep("ingest", "done", `${formatTime(state.duration)} · 已就緒`); setLive("影片已就緒，可以開始處理"); checkCheckpoint();
    };
    els.video.onerror = () => { if (desktopMode && state.filePath) return; els.start.disabled = true; logError("影片無法載入。請確認網址是可直接播放的影片檔，或改用本機上傳。瀏覽器可能也會因跨來源限制而無法擷取遠端音訊。"); };
  }
  function validateExtension(name) { const ext = name.split(".").pop().toLowerCase(); return EXTENSIONS.concat(["m4v", "m4a", "mp3", "wav", "flac", "ogg", "aac"]).includes(ext); }
  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0]; if (!file) return;
    if (!validateExtension(file.name)) { logError("不支援的影音格式。請選擇 MP4、MKV、MOV、AVI、WEBM 或常見音訊格式。"); els.file.value = ""; return; }
    clearError(); setSourceTab("upload"); revealSource(file);
  });
  ["dragenter", "dragover"].forEach(event => els.dropzone.addEventListener(event, e => { e.preventDefault(); els.dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(event => els.dropzone.addEventListener(event, e => { e.preventDefault(); els.dropzone.classList.remove("dragover"); }));
  els.dropzone.addEventListener("drop", e => { const file = e.dataTransfer.files?.[0]; if (file) { els.file.files = e.dataTransfer.files; els.file.dispatchEvent(new Event("change")); } });
  els.loadUrl.addEventListener("click", () => {
    const url = els.url.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) { logError("請輸入完整的 http:// 或 https:// 影片網址。"); return; }
    clearError(); setSourceTab("url");
    if (desktopMode) {
      state.file = null; state.filePath = ""; state.sourceUrl = url; state.duration = 0; els.start.disabled = true; setStep("ingest", "active", "正在分析網址"); setLive("正在辨識網址中的影片…");
      window.desktopApi.inspectSource({ sourceUrl: url }).then(meta => {
        state.duration = Number(meta.duration) || 0; const label = meta.title || "遠端影片";
        els.fileMeta.classList.remove("empty"); els.fileMeta.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${state.duration ? formatTime(state.duration) : "長度待下載後確認"} · ${escapeHtml(meta.extractor || "網址來源")}</span>`;
        els.video.hidden = true; els.start.disabled = false; setStep("ingest", "done", `${state.duration ? formatTime(state.duration) : "網址已就緒"}`); setLive("網址已就緒，可以開始處理"); checkCheckpoint();
      }).catch(error => { els.start.disabled = true; setStep("ingest", "active", "網址無法使用"); logError(`網址分析失敗：${error.message}`); });
      return;
    }
    revealSource(null, url);
  });

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
  function checkpointKey() { return JSON.stringify({ name: state.file?.name || state.sourceUrl, duration: Math.round(state.duration), chunk: Number(els.chunkSeconds.value) }); }
  function saveCheckpoint() {
    const payload = { key: checkpointKey(), name: state.file?.name || state.sourceUrl, duration: state.duration, chunk: Number(els.chunkSeconds.value), completedChunks: state.completedChunks, records: state.records, savedAt: new Date().toISOString() };
    sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify(payload));
  }
  function clearCheckpoint() { sessionStorage.removeItem(CHECKPOINT_KEY); state.checkpoint = null; els.resume.hidden = true; }
  function checkCheckpoint() {
    try { const item = JSON.parse(sessionStorage.getItem(CHECKPOINT_KEY) || "null"); if (!item || item.key !== checkpointKey() || !item.records?.length || item.records.length >= Math.ceil(state.duration / item.chunk)) return;
      state.checkpoint = item; els.resume.hidden = false; els.resumeText.textContent = `已完成 ${item.records.length} 段逐字稿，可以繼續。`;
    } catch { clearCheckpoint(); }
  }
  els.clearResume.addEventListener("click", clearCheckpoint);
  els.resumeBtn.addEventListener("click", () => { if (state.checkpoint) { state.records = state.checkpoint.records || []; state.completedChunks = Number(state.checkpoint.completedChunks || 0); els.resume.hidden = true; startProcessing(true); } });

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function getAudioStream() {
    if (typeof els.video.captureStream === "function") {
      const captured = els.video.captureStream(); const tracks = captured.getAudioTracks();
      if (tracks.length) return new MediaStream(tracks);
      throw new Error("影片沒有可讀取的音訊軌。");
    }
    if (!window.AudioContext && !window.webkitAudioContext) throw new Error("此瀏覽器不支援擷取影片音訊。");
    state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaElementSource(els.video); const destination = state.audioContext.createMediaStreamDestination();
    source.connect(destination); source.connect(state.audioContext.destination); return destination.stream;
  }
  function recorderMime() { return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type)) || ""; }
  async function recordSegment(stream, start, end) {
    if (!stream?.getAudioTracks().length) throw new Error("影片沒有可讀取的音訊軌。");
    await seekVideo(start); const chunks = []; const mime = recorderMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); state.recorder = recorder;
    const done = new Promise((resolve, reject) => { recorder.ondataavailable = e => e.data.size && chunks.push(e.data); recorder.onerror = () => reject(new Error("錄製音訊片段失敗")); recorder.onstop = () => resolve(new Blob(chunks, { type: mime || "audio/webm" })); });
    recorder.start(); await els.video.play(); await sleep(Math.max(500, (end - start) * 1000)); if (recorder.state !== "inactive") recorder.stop();
    state.recorder = null; return done;
  }
  function seekVideo(time) { return new Promise((resolve, reject) => { const onSeek = () => { cleanup(); resolve(); }; const onError = () => { cleanup(); reject(new Error("影片無法跳轉到指定片段")); }; const cleanup = () => { els.video.removeEventListener("seeked", onSeek); els.video.removeEventListener("error", onError); }; els.video.addEventListener("seeked", onSeek, { once: true }); els.video.addEventListener("error", onError, { once: true }); els.video.currentTime = Math.max(0, time); }); }
  async function transcribeBlob() { throw new Error("瀏覽器版不使用雲端 API；請使用 Windows 桌面版進行本機 Whisper 辨識。"); }
  function normalizeResponse(data, start, duration) {
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if (!segments.length && data.text) return [{ start, end: start + duration, speaker: data.speaker || "", text: data.text.trim() }].filter(x => x.text);
    return segments.map((segment, index) => ({ start: start + Number(segment.start || 0), end: start + Number(segment.end || segment.start || Math.min(duration, 10)), speaker: segment.speaker || segment.speaker_id || "", text: String(segment.text || "").trim() })).filter(x => x.text).map(x => ({ ...x, id: `${Math.round(x.start * 10)}-${index}` }));
  }
  async function withRetry(task, count, label) {
    let lastError; for (let attempt = 0; attempt <= count; attempt++) { if (state.cancelled) throw new Error("使用者停止處理"); try { return await task(); } catch (error) { lastError = error; if (attempt < count) { setLive(`${label}失敗，${attempt + 1} 秒後重試`, `第 ${attempt + 1}/${count} 次重試`); await sleep((attempt + 1) * 1000); } } } throw lastError;
  }
  function handleDesktopProgress(payload) {
    if (payload.jobId) state.jobId = payload.jobId;
    if (payload.duration) state.duration = Number(payload.duration);
    const phase = payload.phase;
    if (payload.records) { state.records = payload.records; state.completedChunks = Number(payload.index || 0); renderTranscript(); saveCheckpoint(); }
    if (phase === "runtime" || phase === "prepare") { setStep("ingest", "active", payload.message); setLive(payload.message); setOverall("active", payload.progress || 2, "準備本機引擎"); }
    if (phase === "download") { setStep("ingest", "active", payload.message); setLive(payload.message); setOverall("active", payload.progress || 10, "下載影片"); }
    if (phase === "audio") { setStep("ingest", "done", "來源已就緒"); setStep("audio", "active", payload.message); setLive(payload.message, `${(payload.index || 0) + 1}/${payload.total || "—"}`); setOverall("active", 8 + (payload.progress || 0), "擷取音訊"); }
    if (phase === "transcribe") { setStep("audio", "done", "音訊片段已建立"); setStep("transcribe", "active", payload.message); setLive(payload.message, `${(payload.index || 0) + 1}/${payload.total || "—"}`); setOverall("active", 12 + (payload.progress || 0), "本機語音辨識"); }
    if (phase === "retry") { setStep("transcribe", "active", payload.message); setLive(payload.message, `${(payload.index || 0) + 1}/${payload.total || "—"}`); logError(payload.message); }
    if (phase === "done") { setStep("audio", "done", "音訊擷取完成"); setStep("transcribe", "done", "本機辨識完成"); setOverall("active", 92, "整理結果"); setLive(payload.message); }
  }
  if (desktopMode) window.desktopApi.onProgress(handleDesktopProgress);

  async function startDesktopProcessing(resume = false) {
    if (!state.filePath && !state.sourceUrl) { logError("找不到來源檔案或網址。"); return; }
    state.running = true; state.cancelled = false; clearError(); els.start.disabled = true; els.stop.disabled = false; els.downloads.hidden = true;
    if (!resume) { state.records = []; state.completedChunks = 0; }
    try {
      const result = await window.desktopApi.transcribe({ filePath: state.filePath, sourceUrl: state.sourceUrl, language: els.language.value, model: els.modelSize?.value || "base", chunkSeconds: Number(els.chunkSeconds.value) || 30, retryCount: Number(els.retryCount.value) || 3, diarization: els.diarization.checked, resumeIndex: resume ? state.completedChunks : 0, resumeRecords: resume ? state.records : [] });
      state.jobId = null; state.duration = result.duration || state.duration; state.records = result.records || []; state.completedChunks = Math.ceil(state.duration / (Number(els.chunkSeconds.value) || 30)); renderTranscript(); setStep("transcribe", "done", `${state.records.length} 段逐字稿`);
      if (els.outline.checked) { setStep("outline", "active", "本機摘要與大綱生成中"); renderSummary(heuristicOutline()); setStep("outline", "done", "已完成本機摘要與大綱"); } else setStep("outline", "done", "已略過");
      clearCheckpoint(); setOverall("done", 100, "處理完成"); setLive(`本機逐字稿已完成 · ${result.model || "Whisper"}`, `${state.records.length} 段`); els.downloads.hidden = false;
    } catch (error) {
      setOverall("error", Number.parseFloat(els.overallProgress.style.width) || 12, error.message.includes("停止") ? "已暫停" : "需要處理"); setLive(error.message.includes("停止") ? "已保存目前進度，可稍後繼續" : "本機處理遇到問題"); logError(error.message); saveCheckpoint();
    } finally { state.running = false; state.jobId = null; els.start.disabled = !state.file && !state.sourceUrl; els.stop.disabled = true; }
  }

  async function startProcessing(resume = false) {
    if (state.running) return; if (!state.file && !state.filePath && !state.sourceUrl) { logError("請先選擇影片或載入影片網址。"); return; }
    if (mode() === "browser") { startBrowserRecognition(); return; }
    if (desktopMode) { await startDesktopProcessing(resume); return; }
    logError("本機 Whisper 需要使用 Windows 桌面版 App；目前瀏覽器頁面只提供介面預覽與麥克風模式。");
    return;
  }
  els.start.addEventListener("click", () => startProcessing(false));
  els.stop.addEventListener("click", () => { state.cancelled = true; setLive("正在安全停止並保存進度…"); if (desktopMode && state.jobId) void window.desktopApi.cancel(state.jobId); if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop(); });

  async function buildOutline() { return heuristicOutline(); }
  function heuristicOutline() {
    const summary = state.records.map(r => r.text).join(" ").slice(0, 420) || "尚未辨識到可整理的語音內容。";
    const outline = []; const groupSize = Math.max(1, Math.ceil(state.records.length / 6));
    for (let i = 0; i < state.records.length; i += groupSize) outline.push({ start: state.records[i].start, title: state.records[i].text.slice(0, 28) || `第 ${outline.length + 1} 章`, description: state.records.slice(i, i + groupSize).map(r => r.text).join(" ").slice(0, 150) });
    const words = joinedWords(state.records.map(r => r.text).join(" ")); const keywords = [...new Set(words)].slice(0, 12); return { summary, outline, keywords };
  }
  function joinedWords(text) { const matches = text.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9-]{2,}/g) || []; const counts = new Map(); matches.forEach(word => counts.set(word.toLowerCase(), (counts.get(word.toLowerCase()) || 0) + 1)); return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]); }
  function renderTranscript() {
    els.transcriptEmpty.hidden = state.records.length > 0; els.transcriptList.hidden = !state.records.length; els.transcriptCount.textContent = `${state.records.length} 段`;
    els.transcriptList.innerHTML = state.records.map(record => `<article class="transcript-line"><time class="timestamp">${formatTime(record.start)}</time><span class="speaker">${escapeHtml(record.speaker || "")}</span><span class="transcript-text">${escapeHtml(record.text)}</span></article>`).join("");
  }
  function renderSummary(data) {
    els.summary.classList.remove("empty-copy"); els.summary.textContent = data.summary || "沒有摘要。";
    els.outlineContent.classList.remove("empty-copy"); els.outlineContent.innerHTML = (data.outline || []).map(item => `<div class="outline-item"><span class="outline-time">${formatTime(item.start)}</span><div><div class="outline-title">${escapeHtml(item.title)}</div><div class="outline-desc">${escapeHtml(item.description)}</div></div></div>`).join("") || "沒有章節大綱。";
    els.keywords.classList.remove("empty-copy"); els.keywords.innerHTML = (data.keywords || []).map(word => `<span class="keyword">${escapeHtml(word)}</span>`).join("") || "沒有關鍵字。";
    state.outline = data;
  }

  function startBrowserRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { logError("此瀏覽器不支援語音辨識，請使用 Chrome 或 Edge，或切換到 Whisper 模式。"); return; }
    if (state.recognition) { state.recognition.stop(); return; }
    state.records = []; state.cancelled = false; clearError(); setOverall("active", 20, "瀏覽器即時辨識"); setStep("ingest", "done", "影片已載入"); setStep("audio", "done", "使用麥克風"); setStep("transcribe", "active", "聆聽中"); els.start.disabled = true; els.stop.disabled = false; els.downloads.hidden = true;
    const recognition = new Recognition(); state.recognition = recognition; recognition.lang = els.language.value === "auto" ? "zh-TW" : els.language.value === "zh" ? "zh-TW" : els.language.value; recognition.continuous = true; recognition.interimResults = true;
    const started = performance.now(); recognition.onresult = event => { for (let i = event.resultIndex; i < event.results.length; i++) { const result = event.results[i]; if (!result.isFinal) continue; const text = result[0].transcript.trim(); if (text) state.records.push({ start: (performance.now() - started) / 1000, end: (performance.now() - started) / 1000, speaker: "", text }); } renderTranscript(); setOverall("active", 60, "即時辨識中"); setLive("正在聆聽麥克風", `${state.records.length} 段`); };
    recognition.onerror = event => { logError(`瀏覽器語音辨識錯誤：${event.error}`); stopBrowserRecognition(); };
    recognition.onend = () => { if (state.recognition && !state.cancelled) { try { recognition.start(); } catch {} } };
    recognition.start(); setLive("正在聆聽麥克風，請開始說話");
  }
  async function finishBrowserOutline() { setStep("outline", "active", "摘要與大綱生成中"); const result = await buildOutline(); renderSummary(result); setStep("outline", "done", "已完成摘要與大綱"); }
  function stopBrowserRecognition() { if (!state.recognition) return; state.cancelled = true; state.recognition.onend = null; state.recognition.stop(); state.recognition = null; state.running = false; els.start.disabled = false; els.stop.disabled = true; setStep("transcribe", "done", `${state.records.length} 段逐字稿`); setStep("outline", "done", "即時模式未生成"); setOverall("done", 100, "辨識完成"); setLive("瀏覽器辨識已停止"); if (state.records.length) { els.downloads.hidden = false; if (els.outline.checked) void finishBrowserOutline(); } }
  els.stop.addEventListener("click", () => { if (state.recognition) stopBrowserRecognition(); });

  $$('[data-result-tab]').forEach(button => button.addEventListener("click", () => { $$("[data-result-tab]").forEach(b => b.classList.toggle("active", b === button)); $$("[data-result-view]").forEach(v => v.classList.toggle("active", v.dataset.resultView === button.dataset.resultTab)); }));
  function exportText(kind) {
    if (!state.records.length) return; let content = "", type = "text/plain", ext = kind;
    if (kind === "txt") content = state.records.map(r => `${formatTime(r.start)}${r.speaker ? ` ${r.speaker}` : ""}\n${r.text}`).join("\n\n");
    if (kind === "md") content = `# ${state.file?.name || "影片逐字稿"}\n\n${state.outline?.summary ? `## 摘要\n\n${state.outline.summary}\n\n` : ""}## 逐字稿\n\n${state.records.map(r => `**${formatTime(r.start)}** ${r.speaker ? `**${r.speaker}** ` : ""}${r.text}`).join("\n\n")}`;
    if (kind === "srt") { type = "application/x-subrip"; content = state.records.map((r, i) => `${i + 1}\n${srtTime(r.start)} --> ${srtTime(r.end || r.start + 3)}\n${r.speaker ? `${r.speaker}: ` : ""}${r.text}\n`).join("\n"); }
    if (kind === "vtt") { type = "text/vtt"; content = `WEBVTT\n\n${state.records.map(r => `${vttTime(r.start)} --> ${vttTime(r.end || r.start + 3)}\n${r.speaker ? `${r.speaker}: ` : ""}${r.text}\n`).join("\n")}`; }
    if (kind === "json") { type = "application/json"; ext = "json"; content = JSON.stringify({ source: state.file?.name || state.sourceUrl, duration: state.duration, records: state.records, outline: state.outline || null }, null, 2); }
    const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement("a"); a.href = url; a.download = `video-transcript.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  function srtTime(value) { const ms = Math.round((value % 1) * 1000); return `${formatTime(value).replace(/^(\d+):(\d+)$/, "00:$1:$2")},${String(ms).padStart(3, "0")}`; }
  function vttTime(value) { const ms = Math.round((value % 1) * 1000); return `${formatTime(value).replace(/^(\d+):(\d+)$/, "00:$1:$2")}.${String(ms).padStart(3, "0")}`; }
  $$('[data-download]').forEach(button => button.addEventListener("click", () => exportText(button.dataset.download)));
  window.addEventListener("beforeunload", () => { if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); });
})();
