# Live Translator 🌐

A real-time, bidirectional audio translator powered by Google's Gemini Live API. Translate spoken audio between multiple languages instantly with natural voice output.

## Overview

**Live Translator** is a browser-based application that enables seamless real-time translation of spoken audio. Using the Gemini Live API, it captures audio from your microphone and/or screen, translates it between selected language pairs, and speaks the translation back to you—all in real-time with minimal latency.

### Key Features

- **Real-time bidirectional translation** – Automatically detects the spoken language and outputs translation in the other language
- **Multiple audio sources** – Capture from microphone, browser tab audio, companion app audio, or both simultaneously
- **8+ languages supported** – English, Mandarin Chinese, Bengali, Japanese, Korean, Spanish, French, German, Arabic, Hindi, Portuguese, and more
- **Multiple voices** – Choose from 8 distinct AI voices (Zephyr, Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus)
- **Customizable system prompts** – Tailor the translation behavior to your needs
- **Session management** – Track session duration and conversation history
- **Pop-out window** – Use Picture-in-Picture mode for multitasking
- **Chat logging** – View and export conversation history
- **Mobile-responsive UI** – Sidebar-based settings work seamlessly on mobile and desktop
- **Zero data server** – API key and preferences stored only in your browser

## Project Structure

```
live-translator/
├── index.html           # Main HTML - header, sidebar, chat, modal sheets
├── companion/
│   └── windows/         # Optional localhost audio bridge for app/system audio
├── css/
│   └── style.css       # Responsive mobile-first styling
└── js/
    ├── app.js          # UI glue, lifecycle, preferences, DOM management
    ├── audio.js        # Audio capture & PCM processing (mic, display, TTS playback)
    └── gemini-live.js  # Gemini Live WebSocket client, reconnection logic
```

## Technical Details

### Audio Processing
- **Capture**: Uses Web Audio API + AudioWorklet for sample-rate conversion
  - Mic input: Captured at system rate, resampled to 16 kHz Int16 PCM
  - Display audio: Screen share API (Chromium/Chrome only)
  - Processing: Real-time filtering (echo cancellation, noise suppression, auto-gain control)
- **Playback**: TTS audio received at 24 kHz Int16 PCM, played back via Web Audio API
- **Levels**: Real-time audio level monitoring for visual feedback

### Gemini Live Client
- **Protocol**: WebSocket-based bidirectional streaming (models/gemini-3.1-flash-live-preview)
- **Features**:
  - Proactive reconnection with session resumption
  - Sliding-window context management
  - Turn-based conversation tracking
  - State machine (idle → connecting → connected → error → reconnecting)
- **Configuration**: System prompt template with `{source}` and `{target}` language placeholders

## Getting Started

### Prerequisites
- Modern web browser (Chrome/Chromium recommended for display audio support)
- Google Gemini API key (free tier available)

### Installation

