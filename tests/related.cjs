// Similar notes after processing: matching, state, Link / Use project / Copy tags, project view. Run: node tests/related.cjs
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const code = fs.readFileSync('app.js', 'utf8') + '\nglobalThis.api={CONFIG,Store,Search,Related,Render,Modal,normalizeNote,_noteCardHTML,_getFinalTags,_getProjects,UI};';

function makeApp() {
  const local = new Map(), elements = new Map();
  const el = id => {
    if (!elements.has(id)) {
      const e = { id, value: '', textContent: '', innerHTML: '', hidden: false, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], focus() {} };
      // `hidden` here means the element has the 'hidden' class.
      e.classList = { contains: () => false, add(c) { if (c === 'hidden') e.hidden = true; }, remove(c) { if (c === 'hidden') e.hidden = false; }, toggle(c, on) { if (c === 'hidden') e.hidden = !!on; } };
      elements.set(id, e);
    }
    return elements.get(id);
  };
  const storage = { getItem: k => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, String(v)), removeItem: k => local.delete(k) };
  const toasts = [];
  // No indexedDB in this context: Store uses its localStorage fallback.
  const context = vm.createContext({ console, localStorage: storage, Blob, crypto, URL, Intl, Date, JSON, Set, Map, Number, String, Object, Array, Error, Promise, Math,
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => el('x'), addEventListener() {}, body: { style: {} }, activeElement: null },
    navigator: { onLine: true }, window: { addEventListener() {} }, setTimeout, clearTimeout, setInterval: () => 0, confirm: () => true,
    requestAnimationFrame: () => 0, history: { state: null, back() {}, pushState() {}, replaceState() {} } });
  vm.runInContext(code, context);
  const a = context.api;
  a.UI.showToast = (m, t) => toasts.push([m, t]);
  vm.runInContext('Render._real = Render.renderNotesList; BackupReminder.render = () => {}; Search.schedule = () => {}; Render.renderNotesList = () => {}; AudioPlayer.hide = () => {};', context);
  return { a, toasts, el, local };
}

const note = (id, text, extra = {}) => ({ id, created_at: `2026-10-${10 + id.charCodeAt(0) % 20}T00:00:00Z`, updated_at: '2026-10-31T00:00:00Z',
  status: 'done', input: { raw_text: text, original_text: text }, ai: { type: 'note', cleaned_text: text, summary: '', topics: extra.topics || [] },
  user: { links: [], project: extra.project || null }, sync: {}, context: [] });

const { a, toasts, el, local } = makeApp();
const { Store, Search, Related, Modal } = a;

const notes = [
  note('new', 'Call the plumber about the kitchen leak', { topics: ['house'] }),
  note('leak', 'Kitchen sink is leaking again', { topics: ['house', 'repairs'], project: 'Flat renovation' }),
  note('paint', 'Pick paint colours for bedroom', { project: 'Flat renovation' }),
  note('court', 'Court hearing next Tuesday', { topics: ['legal'] }),
  note('blog', 'Blog idea about maintenance', { topics: ['writing'] }),
].map(a.normalizeNote);
Store.setNotes(notes);

// Fake vectors: similarity to 'new' is set by the angle between them.
const vec = cos => [cos, Math.sqrt(1 - cos * cos), 0];
const index = (id, v) => Search.records.set(id, { id, model: Search.MODEL, version: Search.CACHE_VERSION, source: Search.source(Store.getNote(id)), vectors: [v] });
index('new', [1, 0, 0]);
index('leak', vec(0.82));
index('paint', vec(0.65));
index('court', [0.30, 0, Math.sqrt(1 - 0.09)]); // off in its own direction: close to nothing
index('blog', vec(0.61));

// 1. Top matches above the cut-off, best first; self and weak matches excluded.
let r = Related.forNote('new');
assert.deepEqual([...r.map(x => x.note.id)], ['leak', 'paint', 'blog']);
assert.ok(Math.abs(r[0].score - 0.82) < 1e-9);
assert.equal(Related.forNote('new', { max: 1 }).length, 1);

// 2. A stale vector (text changed since indexing) is ignored until re-indexed.
const edited = Store.getNote('blog'); edited.user.cleaned_text = 'Blog idea about plumbing maintenance'; Store.saveNote(edited);
assert.deepEqual([...Related.forNote('new').map(x => x.note.id)], ['leak', 'paint', 'blog']); // slightly old vectors still count
const n0 = Store.getNote('new'); n0.user.cleaned_text = 'Call the plumber today'; Store.saveNote(n0);
assert.equal(Related.forNote('new', { fresh: true }).length, 0); // settling a new note waits for its current text
n0.user.cleaned_text = null; Store.saveNote(n0);
index('blog', vec(0.61));

// 3. No vector for the processed text yet → it stays "new" (strip says "Looking…") until ready.
Search.records.delete('new');
Related.markNew('new');
assert.equal(Related.forNote('new').length, 0);
Related.check();
assert.equal(Related.state('new'), 'new');
Search.records.set('new', { id: 'new', source: 'raw text before cleaning', vectors: [[1, 0, 0]] }); // indexed while still raw
Related.check();
assert.equal(Related.state('new'), 'new');
index('new', [1, 0, 0]);
Related.check();
assert.equal(Related.state('new'), 'found');
assert.equal(Related.bannerId, 'new');
assert.match(el('related-banner-text').textContent, /^3 similar notes for/);
assert.match(a._noteCardHTML(Store.getNote('new')), /3 similar notes · tap to review/);

