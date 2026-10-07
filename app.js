/* ─────────────────────────────────────────────────────────────────
   NoteCapture — app.js
   All frontend logic. Sections:
     1. CONFIG          — easy-to-change constants
     2. STORAGE         — read/write notes to localStorage
     3. AUTH            — passcode gate
     4. CAPTURE         — mic + text input
     5. QUEUE           — pending retry system
     6. RENDER          — notes list + cards
     7. MODAL           — note detail / edit
     8. SETTINGS        — settings screen
     9. NAV             — screen switching
    10. INIT            — app boot
   ───────────────────────────────────────────────────────────────── */

'use strict';

// ── 1. CONFIG ────────────────────────────────────────────────────
// Centralised constants. Change these without touching logic.

const CONFIG = {
  // localStorage keys
  KEYS: {
    NOTES:       'nc_notes',        // array of all note objects
    PASSCODE:    'nc_passcode',     // stored passcode string
    WORKER_URL:  'nc_worker_url',   // Cloudflare Worker endpoint
    PENDING:     'nc_pending',      // array of note IDs awaiting processing
    CAPTURE_TYPE:'nc_capture_type', // last chosen capture type override
    TRANSCRIPTION_PROMPT: 'nc_transcription_prompt',
    PROMPT:      'nc_custom_prompt',// custom AI prompt override (empty = Worker default)
    DATA_VERSION:'nc_data_version', // note schema migration version
  },

  API_VERSION: 2,
  DEFAULT_TRANSCRIPTION_PROMPT: 'Mixed English, Urdu and Arabic speech. Use Latin letters for English, Urdu script for Urdu, and Arabic script for Arabic; no Hindi or Punjabi. Examples: Please کل صبح meeting رکھ دیں۔ الحمد لله، I will call tomorrow. ہوٹل کی maintenance check کرنی ہے۔',

  // How often the retry queue runs (ms)
  QUEUE_INTERVAL_MS: 60_000,

  // Max retries before a note is left as raw
  MAX_RETRIES: 5,

  // Max audio recording duration (ms) before auto-stop
  MAX_RECORD_MS: 120_000,

  // Note types — add/rename here, UI updates automatically
  // ⚠️ Changing values here will orphan old notes with old type strings.
  //    To rename: update value + write a migration in migrateNotes().
  TYPES: [
    { value: 'todo',     label: 'To-do',    color: 'var(--type-todo)' },
    { value: 'reminder', label: 'Reminder', color: 'var(--type-reminder)' },
    { value: 'schedule', label: 'Schedule', color: 'var(--type-schedule)' },
    { value: 'idea',     label: 'Idea',     color: 'var(--type-idea)' },
    { value: 'research', label: 'Research', color: 'var(--type-research)' },
    { value: 'note',     label: 'Note',     color: 'var(--type-note)' },
  ],
};


// ── 2. STORAGE ───────────────────────────────────────────────────
// All persistence goes through these functions.
// Swap localStorage for IndexedDB or a remote DB here later.

const Store = {
  /** Return all notes, newest first */
  getNotes() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.KEYS.NOTES) || '[]');
    } catch { return []; }
  },

  /** Persist the full notes array */
  setNotes(notes) {
    localStorage.setItem(CONFIG.KEYS.NOTES, JSON.stringify(notes));
  },

  /** Get a single note by id */
  getNote(id) {
    return this.getNotes().find(n => n.id === id) || null;
  },

  /** Save or update a single note (upsert) */
  saveNote(note) {
    const notes = this.getNotes();
    const idx = notes.findIndex(n => n.id === note.id);
    note.updated_at = new Date().toISOString();
    if (idx >= 0) { notes[idx] = note; }
    else { notes.unshift(note); }
    this.setNotes(notes);
  },

  /** Delete a note by id */
  deleteNote(id) {
    this.setNotes(this.getNotes().filter(n => n.id !== id));
    this.removePending(id);
  },

  /** Pending queue helpers */
  getPending() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.KEYS.PENDING) || '[]');
    } catch { return []; }
  },
  addPending(id) {
    const q = this.getPending();
    if (!q.includes(id)) { q.push(id); localStorage.setItem(CONFIG.KEYS.PENDING, JSON.stringify(q)); }
  },
  removePending(id) {
    const q = this.getPending().filter(i => i !== id);
    localStorage.setItem(CONFIG.KEYS.PENDING, JSON.stringify(q));
  },

  /** Settings helpers */
  getPasscode()    { return localStorage.getItem(CONFIG.KEYS.PASSCODE) || ''; },
  setPasscode(v)   { localStorage.setItem(CONFIG.KEYS.PASSCODE, v); },
  getWorkerUrl()   { return (localStorage.getItem(CONFIG.KEYS.WORKER_URL) || '').replace(/\/$/, ''); },
  setWorkerUrl(v)  { localStorage.setItem(CONFIG.KEYS.WORKER_URL, v.replace(/\/$/, '')); },
  /** Custom prompt override. Empty string/absent = use the Worker's built-in default. */
  getPrompt()      { return localStorage.getItem(CONFIG.KEYS.PROMPT) || ''; },
  setPrompt(v)     {
    if (v) localStorage.setItem(CONFIG.KEYS.PROMPT, v);
    else   localStorage.removeItem(CONFIG.KEYS.PROMPT); // keep storage clean when reset
  },

  getTranscriptionPrompt() { return localStorage.getItem(CONFIG.KEYS.TRANSCRIPTION_PROMPT) ?? CONFIG.DEFAULT_TRANSCRIPTION_PROMPT; },
  setTranscriptionPrompt(v) { localStorage.setItem(CONFIG.KEYS.TRANSCRIPTION_PROMPT, v); },

  /** Wipe everything */
  clearAll() {
    Object.values(CONFIG.KEYS).forEach(k => localStorage.removeItem(k));
  },

  /** Run versioned, non-destructive note schema migrations on boot */
  migrateNotes() {
    const currentVersion = Number(localStorage.getItem(CONFIG.KEYS.DATA_VERSION) || '0');

    // Version 1 — Stage 1 data model
    if (currentVersion < 1) {
      const notes = this.getNotes();
      const migrated = notes.map(note => {
        note.input = note.input || {};
        note.ai = note.ai || {};
        note.user = note.user || {};

        if (!Array.isArray(note.context)) note.context = [];
        if (!Array.isArray(note.ai.topics)) {
          note.ai.topics = note.ai.topic ? [note.ai.topic] : [];
        }

        if (!Object.prototype.hasOwnProperty.call(note.user, 'cleaned_text')) note.user.cleaned_text = null;
        if (!Object.prototype.hasOwnProperty.call(note.user, 'summary')) note.user.summary = null;
        if (!Object.prototype.hasOwnProperty.call(note.user, 'fields')) note.user.fields = null;
        if (!Array.isArray(note.user.tags_added)) note.user.tags_added = [];
        if (!Array.isArray(note.user.tags_removed)) note.user.tags_removed = [];

        // Preserve the visible result of a legacy single-topic override.
        const oldOverride = note.user.topic_override;
        const oldAiTopic = note.ai.topic;
        if (oldOverride && oldOverride !== oldAiTopic) {
          if (!note.user.tags_added.includes(oldOverride)) note.user.tags_added.push(oldOverride);
          if (oldAiTopic && !note.user.tags_removed.includes(oldAiTopic)) note.user.tags_removed.push(oldAiTopic);
        }

        if (note.ai.clarification_dismissed) note.user.dismissed_question_id = note.ai.clarification_question;
        return note;
      });

      this.setNotes(migrated);
      localStorage.setItem(CONFIG.KEYS.DATA_VERSION, '1');
    }
    if (currentVersion < 2) {
      const notes = this.getNotes();
      notes.forEach(n => { if (n.ai?.clarification_dismissed && n.user) n.user.dismissed_question_id = n.ai.clarification_question; });
      this.setNotes(notes);
      localStorage.setItem(CONFIG.KEYS.DATA_VERSION, '2');
    }
  },
};


