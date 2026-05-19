// UI glue + lifecycle. Mobile-first; the same DOM becomes a desktop sidebar via CSS.

const LANGUAGES = [
  ['en', 'English'],
  ['zh', 'Chinese (Mandarin)'],
  ['bn', 'Bangla'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['pt', 'Portuguese'],
  ['id', 'Indonesian'],
];

const MAX_TURNS = 50;
const MAX_LOG = 200;
const STORAGE_KEY = 'live-translator-prefs';

// Voice-activity-detection presets. Hand-tuned for translation use: the model
// shouldn't jump in mid-sentence, so we lean towards LOW end-sensitivity and
// longer silence by default. "Patient" is the answer to "model talks too soon".
const VAD_PRESETS = {
  quick:    { startSensitivity: 'HIGH', endSensitivity: 'HIGH', prefixPaddingMs: 100, silenceDurationMs: 400 },
  balanced: { startSensitivity: 'HIGH', endSensitivity: 'LOW',  prefixPaddingMs: 200, silenceDurationMs: 800 },
  patient:  { startSensitivity: 'LOW',  endSensitivity: 'LOW',  prefixPaddingMs: 300, silenceDurationMs: 1800 },
};
const DEFAULT_VAD_PRESET = 'balanced';
const COMPANION_HTTP_URL = 'http://127.0.0.1:52341';
const COMPANION_WS_URL = 'ws://127.0.0.1:52341/audio';

const $ = (id) => document.getElementById(id);

const els = {
  apiKey:        $('api-key'),
  btnShowKey:    $('btn-show-key'),
  langSource:    $('lang-source'),
  langTarget:    $('lang-target'),
  voice:         $('voice'),
  audioInput:    $('audio-input'),
  audioInputHint:$('audio-input-hint'),
  audioSource:   $('audio-source'),
  audioHint:     $('audio-source-hint'),
  companionApp:      $('companion-app'),
  companionAppField: $('companion-app-field'),
  companionAppHint:  $('companion-app-hint'),
  btnRefreshApps:    $('btn-refresh-apps'),
  audioOutput:   $('audio-output'),
  audioOutputHint:$('audio-output-hint'),
  modeSelect:    $('mode-select'),
  dirSelect:     $('dir-select'),
  dirField:      $('dir-field'),
  vadPreset:     $('vad-preset'),
  vadStart:      $('vad-start'),
  vadEnd:        $('vad-end'),
  vadPrefix:     $('vad-prefix'),
  vadSilence:    $('vad-silence'),
  btnSwap:       $('btn-swap'),
  btnStart:      $('btn-start'),
  btnStop:       $('btn-stop'),
  btnHush:       $('btn-hush'),
  btnPause:      $('btn-pause'),
  btnClear:      $('btn-clear'),
  btnMenu:       $('btn-menu'),
  btnLog:        $('btn-log'),
  btnPip:        $('btn-pip'),
  btnPipQuick:   $('btn-pip-quick'),
  btnEditPrompt: $('btn-edit-prompt'),
  btnSavePrompt: $('btn-save-prompt'),
  btnResetPrompt:$('btn-reset-prompt'),
  promptText:    $('prompt-text'),
  openFromEmpty: $('open-settings-from-empty'),
  sidebar:       $('sidebar'),
  promptSheet:   $('prompt-sheet'),
  logSheet:      $('log-sheet'),
  statusPill:    $('status-pill'),
  statusText:    $('status-text'),
  sessionAge:    $('session-age'),
  turns:         $('turns'),
  emptyState:    $('empty-state'),
  micMeter:      $('mic-meter'),
  outMeter:      $('out-meter'),
  log:           $('log'),
};

const state = {
  running: false,
  paused: false,
  client: null,
  capture: null,
  player: null,
  pip: null,
  currentAudioMode: '',
  startedAt: 0,
  ageTimer: 0,
  liveTurn: null,
  systemPromptTemplate: null,
  companionAvailable: false,
  // List of {pid, name, displayName} returned by the companion /apps endpoint.
  // Refreshed when the companion service is detected or the user clicks ↻.
  companionApps: [],
};

// ─── Prefs ────────────────────────────────────────────────────────────────────
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch (_) { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiKey: els.apiKey.value,
      source: els.langSource.value,
      target: els.langTarget.value,
      voice:  els.voice.value,
      input:  els.audioInput.value,
      audio:  els.audioSource.value,
      output: els.audioOutput.value,
      mode:   els.modeSelect.value,
      dir:    els.dirSelect.value,
      promptTemplate: state.systemPromptTemplate || '',
      // Persist the exe name, not the pid — pids change between runs.
      companionApp: els.companionApp ? els.companionApp.value : '',
      vadPreset:   els.vadPreset ? els.vadPreset.value : DEFAULT_VAD_PRESET,
      vadStart:    els.vadStart ? els.vadStart.value : '',
      vadEnd:      els.vadEnd ? els.vadEnd.value : '',
      vadPrefix:   els.vadPrefix ? Number(els.vadPrefix.value) : null,
      vadSilence:  els.vadSilence ? Number(els.vadSilence.value) : null,
    }));
  } catch (_) {}
}

function langName(code) {
  for (const [c, n] of LANGUAGES) if (c === code) return n;
  return code;
}

// ─── System prompt resolution ────────────────────────────────────────────────
// One custom slot. Mode/Direction supply defaults. A saved template that
// matches any built-in template is treated as "not customised" so users can
// switch modes without their old default-text overriding the new default.
function isBuiltinPromptTemplate(t) {
  return t === GeminiLive.DEFAULT_SYSTEM_PROMPT_TEMPLATE ||
         t === GeminiLive.ONE_WAY_SYSTEM_PROMPT_TEMPLATE ||
         t === GeminiLive.TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE;
}

