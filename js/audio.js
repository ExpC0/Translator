// Audio capture (mic and/or display) → 16 kHz Int16 PCM, and TTS playback (24 kHz Int16 PCM).
// Pure browser. AudioWorklet loaded from a Blob URL so this works from file:// or any host.

const PCM16_WORKLET_SRC = `
class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / 16000;
    this._inPos = 0;
    this._prev = 0;
    this._target = 1600;                  // ~100 ms @ 16 kHz
    this._out = new Float32Array(this._target);
    this._oIdx = 0;
    this._peak = 0;
    // Emit a level message every ~100 ms of input audio regardless of the
    // context sample rate or render quantum size, so the visualizer cadence
    // is consistent across devices.
    this._levelSamples = 0;
    this._levelInterval = (sampleRate * 0.1) | 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const N = ch.length;
    const ratio = this._ratio;
    const target = this._target;
    const out = this._out;
    let p = this._inPos;
    let o = this._oIdx;
    let peak = this._peak;

    while (p < N) {
      let v;
      if (p < 0) {
        const frac = p + 1;
        v = this._prev * (1 - frac) + ch[0] * frac;
      } else {
        const i = p | 0;
        const frac = p - i;
        const a = ch[i];
        const b = (i + 1 < N) ? ch[i + 1] : a;
        v = a + (b - a) * frac;
      }
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[o++] = v;
      if (o >= target) {
        const buf = new Int16Array(target);
        for (let k = 0; k < target; k++) {
          const s = out[k];
          buf[k] = s < 0 ? (s * 32768) | 0 : (s * 32767) | 0;
        }
        this.port.postMessage({ type: 'audio', buffer: buf.buffer }, [buf.buffer]);
        o = 0;
      }
      p += ratio;
    }

    for (let i = 0; i < N; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }

    p -= N;
    this._prev = ch[N - 1];
    this._inPos = p;
    this._oIdx = o;

    this._levelSamples += N;
    if (this._levelSamples >= this._levelInterval) {
      this.port.postMessage({ type: 'level', level: peak });
      this._levelSamples = 0;
      peak = 0;
    }
    this._peak = peak;
    return true;
  }
}
registerProcessor('pcm16-processor', PCM16Processor);
`;

class AudioCapture {
  constructor({ onChunk, onLevel, onDisplayEnded } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.ctx = null;
    this.streams = [];
    this.sources = [];
    this.node = null;
    this._workletUrl = null;
    this._level = 0;
    this._rafId = 0;
  }

