# 智慧影片逐字稿（Smart Video Transcript Capture）

版本：**v0.3.0**（Windows Desktop）

這是一套不需要 OpenAI API Key 的 Windows 桌面 App。影片下載、音訊切割、語音辨識與摘要大綱都在本機執行，適合處理本機影片，以及可由 `yt-dlp` 公開擷取的影音網址。

## 下載 Windows 安裝檔

- [Smart-Video-Transcript-Setup-0.3.0.exe](https://github.com/prayer168/smart-video-transcript-capture/releases/download/v0.3.0/Smart-Video-Transcript-Setup-0.3.0.exe)
- [v0.3.0 Release 頁面](https://github.com/prayer168/smart-video-transcript-capture/releases/tag/v0.3.0)

## 主要功能

- 貼上 YouTube、部分 Facebook、短影音與其他 `yt-dlp` 支援的公開影音網址
- 上傳 MP4、MKV、MOV、AVI、WEBM、M4V、M4A、MP3、WAV、FLAC、OGG、AAC
- FFmpeg 自動轉換音訊、取得長度並依固定秒數切段
- 本機 Whisper 語音辨識，不需要 OpenAI API Key 或雲端 API
- Tiny、Base、Small、Medium 模型選擇
- 長影片逐段處理、進度顯示、失敗重試與中斷後繼續
- 時間戳記、逐字稿、摘要、章節大綱與關鍵字
- 可選本機逐字稿校正：針對明顯誤辨字詞與少量語助詞逐段修正；保留原文切換檢視
- 匯出 TXT、Markdown、SRT、VTT、JSON
- Windows 安裝程式 `setup.exe`，含透明背景桌面捷徑圖示

## 系統架構

```text
Windows Desktop App（Electron）
        ↓
網址：yt-dlp      本機檔案：直接讀取
        ↓
FFmpeg：取得長度、轉 WAV、切割音訊
        ↓
Whisper.cpp：本機語音辨識
        ↓
可選 llama.cpp + Qwen3 0.6B：逐字稿校正（保留原文與時間戳記）
        ↓
逐字稿合併、時間戳記、摘要大綱與匯出
```

## 安裝與執行

### 開發模式

需要 Node.js 20 以上：

```powershell
npm install
npm start
```

第一次使用本機 Whisper 時，App 會在使用者資料夾下載：

- `yt-dlp.exe`
- Whisper.cpp Windows 執行檔
- 選定的 Whisper 模型
- 勾選「逐字稿校正」時，下載 llama.cpp 與約 484 MB 的本機校正模型

下載完成後，語音辨識可在本機離線執行。模型大小與準確度取捨如下：

| 模型 | 特性 |
| --- | --- |
| Tiny | 最快，準確度較低 |
| Base | 建議起始選擇，速度與準確度平衡 |
| Small | 較準確，需要較多時間與記憶體 |
| Medium | 高準確度，需要較多記憶體與磁碟空間 |

### 建立 Windows setup.exe

```powershell
npm run dist
```

輸出檔會放在 `release/Smart-Video-Transcript-Setup-0.3.0.exe`。安裝時會建立具有專用圖示的桌面捷徑。

## 網址擷取限制

網址擷取由 `yt-dlp` 處理，能支援的網站與格式會隨網站改版而變動。以下情況可能無法下載：

- 私人影片、需要登入或年齡驗證的影片
- DRM、加密串流或付費內容
- 網站封鎖自動化下載
- 需要 Cookie、驗證碼或特殊瀏覽器工作階段的內容
- 來源網站沒有可取得的音訊串流

這些限制不是 Whisper 造成的，而是來源網站的存取權限與串流格式限制。請只處理你有權下載與轉錄的內容。

## 本機處理與隱私

- 不需要 OpenAI API Key
- 不會把影片或音訊上傳到 OpenAI
- 本機 Whisper 模型與暫存音訊放在 Windows 使用者資料夾
- 下載來源網址時，影片會先暫存於本機，再分段處理
- 完成或取消工作後，App 會清理大部分暫存片段
- 校正模型只修改逐字稿文字，原始辨識結果保存在每一段的 `rawText`，時間戳記不會更動；若改動過大或數字變動，該段會保留原文

## 目前限制

- 說話者辨識介面已保留，但完整聲紋分離仍需整合本機 diarization 模型。
- 背景音樂、噪音與多人重疊說話會降低辨識準確度。
- 摘要與大綱目前使用本機規則生成，不是大型語言模型生成。
- 逐字稿校正是小型本機模型，可能漏掉錯字或誤判；請用「查看辨識原文」比對重要內容。
- GitHub Pages 版本只保留介面預覽；完整本機辨識功能請使用 Windows `setup.exe`。

## 專案結構

```text
.
├── VERSION
├── README.md
├── package.json             # Electron 與 setup.exe 打包設定
├── electron/
│   ├── main.cjs             # 本機下載、FFmpeg、Whisper 與 IPC
│   ├── correction.cjs       # 逐字稿校正與保守改動檢查
│   └── preload.cjs          # 安全的 Renderer／主程序橋接
├── assets/
│   ├── app-icon.png         # 去背圖示原圖
│   └── app-icon.ico         # Windows 安裝檔與桌面捷徑圖示
├── dist/
│   ├── index.html           # App 介面
│   ├── app.js               # 互動、進度、結果與匯出
│   └── styles.css           # 介面樣式
└── tests/fixtures/          # 測試用素材
```

## 版本策略

本專案採用語意化版本號：`主版本.次版本.修訂版本`。

- `0.3.0`：加入透明桌面圖示、主介面版權與來源說明、本機逐字稿校正及原文比對。
- `0.2.0`：改為 Windows Electron 桌面 App，加入 yt-dlp、FFmpeg、本機 Whisper 與 `setup.exe` 打包流程。
- `0.1.0`：原始瀏覽器版影片匯入、分段、逐字稿、摘要大綱與匯出 MVP。