function modeDefaultTemplate() {
  if (els.modeSelect.value === 'transcribe') return GeminiLive.TRANSCRIBE_SYSTEM_PROMPT_TEMPLATE;
  if (els.dirSelect.value === 'oneway')      return GeminiLive.ONE_WAY_SYSTEM_PROMPT_TEMPLATE;
  return GeminiLive.DEFAULT_SYSTEM_PROMPT_TEMPLATE;
}

function effectivePromptTemplate() {
  const custom = state.systemPromptTemplate;
  if (custom && !isBuiltinPromptTemplate(custom)) return custom;
  return modeDefaultTemplate();
}

function modeDescriptiveLabel() {
  const mode = els.modeSelect.value;
  if (mode === 'transcribe') return 'Transcribe only';
  const dirLabel = els.dirSelect.value === 'oneway' ? 'one-way →' : 'both ways ↔';
  const fmt = mode === 'text' ? 'text only' : 'voice + text';
  return `Translate (${fmt}, ${dirLabel})`;
}

function updateDirVisibility() {
  els.dirField.style.display = els.modeSelect.value === 'transcribe' ? 'none' : '';
}

// ─── VAD preset / advanced fields ────────────────────────────────────────────
// The preset dropdown drives the 4 detail fields. Touching any detail field
// flips the preset to "custom" so the user sees that they've deviated. On
// Start we read whatever the detail fields say — preset is just a shortcut.
function applyVadPreset(name) {
  const preset = VAD_PRESETS[name];
  if (!preset) return;
  els.vadStart.value = preset.startSensitivity;
  els.vadEnd.value = preset.endSensitivity;
  els.vadPrefix.value = String(preset.prefixPaddingMs);
  els.vadSilence.value = String(preset.silenceDurationMs);
}

function currentVadConfig() {
  // Clamp into a sensible range so a typo doesn't break the session.
  const prefix = Math.max(0, Math.min(2000, Number(els.vadPrefix.value) || 0));
  const silence = Math.max(100, Math.min(5000, Number(els.vadSilence.value) || 800));
  return {
    startSensitivity: els.vadStart.value === 'LOW' ? 'LOW' : 'HIGH',
    endSensitivity:   els.vadEnd.value === 'HIGH' ? 'HIGH' : 'LOW',
    prefixPaddingMs:   prefix,
    silenceDurationMs: silence,
  };
}

function vadConfigMatchesPreset(name) {
  const preset = VAD_PRESETS[name];
  if (!preset) return false;
  const cur = currentVadConfig();
  return cur.startSensitivity === preset.startSensitivity &&
         cur.endSensitivity === preset.endSensitivity &&
         cur.prefixPaddingMs === preset.prefixPaddingMs &&
         cur.silenceDurationMs === preset.silenceDurationMs;
}

function detectVadPreset() {
  for (const name of Object.keys(VAD_PRESETS)) {
    if (vadConfigMatchesPreset(name)) return name;
  }
  return 'custom';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function updateAudioSourceAvailability() {
  for (const opt of els.audioSource.options) {
    if (opt.value === 'display') {
      opt.disabled = !LiveAudio.canCaptureDisplayAudio();
    } else if (opt.value === 'companion') {
      opt.disabled = !state.companionAvailable;
    }
  }
  if (els.audioSource.selectedOptions[0]?.disabled) {
    els.audioSource.value = 'mic';
  }

  if (!LiveAudio.canCaptureDisplayAudio() && !state.companionAvailable) {
    els.audioHint.textContent = 'App audio capture is unavailable. Start the companion service or use Chrome/Edge tab audio.';
  } else if (state.companionAvailable) {
    els.audioHint.textContent = 'Companion app detected. Use it for background app audio without screen sharing.';
  } else if (!LiveAudio.canCaptureDisplayAudio()) {
    els.audioHint.textContent = 'Browser app audio capture is unsupported here. Start the companion service to use app audio.';
  } else {
    els.audioHint.textContent = 'Default microphone. Use app/tab audio in Chrome/Edge, or Companion app audio when the local service is running.';
  }
  updateCompanionAppVisibility();
}

async function detectCompanionService({ silent = true } = {}) {
  try {
    const res = await fetchWithTimeout(`${COMPANION_HTTP_URL}/status`, {
      mode: 'cors',
      cache: 'no-store',
      headers: { 'X-Live-Translator': 'status' },
    }, 600);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    state.companionAvailable = data && data.status === 'ok';
  } catch (e) {
    state.companionAvailable = false;
    if (!silent) log('warn', 'Companion service unavailable: ' + (e && e.message ? e.message : e));
  }
  updateAudioSourceAvailability();
  if (state.companionAvailable && els.companionApp) {
    // Don't block detection on this; just trigger a background fetch.
    refreshCompanionApps({ silent: true });
  }
  return state.companionAvailable;
}

async function fetchCompanionApps() {
  const res = await fetchWithTimeout(`${COMPANION_HTTP_URL}/apps`, {
    mode: 'cors',
    cache: 'no-store',
    headers: { 'X-Live-Translator': 'apps' },
  }, 1500);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.apps) ? data.apps : [];
}

