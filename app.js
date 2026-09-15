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
  },

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

  /** Wipe everything */
  clearAll() {
    Object.values(CONFIG.KEYS).forEach(k => localStorage.removeItem(k));
  },

  /** Placeholder: run any data migrations on boot */
  migrateNotes() {
    // Example: if you rename a type, transform old notes here.
    // const notes = this.getNotes();
    // this.setNotes(notes.map(n => ({ ...n, ai: { ...n.ai, type: n.ai.type === 'oldname' ? 'newname' : n.ai.type }})));
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
        original_text: '',  // ← set once at capture time, NEVER overwritten afterward
        audio_blob_key: null,
      },
      ai: {
        type: null,
        type_confidence: null,
        cleaned_text: '',
        summary: '',
        fields: {},
        topic: '',
        clarification_needed: false,
        clarification_question: null,
        clarification_answer: null,
      },
      user: {
        type_override: this.captureTypeOverride,
        topic_override: null,
        edits: {},
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
  /** Process a single note by id */
  async processNote(id) {
    const note = Store.getNote(id);
    if (!note) return;

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

    note.status = 'processing';
    Store.saveNote(note);

    try {
      // Build request body
      const body = {
        note_id: note.id,
        mode: note.input.mode,
        raw_text: note.input.raw_text || null,
        type_hint: note.user.type_override || null,
        existing_topics: _getExistingTopics(),
        clarification_answer: note.ai.clarification_answer || null,
      };

      // Attach audio if present
      if (note.input.audio_blob_key) {
        const base64 = localStorage.getItem(note.input.audio_blob_key);
        if (base64) body.audio_base64 = base64;
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

      if (data.status === 'ok' && data.result) {
        // Store transcript — but only set original_text once (first transcription)
        if (data.result.transcript) {
          note.input.raw_text = data.result.transcript;
          if (!note.input.original_text) {
            note.input.original_text = data.result.transcript; // locked after first set
          }
        }

        _applyAiResult(note, data.result);
        note.status = data.result.clarification_needed ? 'needs_context' : 'done';
        note.sync.pending = false;
        note.sync.last_error = null;

        // Clean up stored audio blob once transcribed
        if (note.input.audio_blob_key) {
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
        fresh.status = 'raw';
        fresh.sync.retry_count = (fresh.sync.retry_count || 0) + 1;
        fresh.sync.last_error = err.message;
        Store.saveNote(fresh);
      }
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
  note.ai.type               = result.type || 'note';
  note.ai.type_confidence    = result.type_confidence || 'high';
  note.ai.cleaned_text       = result.cleaned_text || note.input.raw_text;
  note.ai.summary            = result.summary || '';
  note.ai.topic              = result.topic || '';
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

/** Collect distinct topic strings from existing notes (for AI context) */
function _getExistingTopics() {
  return [...new Set(Store.getNotes().map(n => n.ai.topic).filter(Boolean))].slice(0, 20);
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
      notes = notes.filter(n => (n.user.type_override || n.ai.type) === this.currentFilter);
    }

    // Apply text search
    if (this.currentSearch) {
      const q = this.currentSearch.toLowerCase();
      notes = notes.filter(n =>
        [n.input.raw_text, n.ai.cleaned_text, n.ai.summary, n.ai.topic,
         ...Object.values(n.ai.fields || {})]
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
  const type    = note.user.type_override || note.ai.type || 'raw';
  const label   = CONFIG.TYPES.find(t => t.value === type)?.label || type;
  const topic   = note.user.topic_override || note.ai.topic || '';
  const summary = note.ai.summary || note.ai.cleaned_text || note.input.raw_text || '(no content)';
  const time    = _relativeTime(note.created_at);

  const needsCtx  = note.status === 'needs_context' ? 'needs-context' : '';
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

  open(id) {
    const note = Store.getNote(id);
    if (!note) return;
    this.currentId = id;

    const type  = note.user.type_override || note.ai.type || 'note';
    const topic = note.user.topic_override || note.ai.topic || '';

    // Populate fields
    document.getElementById('modal-type').value    = type;
    document.getElementById('modal-topic').value   = topic;
    document.getElementById('modal-cleaned').value = note.ai.cleaned_text || note.input.raw_text || '';
    document.getElementById('modal-summary').value = note.ai.summary || '';

    // Show original capture text if different from cleaned (gives user full transparency)
    const original = note.input.original_text || '';
    const cleaned  = note.ai.cleaned_text || '';
    const showOriginal = original && original !== cleaned;
    document.getElementById('modal-timestamps').textContent =
      `created ${_relativeTime(note.created_at)}  ·  updated ${_relativeTime(note.updated_at)}`
      + (showOriginal ? `\noriginal: "${original.slice(0, 120)}${original.length > 120 ? '…' : ''}"` : '');

    // Clarification banner
    const banner = document.getElementById('clarification-banner');
    if (note.ai.clarification_needed && !note.ai.clarification_answer) {
      document.getElementById('clarif-question').textContent = note.ai.clarification_question || 'Can you add more context?';
      document.getElementById('clarif-answer').value = '';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    // Audio player — show if note has a saved audio blob
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

    // Dynamic type-specific fields
    this._renderFields(note);

    // Show modal
    document.getElementById('modal-note').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  },

  close() {
    this.currentId = null;
    AudioPlayer.hide(); // stop audio when modal closes
    document.getElementById('modal-note').classList.add('hidden');
    document.body.style.overflow = '';
  },

  save() {
    const note = Store.getNote(this.currentId);
    if (!note) return;

    const selectedType = document.getElementById('modal-type').value;
    const selectedTopic = document.getElementById('modal-topic').value.trim();

    note.user.type_override  = selectedType !== note.ai.type ? selectedType : null;
    note.user.topic_override = selectedTopic !== note.ai.topic ? selectedTopic : null;
    note.ai.cleaned_text     = document.getElementById('modal-cleaned').value.trim();
    note.ai.summary          = document.getElementById('modal-summary').value.trim();

    // Collect dynamic fields
    document.querySelectorAll('#modal-fields .field-input').forEach(input => {
      note.ai.fields[input.dataset.field] = input.value.trim();
    });

    Store.saveNote(note);
    this.close();
    Render.renderNotesList();
    UI.showToast('Saved', 'ok');
  },

  delete() {
    if (!confirm('Delete this note?')) return;
    Store.deleteNote(this.currentId);
    this.close();
    Render.renderNotesList();
    UI.showToast('Deleted');
  },

  /** Submit a clarification answer and re-queue the note */
  submitClarification() {
    const note   = Store.getNote(this.currentId);
    const answer = document.getElementById('clarif-answer').value.trim();
    if (!note || !answer) return;

    note.ai.clarification_answer = answer;
    note.status    = 'raw';
    note.sync.pending = true;
    Store.saveNote(note);
    Store.addPending(note.id);

    this.close();
    Queue.processNote(note.id);
    UI.showToast('Reprocessing with context…');
  },

  /** Render dynamic fields based on the note type */
  _renderFields(note) {
    const container = document.getElementById('modal-fields');
    const type = note.user.type_override || note.ai.type || 'note';
    const fields = note.ai.fields || {};

    // Field definitions per type — add new types / fields here
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

    const checks = ['worker','auth','groq-key','groq-model','groq-whisper','gemini'];
    checks.forEach(k => {
      document.getElementById(`diag-${k}-icon`).textContent   = '○';
      document.getElementById(`diag-${k}-icon`).className     = 'diag-icon pending';
      document.getElementById(`diag-${k}-detail`).textContent = 'checking…';
    });

    // Step 1: Worker URL set?
    if (!workerUrl) {
      this._row('worker', false, 'No Worker URL — add it in Settings above');
      this._abort(['auth','groq-key','groq-model','groq-whisper','gemini']);
      this._summary(false, 'Add your Worker URL first.');
      return;
    }

    // Step 2: Worker reachable?
    try {
      const res = await fetch(`${workerUrl}/ping`, { method: 'GET' });
      if (res.status === 404) {
        this._row('worker', false, '/ping route missing — redeploy the latest worker.js');
        this._abort(['auth','groq-key','groq-model','groq-whisper','gemini']);
        this._summary(false, 'Redeploy worker.js — the /ping route is missing.');
        return;
      }
      // 401 = Worker running but no passcode header yet — that is expected here
      this._row('worker', true, `Reachable at ${workerUrl}`);
    } catch (err) {
      this._row('worker', false, `Cannot reach Worker: ${err.message}`);
      this._abort(['auth','groq-key','groq-model','groq-whisper','gemini']);
      this._summary(false, 'Check your Worker URL and that the Worker is deployed.');
      return;
    }

    // Step 3: Passcode works?
    if (!passcode) {
      this._row('auth', false, 'No passcode stored — enter it on the lock screen');
      this._abort(['groq-key','groq-model','groq-whisper','gemini']);
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
        this._abort(['groq-key','groq-model','groq-whisper','gemini']);
        this._summary(false, 'Wrong passcode. Update it in Settings or in your Cloudflare Worker variables.');
        return;
      } else {
        this._row('auth', false, `Unexpected response: HTTP ${res.status}`);
        this._abort(['groq-key','groq-model','groq-whisper','gemini']);
        return;
      }
    } catch (err) {
      this._row('auth', false, `Auth check failed: ${err.message}`);
      this._abort(['groq-key','groq-model','groq-whisper','gemini']);
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
        this._abort(['groq-model','groq-whisper','gemini']);
        this._summary(false, 'Redeploy worker.js — the /diagnose route is missing.');
        return;
      }

      const data = await res.json();
      const r    = data.results || {};

      this._row('groq-key',     r.groq_key?.ok,     r.groq_key?.detail     || '—');
      this._row('groq-model',   r.groq_model?.ok,   r.groq_model?.detail   || '—');
      this._row('groq-whisper', r.groq_whisper?.ok, r.groq_whisper?.detail || '—');
      this._row('gemini',       r.gemini?.ok,       r.gemini?.detail       || '—');

      const anyAi = r.groq_model?.ok || r.gemini?.ok;
      if (!r.groq_key?.ok) {
        this._summary(false, 'Groq API key invalid — get a new one at console.groq.com and update GROQ_API_KEY in your Worker env vars.');
      } else if (!anyAi) {
        this._summary(false, 'Both AI providers failing — notes cannot be structured. Check both API keys.');
      } else if (!r.groq_whisper?.ok) {
        this._summary(false, 'Voice transcription failing — voice notes will not process. Text notes still work.');
      } else if (!r.groq_model?.ok) {
        this._summary(false, 'Groq chat failing but Gemini fallback works — notes will be structured via Gemini.');
      } else {
        this._summary(true, 'Everything looks good. If notes still queue, hit Retry all pending.');
      }
    } catch (err) {
      this._row('groq-key',     false, `Diagnose request failed: ${err.message}`);
      this._abort(['groq-model','groq-whisper','gemini']);
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
    el.innerHTML = `${pendingIds.length} pending:<br><small style="opacity:0.7">${details.join('<br>')}</small>`;
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
  document.getElementById('modal-backdrop').addEventListener('click', () => Modal.close());
  document.getElementById('modal-save').addEventListener('click',     () => Modal.save());
  document.getElementById('modal-delete').addEventListener('click',   () => Modal.delete());
  document.getElementById('clarif-submit').addEventListener('click',  () => Modal.submitClarification());

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