// ── 3. AUTH ──────────────────────────────────────────────────────
// Passcode gate. Passcode is sent with every Worker request.

const Auth = {
  /** Check if we have a stored passcode already */
  isUnlocked() {
    return !!Store.getPasscode();
  },

  /** Try the entered passcode: ping Worker to verify it, or store optimistically */
  async unlock(passcode) {
    const url = Store.getWorkerUrl();
    if (!url) {
      // No Worker URL set yet — store passcode and proceed
      Store.setPasscode(passcode);
      return { ok: true };
    }
    // Verify against Worker
    try {
      const res = await fetch(`${url}/ping`, {
        method: 'GET',
        headers: { 'X-Passcode': passcode },
      });
      if (res.status === 401) return { ok: false, error: 'Incorrect passcode.' };
      Store.setPasscode(passcode);
      return { ok: true };
    } catch {
      // Network error — store optimistically, will fail later on real calls
      Store.setPasscode(passcode);
      return { ok: true };
    }
  },
};


// ── 4. CAPTURE ───────────────────────────────────────────────────
// Handles mic recording (MediaRecorder) + text input.
// Saves raw note immediately, then enqueues for Worker processing.

const Capture = {
  mediaRecorder: null,
  audioChunks: [],
  recordTimer: null,
  captureTypeOverride: null, // null = let AI decide

  /** Build a fresh empty note object */
  makeNote(mode) {
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'raw', // raw | processing | done | needs_context
      input: {
        mode,               // 'voice' | 'text'
        raw_text: '',       // typed text or transcript — updated when transcription arrives
        original_text: '',  // set once at capture time, NEVER overwritten afterward
        audio_blob_key: null,
      },
      context: [],
      ai: {
        type: null,
        type_confidence: null,
        cleaned_text: '',
        summary: '',
        fields: {},
        topics: [],
        topic: '', // legacy field retained until UI switches to topics[]
        clarification_needed: false,
        clarification_question: null,
        clarification_answer: null, // legacy field retained until context UI lands
      },
      user: {
        type_override: this.captureTypeOverride,
        cleaned_text: null,
        summary: null,
        fields: null,
        tags_added: [],
        tags_removed: [],
        topic_override: null, // legacy field retained for current UI
        edits: {},            // legacy field retained for rollback compatibility
      },
      sync: {
        pending: true,
        retry_count: 0,
        last_error: null,
      },
    };
  },

  /** Check if the browser supports audio recording */
  hasVoiceSupport() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  },

  /** Start recording */
  async startRecording() {
    if (!this.hasVoiceSupport()) {
      UI.setMicState('no-voice');
      UI.setMicStatus('voice not available — use text');
      return;
    }
    // Block recording when offline — audio requires Groq Whisper (server-side)
    // If offline, user should type instead. Audio blobs cannot be transcribed locally.
    if (!navigator.onLine) {
      UI.showToast('Offline — type your note instead', 'error');
      UI.setMicStatus('offline — use text input');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      // Pick best supported MIME type
      const mimeType = ['audio/webm', 'audio/ogg', 'audio/mp4', ''].find(
        m => !m || MediaRecorder.isTypeSupported(m)
      );
      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

      this.mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this._onRecordingDone();
      };

      this.mediaRecorder.start(250); // collect chunks every 250ms
      UI.setMicState('recording');
      UI.setMicStatus('recording… tap to stop');

      // Auto-stop at max duration
      this.recordTimer = setTimeout(() => this.stopRecording(), CONFIG.MAX_RECORD_MS);
    } catch (err) {
      console.warn('Capture: mic error', err);
      UI.setMicState('idle');
      UI.setMicStatus('mic denied — use text');
      UI.showToast('Microphone access denied', 'error');
    }
  },

  /** Stop recording */
  stopRecording() {
    clearTimeout(this.recordTimer);
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      UI.setMicState('processing');
      UI.setMicStatus('saving…');
    }
  },

  /** Called when MediaRecorder finishes — save audio + enqueue */
  async _onRecordingDone() {
    const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
    this.audioChunks = [];

    const note = this.makeNote('voice');

    // Save audio blob to localStorage as base64
    // (blobs can't be serialised directly)
    const blobKey = `nc_audio_${note.id}`;
    try {
      const base64 = await blobToBase64(blob);
      localStorage.setItem(blobKey, base64);
      note.input.audio_blob_key = blobKey;
      note.input.audio_mime_type = blob.type.split(';')[0];
    } catch (err) {
      console.warn('Capture: could not save audio blob', err);
    }

    // Save note immediately — this is the never-lose-it guarantee
    Store.saveNote(note);
    Store.addPending(note.id);

    UI.setMicState('idle');
    UI.setMicStatus('tap to record');
    UI.showToast('Note saved — processing…');
    UI.updatePendingBadge();

    // Try to process now
    Queue.processNote(note.id);
  },

  /** Save a text note */
  saveTextNote(text) {
    text = text.trim();
    if (!text) return;

    const note = this.makeNote('text');
    note.input.raw_text      = text;
    note.input.original_text = text; // locked forever
    note.status = 'raw';

    Store.saveNote(note);
    Store.addPending(note.id);

    UI.showToast('Note saved — processing…');
    UI.updatePendingBadge();

    // Clear input
    document.getElementById('text-input').value = '';

    Queue.processNote(note.id);
  },
};


// ── 5. QUEUE ─────────────────────────────────────────────────────
// Pending retry system. Every note that needs Worker processing
// goes through here. Retries on failure, gives up after MAX_RETRIES.