// 4. A new note with nothing close settles quietly (no banner, no card label).
Related.markNew('court');
Related.bannerId = null;
Related.check();
assert.equal(Related.state('court'), null);
assert.equal(Related.bannerId, null);
assert.doesNotMatch(a._noteCardHTML(Store.getNote('court')), /similar/);

// 5. Opening the note marks it seen (card label and banner go); the strip shows in the sheet with scores.
Related.bannerId = 'new';
Modal.open('new');
assert.equal(Related.state('new'), 'seen');
assert.equal(Related.bannerId, null);
assert.doesNotMatch(a._noteCardHTML(Store.getNote('new')), /similar/);
assert.match(el('modal-related-list').innerHTML, /82% similar · ◆ Flat renovation/);
assert.match(el('modal-related-list').innerHTML, /data-act="project">Use project/);
assert.equal(el('modal-related').hidden, false);

// 6. Link: stored on this note only; the linked note leaves the suggestions and shows as a chip.
Modal.relatedAction('link', 'leak');
assert.deepEqual([...Store.getNote('new').user.links], ['leak']);
assert.deepEqual([...Store.getNote('leak').user.links], []);
assert.ok(!Related.forNote('new').some(x => x.note.id === 'leak'));
assert.match(el('modal-links-list').innerHTML, /data-open="leak"/);
// Original text and AI output untouched.
assert.equal(Store.getNote('new').ai.cleaned_text, 'Call the plumber about the kitchen leak');
assert.equal(Store.getNote('new').input.original_text, 'Call the plumber about the kitchen leak');

// 7. Link both ways adds the reverse link too; unlink removes only this side.
Modal.relatedAction('both', 'paint');
assert.deepEqual([...Store.getNote('paint').user.links], ['new']);
Related.unlink('new', 'paint');
assert.deepEqual([...Store.getNote('new').user.links], ['leak']);
assert.deepEqual([...Store.getNote('paint').user.links], ['new']);

// 8. Use project and Copy tags; both need no unsaved edits in the sheet.
Modal.relatedAction('project', 'paint');
assert.equal(Store.getNote('new').user.project, 'Flat renovation');
assert.equal(el('modal-project').value, 'Flat renovation');
const tagsBefore = Store.getNote('new');
tagsBefore.user.tags_removed = ['repairs']; Store.saveNote(tagsBefore);
Modal.open('new');
Modal.relatedAction('tags', 'leak');
assert.deepEqual([...a._getFinalTags(Store.getNote('new'))], ['house', 'repairs']);
assert.deepEqual([...Store.getNote('new').ai.topics], ['house']); // AI tags untouched
assert.equal(el('modal-topic').value, 'house, repairs');
assert.equal(Modal.hasUnsavedChanges(), false);
assert.equal(a.Modal.relatedAction('tags', 'leak'), undefined);
assert.equal(toasts.at(-1)[0], 'No new tags to copy');
el('modal-summary').value = 'typing something';
Modal.relatedAction('project', 'leak');
assert.equal(toasts.at(-1)[0], 'Save your changes first.');
el('modal-summary').value = '';

// 9. Project typed in the sheet is saved with Save changes; empty clears it.
Modal.open('court');
el('modal-project').value = '  Court case  ';
Modal.save(false);
assert.equal(Store.getNote('court').user.project, 'Court case');
el('modal-project').value = '';
Modal.save(false);
assert.equal(Store.getNote('court').user.project, null);
assert.deepEqual([...a._getProjects()], ['Flat renovation']);

// 10. Hide dismisses the strip for that note; "Show similar notes" brings it back.
Modal.open('new');
Modal.dismissRelated();
assert.equal(Related.state('new'), 'dismissed');
assert.equal(el('modal-related').hidden, true);
assert.equal(el('modal-related-show').hidden, false);
Related.markNew('new'); // reprocessing does not undo a dismissal
assert.equal(Related.state('new'), 'dismissed');
Modal.dismissRelated(true);
assert.equal(Related.state('new'), 'seen');
assert.equal(el('modal-related').hidden, false);

// 11. Project view lists every note in the project, archived ones included.
const arch = Store.getNote('paint'); arch.user.archived_at = '2026-10-31T00:00:00Z'; Store.saveNote(arch);
a.Render.projectFilter = 'flat renovation';
a.Render._real();
const html = el('notes-list').innerHTML;
assert.match(html, /data-id="leak"/); assert.match(html, /data-id="paint"/); assert.match(html, /data-id="new"/);
assert.doesNotMatch(html, /data-id="court"|data-id="blog"/);
assert.equal(el('project-bar').hidden, false);
a.Render.projectFilter = null;
a.Render._real();
assert.doesNotMatch(el('notes-list').innerHTML, /data-id="paint"/); // archived hidden again
assert.equal(el('project-bar').hidden, true);

// 12. State for deleted notes is forgotten on the next write.
Store.deleteNote('court');
Related.setState('blog', 'seen');
assert.ok(!('court' in JSON.parse(local.get('nc_related'))));

console.log('PASS: related notes (cut-off, best-first, slightly old vectors still shown, new notes wait for a current vector, quiet when nothing close, seen/dismissed state, Link, Link both ways, unlink one side, Use project, Copy tags incl. previously removed, unsaved-edit guard, project field save/clear, project list, state cleanup).');