1. Clone or download this repository
2. Open `index.html` in your browser (works from file:// or any web server)

### Configuration

1. **Get API Key**:
   - Visit [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   - Create a new API key
   - Copy it

2. **Launch the App**:
   - Click the ⚙️ **Settings** button (top-left)
   - Paste your API key in the "Gemini API key" field
   - Select your source and target languages
   - Choose a voice from the dropdown
  - Select audio source (Microphone, App audio, Companion app audio, or both)
   - Click **Save** or start translating

## Usage

### Basic Workflow

1. **Start**: Click the main play button to begin listening and translating
2. **Speak**: Say something in the source language
3. **Translate**: The AI listens, translates, and speaks back the translation
4. **Switch**: Optionally swap source/target languages with the 🔄 swap button
5. **Stop**: Click stop when done

### Advanced Features

#### Pop-Out Window
- Click the **📺 Pop out** button to open the translator in a floating window
- Continue translating while working in other tabs

#### Chat Log
- Click the **📋 Log** button to view the conversation history
- See input transcripts, output translations, and timestamps
- Useful for reviewing translated content

#### Custom System Prompt
- Click the **✏️ Customise system prompt** button to modify translation behavior
- Edit the template to adjust tone, strictness, or special instructions
- Default prompt enforces strict translation-only behavior (no commentary or responses)

#### Clear Chat
- Click the **🗑️ Clear chat** button to reset the conversation history
- Useful for starting a new session

## Settings Reference

| Setting | Options | Description |
|---------|---------|-------------|
| **Gemini API key** | Text | Required for authentication with Google's API |
| **You speak** | Language dropdown | Source language (the language you'll speak) |
| **Translate to** | Language dropdown | Target language (the translation output language) |
| **Voice** | Zephyr, Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus | AI voice for translation output |
| **Audio source** | Microphone, App/tab, Companion app audio, Mic + app | Which audio to capture and translate |

## Browser Support

| Feature | Chrome/Edge | Firefox | Safari |
|---------|------------|---------|--------|
| Microphone input | ✅ | ✅ | ✅ |
| Display/tab audio | ✅ | ❌ | ❌ |
| Companion app audio | ✅ | ✅ | ✅ |
| WebSocket (WebAudio) | ✅ | ✅ | ✅ |
| Web Audio API | ✅ | ✅ | ✅ |
| AudioWorklet | ✅ | ✅ | ⚠️ Limited |

*Display audio capture requires Chromium-based browsers (Chrome, Edge, Brave, etc.)*
*Companion app audio requires the optional Windows companion service in `companion/windows`.*

## Companion App Audio

Firefox cannot capture tab/window audio through screen sharing. The optional Windows companion service solves that by running a local server on `127.0.0.1:52341`:

- `GET /status` lets the web page detect the service
- `ws://127.0.0.1:52341/audio` streams mono 16 kHz PCM16 audio frames

Build it from a Visual Studio Developer PowerShell or MinGW CMake environment:

```powershell
cd companion\windows
cmake -S . -B build
cmake --build build --config Release
.\build\live-translator-companion.exe
```

With Visual Studio generators, the executable may be under `build\Release\` instead.

The current native MVP captures default system output loopback. The web protocol is ready for a later process-specific Windows capture implementation using `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`.

## File Descriptions

### `index.html`
Main entry point with:
- Responsive header with status and session timer
- Sidebar containing all settings (API key, language selection, voice, audio source)
- Chat log display area
- Modals for system prompt editing and logs
- Button controls (start, stop, mute, settings, pop-out)

### `css/style.css`
Mobile-first responsive styling:
- Sidebar transforms to fixed overlay on mobile, side panel on desktop
- Dark theme optimized for accessibility
- Status indicators and real-time level meters
- Smooth transitions and animations

### `js/app.js`
Application logic and UI management:
- DOM element caching and event listeners
- Preference persistence (localStorage)
- Language dropdown population
- Session timer
- Start/stop lifecycle management
- Sidebar and modal toggling
- Chat history rendering

### `js/audio.js`
Web Audio API wrapper for capture and playback:
- `AudioCapture` class: Manages microphone and/or display audio capture
- AudioWorklet-based PCM16 resampling (browser-native, no libraries)
- Audio level monitoring for visual feedback
- TTS playback using Web Audio API
- Handles echoCancellation, noiseSuppression, and autoGainControl

### `js/gemini-live.js`
Gemini Live API client:
- WebSocket connection management
- Binary audio message framing
- Automatic reconnection with exponential backoff
- Session resumption after disconnections
- Turn-based conversation tracking
- System prompt template rendering with language substitution
- Event callbacks for audio, transcripts, and state changes

## API Cost Considerations

The Gemini Live API is free for development. Usage is metered by:
- **Audio input**: Duration of audio captured
- **Audio output**: Duration of AI-generated speech

See [Google AI Pricing](https://ai.google.dev/pricing) for current rates.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Missing API key" error | Paste your API key in Settings and save |
| No microphone access | Check browser permissions; reload and grant mic access |
| Display audio not working | Use Chrome/Edge; tap "App audio" in Settings; grant screen share permission |
| Audio garbled or laggy | Check internet connection; reduce background noise; try different audio source |
| Session drops | Automatic reconnection should resume within 2 seconds; check API key validity |
| Translated text missing | Check Settings > system prompt hasn't been set to filter language |

## Privacy & Security

- **API Key**: Stored in browser localStorage only; never sent to any server except Google's
- **Audio**: Processed in real-time; no cloud storage or logging beyond Gemini session
- **Chat History**: Stored locally in browser memory; cleared on page refresh unless exported

## Development Notes

- Pure client-side application; no backend required
- Works from `file://` protocol (useful for local development)
- AudioWorklet code is embedded as a Blob URL to work from any origin
- No external dependencies—uses native Web Audio, WebSocket, and Fetch APIs
- Tested on Chrome 120+, Edge 120+, Firefox 121+


## License

Open source. Feel free to use, modify, and distribute.
