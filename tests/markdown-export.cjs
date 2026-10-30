// Markdown/ZIP export test. Run: node tests/markdown-export.cjs [out.zip]
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const values = new Map(), elements = new Map();
function el(id) { if (!elements.has(id)) elements.set(id, { value: '', type: 'password', textContent: '', classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, setAttribute() {}, parentElement: { querySelector: () => el('eye') }, querySelectorAll: () => [], focus() {} }); return elements.get(id); }
const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
const context = vm.createContext({ console, localStorage: storage, Blob, File, atob, btoa, crypto, URL, Intl, Date, JSON, Set, Map, Uint8Array, Number, String, Object, Array, Error, Promise, Response, Request, TextEncoder, DataView, ArrayBuffer,
  document: { getElementById: el, querySelectorAll: () => [], querySelector: () => el('eye'), addEventListener() {} },
  navigator: { onLine: true }, confirm: () => true, window: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, confirm: () => true, location: { reload() {} }, history: { state: null, back() {}, pushState() {} } });
vm.runInContext(fs.readFileSync('app.js', 'utf8') + '\nglobalThis.api={Store,Backup,Capture,CONFIG,Usage,Modal,noteToMarkdown,noteFilename,buildZip,normalizeNote};', context);
const a = context.api;
vm.runInContext('downloadBlob = (blob, name) => { globalThis.download = {blob, name}; };', context);

(async () => {
  const n = a.Capture.makeNote('voice');
  n.id = 'abcd1234-ef56'; n.created_at = '2026-10-30T06:00:00.000Z'; n.input.original_text = 'Sarah se kal budget ka reply lena hai';
  Object.assign(n.ai, { type: 'reminder', cleaned_text: "Get Sarah's reply on the budget tomorrow.", summary: 'Get Sarah budget reply', topics: ['budget', 'work stuff'], fields: { action: 'Get reply', due_datetime: '2026-10-31T09:00', location: '' } });
  a.normalizeNote(n);
  const md = a.noteToMarkdown(n);
  assert(md.startsWith('---\nid: "abcd1234-ef56"\ntype: reminder\nstatus: open\n'));
  assert(md.includes('due: "2026-10-31T09:00"') && md.includes('action: "Get reply"'));
  assert(!md.includes('where:'), 'empty fields are omitted');
  assert(md.includes('tags: ["budget", "work-stuff"]'));
  assert(md.includes('# Get Sarah budget reply') && md.includes('## Original') && md.includes('Sarah se kal budget'));
  assert.equal(a.noteFilename(n), '2026-10-30-get-sarah-budget-reply-abcd1234.md');

  const u = a.Capture.makeNote('text'); u.id = 'u1'; u.input.original_text = u.input.raw_text = 'اردو note "quoted": yes'; a.normalizeNote(u);
  const md2 = a.noteToMarkdown(u);
  assert(md2.includes('type: note') && !md2.includes('## Original'), 'unprocessed note exports raw text once');
  assert(a.noteFilename(u).endsWith('-u1.md'));

  // Urgency lands in frontmatter
  n.ai.urgency = 'urgent'; n.ai.urgency_reason = 'court hearing';
  assert(a.noteToMarkdown(n).includes('urgent: true\nurgent_reason: "court hearing"'));

  // Export-once: new notes only, uncertain transcripts held back, processing notes wait (when a Worker is set)
  const review = a.Capture.makeNote('voice'); review.id = 'rev1'; review.status = 'transcription_review'; review.input.raw_text = 'maybe words'; a.normalizeNote(review);
  const proc = a.Capture.makeNote('text'); proc.id = 'proc1'; proc.status = 'processing'; proc.input.raw_text = 'still processing'; a.normalizeNote(proc);
  a.Store.setNotes([n, u, review, proc]);
  a.Store.setWorkerUrl('https://worker.test');
  const status = () => elements.get('backup-status').textContent;
  context.download = null;
  n.status = u.status = 'done'; a.Store.setNotes([n, u, review, proc]); a.Backup.exportMarkdown();
  const zip = Buffer.from(await context.download.blob.arrayBuffer());
  assert(/^notecapture-obsidian-\d{4}-\d{2}-\d{2}\.zip$/.test(context.download.name));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert(status().includes('2 new notes') && status().includes('1 with an uncertain transcript held back') && status().includes('1 still processing'), status());
  if (process.argv[2]) fs.writeFileSync(process.argv[2], zip);
  context.download = null;
  a.Backup.exportMarkdown();
  assert.equal(context.download, null, 'second export must not download again');
  assert(status().startsWith('Nothing new to export.'), status());
  a.Backup.exportMarkdown(true);
  assert(context.download, 'export all re-sends');
  // Once processing finishes the note becomes exportable and the held one stays held
  proc.status = 'done'; a.Store.saveNote(proc);
  context.download = null; a.Backup.exportMarkdown();
  assert(context.download && status().includes('1 new note.'), status());

  // Usage: recorded per day, cost from list prices, reasoning is a subset of completion tokens
  a.Usage.record({ model: 'openai/gpt-oss-20b', prompt_tokens: 1000000, completion_tokens: 1000000, reasoning_tokens: 400000, audio_seconds: 3600 });
  a.Usage.record({ model: 'openai/gpt-oss-120b', prompt_tokens: 1000000, completion_tokens: 0, audio_seconds: 0 });
  a.Usage.record({ model: 'openai/gpt-oss-20b' }); a.Usage.record(null); a.Usage.record({ prompt_tokens: -5, completion_tokens: NaN });
  const t = a.Usage.total(1);
  assert.equal(t.calls, 2); assert.equal(t.prompt, 2000000); assert.equal(t.reasoning, 400000);
  assert(Math.abs(t.cost - (0.075 + 0.30 + 0.111 + 0.15)) < 1e-9, String(t.cost));
  assert(a.Usage.describe().join(' ').includes('1,000 notes would cost'));
  values.set(a.CONFIG.KEYS.USAGE, '{not json'); assert.equal(a.Usage.total(30).calls, 0, 'corrupt usage data is tolerated');
  a.Usage.record({ prompt_tokens: 10, completion_tokens: 5, model: 'x' }); assert.equal(a.Usage.total(30).calls, 1);

  // Copy button copies the Cleaned box, including unsaved edits
  let copied = null; context.navigator.clipboard = { writeText: async v => { copied = v; } };
  el('modal-cleaned').value = '  Hello Sarah  '; await a.Modal.copyCleaned(); assert.equal(copied, 'Hello Sarah');
  copied = null; el('modal-cleaned').value = '   '; await a.Modal.copyCleaned(); assert.equal(copied, null);
  console.log('PASS: markdown export (frontmatter, urgency, filenames, unicode, zip, export-once, held-back review notes) + usage tracking + copy button');
})().catch(e => { console.error(e); process.exitCode = 1; });
