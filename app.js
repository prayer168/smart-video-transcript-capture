(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const els = {
    file: $("#videoFile"), url: $("#videoUrl"), loadUrl: $("#loadUrlBtn"), dropzone: $("#dropzone"),
    fileMeta: $("#fileMeta"), video: $("#videoPreview"), language: $("#language"), apiKey: $("#apiKey"),
    chunkSeconds: $("#chunkSeconds"), retryCount: $("#retryCount"), diarization: $("#speakerDiarization"),
    outline: $("#generateOutline"), start: $("#startBtn"), stop: $("#stopBtn"), resume: $("#resumeCard"),
    resumeText: $("#resumeText"), resumeBtn: $("#resumeBtn"), clearResume: $("#clearResumeBtn"),
    overallStatus: $("#overallStatus"), overallProgress: $("#overallProgress"), liveStatus: $("#liveStatus"),
    segmentStatus: $("#segmentStatus"), errorLog: $("#errorLog"), transcriptList: $("#transcriptList"),
    transcriptEmpty: $("#transcriptEmpty"), transcriptCount: $("#transcriptCount"), summary: $("#summaryContent"),
    outlineContent: $("#outlineContent"), keywords: $("#keywordsContent"), downloads: $("#downloadGroup"),
  };

  const STEP_LABELS = { ingest: "取得影片", audio: "擷取音訊", transcribe: "語音辨識", outline: "生成大綱" };
  const CHECKPOINT_KEY = "smart-video-transcript-checkpoint-v1";
  const EXTENSIONS = ["mp4", "mkv", "mov", "avi", "webm"];
  const state = {
    file: null, sourceUrl: "", objectUrl: "", duration: 0, running: false, cancelled: false,
    records: [], checkpoint: null, audioContext: null, mediaStream: null, recorder: null, recognition: null,
  };

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
    $("#apiKeyGroup").classList.toggle("hidden", mode() === "browser");
  }));

  function revealSource(name, sourceUrl = "") {
    state.file = name instanceof File ? name : null; state.sourceUrl = sourceUrl; state.duration = 0;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); state.objectUrl = "";
    const src = state.file ? (state.objectUrl = URL.createObjectURL(state.file)) : sourceUrl;
    if (!src) return;
    els.video.crossOrigin = "anonymous"; els.video.src = src; els.video.hidden = false; els.video.load();
    els.video.onloadedmetadata = () => {
      state.duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
      const title = state.file ? state.file.name : new URL(sourceUrl).pathname.split("/").pop() || "遠端影片";
      els.fileMeta.classList.remove("empty"); els.fileMeta.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${formatTime(state.duration)} · ${state.file ? formatBytes(state.file.size) : "直接影片網址"}</span>`;
      els.start.disabled = false; setStep("ingest", "done", `${formatTime(state.duration)} · 已就緒`); setLive("影片已就緒，可以開始處理"); checkCheckpoint();
    };
    els.video.onerror = () => { els.start.disabled = true; logError("影片無法載入。請確認網址是可直接播放的影片檔，或改用本機上傳。瀏覽器可能也會因跨來源限制而無法擷取遠端音訊。"); };
  }
  function validateExtension(name) { const ext = name.split(".").pop().toLowerCase(); return EXTENSIONS.includes(ext); }
  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0]; if (!file) return;
    if (!validateExtension(file.name)) { logError("不支援的影片格式。請選擇 MP4、MKV、MOV、AVI 或 WEBM。"); els.file.value = ""; return; }
    clearError(); setSourceTab("upload"); revealSource(file);
  });
  ["dragenter", "dragover"].forEach(event => els.dropzone.addEventListener(event, e => { e.preventDefault(); els.dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(event => els.dropzone.addEventListener(event, e => { e.preventDefault(); els.dropzone.classList.remove("dragover"); }));
  els.dropzone.addEventListener("drop", e => { const file = e.dataTransfer.files?.[0]; if (file) { els.file.files = e.dataTransfer.files; els.file.dispatchEvent(new Event("change")); } });
  els.loadUrl.addEventListener("click", () => {
    const url = els.url.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) { logError("請輸入完整的 http:// 或 https:// 影片網址。"); return; }
    clearError(); setSourceTab("url"); revealSource(null, url);
  });

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
  function checkpointKey() { return JSON.stringify({ name: state.file?.name || state.sourceUrl, duration: Math.round(state.duration), chunk: Number(els.chunkSeconds.value) }); }
  function saveCheckpoint() {
    const payload = { key: checkpointKey(), name: state.file?.name || state.sourceUrl, duration: state.duration, chunk: Number(els.chunkSeconds.value), records: state.records, savedAt: new Date().toISOString() };
    sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify(payload));
  }
  function clearCheckpoint() { sessionStorage.removeItem(CHECKPOINT_KEY); state.checkpoint = null; els.resume.hidden = true; }
  function checkCheckpoint() {
    try { const item = JSON.parse(sessionStorage.getItem(CHECKPOINT_KEY) || "null"); if (!item || item.key !== checkpointKey() || !item.records?.length || item.records.length >= Math.ceil(state.duration / item.chunk)) return;
      state.checkpoint = item; els.resume.hidden = false; els.resumeText.textContent = `已完成 ${item.records.length} 個片段（${formatTime(item.records[item.records.length - 1].end)}），可以繼續。`;
    } catch { clearCheckpoint(); }
  }
  els.clearResume.addEventListener("click", clearCheckpoint);
  els.resumeBtn.addEventListener("click", () => { if (state.checkpoint) { state.records = state.checkpoint.records || []; els.resume.hidden = true; startProcessing(true); } });

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function getAudioStream() {
    if (typeof els.video.captureStream === "function") {
      const captured = els.video.captureStream(); const tracks = captured.getAudioTracks();
      if (tracks.length) return new MediaStream(tracks);
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
  async function transcribeBlob(blob, start, previousText = "") {
    const key = els.apiKey.value.trim(); if (!key) throw new Error("Whisper 模式需要 OpenAI API Key。");
    const form = new FormData(); form.append("file", blob, `segment-${Math.round(start)}.webm`); form.append("model", els.diarization.checked ? "gpt-4o-transcribe-diarize" : "gpt-4o-mini-transcribe"); form.append("response_format", els.diarization.checked ? "diarized_json" : "verbose_json");
    if (els.language.value !== "auto") form.append("language", els.language.value); if (previousText) form.append("prompt", previousText.slice(-500));
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!response.ok) { const detail = await response.text(); throw new Error(`API ${response.status}: ${detail.slice(0, 240)}`); }
    return response.json();
  }
  function normalizeResponse(data, start, duration) {
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if (!segments.length && data.text) return [{ start, end: start + duration, speaker: data.speaker || "", text: data.text.trim() }].filter(x => x.text);
    return segments.map((segment, index) => ({ start: start + Number(segment.start || 0), end: start + Number(segment.end || segment.start || Math.min(duration, 10)), speaker: segment.speaker || segment.speaker_id || "", text: String(segment.text || "").trim() })).filter(x => x.text).map(x => ({ ...x, id: `${Math.round(x.start * 10)}-${index}` }));
  }
  async function withRetry(task, count, label) {
    let lastError; for (let attempt = 0; attempt <= count; attempt++) { if (state.cancelled) throw new Error("使用者停止處理"); try { return await task(); } catch (error) { lastError = error; if (attempt < count) { setLive(`${label}失敗，${attempt + 1} 秒後重試`, `第 ${attempt + 1}/${count} 次重試`); await sleep((attempt + 1) * 1000); } } } throw lastError;
  }
  async function startProcessing(resume = false) {
    if (state.running) return; if (!state.file && !state.sourceUrl) { logError("請先選擇影片或載入影片網址。"); return; }
    if (mode() === "browser") { startBrowserRecognition(); return; }
    if (!els.apiKey.value.trim()) { logError("請輸入 OpenAI API Key，或切換到瀏覽器語音辨識模式。"); return; }
    state.running = true; state.cancelled = false; clearError(); els.start.disabled = true; els.stop.disabled = false; els.downloads.hidden = true;
    if (!resume) state.records = [];
    try {
      setOverall("active", 8, "準備音訊"); setStep("ingest", "done", `${formatTime(state.duration)} · 已就緒`); setStep("audio", "active", "建立音訊串流");
      const stream = state.mediaStream = getAudioStream(); setStep("audio", "done", "音訊串流已建立"); setStep("transcribe", "active", "等待片段");
      const chunk = Math.max(10, Math.min(120, Number(els.chunkSeconds.value) || 30)); const total = Math.ceil(state.duration / chunk); const completed = state.records.length;
      for (let index = completed; index < total; index++) {
        if (state.cancelled) throw new Error("使用者停止處理，已保存目前進度。");
        const start = index * chunk; const end = Math.min(state.duration, start + chunk); const label = `片段 ${index + 1}/${total}`;
        els.transcribeDetail.textContent = `${label} · ${formatTime(start)}–${formatTime(end)}`; setLive(`正在擷取並辨識 ${label}`, `${index + 1}/${total}`); setOverall("active", 10 + (index / total) * 75, `辨識 ${index + 1}/${total}`);
        const blob = await withRetry(() => recordSegment(stream, start, end), Number(els.retryCount.value) || 0, label);
        const data = await withRetry(() => transcribeBlob(blob, start, state.records.at(-1)?.text || ""), Number(els.retryCount.value) || 0, `${label} API`);
        state.records.push(...normalizeResponse(data, start, end - start)); state.records.sort((a, b) => a.start - b.start); renderTranscript(); saveCheckpoint();
      }
      setStep("transcribe", "done", `${state.records.length} 段逐字稿`); setOverall("active", 88, "整理結果");
      if (els.outline.checked) { setStep("outline", "active", "摘要與大綱生成中"); const result = await buildOutline(); renderSummary(result); setStep("outline", "done", "已完成摘要與大綱"); } else { setStep("outline", "done", "已略過"); }
      clearCheckpoint(); setOverall("done", 100, "處理完成"); setLive("影片逐字稿已完成", `${state.records.length} 段`); els.downloads.hidden = false;
    } catch (error) {
      setOverall("error", Math.max(12, Number.parseFloat(els.overallProgress.style.width) || 12), error.message.includes("停止") ? "已暫停" : "需要處理"); setLive(error.message.includes("停止") ? "已保存目前進度，可稍後繼續" : "處理遇到問題"); logError(error.message); saveCheckpoint();
    } finally { state.running = false; els.start.disabled = !state.file && !state.sourceUrl; els.stop.disabled = true; if (state.mediaStream) state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null; if (state.recorder?.state !== "inactive") state.recorder.stop(); state.recorder = null; }
  }
  els.start.addEventListener("click", () => startProcessing(false));
  els.stop.addEventListener("click", () => { state.cancelled = true; setLive("正在安全停止並保存進度…"); if (state.recorder?.state !== "inactive") state.recorder.stop(); });

  async function buildOutline() {
    const joined = state.records.map(r => `[${formatTime(r.start)}] ${r.speaker ? `${r.speaker}: ` : ""}${r.text}`).join("\n");
    const key = els.apiKey.value.trim(); if (!key) return heuristicOutline();
    try {
      const prompt = `請根據以下影片逐字稿，回傳純 JSON，不要 Markdown：{"summary":"約150字摘要","keywords":["關鍵字"],"outline":[{"start":0,"title":"章節標題","description":"章節重點"}]}。章節 start 必須使用逐字稿中存在的秒數。不要捏造原文沒有的內容。\n\n${joined.slice(0, 50000)}`;
      const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, messages: [{ role: "system", content: "你是影片內容整理助手。" }, { role: "user", content: prompt }] }) });
      if (!response.ok) throw new Error("大綱 API 無法完成"); const data = await response.json(); const raw = data.choices?.[0]?.message?.content || ""; const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/\s*```$/, "")); return parsed;
    } catch (error) { logError(`摘要／大綱生成改用本機規則：${error.message}`); return heuristicOutline(); }
  }
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
