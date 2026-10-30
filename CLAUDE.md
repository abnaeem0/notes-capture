# NoteCapture

Voice/text note capture for one person who writes and speaks English, Urdu and Roman Urdu. Notes are cleaned into English, classified, tagged, searchable, and exported to Obsidian, where the user does long-term filing, todos and search.

## Architecture
- **Frontend** (`index.html`, `app.js`, `styles.css`): static site, no build step, no dependencies. Notes live in the browser's `localStorage` (`nc_notes`); recordings in IndexedDB (`nc_audio_store`); search vectors in a disposable IndexedDB cache (`nc_search`). There is no server-side copy of notes.
- **Worker** (`worker/worker.js`): stateless Cloudflare Worker. It transcribes (Groq Whisper Large V3), cleans and classifies (Groq `openai/gpt-oss-*`), and embeds for search (Workers AI `bge-m3`). It stores nothing.
- Secrets live only in Cloudflare: `PASSCODE`, `GROQ_API_KEY`. The Workers AI binding is named `AI`. Never put keys in the repo or the frontend.
- Frontend and Worker are versioned together by `API_VERSION` (currently 2). Add response fields without bumping it; bump it only for breaking changes. Always redeploy the Worker when `worker.js` changes, or the new features silently do nothing.

## Commands
```
node tests/frontend.cjs          # app state, backup/restore, queue
node tests/markdown-export.cjs   # Obsidian export, usage tracking, copy button
node tests/worker.mjs            # transcription quality + retries
node tests/worker-usage.mjs      # model allowlist, usage reporting, urgency
node --check app.js              # quick syntax check
```
Tests mock the DOM with `vm`; there is no browser test. Check UI changes by hand on a phone.

## Conventions
- Note shape: `input` (original text, audio), `ai` (model output, never overwritten by user edits), `user` (overrides: `type_override`, `cleaned_text`, `fields`, tags), `sync`. Read through the `_getFinal*` helpers so user edits win.
- `original_text` is set once at capture and never overwritten.
- Schema changes need a migration in `migrateNotes()` and a `schema_version` bump in backups.
- New settings go through `CONFIG.KEYS`; `clearAll` wipes every key listed there.
- Groq list prices are in `CONFIG.PRICES` and are estimates. Re-check them before relying on the cost readout.

## Obsidian export (`Backup.exportMarkdown`)
- One `.md` per note in a ZIP: frontmatter (id, type, status, urgent, due/when/where, tags, source, created, updated) + English text + `## Original`.
- **Each note is exported once**, tracked by id in `nc_md_exported`, so unzipping never duplicates. After export Obsidian owns the note; later edits in the app do not flow back. "Export all again" exists but can duplicate.
- Held back until resolved: notes with an uncertain transcript (`transcription_review`; the audio only exists in the app) and notes still processing when a Worker is configured.
- Filenames are stable per note: `YYYY-MM-DD-slug-<id8>.md`. Renaming in Obsidian is fine; the `id` in frontmatter is the identity.

## Backlog (decided, not built)
1. **Waiting / who / project.** Add a `waiting` status and `who` field for handed-off tasks; add `project` (stored as an Obsidian link `[[Project]]` so renames propagate). Collapse the six types toward Note / Task / Idea with date and reminder as attributes.
2. **Personal dictionary.** Names and terms (people, places, courts, Urdu words) fed into the Whisper prompt (700 char limit) and the classifier. Lives in the app because transcription happens before notes reach Obsidian. Today only "Transcription guidance" exists.
3. **Project list.** Master list in the app, sent to the classifier like `existing_topics`, so capture can suggest a project. Obsidian is the source of truth for the notes themselves.
4. **Link suggestions at capture** using the existing `bge-m3` search index ("this looks related to X, link it?").
5. **Tone.** Tone and urgency are lost in transcription. Ideas to revisit: have the user mark urgency with one tap at capture; keep Whisper's per-segment signals; or run a prosody check on the audio (volume, pace) and pass a short hint to the classifier. Not decided.
6. **Clarification quality.** The prompt now treats urgent or high-stakes notes (court dates, "today") as needing date, time, place and person. It is untested against the live model. Test with these and adjust the prompt in `worker.js`:
   - "Court hearing next Tuesday" → should ask time and court.
   - "Have to submit the form today" → urgent; ask what form / where if unclear.
   - "Call Sarah about the budget" → no urgency; ask at most for a deadline.
   - "Maybe a blog about maintenance" → idea; no question.
7. **Obsidian automation.** The export is a manual download then unzip into the vault. FolderSync or Syncthing could watch Downloads later.

## Known limits
- Android Chrome cannot write straight into a folder, so export is download-and-unzip.
- Usage numbers are per device and include only calls that reached a Worker response.
- Roman Urdu has no fixed spelling; notes are translated to English first, and search/AI run on the English text.
