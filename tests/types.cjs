// Three types (Task / Idea / Note), data version 5 migration, urgency as a tag. Run: node tests/types.cjs
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const values=new Map(), elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',classList:{contains:()=>false,add(){},remove(){},toggle(){}},setAttribute(){},querySelectorAll:()=>[],focus(){}});return elements.get(id)}
const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
const context=vm.createContext({console,localStorage:storage,Blob,File,atob,btoa,crypto,URL,Intl,Date,JSON,Set,Map,Uint8Array,Number,String,Object,Array,Error,Promise,Response,Request,
 document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>el('x'),addEventListener(){}},
 navigator:{onLine:true},window:{addEventListener(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,confirm:()=>true,location:{reload(){}},history:{state:null,back(){},pushState(){}}});
vm.runInContext(fs.readFileSync('app.js','utf8')+`\nglobalThis.api={CONFIG,Store,normalizeNote,validateBackup,_applyAiResult,_getFinalType,_getFinalFields,_getFinalTags,_hasTag,_noteCardHTML,_getExistingTopics};`,context);
const a=context.api;
const old=(id,ai,user={})=>({id,created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:00:00Z',input:{raw_text:'x'},ai:{topics:['court'],...ai},user,sync:{}});

// 1. Migration from version 4 on stored notes
storage.setItem('nc_data_version','4');
a.Store.setNotes([
  old('t1',{type:'todo',fields:{action:'Call',priority:'high'}}),
  old('t2',{type:'schedule',fields:{event_name:'Hearing',datetime:'Tue 10:00',location:'High Court'},urgency:'urgent',urgency_reason:'court hearing'}),
  old('t3',{type:'research',fields:{follow_up_question:'Which brand?'}}),
  old('t4',{type:'todo',fields:{action:'a',priority:''}},{type_override:'reminder',fields:{action:'a',due_datetime:'Friday'}}),
  old('t5',{type:'note',fields:{},urgency:'normal'},{type_override:'research'}),
]);
a.Store.migrateNotes();
assert.equal(storage.getItem('nc_data_version'),'5');
const g=id=>a.Store.getNote(id);
assert.equal(g('t1').ai.type,'task'); assert.deepEqual({...g('t1').ai.fields},{}); assert.equal(g('t1').legacy_v4.ai_type,'todo'); assert.equal(g('t1').legacy_v4.ai_fields.priority,'high');
assert.equal(g('t2').ai.type,'task'); assert.deepEqual({...g('t2').ai.fields},{when:'Tue 10:00',where:'High Court'});
assert(a._hasTag(g('t2'),'urgent')); assert(!('urgency' in g('t2').ai)); assert.equal(g('t2').ai.urgency_reason,'court hearing');
assert(a._noteCardHTML(g('t2')).includes('note-urgent-badge') && a._noteCardHTML(g('t2')).includes('class="note-topic">court'));
assert.equal(g('t3').ai.type,'idea'); assert.equal(g('t3').ai.fields.follow_up_question,'Which brand?');
assert.equal(g('t4').user.type_override,null,'todo vs reminder are both Task, so the override goes'); assert.equal(a._getFinalType(g('t4')),'task');
assert.equal(a._getFinalFields(g('t4')).when,'Friday','user-edited due date carries over'); assert.equal(g('t4').legacy_v4.type_override,'reminder');
assert.equal(a._getFinalType(g('t5')),'idea'); assert(!g('t5').legacy_v4.urgency);
// Idempotent: running normalize again changes nothing
const snap=JSON.stringify(a.Store.getNotes()); a.Store.setNotes(a.Store.getNotes().map(a.normalizeNote)); assert.equal(JSON.stringify(a.Store.getNotes()),snap);
// Removed urgent tag stays removed
const t2=g('t2'); t2.user.tags_removed=['urgent']; a.normalizeNote(t2); assert(!a._hasTag(t2,'urgent'));

// 2. Old backups (schema 4, old types) still validate and come back in the new shape
const notes=a.validateBackup({schema_version:4,notes:[old('b1',{type:'reminder',fields:{due_datetime:'today'}})]});
assert.equal(notes[0].ai.type,'task'); assert.equal(notes[0].ai.fields.when,'today');
assert.throws(()=>a.validateBackup({schema_version:4,notes:[old('b2',{type:'banana'})]}),/Unknown note type/);

// 3. AI results: new Worker and an older Worker that hasn't been redeployed
const n=a.normalizeNote(old('n1',{type:'note'}));
a._applyAiResult(n,{type:'task',cleaned_text:'Ask Ahmed for the form',topics:['forms','important'],fields:{when:'Friday',who:'Ahmed',priority:'x'},urgency:'normal'});
assert.equal(n.ai.type,'task'); assert.deepEqual({...n.ai.fields},{when:'Friday',where:'',who:'Ahmed'}); assert(a._hasTag(n,'important') && !a._hasTag(n,'urgent'));
assert(a._noteCardHTML(n).includes('note-important-badge') && a._noteCardHTML(n).includes('class="note-topic">forms'));
a._applyAiResult(n,{type:'schedule',cleaned_text:'Hearing',topics:['court'],fields:{datetime:'Mon 9',location:'Court 3'},urgency:'urgent',urgency_reason:'court'});
assert.equal(n.ai.type,'task'); assert.equal(n.ai.fields.when,'Mon 9'); assert.equal(n.ai.fields.where,'Court 3'); assert(a._hasTag(n,'urgent')); assert(!('urgency' in n.ai));
a._applyAiResult(n,{type:'research',cleaned_text:'Look into solar',topics:[]}); assert.equal(n.ai.type,'idea');
a._applyAiResult(n,{type:'nonsense',cleaned_text:'?',topics:[]}); assert.equal(n.ai.type,'note');
// A user's own type choice still wins
n.user.type_override='note'; a._applyAiResult(n,{type:'task',cleaned_text:'x',topics:[]}); assert.equal(a._getFinalType(n),'note');

// 4. Flags are not offered to the AI as topics to reuse
assert(!a._getExistingTopics().some(t=>['urgent','important'].includes(t.toLowerCase())));
assert.equal(a.CONFIG.TYPES.map(t=>t.value).join(),'task,idea,note');
console.log('PASS: three types: v4→v5 migration (types, fields, overrides, urgency→tag, legacy kept, idempotent), old backups, new and old Worker answers, user override wins, flag tags.');