  // mode: 'mic' | 'display' | 'both'
  async start({ mode = 'mic', micDeviceId = '' } = {}) {
    const wantMic = mode === 'mic' || mode === 'both';
    const wantDisplay = mode === 'display' || mode === 'both';

    if (wantMic) {
      const baseAudio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      let s;
      try {
        const audio = { ...baseAudio };
        if (micDeviceId) audio.deviceId = { exact: micDeviceId };
        s = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (e) {
        if (!micDeviceId) throw e;
        s = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
      }
      this.streams.push({ kind: 'mic', stream: s });
    }

    if (wantDisplay) {
      // Chrome requires `video: true` to even surface the audio option in the picker.
      let displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch (e) {
        // If the user cancels or browser refuses, clean up mic if it was acquired and rethrow.
        this._releaseStreams();
        throw e;
      }
      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach((t) => t.stop());
        this._releaseStreams();
        throw new Error('No audio track. Pick a tab and tick "Share tab audio".');
      }
      // We don't need the video — stop it so the indicator is quieter and CPU is lower.
      displayStream.getVideoTracks().forEach((t) => t.stop());
      const audioTrack = displayStream.getAudioTracks()[0];
      audioTrack.addEventListener('ended', () => this.onDisplayEnded());
      this.streams.push({ kind: 'display', stream: displayStream });
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const blob = new Blob([PCM16_WORKLET_SRC], { type: 'application/javascript' });
    this._workletUrl = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(this._workletUrl);

    // Force mono so the worklet always reads inputs[0][0]. Sources at different
    // channel counts (stereo display vs mono mic) get downmixed before delivery.
    this.node = new AudioWorkletNode(this.ctx, 'pcm16-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.node.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'audio') this.onChunk(m.buffer);
      else if (m.type === 'level') {
        if (m.level > this._level) this._level = m.level;
      }
    };

    // Connect every input stream to the same worklet — Web Audio sums them.
    for (const s of this.streams) {
      const src = this.ctx.createMediaStreamSource(s.stream);
      src.connect(this.node);
      this.sources.push(src);
    }
    // Worklet output isn't connected to destination — no monitor playback.

    this._startMeter();
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      this._level *= Math.exp(-dt / decayTau);
      this.onLevel(this._level);
      if (this.node) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _releaseStreams() {
    for (const s of this.streams) {
      try { s.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    this.streams = [];
  }

  stop() {
    for (const s of this.sources) { try { s.disconnect(); } catch (_) {} }
    try { this.node && this.node.disconnect(); } catch (_) {}
    this._releaseStreams();
    try { this.ctx && this.ctx.close(); } catch (_) {}
    if (this._workletUrl) {
      URL.revokeObjectURL(this._workletUrl);
      this._workletUrl = null;
    }
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._level = 0;
    this.onLevel(0);
    this.sources = [];
    this.node = null;
    this.ctx = null;
  }
}

class CompanionAudioCapture {
  constructor({ onChunk, onLevel, onDisplayEnded } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onDisplayEnded = onDisplayEnded || (() => {});
    this.ws = null;
    this._level = 0;
    this._rafId = 0;
    this._stopping = false;
  }

  async start({ wsUrl = 'ws://127.0.0.1:52341/audio' } = {}) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        settled = true;
        this._stopping = false;
        this.ws = ws;
        this._startMeter();
        resolve();
      };
      ws.onerror = () => {
        if (!settled) reject(new Error('Companion audio service is unavailable.'));
      };
      ws.onclose = () => {
        this.ws = null;
        if (!this._stopping) this.onDisplayEnded();
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        this._trackLevel(ev.data);
        this.onChunk(ev.data);
      };
    });
  }

  _trackLevel(buffer) {
    const pcm = new Int16Array(buffer);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i] / 32768);
      if (a > peak) peak = a;
    }
    if (peak > this._level) this._level = peak;
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    // 100 ms time constant — reproduces the old *0.85/frame feel at 60 Hz
    // but is independent of the display refresh rate.
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      this._level *= Math.exp(-dt / decayTau);
      this.onLevel(this._level);
      if (this.ws) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    const ws = this.ws;
    this._stopping = true;
    this.ws = null;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._level = 0;
    this.onLevel(0);
    try { ws && ws.close(); } catch (_) {}
  }
}

class TTSPlayer {
  constructor({ onLevel, onActiveChange, outputDeviceId = '' } = {}) {
    this.onLevel = onLevel || (() => {});
    this.onActiveChange = onActiveChange || (() => {});
    this.outputDeviceId = outputDeviceId || '';
    this.ctx = null;
    this.outputNode = null;
    this.outputStreamNode = null;
    this.outputEl = null;
    this.analyser = null;
    this._analyserBuf = null;
    this.nextStart = 0;
    this.sources = new Set();
    this._level = 0;
    this._rafId = 0;
  }

  async ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      await this._configureOutput();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async _configureOutput() {
    if (!this.ctx) return;

    let sink;
    if (typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(this.outputDeviceId || '');
      } catch (e) {
        if (!this.outputDeviceId) throw e;
        this.outputDeviceId = '';
        await this.ctx.setSinkId('');
      }
      sink = this.ctx.destination;
    } else if (TTSPlayer.canSelectOutputDevice()) {
      this.outputStreamNode = this.ctx.createMediaStreamDestination();
      this.outputEl = new Audio();
      this.outputEl.autoplay = true;
      this.outputEl.playsInline = true;
      this.outputEl.srcObject = this.outputStreamNode.stream;
      try {
        await this.outputEl.setSinkId(this.outputDeviceId || '');
      } catch (e) {
        if (!this.outputDeviceId) throw e;
        this.outputDeviceId = '';
        await this.outputEl.setSinkId('');
      }
      try { await this.outputEl.play(); } catch (_) {}
      sink = this.outputStreamNode;
    } else {
      sink = this.ctx.destination;
    }