const Queue = {
  active: new Set(),
  /** Process a single note by id */
  async processNote(id) {
    const note = Store.getNote(id);
    if (!note || this.active.has(id) || navigator.onLine === false) return;

    const workerUrl = Store.getWorkerUrl();
    const passcode  = Store.getPasscode();

    if (!workerUrl || !passcode) {
      // No Worker configured — leave note as raw
      console.info('Queue: no Worker URL or passcode set, skipping', id);
      return;
    }

    if (note.sync.retry_count >= CONFIG.MAX_RETRIES) {
      console.warn('Queue: max retries reached for', id);
      return;
    }

    this.active.add(id);
    note.status = 'processing';
    Store.saveNote(note);

    try {
      const ping = await fetch(`${workerUrl}/ping`, { headers: { 'X-Passcode': passcode } });
      if (!ping.ok) throw new Error(`Worker authentication/connectivity failed: HTTP ${ping.status}`);
      const protocol = await ping.json();
      if (protocol.api_version !== CONFIG.API_VERSION) throw new Error('Deploy the updated Worker (API 2) before processing notes.');
      // Build request body
      const body = {
        note_id: note.id,
        mode: note.input.mode,
        api_version: CONFIG.API_VERSION,
        transcription_prompt: Store.getTranscriptionPrompt(),
        created_at: note.created_at,
        current_time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        raw_text: _assembleReprocessText(note) || note.input.raw_text || null,
        type_hint: note.input.reprocess_requested ? null : (note.user.type_override || null),
        existing_topics: _getExistingTopics(),
        clarification_answer: null,
        custom_prompt: Store.getPrompt() || null,
      };

      // Attach audio if present
      if (note.input.audio_blob_key && !note.input.reprocess_requested) {
        const base64 = localStorage.getItem(note.input.audio_blob_key);
        if (base64) {
          body.audio_base64 = base64;
          body.audio_mime_type = note.input.audio_mime_type || (base64.startsWith('AAAA') ? 'audio/mp4' : 'audio/webm');
        }
      }

      const res = await fetch(`${workerUrl}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passcode': passcode,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        UI.showToast('Passcode rejected by Worker', 'error');
        note.status = 'raw';
        note.sync.last_error = '401 unauthorised';
        Store.saveNote(note);
        return;
      }

      const data = await res.json();
      const stored = Store.getNote(id);
      if (!stored) return;
      note.user = stored.user; // preserve edits saved while the request was in flight
      // Persist a successful transcript even if subsequent structuring fails.
      const transcript = data.result?.transcript || data.transcript;
      if (transcript && !note.input.original_text && !note.input.reprocess_requested) {
        note.input.raw_text = transcript;
        note.input.original_text = transcript;
        const audioKey = note.input.audio_blob_key;
        note.input.audio_blob_key = null;
        Store.saveNote(note);
        if (audioKey) localStorage.removeItem(audioKey);
      }

      if (data.status === 'ok' && data.result) {
        if (!Store.getNote(id)) return; // deleted while processing
        if (note.input.reprocess_requested) _clearUserEditsForReprocess(note);
        note.input.reprocess_requested = false;
        _applyAiResult(note, data.result);
        _recordQuestion(note);
        note.status = data.result.clarification_needed ? 'needs_context' : 'done';
        note.sync.pending = false;
        note.sync.last_error = null;

        // Clean up stored audio blob once transcribed
        if (note.input.audio_blob_key && body.audio_base64) {
          localStorage.removeItem(note.input.audio_blob_key);
          note.input.audio_blob_key = null;
        }
        Store.saveNote(note);
        Store.removePending(note.id);
        UI.updatePendingBadge();

        // Refresh notes list if visible
        if (document.getElementById('screen-notes').classList.contains('active')) {
          Render.renderNotesList();
        }
      } else {
        throw new Error(data.error || data.status || 'Unknown Worker error');
      }
    } catch (err) {
      console.warn('Queue: Worker call failed for', id, err);
      const fresh = Store.getNote(id);
      if (fresh) {
        fresh.sync.retry_count = (fresh.sync.retry_count || 0) + 1;
        fresh.status = fresh.sync.retry_count >= CONFIG.MAX_RETRIES ? 'error' : 'raw';
        fresh.sync.last_error = err.message;
        Store.saveNote(fresh);
      }
    } finally {
      this.active.delete(id);
      UI.updatePendingBadge();
      if (document.getElementById('screen-notes').classList.contains('active')) Render.renderNotesList();
    }
  },

  /** Drain the pending queue — called on load and on interval */
  async drainQueue(resetRetries = false) {
    const pending = Store.getPending();
    if (!pending.length) return;
    // Process up to 3 at a time to avoid hammering quota
    const batch = pending.slice(0, 3);
    for (const id of batch) {
      // If manual retry, reset retry count so stuck notes get another chance
      if (resetRetries) {
        const note = Store.getNote(id);
        if (note) {
          note.sync.retry_count = 0;
          note.sync.last_error  = null;
          Store.saveNote(note);
        }
      }
      await this.processNote(id);
    }
    UI.updatePendingBadge();
  },

  /** Start the background retry interval */
  startInterval() {
    setInterval(() => this.drainQueue(), CONFIG.QUEUE_INTERVAL_MS);
    // Also drain when browser comes back online
    window.addEventListener('online', () => this.drainQueue());
  },
};

/** Apply AI result fields onto a note object (mutates note).
 *  Only copies the exact fields we expect — ignores anything extra the AI adds. */
function _applyAiResult(note, result) {
  // ── Custom-prompt mode ───────────────────────────────────────
  // When a custom prompt (Settings → AI Prompt) is active, the Worker
  // skips its tagging/summarising/clarification pipeline and returns just
  // { result, transcript }. Everything else (type, summary, topic, fields,
  // clarification) is left as-is/empty — no extra routing is forced.
  if (typeof result.result === 'string') {
    note.ai.type               = 'note';
    note.ai.topics = [];
    note.ai.topic = '';
    note.ai.type_confidence    = 'high';
    note.ai.cleaned_text       = result.result || note.input.raw_text;
    note.ai.summary            = '';
    note.ai.fields             = {};
    note.ai.clarification_needed   = false;
    note.ai.clarification_question = null;
    return;
  }

  // ── Default structured mode ──────────────────────────────────
  note.ai.type               = result.type || 'note';
  note.ai.type_confidence    = result.type_confidence || 'high';
  note.ai.cleaned_text       = result.cleaned_text || note.input.raw_text;
  note.ai.summary            = result.summary || '';
  note.ai.topic              = result.topic || '';
  note.ai.topics             = Array.isArray(result.topics)
    ? result.topics.filter(Boolean).slice(0, 4)
    : (result.topic ? [result.topic] : []);
  // Strip fields to only allowed keys for this type — no AI extras
  note.ai.fields             = _sanitiseFields(result.type, result.fields || {});
  note.ai.clarification_needed   = !!result.clarification_needed;
  note.ai.clarification_question = result.clarification_question || null;
}

/** Strip AI fields to only the allowed keys for each note type.
 *  Prevents AI from sneaking in sentiment/warning fields. */
function _sanitiseFields(type, fields) {
  const ALLOWED = {
    todo:     ['action', 'priority'],
    reminder: ['action', 'due_datetime'],
    schedule: ['event_name', 'datetime', 'location'],
    idea:     ['follow_up_question'],
    research: ['follow_up_question'],
    note:     [],
  };
  const allowed = ALLOWED[type] || [];
  return Object.fromEntries(allowed.map(k => [k, fields[k] ?? '']));
}

/** Return the final displayed type after any user override. */
function _getFinalType(note) {
  return note.user?.type_override || note.ai?.type || 'note';
}

/** Return final cleaned text without overwriting the AI's original output. */
function _getFinalCleanedText(note) {
  return note.user?.cleaned_text !== null && note.user?.cleaned_text !== undefined
    ? note.user.cleaned_text
    : (note.ai?.cleaned_text || note.input?.raw_text || '');
}

/** Return final summary without overwriting the AI's original output. */
function _getFinalSummary(note) {
  return note.user?.summary !== null && note.user?.summary !== undefined
    ? note.user.summary
    : (note.ai?.summary || '');
}

/** Return final fields without overwriting the AI's original output. */
function _getFinalFields(note) {
  return note.user?.fields !== null && note.user?.fields !== undefined
    ? note.user.fields
    : (note.ai?.fields || {});
}

/** Return final tags: AI tags plus user additions, minus user removals. */
function _getFinalTags(note) {
  const aiTags = Array.isArray(note.ai?.topics)
    ? note.ai.topics
    : (note.ai?.topic ? [note.ai.topic] : []);
  const added = Array.isArray(note.user?.tags_added) ? note.user.tags_added : [];
  const removed = new Set(
    (Array.isArray(note.user?.tags_removed) ? note.user.tags_removed : [])
      .map(t => String(t).trim().toLowerCase())
  );

  const seen = new Set();
  return [...aiTags, ...added]
    .map(t => String(t).trim())
    .filter(Boolean)
    .filter(t => !removed.has(t.toLowerCase()))
    .filter(t => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Collect distinct FINAL topic strings from existing notes (for AI context). */
function _getExistingTopics() {
  const seen = new Set();
  const topics = [];
  Store.getNotes().forEach(note => {
    _getFinalTags(note).forEach(topic => {
      const key = topic.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        topics.push(topic);
      }
    });
  });
  return topics.slice(0, 20);
}

/** Latest user-approved reprocessing text takes priority over historical source. */
function _assembleReprocessText(note) {
  if (typeof note.input?.processing_text === 'string') return note.input.processing_text;
  const original = note.input?.original_text || note.input?.raw_text || '';
  const entries = Array.isArray(note.context) ? note.context : [];
  const oldContext = entries.filter(e => e.text && e.source !== 'ai_question_only');
  return [original, ...oldContext.map(e => `User added: ${e.text}`)].filter(Boolean).join('\n\n');
}

function _recordQuestion(note) {
  if (!note.ai.clarification_needed || !note.ai.clarification_question) return;
  note.context = note.context || [];
  const last = [...note.context].reverse().find(e => e.source === 'ai_question_only');
  if (last?.text === note.ai.clarification_question) return;
  note.context.push({ id: crypto.randomUUID(), at: new Date().toISOString(), source: 'ai_question_only', text: note.ai.clarification_question });
}

function _questionKey(note) { return note.ai?.clarification_question || ''; }

/** Clear user-owned AI-derived edits before a deliberate reprocess.
 *  Hand-added/removed tags are intentionally preserved. */
function _clearUserEditsForReprocess(note) {
  note.user.cleaned_text = null;
  note.user.summary = null;
  note.user.fields = null;
  note.user.type_override = null;
  note.user.topic_override = null; // legacy compatibility field only
}

/** Compact local timestamp for history labels. */
function _historyTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Convert a Blob to a base64 data URL string */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}


// ── 6. RENDER ────────────────────────────────────────────────────
// Builds the notes list DOM. Only touches #notes-list.

const Render = {
  currentFilter: 'all',
  currentSearch: '',

  renderNotesList() {
    const list = document.getElementById('notes-list');
    let notes = Store.getNotes();

    // Apply type filter
    if (this.currentFilter !== 'all') {
      notes = notes.filter(n => _getFinalType(n) === this.currentFilter);
    }

    // Apply text search
    if (this.currentSearch) {
      const q = this.currentSearch.toLowerCase();
      notes = notes.filter(n =>
        [n.input.original_text, n.input.raw_text, ...(n.context || []).map(e => e.text), _getFinalCleanedText(n), _getFinalSummary(n),
         ..._getFinalTags(n), ...Object.values(_getFinalFields(n))]
          .some(v => String(v || '').toLowerCase().includes(q))
      );
    }

    if (!notes.length) {
      list.innerHTML = `<p class="notes-empty">no notes yet</p>`;
      return;
    }

    list.innerHTML = notes.map(n => _noteCardHTML(n)).join('');

    // Bind tap events
    list.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', () => Modal.open(card.dataset.id));
    });
  },
};

/** Generate HTML string for a single note card */
function _noteCardHTML(note) {
  const type    = _getFinalType(note);
  const label   = CONFIG.TYPES.find(t => t.value === type)?.label || type;
  const topic   = _getFinalTags(note)[0] || '';
  const summary = _getFinalSummary(note) || _getFinalCleanedText(note) || note.input.raw_text || '(no content)';
  const time    = _relativeTime(note.created_at);

  const needsCtx  = note.status === 'needs_context' && note.user?.dismissed_question_id !== _questionKey(note) ? 'needs-context' : '';
  const isPending = note.sync.pending ? 'pending' : '';

  return `
    <div class="note-card ${needsCtx} ${isPending}" data-id="${note.id}" data-type="${type}">
      <div class="note-card-top">
        <span class="note-type-badge ${type}">${label}</span>
        ${topic ? `<span class="note-topic">${escHtml(topic)}</span>` : ''}
      </div>
      <p class="note-summary">${escHtml(summary)}</p>
      <p class="note-time">${time}</p>
      ${note.sync.pending ? `<p class="note-pending-label">⟳ pending sync</p>` : ''}
    </div>
  `;
}


// ── 7. MODAL ─────────────────────────────────────────────────────
// Note detail / edit sheet. One modal, reused for all notes.

const Modal = {
  currentId: null,
  openSnapshot: null,

  requestClose(fromBack = false) {
    if (this.hasUnsavedChanges() && !confirm('Discard unsaved changes?')) {
      if (fromBack) history.pushState({ ncNote: this.currentId }, '');
      return;
    }
    this.close(fromBack);
  },

  open(id) {
    const note = Store.getNote(id);
    if (!note) return;
    this.currentId = id;
    this.previousFocus = document.activeElement;
    history.pushState({ ncNote: id }, '');

    const type = _getFinalType(note);
    const tags = _getFinalTags(note);

    document.getElementById('modal-type').value    = type;
    document.getElementById('modal-topic').value   = tags.join(', ');
    document.getElementById('modal-cleaned').value = _getFinalCleanedText(note);
    document.getElementById('modal-summary').value = _getFinalSummary(note);

    // New Stage 1 modal sections. Guard these so a cached older index.html
    // cannot prevent notes from opening while GitHub Pages updates.
    if (document.getElementById('modal-original-meta')) this._renderHistory(note);
    if (document.getElementById('context-question-wrap')) this._renderContextPanel(note);
    this._renderFields(note);

    document.getElementById('modal-timestamps').textContent =
      `created ${_relativeTime(note.created_at)}  ·  updated ${_relativeTime(note.updated_at)}`;

    if (note.input.audio_blob_key) {
      const base64 = localStorage.getItem(note.input.audio_blob_key);
      if (base64) {
        const isMp4 = base64.startsWith('/w') || base64.startsWith('AAAA');
        AudioPlayer.load(base64, isMp4 ? 'audio/mp4' : 'audio/webm');
      } else {
        AudioPlayer.hide();
      }
    } else {
      AudioPlayer.hide();
    }

    document.getElementById('modal-note').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this.openSnapshot = this._formSnapshot();
    document.querySelector('.modal-content').scrollTop = 0;
    document.getElementById('modal-close').focus();
  },

  close(fromBack = false) {
    if (!fromBack && history.state?.ncNote === this.currentId) history.back();
    this.currentId = null;
    this.openSnapshot = null;
    AudioPlayer.hide();
    document.getElementById('modal-note').classList.add('hidden');
    document.body.style.overflow = '';
    this.previousFocus?.focus();
  },

  _formSnapshot() {
    const fields = {};
    document.querySelectorAll('#modal-fields .field-input').forEach(input => {
      fields[input.dataset.field] = input.value;
    });
    return JSON.stringify({
      type: document.getElementById('modal-type').value,
      tags: document.getElementById('modal-topic').value,
      cleaned: document.getElementById('modal-cleaned').value,
      summary: document.getElementById('modal-summary').value,
      fields,
    });
  },

  hasUnsavedChanges() {
    return this.openSnapshot !== null && this._formSnapshot() !== this.openSnapshot;
  },

  save(closeAfter = true) {
    const note = Store.getNote(this.currentId);
    if (!note) return;
    if (Queue.active.has(note.id) && note.input.reprocess_requested) { UI.showToast('Wait for reprocessing to finish before saving', 'error'); return; }

    const selectedType = document.getElementById('modal-type').value;
    const selectedTags = document.getElementById('modal-topic').value
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    note.user.type_override = selectedType !== note.ai.type ? selectedType : null;
    note.user.cleaned_text  = document.getElementById('modal-cleaned').value.trim();
    note.user.summary       = document.getElementById('modal-summary').value.trim();

    const aiTags = Array.isArray(note.ai.topics)
      ? note.ai.topics
      : (note.ai.topic ? [note.ai.topic] : []);
    const aiKeys = new Set(aiTags.map(t => String(t).trim().toLowerCase()));
    const selectedKeys = new Set(selectedTags.map(t => t.toLowerCase()));

    note.user.tags_added = selectedTags.filter(t => !aiKeys.has(t.toLowerCase()));
    note.user.tags_removed = aiTags.filter(t => !selectedKeys.has(String(t).trim().toLowerCase()));

    note.user.topic_override = selectedTags.length === 1 && selectedTags[0] !== note.ai.topic
      ? selectedTags[0]
      : null;

    const userFields = {};
    document.querySelectorAll('#modal-fields .field-input').forEach(input => {
      userFields[input.dataset.field] = input.value.trim();
    });
    note.user.fields = userFields;

    Store.saveNote(note);
    this.openSnapshot = this._formSnapshot();
    if (closeAfter) {
      this.close();
      Render.renderNotesList();
      UI.showToast('Saved', 'ok');
    }
  },

  delete() {
    if (!confirm('Delete this note?')) return;
    Store.deleteNote(this.currentId);
    this.close();
    Render.renderNotesList();
    UI.showToast('Deleted');
  },

  /** Reprocess current Cleaned, saving the exact source before requesting AI. */
  reprocess() {
    let note = Store.getNote(this.currentId);
    if (!note) return;
    if (Queue.active.has(note.id)) { UI.showToast('This note is still processing. Try again when it finishes.'); return; }
    const cleaned = document.getElementById('modal-cleaned').value.trim();
    if (!cleaned) { UI.showToast('Enter text in Cleaned first', 'error'); return; }
    this.save(false);
    note = Store.getNote(this.currentId);
    note.context = note.context || [];
    if (note.input.processing_text !== cleaned) {
      note.context.push({ id: crypto.randomUUID(), at: new Date().toISOString(), source: 'user_revision', text: cleaned });
    }
    note.input.processing_text = cleaned;
    note.input.reprocess_requested = true;
    note.status = 'raw';
    note.sync.pending = true;
    note.sync.retry_count = 0;
    note.sync.last_error = null;
    Store.saveNote(note);
    Store.addPending(note.id);
    this.close();
    Render.renderNotesList();
    Queue.processNote(note.id);
    UI.showToast('Saved — reprocessing…');
  },

  /** Hide the current needs-context state without deleting the AI question. */
  dismissContextQuestion() {
    const note = Store.getNote(this.currentId);
    if (!note) return;

    note.user.dismissed_question_id = _questionKey(note);
    if (note.status === 'needs_context') note.status = 'done';
    Store.saveNote(note);

    this._renderContextPanel(note);
    Render.renderNotesList();
    UI.showToast('Question dismissed');
  },

  _renderHistory(note) {
    const original = note.input.original_text || note.input.raw_text || '';
    document.getElementById('modal-original-meta').textContent =
      `Original · ${_historyTime(note.created_at)}`;
    const originalEl = document.getElementById('modal-original-text');
    originalEl.textContent = original || '(empty)';
    originalEl.classList.add('original-collapsed');
    const toggle = document.getElementById('modal-original-toggle');
    toggle.textContent = 'Show more';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.toggle('hidden', original.length < 180 && original.split('\n').length <= 3);
    requestAnimationFrame(() => toggle.classList.toggle('hidden', originalEl.scrollHeight <= originalEl.clientHeight + 1));

    const history = document.getElementById('modal-context-history');
    const entries = Array.isArray(note.context) ? note.context : [];

    document.getElementById('modal-history-details').classList.toggle('hidden', !entries.length);
    document.getElementById('modal-history-details').open = false;
    history.innerHTML = entries.map(entry => {
      if (entry.source === 'ai_question') {
        return `
          <div class="context-entry">
            <div class="history-label">[AI asked · ${escHtml(_historyTime(entry.at))}]</div>
            <div class="history-text">${escHtml(entry.question || '')}</div>
            <div class="history-label">[You answered · ${escHtml(_historyTime(entry.at))}]</div>
            <div class="history-text">${escHtml(entry.text || '')}</div>
          </div>`;
      }
      return `
        <div class="context-entry">
          <div class="history-label">[${entry.source === 'user_revision' ? 'You reprocessed' : entry.source === 'ai_question_only' ? 'AI asked' : 'You added'} · ${escHtml(_historyTime(entry.at))}]</div>
          <div class="history-text">${escHtml(entry.text || '')}</div>
        </div>`;
    }).join('');
  },

  _renderContextPanel(note) {
    const wrap = document.getElementById('context-question-wrap');
    if (!wrap) return;
    const hasQuestion = !!(
      note.ai.clarification_needed &&
      note.user?.dismissed_question_id !== _questionKey(note) &&
      note.ai.clarification_question
    );

    if (hasQuestion) {
      document.getElementById('context-question').textContent = note.ai.clarification_question;
      document.getElementById('context-panel').classList.remove('hidden');
      wrap.classList.remove('hidden');
    } else {
      document.getElementById('context-question').textContent = '';
      document.getElementById('context-panel').classList.add('hidden');
      wrap.classList.add('hidden');
    }

  },

  /** Render dynamic fields based on the note type */
  _renderFields(note) {
    const container = document.getElementById('modal-fields');
    const type = _getFinalType(note);
    const fields = _getFinalFields(note);

    const FIELD_DEFS = {
      todo:     [{ key: 'action', label: 'Action', type: 'text' }, { key: 'priority', label: 'Priority', type: 'text' }],
      reminder: [{ key: 'action', label: 'Action', type: 'text' }, { key: 'due_datetime', label: 'Due', type: 'text' }],
      schedule: [{ key: 'event_name', label: 'Event', type: 'text' }, { key: 'datetime', label: 'When', type: 'text' }, { key: 'location', label: 'Where', type: 'text' }],
      idea:     [{ key: 'follow_up_question', label: 'Follow-up', type: 'text' }],
      research: [{ key: 'follow_up_question', label: 'Follow-up', type: 'text' }],
      note:     [],
    };

    const defs = FIELD_DEFS[type] || [];
    if (!defs.length) { container.innerHTML = ''; return; }

    container.innerHTML = defs.map(def => `
      <div class="field-row">
        <label class="field-label">${def.label}</label>
        <input
          class="field-input"
          type="${def.type}"
          data-field="${def.key}"
          value="${escHtml(String(fields[def.key] || ''))}"
          placeholder="—"
        />
      </div>
    `).join('');
  },
};

// ── 8. SETTINGS ──────────────────────────────────────────────────

// ── AUDIO PLAYER CONTROLLER ─────────────────────────────────────
// Wires up the custom seek bar in the modal for smooth scrubbing.
// The native <audio> seek is jumpy on base64 blobs because the browser
// can't determine duration until the whole blob is loaded.
// We force-load the full blob and drive the seek bar ourselves.

const AudioPlayer = {
  audio: null,
  seekEl: null,
  timeEl: null,
  durEl:  null,
  rafId:  null,

  /** Call this after setting audio.src — wires up smooth seek bar */
  init() {
    this.audio   = document.getElementById('modal-audio-player');
    this.seekEl  = document.getElementById('modal-audio-seek');
    this.timeEl  = document.getElementById('modal-audio-time');
    this.durEl   = document.getElementById('modal-audio-duration');

    if (!this.audio || !this.seekEl) return;

    // Remove old listeners by cloning — cleanest way to reset
    const newAudio = this.audio.cloneNode(true);
    this.audio.parentNode.replaceChild(newAudio, this.audio);
    this.audio = newAudio;

    // preload=auto makes the browser buffer the whole blob up front
    this.audio.preload = 'auto';

    this.audio.addEventListener('loadedmetadata', () => {
      if (isFinite(this.audio.duration)) {
        this.durEl.textContent = _fmtTime(this.audio.duration);
        this.seekEl.max = this.audio.duration;
      }
    });

    // Some browsers (Safari) don't fire loadedmetadata on blob URLs.
    // Poll duration until it's available.
    const waitForDuration = setInterval(() => {
      if (this.audio.duration && isFinite(this.audio.duration)) {
        this.durEl.textContent = _fmtTime(this.audio.duration);
        this.seekEl.max = this.audio.duration;
        clearInterval(waitForDuration);
      }
    }, 200);

    this.audio.addEventListener('timeupdate', () => {
      if (!this.seekEl.dragging) {
        this.seekEl.value = this.audio.currentTime;
        this.timeEl.textContent = _fmtTime(this.audio.currentTime);
      }
    });

    // Smooth scrubbing — pause while dragging, seek on release
    this.seekEl.addEventListener('mousedown',  () => { this.seekEl.dragging = true; });
    this.seekEl.addEventListener('touchstart', () => { this.seekEl.dragging = true; }, { passive: true });
    this.seekEl.addEventListener('input', () => {
      this.timeEl.textContent = _fmtTime(parseFloat(this.seekEl.value));
    });
    this.seekEl.addEventListener('change', () => {
      this.audio.currentTime = parseFloat(this.seekEl.value);
      this.seekEl.dragging = false;
    });
    this.seekEl.addEventListener('mouseup',  () => { this.seekEl.dragging = false; });
    this.seekEl.addEventListener('touchend', () => { this.seekEl.dragging = false; });

    this.audio.addEventListener('ended', () => {
      this.seekEl.value = 0;
      this.timeEl.textContent = '0:00';
    });
  },

  /** Load a base64 audio string and show the player */
  load(base64, mimeType) {
    const wrap = document.getElementById('modal-audio-wrap');
    this.init(); // re-wire listeners on fresh element
    this.audio.src = `data:${mimeType};base64,${base64}`;
    this.audio.load(); // force buffer
    this.seekEl.value = 0;
    this.timeEl.textContent  = '0:00';
    this.durEl.textContent   = '…';
    wrap.classList.remove('hidden');
  },

  hide() {
    const wrap = document.getElementById('modal-audio-wrap');
    if (wrap) wrap.classList.add('hidden');
    if (this.audio) { this.audio.pause(); this.audio.src = ''; }
  },
};

function _fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}


// ── DIAGNOSTICS ──────────────────────────────────────────────────
// Tests each part of the pipeline and shows results in Settings.

const Diagnostics = {
  async run() {
    const workerUrl = Store.getWorkerUrl();
    const passcode  = Store.getPasscode();
    const panel     = document.getElementById('diag-panel');

    panel.classList.remove('hidden');
    document.getElementById('diag-summary').textContent = '';
    document.getElementById('diag-summary').className   = 'diag-summary';

    const checks = ['worker','auth','groq-key','groq-model','groq-whisper'];
    checks.forEach(k => {
      document.getElementById(`diag-${k}-icon`).textContent   = '○';
      document.getElementById(`diag-${k}-icon`).className     = 'diag-icon pending';
      document.getElementById(`diag-${k}-detail`).textContent = 'checking…';
    });

    // Step 1: Worker URL set?
    if (!workerUrl) {
      this._row('worker', false, 'No Worker URL — add it in Settings above');
      this._abort(['auth','groq-key','groq-model','groq-whisper']);
      this._summary(false, 'Add your Worker URL first.');
      return;
    }

    // Step 2: Worker reachable?
    try {
      const res = await fetch(`${workerUrl}/ping`, { method: 'GET' });
      if (res.status === 404) {
        this._row('worker', false, '/ping route missing — redeploy the latest worker.js');
        this._abort(['auth','groq-key','groq-model','groq-whisper']);
        this._summary(false, 'Redeploy worker.js — the /ping route is missing.');
        return;
      }
      // 401 = Worker running but no passcode header yet — that is expected here
      this._row('worker', true, `Reachable at ${workerUrl}`);
    } catch (err) {
      this._row('worker', false, `Cannot reach Worker: ${err.message}`);
      this._abort(['auth','groq-key','groq-model','groq-whisper']);
      this._summary(false, 'Check your Worker URL and that the Worker is deployed.');
      return;
    }

    // Step 3: Passcode works?
    if (!passcode) {
      this._row('auth', false, 'No passcode stored — enter it on the lock screen');
      this._abort(['groq-key','groq-model','groq-whisper']);
      this._summary(false, 'Enter your passcode on the lock screen first.');
      return;
    }
    try {
      const res = await fetch(`${workerUrl}/ping`, {
        method: 'GET',
        headers: { 'X-Passcode': passcode },
      });
      if (res.ok) {
        this._row('auth', true, 'Passcode accepted');
      } else if (res.status === 401) {
        this._row('auth', false, 'Passcode rejected — update it in Settings to match PASSCODE in your Worker env vars');
        this._abort(['groq-key','groq-model','groq-whisper']);
        this._summary(false, 'Wrong passcode. Update it in Settings or in your Cloudflare Worker variables.');
        return;
      } else {
        this._row('auth', false, `Unexpected response: HTTP ${res.status}`);
        this._abort(['groq-key','groq-model','groq-whisper']);
        return;
      }
    } catch (err) {
      this._row('auth', false, `Auth check failed: ${err.message}`);
      this._abort(['groq-key','groq-model','groq-whisper']);
      return;
    }

    // Step 4: Run /diagnose on Worker (checks Groq + Gemini)
    try {
      const res = await fetch(`${workerUrl}/diagnose`, {
        method: 'GET',
        headers: { 'X-Passcode': passcode },
      });

      if (res.status === 404) {
        this._row('groq-key',     false, '/diagnose route missing — redeploy the latest worker.js');
        this._abort(['groq-model','groq-whisper']);
        this._summary(false, 'Redeploy worker.js — the /diagnose route is missing.');
        return;
      }

      const data = await res.json();
      const r    = data.results || {};

      this._row('groq-key',     r.groq_key?.ok,     r.groq_key?.detail     || '—');
      this._row('groq-model',   r.groq_model?.ok,   r.groq_model?.detail   || '—');
      this._row('groq-whisper', r.groq_whisper?.ok, r.groq_whisper?.detail || '—');
      

      const anyAi = r.groq_model?.ok;
      if (!r.groq_key?.ok) {
        this._summary(false, 'Groq API key invalid — get a new one at console.groq.com and update GROQ_API_KEY in your Worker env vars.');
      } else if (!anyAi) {
        this._summary(false, 'Groq chat is failing — notes cannot be structured. Check the diagnostic above.');
      } else if (!r.groq_whisper?.ok) {
        this._summary(false, 'Voice transcription failing — voice notes will not process. Text notes still work.');

      } else {
        this._summary(true, 'Everything looks good. If notes still queue, hit Retry all pending.');
      }
    } catch (err) {
      this._row('groq-key',     false, `Diagnose request failed: ${err.message}`);
      this._abort(['groq-model','groq-whisper']);
      this._summary(false, 'Could not reach /diagnose — make sure the latest worker.js is deployed.');
    }
  },

  _row(key, ok, detail) {
    const icon = document.getElementById(`diag-${key}-icon`);
    const det  = document.getElementById(`diag-${key}-detail`);
    if (!icon || !det) return;
    icon.textContent = ok ? '✓' : '✗';
    icon.className   = `diag-icon ${ok ? 'ok' : 'fail'}`;
    det.textContent  = detail;
  },

  _abort(keys) {
    keys.forEach(k => {
      const icon = document.getElementById(`diag-${k}-icon`);
      const det  = document.getElementById(`diag-${k}-detail`);
      if (!icon) return;
      icon.textContent = '—';
      icon.className   = 'diag-icon pending';
      if (det) det.textContent = 'Skipped';
    });
  },

  _summary(ok, msg) {
    const el = document.getElementById('diag-summary');
    el.textContent = msg;
    el.className   = `diag-summary ${ok ? 'ok' : 'fail'}`;
  },
};


const Settings = {
  load() {
    document.getElementById('setting-worker-url').value = Store.getWorkerUrl();
    this.loadPrompt();
    document.getElementById('setting-transcription-prompt').value = Store.getTranscriptionPrompt();

    // Show pending queue details including last errors
    const pendingIds = Store.getPending();
    const el = document.getElementById('setting-pending-info');
    if (!pendingIds.length) {
      el.textContent = 'No notes pending sync.';
      return;
    }
    const details = pendingIds.map(id => {
      const n = Store.getNote(id);
      if (!n) return `${id}: not found`;
      const err = n.sync.last_error ? ` — ${n.sync.last_error}` : '';
      const retries = n.sync.retry_count ? ` (tried ${n.sync.retry_count}x)` : '';
      return `${n.id.slice(0,8)}… retries:${n.sync.retry_count}${err}`;
    });
    el.innerHTML = `${pendingIds.length} pending:<br><small style="opacity:0.7">${details.map(escHtml).join('<br>')}</small>`;
  },

  saveWorkerUrl() {
    const url = document.getElementById('setting-worker-url').value.trim();
    Store.setWorkerUrl(url);
    UI.showToast('Worker URL saved', 'ok');
  },

  savePasscode() {
    const p = document.getElementById('setting-passcode').value.trim();
    if (!p) { UI.showToast('Enter a passcode first', 'error'); return; }
    Store.setPasscode(p);
    document.getElementById('setting-passcode').value = '';
    UI.showToast('Passcode updated', 'ok');
  },

  clearAll() {
    if (!confirm('Delete ALL notes and settings? This cannot be undone.')) return;
    Store.clearAll();
    location.reload();
  },

  async loadDefaultPrompts() {
    const status = document.getElementById('default-prompt-status');
    status.textContent = 'Loading deployed default prompts…';
    document.getElementById('default-processing-prompt').textContent = '';
    document.getElementById('default-transcription-prompt').textContent = '';
    const url = Store.getWorkerUrl();
    if (!url) { status.textContent = 'Set your Worker URL first.'; return; }
    try {
      const res = await fetch(`${url}/prompts`, { headers: { 'X-Passcode': Store.getPasscode() } });
      if (!res.ok) throw new Error(res.status === 404 ? 'Deploy the updated Worker to enable prompt viewing.' : `Worker returned HTTP ${res.status}`);
      const data = await res.json();
      document.getElementById('default-processing-prompt').textContent = data.processing_prompt;
      document.getElementById('default-transcription-prompt').textContent = data.transcription_prompt;
      status.textContent = `Deployed Worker defaults · API ${data.api_version}`;
    } catch (err) { status.textContent = err.message; }
  },

  /** Populate the prompt textarea + status line from storage. */
  loadPrompt() {
    const ta     = document.getElementById('setting-prompt');
    const status = document.getElementById('setting-prompt-status');
    if (!ta || !status) return; // older index.html without the prompt editor

    const custom = Store.getPrompt();
    ta.value = custom;
    status.textContent = custom
      ? 'Using your custom prompt — tagging/summary/clarifying questions are skipped; you get back "result" + the original transcript.'
      : 'Using Worker default prompt (type, summary, topic, fields, clarifying questions).';
  },

  /** Save (or clear, if empty) the custom prompt override. */
  savePrompt() {
    const ta = document.getElementById('setting-prompt');
    if (!ta) return;
    const value = ta.value.trim();
    Store.setPrompt(value);
    this.loadPrompt();
    UI.showToast(value ? 'Custom prompt saved' : 'Reverted to Worker default prompt', 'ok');
  },
};


// ── 9. UI HELPERS ────────────────────────────────────────────────

const UI = {
  _toastTimer: null,

  showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast${type ? ` ${type}` : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
  },

  setMicState(state) {
    // state: 'idle' | 'recording' | 'processing' | 'no-voice'
    const btn = document.getElementById('mic-btn');
    btn.className = `mic-btn ${state !== 'idle' ? state : ''}`;
  },

  setMicStatus(msg) {
    document.getElementById('mic-status').textContent = msg;
  },

  updatePendingBadge() {
    const count = Store.getPending().length;
    const dot = document.getElementById('pending-count');
    if (count > 0) {
      dot.title = `${count} note${count !== 1 ? 's' : ''} pending`;
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  },

  /** Switch visible screen */
  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.add('active');

    // Update all nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.screen === name);
    });

    // Side effects per screen
    if (name === 'notes')    Render.renderNotesList();
    if (name === 'settings') Settings.load();
  },
};


// ── 10. INIT ─────────────────────────────────────────────────────
// Boot sequence. Runs on DOMContentLoaded.

function init() {
  Store.migrateNotes();

  // ── Passcode gate
  if (Auth.isUnlocked()) {
    UI.showScreen('capture');
    afterUnlock();
  } else {
    UI.showScreen('passcode');
  }

  // ── Passcode submit
  document.getElementById('passcode-submit').addEventListener('click', async () => {
    const val = document.getElementById('passcode-input').value.trim();
    if (!val) return;
    const result = await Auth.unlock(val);
    if (result.ok) {
      document.getElementById('passcode-error').classList.add('hidden');
      UI.showScreen('capture');
      afterUnlock();
    } else {
      document.getElementById('passcode-error').classList.remove('hidden');
    }
  });

  // Allow Enter key on passcode input
  document.getElementById('passcode-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('passcode-submit').click();
  });

  // ── Mic button
  const micBtn = document.getElementById('mic-btn');

  if (!Capture.hasVoiceSupport()) {
    UI.setMicState('no-voice');
    UI.setMicStatus('voice not supported — use text');
  } else if (!navigator.onLine) {
    UI.setMicStatus('offline — use text input');
  }

  // Update mic label whenever online/offline state changes
  window.addEventListener('online',  () => UI.setMicStatus('tap to record'));
  window.addEventListener('offline', () => UI.setMicStatus('offline — use text input'));

  micBtn.addEventListener('click', () => {
    if (!Capture.hasVoiceSupport()) return;
    if (Capture.mediaRecorder && Capture.mediaRecorder.state === 'recording') {
      Capture.stopRecording();
    } else {
      Capture.startRecording();
    }
  });

  // ── Text submit
  document.getElementById('text-submit').addEventListener('click', () => {
    Capture.saveTextNote(document.getElementById('text-input').value);
  });

  document.getElementById('text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      Capture.saveTextNote(e.target.value);
    }
  });

  // ── Type badge (capture screen)
  document.getElementById('type-badge').addEventListener('click', () => {
    document.getElementById('type-picker').classList.remove('hidden');
  });

  document.getElementById('type-picker-backdrop').addEventListener('click', () => {
    document.getElementById('type-picker').classList.add('hidden');
  });

  document.getElementById('type-picker-options').addEventListener('click', e => {
    const btn = e.target.closest('.type-opt');
    if (!btn) return;
    const val = btn.dataset.type;
    Capture.captureTypeOverride = val === 'auto' ? null : val;
    document.getElementById('type-label').textContent = val;
    document.getElementById('type-picker').classList.add('hidden');
  });

  // ── Navigation
  document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => UI.showScreen(btn.dataset.screen));
  });

  // ── Notes list: filter tabs
  document.getElementById('filter-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.filter-tab');
    if (!tab) return;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Render.currentFilter = tab.dataset.type;
    Render.renderNotesList();
  });

  // ── Notes list: search
  document.getElementById('search-input').addEventListener('input', e => {
    Render.currentSearch = e.target.value.trim();
    Render.renderNotesList();
  });

  // ── Modal actions
  document.getElementById('modal-backdrop').addEventListener('click', () => Modal.requestClose());
  document.getElementById('modal-close').addEventListener('click', () => Modal.requestClose());
  window.addEventListener('popstate', () => { if (Modal.currentId) Modal.requestClose(true); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && Modal.currentId) Modal.requestClose(); });
  document.getElementById('modal-original-toggle').addEventListener('click', e => {
    const expanded = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    e.currentTarget.setAttribute('aria-expanded', String(expanded));
    e.currentTarget.textContent = expanded ? 'Show less' : 'Show more';
    document.getElementById('modal-original-text').classList.toggle('original-collapsed', !expanded);
  });
  document.getElementById('modal-save').addEventListener('click',      () => Modal.save());
  document.getElementById('modal-reprocess')?.addEventListener('click', () => Modal.reprocess());
  document.getElementById('modal-delete').addEventListener('click',    () => Modal.delete());

  document.getElementById('context-dismiss')?.addEventListener('click', () => Modal.dismissContextQuestion());

  // Auto-save Worker URL when it changes — also retry pending notes
  document.getElementById('setting-worker-url').addEventListener('change', e => {
    Store.setWorkerUrl(e.target.value.trim());
    UI.showToast('Worker URL saved — retrying pending…');
    // Reset retry counts so notes stuck from earlier failures get another chance
    Store.getPending().forEach(id => {
      const note = Store.getNote(id);
      if (note) { note.sync.retry_count = 0; note.sync.last_error = null; Store.saveNote(note); }
    });
    Queue.drainQueue(true);
    setTimeout(() => Settings.load(), 1500);
  });

  document.querySelectorAll('.password-eye').forEach(btn => btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide passcode' : 'Show passcode');
    btn.title = show ? 'Hide passcode' : 'Show passcode';
  }));
  document.getElementById('default-prompt-panel').addEventListener('toggle', e => {
    if (e.target.open) Settings.loadDefaultPrompts();
  });
  document.getElementById('setting-transcription-save').addEventListener('click', () => {
    Store.setTranscriptionPrompt(document.getElementById('setting-transcription-prompt').value.trim());
    UI.showToast('Transcription guidance saved', 'ok');
  });
  document.getElementById('setting-transcription-reset').addEventListener('click', () => {
    localStorage.removeItem(CONFIG.KEYS.TRANSCRIPTION_PROMPT);
    document.getElementById('setting-transcription-prompt').value = Store.getTranscriptionPrompt();
    UI.showToast('Default guidance restored', 'ok');
  });

  // ── Settings actions
  document.getElementById('setting-passcode-save').addEventListener('click', () => Settings.savePasscode());
  document.getElementById('setting-retry-all').addEventListener('click', () => {
    Queue.drainQueue(true); // true = reset retry counts so stuck notes get another chance
    UI.showToast('Retrying pending notes…');
  });
  document.getElementById('setting-clear-all').addEventListener('click', () => Settings.clearAll());
  document.getElementById('setting-diagnose').addEventListener('click',   () => Diagnostics.run());

  // Prompt editor buttons (present in some versions of index.html)
  const promptSaveBtn  = document.getElementById('setting-prompt-save');
  const promptResetBtn = document.getElementById('setting-prompt-reset');
  if (promptSaveBtn)  promptSaveBtn.addEventListener('click',  () => Settings.savePrompt?.());
  if (promptResetBtn) promptResetBtn.addEventListener('click', () => {
    const ta = document.getElementById('setting-prompt');
    if (ta) ta.value = '';
    Settings.savePrompt?.();
    Settings.loadPrompt?.();
  });
}

/** Called once auth passes — start queues, update badges */
function afterUnlock() {
  UI.updatePendingBadge();
  Queue.drainQueue();
  Queue.startInterval();
}

// ── UTILS ────────────────────────────────────────────────────────

/** Escape HTML special chars to prevent XSS in innerHTML */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Simple relative time formatter */
function _relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── BOOT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
