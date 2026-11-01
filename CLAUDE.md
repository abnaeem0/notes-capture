# CLAUDE.md

## About me
I'm not an experienced developer. Explain trade-offs simply, warn me before hard-to-undo changes, and push back on low-value or premature work.

## Workflow
- Read `PLAN.md` before starting any task.
- After finishing a task, check it off in `PLAN.md` with a short note on what changed and why.
- Build one small piece at a time. Do not bundle unrelated changes.
- When I make a decision, record it under **Decisions** in `PLAN.md`.
- The only docs in this repo are `CLAUDE.md` (how to work here) and `PLAN.md` (direction, decisions, to-dos, open questions, bugs). Don't add other docs.

## Rule
Use the project map below to find relevant files instead of reading the whole repo. Update the map when files are added, moved or removed.

## What this project is
NoteCapture: voice/text note capture for one person who writes and speaks English, Urdu and Roman Urdu. Notes are cleaned into English, classified, tagged and searchable.

The app is the main home for notes. Obsidian markdown is a backup to export to and occasionally import from. This direction was set on 2026-10-31 (see `PLAN.md`). The **Obsidian export** section below still describes the current, older behaviour until that work ships.

## Project map

**Frontend** (static site, no build step, no dependencies)
- `index.html`: all screens and markup.
- `styles.css`: all styles.
- `app.js`: all frontend logic, in numbered sections:
  - `CONFIG`: constants, storage keys (`CONFIG.KEYS`), prices.
  - `NoteDB` + `Store`: notes in IndexedDB with an in-memory copy (`Store.load()` at boot, `getNotes`/`saveNote`/`setNotes`), the pending queue, settings, `migrateNotes()`. `AudioStore`: recordings in IndexedDB. `Usage`: cost tracking. `Backup`: JSON backup/restore and `exportMarkdown()` (optional Obsidian copy). `BackupReminder`: last-backup line and reminder banner.
  - `Auth`: passcode gate. `Capture`: mic and text input. `Queue`: sending notes to the Worker, retries.
  - `Search`: semantic search (embeddings cached in IndexedDB `nc_search`, `cosine()` ranking) with keyword fallback.
  - `Related`: similar notes after processing, using `Search.records` vectors (`forNote(id)` → notes with scores; cut-off `MIN_SCORE`). Per-note state in `nc_related`. Actions: `link`, `unlink`, `setProject`, `copyTags`. `_getProjects()` lists project names.
  - `Render`: notes list and cards (`projectFilter` / `showProject()` for the project view). `Modal`: note detail/edit, incl. project field, linked notes and the similar-notes strip (`_renderRelated`, `relatedAction`). `Settings`, `AudioPlayer`, `Diagnostics`, `UI`: their screens and helpers.
  - `_getFinal*` helpers: read a note's final values (user edits win over AI output).

**Worker** (`worker/`)
- `worker.js`: stateless Cloudflare Worker. Routes: `/ping`, `/prompts`, `/diagnose`, `/embeddings` (Workers AI `bge-m3`), `/process` (Groq Whisper transcription, then cleaning and classification with Groq `openai/gpt-oss-*`). The built-in prompt is `DEFAULT_PROCESSING_PROMPT`.
- `wrangler.jsonc`: Worker name and the Workers AI binding `AI`.

**Tests** (`tests/`, mock the DOM with `vm`; there is no browser test)
- `frontend.cjs`: app state, backup/restore, queue.
- `markdown-export.cjs`: Obsidian export, usage tracking, copy button.
- `worker.mjs`: transcription quality and retries.
- `worker-usage.mjs`: model allowlist, usage reporting, urgency.
- `storage.cjs`: IndexedDB move and recovery cases, schema 5, backup reminder (uses a small fake IndexedDB).
- `related.cjs`: similar notes, links, projects, project view.
- `types.cjs`: three types, version 5 migration, urgency as a tag, old backups and old Worker answers.

## Architecture
- Notes live in IndexedDB (`nc_notes_db`, one record holding the whole array); `Store` keeps an in-memory copy and writes in the background (`setNotes` returns a promise; `Store.flush()` waits for all writes). The old `nc_notes` localStorage value is a frozen pre-move safety copy; `nc_notes_backend` marks the move. Without IndexedDB (tests), `Store` falls back to localStorage. Recordings are in IndexedDB (`nc_audio_store`); search vectors in a disposable IndexedDB cache (`nc_search`). There is no server-side copy of notes. One device only, by choice. The JSON full backup is the backup.
- All note reads and writes go through `Store`, so storage can move to IndexedDB, or a cloud copy can be added later, without touching callers. Don't bypass it.
- The Worker stores nothing.
- Secrets live only in Cloudflare: `PASSCODE`, `GROQ_API_KEY`. Never put keys in the repo or the frontend.
- Frontend and Worker are versioned together by `API_VERSION` (currently 2). Add response fields without bumping it; bump it only for breaking changes. The Worker deploys automatically when `main` is pushed (set up in Cloudflare), so a push updates the app and the Worker together. If the Worker version on `/ping` (`WORKER_VERSION`) doesn't change after a push, the deploy failed: check it in Cloudflare.

