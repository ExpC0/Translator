# Live Translator Companion for Windows

Headless localhost audio bridge for browsers that cannot capture app audio.

This MVP exposes:

- `GET /status` on `http://127.0.0.1:52341/status`
- `GET /audio` WebSocket on `ws://127.0.0.1:52341/audio`

The WebSocket streams mono 16 kHz signed PCM16 frames, matching what the web app already sends to Gemini.

## Build

From a Visual Studio Developer PowerShell:

```powershell
cd companion\windows
cmake -S . -B build
cmake --build build --config Release
```

Run:

```powershell
.\build\Release\live-translator-companion.exe
```

With single-config generators such as Ninja/MinGW, the exe may be at:

```powershell
.\build\live-translator-companion.exe
```

The binary is built as a Windows subsystem app, so it has no console window in normal use.

## Origin Checks

By default the service allows common local development origins:

- `null` for `file://`
- `http://localhost:*`
- `https://localhost:*`
- `http://127.0.0.1:*`
- `https://127.0.0.1:*`

For a deployed page, set allowed origins before launch:

```powershell
$env:LIVE_TRANSLATOR_ALLOWED_ORIGINS="https://your-real-domain.com,https://www.your-real-domain.com"
.\build\Release\live-translator-companion.exe
```

## Current Capture Mode

This MVP captures default render-device loopback, which means system output audio.

Windows process-specific loopback is possible with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
and `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, but that needs a newer activation path
than standard default-device WASAPI loopback. The browser integration is already designed so the
native service can later swap system loopback for per-process loopback without changing the web app
protocol.
