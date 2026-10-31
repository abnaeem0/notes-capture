// Worker: model/effort allowlist, usage reporting, urgency normalisation. Run: node tests/worker-usage.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync('worker/worker.js', 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const env = { PASSCODE: 'test', GROQ_API_KEY: 'mock' };
const req = (path, body) => new Request('https://worker.test' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Passcode': 'test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ api_version: 2, note_id: 'n', ...body }) : undefined });
const good = { text: 'Hello', duration: 12.5, segments: [{ avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1, end: 12.5 }] };
let sent;
const groq = (content, usage = { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: 120 } }) =>
  async (url, init) => {
    if (url.includes('transcriptions')) return Response.json(good);
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage });
  };

// Ping advertises choices
let ping = await (await worker.fetch(req('/ping'), env)).json();
assert.deepEqual(ping.models, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
assert.equal(ping.default_model, 'openai/gpt-oss-20b');

// Valid model + effort are used; usage is reported
globalThis.fetch = groq({ type: 'schedule', cleaned_text: 'Court hearing Monday', urgency: 'URGENT', urgency_reason: 'court hearing' });
let data = await (await worker.fetch(req('/process', { raw_text: 'court monday', model: 'openai/gpt-oss-120b', reasoning_effort: 'high' }), env)).json();
assert.equal(sent.model, 'openai/gpt-oss-120b'); assert.equal(sent.reasoning_effort, 'high');
assert.equal(data.status, 'ok'); assert.equal(data.result.urgency, 'urgent'); assert.equal(data.result.urgency_reason, 'court hearing');
assert.deepEqual(data.usage, { audio_seconds: 0, model: 'openai/gpt-oss-120b', prompt_tokens: 900, completion_tokens: 300, reasoning_tokens: 120, total_tokens: 1200 });

// Unknown model / effort fall back to defaults (no arbitrary model selection)
globalThis.fetch = groq({ type: 'note', cleaned_text: 'x' });
data = await (await worker.fetch(req('/process', { raw_text: 'x', model: 'llama-expensive-405b', reasoning_effort: 'extreme' }), env)).json();
assert.equal(sent.model, 'openai/gpt-oss-20b'); assert.equal(sent.reasoning_effort, 'medium');
assert.equal(data.result.urgency, 'normal'); assert.equal(data.result.urgency_reason, null);

// A normal note cannot carry a reason; a missing urgency defaults to normal
globalThis.fetch = groq({ type: 'todo', cleaned_text: 'x', urgency: 'normal', urgency_reason: 'because' });
data = await (await worker.fetch(req('/process', { raw_text: 'x' }), env)).json();
assert.equal(data.result.urgency_reason, null);

// Audio seconds are reported with the chat usage
globalThis.fetch = groq({ type: 'note', cleaned_text: 'Hello' });
data = await (await worker.fetch(req('/process', { audio_base64: btoa('audio') }), env)).json();
assert.equal(data.usage.audio_seconds, 12.5); assert.equal(data.usage.total_tokens, 1200);

// Truncated output is billed, so usage is still returned on failure
globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 50, completion_tokens: 4096, total_tokens: 4146 } });
data = await (await worker.fetch(req('/process', { raw_text: 'x' }), env)).json();
assert.equal(data.status, 'ai_failed'); assert.equal(data.usage.completion_tokens, 4096);

// Three types: an old type name from the model is mapped; unknown types fail
globalThis.fetch = groq({ type: 'Reminder', cleaned_text: 'x' });
data = await (await worker.fetch(req('/process', { raw_text: 'x' }), env)).json();
assert.equal(data.result.type, 'task');
globalThis.fetch = groq({ type: 'research', cleaned_text: 'x' });
assert.equal((await (await worker.fetch(req('/process', { raw_text: 'x' }), env)).json()).result.type, 'idea');
globalThis.fetch = groq({ type: 'event', cleaned_text: 'x' });
assert.equal((await (await worker.fetch(req('/process', { raw_text: 'x' }), env)).json()).status, 'ai_failed');

// Prompt mentions the new schema keys
const prompts = await (await worker.fetch(req('/prompts'), env)).json();
assert(prompts.processing_prompt.includes('"urgency"') && prompts.processing_prompt.includes('court'));
assert(prompts.processing_prompt.includes(' task —') && !prompts.processing_prompt.includes(' todo —') && prompts.processing_prompt.includes('who'));
console.log('PASS: model/effort allowlist, usage reporting (tokens, reasoning, audio seconds, failures), urgency normalisation, three types, prompt schema.');