## Commands
```
node tests/frontend.cjs          # app state, backup/restore, queue
node tests/markdown-export.cjs   # Obsidian export, usage tracking, copy button
node tests/worker.mjs            # transcription quality + retries
node tests/worker-usage.mjs      # model allowlist, usage reporting, urgency
node tests/storage.cjs           # IndexedDB storage, recovery, backup reminder
node tests/related.cjs           # similar notes, links, projects
node tests/types.cjs             # three types, v5 migration, urgent/important tags
node --check app.js              # quick syntax check
```
Check UI changes by hand on a phone.

## Conventions
- Note shape: `input` (original text, audio), `ai` (model output, never overwritten by user edits), `user` (overrides: `type_override`, `cleaned_text`, `fields`, tags), `sync`. Read through the `_getFinal*` helpers so user edits win.
- `original_text` is set once at capture and never overwritten.
- Schema changes need a migration in `migrateNotes()`, a bump of `CONFIG.DATA_VERSION`, and a bump of `CONFIG.BACKUP_SCHEMA` (backups). Currently 5. Every note has `user.links` (note ids) and `user.project` (string or null); `normalizeNote()` fills them.
- Types are `task`, `idea`, `note` (`CONFIG.TYPES`). Old names (`todo`, `reminder`, `schedule`, `research`) are mapped by `_currentType()` / `CONFIG.LEGACY_TYPES` wherever notes come in (migration, backups, Worker answers). Task fields: `when`, `where`, `who`; Idea: `follow_up_question`. Priority is a tag (`CONFIG.FLAG_TAGS`: `urgent`, `important`); read it with `_hasTag(note, 'urgent')`, not a separate field. Version 5 keeps replaced values in `note.legacy_v4`.
- When `app.js` or `styles.css` change, bump the `?v=` tag on both in `index.html`, or phones keep the cached old copy.
- New settings go through `CONFIG.KEYS`; `clearAll` wipes every key listed there.
- Groq list prices are in `CONFIG.PRICES` and are estimates. Re-check them before relying on the cost readout.

## Obsidian export (`Backup.exportMarkdown`), optional copy
- One `.md` per note in a ZIP: frontmatter (id, type, status, urgent, important, when/where/who, tags, source, created, updated) + English text + `## Original`.
- Exporting changes nothing in the app (no archiving, no label). "Export new notes" skips ids already sent (`nc_md_exported`); "Export all again" can duplicate. The round trip (repeatable export + import) is on ice; see `PLAN.md`.
- Held back until resolved: notes with an uncertain transcript (`transcription_review`; the audio only exists in the app), notes with an unanswered AI question (answer or dismiss it in the app; the status line says how many are urgent), and notes still processing when a Worker is configured.
- Filenames are stable per note: `YYYY-MM-DD-slug-<id8>.md`. Renaming in Obsidian is fine; the `id` in frontmatter is the identity.
- Planned replacement (repeatable export, simple import with conflict notes): see **Decisions** in `PLAN.md`.

## Custom prompt
A saved custom prompt rewrites `cleaned_text` only; type, tags, urgency and questions still run from the built-in prompt. With the "Use my prompt only" box ticked (`nc_skip_classify`, sent as `classify: false`), the Worker uses the user's prompt on its own and returns a plain `note` with no summary, tags, urgency or questions. The flag is ignored when no custom prompt is saved.

## Things to be careful with
- My own edits must never be overwritten by AI results (`user.*` wins over `ai.*`).
- Notes exist only on one device. Anything that deletes, migrates or rewrites stored notes: warn me first and make sure a backup exists.
- Pushing to `main` goes live on my phone the next time I open the app. Tell me before anything is pushed.
- Never read or write the `nc_notes` localStorage key directly; go through `Store`.
- A push to `main` also redeploys the Worker. Changes to `worker.js` go live with the push, for every note processed after it.

## Known limits
- Audio is deleted from the device as soon as a transcript passes the quality checks. Only uncertain transcripts keep their recording, until you retry successfully or delete it.
- Android Chrome cannot write straight into a folder, so export is download-and-unzip.
- Usage numbers are per device and include only calls that reached a Worker response.
- Roman Urdu has no fixed spelling; notes are translated to English first, and search/AI run on the English text.
