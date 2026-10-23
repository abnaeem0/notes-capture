const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const values=new Map(), elements=new Map(), blobs=new Map();
function el(id){if(!elements.has(id))elements.set(id,{value:'',type:'password',textContent:'',classList:{contains:()=>false,add(){},remove(){},toggle(){}},setAttribute(k,v){this[k]=v},parentElement:{querySelector:()=>el('eye')},querySelectorAll:()=>[],focus(){}});return elements.get(id)}
const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
const context=vm.createContext({console,localStorage:storage,Blob,File,atob,btoa,crypto,URL,Intl,Date,JSON,Set,Map,Uint8Array,Number,String,Object,Array,Error,Promise,Response,Request,
 document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>el('eye'),addEventListener(){}},
 navigator:{onLine:true},window:{addEventListener(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,confirm:()=>true,location:{reload(){}},history:{state:null,back(){},pushState(){}}
});
vm.runInContext(fs.readFileSync('app.js','utf8')+`\nglobalThis.api={CONFIG,Store,AudioStore,Backup,Capture,Queue,Render,Modal,Settings,Search,UI,normalizeNote,visibleNotes,validateBackup};`,context);
const a=context.api;
a.Search.schedule=()=>{};a.Render.renderNotesList=()=>{};a.UI.showToast=()=>{};a.UI.updatePendingBadge=()=>{};a.Modal.close=()=>{};
a.AudioStore.transaction=async(mode,fn)=>{let result;const store={get:k=>{result=blobs.get(k)},put:(b,k)=>{blobs.set(k,b)},delete:k=>{blobs.delete(k)},clear:()=>blobs.clear()};fn(store);return result};
vm.runInContext(`blobToBase64 = async blob => btoa(await blob.text()); downloadBlob = (blob, name) => { globalThis.download = {blob, name}; };`,context);
function note(id,mode='text'){const n=a.Capture.makeNote(mode);n.id=id;n.input.raw_text=n.input.original_text=mode==='text'?'Call electrician':'';n.ai.type='todo';n.sync.pending=false;return a.normalizeNote(n)}
(async()=>{
 a.Store.setPasscode('saved-pass');a.Settings.load();assert.equal(el('setting-passcode').value,'saved-pass');assert.equal(el('setting-passcode').type,'password');assert.equal(a.Store.getTranscriptionPrompt(),'');
 const n=note('one');a.Store.saveNote(n);a.Modal.currentId=n.id;a.Modal.lifecycle('complete');let saved=a.Store.getNote(n.id);assert(saved.user.archived_at&&saved.user.completed_at);
 assert.equal(a.visibleNotes([saved],'active','',true).length,0);assert.equal(a.visibleNotes([saved],'active','call',true).length,1);assert.equal(a.visibleNotes([saved],'active','call',false).length,0);assert.equal(a.visibleNotes([saved],'archived','',false).length,1);
 a.Modal.lifecycle('archive');saved=a.Store.getNote(n.id);assert(!saved.user.archived_at&&saved.user.completed_at);
 const voice=note('voice','voice');voice.input.audio_blob_key='nc_audio_voice';voice.status='transcription_review';await a.AudioStore.put(voice.input.audio_blob_key,new Blob(['audio'],{type:'audio/wav'}));a.Store.saveNote(voice);
 await a.Backup.export();const backup=JSON.parse(await context.download.blob.text());assert.equal(backup.notes.length,2);assert.equal(backup.audio.length,1);assert(!JSON.stringify(backup).includes('saved-pass'));
 a.Store.setNotes([]);blobs.clear();await a.Backup.import(new File([JSON.stringify(backup)],'backup.json'));assert.equal(a.Store.getNotes().length,2);assert.equal(await(await a.AudioStore.get(a.Store.getNote('voice').input.audio_blob_key)).text(),'audio');
 const before=JSON.stringify(a.Store.getNotes());await a.Backup.import(new File([JSON.stringify(backup)],'backup.json'));assert.equal(JSON.stringify(a.Store.getNotes()),before);
 await a.Backup.import(new File(['{"schema_version":3,"notes":[{"id":"bad"}]}'],'bad.json'));assert.equal(JSON.stringify(a.Store.getNotes()),before);
 const newer=note('one');newer.updated_at='2099-01-01T00:00:00Z';newer.input.raw_text='new';await a.Backup.import(new File([JSON.stringify({schema_version:3,notes:[newer]})],'new.json'));assert.equal(a.Store.getNote('one').input.raw_text,'new');assert(a.Store.getNote('voice'));
 // Storage error rolls back staged recordings and keeps prior data.
 const oldSet=a.Store.setNotes;const beforeQuota=JSON.stringify(a.Store.getNotes()),audioCount=blobs.size;
 a.Store.setNotes=()=>{throw Error('quota')};const q=note('quota','voice');q.input.audio_blob_key='nc_audio_quota';
 await a.Backup.import(new File([JSON.stringify({schema_version:3,notes:[q],audio:[{note_id:q.id,mime_type:'audio/wav',base64:btoa('new')} ]})],'quota.json'));
 a.Store.setNotes=oldSet;assert.equal(JSON.stringify(a.Store.getNotes()),beforeQuota);assert.equal(blobs.size,audioCount);
 // Legacy migration failure leaves source intact; successful write removes it.
 const legacy=note('legacy','voice');legacy.input.audio_blob_key='nc_audio_legacy';a.Store.saveNote(legacy);storage.setItem(legacy.input.audio_blob_key,btoa('legacy audio'));
 const put=a.AudioStore.put;a.AudioStore.put=async()=>{throw Error('quota')};await assert.rejects(a.AudioStore.migrateLegacy());assert(storage.getItem(legacy.input.audio_blob_key));a.AudioStore.put=put;await a.AudioStore.migrateLegacy();assert.equal(storage.getItem(legacy.input.audio_blob_key),null);assert.equal(await(await a.AudioStore.get(legacy.input.audio_blob_key)).text(),'legacy audio');
 a.Store.setWorkerUrl('https://worker.test');let audioCalls=0;
 context.fetch=async(url,init)=>{if(url.endsWith('/ping'))return Response.json({api_version:2,transcription_quality:true});const body=JSON.parse(init.body);if(body.audio_base64)audioCalls++;return Response.json({status:'transcription_review',transcript:'uncertain words',transcription:{level:'review',reasons:['Uncertain']}})};
 const low=note('low','voice');low.input.audio_blob_key='nc_audio_low';await a.AudioStore.put(low.input.audio_blob_key,new Blob(['low']));a.Store.saveNote(low);a.Store.addPending(low.id);await a.Queue.processNote(low.id);assert.equal(a.Store.getNote(low.id).status,'transcription_review');assert(!a.Store.getPending().includes(low.id));assert(await a.AudioStore.get(low.input.audio_blob_key));await a.Queue.processNote(low.id);assert.equal(audioCalls,1);
 context.fetch=async(url,init)=>{if(url.endsWith('/ping'))return Response.json({api_version:2,transcription_quality:true});const body=JSON.parse(init.body);if(body.audio_base64)audioCalls++;return Response.json({status:'ai_failed',transcript:'clear words',transcription:{level:'high',reasons:[]},error:'model failure'})};
 const high=note('high','voice');high.input.audio_blob_key='nc_audio_high';await a.AudioStore.put(high.input.audio_blob_key,new Blob(['high']));a.Store.saveNote(high);a.Store.addPending(high.id);await a.Queue.processNote(high.id);assert.equal(a.Store.getNote(high.id).input.original_text,'clear words');assert.equal(await a.AudioStore.get(high.input.audio_blob_key),null);const count=audioCalls;await a.Queue.processNote(high.id);assert.equal(audioCalls,count);
 context.fetch=async(url)=>{if(url.endsWith('/ping'))return Response.json({api_version:2,transcription_quality:true});const n=a.Store.getNote('one');n.user.archived_at=n.user.completed_at='2026-10-23';a.Store.saveNote(n);return Response.json({status:'ok',result:{type:'todo',cleaned_text:'Call electrician',topics:[],fields:{}}})};await a.Queue.processNote('one');assert(a.Store.getNote('one').user.archived_at);
 // Review accepted via text-only reprocess keeps audio and user lifecycle.
 const reviewed=a.Store.getNote('low');reviewed.input.processing_text='Corrected words';reviewed.input.reprocess_requested=true;reviewed.status='raw';reviewed.user.archived_at='2026-10-23';a.Store.saveNote(reviewed);await a.Queue.processNote('low');assert(await a.AudioStore.get('nc_audio_low'));assert(a.Store.getNote('low').user.archived_at);
 console.log('PASS: frontend state tests with mocked DOM/storage transactions: archive/search/completion, saved passcode, full backup audio roundtrip, newer-copy merge, idempotence, invalid import, quota rollback, migration failure/success, transcription review, high-quality deletion, text-only retry, in-flight archive, reprocess keeps audio and lifecycle.');
})().catch(e=>{console.error(e);process.exitCode=1});