async function refreshCompanionApps({ silent = true } = {}) {
  if (!els.companionApp) return;
  try {
    const apps = await fetchCompanionApps();
    // Sort by display name (case-insensitive) for a stable, scannable list.
    apps.sort((a, b) =>
      (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', undefined, { sensitivity: 'base' })
    );
    state.companionApps = apps;

    const preferred = els.companionApp.value ||
                      els.companionApp.dataset.preferred || '';
    const frag = document.createDocumentFragment();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'All system audio';
    frag.appendChild(def);
    for (const app of apps) {
      const opt = document.createElement('option');
      opt.value = app.name;
      const display = app.displayName && app.displayName !== app.name
        ? `${app.displayName} (${app.name})`
        : app.name;
      opt.textContent = display;
      frag.appendChild(opt);
    }
    els.companionApp.innerHTML = '';
    els.companionApp.appendChild(frag);

    // Restore the user's previous selection if it's still present.
    const stillThere = apps.some((a) => a.name === preferred);
    els.companionApp.value = stillThere ? preferred : '';
    els.companionApp.dataset.preferred = els.companionApp.value;

    if (els.companionAppHint) {
      els.companionAppHint.textContent = apps.length
        ? 'Pick an app. Refresh ↻ after starting playback in a new app.'
        : 'No app is making sound right now. Start playback, then refresh ↻.';
    }
    if (!silent) log('info', `Companion: found ${apps.length} app${apps.length === 1 ? '' : 's'} with active audio.`);
  } catch (e) {
    if (!silent) log('warn', 'Could not list companion apps: ' + (e && e.message ? e.message : e));
    if (els.companionAppHint) {
      els.companionAppHint.textContent = 'Could not reach the companion service.';
    }
  }
}

function updateCompanionAppVisibility() {
  if (!els.companionAppField) return;
  const show = els.audioSource.value === 'companion' && state.companionAvailable;
  els.companionAppField.style.display = show ? '' : 'none';
}

function fillLanguages() {
  const frag1 = document.createDocumentFragment();
  const frag2 = document.createDocumentFragment();
  for (const [code, name] of LANGUAGES) {
    const o1 = document.createElement('option');
    o1.value = code; o1.textContent = name; frag1.appendChild(o1);
    const o2 = document.createElement('option');
    o2.value = code; o2.textContent = name; frag2.appendChild(o2);
  }
  els.langSource.appendChild(frag1);
  els.langTarget.appendChild(frag2);

  const prefs = loadPrefs();
  els.apiKey.value      = prefs.apiKey || '';
  els.langSource.value  = prefs.source || 'en';
  els.langTarget.value  = prefs.target || 'zh';
  els.voice.value       = prefs.voice  || 'Zephyr';
  els.audioInput.dataset.preferred = prefs.input || '';
  els.audioInput.value  = prefs.input  || '';
  els.audioSource.value = prefs.audio  || 'mic';
  els.audioOutput.dataset.preferred = prefs.output || '';
  els.audioOutput.value = prefs.output || '';
  if (els.companionApp) {
    // Stash the saved exe name; refreshCompanionApps() picks it up once the
    // /apps response comes in.
    els.companionApp.dataset.preferred = prefs.companionApp || '';
    els.companionApp.value = prefs.companionApp || '';
  }

  // VAD: load preset first, then let any saved detail values override it. If
  // the result no longer matches a named preset, switch the dropdown to
  // "custom" so the UI reflects reality.
  const savedPreset = prefs.vadPreset && (VAD_PRESETS[prefs.vadPreset] || prefs.vadPreset === 'custom')
    ? prefs.vadPreset : DEFAULT_VAD_PRESET;
  els.vadPreset.value = savedPreset;
  applyVadPreset(savedPreset === 'custom' ? DEFAULT_VAD_PRESET : savedPreset);
  if (prefs.vadStart === 'HIGH' || prefs.vadStart === 'LOW') els.vadStart.value = prefs.vadStart;
  if (prefs.vadEnd === 'HIGH' || prefs.vadEnd === 'LOW')     els.vadEnd.value   = prefs.vadEnd;
  if (Number.isFinite(prefs.vadPrefix))  els.vadPrefix.value = String(prefs.vadPrefix);
  if (Number.isFinite(prefs.vadSilence)) els.vadSilence.value = String(prefs.vadSilence);
  if (savedPreset !== 'custom') {
    els.vadPreset.value = vadConfigMatchesPreset(savedPreset) ? savedPreset : 'custom';
  }
  els.modeSelect.value  = prefs.mode   || 'audio';
  els.dirSelect.value   = prefs.dir    || 'bidir';
  state.systemPromptTemplate = prefs.promptTemplate || null;

  // ?api=... in the URL overrides any saved key — handy for sharing a single
  // link that pre-fills the key. We strip the param afterwards so the key
  // doesn't linger in browser history, bookmarks, or referer headers.
  const urlKey = new URLSearchParams(location.search).get('api');
  if (urlKey) {
    els.apiKey.value = urlKey;
    const url = new URL(location.href);
    url.searchParams.delete('api');
    history.replaceState(null, '', url.toString());
    savePrefs();
    log('info', 'API key loaded from URL and saved locally.');
  }

  if (els.langSource.value === els.langTarget.value) {
    els.langTarget.value = els.langSource.value === 'en' ? 'es' : 'en';
  }

  updateDirVisibility();
  updateAudioSourceAvailability();

  updateAudioInputSupport();
  updateAudioOutputSupport();
}

function updateAudioInputSupport() {
  if (!els.audioInput) return;
  const supported = !!(navigator.mediaDevices &&
                       navigator.mediaDevices.getUserMedia &&
                       navigator.mediaDevices.enumerateDevices);
  els.audioInput.disabled = !supported;
  if (!supported) {
    els.audioInputHint.textContent = 'This browser does not allow web apps to choose a microphone.';
  }
}

function updateAudioOutputSupport() {
  if (!els.audioOutput) return;
  const canSelect = LiveAudio.canSelectOutputDevice && LiveAudio.canSelectOutputDevice();
  const canList = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
  const supported = canSelect && canList;
  els.audioOutput.disabled = !supported;
  if (!supported) {
    els.audioOutputHint.textContent = 'This browser does not allow web apps to choose a speaker.';
  }
}

function inputDeviceLabel(device, index) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  if (device.deviceId === 'communications') return 'Communications default';
  return `Microphone ${index + 1}`;
}

function outputDeviceLabel(device, index) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  if (device.deviceId === 'communications') return 'Communications default';
  return `Speaker ${index + 1}`;
}