    // Sources feed an analyser so the meter reflects what is actually playing
    // out the speakers, not what we have queued. Without this, the level
    // decays to zero as soon as the model finishes streaming chunks, even
    // though several seconds of audio may still be buffered.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.connect(sink);
    this._analyserBuf = new Float32Array(this.analyser.fftSize);
    this.outputNode = this.analyser;
  }

  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId || '';

    if (!this.ctx) return;

    if (typeof this.ctx.setSinkId === 'function') {
      await this.ctx.setSinkId(this.outputDeviceId);
      return;
    }

    if (this.outputEl && typeof this.outputEl.setSinkId === 'function') {
      await this.outputEl.setSinkId(this.outputDeviceId);
    }
  }

  async playChunk(base64Pcm) {
    await this.ensureCtx();
    const bin = atob(base64Pcm);
    const n = bin.length;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    const usable = n - (n % 2);
    if (usable === 0) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);

    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float[i] = pcm[i] / 32768;
    }

    const buf = this.ctx.createBuffer(1, float.length, 24000);
    buf.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outputNode || this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.04, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buf.duration;

    const wasIdle = this.sources.size === 0;
    this.sources.add(src);
    if (wasIdle) {
      this.onActiveChange(true);
      this._startMeter();
    }
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) {
        this.nextStart = 0;
        this.onActiveChange(false);
      }
    };
  }

  _startMeter() {
    if (this._rafId) return;
    let last = performance.now();
    const decayTau = 0.1;
    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - last) / 1000);
      last = now;

      // Sample the actual output, not the queued chunks.
      let peak = 0;
      if (this.analyser && this._analyserBuf) {
        this.analyser.getFloatTimeDomainData(this._analyserBuf);
        const buf = this._analyserBuf;
        for (let i = 0; i < buf.length; i++) {
          const a = buf[i] < 0 ? -buf[i] : buf[i];
          if (a > peak) peak = a;
        }
      }

      if (peak > this._level) this._level = peak;
      else this._level *= Math.exp(-dt / decayTau);

      this.onLevel(this._level);
      // Keep ticking while audio is scheduled OR still ringing out in the meter.
      if (this.sources.size > 0 || this._level > 0.005) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = 0;
        this.onLevel(0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  hush() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    this.sources.clear();
    this.nextStart = 0;
    this._level = 0;
    this.onActiveChange(false);
    this.onLevel(0);
  }

  isActive() {
    return this.sources.size > 0 ||
           (this.ctx && this.nextStart > this.ctx.currentTime);
  }

  destroy() {
    this.hush();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    if (this.outputEl) {
      try { this.outputEl.pause(); } catch (_) {}
      this.outputEl.srcObject = null;
    }
    try { this.analyser && this.analyser.disconnect(); } catch (_) {}
    try { this.outputStreamNode && this.outputStreamNode.disconnect(); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.outputEl = null;
    this.outputStreamNode = null;
    this.outputNode = null;
    this.analyser = null;
    this._analyserBuf = null;
    this.ctx = null;
  }

  static canSelectOutputDevice() {
    return typeof HTMLMediaElement !== 'undefined' &&
           !!HTMLMediaElement.prototype &&
           typeof HTMLMediaElement.prototype.setSinkId === 'function';
  }
}

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function canCaptureDisplayAudio() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function canSelectOutputDevice() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return (Ctx && typeof Ctx.prototype.setSinkId === 'function') ||
         TTSPlayer.canSelectOutputDevice();
}

window.LiveAudio = { AudioCapture, CompanionAudioCapture, TTSPlayer, abToBase64, canCaptureDisplayAudio, canSelectOutputDevice };
