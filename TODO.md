# NoteCapture to-do

Product ideas and planned work. Instructions for Claude live in `CLAUDE.md`.

## Next
- [ ] **Waiting / who / project.** `waiting` status and `who` field for handed-off tasks. `project` stored as an Obsidian link (`[[Project]]`) so renames propagate. Collapse the six types toward Note / Task / Idea, with date and reminder as attributes.
- [ ] **Mark exported notes in the app.** Show an "In Obsidian" label and optionally auto-archive on export (never delete: the app copy is the only backup with the audio, and the only place the AI can reprocess).
- [ ] **Test the new clarification prompt on the live model** with real notes, and adjust `DEFAULT_PROCESSING_PROMPT` in `worker.js`:
  - "Court hearing next Tuesday" → urgent; ask the time and which court.
  - "Have to submit the form today" → urgent; ask which form / where if unclear.
  - "Call Sarah about the budget" → not urgent; at most ask for a deadline.
  - "Maybe a blog about maintenance" → idea; no question.
- [ ] **Decide:** hold notes that still have an open question back from export (like uncertain transcripts), or export them with a `needs:` property.

## Later
- [ ] **Personal dictionary.** Names and terms (people, places, courts, Urdu words) fed into the Whisper prompt (700 character limit) and the classifier. Lives in the app because transcription happens before notes reach Obsidian. Today only "Transcription guidance" exists.
- [ ] **Project list in the app.** Sent to the classifier like `existing_topics` so capture can suggest a project.
- [ ] **Link suggestions at capture** using the existing `bge-m3` search index ("this looks related to X, link it?").
- [ ] **Better export to Obsidian.** Upload the `.md` files to Google Drive instead of downloading a ZIP to the phone. Needs a Google OAuth client in the browser (Worker cannot hold Drive credentials for a static page without more setup) and something on the phone that pulls the Drive folder into the vault (FolderSync, Syncthing, or a sync plugin). Compare against Obsidian Sync and a Git-based sync before choosing.
- [ ] **Bulk triage view in the app** for notes with open questions or missing dates, one screen, answer one after another.

## Maybe
- [ ] **Tone detection in the app.** Tone and urgency are lost in transcription. Options: a one-tap "urgent" at capture; keep Whisper's per-segment signals; or a prosody check on the audio (volume, pace) passed to the classifier as a short hint. Not needed now.
