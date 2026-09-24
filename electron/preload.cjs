const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  isDesktop: true,
  getFilePath(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || "";
    }
  },
  inspectSource(options) {
    return ipcRenderer.invoke("inspect-source", options);
  },
  transcribe(options) {
    return ipcRenderer.invoke("transcribe-source", options);
  },
  correctTranscript(options) {
    return ipcRenderer.invoke("correct-transcript", options);
  },
  cancel(jobId) {
    return ipcRenderer.invoke("cancel-transcription", jobId);
  },
  onProgress(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("transcription-progress", listener);
    return () => ipcRenderer.removeListener("transcription-progress", listener);
  }
});
