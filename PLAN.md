# NoteCapture plan

Everything that isn't instructions for Claude lives here: direction, decisions, planned work, open questions and known bugs. Instructions for Claude live in `CLAUDE.md`. When an item ships, check it off and move it to **Done** with a short note on what changed and why.

## Direction (decided 2026-10-31)
- **The app is the main home for notes.** Obsidian / markdown becomes a backup you can export to and import from, not the place notes move to.
- **One device for now.** No cloud copy of notes. Storage gets hardened locally and backed up regularly.
- **Related notes at capture.** Once a note is transcribed and cleaned, the app finds similar notes and offers to link them, reuse their project, or copy their tags.
- **Conflict handling stays simple.** Importing from Obsidian is occasional, so it needs to be safe, not clever.

## Decisions
- **Storage:** notes move from `localStorage` to IndexedDB. `Store` keeps an in-memory copy loaded at startup so reads stay synchronous; writes go to IndexedDB in the background. Ask for `navigator.storage.persist()` so the browser doesn't evict the data.
- **Cloud later stays possible.** All note access goes through `Store`, notes have stable ids and `updated_at`, and the import fingerprint (below) works for any sync. Adding a Cloudflare D1 copy later means a push/pull of changed notes by `updated_at`, ideally encrypted in the browser before upload. Nothing in this plan should bypass `Store`.
- **Links:** a link is stored as note ids in `user.links` and is never appended to the note text. The app shows links as chips on the note. On export they're written as `related: ["[[<filename>]]"]` in frontmatter, so they work in Obsidian; on import, filenames are mapped back to ids, with the frontmatter `id` as a fallback if a file was renamed.
- **Project:** a single `user.project` field, not a tag. Exported as `project: "[[Project Name]]"` so Obsidian treats it as a link. The project list is built from existing notes' projects.
- **Tags** stay as they are. "Copy tags" merges the related note's tags into this note's tags.
- **Export is repeatable.** Each export rewrites the same file per note (filenames already stable: `YYYY-MM-DD-slug-<id8>.md`). The "export once" tracking (`nc_md_exported`) and archive-after-export go away. At export, store a fingerprint of the file's contents in `sync.md_hash` and the time in `sync.md_exported_at`.
- **Import rules (simple):**
  - File has an `id` that matches an app note:
    - File unchanged since export (fingerprint matches) → skip.
    - File changed, app note not edited since export → take the file's text, tags, project and links into `user.*` (`ai.*` is never touched).
    - Both changed → keep the app version, save the Obsidian text as a new note marked "Conflict from Obsidian" with a link to the original. You merge by hand.
  - File has no `id` or an unknown `id` → new note, `source: obsidian`.
  - Import shows a summary before applying: X updated, Y new, Z conflicts.

## Next
- [ ] **Harden storage.**
  - Move notes and the pending queue to IndexedDB behind `Store`, with a one-time migration from `localStorage` (keep the old key until the IndexedDB write is confirmed, as with audio).
  - Request persistent storage; show in Settings whether it was granted.
  - Settings (passcode, Worker URL, prompts) can stay in `localStorage`.
- [ ] **Regular backups.**
  - Record the last backup time; show "Last backup: 3 days ago" in the app.
  - Nudge (a banner, not a popup) after 7 days or 20 new or changed notes since the last backup, with a one-tap backup.
  - Android Chrome can't write to a folder silently, so a backup is always a tap and a download. Desktop Chrome could write to a chosen folder later.
- [ ] **Repeatable markdown export and import** (rules above). Drop the archive and "In Obsidian" behaviour; keep the hold-backs only where they still make sense (uncertain transcript with audio, perhaps).
- [ ] **Related notes after transcription.**
  - When a note finishes processing, embed its cleaned text (one `bge-m3` call through the existing `/embeddings` route) and rank against the local `nc_search` index.
  - Show the top 3 above a similarity cut-off (tune on real notes). Nothing shows if nothing is close.
  - Each related note shows a title, a one-line snippet and two buttons: **Link** and **Use project** (only if it has one). A **⋯** opens more: **Copy tags**, **Open note**, **Link both ways**.
  - Nothing is applied automatically. Dismissing the strip hides it for that note.
  - Typed notes go through the same flow after cleaning; no live suggestions while typing for now.
- [ ] **Waiting / who / project.** `waiting` status and a `who` field for handed-off tasks. `project` as decided above. Collapse the six types toward Note / Task / Idea, with date and reminder as attributes.
- [ ] **Test the clarification prompt on the live model** with real notes and adjust `DEFAULT_PROCESSING_PROMPT` in `worker.js`:
  - "Court hearing next Tuesday" → urgent; ask the time and which court.
  - "Have to submit the form today" → urgent; ask which form / where if unclear.
  - "Call Sarah about the budget" → not urgent; at most ask for a deadline.
  - "Maybe a blog about maintenance" → idea; no question.

## Later
- [ ] **Related notes feed the classifier.** Send the top matches' tags and project with `existing_topics`, so suggested tags and project match what you already use. Needs the embedding to run before classification (one extra round trip).
- [ ] **Personal dictionary.** Names and terms (people, places, courts, Urdu words) fed into the Whisper prompt (700 character limit) and the classifier. Today only "Transcription guidance" exists.
- [ ] **Bulk triage view** for notes with open questions or missing dates: one screen, answer one after another.
- [ ] **Open in Obsidian button.** `obsidian://adv-uri?vault=<name>&uid=<id>` via the Advanced URI plugin. Less important now that the app is the main home.
- [ ] **Obsidian vault setup** (not code; do on the phone). Vault in a normal folder such as Documents so Files can unzip into it; an `Inbox/` folder; Bases views over the frontmatter (Urgent, Due this week, Needs attention, Waiting).
- [ ] **Cloud copy (optional).** D1 behind the Worker, encrypted in the browser. Only if a second device becomes necessary.

## Maybe
- [ ] **Tone detection.** Tone and urgency are lost in transcription. Options: a one-tap "urgent" at capture; Whisper's per-segment signals; or a prosody check on the audio passed to the classifier as a short hint.

## Open questions
- Should "Link" also add the reverse link on the other note by default, or only via "Link both ways"?
- Similarity cut-off for related notes: start around 0.6 for `bge-m3` and adjust once there are real notes to test on.

## Known bugs
- None recorded yet. Add them here as `- [ ] what happens — where — how to reproduce`.

## Done
- [x] 2026-10-31: Merged `TODO.md` into this file and recorded the app-is-main direction and its decisions. `CLAUDE.md` now points here.

## Superseded
- "Decide what the app copy does after export" — replaced by the app-is-main direction.
- "Better export to Obsidian via Google Drive" — parked; notes stay off the cloud for now.
- "Link suggestions at capture" and "Project list in the app" — folded into **Related notes after transcription** and **Project** above.
