# NoteCapture to-do

Product ideas and planned work. Instructions for Claude live in `CLAUDE.md`.

## Next
- [ ] **Waiting / who / project.** `waiting` status and `who` field for handed-off tasks. `project` stored as an Obsidian link (`[[Project]]`) so renames propagate. Collapse the six types toward Note / Task / Idea, with date and reminder as attributes.
- [ ] **Test the new clarification prompt on the live model** with real notes, and adjust `DEFAULT_PROCESSING_PROMPT` in `worker.js`:
  - "Court hearing next Tuesday" → urgent; ask the time and which court.
  - "Have to submit the form today" → urgent; ask which form / where if unclear.
  - "Call Sarah about the budget" → not urgent; at most ask for a deadline.
  - "Maybe a blog about maintenance" → idea; no question.

- [ ] **Decide what the app copy does after export.** Exported notes are labelled "In Obsidian" and archived, never deleted (the app copy allows re-export if the file format changes). Audio is already deleted for confident transcripts, so the app copy holds only text. Still open: block edits on exported notes?
- [ ] **Open in Obsidian button.** Link `obsidian://adv-uri?vault=<name>&uid=<id>` using the Advanced URI plugin, which finds a note by a frontmatter id even after it is moved or renamed. Needs: export the id as `uid` (check the plugin's frontmatter field name), a vault-name setting in the app, and the plugin installed. Verify the link opens Obsidian from Chrome on the phone. A follow-up note started from the app would go in the Inbox with a `[[link]]` to the old note, not into the same folder (the app cannot know where the old note was moved).

## Later
- [ ] **Obsidian vault setup** (not code; do on the phone). Create the vault in a normal folder such as Documents so Files can unzip into it. Make an `Inbox/` folder. Build saved views (Bases) over the frontmatter: Urgent, Due this week, Needs attention (`needs:` set or `due` empty), Waiting once that status exists. Try Smart Connections with a multilingual embedding model (bge-m3 or Gemini embeddings) for related-note suggestions. Obsidian 1.11 has official Android widgets for New Note and Daily Note.
- [ ] **Personal dictionary.** Names and terms (people, places, courts, Urdu words) fed into the Whisper prompt (700 character limit) and the classifier. Lives in the app because transcription happens before notes reach Obsidian. Today only "Transcription guidance" exists.
- [ ] **Project list in the app.** Sent to the classifier like `existing_topics` so capture can suggest a project.
- [ ] **Link suggestions at capture** using the existing `bge-m3` search index ("this looks related to X, link it?").
- [ ] **Better export to Obsidian.** Upload the `.md` files to Google Drive instead of downloading a ZIP to the phone. Needs a Google OAuth client in the browser (Worker cannot hold Drive credentials for a static page without more setup) and something on the phone that pulls the Drive folder into the vault (FolderSync, Syncthing, or a sync plugin). Compare against Obsidian Sync and a Git-based sync before choosing.
- [ ] **Bulk triage view in the app** for notes with open questions or missing dates, one screen, answer one after another.

## Maybe
- [ ] **Tone detection in the app.** Tone and urgency are lost in transcription. Options: a one-tap "urgent" at capture; keep Whisper's per-segment signals; or a prosody check on the audio (volume, pace) passed to the classifier as a short hint. Not needed now.
