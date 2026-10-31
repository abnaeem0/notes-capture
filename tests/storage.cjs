// Storage move (localStorage -> IndexedDB), schema 4 and backup reminder. Run: node tests/storage.cjs
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const code = fs.readFileSync('app.js', 'utf8') + '\nglobalThis.api={CONFIG,Store,NoteDB,Backup,BackupReminder,Capture,normalizeNote,validateBackup,UI};';

// Minimal in-memory IndexedDB: one database map shared across "app reloads".
function fakeIndexedDB(dbs, opts = {}) {
  return {
    open(name) {
      const req = {};
      setTimeout(() => {
        if (opts.failOpen) { req.error = new Error('open failed'); req.onerror?.(); return; }
        let isNew = !dbs.has(name);
        if (isNew) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          createObjectStore(s) { if (!stores.has(s)) stores.set(s, new Map()); },
          transaction(s, mode) {
            const data = stores.get(s); const tx = {};
            tx.objectStore = () => ({
              get: k => op(() => data.get(k)),
              put: (v, k) => op(() => { if (opts.failPut?.()) throw new Error('disk full'); data.set(k, v); }),
              delete: k => op(() => data.delete(k)),
              clear: () => op(() => data.clear()),
            });
            function op(fn) {
              const r = {};
              setTimeout(() => {
                try { r.result = fn(); r.onsuccess?.(); setTimeout(() => tx.oncomplete?.()); }
                catch (e) { tx.error = e; tx.onabort?.(); }
              });
              return r;
            }
            return tx;
          },
        };
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

function makeApp(local, dbs, opts = {}) {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', classList: { contains: () => false, add() {}, remove() {}, toggle(c, on) { this.hidden = on; } }, setAttribute() {}, querySelectorAll: () => [] }); return elements.get(id); };
  const storage = { getItem: k => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, String(v)), removeItem: k => local.delete(k) };
  const toasts = [];
  const context = vm.createContext({ console, localStorage: storage, indexedDB: fakeIndexedDB(dbs, opts), Blob, File, atob, btoa, crypto, URL, Intl, Date, JSON, Set, Map, Uint8Array, Number, String, Object, Array, Error, Promise, Response, Request, Math,
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => el('x'), addEventListener() {} },
    navigator: { onLine: true, storage: { persist: async () => true } }, window: { addEventListener() {} }, setTimeout, clearTimeout, setInterval: () => 0, confirm: () => true, location: { reload() {} }, history: { state: null, back() {}, pushState() {} } });
  vm.runInContext(code, context);
  const a = context.api;
  a.UI.showToast = (m, t) => toasts.push([m, t]);
  vm.runInContext('Search.schedule = () => {}; Render.renderNotesList = () => {}; blobToBase64 = async b => btoa(await b.text()); downloadBlob = (blob, name) => { globalThis.download = { blob, name }; };', context);
  return { a, toasts, el, context };
}
const idbNotes = dbs => dbs.get('nc_notes_db')?.get('kv')?.get('notes');

(async () => {
  // 1. First start on the new version moves notes to IndexedDB and keeps the old copy.
  const local = new Map(), dbs = new Map();
  const old = [
    { id: 'a', created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z', input: { raw_text: 'Call electrician' }, ai: { type: 'todo' }, user: { exported_at: '2026-10-31T07:00:00Z', archived_at: '2026-10-31T07:00:00Z' }, sync: {} },
    { id: 'b', created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', input: { raw_text: 'Old done thing' }, ai: { type: 'note' }, user: { archived_at: '2026-10-20T00:00:00Z' }, sync: {} },
  ];
  local.set('nc_notes', JSON.stringify(old)); local.set('nc_data_version', '3');
  let app = makeApp(local, dbs);
  assert.equal(await app.a.Store.load(), null);
  assert.equal(app.a.Store.backend, 'indexeddb');
  assert.equal(local.get('nc_notes_backend'), 'indexeddb');
  assert.equal(app.a.Store.persisted, true);
  app.a.Store.migrateNotes(); await app.a.Store.flush();
  const moved = JSON.parse(idbNotes(dbs));
  assert.equal(moved.find(n => n.id === 'a').user.archived_at, null, 'export-archived note comes back');
  assert.equal(moved.find(n => n.id === 'a').user.exported_at, undefined, '"In Obsidian" label removed');
  assert.equal(moved.find(n => n.id === 'b').user.archived_at, '2026-10-20T00:00:00Z', 'user-archived note stays archived');
  assert(moved.every(n => Array.isArray(n.user.links) && n.user.project === null));
  assert.equal(local.get('nc_data_version'), '5');
  assert.equal(local.get('nc_notes'), JSON.stringify(old), 'pre-move copy is left untouched');

  // 2. Saves reach IndexedDB, not localStorage.
  const n = app.a.Store.getNote('a'); n.input.raw_text = 'Call the electrician today'; app.a.Store.saveNote(n); await app.a.Store.flush();
  assert(idbNotes(dbs).includes('today')); assert(!local.get('nc_notes').includes('today')); assert(local.get('nc_notes_rev'));

  // 3. Next start reads IndexedDB.
  app = makeApp(local, dbs);
  assert.equal(await app.a.Store.load(), null);
  assert.equal(app.a.Store.getNote('a').input.raw_text, 'Call the electrician today');

  // 4. IndexedDB emptied after the move: load the kept copy and warn.
  dbs.clear(); app = makeApp(local, dbs);
  const warn = await app.a.Store.load();
  assert(warn && warn.includes('missing'), warn); assert.equal(app.a.Store.getNotes().length, 2);

  // 5. IndexedDB cannot open after the move: read-only, never writes the stale copy.
  app = makeApp(local, dbs, { failOpen: true });
  const ro = await app.a.Store.load();
  assert(app.a.Store.readOnly && ro.includes('cannot be saved'));
  assert.throws(() => app.a.Store.setNotes([]));
  assert.equal(local.get('nc_notes'), JSON.stringify(old));

  // 6. A failed write is reported and awaiting callers see it.
  let fail = false; app = makeApp(local, dbs, { failPut: () => fail });
  await app.a.Store.load();
  fail = true;
  await assert.rejects(app.a.Store.setNotes([]));
  assert(app.a.Store.writeError && app.toasts.some(([m]) => m.includes('Could not save notes')));

  // 7. Import whose write fails keeps the existing notes in memory and on disk.
  fail = false; await app.a.Store.setNotes(app.a.Store.getNotes()); // heal
  const beforeImport = idbNotes(dbs);
  const incoming = { schema_version: 4, notes: [{ id: 'c', updated_at: '2026-10-30T10:00:00Z', input: { raw_text: 'new' }, user: { links: ['a'], project: 'House move' } }] };
  fail = true;
  await app.a.Backup.import(new File([JSON.stringify(incoming)], 'b.json'));
  assert(app.el('backup-progress-step').textContent.startsWith('Restore failed; your existing notes were kept'), app.el('backup-progress-step').textContent);
  assert(app.el('backup-progress-file').textContent.startsWith('b.json'));
  assert.equal(app.a.Store.getNote('c'), null); assert.equal(idbNotes(dbs), beforeImport);
  fail = false;
  await app.a.Backup.import(new File([JSON.stringify(incoming)], 'b.json'));
  assert.deepEqual([...app.a.Store.getNote('c').user.links], ['a']); assert.equal(app.a.Store.getNote('c').user.project, 'House move');
  assert.throws(() => app.a.validateBackup({ schema_version: 4, notes: [{ id: 'x', input: {}, user: { links: [5] } }] }), /links/);
  assert.throws(() => app.a.validateBackup({ schema_version: 6, notes: [] }), /Unsupported/);

  // 8. Backup reminder.
  local.delete('nc_last_backup');
  let st = app.a.BackupReminder.state();
  assert(st.due && st.show && !st.last, 'never backed up + notes = due');
  await app.a.Backup.export();
  const backup = JSON.parse(await app.context.download.blob.text());
  assert.equal(backup.schema_version, 5); assert(local.get('nc_last_backup'));
  st = app.a.BackupReminder.state(); assert(!st.due && st.changed === 0, JSON.stringify(st));
  assert(app.a.BackupReminder.state(Date.now() + 8 * 86_400_000).due, 'due after 7 days');
  const many = app.a.Store.getNotes();
  for (let i = 0; i < 20; i++) many.push(app.a.normalizeNote({ id: `m${i}`, updated_at: new Date(Date.now() + 1000).toISOString(), input: { raw_text: 'x' } }));
  await app.a.Store.setNotes(many);
  st = app.a.BackupReminder.state(); assert(st.due && st.changed >= 20);
  app.a.BackupReminder.snooze(); assert(!app.a.BackupReminder.state().show && app.a.BackupReminder.state().due);
  app.a.BackupReminder.render();
  assert(app.el('backup-last').textContent.startsWith('Last backup'));

  // 9. Clear all wipes IndexedDB too.
  await app.a.Store.clearAll();
  assert.equal(idbNotes(dbs), undefined); assert.equal(local.get('nc_notes'), undefined);

  console.log('PASS: storage move to IndexedDB (verified copy, old copy kept, export-archived notes restored, links/project fields), reload, missing-store recovery, read-only on open failure, write-failure reporting, import rollback, schema 4 backups, backup reminder (never/7 days/20 changes/snooze), clear all.');
})().catch(e => { console.error(e); process.exitCode = 1; });