async function refreshAudioInputDevices() {
  if (!els.audioInput || els.audioInput.disabled) return;
  try {
    const selected = els.audioInput.value || els.audioInput.dataset.preferred || '';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const seen = new Set();
    const frag = document.createDocumentFragment();

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System default';
    frag.appendChild(defaultOpt);
    seen.add('');

    inputs.forEach((device, index) => {
      const id = device.deviceId || '';
      if (id === 'default') return;
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = inputDeviceLabel(device, index);
      frag.appendChild(opt);
    });

    els.audioInput.innerHTML = '';
    els.audioInput.appendChild(frag);
    els.audioInput.value = seen.has(selected) ? selected : '';
    els.audioInput.dataset.preferred = els.audioInput.value;

    if (inputs.length) {
      const hasLabels = inputs.some((d) => d.label);
      els.audioInputHint.textContent = hasLabels
        ? 'Changes apply immediately; Mic + app audio asks you to pick app audio again.'
        : 'Device names may appear after microphone permission.';
    } else {
      els.audioInputHint.textContent = 'No microphones were reported by this browser.';
    }
    savePrefs();
  } catch (e) {
    els.audioInput.disabled = true;
    els.audioInputHint.textContent = 'Could not read microphone devices.';
    log('warn', 'Microphone devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

async function refreshAudioOutputDevices() {
  if (!els.audioOutput || els.audioOutput.disabled) return;
  try {
    const selected = els.audioOutput.value || els.audioOutput.dataset.preferred || '';
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const seen = new Set();
    const frag = document.createDocumentFragment();

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System default';
    frag.appendChild(defaultOpt);
    seen.add('');

    outputs.forEach((device, index) => {
      const id = device.deviceId || '';
      if (id === 'default') return;
      if (seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = outputDeviceLabel(device, index);
      frag.appendChild(opt);
    });

    els.audioOutput.innerHTML = '';
    els.audioOutput.appendChild(frag);
    els.audioOutput.value = seen.has(selected) ? selected : '';
    els.audioOutput.dataset.preferred = els.audioOutput.value;

    if (outputs.length) {
      const hasLabels = outputs.some((d) => d.label);
      els.audioOutputHint.textContent = hasLabels
        ? 'Changes apply immediately to translated speech when supported by the browser.'
        : 'Device names may appear after microphone permission.';
    } else {
      els.audioOutputHint.textContent = 'No speaker devices were reported by this browser.';
    }
    savePrefs();
  } catch (e) {
    els.audioOutput.disabled = true;
    els.audioOutputHint.textContent = 'Could not read audio output devices.';
    log('warn', 'Audio output devices unavailable: ' + (e && e.message ? e.message : e));
  }
}

async function changeAudioOutput() {
  els.audioOutput.dataset.preferred = els.audioOutput.value;
  savePrefs();
  if (!state.player) return;
  try {
    await state.player.setOutputDevice(els.audioOutput.value);
    log('info', 'Audio output changed: ' + (els.audioOutput.selectedOptions[0]?.textContent || 'System default'));
  } catch (e) {
    log('error', 'Audio output change failed: ' + (e && e.message ? e.message : e));
    await refreshAudioOutputDevices();
  }
}

function createAudioCapture() {
  return new LiveAudio.AudioCapture({
    onChunk: (buf) => {
      if (!state.paused) state.client.sendAudio(buf);
    },
    onLevel: (l) => setMeter(els.micMeter, l),
    onDisplayEnded: () => {
      log('warn', 'App audio share ended by the browser.');
      stopPipeline();
    },
  });
}

function createCompanionCapture() {
  return new LiveAudio.CompanionAudioCapture({
    onChunk: (buf) => {
      if (!state.paused) state.client.sendAudio(buf);
    },
    onLevel: (l) => setMeter(els.micMeter, l),
    onDisplayEnded: () => {
      if (!state.running) return;
      log('warn', 'Companion audio service disconnected.');
      stopPipeline();
    },
  });
}

async function changeAudioInput() {
  els.audioInput.dataset.preferred = els.audioInput.value;
  savePrefs();
  if (!state.running) return;

  const audioMode = state.currentAudioMode || els.audioSource.value || 'mic';
  if (audioMode === 'display' || audioMode === 'companion') {
    log('info', 'Microphone changed; it will apply when microphone input is used.');
    return;
  }

  try {
    if (audioMode === 'both') {
      log('info', 'Pick the app/tab audio again to switch microphones.');
    }
    const nextCapture = createAudioCapture();
    await nextCapture.start({ mode: audioMode, micDeviceId: els.audioInput.value });
    try { state.capture && state.capture.stop(); } catch (_) {}
    state.capture = nextCapture;
    await refreshAudioInputDevices();
    log('info', 'Microphone changed: ' + (els.audioInput.selectedOptions[0]?.textContent || 'System default'));
  } catch (e) {
    log('error', 'Microphone change failed: ' + (e && e.message ? e.message : e));
    await refreshAudioInputDevices();
  }
}

// ─── Status pill ──────────────────────────────────────────────────────────────
const STATUS_MAP = {
  idle:         ['pill-idle',         'Idle'],
  connecting:   ['pill-connecting',   'Connecting'],
  connected:    ['pill-listening',    'Listening'],
  translating:  ['pill-translating',  'Speaking'],
  reconnecting: ['pill-reconnecting', 'Reconnect'],
  error:        ['pill-error',        'Error'],
};
function setStatus(s) {
  const [cls, text] = STATUS_MAP[s] || STATUS_MAP.idle;
  els.statusPill.className = 'pill ' + cls;
  els.statusText.textContent = text;
  if (state.pip) state.pip.setStatus(text, s === 'translating' || s === 'connected');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function log(level, message) {
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  const ts = new Date().toLocaleTimeString();
  const tsEl = document.createElement('span'); tsEl.className = 'ts'; tsEl.textContent = ts;
  const lvEl = document.createElement('span'); lvEl.className = 'level'; lvEl.textContent = level.toUpperCase();
  const msEl = document.createElement('span'); msEl.className = 'msg'; msEl.textContent = message;
  line.appendChild(tsEl); line.appendChild(lvEl); line.appendChild(msEl);
  els.log.appendChild(line);
  while (els.log.children.length > MAX_LOG) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

// ─── Streaming transcripts: batch chunks per rAF ──────────────────────────────
let pendingInput = '';
let pendingOutput = '';
let pendingScheduled = false;

function scheduleFlush() {
  if (pendingScheduled) return;
  pendingScheduled = true;
  requestAnimationFrame(flushPending);
}

function flushPending() {
  pendingScheduled = false;
  if (!pendingInput && !pendingOutput) return;
  const t = ensureLiveTurn();
  if (pendingInput) {
    if (t.inputText === '') {
      t.inputEl.classList.remove('empty');
      t.inputEl.firstChild.nodeValue = '';
      t.inputCaret.style.display = '';
    }
    t.inputText += pendingInput;
    t.inputEl.firstChild.nodeValue = t.inputText;
    pendingInput = '';
    if (state.pip) state.pip.setInput(t.inputText);
  }
  if (pendingOutput) {
    if (t.outputEl) {
      if (t.outputText === '') {
        t.outputEl.classList.remove('empty');
        t.outputEl.firstChild.nodeValue = '';
        if (t.outputCaret) t.outputCaret.style.display = '';
      }
      t.outputText += pendingOutput;
      t.outputEl.firstChild.nodeValue = t.outputText;
      if (state.pip) state.pip.setOutput(t.outputText);
    }
    pendingOutput = '';
  }
  els.turns.scrollTop = els.turns.scrollHeight;
}

function ensureLiveTurn() {
  if (state.liveTurn) return state.liveTurn;
  if (els.emptyState) { els.emptyState.remove(); els.emptyState = null; }

  const isTranscribe = els.modeSelect.value === 'transcribe';

  const root = document.createElement('div');
  root.className = 'turn live' + (isTranscribe ? ' turn-single' : '');

  const inRow = document.createElement('div');
  inRow.className = 'turn-row input';
  const inLab = document.createElement('span');
  inLab.className = 'turn-label';
  inLab.textContent = '🎙 ' + langName(els.langSource.value);
  const inText = document.createElement('span');
  inText.className = 'turn-text empty';
  inText.appendChild(document.createTextNode('listening…'));
  const inCaret = document.createElement('span'); inCaret.className = 'caret'; inCaret.style.display = 'none';
  inText.appendChild(inCaret);
  inRow.appendChild(inLab); inRow.appendChild(inText);

  let outText = null, outCaret = null;
  if (!isTranscribe) {
    const outRow = document.createElement('div');
    outRow.className = 'turn-row output';
    const outLab = document.createElement('span');
    outLab.className = 'turn-label';
    outLab.textContent = '→ ' + langName(els.langTarget.value);
    outText = document.createElement('span');
    outText.className = 'turn-text empty';
    outText.appendChild(document.createTextNode('…'));
    outCaret = document.createElement('span'); outCaret.className = 'caret'; outCaret.style.display = 'none';
    outText.appendChild(outCaret);
    outRow.appendChild(outLab); outRow.appendChild(outText);
    root.appendChild(inRow); root.appendChild(outRow);
  } else {
    root.appendChild(inRow);
  }

  els.turns.appendChild(root);

  while (els.turns.children.length > MAX_TURNS) {
    els.turns.removeChild(els.turns.firstChild);
  }

  state.liveTurn = {
    root,
    inputEl: inText,
    outputEl: outText,
    inputCaret: inCaret,
    outputCaret: outCaret,
    inputText: '',
    outputText: '',
  };

  if (state.pip) {
    state.pip.setLangs(langName(els.langSource.value), langName(els.langTarget.value));
    state.pip.setInput('');
    state.pip.setOutput('');
  }
  return state.liveTurn;
}

function appendInput(chunk)  { pendingInput  += chunk; scheduleFlush(); }
function appendOutput(chunk) { pendingOutput += chunk; scheduleFlush(); }

function finalizeTurn() {
  flushPending();
  if (!state.liveTurn) return;
  const t = state.liveTurn;
  t.inputCaret.remove();
  if (t.outputCaret) t.outputCaret.remove();
  if (!t.inputText.trim())  { t.inputEl.classList.add('empty');  t.inputEl.firstChild.nodeValue = '(silence)'; }
  if (t.outputEl && !t.outputText.trim()) { t.outputEl.classList.add('empty'); t.outputEl.firstChild.nodeValue = '(no translation)'; }
  t.root.classList.remove('live');
  state.liveTurn = null;
}

function setMeter(el, level) {
  const pct = level <= 0 ? 0 : Math.min(100, Math.sqrt(level) * 110);
  el.style.width = pct + '%';
}

// ─── Pipeline ────────────────────────────────────────────────────────────────
async function startPipeline() {
  if (state.running) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    openSheet('sidebar');
    log('error', 'Paste your Gemini API key first.');
    els.apiKey.focus();
    return;
  }
  const src = els.langSource.value;
  const tgt = els.langTarget.value;
  if (src === tgt) {
    log('error', 'Source and target languages must differ.');
    return;
  }
  savePrefs();

  const translationMode = els.modeSelect.value; // 'audio' | 'text' | 'transcribe'
  const dir = els.dirSelect.value;               // 'bidir' | 'oneway'
  const isAudio = translationMode === 'audio';

  setStatus('connecting');
  els.btnStart.disabled = true;
  els.btnStop.disabled  = false;
  els.btnHush.disabled  = !isAudio;
  setControlsLocked(true);

  if (isAudio) {
    state.player = new LiveAudio.TTSPlayer({
      outputDeviceId: els.audioOutput.value,
      onLevel: (l) => setMeter(els.outMeter, l),
      onActiveChange: (active) => {
        const s = state.client && state.client.state;
        if (s === 'connected') setStatus(active ? 'translating' : 'connected');
      },
    });
  } else {
    state.player = null;
  }

  const systemInstruction = GeminiLive.renderSystemPrompt(
    effectivePromptTemplate(), langName(src), langName(tgt));

  state.client = new GeminiLive.GeminiLiveClient({
    apiKey,
    voice: els.voice.value,
    systemInstruction,
    vad: currentVadConfig(),
    // outputAudioTranscription is needed for both audio and text modes:
    // audio mode — show the translation text alongside the spoken audio
    // text mode  — the ONLY way to get text output (native audio model doesn't support TEXT modality)
    // transcribe mode — no model output needed, only inputAudioTranscription matters
    useOutputTranscription: translationMode !== 'transcribe',
    onAudio: isAudio ? (b64) => { state.player.playChunk(b64); } : () => {},
    onInputChunk: appendInput,
    onOutputChunk: translationMode !== 'transcribe' ? appendOutput : () => {},
    onTurnComplete: finalizeTurn,
    onState: (s) => {
      if (s === 'connected') {
        setStatus(isAudio && state.player && state.player.isActive() ? 'translating' : 'connected');
      } else {
        setStatus(s);
      }
    },
    onLog: log,
  });

  try {
    if (isAudio) await state.player.ensureCtx();
    const audioMode = els.audioSource.value || 'mic';
    if (audioMode === 'companion') {
      if (!state.companionAvailable && !(await detectCompanionService({ silent: false }))) {
        throw new Error('Companion audio service is not running.');
      }
      // Refresh the app list right before connecting so the pid we send is
      // still valid (the user may have closed the app since the last refresh).
      const selectedExe = els.companionApp ? els.companionApp.value : '';
      let pid = 0;
      if (selectedExe) {
        try { await refreshCompanionApps({ silent: true }); } catch (_) {}
        const match = state.companionApps.find((a) => a.name === selectedExe);
        if (match) pid = match.pid;
        else throw new Error(`"${selectedExe}" is no longer making sound. Start playback in it and try again.`);
      }
      const wsUrl = pid ? `${COMPANION_WS_URL}?pid=${pid}` : COMPANION_WS_URL;
      state.capture = createCompanionCapture();
      await state.capture.start({ wsUrl });
    } else {
      state.capture = createAudioCapture();
      await state.capture.start({ mode: audioMode, micDeviceId: els.audioInput.value });
    }
    state.currentAudioMode = audioMode;
    await refreshAudioInputDevices();
    await refreshAudioOutputDevices();
    const sourceLabels = {mic:'microphone', display:'browser app audio', companion:'companion app audio', both:'mic + app audio'};
    let sourceLog = sourceLabels[audioMode] || audioMode;
    if (audioMode === 'companion' && els.companionApp && els.companionApp.value) {
      const opt = els.companionApp.selectedOptions[0];
      sourceLog = `companion app audio (${opt ? opt.textContent : els.companionApp.value})`;
    }
    log('info', 'Audio source: ' + sourceLog);
  } catch (e) {
    log('error', 'Audio error: ' + (e && e.message ? e.message : e));
    await stopPipeline();
    return;
  }

  state.client.start();
  state.running = true;
  state.paused = false;
  els.btnPause.disabled = false;
  els.btnPause.classList.remove('is-paused');
  els.btnPause.title = 'Pause mic';

  state.startedAt = Date.now();
  if (state.ageTimer) clearInterval(state.ageTimer);
  state.ageTimer = setInterval(() => {
    els.sessionAge.textContent = fmtDuration(Date.now() - state.startedAt);
  }, 1000);

  const dirLabel = dir === 'oneway' ? '→' : '⇄';
  const modeLabel = translationMode !== 'audio' ? ` (${translationMode === 'text' ? 'text only' : 'transcribe'})` : '';
  log('info', `Session started: ${langName(src)} ${dirLabel} ${langName(tgt)}${modeLabel}`);
}

async function stopPipeline() {
  try { state.client && state.client.stop(); } catch (_) {}
  try { state.capture && state.capture.stop(); } catch (_) {}
  try { state.player && state.player.destroy(); } catch (_) {}
  state.client = null;
  state.capture = null;
  state.player = null;
  state.currentAudioMode = '';
  state.running = false;
  state.paused = false;
  if (state.ageTimer) { clearInterval(state.ageTimer); state.ageTimer = 0; }
  finalizeTurn();
  setStatus('idle');
  setControlsLocked(false);
  els.btnStart.disabled = false;
  els.btnStop.disabled  = true;
  els.btnHush.disabled  = true;
  els.btnPause.disabled = true;
  els.btnPause.classList.remove('is-paused');
  els.btnPause.title = 'Pause mic';
  els.sessionAge.textContent = '00:00';
  setMeter(els.micMeter, 0);
  setMeter(els.outMeter, 0);
}

function setControlsLocked(locked) {
  els.langSource.disabled    = locked;
  els.langTarget.disabled    = locked;
  els.voice.disabled         = locked;
  els.audioSource.disabled   = locked;
  els.apiKey.disabled        = locked;
  els.btnSwap.disabled       = locked;
  els.modeSelect.disabled    = locked;
  els.dirSelect.disabled     = locked;
  els.vadPreset.disabled     = locked;
  els.vadStart.disabled      = locked;
  els.vadEnd.disabled        = locked;
  els.vadPrefix.disabled     = locked;
  els.vadSilence.disabled    = locked;
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  els.btnPause.classList.toggle('is-paused', state.paused);
  els.btnPause.title = state.paused ? 'Resume mic' : 'Pause mic';
  if (state.paused && state.player) state.player.hush();
  log('info', state.paused ? 'Mic paused.' : 'Mic resumed.');
}

// ─── Sheets ──────────────────────────────────────────────────────────────────
function openSheet(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('is-open');
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('is-open');
}

function clearConversation() {
  state.liveTurn = null;
  els.turns.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = 'empty-state';
  empty.innerHTML =
    '<div class="empty-icon" aria-hidden="true">' +
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
        '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
        '<line x1="12" y1="19" x2="12" y2="23"/>' +
        '<line x1="8" y1="23" x2="16" y2="23"/>' +
      '</svg>' +
    '</div>' +
    '<p>Press <strong>Start</strong> and speak.</p>';
  els.turns.appendChild(empty);
  els.emptyState = empty;
  if (state.pip) { state.pip.setInput(''); state.pip.setOutput(''); }
}

// ─── System prompt editor ────────────────────────────────────────────────────
function openPromptEditor() {
  els.promptText.value = effectivePromptTemplate();
  const lab = document.getElementById('prompt-mode-label');
  if (lab) lab.textContent = modeDescriptiveLabel();
  openSheet('prompt-sheet');
}
function savePromptEditor() {
  const v = els.promptText.value.trim();
  // Treat empty or any built-in template as "no custom" — the resolver will
  // pick the right default for whichever mode the user is in.
  state.systemPromptTemplate = (v && !isBuiltinPromptTemplate(v)) ? v : null;
  savePrefs();
  closeSheet('prompt-sheet');
  log('info', state.systemPromptTemplate
        ? 'System prompt updated (takes effect on next Start).'
        : 'System prompt reset — using default for the current mode.');
}
function resetPromptEditor() {
  els.promptText.value = modeDefaultTemplate();
}

// ─── Picture-in-Picture ──────────────────────────────────────────────────────
class PipController {
  constructor() {
    this.win = null;
    this.statusEl = null;
    this.dotEl = null;
    this.inputLabelEl = null;
    this.outputLabelEl = null;
    this.inputEl = null;
    this.outputEl = null;
    this._currentInput = '';
    this._currentOutput = '';
    this._currentStatus = 'Idle';
    this._currentLive = false;
    this._inLang = '';
    this._outLang = '';
    this.onClose = () => {};
  }

  static isDocPipSupported() {
    return 'documentPictureInPicture' in window;
  }

  isOpen() { return !!(this.win && !this.win.closed); }

  async open() {
    if (this.isOpen()) { try { this.win.focus(); } catch (_) {} return; }
    if (PipController.isDocPipSupported()) {
      this.win = await window.documentPictureInPicture.requestWindow({
        width: 460, height: 300,
      });
    } else {
      this.win = window.open('', 'live-translator-pip',
        'width=460,height=300,resizable=yes,scrollbars=yes,noopener=no');
      if (!this.win) throw new Error('Popup blocked. Allow popups for this site.');
    }
    this._setup();
    this.win.addEventListener('pagehide', () => this._cleanup());
    if (this.win.document) this.win.document.title = 'Live Translator';
  }

  _setup() {
    const doc = this.win.document;
    doc.documentElement.lang = 'en';
    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0; height: 100%;
        background: #0b0d12; color: #e8ecf3;
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        display: flex; flex-direction: column; overflow: hidden;
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-bottom: 1px solid #1c2230;
        background: #11141b; flex: 0 0 auto;
      }
      .pip-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        font-size: 11px; font-weight: 600;
        background: #1d2230;
      }
      .pip-dot { width: 6px; height: 6px; border-radius: 50%; background: #6b7488; }
      .pip-dot.live { background: #7c9cff; animation: p 0.8s infinite; }
      @keyframes p { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }
      .pip-brand { font-weight: 600; font-size: 13px; }
      main {
        flex: 1; padding: 14px 16px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 12px;
      }
      .pip-label {
        font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
        text-transform: uppercase; color: #6b7488; margin-bottom: 4px;
      }
      .pip-input-lab { color: #7c9cff; }
      .pip-output-lab { color: #a78bfa; }
      .pip-input { font-size: 15px; color: #aab2c4; line-height: 1.45; word-wrap: break-word; }
      .pip-output { font-size: 20px; font-weight: 500; line-height: 1.4; word-wrap: break-word; }
      .pip-empty { color: #6b7488; font-style: italic; }
    `;
    doc.head.appendChild(style);
    doc.body.innerHTML = `
      <header>
        <span aria-hidden="true">🌐</span>
        <span class="pip-brand">Translator</span>
        <span style="flex:1"></span>
        <span class="pip-pill"><span class="pip-dot" id="pipdot"></span><span id="pipstatus">Idle</span></span>
      </header>
      <main>
        <div>
          <div class="pip-label pip-input-lab" id="pipinlab">You</div>
          <div class="pip-input pip-empty" id="pipin">—</div>
        </div>
        <div>
          <div class="pip-label pip-output-lab" id="pipoutlab">Translation</div>
          <div class="pip-output pip-empty" id="pipout">—</div>
        </div>
      </main>
    `;
    this.statusEl = doc.getElementById('pipstatus');
    this.dotEl = doc.getElementById('pipdot');
    this.inputLabelEl = doc.getElementById('pipinlab');
    this.outputLabelEl = doc.getElementById('pipoutlab');
    this.inputEl = doc.getElementById('pipin');
    this.outputEl = doc.getElementById('pipout');

    // Replay current state.
    this.setStatus(this._currentStatus, this._currentLive);
    if (this._inLang) this.setLangs(this._inLang, this._outLang);
    this.setInput(this._currentInput);
    this.setOutput(this._currentOutput);
  }

  setStatus(text, live) {
    this._currentStatus = text;
    this._currentLive = !!live;
    if (this.statusEl) this.statusEl.textContent = text;
    if (this.dotEl) this.dotEl.classList.toggle('live', !!live);
  }

  setLangs(inLang, outLang) {
    this._inLang = inLang; this._outLang = outLang;
    if (this.inputLabelEl) this.inputLabelEl.textContent = '🎙 ' + inLang;
    if (this.outputLabelEl) this.outputLabelEl.textContent = '→ ' + outLang;
  }

  setInput(text) {
    this._currentInput = text;
    if (!this.inputEl) return;
    if (text) {
      this.inputEl.classList.remove('pip-empty');
      this.inputEl.textContent = text;
    } else {
      this.inputEl.classList.add('pip-empty');
      this.inputEl.textContent = '—';
    }
  }

  setOutput(text) {
    this._currentOutput = text;
    if (!this.outputEl) return;
    if (text) {
      this.outputEl.classList.remove('pip-empty');
      this.outputEl.textContent = text;
    } else {
      this.outputEl.classList.add('pip-empty');
      this.outputEl.textContent = '—';
    }
  }

  _cleanup() {
    this.win = null;
    this.statusEl = this.dotEl = null;
    this.inputEl = this.outputEl = null;
    this.inputLabelEl = this.outputLabelEl = null;
    this.onClose();
  }

  close() {
    if (this.win) { try { this.win.close(); } catch (_) {} }
    this._cleanup();
  }
}

async function togglePip() {
  if (state.pip && state.pip.isOpen()) {
    state.pip.close();
    return;
  }
  const pip = new PipController();
  try {
    await pip.open();
  } catch (e) {
    log('error', 'Pop out failed: ' + (e && e.message ? e.message : e));
    return;
  }
  state.pip = pip;
  pip.onClose = () => { if (state.pip === pip) state.pip = null; };

  // Seed with current state.
  pip.setStatus(els.statusText.textContent, els.statusPill.classList.contains('pill-translating')
                                              || els.statusPill.classList.contains('pill-listening'));
  pip.setLangs(langName(els.langSource.value), langName(els.langTarget.value));
  if (state.liveTurn) {
    pip.setInput(state.liveTurn.inputText);
    pip.setOutput(state.liveTurn.outputText);
  } else {
    // Try last completed turn.
    const last = els.turns.querySelector('.turn:last-child');
    if (last) {
      const it = last.querySelector('.turn-row.input .turn-text');
      const ot = last.querySelector('.turn-row.output .turn-text');
      pip.setInput(it && !it.classList.contains('empty') ? it.textContent : '');
      pip.setOutput(ot && !ot.classList.contains('empty') ? ot.textContent : '');
    }
  }
  log('info', PipController.isDocPipSupported() ? 'Pop-out window opened.' : 'Pop-out (popup fallback) opened.');
}

// ─── Wire UI ─────────────────────────────────────────────────────────────────
function wireUI() {
  els.btnStart.addEventListener('click', startPipeline);
  els.btnStop.addEventListener('click', stopPipeline);
  els.btnPause.addEventListener('click', togglePause);
  els.btnHush.addEventListener('click', () => {
    if (state.player) state.player.hush();
    log('info', 'Playback hushed');
  });
  els.btnClear.addEventListener('click', clearConversation);
  els.btnSwap.addEventListener('click', () => {
    const a = els.langSource.value;
    els.langSource.value = els.langTarget.value;
    els.langTarget.value = a;
    savePrefs();
  });
  els.btnShowKey.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });
  els.modeSelect.addEventListener('change', () => {
    updateDirVisibility();
    savePrefs();
  });
  els.vadPreset.addEventListener('change', () => {
    if (els.vadPreset.value !== 'custom') applyVadPreset(els.vadPreset.value);
    savePrefs();
  });
  for (const el of [els.vadStart, els.vadEnd, els.vadPrefix, els.vadSilence]) {
    el.addEventListener('change', () => {
      els.vadPreset.value = detectVadPreset();
      savePrefs();
    });
  }
  els.audioSource.addEventListener('change', () => {
    if (els.audioSource.value === 'companion') detectCompanionService({ silent: false });
    updateCompanionAppVisibility();
    savePrefs();
  });
  if (els.companionApp) {
    els.companionApp.addEventListener('change', () => {
      els.companionApp.dataset.preferred = els.companionApp.value;
      savePrefs();
    });
  }
  if (els.btnRefreshApps) {
    els.btnRefreshApps.addEventListener('click', () => refreshCompanionApps({ silent: false }));
  }
  for (const sel of [els.langSource, els.langTarget, els.voice, els.dirSelect]) {
    sel.addEventListener('change', savePrefs);
  }
  els.audioInput.addEventListener('change', changeAudioInput);
  els.audioOutput.addEventListener('change', changeAudioOutput);
  els.apiKey.addEventListener('change', savePrefs);

  els.btnMenu.addEventListener('click', () => openSheet('sidebar'));
  els.btnLog.addEventListener('click', () => openSheet('log-sheet'));
  els.btnEditPrompt.addEventListener('click', openPromptEditor);
  els.btnSavePrompt.addEventListener('click', savePromptEditor);
  els.btnResetPrompt.addEventListener('click', resetPromptEditor);
  els.btnPip.addEventListener('click', togglePip);
  els.btnPipQuick.addEventListener('click', togglePip);
  if (els.openFromEmpty) {
    els.openFromEmpty.addEventListener('click', () => openSheet('sidebar'));
  }

  // Generic sheet close handlers
  document.addEventListener('click', (ev) => {
    const tgt = ev.target.closest('[data-close]');
    if (tgt) closeSheet(tgt.getAttribute('data-close'));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeSheet('sidebar');
      closeSheet('prompt-sheet');
      closeSheet('log-sheet');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.running) stopPipeline();
    if (state.pip) state.pip.close();
  });
  window.addEventListener('focus', () => detectCompanionService());

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshAudioInputDevices();
      refreshAudioOutputDevices();
    });
  }
}

function checkSupport() {
  const missing = [];
  if (!window.WebSocket) missing.push('WebSocket');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) missing.push('getUserMedia');
  if (!(window.AudioContext || window.webkitAudioContext)) missing.push('AudioContext');
  if (!window.AudioWorkletNode) missing.push('AudioWorklet');
  if (missing.length) {
    log('error', 'Browser missing required APIs: ' + missing.join(', '));
    els.btnStart.disabled = true;
    return false;
  }
  if (location.protocol === 'http:' &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1') {
    log('warn', 'Microphone needs HTTPS, localhost, or file://.');
  }
  if (!PipController.isDocPipSupported()) {
    log('info', 'Native PiP unavailable here — Pop out will use a regular popup window.');
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  fillLanguages();
  wireUI();
  setStatus('idle');
  detectCompanionService();
  refreshAudioInputDevices();
  refreshAudioOutputDevices();
  if (checkSupport()) log('info', 'Ready.');
});
