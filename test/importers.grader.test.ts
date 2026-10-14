import assert from 'node:assert/strict';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { GRADER_KEY_ENV_NAME, graderBaseUrlProblem } from '../examples/importers/shared.ts';
import { callShapeHash, EFFORTS, hashOf, validateCallShape } from '../src/index.ts';
import { mulberry32, randomInt, seedFromString } from '../src/rng.ts';
import { GRADER_CONFIG_KEYS, GRADER_DEFAULTS, GRADER_NAME, REASK_CEILING, REASK_REASONS, RECORD_SCHEMA, SENT_EFFORTS, TIMEOUT_MS_CEILING } from '../examples/importers/shared.ts';
import { startFakeEndpoint } from '../examples/importers/fake-endpoint.ts';
import type { CallShape } from '../src/index.ts';

// The recording grader and the stored-outputs provider, called the way promptfoo calls a provider:
// `new Provider(options)`, then `await provider.callApi(prompt, context, callOptions)`. The tool is not run here.
// What rests on a run of the tool (promptfoo 0.123.1): the constructor and callApi shapes,
// that a provider's options arrive as `{ id, config, env }` with the tool's own key `basePath` always in `config`,
// and that the handed prompt is the JSON text of a message list.

const require = createRequire(import.meta.url);
const GRADER_PATH = new URL('../examples/importers/promptfoo/grader-provider.cjs', import.meta.url).pathname;
const STORED_PATH = new URL('../examples/importers/promptfoo/stored-outputs-provider.cjs', import.meta.url).pathname;
const KEY = 'test-dummy-credential-0123456789';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

type Provider = { callApi(prompt: unknown, context?: unknown, options?: unknown): Promise<{ output: string; metadata: { graderEvidence: Record<string, any> } }> };
type ProviderClass = new (options: unknown) => Provider;

/** A fresh copy of the module, so its per-process state (run id, call number) starts clean in each test. */
function loadGrader(): ProviderClass {
  delete require.cache[GRADER_PATH];
  return require(GRADER_PATH) as ProviderClass;
}

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; raw: string; body: any };
type Respond = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

let seen: Seen[] = [];
let respond: Respond = okResponder();
let base = '';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw, body };
    seen.push(s);
    respond(req, res, s);
  });
});

function okResponder(over: Record<string, unknown> = {}): Respond {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test_1', type: 'message', role: 'assistant', model: 'judge-served-2026', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"pass":true,"reason":"ok"}' }], ...over }));
  };
}

const savedKey = process.env['ANTHROPIC_API_KEY'];
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['ANTHROPIC_API_KEY'] = KEY;
});
after(async () => {
  if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  seen = [];
  respond = okResponder();
});

/** The three settings a grader is never given a default for. A bound of 0 re-asks is one ask per slot. */
const STATED = { thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0 } as const;

const SYSTEM = 'You are grading "output" for a refund bot.\nUse JSON: {"pass": true}  é ✓';
const USER = 'Output: Refund granted within 30 days.\n\nRubric:\n\tThe reply follows the policy. \\ "quoted"';
const PAIR = JSON.stringify([{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }]);
const SOLO = JSON.stringify([{ role: 'user', content: USER }]);

function make(config: Record<string, unknown> = {}): Provider {
  const Grader = loadGrader();
  return new Grader({ id: 'file://grader-provider.cjs', config: { model: 'judge-requested', max_tokens: 256, baseUrl: base, ...STATED, ...config } });
}

describe('the recording grader: the whole request', () => {
  it('sends exactly the request the record describes, with a system text and a temperature of 0.7', async () => {
    const g = make({ temperature: 0.7 });
    const r = await g.callApi(PAIR, { vars: {} }, {});
    assert.equal(seen.length, 1);
    const s = seen[0]!;
    assert.equal(s.method, 'POST');
    assert.equal(s.url, '/v1/messages');
    assert.equal(s.headers['content-type'], 'application/json');
    assert.equal(s.headers['anthropic-version'], '2023-06-01');
    assert.equal(s.headers['x-api-key'], KEY);
    // No header of the call's own other than these three; the rest are the platform client's.
    const clientOwn = new Set(['host', 'connection', 'accept', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding', 'content-length']);
    assert.deepEqual(Object.keys(s.headers).filter((h) => !clientOwn.has(h)).sort(), ['anthropic-version', 'content-type', 'x-api-key']);
    // The body: every key and no other.
    assert.deepEqual(Object.keys(s.body).sort(), ['max_tokens', 'messages', 'model', 'system', 'temperature']);
    assert.deepEqual(s.body, { model: 'judge-requested', max_tokens: 256, temperature: 0.7, system: SYSTEM, messages: [{ role: 'user', content: USER }] });

    const rec = r.metadata.graderEvidence;
    assert.equal(rec['schema'], 'example.grader-evidence/v7');
    assert.equal(rec['requestedModel'], s.body.model);
    assert.equal(rec['promptSha256'], sha(PAIR));
    assert.deepEqual(rec['sent'], { system: sha(s.body.system), user: sha(s.body.messages[0]!.content), thinking: 'NOT_SENT', output_config: 'NOT_SENT' });
    assert.equal(rec['callShape'].endpoint, `${base}/v1/messages`);
    assert.equal(rec['callShape'].apiVersion, s.headers['anthropic-version']);
    assert.equal(rec['callShape'].maxOutputTokens, s.body.max_tokens);
    assert.equal(rec['callShape'].temperature, s.body.temperature);
    assert.equal(rec['callShape'].timeoutMs, 60000);
    assert.equal(rec['callShape'].contextPolicy, 'none');
    assert.deepEqual(rec['callShape'].extras, {});
    assert.equal(r.output, '{"pass":true,"reason":"ok"}');
    assert.equal(rec['reply'], r.output);
    assert.deepEqual(rec['contentTypes'], ['text']);
    assert.equal(rec['stopReason'], 'end_turn');
    assert.equal(rec['responseId'], 'msg_test_1');
    assert.deepEqual(Object.keys(rec).sort(), ['callId', 'callSeq', 'callShape', 'contentTypes', 'grader', 'graderRunId', 'promptSha256', 'reask', 'reply', 'requestedModel', 'responseId', 'schema', 'sent', 'servedModel', 'stopReason', 'thinkingTokens', 'usage']);
    assert.deepEqual(rec['reask'], { max: 0, earlier: [] });
    assert.equal(rec['usage'], 'ABSENT');
    assert.equal(rec['callSeq'], 1);
    assert.deepEqual(Object.keys(rec['grader']).sort(), ['language', 'name', 'runtime', 'sha256']);
    assert.equal(rec['grader'].name, 'anchorset-recording-grader');
    assert.equal(rec['grader'].language, 'js');
    assert.equal(rec['grader'].sha256, createHash('sha256').update(readFileSync(GRADER_PATH)).digest('hex'));
    assert.equal(rec['grader'].runtime, `node ${process.version}`);
  });

  it('sends no system field and no temperature when neither exists, and records NOT_SENT for both', async () => {
    const r = await make().callApi(SOLO);
    const s = seen[0]!;
    assert.deepEqual(Object.keys(s.body).sort(), ['max_tokens', 'messages', 'model']);
    assert.deepEqual(s.body.messages, [{ role: 'user', content: USER }]);
    const rec = r.metadata.graderEvidence;
    assert.deepEqual(rec['sent'], { system: 'NOT_SENT', user: sha(USER), thinking: 'NOT_SENT', output_config: 'NOT_SENT' });
    assert.equal(rec['promptSha256'], sha(SOLO));
    assert.equal(rec['callShape'].temperature, 'NOT_SENT');
  });

  it('sends a temperature of 0 (a value, not an absence)', async () => {
    const r = await make({ temperature: 0 }).callApi(SOLO);
    assert.equal(seen[0]!.body.temperature, 0);
    assert.equal(r.metadata.graderEvidence['callShape'].temperature, 0);
  });

  it('makes one request per call', async () => {
    const g = make();
    for (let i = 1; i <= 3; i++) {
      await g.callApi(SOLO);
      assert.equal(seen.length, i);
    }
  });

  it('records the served model as the response field when it differs from the requested one, and the raw stop word', async () => {
    respond = okResponder({ model: 'judge-served-other', stop_reason: 'max_tokens', id: 'msg_x9' });
    const rec = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.equal(rec['requestedModel'], 'judge-requested');
    assert.equal(rec['servedModel'], 'judge-served-other');
    assert.equal(rec['stopReason'], 'max_tokens');
    assert.equal(rec['responseId'], 'msg_x9');
  });

  it('concatenates text blocks in order and lists every block type in order', async () => {
    respond = okResponder({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'b' }] });
    const r = await make().callApi(SOLO);
    assert.equal(r.output, 'ab');
    assert.deepEqual(r.metadata.graderEvidence['contentTypes'], ['text', 'thinking', 'text']);
  });

  it('writes a record that survives JSON.parse(JSON.stringify()) unchanged, with no null and no undefined', async () => {
    const rec = (await make({ temperature: 0.7 }).callApi(PAIR)).metadata.graderEvidence;
    assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
    assert.ok(!JSON.stringify(rec).includes('null'));
  });

  it('writes a call shape that validates and hashes to a known value', async () => {
    const shape = (await make({ temperature: 0.7 }).callApi(PAIR)).metadata.graderEvidence['callShape'];
    assert.deepEqual(validateCallShape(shape), []);
    const expected = {
      schema: 'anchorset.callshape/v1', endpoint: `${base}/v1/messages`, apiVersion: '2023-06-01', betaFlags: 'NOT_SENT', thinkingMode: 'NOT_SENT',
      thinkingBudgetTokens: 'NOT_SENT', effort: 'NOT_SENT', toolChoice: 'NOT_SENT', toolChoiceName: 'NOT_SENT', strictTools: 'NOT_SENT',
      parallelToolUse: 'NOT_SENT', temperature: 0.7, topP: 'NOT_SENT', topK: 'NOT_SENT', frequencyPenalty: 'NOT_SENT', presencePenalty: 'NOT_SENT',
      samplingSeed: 'NOT_SENT', maxOutputTokens: 256, stopSequences: 'NOT_SENT', responseFormat: 'NOT_SENT', contextPolicy: 'none', stream: 'NOT_SENT',
      timeoutMs: 60000, extras: {},
    };
    assert.deepEqual(shape, expected);
    const h = callShapeHash(shape as CallShape);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, hashOf(expected));
  });

  it('puts the base URL path before /v1/messages, without a doubled slash', async () => {
    seen = [];
    const rec = (await make({ baseUrl: `${base}/proxy/` }).callApi(SOLO)).metadata.graderEvidence;
    assert.equal(seen[0]!.url, '/proxy/v1/messages');
    assert.equal(rec['callShape'].endpoint, `${base}/proxy/v1/messages`);
  });
});

describe('the recording grader: the message conversion', () => {
  it('sends exactly the handed texts, byte for byte, with quotes, newlines, tabs, backslashes and non-ASCII', async () => {
    const g = make();
    await g.callApi(PAIR);
    assert.equal(seen[0]!.body.system, SYSTEM);
    assert.equal(seen[0]!.body.messages[0].content, USER);
    await g.callApi(SOLO);
    assert.equal(seen[1]!.body.messages[0].content, USER);
    assert.equal('system' in seen[1]!.body, false);
  });

  const bad: [string, unknown][] = [
    ['an empty list', '[]'],
    ['three messages', JSON.stringify([{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }])],
    ['two user messages', JSON.stringify([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }])],
    ['user then system', JSON.stringify([{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }])],
    ['a lone system message', JSON.stringify([{ role: 'system', content: 'a' }])],
    ['an assistant message', JSON.stringify([{ role: 'assistant', content: 'a' }])],
    ['a list-valued content', JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'a' }] }])],
    ['an extra key on a message', JSON.stringify([{ role: 'user', content: 'a', name: 'x' }])],
    ['an empty content', JSON.stringify([{ role: 'user', content: '' }])],
    ['an empty system content', JSON.stringify([{ role: 'system', content: '' }, { role: 'user', content: 'a' }])],
    ['an object, not a list', JSON.stringify({ role: 'user', content: 'a' })],
    ['text that is not JSON', 'Grade this output.'],
    ['a handed list, not a string', [{ role: 'user', content: 'a' }]],
    ['undefined', undefined],
  ];
  for (const [name, prompt] of bad) {
    it(`throws before any request on ${name}`, async () => {
      await assert.rejects(make().callApi(prompt));
      assert.equal(seen.length, 0);
    });
  }
});

describe('thinking and effort are stated, with no default', () => {
  const forms: [string, unknown, Record<string, unknown>][] = [
    ['adaptive', { type: 'adaptive' }, { thinkingMode: 'adaptive', thinkingBudgetTokens: 'NOT_SENT' }],
    ['between_tools', { type: 'between_tools' }, { thinkingMode: 'between-tools', thinkingBudgetTokens: 'NOT_SENT' }],
    ['disabled', { type: 'disabled' }, { thinkingMode: 'off', thinkingBudgetTokens: 'NOT_SENT' }],
    ['enabled with a budget', { type: 'enabled', budget_tokens: 2048 }, { thinkingMode: 'budgeted', thinkingBudgetTokens: 2048 }],
  ];
  for (const [name, thinking, shape] of forms) {
    it(`thinking ${name}: sent verbatim as the top-level thinking key, recorded as sent, and mapped into the call shape`, async () => {
      const r = await make({ thinking }).callApi(SOLO);
      assert.deepEqual(seen[0]!.body.thinking, thinking);
      assert.deepEqual(Object.keys(seen[0]!.body).sort(), ['max_tokens', 'messages', 'model', 'thinking']);
      const rec = r.metadata.graderEvidence;
      assert.deepEqual(rec['sent'].thinking, thinking);
      assert.equal(rec['sent'].output_config, 'NOT_SENT');
      for (const [k, v] of Object.entries(shape)) assert.equal(rec['callShape'][k], v, k);
      assert.equal(rec['callShape'].effort, 'NOT_SENT');
      assert.deepEqual(validateCallShape(rec['callShape']), []);
    });
  }

  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    it(`effort ${effort}: sent as output_config, recorded as sent, and mapped into the call shape`, async () => {
      const r = await make({ effort }).callApi(SOLO);
      assert.deepEqual(seen[0]!.body.output_config, { effort });
      assert.deepEqual(Object.keys(seen[0]!.body).sort(), ['max_tokens', 'messages', 'model', 'output_config']);
      const rec = r.metadata.graderEvidence;
      assert.deepEqual(rec['sent'].output_config, { effort });
      assert.equal(rec['sent'].thinking, 'NOT_SENT');
      assert.equal(rec['callShape'].effort, effort);
      assert.equal(rec['callShape'].thinkingMode, 'NOT_SENT');
      assert.deepEqual(validateCallShape(rec['callShape']), []);
    });
  }

  it('both at once; and the call shape of a stated pair hashes differently from the unstated one', async () => {
    const both = (await make({ thinking: { type: 'adaptive' }, effort: 'high' }).callApi(SOLO)).metadata.graderEvidence;
    const none = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.deepEqual(seen[0]!.body.thinking, { type: 'adaptive' });
    assert.deepEqual(seen[0]!.body.output_config, { effort: 'high' });
    assert.notEqual(callShapeHash(both['callShape'] as CallShape), callShapeHash(none['callShape'] as CallShape));
  });

  it('NOT_SENT sends nothing: no thinking key and no output_config key, and the record says so', async () => {
    const rec = (await make({ thinking: 'NOT_SENT', effort: 'NOT_SENT' }).callApi(SOLO)).metadata.graderEvidence;
    assert.ok(!('thinking' in seen[0]!.body) && !('output_config' in seen[0]!.body));
    assert.ok(!seen[0]!.raw.includes('thinking') && !seen[0]!.raw.includes('output_config'));
    assert.deepEqual([rec['sent'].thinking, rec['sent'].output_config, rec['callShape'].thinkingMode, rec['callShape'].thinkingBudgetTokens, rec['callShape'].effort], ['NOT_SENT', 'NOT_SENT', 'NOT_SENT', 'NOT_SENT', 'NOT_SENT']);
  });

  for (const key of ['thinking', 'effort']) {
    it(`a missing ${key} refuses at construction, before any call; there is no default`, () => {
      assert.throws(() => make({ [key]: undefined }), new RegExp(`config\\.${key}`));
      assert.equal(seen.length, 0);
      const Grader = loadGrader();
      const cfg: Record<string, unknown> = { model: 'm', max_tokens: 5, baseUrl: base, ...STATED };
      delete cfg[key];
      assert.throws(() => new Grader({ config: cfg }), new RegExp(`config\\.${key}`));
    });
  }

  const badThinking: unknown[] = [
    {}, { type: 'auto' }, { type: 'between-tools' }, { type: 'off' }, { type: 'ADAPTIVE' }, { type: 'adaptive', display: 'summarized' }, { type: 'adaptive', zeta: 1 }, { type: 'disabled', typed: true }, { type: 'adaptive', budget_tokens: 1024 },
    { type: 'disabled', budget_tokens: 1024 }, { type: 'enabled' }, { type: 'enabled', budget_tokens: 0 }, { type: 'enabled', budget_tokens: -5 }, { type: 'enabled', budget_tokens: 10.5 },
    { type: 'enabled', budget_tokens: '2048' }, { type: 'enabled', budget_tokens: 2 ** 53 }, { type: 'enabled', budget_tokens: 1e300 }, { type: 'enabled', budget_tokens: 1024, extra: 1 }, { budget_tokens: 1024 }, 'adaptive', 'not_sent', 'NOT-SENT', '', null, true, 5, ['adaptive'],
  ];
  for (const thinking of badThinking) {
    it(`thinking ${JSON.stringify(thinking)} is refused at construction and nothing is sent`, () => {
      assert.throws(() => make({ thinking }), /config\.thinking/);
      assert.equal(seen.length, 0);
    });
  }
  const badEffort: unknown[] = ['minimal', 'HIGH', 'High', 'highest', '', 'none', 'not_sent', null, 3, true, { effort: 'high' }, ['high'], ' high'];
  for (const effort of badEffort) {
    it(`effort ${JSON.stringify(effort)} is refused at construction and nothing is sent`, () => {
      assert.throws(() => make({ effort }), /config\.effort/);
      assert.equal(seen.length, 0);
    });
  }
  // On this path the reading rule is stated to the importer and never to the grader: the key is not the grader's, whatever its value.
  for (const reading of ['one-json-object-boolean-pass/v1', 'one-json-object-boolean-pass-or-json-fence/v1', '', null, 1]) {
    it(`a config that holds reading ${JSON.stringify(reading)} is refused at construction as any unknown key is, and nothing is sent`, () => {
      assert.throws(() => make({ reading }), /config key "reading" is not one the grader sends/);
      assert.equal(seen.length, 0);
    });
  }

  it('the record holds no reading, whatever the reply', async () => {
    const rec = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.ok(!('reading' in rec));
  });

  it('the grader does not read the reply: a fenced reply is recorded as it came, and returned', async () => {
    const text = '```json\n{"pass":true}\n```';
    respond = okResponder({ content: [{ type: 'text', text }] });
    const r = await make().callApi(SOLO);
    assert.equal(r.output, text);
    assert.equal(r.metadata.graderEvidence['reply'], text);
  });

  it('the settings handed are not changed by the grader, and a later change of them does not change a built grader', async () => {
    const thinking = { type: 'enabled', budget_tokens: 1500 };
    const g = make({ thinking });
    thinking.budget_tokens = 9;
    await g.callApi(SOLO);
    assert.deepEqual(seen[0]!.body.thinking, { type: 'enabled', budget_tokens: 1500 });
  });
});

describe('thinking blocks, the text block as the reply, and the thinking-token counter', () => {
  const THOUGHT = 'secret reasoning that must not be recorded';
  const SIGNATURE = 'sig-abcdef0123456789';
  it('a reply with a thinking block then a text block: the reply is the text, the types are listed, no thinking text or signature is recorded', async () => {
    respond = okResponder({ content: [{ type: 'thinking', thinking: THOUGHT, signature: SIGNATURE }, { type: 'text', text: '{"pass":false,"reason":"no"}' }], usage: { input_tokens: 9, output_tokens: 40, output_tokens_details: { thinking_tokens: 17 } } });
    const r = await make().callApi(SOLO);
    assert.equal(r.output, '{"pass":false,"reason":"no"}');
    const rec = r.metadata.graderEvidence;
    assert.equal(rec['reply'], '{"pass":false,"reason":"no"}');
    assert.deepEqual(rec['contentTypes'], ['thinking', 'text']);
    assert.equal(rec['thinkingTokens'], 17);
    const all = JSON.stringify(r);
    assert.ok(!all.includes(THOUGHT) && !all.includes(SIGNATURE));
  });

  it('an empty thinking text with only a signature, and a redacted block: both give the text block as the reply', async () => {
    respond = okResponder({ content: [{ type: 'thinking', thinking: '', signature: SIGNATURE }, { type: 'text', text: 'T1' }] });
    const a = await make().callApi(SOLO);
    assert.equal(a.output, 'T1');
    assert.deepEqual(a.metadata.graderEvidence['contentTypes'], ['thinking', 'text']);
    respond = okResponder({ content: [{ type: 'redacted_thinking', data: 'REDACTED-DATA-XYZ' }, { type: 'text', text: 'T2' }] });
    const b = await make().callApi(SOLO);
    assert.equal(b.output, 'T2');
    assert.deepEqual(b.metadata.graderEvidence['contentTypes'], ['redacted_thinking', 'text']);
    assert.ok(!JSON.stringify(b).includes('REDACTED-DATA-XYZ'));
  });

  it('a thinking block with no text field, or a non-string one, does not stop the call: nothing of it is read', async () => {
    respond = okResponder({ content: [{ type: 'thinking', signature: SIGNATURE }, { type: 'text', text: 'T3' }] });
    assert.equal((await make().callApi(SOLO)).output, 'T3');
  });

  it('a block with no type, and a text block with no text, still raise and record nothing', async () => {
    respond = okResponder({ content: [{ thinking: 'x' }, { type: 'text', text: 'T' }] });
    await assert.rejects(make().callApi(SOLO), /content block has no type/);
    respond = okResponder({ content: [{ type: 'text' }] });
    await assert.rejects(make().callApi(SOLO), /text block has no text/);
  });

  it('thinkingTokens is the integer at usage.output_tokens_details.thinking_tokens, 0 included', async () => {
    respond = okResponder({ usage: { input_tokens: 9, output_tokens: 4, output_tokens_details: { thinking_tokens: 0 } } });
    assert.equal((await make().callApi(SOLO)).metadata.graderEvidence['thinkingTokens'], 0);
    respond = okResponder({ usage: { input_tokens: 9, output_tokens: 400, output_tokens_details: { thinking_tokens: 321 } } });
    assert.equal((await make().callApi(SOLO)).metadata.graderEvidence['thinkingTokens'], 321);
  });

  it('thinkingTokens is "ABSENT" when the response has no such counter (no usage, no details, details without the key)', async () => {
    for (const usage of [undefined, {}, { input_tokens: 9, output_tokens: 4 }, { output_tokens_details: {} }]) {
      respond = okResponder(usage === undefined ? {} : { usage });
      assert.equal((await make().callApi(SOLO)).metadata.graderEvidence['thinkingTokens'], 'ABSENT', JSON.stringify(usage));
    }
  });

  it('a counter that is present and is not a non-negative integer raises, and nothing is recorded as graded', async () => {
    for (const bad of [-1, 1.5, '12', null, true, {}]) {
      respond = okResponder({ usage: { input_tokens: 9, output_tokens: 4, output_tokens_details: { thinking_tokens: bad } } });
      await assert.rejects(make().callApi(SOLO), /thinking-token counter/, JSON.stringify(bad));
    }
    respond = okResponder({ usage: { output_tokens_details: 5 } });
    await assert.rejects(make().callApi(SOLO), /thinking-token counter/);
  });

  it('the reply is the text of the response\'s text blocks, joined, and the content types say how many there were', async () => {
    respond = okResponder({ content: [{ type: 'text', text: '{"pass":true,' }, { type: 'text', text: '"reason":"ok"}' }] });
    const ev = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.deepEqual([ev['contentTypes'], ev['reply']], [['text', 'text'], '{"pass":true,"reason":"ok"}']);
  });

  it('a null at any level of the counter raises the same way (usage, output_tokens_details, thinking_tokens), as does a usage that is not an object', async () => {
    for (const usage of [null, 5, 'x', [], { output_tokens_details: null }, { output_tokens_details: { thinking_tokens: null } }]) {
      respond = okResponder({ usage });
      await assert.rejects(make().callApi(SOLO), /thinking-token counter/, JSON.stringify(usage));
    }
  });

  it('the counter and the blocks are recorded and not compared: a counter with no block, and a block with a counter of 0, are both written', async () => {
    respond = okResponder({ usage: { output_tokens_details: { thinking_tokens: 33 } } });
    const a = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.deepEqual([a['contentTypes'], a['thinkingTokens']], [['text'], 33]);
    respond = okResponder({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'x' }], usage: { output_tokens_details: { thinking_tokens: 0 } } });
    const b = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.deepEqual([b['contentTypes'], b['thinkingTokens']], [['thinking', 'text'], 0]);
  });

  it('a failed call (a 400 from the provider for a setting the model does not accept) uses up its call number and records nothing', async () => {
    respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type.disabled is not supported for this model' } }));
    };
    const g = make({ thinking: { type: 'disabled' } });
    await assert.rejects(g.callApi(SOLO), /status 400/);
    respond = okResponder();
    const rec = (await g.callApi(SOLO)).metadata.graderEvidence;
    assert.equal(rec['callSeq'], 2);
  });
});

describe('the recording grader: configuration and the URL refusals', () => {
  const refusedUrls: [string, string][] = [
    ['user information', 'http://user:pass@127.0.0.1:1'],
    ['a user name alone', 'http://user@127.0.0.1:1'],
    ['a query', 'http://127.0.0.1:1/x?a=1'],
    ['an empty query', 'http://127.0.0.1:1/x?'],
    ['a fragment', 'http://127.0.0.1:1/x#frag'],
    ['plain http to a host that is not 127.0.0.1 or [::1]', 'http://example.com'],
    ['plain http to the name localhost', 'http://localhost:1'],
    ['a scheme that is not http or https', 'ftp://example.com'],
    ['a string that is not a URL', 'not a url'],
  ];
  for (const [name, baseUrl] of refusedUrls) {
    it(`throws at construction, before any call, on a base URL with ${name}`, () => {
      assert.throws(() => make({ baseUrl }), /baseUrl|grader/);
      assert.equal(seen.length, 0);
    });
  }

  it('does not put a refused URL, or any credential in it, into an error message', () => {
    try {
      make({ baseUrl: 'http://user:pass@127.0.0.1:1' });
      assert.fail('should throw');
    } catch (e) {
      assert.ok(!String((e as Error).message).includes('pass'));
    }
  });

  it('accepts https for any host at construction', () => {
    assert.doesNotThrow(() => make({ baseUrl: 'https://api.example.com' }));
  });

  it('the importers hold a base URL and the key variable in a configuration to the very rule of this file: what the grader refuses when built, they refuse, and nothing else', () => {
    const built = (config: Record<string, unknown>): boolean => {
      try {
        make(config);
        return true;
      } catch {
        return false;
      }
    };
    const urls: unknown[] = [
      ...refusedUrls.map(([, url]) => url),
      'https://api.example.com', 'https://api.example.com/', 'https://api.example.com/base//', 'HTTPS://API.EXAMPLE.COM', 'http://127.0.0.1:1', 'http://localhost:1', 'http://localhost', 'https://localhost', 'https://localhost:8443', 'http://[::1]:1', 'http://LOCALHOST:1',
      'http://127.0.0.2:1', 'http://[::2]:1', 'http://example.com:80', 'https://api.example.com/a b', ' https://api.example.com', 'https://api.example.com ', 'https://api.example.com/a@b', 'https://api.example.com\\x',
      'https://api.example.com/\t', 'https://@api.example.com', 'https://api.example.com/#', 'https://api.example.com/?', 'https:api.example.com', 'api.example.com', 'file:///etc/x', '', 0, 42, null, false, ['https://api.example.com'], {},
    ];
    for (const baseUrl of urls) assert.equal(graderBaseUrlProblem(baseUrl) === undefined, built({ baseUrl }), `baseUrl ${JSON.stringify(baseUrl)}: ${String(graderBaseUrlProblem(baseUrl))}`);
    for (const apiKeyEnv of ['JUDGE_KEY', '_K9', 'k', '9K', 'MY KEY', 'KEY-NAME', 'sk-example-0123456789-not-a-real-key', '', 7, null, false, ['K']]) {
      assert.equal(typeof apiKeyEnv === 'string' && GRADER_KEY_ENV_NAME.test(apiKeyEnv), built({ apiKeyEnv }), `apiKeyEnv ${JSON.stringify(apiKeyEnv)}`);
    }
    // A null is a value to the grader, not "not set": it refuses each of these, and so does the importers' check.
    for (const config of [{ timeoutMs: null }, { apiVersion: null }, { baseUrl: null }, { apiKeyEnv: null }, { temperature: null }]) assert.equal(built(config), false, JSON.stringify(config));
  });

  const refusedConfig: [string, Record<string, unknown>][] = [
    ['a setting it does not send (top_p)', { top_p: 0.5 }],
    ['a setting it does not send (stop_sequences)', { stop_sequences: ['x'] }],
    ['a missing model', { model: undefined }],
    ['a missing max_tokens', { max_tokens: undefined }],
    ['a fractional max_tokens', { max_tokens: 10.5 }],
    ['a temperature above 1', { temperature: 1.5 }],
    ['a temperature that is not a number', { temperature: '0.7' }],
    ['a timeout of zero', { timeoutMs: 0 }],
  ];
  for (const [name, config] of refusedConfig) {
    it(`throws at construction on ${name}`, () => {
      assert.throws(() => make(config), /grader/);
    });
  }

  it('refuses a call when the key variable is not set, and sends nothing', async () => {
    const g = make({ apiKeyEnv: 'ANCHORSET_TEST_KEY_NOT_SET' });
    await assert.rejects(g.callApi(SOLO), (e: Error) => /the key variable named in apiKeyEnv is not set/.test(e.message) && !e.message.includes('ANCHORSET_TEST_KEY_NOT_SET'));
    assert.equal(seen.length, 0);
  });

  it('an apiKeyEnv that is not a variable name (a key put there by mistake) refuses at construction and is never echoed', () => {
    for (const bad of [KEY, 'has space', '1LEADING', 'a=b', '']) {
      assert.throws(
        () => make({ apiKeyEnv: bad }),
        (e: Error) => /apiKeyEnv/.test(e.message) && (bad === '' || !e.message.includes(bad)),
        JSON.stringify(bad),
      );
    }
    assert.doesNotThrow(() => make({ apiKeyEnv: 'MY_JUDGE_KEY_2' }));
  });
});

describe('the recording grader: redirects and failures record nothing', () => {
  it('throws on a 307 and never follows it', async () => {
    respond = (req, res) => {
      if (req.url === '/v1/messages') {
        res.writeHead(307, { location: '/elsewhere' });
        res.end();
      } else {
        okResponder()(req, res, seen[0]!);
      }
    };
    await assert.rejects(make().callApi(SOLO));
    assert.equal(seen.length, 1);
    assert.equal(seen.filter((s) => s.url === '/elsewhere').length, 0);
  });

  it('throws on a 500, once, with no retry', async () => {
    respond = (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
    };
    await assert.rejects(make().callApi(SOLO), /status 500/);
    assert.equal(seen.length, 1);
  });

  it('throws on a 429, once, with no retry', async () => {
    respond = (_req, res) => {
      res.writeHead(429);
      res.end();
    };
    await assert.rejects(make().callApi(SOLO), /status 429/);
    assert.equal(seen.length, 1);
  });

  it('throws on a timeout, once, with no retry', async () => {
    respond = () => {
      /* never answers */
    };
    await assert.rejects(make({ timeoutMs: 150 }).callApi(SOLO));
    assert.equal(seen.length, 1);
  });

  it('throws when the body stalls after the headers (the deadline covers the whole call)', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    };
    await assert.rejects(make({ timeoutMs: 150 }).callApi(SOLO));
  });

  const malformed: [string, Record<string, unknown>][] = [
    ['no id', { id: undefined }],
    ['no model', { model: undefined }],
    ['no stop_reason', { stop_reason: undefined }],
    ['a null stop_reason', { stop_reason: null }],
    ['empty content', { content: [] }],
    ['a text block with no text', { content: [{ type: 'text' }] }],
  ];
  for (const [name, over] of malformed) {
    it(`throws on a response with ${name}`, async () => {
      respond = okResponder(over);
      await assert.rejects(make().callApi(SOLO));
    });
  }

  it('throws on a response that is not JSON', async () => {
    respond = (_req, res) => {
      res.writeHead(200);
      res.end('<html>');
    };
    await assert.rejects(make().callApi(SOLO));
  });

  it('gives a failed call a number, so a hole shows in the sequence', async () => {
    const g = make();
    respond = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    await assert.rejects(g.callApi(SOLO));
    respond = okResponder();
    const rec = (await g.callApi(SOLO)).metadata.graderEvidence;
    assert.equal(rec['callSeq'], 2);
  });
});

describe('the recording grader: identity, numbering and secrets', () => {
  it('writes the key nowhere in the record, and sends it only in the key header', async () => {
    const r = await make({ temperature: 0.7 }).callApi(PAIR);
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(!seen[0]!.raw.includes(KEY));
  });

  it('writes no credential-bearing URL: the endpoint is the origin plus the posted path only', async () => {
    const rec = (await make().callApi(SOLO)).metadata.graderEvidence;
    const u = new URL(rec['callShape'].endpoint);
    assert.equal(u.username + u.password + u.search + u.hash, '');
    assert.equal(u.pathname, '/v1/messages');
  });

  it('gives twenty concurrent calls the call numbers 1 to 20, each once, with one run id and distinct call ids', async () => {
    respond = (_req, res) => {
      // Answer late and out of order, so a number taken after an await would collide.
      setTimeout(() => okResponder({ id: `msg_${seen.length}_${Math.random()}` })(_req, res, seen[0]!), Math.floor(Math.random() * 40));
    };
    const g = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => g.callApi(SOLO)));
    const recs = results.map((r) => r.metadata.graderEvidence);
    assert.deepEqual(recs.map((r) => r['callSeq'] as number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(recs.map((r) => r['graderRunId'])).size, 1);
    assert.equal(new Set(recs.map((r) => r['callId'])).size, 20);
    assert.equal(seen.length, 20);
  });

  it('numbers by the order the calls were started: the first call started gets 1', async () => {
    const g = make();
    const a = g.callApi(SOLO);
    const b = g.callApi(SOLO);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.metadata.graderEvidence['callSeq'], 1);
    assert.equal(rb.metadata.graderEvidence['callSeq'], 2);
  });

  it('keeps one run id per process (two instances of one module share it) and a new one per module load', async () => {
    const Grader = loadGrader();
    const cfg = { config: { model: 'm', max_tokens: 5, baseUrl: base, ...STATED } };
    const a = (await new Grader(cfg).callApi(SOLO)).metadata.graderEvidence;
    const b = (await new Grader(cfg).callApi(SOLO)).metadata.graderEvidence;
    assert.equal(a['graderRunId'], b['graderRunId']);
    assert.deepEqual([a['callSeq'], b['callSeq']], [1, 2]);
    const c = (await make().callApi(SOLO)).metadata.graderEvidence;
    assert.notEqual(c['graderRunId'], a['graderRunId']);
  });
});

describe('the two provider files import only platform modules', () => {
  const IMPORT_FORMS = [/require\(\s*(['"`])([^'"`]*)\1\s*\)/g, /\bimport\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g, /^\s*import\s[^'"`\n]*?(['"`])([^'"`]*)\1/gm, /\bfrom\s*(['"`])([^'"`]*)\1/g];
  for (const path of [GRADER_PATH, STORED_PATH]) {
    it(`${path.split('/').pop()}: every module it loads is a node: built-in`, () => {
      const text = readFileSync(path, 'utf8');
      const specs: string[] = [];
      for (const re of IMPORT_FORMS) for (const m of text.matchAll(re)) specs.push(m[2]!);
      assert.ok(specs.length > 0, 'the file loads at least one module');
      for (const s of specs) {
        assert.ok(s.startsWith('node:'), `${s}: must use the node: prefix`);
        assert.ok(builtinModules.includes(s.slice('node:'.length)), `${s}: not a Node built-in`);
      }
      assert.ok(!/\brequire\s*\(\s*[^'"`\s)]/.test(text), 'no computed require');
      assert.ok(!/\bimport\s*\(\s*[^'"`\s)]/.test(text), 'no computed import');
    });
  }

  it('the grader file has no carriage return and ends with a newline (the line endings its hash depends on)', () => {
    const text = readFileSync(GRADER_PATH, 'utf8');
    assert.ok(!text.includes('\r'));
    assert.ok(text.endsWith('\n'));
  });

  it('.gitattributes fixes the line endings of the grader files', () => {
    const attrs = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
    assert.match(attrs, /^examples\/importers\/promptfoo\/grader-provider\.cjs text eol=lf$/m);
    assert.match(attrs, /^examples\/importers\/inspect\/recording_grader\.py text eol=lf$/m);
  });
});

describe('the stored-outputs provider', () => {
  let dir = '';
  let file = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'anchorset-stored-'));
    file = join(dir, 'stored.json');
    writeFileSync(file, JSON.stringify({ c1: 'Refund granted.', c2: 'No refund after 45 days.', c3: 7, constructor: 'x' }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function stored(config: Record<string, unknown> = { storedFile: file }): Provider {
    delete require.cache[STORED_PATH];
    const P = require(STORED_PATH) as ProviderClass;
    return new P({ id: 'file://stored-outputs-provider.cjs', config });
  }
  const call = (p: Provider, vars: unknown, repeatIndex: unknown): Promise<any> => p.callApi('ignored prompt', { vars, repeatIndex });

  it('replays the stored output and writes the draw index and the output hash into the metadata', async () => {
    const p = stored();
    const r = await call(p, { case_id: 'c2', question: 'q' }, 2);
    assert.equal(r.output, 'No refund after 45 days.');
    assert.deepEqual(r.metadata, { storedOutput: { schema: 'example.stored-output/v1', caseId: 'c2', repeatIndex: 2, outputSha256: sha('No refund after 45 days.') } });
    assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata);
    assert.equal((await call(p, { case_id: 'c1' }, 0)).metadata.storedOutput.repeatIndex, 0);
  });

  const bad: [string, unknown, unknown][] = [
    ['a missing case id', { question: 'q' }, 0],
    ['an empty case id', { case_id: '' }, 0],
    ['a numeric case id', { case_id: 1 }, 0],
    ['an id that is not in the file', { case_id: 'zz' }, 0],
    ['an id that is only on the prototype', { case_id: 'toString' }, 0],
    ['an output that is not a string', { case_id: 'c3' }, 0],
    ['a missing repeat index', { case_id: 'c1' }, undefined],
    ['a negative repeat index', { case_id: 'c1' }, -1],
    ['a fractional repeat index', { case_id: 'c1' }, 0.5],
  ];
  for (const [name, vars, idx] of bad) {
    it(`throws on ${name}`, async () => {
      await assert.rejects(call(stored(), vars, idx));
    });
  }

  it('throws at construction on an unreadable file and on an unknown config key', () => {
    assert.throws(() => stored({ storedFile: join(dir, 'missing.json') }));
    assert.throws(() => stored({ storedFile: file, other: 1 }));
  });
});

describe('the tool-shaped options: basePath, env and fresh construction', () => {
  const REAL = (config: Record<string, unknown>, env: unknown): unknown => ({ id: 'file://x.cjs', config, env });
  const GCONF = (): Record<string, unknown> => ({ model: 'judge-requested', max_tokens: 256, baseUrl: base, ...STATED });
  let dir = '';
  const savedCwd = process.cwd();
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'anchorset-basepath-'));
  });
  after(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
  });
  const storedClass = (): ProviderClass => {
    delete require.cache[STORED_PATH];
    return require(STORED_PATH) as ProviderClass;
  };

  for (const env of [undefined, {}]) {
    it(`constructs both providers from the shape the tool passes, with env ${JSON.stringify(env) ?? 'undefined'}`, () => {
      const Grader = loadGrader();
      assert.doesNotThrow(() => new Grader(REAL({ ...GCONF(), basePath: '/some/dir' }, env)));
      const Stored = storedClass();
      writeFileSync(join(dir, 'ok.json'), '{}');
      assert.doesNotThrow(() => new Stored(REAL({ storedFile: join(dir, 'ok.json'), basePath: '/some/dir' }, env)));
    });
  }

  it('never sends basePath, never records it, never puts it in the call shape', async () => {
    const Grader = loadGrader();
    const p = new Grader(REAL({ ...GCONF(), basePath: '/some/dir/UNIQUE-BASE' }, {}));
    const r = await p.callApi(PAIR, {}, {});
    assert.equal(seen.length, 1);
    assert.ok(!seen[0]!.raw.includes('basePath') && !seen[0]!.raw.includes('UNIQUE-BASE'));
    const text = JSON.stringify(r);
    assert.ok(!text.includes('basePath') && !text.includes('UNIQUE-BASE'));
    assert.ok(!('basePath' in r.metadata.graderEvidence['callShape']) && !('basePath' in r.metadata.graderEvidence['callShape']['extras']));
    assert.deepEqual(Object.keys(r.metadata.graderEvidence['callShape']['extras']), []);
  });

  for (const bad of [1, null, {}, ['x'], true]) {
    it(`refuses a basePath that is not a string (${JSON.stringify(bad)}), in both providers`, () => {
      const Grader = loadGrader();
      assert.throws(() => new Grader(REAL({ ...GCONF(), basePath: bad }, {})), /basePath/);
      const Stored = storedClass();
      assert.throws(() => new Stored(REAL({ basePath: bad }, {})), /basePath/);
    });
  }

  it('refuses a relative basePath in the stored-outputs provider: it would resolve against the working folder', () => {
    const Stored = storedClass();
    assert.throws(() => new Stored(REAL({ basePath: 'some/dir' }, {})), /absolute/);
  });

  it('the refusal of a relative basePath names the remedy, an absolute -c', () => {
    const Stored = storedClass();
    for (const rel of ['.', 'some/dir']) {
      assert.throws(() => new Stored(REAL({ basePath: rel }, {})), (e: Error) => e.message.includes('must be an absolute path: pass the config as -c "$PWD/promptfooconfig.yaml"'));
    }
  });

  it('the example config tells the user to pass an absolute -c', () => {
    const yaml = readFileSync(new URL('../examples/importers/promptfoo/promptfooconfig.yaml', import.meta.url), 'utf8');
    assert.match(yaml, /-c "\$PWD\/promptfooconfig\.yaml"/);
    assert.doesNotMatch(yaml, /-c (\.\/)?promptfooconfig/);
  });

  it('still refuses every other unknown config key, in both providers, even beside basePath', () => {
    const Grader = loadGrader();
    assert.throws(() => new Grader(REAL({ ...GCONF(), basePath: '/some/dir', topP: 0.5 }, {})), /topP/);
    const Stored = storedClass();
    assert.throws(() => new Stored(REAL({ basePath: '/some/dir', other: 1 }, {})), /other/);
  });

  it('constructed afresh for each of N calls from one loaded module, the grader gives one graderRunId and callSeq 1 to N', async () => {
    const Grader = loadGrader();
    const evs: Record<string, any>[] = [];
    for (let i = 0; i < 6; i++) {
      const p = new Grader(REAL({ ...GCONF(), basePath: '/some/dir' }, {}));
      evs.push((await p.callApi(PAIR, {}, {})).metadata.graderEvidence);
    }
    assert.equal(new Set(evs.map((e) => e['graderRunId'])).size, 1);
    assert.deepEqual(evs.map((e) => e['callSeq']), [1, 2, 3, 4, 5, 6]);
  });

  it('resolves a relative storedFile against basePath when present, never against the working folder', async () => {
    const base1 = join(dir, 'base1');
    const cwd = join(dir, 'cwd');
    mkdirSync(base1);
    mkdirSync(cwd);
    writeFileSync(join(base1, 'rel.json'), JSON.stringify({ c1: 'from-basepath' }));
    writeFileSync(join(cwd, 'rel.json'), JSON.stringify({ c1: 'from-cwd' }));
    process.chdir(cwd);
    try {
      const Stored = storedClass();
      const p = new Stored(REAL({ storedFile: 'rel.json', basePath: base1 }, {}));
      assert.equal((await p.callApi('x', { vars: { case_id: 'c1' }, repeatIndex: 0 })).output, 'from-basepath');
      // a relative file that exists only in the working folder is not found
      writeFileSync(join(cwd, 'only-cwd.json'), JSON.stringify({ c1: 'x' }));
      assert.throws(() => new Stored(REAL({ storedFile: 'only-cwd.json', basePath: base1 }, {})));
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resolves a relative storedFile against the provider\'s own folder without basePath, never against the working folder', async () => {
    const prov = join(dir, 'prov');
    const cwd = join(dir, 'cwd2');
    mkdirSync(prov);
    mkdirSync(cwd);
    const copy = join(prov, 'stored-outputs-provider.cjs');
    writeFileSync(copy, readFileSync(STORED_PATH));
    writeFileSync(join(prov, 'rel.json'), JSON.stringify({ c1: 'from-provider-folder' }));
    writeFileSync(join(cwd, 'rel.json'), JSON.stringify({ c1: 'from-cwd' }));
    writeFileSync(join(cwd, 'only-cwd.json'), JSON.stringify({ c1: 'x' }));
    process.chdir(cwd);
    try {
      delete require.cache[copy];
      const P = require(copy) as ProviderClass;
      const p = new P(REAL({ storedFile: 'rel.json' }, {}));
      assert.equal((await p.callApi('x', { vars: { case_id: 'c1' }, repeatIndex: 0 })).output, 'from-provider-folder');
      assert.throws(() => new P(REAL({ storedFile: 'only-cwd.json' }, {})));
    } finally {
      process.chdir(savedCwd);
      delete require.cache[copy];
    }
  });
});

describe('an environment switch that reroutes or weakens the request stops the grader', () => {
  const run = promisify(execFile);
  const SCRIPT = `
    const G = require(process.env.T_GRADER);
    const g = new G({ config: { model: 'm', max_tokens: 8, baseUrl: process.env.T_BASE, thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0 } });
    g.callApi(JSON.stringify([{ role: 'user', content: 'x' }])).then((r) => console.log('OK ' + r.output), (e) => console.log('ERR ' + e.message));
  `;
  const CLEAN = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'];
  async function child(env: Record<string, string>, target: string = base, execArgv: string[] = []): Promise<string> {
    const e: Record<string, string | undefined> = { ...process.env };
    for (const k of CLEAN) delete e[k];
    const r = await run(process.execPath, [...execArgv, '-e', SCRIPT], { env: { ...e, ...env, T_GRADER: GRADER_PATH, T_BASE: target, ANTHROPIC_API_KEY: KEY }, encoding: 'utf8' });
    return r.stdout.trim();
  }

  it('a disabled certificate check throws before any request', async () => {
    const out = await child({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.match(out, /^ERR grader: .*certificate/);
    assert.equal(seen.length, 0);
  });

  it('an environment proxy with a target that is not 127.0.0.1 or [::1] throws before any request', async () => {
    const out = await child({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9' }, 'https://api.example.invalid');
    assert.match(out, /^ERR grader: an environment proxy is on; the record cannot say which server answers/);
    assert.equal(seen.length, 0);
  });

  it('an environment proxy with a target at 127.0.0.1 throws unless NO_PROXY covers the host', async () => {
    for (const env of [{ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9' }, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'example.com' }]) {
      const out = await child(env);
      assert.match(out, /^ERR grader: an environment proxy is on/, JSON.stringify(env));
    }
    assert.equal(seen.length, 0);
  });

  it('an environment proxy with NO_PROXY covering 127.0.0.1 sends the one request to that host', async () => {
    const out = await child({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
    assert.equal(out, 'OK {"pass":true,"reason":"ok"}');
    assert.equal(seen.length, 1);
  });

  it('proxy variables without the switch are ignored by the platform and the grader sends as usual', async () => {
    const out = await child({ HTTP_PROXY: 'http://127.0.0.1:9' });
    assert.equal(out, 'OK {"pass":true,"reason":"ok"}');
    assert.equal(seen.length, 1);
  });

  it('the command-line switch --use-env-proxy counts as the environment switch', async (t) => {
    const out = await child({ HTTP_PROXY: 'http://127.0.0.1:9' }, base, ['--use-env-proxy']);
    if (out === '') return t.skip('this Node does not know --use-env-proxy');
    assert.match(out, /^ERR grader: an environment proxy is on/);
    assert.equal(seen.length, 0);
  });
});

describe('a response larger than the cap is refused while it streams', () => {
  it('throws on a 33 MiB body and records nothing', async () => {
    respond = (_req, res) => {
      res.on('error', () => undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(1 << 20, 97);
      let n = 0;
      const pump = (): void => {
        while (n < 33) {
          n += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    };
    await assert.rejects(make().callApi(SOLO), /larger than 32 MiB/);
  });
});

describe('the importers\' copies of the grader\'s defaults and settings equal the grader files\' own constants', () => {
  const js = readFileSync(GRADER_PATH, 'utf8');
  const py = readFileSync(new URL('../examples/importers/inspect/recording_grader.py', import.meta.url), 'utf8');
  const jsConst = (name: string): string => (js.match(new RegExp(`const ${name} = ([^;]+);`)) ?? [])[1] ?? 'MISSING';
  const pyConst = (name: string): string => (py.match(new RegExp(`^${name} = (.+)$`, 'm')) ?? [])[1] ?? 'MISSING';
  it('the JavaScript grader', () => {
    assert.equal(jsConst('DEFAULT_BASE_URL'), `'${GRADER_DEFAULTS.baseUrl}'`);
    assert.equal(jsConst('DEFAULT_API_VERSION'), `'${GRADER_DEFAULTS.apiVersion}'`);
    assert.equal(jsConst('DEFAULT_TIMEOUT_MS'), String(GRADER_DEFAULTS.timeoutMs));
    assert.equal(jsConst('GRADER_NAME'), `'${GRADER_NAME}'`);
    const keys = [...jsConst('ALLOWED_CONFIG').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(keys, [...GRADER_CONFIG_KEYS.promptfoo]);
  });
  it('the Python grader', () => {
    assert.equal(pyConst('DEFAULT_BASE_URL'), `"${GRADER_DEFAULTS.baseUrl}"`);
    assert.equal(pyConst('DEFAULT_API_VERSION'), `"${GRADER_DEFAULTS.apiVersion}"`);
    assert.equal(pyConst('DEFAULT_TIMEOUT_MS'), String(GRADER_DEFAULTS.timeoutMs));
    assert.equal(pyConst('GRADER_NAME'), `"${GRADER_NAME}"`);
    const keys = [...pyConst('ALLOWED_MODEL_ARGS').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys, [...GRADER_CONFIG_KEYS.inspect]);
  });
  it('the record schema string is one value in shared.ts and in both grader files', () => {
    assert.equal(jsConst('RECORD_SCHEMA'), `'${RECORD_SCHEMA}'`);
    assert.equal(pyConst('RECORD_SCHEMA'), `"${RECORD_SCHEMA}"`);
  });
  it('the effort list is equal across shared.ts, the JavaScript grader and the Python grader', () => {
    const jsList = (name: string): string[] => [...jsConst(name).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    const pyList = (name: string): string[] => [...pyConst(name).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    assert.deepEqual(SENT_EFFORTS, EFFORTS.filter((e) => e !== 'minimal'));
    assert.deepEqual(jsList('EFFORTS'), [...SENT_EFFORTS]);
    assert.deepEqual(pyList('EFFORTS'), [...SENT_EFFORTS]);
    assert.equal(jsConst('READINGS'), 'MISSING', 'the grader holds no list of reading rules');
  });
  it('the range and the five reasons equal the constants in both grader files', () => {
    const jsList = (name: string): string[] => [...jsConst(name).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    const pyList = (name: string): string[] => [...pyConst(name).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    assert.equal(REASK_CEILING, 3);
    assert.deepEqual([...REASK_REASONS], ['timeout', 'transport', 'server-error', 'rate-limited', 'truncated']);
    assert.equal(jsConst('MAX_REASKS_CEILING'), String(REASK_CEILING));
    assert.equal(pyConst('MAX_REASKS_CEILING'), String(REASK_CEILING));
    assert.deepEqual(jsList('REASK_REASONS'), [...REASK_REASONS]);
    assert.deepEqual(pyList('REASK_REASONS'), [...REASK_REASONS]);
    // The waits are constants of each file, and the same schedule in both: 2, 4, then 8 seconds.
    assert.equal(jsConst('REASK_WAITS_MS'), '[2000, 4000, 8000]');
    assert.equal(pyConst('REASK_WAITS_S'), '(2, 4, 8)');
    // Neither file reads a retry-after header: the server does not steer the grader.
    assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /retry-after/i);
    assert.doesNotMatch(py.replace(/^\s*#.*$/gm, ''), /retry-after/i);
  });
});

describe('the committed inputs and fixtures are pinned against a line-ending conversion', () => {
  const attrs = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  for (const line of [
    'examples/importers/*/fixtures/*.json -text',
    'examples/importers/*/bad-fixtures/*.json -text',
    'examples/importers/*/fixture-inputs/* -text',
    'examples/importers/*/cases.json -text',
    'examples/importers/*/bar.json -text',
    'examples/importers/*/plan.json -text',
    'examples/importers/FIXTURES.sha256 -text',
  ]) {
    it(line, () => assert.ok(attrs.split('\n').includes(line)));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The bounded, recorded re-ask
// ---------------------------------------------------------------------------------------------------------------

/**
 * Runs `fn` with the grader's waits between asks (2000, 4000 or 8000 ms, its own constants) cut to a millisecond, and
 * returns the waits it asked for, in order. Every other timer is left as it is.
 */
async function withShortWaits<T>(fn: () => Promise<T>): Promise<{ value: T; waits: number[] }> {
  const real = globalThis.setTimeout;
  const waits: number[] = [];
  const patched = (f: (...a: unknown[]) => void, ms?: number, ...a: unknown[]): unknown => {
    if (ms === 2000 || ms === 4000 || ms === 8000) {
      waits.push(ms);
      return real(f, 1, ...a);
    }
    return real(f, ms, ...a);
  };
  (globalThis as { setTimeout: unknown }).setTimeout = patched;
  try {
    return { value: await fn(), waits };
  } finally {
    globalThis.setTimeout = real;
  }
}

/** The error a call is rejected with. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  return assert.fail('the call did not throw');
}

/** A responder that answers the first `n` requests with `first` and every later one as a clean reply. */
function firstThen(n: number, first: Respond, over: Record<string, unknown> = {}): Respond {
  return (req, res, s) => (seen.length <= n ? first(req, res, s) : okResponder({ id: `msg_test_${seen.length}`, ...over })(req, res, s));
}
const statusResponder = (status: number, headers: Record<string, string> = {}): Respond => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type: 'some_error', message: `SECRET-BODY-TEXT ${status}` } }));
};
const cutResponder = (over: Record<string, unknown> = {}): Respond => (req, res, s) =>
  okResponder({ id: `msg_cut_${seen.length}`, stop_reason: 'max_tokens', content: [{ type: 'text', text: 'CUT-REPLY-TEXT {"pa' }], usage: { input_tokens: 31, output_tokens: 256, output_tokens_details: { thinking_tokens: 7 } }, ...over })(req, res, s);

describe('the bound is stated: maxReasks, an integer from 0 to 3, with no default', () => {
  it('maxReasks is required: a config without it throws before any request', async () => {
    assert.throws(() => make({ maxReasks: undefined }), /grader: config\.maxReasks is required \(no default\)/);
    const Grader = loadGrader();
    assert.throws(() => new Grader({ config: { model: 'm', max_tokens: 5, baseUrl: base, thinking: 'NOT_SENT', effort: 'NOT_SENT' } }), /maxReasks is required/);
    assert.equal(seen.length, 0);
  });

  it('maxReasks of -1, 4, 1.5, "2" or null throws before any request', () => {
    for (const bad of [-1, 4, 1.5, '2', null, true, [1], {}, Number.NaN, Infinity, '', '0', 100]) {
      assert.throws(() => make({ maxReasks: bad }), /grader: config\.maxReasks must be an integer from 0 to 3/, JSON.stringify(bad) ?? String(bad));
    }
    for (const good of [0, 1, 2, 3]) assert.doesNotThrow(() => make({ maxReasks: good }));
    assert.equal(seen.length, 0);
  });

  it('the bound is in the record of every slot, and nowhere in the request or the call shape', async () => {
    for (const max of [0, 1, 2, 3]) {
      seen = [];
      const rec = (await make({ maxReasks: max }).callApi(SOLO)).metadata.graderEvidence;
      assert.deepEqual(rec['reask'], { max, earlier: [] });
      assert.ok(!seen[0]!.raw.includes('maxReasks') && !seen[0]!.raw.includes('reask'));
      assert.ok(!JSON.stringify(rec['callShape']).includes('easks'));
      assert.deepEqual(rec['callShape'].extras, {});
    }
  });
});

describe('a slot is asked again only on the five conditions', () => {
  it('a finished reply is asked once under maxReasks 3', async () => {
    const rec = (await make({ maxReasks: 3 }).callApi(SOLO)).metadata.graderEvidence;
    assert.equal(seen.length, 1);
    assert.deepEqual(rec['reask'], { max: 3, earlier: [] });
    assert.equal(rec['callSeq'], 1);
  });

  it('a cut reply is asked again with the same bytes', async () => {
    respond = firstThen(1, cutResponder(), { usage: { input_tokens: 31, output_tokens: 12 } });
    const g = make({ maxReasks: 2, temperature: 0 });
    const { value: r, waits } = await withShortWaits(() => g.callApi(PAIR));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.raw, seen[1]!.raw);
    assert.deepEqual(waits, [], 'no wait after a cut reply');
    for (const h of ['content-type', 'anthropic-version', 'x-api-key', 'content-length']) assert.equal(seen[0]!.headers[h], seen[1]!.headers[h], h);
    const rec = r.metadata.graderEvidence;
    assert.equal(rec['stopReason'], 'end_turn');
    assert.equal(rec['responseId'], 'msg_test_2');
    assert.equal(r.output, '{"pass":true,"reason":"ok"}');
    assert.deepEqual(rec['usage'], { input_tokens: 31, output_tokens: 12 });
    assert.equal(rec['reask'].max, 2);
    assert.equal(rec['reask'].earlier.length, 1);
    const e = rec['reask'].earlier[0];
    assert.deepEqual(Object.keys(e), ['reason', 'callSeq', 'callId', 'httpStatus', 'responseId', 'servedModel', 'stopReason', 'contentTypes', 'thinkingTokens', 'usage', 'replySha256', 'replyUtf8Bytes']);
    assert.deepEqual({ ...e, callId: '' }, { reason: 'truncated', callSeq: 1, callId: '', httpStatus: 200, responseId: 'msg_cut_1', servedModel: 'judge-served-2026', stopReason: 'max_tokens', contentTypes: ['text'], thinkingTokens: 7, usage: { input_tokens: 31, output_tokens: 256 }, replySha256: sha('CUT-REPLY-TEXT {"pa'), replyUtf8Bytes: 19 });
    // Two consecutive call numbers and two call ids.
    assert.deepEqual([e.callSeq, rec['callSeq']], [1, 2]);
    assert.match(e.callId, /^[0-9a-f-]{36}$/);
    assert.notEqual(e.callId, rec['callId']);
    // The cut reply's text is recorded nowhere.
    assert.ok(!JSON.stringify(r).includes('CUT-REPLY-TEXT'));
    // One prompt, one sent block and one call shape for the slot.
    assert.equal(rec['promptSha256'], sha(PAIR));
  });

  it('a 529 is asked again', async () => {
    respond = firstThen(1, statusResponder(529));
    const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.raw, seen[1]!.raw);
    assert.deepEqual(waits, [2000]);
    const rec = r.metadata.graderEvidence;
    assert.equal(rec['stopReason'], 'end_turn');
    assert.deepEqual(Object.keys(rec['reask'].earlier[0]), ['reason', 'callSeq', 'callId', 'httpStatus', 'detail']);
    assert.deepEqual({ ...rec['reask'].earlier[0], callId: '' }, { reason: 'server-error', callSeq: 1, callId: '', httpStatus: 529, detail: 'the endpoint answered status 529' });
    assert.equal(rec['callSeq'], 2);
    // The body of an error response is not recorded.
    assert.ok(!JSON.stringify(r).includes('SECRET-BODY-TEXT'));
  });

  it('every status from 500 to 599 is a server error, and 499 and 600 are not', async () => {
    for (const status of [500, 502, 503, 529, 599]) {
      seen = [];
      respond = firstThen(1, statusResponder(status));
      const { value: r } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
      assert.deepEqual([r.metadata.graderEvidence['reask'].earlier[0].reason, r.metadata.graderEvidence['reask'].earlier[0].httpStatus], ['server-error', status]);
    }
    for (const status of [499, 600]) {
      seen = [];
      respond = firstThen(1, statusResponder(status));
      const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.match(e.message, new RegExp(`status ${status}`));
      assert.equal(seen.length, 1, String(status));
    }
  });

  it('a 429 is asked again', async () => {
    // A retry-after header is not read: the wait is the grader's own constant.
    respond = firstThen(1, statusResponder(429, { 'retry-after': '120' }));
    const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, [2000]);
    assert.deepEqual({ ...r.metadata.graderEvidence['reask'].earlier[0], callId: '' }, { reason: 'rate-limited', callSeq: 1, callId: '', httpStatus: 429, detail: 'the endpoint answered status 429' });
  });

  it('a passed deadline is asked again', async () => {
    respond = firstThen(1, () => {
      /* never answers */
    });
    const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 1, timeoutMs: 150 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.raw, seen[1]!.raw);
    assert.deepEqual(waits, [2000]);
    assert.deepEqual({ ...r.metadata.graderEvidence['reask'].earlier[0], callId: '' }, { reason: 'timeout', callSeq: 1, callId: '', httpStatus: 'NO_RESPONSE', detail: 'the call passed its deadline of 150 ms' });
  });

  it('a deadline that passes while the body is read is asked again as a timeout', async () => {
    respond = firstThen(1, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    });
    const { value: r } = await withShortWaits(() => make({ maxReasks: 1, timeoutMs: 150 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(r.metadata.graderEvidence['reask'].earlier[0].reason, 'timeout');
  });

  it('a dropped connection is asked again', async () => {
    respond = firstThen(1, (req) => {
      req.socket.destroy();
    });
    const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.raw, seen[1]!.raw);
    assert.deepEqual(waits, [2000]);
    const e = r.metadata.graderEvidence['reask'].earlier[0];
    assert.deepEqual([e.reason, e.callSeq, e.httpStatus], ['transport', 1, 'NO_RESPONSE']);
    assert.match(e.detail, /^transport error \([A-Za-z_0-9]+\)$/);
  });

  it('a connection dropped in the middle of the body is asked again as a transport error', async () => {
    respond = firstThen(1, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"id":');
      setTimeout(() => req.socket.destroy(), 20);
    });
    const { value: r } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(r.metadata.graderEvidence['reask'].earlier[0].reason, 'transport');
  });

  it('the waits are 2, 4, then 8 seconds, by the number of the re-ask, and none after a cut', async () => {
    // no reply, no reply, no reply, then a reply
    respond = firstThen(3, statusResponder(503));
    const a = await withShortWaits(() => make({ maxReasks: 3 }).callApi(SOLO));
    assert.deepEqual(a.waits, [2000, 4000, 8000]);
    assert.deepEqual(a.value.metadata.graderEvidence['reask'].earlier.map((e: any) => e.callSeq), [1, 2, 3]);
    assert.equal(a.value.metadata.graderEvidence['callSeq'], 4);
    // a cut, then no reply, then a reply: the wait of the second re-ask is the second wait
    seen = [];
    respond = (req, res, s) => (seen.length === 1 ? cutResponder()(req, res, s) : seen.length === 2 ? statusResponder(500)(req, res, s) : okResponder({ id: 'msg_last' })(req, res, s));
    const b = await withShortWaits(() => make({ maxReasks: 3 }).callApi(SOLO));
    assert.deepEqual(b.waits, [4000]);
    assert.deepEqual(b.value.metadata.graderEvidence['reask'].earlier.map((e: any) => e.reason), ['truncated', 'server-error']);
  });

  it('the wait is real: one re-ask after a 529 takes two seconds', async () => {
    respond = firstThen(1, statusResponder(529));
    const t0 = Date.now();
    const r = await make({ maxReasks: 1 }).callApi(SOLO);
    const took = Date.now() - t0;
    assert.ok(took >= 1950 && took < 4000, String(took));
    assert.equal(r.metadata.graderEvidence['reask'].earlier.length, 1);
  });
});

describe('what is never asked again', () => {
  for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 425]) {
    it(`a ${status} is never asked again`, async () => {
      respond = statusResponder(status);
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.equal(e.message, `grader: the endpoint answered status ${status}`);
      assert.equal(seen.length, 1);
      assert.deepEqual(waits, []);
    });
  }

  it('a redirect is never asked again', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      seen = [];
      respond = (req, res) => {
        if (req.url === '/v1/messages') {
          res.writeHead(status, { location: '/elsewhere' });
          res.end();
        } else okResponder()(req, res, seen[0]!);
      };
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.equal(e.message, `grader: the endpoint answered status ${status}`);
      assert.equal(seen.length, 1, String(status));
      assert.deepEqual(waits, []);
    }
  });

  it('a status 200 with a malformed body is never asked again', async () => {
    const bodies: [string, Respond][] = [
      ['not JSON', (_req, res) => { res.writeHead(200); res.end('<html>'); }],
      ['no id', okResponder({ id: undefined })],
      ['no model', okResponder({ model: undefined })],
      ['no stop_reason', okResponder({ stop_reason: undefined })],
      ['empty content', okResponder({ content: [] })],
      ['a block with no type', okResponder({ content: [{ text: 'x' }] })],
      ['a malformed thinking counter', okResponder({ usage: { output_tokens_details: { thinking_tokens: -1 } } })],
      ['a malformed usage', okResponder({ usage: { input_tokens: 'many', output_tokens: 5 } })],
      // The same malformed bodies with a cut stop: a body the grader cannot read is not a cut reply.
      ['cut, no id', okResponder({ id: undefined, stop_reason: 'max_tokens' })],
      ['cut, a text block with no text', okResponder({ stop_reason: 'max_tokens', content: [{ type: 'text' }] })],
      ['cut, a malformed usage', okResponder({ stop_reason: 'max_tokens', usage: { input_tokens: 5 } })],
    ];
    for (const [name, r] of bodies) {
      seen = [];
      respond = r;
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.match(e.message, /^grader: /, name);
      assert.equal(seen.length, 1, name);
      assert.deepEqual(waits, [], name);
    }
  });

  it('a finished reply with no verdict, with prose, with a refusal stop or with a tool block is never asked again', async () => {
    const replies: [string, Record<string, unknown>][] = [
      ['no verdict', { content: [{ type: 'text', text: '{"reason":"none given"}' }] }],
      ['prose', { content: [{ type: 'text', text: 'Here is my verdict: {"pass":true} I hope that helps.' }] }],
      ['an empty text', { content: [{ type: 'text', text: '' }] }],
      ['a fenced reply', { content: [{ type: 'text', text: '```json\n{"pass":true}\n```' }] }],
      ['a refusal stop', { stop_reason: 'refusal' }],
      ['a stop sequence', { stop_reason: 'stop_sequence' }],
      ['a tool block', { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 't', input: {} }] }],
      ['a paused turn', { stop_reason: 'pause_turn' }],
      ['a stop word not known', { stop_reason: 'something_new' }],
      // Only the exact word is a cut: no other spelling is asked again.
      ['MAX_TOKENS', { stop_reason: 'MAX_TOKENS' }],
      ['two text blocks', { content: [{ type: 'text', text: '{"pass":' }, { type: 'text', text: 'true}' }] }],
    ];
    for (const [name, over] of replies) {
      seen = [];
      respond = okResponder(over);
      const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 3 }).callApi(SOLO));
      assert.equal(seen.length, 1, name);
      assert.deepEqual(waits, [], name);
      const rec = r.metadata.graderEvidence;
      assert.deepEqual(rec['reask'], { max: 3, earlier: [] }, name);
      assert.equal(rec['stopReason'], over['stop_reason'] ?? 'end_turn', name);
      assert.equal(rec['schema'], 'example.grader-evidence/v7', name);
    }
  });

  it('"max_tokens " with a trailing space is not a cut reply and not a recordable stop: it ends the slot after one request, where it used to be recorded', async () => {
    seen = [];
    respond = okResponder({ stop_reason: 'max_tokens ' });
    const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
    assert.match(e.message, /^grader: the response stop_reason is not one printable line/);
    assert.equal(seen.length, 1);
    assert.deepEqual(waits, []);
  });

  it('a key with a line feed, a carriage return, a space, a control character or a non-ASCII character is refused before any request, once, and never echoed', async () => {
    const name = 'ANCHORSET_TEST_BAD_HEADER_KEY';
    for (const bad of [`${KEY}\n`, `${KEY}\r`, `${KEY}\r\n`, `\n${KEY}`, `${KEY.slice(0, 10)}\n${KEY.slice(10)}`, `${KEY} `, ` ${KEY}`, `${KEY}\t`, `${KEY}\u0001`, `${KEY}\u007f`, `${KEY}\u00e9`, `${KEY}\u2713`, '\n']) {
      process.env[name] = bad;
      try {
        seen = [];
        const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3, apiKeyEnv: name }).callApi(SOLO)));
        assert.equal(e.message, 'grader: the key in the variable named in apiKeyEnv holds a character that is not visible ASCII (a space, a line feed, a control character or a character outside ASCII); the request is not sent and the key is not shown', JSON.stringify(bad));
        for (const text of [e.message, String(e.stack), JSON.stringify(e), String((e as { cause?: unknown }).cause)]) {
          assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(0, 10)) && !text.includes(KEY.slice(10)), JSON.stringify(bad));
        }
        assert.equal(seen.length, 0, JSON.stringify(bad));
        assert.deepEqual(waits, []);
      } finally {
        delete process.env[name];
      }
    }
    // Every visible ASCII character is taken.
    let all = '';
    for (let c = 0x21; c <= 0x7e; c++) all += String.fromCharCode(c);
    process.env[name] = all;
    try {
      seen = [];
      await make({ apiKeyEnv: name }).callApi(SOLO);
      assert.equal(seen[0]!.headers['x-api-key'], all);
    } finally {
      delete process.env[name];
    }
  });
});

describe('a status other than 200 is judged by the status alone, before any byte of its body', () => {
  /** A status and its headers, then a body that never ends. */
  const stalledBody = (status: number): Respond => (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"type":"error","error":{"message":"SECRET-BODY-TEXT');
  };

  for (const status of [400, 401, 403, 307, 302]) {
    it(`a ${status} whose body stalls is one request and an error by its status, not a passed deadline that is asked again`, async () => {
      respond = stalledBody(status);
      const t0 = Date.now();
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3, timeoutMs: 1500 }).callApi(SOLO)));
      const took = Date.now() - t0;
      assert.equal(e.message, `grader: the endpoint answered status ${status}`);
      assert.equal(seen.length, 1);
      assert.deepEqual(waits, []);
      assert.ok(took < 1000, `the body was waited for: ${took} ms`);
    });
  }

  it('a 529 or a 429 whose body stalls is a server error or a rate limit by its status, not a timeout', async () => {
    for (const [status, reason] of [[529, 'server-error'], [429, 'rate-limited']] as const) {
      seen = [];
      respond = firstThen(1, stalledBody(status));
      const t0 = Date.now();
      const { value: r, waits } = await withShortWaits(() => make({ maxReasks: 1, timeoutMs: 1500 }).callApi(SOLO));
      assert.ok(Date.now() - t0 < 1000, String(status));
      const e = r.metadata.graderEvidence['reask'].earlier[0];
      assert.deepEqual([e.reason, e.httpStatus, e.detail], [reason, status, `the endpoint answered status ${status}`]);
      assert.equal(seen.length, 2);
      assert.deepEqual(waits, [2000]);
    }
  });
});

describe("the deadline of an ask is the configured timeoutMs, which is the call shape's", () => {
  /** A clean reply, sent `ms` after the request. */
  const after = (ms: number): Respond => (req, res, s) => {
    setTimeout(() => okResponder()(req, res, s), ms);
  };

  it('a reply that comes after 400 ms is taken under a deadline of 5000 ms and is a passed deadline under one of 150 ms, after about 150 ms', async () => {
    respond = after(400);
    const slow = await make({ timeoutMs: 5000 }).callApi(SOLO);
    assert.equal(slow.metadata.graderEvidence['stopReason'], 'end_turn');
    assert.equal(slow.metadata.graderEvidence['callShape'].timeoutMs, 5000);
    assert.equal(seen.length, 1);

    seen = [];
    const t0 = Date.now();
    const e = await rejection(make({ timeoutMs: 150 }).callApi(SOLO));
    const took = Date.now() - t0;
    assert.equal(e.name, 'TimeoutError');
    assert.ok(took >= 140 && took < 390, `the ask ended after ${took} ms under a deadline of 150 ms`);
    assert.equal(seen.length, 1);
  });

  it('the deadline that is recorded in the detail of a timed-out ask is the one that ran', async () => {
    respond = firstThen(1, after(400));
    const t0 = Date.now();
    const { value: r } = await withShortWaits(() => make({ maxReasks: 1, timeoutMs: 200 }).callApi(SOLO));
    const took = Date.now() - t0;
    const rec = r.metadata.graderEvidence;
    assert.equal(rec['reask'].earlier[0].detail, 'the call passed its deadline of 200 ms');
    assert.equal(rec['callShape'].timeoutMs, 200);
    // The first ask ran for its 200 ms and no longer; the second was answered at once.
    assert.ok(took >= 190 && took < 390, String(took));
  });
});

describe('the body of a status 200: whole, UTF-8, and no more than declared', () => {
  it('a body that ends before its declared length is a transport error and is asked again, even when the part sent is a whole reply', async () => {
    const whole = JSON.stringify({ id: 'msg_short', type: 'message', role: 'assistant', model: 'judge-served-2026', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"pass":false}' }] });
    respond = firstThen(1, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(whole) + 40) });
      res.write(whole);
      setTimeout(() => req.socket.destroy(), 20);
    });
    const { value: r } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
    assert.equal(seen.length, 2);
    assert.equal(r.metadata.graderEvidence['reask'].earlier[0].reason, 'transport');
    assert.equal(r.metadata.graderEvidence['responseId'], 'msg_test_2');
    assert.equal(r.output, '{"pass":true,"reason":"ok"}');
  });

  it('a body that is not UTF-8, or opens with a byte-order mark, is not JSON: never replaced, never asked again', async () => {
    const good = Buffer.from(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: 'judge-served-2026', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"pass":true}' }] }), 'utf8');
    const badUtf8 = Buffer.concat([good.subarray(0, good.length - 4), Buffer.from([0xff]), good.subarray(good.length - 4)]);
    const withMark = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]);
    for (const [name, bytes] of [['not UTF-8', badUtf8], ['a byte-order mark', withMark]] as const) {
      seen = [];
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(bytes);
      };
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.equal(e.message, 'grader: the response is not JSON', name);
      assert.equal(seen.length, 1, name);
      assert.deepEqual(waits, [], name);
    }
  });
});

describe('a cut ask records the sha256 and the UTF-8 length of the text that was cut, and never the text', () => {
  it('the hash is over the text blocks joined, as UTF-8; an empty text has the hash of no bytes', async () => {
    const cases: [unknown[], string, number][] = [
      [[{ type: 'text', text: 'CUT-REPLY-TEXT {"pa' }], 'CUT-REPLY-TEXT {"pa', 19],
      [[{ type: 'text', text: '' }], '', 0],
      [[{ type: 'text', text: 'é✓ {"pa' }], 'é✓ {"pa', 10],
      [[{ type: 'thinking', thinking: 'HIDDEN', signature: 's' }, { type: 'text', text: '{"pa' }, { type: 'text', text: 'XY' }], '{"paXY', 6],
    ];
    for (const [content, text, bytes] of cases) {
      seen = [];
      respond = firstThen(1, cutResponder({ content }));
      const { value: r } = await withShortWaits(() => make({ maxReasks: 1 }).callApi(SOLO));
      const e = r.metadata.graderEvidence['reask'].earlier[0];
      assert.deepEqual([e.replySha256, e.replyUtf8Bytes], [sha(text), bytes], JSON.stringify(text));
      assert.ok(text === '' || !JSON.stringify(r).includes(JSON.stringify(text).slice(1, -1)), JSON.stringify(text));
      assert.ok(!JSON.stringify(r).includes('HIDDEN'));
    }
    assert.equal(sha(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('a cut reply that holds an unpaired surrogate has no hash: the slot ends and is not asked again', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_s","type":"message","role":"assistant","model":"judge-served-2026","stop_reason":"max_tokens","content":[{"type":"text","text":"{\\"pa\\ud800"}]}');
    };
    const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
    assert.equal(e.message, 'grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own');
    assert.equal(seen.length, 1);
    assert.deepEqual(waits, []);
  });
});

describe('the bound holds', () => {
  /** A fake endpoint with a request log, for the stateful marker. */
  async function withFake<T>(fn: (url: string, log: () => any[]) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'anchorset-reask-'));
    const logPath = join(dir, 'requests.jsonl');
    const ep = await startFakeEndpoint({ port: 0, logPath });
    try {
      return await fn(`http://127.0.0.1:${ep.port}`, () => readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)));
    } finally {
      await ep.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const promptOf = (marker: string): string => JSON.stringify([{ role: 'user', content: `Output: a refund was granted. ${marker}` }]);

  it('the bound holds on cut replies', async () => {
    await withFake(async (url, log) => {
      const { value: r, waits } = await withShortWaits(() => make({ baseUrl: url, maxReasks: 2 }).callApi(promptOf('[[times:3:truncated]]')));
      const requests = log();
      assert.equal(requests.length, 3);
      assert.deepEqual(waits, []);
      assert.equal(new Set(requests.map((q) => JSON.stringify(q.bodyJson))).size, 1);
      const rec = r.metadata.graderEvidence;
      assert.equal(rec['stopReason'], 'max_tokens');
      assert.equal(rec['reask'].max, 2);
      assert.deepEqual(rec['reask'].earlier.map((e: any) => [e.reason, e.callSeq, e.responseId, e.stopReason]), [['truncated', 1, 'msg_fake_0001', 'max_tokens'], ['truncated', 2, 'msg_fake_0002', 'max_tokens']]);
      assert.deepEqual([rec['callSeq'], rec['responseId']], [3, 'msg_fake_0003']);
      assert.deepEqual(rec['usage'], { input_tokens: 100, output_tokens: 20 });
    });
  });

  it('one more cut than the bound allows is still never a fourth request', async () => {
    await withFake(async (url, log) => {
      for (const max of [0, 1, 2, 3]) {
        const before = log().length;
        const r = await make({ baseUrl: url, maxReasks: max }).callApi(promptOf(`[[times:9:truncated]] bound ${max}`));
        assert.equal(log().length - before, 1 + max, `bound ${max}`);
        assert.equal(r.metadata.graderEvidence['reask'].earlier.length, max);
        assert.equal(r.metadata.graderEvidence['stopReason'], 'max_tokens');
      }
    });
  });

  it('the bound holds with no reply', async () => {
    await withFake(async (url, log) => {
      const g = make({ baseUrl: url, maxReasks: 1 });
      const { value: e, waits } = await withShortWaits(() => rejection(g.callApi(promptOf('[[mode:http-529]]'))));
      assert.equal(log().length, 2);
      assert.deepEqual(waits, [2000]);
      // The message lists both asks: the tool keeps no record of a call that throws.
      assert.match(e.message, /^grader: the endpoint answered status 529; no reply after 2 asks, the bound of 1 re-ask\(s\) is used up: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): server-error, the endpoint answered status 529; ask 2 \(callSeq 2, callId [0-9a-f-]{36}\): server-error, the endpoint answered status 529$/);
      assert.ok(!('metadata' in e));
      // The two numbers are used up: the next slot starts at 3.
      assert.equal((await g.callApi(promptOf('plain'))).metadata.graderEvidence['callSeq'], 3);
    });
  });

  it('a slot that ends with no reply after a cut lists the cut ask too, by its response id', async () => {
    respond = (req, res, s) => (seen.length === 1 ? cutResponder()(req, res, s) : statusResponder(500)(req, res, s));
    const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 2 }).callApi(SOLO)));
    assert.equal(seen.length, 3);
    assert.match(e.message, /no reply after 3 asks, the bound of 2 re-ask\(s\) is used up: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): truncated, response msg_cut_1; ask 2 \(callSeq 2, [^)]*\): server-error, the endpoint answered status 500; ask 3 \(callSeq 3, [^)]*\): server-error, the endpoint answered status 500$/);
    assert.ok(!e.message.includes('CUT-REPLY-TEXT') && !e.message.includes('SECRET-BODY-TEXT'));
  });

  it('maxReasks 0 is the grader as it was', async () => {
    respond = statusResponder(500);
    const a = await withShortWaits(() => rejection(make({ maxReasks: 0 }).callApi(SOLO)));
    assert.equal(a.value.message, 'grader: the endpoint answered status 500');
    assert.equal(seen.length, 1);
    assert.deepEqual(a.waits, []);
    seen = [];
    respond = cutResponder();
    const b = await make({ maxReasks: 0 }).callApi(SOLO);
    assert.equal(seen.length, 1);
    assert.equal(b.metadata.graderEvidence['stopReason'], 'max_tokens');
    assert.deepEqual(b.metadata.graderEvidence['reask'], { max: 0, earlier: [] });
    assert.equal(b.output, 'CUT-REPLY-TEXT {"pa');
    // A deadline and a dropped connection are raised as the platform raised them.
    seen = [];
    respond = () => undefined;
    const c = await rejection(make({ maxReasks: 0, timeoutMs: 100 }).callApi(SOLO));
    assert.equal(c.name, 'TimeoutError');
    assert.equal(seen.length, 1);
    seen = [];
    respond = (req) => void req.socket.destroy();
    const d = await rejection(make({ maxReasks: 0 }).callApi(SOLO));
    assert.ok(d instanceof TypeError);
    assert.equal(seen.length, 1);
  });

  it('callSeq over every ask of concurrent calls is 1 to the total, each once', async () => {
    await withFake(async (url, log) => {
      const g = make({ baseUrl: url, maxReasks: 2 });
      // Ten slots at once: four are cut once, three are cut twice, three are whole. 20 asks.
      const prompts = Array.from({ length: 10 }, (_, i) => promptOf(`slot ${i} ${i < 4 ? '[[times:1:truncated]]' : i < 7 ? '[[times:2:truncated]]' : ''}`));
      const results = await Promise.all(prompts.map((p) => g.callApi(p)));
      const recs = results.map((r) => r.metadata.graderEvidence);
      const seqs = recs.flatMap((r) => [...r['reask'].earlier.map((e: any) => e.callSeq as number), r['callSeq'] as number]).sort((a, b) => a - b);
      assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
      const ids = recs.flatMap((r) => [...r['reask'].earlier.map((e: any) => e.callId as string), r['callId'] as string]);
      assert.equal(new Set(ids).size, 20);
      const responseIds = recs.flatMap((r) => [...r['reask'].earlier.map((e: any) => e.responseId as string), r['responseId'] as string]);
      assert.equal(new Set(responseIds).size, 20);
      assert.equal(log().length, 20);
      // Within a slot the numbers rise in the order asked.
      for (const r of recs) {
        const own = [...r['reask'].earlier.map((e: any) => e.callSeq as number), r['callSeq'] as number];
        assert.deepEqual(own, [...own].sort((a, b) => a - b));
      }
      assert.ok(recs.every((r) => r['stopReason'] === 'end_turn'));
    });
  });

  it("the tool's abort ends the slot", async () => {
    // Each abort is given when the endpoint has seen the first request, never on a timer from the start of the call:
    // on a busy machine the request may not have left yet when such a timer fires, and the abort would then be the
    // third case below (before the call, no request at all).
    // During a wait between two asks: the abort ends the wait, and no further request is made. The endpoint answers the
    // first ask with a 529, after which the grader waits 2000 ms before it asks again; the abort is given once that
    // answer has been written and a moment has passed, well inside the wait.
    const waiting = new AbortController();
    let abortedAt = 0;
    respond = (req, res, s) => {
      res.on('finish', () => setTimeout(() => {
        abortedAt = Date.now();
        waiting.abort(new Error('the tool stopped the run'));
      }, 100));
      statusResponder(529)(req, res, s);
    };
    const e = await rejection(make({ maxReasks: 3 }).callApi(SOLO, {}, { abortSignal: waiting.signal }));
    const endedAfter = Date.now() - abortedAt;
    assert.equal(e.message, 'the tool stopped the run');
    assert.ok(abortedAt > 0, 'the abort was given by the endpoint, after its answer');
    // The slot ended on the abort, not when the 2000 ms wait would have ended.
    assert.ok(endedAfter < 1500, `the slot ended ${endedAfter} ms after the abort`);
    assert.equal(seen.length, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 1);
    // During a request: the same, and it is not taken for a passed deadline or a failed connection. The endpoint
    // never answers, and the abort is given when it has the request.
    seen = [];
    const sending = new AbortController();
    respond = () => sending.abort(new Error('stopped while sending'));
    const q = rejection(make({ maxReasks: 3, timeoutMs: 5000 }).callApi(SOLO, {}, { abortSignal: sending.signal }));
    assert.equal((await q).message, 'stopped while sending');
    assert.equal(seen.length, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 1);
    // An abort that came before the call: nothing is sent after the first failure either.
    seen = [];
    const already = new AbortController();
    already.abort(new Error('stopped before'));
    assert.equal((await rejection(make({ maxReasks: 3 }).callApi(SOLO, {}, { abortSignal: already.signal }))).message, 'stopped before');
    assert.equal(seen.length, 0);
  });

  it('usage is two integers, or "ABSENT"', async () => {
    const cases: [unknown, unknown][] = [
      [{ input_tokens: 9, output_tokens: 4 }, { input_tokens: 9, output_tokens: 4 }],
      [{ input_tokens: 0, output_tokens: 0 }, { input_tokens: 0, output_tokens: 0 }],
      // Only the two counters are recorded, whatever else the response's usage holds.
      [{ input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3, output_tokens_details: { thinking_tokens: 2 } }, { input_tokens: 9, output_tokens: 4 }],
      [{}, 'ABSENT'],
      [{ output_tokens_details: { thinking_tokens: 2 } }, 'ABSENT'],
    ];
    for (const [usage, expected] of cases) {
      respond = okResponder({ usage });
      assert.deepEqual((await make().callApi(SOLO)).metadata.graderEvidence['usage'], expected, JSON.stringify(usage));
    }
    respond = okResponder();
    assert.equal((await make().callApi(SOLO)).metadata.graderEvidence['usage'], 'ABSENT');
    // One counter without the other, or one that is not a non-negative integer, stops the call.
    for (const usage of [{ input_tokens: 9 }, { output_tokens: 4 }, { input_tokens: -1, output_tokens: 4 }, { input_tokens: 1.5, output_tokens: 4 }, { input_tokens: '9', output_tokens: 4 }, { input_tokens: 9, output_tokens: null }, { input_tokens: 2 ** 53, output_tokens: 4 }]) {
      respond = okResponder({ usage });
      await assert.rejects(make().callApi(SOLO), /grader: the token usage is malformed/, JSON.stringify(usage));
    }
  });

  it('no detail text holds the key', async () => {
    // Every kind of earlier ask in one slot, then the record; and the message of a slot that ends with no reply.
    respond = (req, res, s) => {
      if (seen.length === 1) statusResponder(503)(req, res, s);
      else if (seen.length === 2) req.socket.destroy();
      else if (seen.length === 3) cutResponder()(req, res, s);
      else okResponder({ id: 'msg_final' })(req, res, s);
    };
    const { value: r } = await withShortWaits(() => make({ maxReasks: 3 }).callApi(PAIR));
    const text = JSON.stringify(r);
    assert.ok(!text.includes(KEY));
    assert.deepEqual(r.metadata.graderEvidence['reask'].earlier.map((e: any) => e.reason), ['server-error', 'transport', 'truncated']);
    for (const e of r.metadata.graderEvidence['reask'].earlier) if ('detail' in e) assert.match(e.detail, /^[A-Za-z0-9 ()_]+$/);
    seen = [];
    respond = (req) => void req.socket.destroy();
    const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 1 }).callApi(PAIR)));
    assert.match(e.message, /no reply after 2 asks/);
    assert.ok(!e.message.includes(KEY) && !String(e.stack).includes(KEY));
  });

  it('the record of a re-asked slot survives a JSON round trip unchanged and holds no null', async () => {
    respond = firstThen(1, cutResponder());
    const r = await make({ maxReasks: 1 }).callApi(SOLO);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
    assert.ok(!JSON.stringify(r).includes('null'));
  });
});

describe('the deadline is at most one hour, refused when the grader is built (one bound for the three paths)', () => {
  const words = 'grader: config.timeoutMs must be a positive integer of at most 3600000 (one hour)';
  it('a timeoutMs above 3600000 ms is refused before any request, in one wording; a platform timer would run 2^31 ms and above after 1 ms', () => {
    // 2^31 and above: Node runs such a timer after 1 ms, so every ask would end as a passed deadline while the record
    // stated the larger value. Between the bound and 2^31 - 1 the value is refused too: the bound is the grader's.
    for (const timeoutMs of [3600001, 2 ** 31 - 1, 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER, 1e21]) {
      assert.throws(() => make({ timeoutMs }), (e: Error) => e.message === words, String(timeoutMs));
    }
    for (const timeoutMs of [0, -1, 1.5, '60000', null]) assert.throws(() => make({ timeoutMs }), (e: Error) => e.message === words, String(timeoutMs));
    assert.equal(seen.length, 0);
  });
  it('3600000 ms is taken, sent as the deadline of the ask and stated in the call shape', async () => {
    const r = await make({ timeoutMs: 3600000 }).callApi(SOLO);
    assert.equal(seen.length, 1);
    assert.equal(r.metadata.graderEvidence['callShape'].timeoutMs, 3600000);
  });
  it('the bound is one constant, the same in the two grader files and in the importers', () => {
    const js = readFileSync(GRADER_PATH, 'utf8');
    const py = readFileSync(new URL('../examples/importers/inspect/recording_grader.py', import.meta.url), 'utf8');
    assert.equal(TIMEOUT_MS_CEILING, 3600000);
    assert.equal((js.match(/^const MAX_TIMEOUT_MS = ([^;]+);$/m) ?? [])[1], String(TIMEOUT_MS_CEILING));
    assert.equal((py.match(/^MAX_TIMEOUT_MS = (.+)$/m) ?? [])[1], String(TIMEOUT_MS_CEILING));
    // The Python grader's refusal is in the same words, with its own name for the setting.
    assert.ok(py.includes('raise ValueError(f"grader: timeout_ms must be a positive integer of at most {MAX_TIMEOUT_MS} (one hour)")'));
    assert.ok(js.includes('throw new Error(`grader: config.timeoutMs must be a positive integer of at most ${MAX_TIMEOUT_MS} (one hour)`)'));
  });
});

describe('a response id that is not 1 to 200 visible ASCII characters is a malformed reply: never asked again, never shown', () => {
  const words = 'grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown';
  const hostile = ['msg_1\nREFUSED forged line', 'msg_1\r', 'msg_\u001b[2J\u001b[31mRED', 'msg_1\u0000', 'msg_1\u007f', 'msg 1', ' msg_1', 'msg_1\t', 'msg_é', 'msg_✓', 'msg_‮1', 'm'.repeat(201)];
  it('a finished reply with such an id raises after one request, whatever the bound, and the id is in no message', async () => {
    for (const id of hostile) {
      seen = [];
      respond = okResponder({ id });
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.equal(e.message, words, JSON.stringify(id));
      assert.equal(seen.length, 1, JSON.stringify(id));
      assert.deepEqual(waits, [], JSON.stringify(id));
      assert.ok(!e.message.includes(id) && !String(e.stack).includes(id), JSON.stringify(id));
    }
  });
  it('a cut reply with such an id is not a cut reply: it raises after one request, so the id never reaches the text of a used-up bound', async () => {
    for (const id of hostile) {
      seen = [];
      respond = cutResponder({ id });
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 1 }).callApi(SOLO)));
      assert.equal(e.message, words, JSON.stringify(id));
      assert.equal(seen.length, 1, JSON.stringify(id));
      assert.deepEqual(waits, []);
    }
    // A clean cut reply, then a cut reply whose id is hostile: the slot ends at the second ask. Its message is the
    // malformed reply's and then the list of the slot's asks, which names the first ask by its own, well-formed id and
    // holds nothing of the hostile one.
    for (const id of hostile) {
      seen = [];
      respond = (req, res, s) => (seen.length === 1 ? cutResponder({ id: 'msg_cut_1' }) : cutResponder({ id }))(req, res, s);
      const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.match(e.message, /^grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown; the slot ends with no record after 2 asks: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): truncated, response msg_cut_1; ask 2 \(callSeq 2, callId [0-9a-f-]{36}\): ended the slot$/, JSON.stringify(id));
      assert.ok(!e.message.includes(id), JSON.stringify(id));
      assert.equal(seen.length, 2);
    }
  });
  it('an id of 1 or 200 visible ASCII characters, any of them, is taken and recorded as it came', async () => {
    let all = '';
    for (let c = 0x21; c <= 0x7e; c++) all += String.fromCharCode(c);
    for (const id of ['m', 'm'.repeat(200), all]) {
      seen = [];
      respond = okResponder({ id });
      const r = await make().callApi(SOLO);
      assert.equal(r.metadata.graderEvidence['responseId'], id);
    }
  });
  it('the two grader files hold the same form for a response id, and the importers the same', () => {
    const js = readFileSync(GRADER_PATH, 'utf8');
    const py = readFileSync(new URL('../examples/importers/inspect/recording_grader.py', import.meta.url), 'utf8');
    const shared = readFileSync(new URL('../examples/importers/shared.ts', import.meta.url), 'utf8');
    assert.ok(js.includes('const RESPONSE_ID_FORM = /^[\\x21-\\x7e]{1,200}$/;'));
    assert.ok(py.includes('RESPONSE_ID_FORM = re.compile(r"[\\x21-\\x7e]{1,200}")'));
    assert.ok(py.includes('raise ValueError("grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown")'));
    assert.ok(shared.includes("const isPlainId = (v: unknown): boolean => typeof v === 'string' && /^[\\x21-\\x7e]{1,200}$/.test(v);"));
  });
});

describe('a model id or an API version the importer would refuse is refused before the first call, and a served model, id or stop reason it would refuse ends the slot', () => {
  const importerWords = ['UNKNOWN', 'unknown', 'N/A', 'none', 'null', 'NOT_SENT', 'not-sent', 'Undefined'];
  const notOneLine = ['judge\nforged line', 'judge\r', 'judge\u001b[2J', 'judge\tid', 'judge  id', ' judge', 'judge ', 'judgé', 'j'.repeat(201)];
  it('a model id that reads as unknown or is not one printable line is refused when the grader is built, with 0 requests and the value not shown', () => {
    for (const model of [...importerWords, ...notOneLine]) {
      const e = (() => { try { make({ model }); } catch (x) { return x as Error; } return undefined; })();
      assert.ok(e, JSON.stringify(model));
      assert.match(e.message, /^grader: config\.model must be one printable line/, JSON.stringify(model));
      // the value is shown nowhere (a gap word is also a word of the message itself)
      if (!importerWords.includes(model)) assert.ok(!e.message.includes(model), JSON.stringify(model));
    }
    assert.equal(seen.length, 0);
    // a plain id, one with single spaces, and one of 200 characters are taken
    for (const model of ['judge-requested', 'claude-judge 2026', 'j'.repeat(200)]) make({ model });
  });
  it('an API version that reads as unknown, holds a control character or a letter outside ASCII, or is longer than 200 characters is refused when the grader is built', () => {
    for (const apiVersion of [...importerWords, '2023-06-01\u0001', '2023-06-01\u007f', '2023é', 'v'.repeat(201)]) {
      const e = (() => { try { make({ apiVersion }); } catch (x) { return x as Error; } return undefined; })();
      assert.ok(e, JSON.stringify(apiVersion));
      assert.match(e.message, /^grader: config\.apiVersion must be /, JSON.stringify(apiVersion));
      if (!importerWords.includes(apiVersion)) assert.ok(!e.message.includes(apiVersion), JSON.stringify(apiVersion));
    }
    assert.equal(seen.length, 0);
    make({ apiVersion: '2024-01-01' });
    // A value that holds white space is a non-empty string: it is refused with the reason that is true of it.
    for (const apiVersion of ['a b', '2023-06-01\n', ' 2023-06-01', '2023\t06']) {
      assert.throws(() => make({ apiVersion }), (e: Error) => e.message === 'grader: config.apiVersion must be 1 to 200 visible ASCII characters with no space that do not read as unknown; the value is not shown', JSON.stringify(apiVersion));
    }
    for (const apiVersion of ['', 7]) assert.throws(() => make({ apiVersion: apiVersion as string }), (e: Error) => e.message === 'grader: config.apiVersion must be a non-empty string', JSON.stringify(apiVersion));
    assert.equal(seen.length, 0);
  });
  it('the grader\'s gap spellings are the library\'s: every spelling readsAsGap names, the grader refuses', async () => {
    const { readsAsGap } = await import('../src/index.ts');
    for (const word of ['unknown', 'UNKNOWN', 'Un-Known', 'n/a', 'N.A.', 'none', 'null', 'nil', 'undefined', 'not_sent', 'NOT SENT', 'not.sent', 'judge', 'na1', '']) {
      const refused = (() => { try { make({ model: word === '' ? 'x' : word }); return false; } catch { return true; } })();
      if (word !== '') assert.equal(refused, readsAsGap(word), JSON.stringify(word));
    }
  });
  const hostileModels = ['judge served', 'judge\nforged', 'judge\r', 'judge\u001b[2J', 'judgé', 'm'.repeat(201), 'unknown', 'N/A'];
  it('a served model that is not 1 to 200 visible ASCII characters with no space, or reads as unknown, ends the slot after one request, whatever the bound, and is shown nowhere', async () => {
    for (const model of hostileModels) {
      seen = [];
      respond = okResponder({ model });
      const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.ok(/^grader: the response (model is not 1 to 200 visible ASCII characters with no space; it is not shown|id, model or stop_reason reads as unknown; it is not shown)$/.test(e.message), `${JSON.stringify(model)}: ${e.message}`);
      assert.equal(seen.length, 1, JSON.stringify(model));
      assert.deepEqual(waits, [], JSON.stringify(model));
      if (!['unknown', 'N/A'].includes(model)) assert.ok(!e.message.includes(model) && !String(e.stack).includes(model), JSON.stringify(model));
    }
  });
  it('a stop reason that is not one printable line, or reads as unknown, ends the slot after one request and is shown nowhere', async () => {
    for (const stop_reason of ['end turn\nforged', 'end_turn\r', 'end_turn\u001b[2J', 'end  turn', 's'.repeat(201), 'unknown', 'none']) {
      seen = [];
      respond = okResponder({ stop_reason });
      const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
      assert.ok(/^grader: the response (stop_reason is not one printable line|id, model or stop_reason reads as unknown)/.test(e.message), `${JSON.stringify(stop_reason)}: ${e.message}`);
      assert.equal(seen.length, 1, JSON.stringify(stop_reason));
      if (!['unknown', 'none'].includes(stop_reason)) assert.ok(!e.message.includes(stop_reason) && !String(e.stack).includes(stop_reason), JSON.stringify(stop_reason));
    }
  });
  it('a response id that reads as unknown ends the slot after one request', async () => {
    for (const id of ['unknown', 'None', 'N/A', 'not_sent']) {
      seen = [];
      respond = okResponder({ id });
      const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 2 }).callApi(SOLO)));
      assert.equal(e.message, 'grader: the response id, model or stop_reason reads as unknown; it is not shown', id);
      assert.equal(seen.length, 1);
    }
  });
});

describe('a slot that ends with no record after an earlier ask: the error text lists every ask of the slot', () => {
  const LIST = (last: string): RegExp => new RegExp(`^${last}; the slot ends with no record after 2 asks: ask 1 \\(callSeq 1, callId [0-9a-f-]{36}\\): truncated, response msg_cut_1; ask 2 \\(callSeq 2, callId [0-9a-f-]{36}\\): ended the slot$`);

  it('a cut reply, then a 400: the text is the 400 and the two asks, where it used to be the 400 alone', async () => {
    respond = (req, res, s) => (seen.length === 1 ? cutResponder()(req, res, s) : statusResponder(400)(req, res, s));
    const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, []);
    assert.match(e.message, LIST('grader: the endpoint answered status 400'));
    assert.ok(!e.message.includes('CUT-REPLY-TEXT') && !e.message.includes('SECRET-BODY-TEXT') && !e.message.includes(KEY));
    assert.ok(!('metadata' in e));
  });

  it('a cut reply, then a redirect, a body that is not JSON, a response with no id or no model: each names the cut ask', async () => {
    const seconds: [string, Respond, string][] = [
      ['a redirect', (_req, res) => { res.writeHead(307, { location: '/elsewhere' }); res.end(); }, 'grader: the endpoint answered status 307'],
      ['not JSON', (_req, res) => { res.writeHead(200); res.end('<html>'); }, 'grader: the response is not JSON'],
      ['no id', okResponder({ id: undefined }), 'grader: the response lacks id, model, stop_reason or content'],
      ['no model', okResponder({ model: undefined }), 'grader: the response lacks id, model, stop_reason or content'],
    ];
    for (const [name, second, words] of seconds) {
      seen = [];
      respond = (req, res, s) => (seen.length === 1 ? cutResponder()(req, res, s) : second(req, res, s));
      const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 2 }).callApi(SOLO)));
      assert.equal(seen.length, 2, name);
      assert.match(e.message, LIST(words), name);
    }
  });

  it('a cut reply, then a cut reply that holds an unpaired surrogate: the slot ends and the first cut ask is named', async () => {
    respond = (req, res, s) => {
      if (seen.length === 1) return cutResponder()(req, res, s);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_s","type":"message","role":"assistant","model":"judge-served-2026","stop_reason":"max_tokens","content":[{"type":"text","text":"{\\"pa\\ud800"}]}');
    };
    const { value: e } = await withShortWaits(() => rejection(make({ maxReasks: 3 }).callApi(SOLO)));
    assert.equal(seen.length, 2);
    assert.match(e.message, LIST('grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own'));
  });

  it('an ask with no reply, then a 403: the first ask is named with what it ended in', async () => {
    respond = (req, res, s) => (seen.length === 1 ? statusResponder(529)(req, res, s) : statusResponder(403)(req, res, s));
    const { value: e, waits } = await withShortWaits(() => rejection(make({ maxReasks: 1 }).callApi(SOLO)));
    assert.equal(seen.length, 2);
    assert.deepEqual(waits, [2000]);
    assert.match(e.message, /^grader: the endpoint answered status 403; the slot ends with no record after 2 asks: ask 1 \(callSeq 1, callId [0-9a-f-]{36}\): server-error, the endpoint answered status 529; ask 2 \(callSeq 2, callId [0-9a-f-]{36}\): ended the slot$/);
  });

  it('a slot that ends on its first ask is raised as it came, with no list', async () => {
    respond = statusResponder(400);
    assert.equal((await rejection(make({ maxReasks: 3 }).callApi(SOLO))).message, 'grader: the endpoint answered status 400');
  });
});

describe('the base URL path holds plain segments only, and the response is in no content encoding', () => {
  const PATHS = ['/a/../b', '/a/./b', '/..', '/.', '/a//b', '//a', '/a%20b', '/a%2e%2e/b', '/a;b', '/a:b', '/café', '/a,b', '/a+b', '/a=b', '/a&b', '/a!b', "/a'b", '/a(b)', '/a*b', '/a$b', '/a[b]', '/a|b', '/a"b', '/a<b', '/a^b', '/a`b', '/a{b}'];
  const PATH_WORDS = 'grader: baseUrl path must hold plain segments only';

  it('a path with a dot segment, an empty segment, a percent escape or any character outside letters, digits, ".", "_", "~" and "-" is refused when the grader is built, in one wording, and no request is made', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchorset-path-'));
    const logPath = join(dir, 'requests.jsonl');
    const ep = await startFakeEndpoint({ port: 0, logPath });
    try {
      const url = `http://127.0.0.1:${ep.port}`;
      for (const p of PATHS) {
        assert.throws(() => make({ baseUrl: `${url}${p}` }), (e: Error) => e.message === PATH_WORDS, p);
        assert.throws(() => make({ baseUrl: `${url}${p}/` }), (e: Error) => e.message === PATH_WORDS, `${p}/`);
        assert.notEqual(graderBaseUrlProblem(`${url}${p}`), undefined, p);
      }
      // The refusal does not show the path: a path can hold a credential.
      assert.throws(() => make({ baseUrl: `${url}/secret-token;x` }), (e: Error) => e.message === PATH_WORDS);
      assert.equal(readFileSync(logPath, 'utf8'), '');
    } finally {
      await ep.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a path of plain segments is taken, with any number of closing slashes, and is posted to as written', async () => {
    for (const [p, posted] of [['', '/v1/messages'], ['/', '/v1/messages'], ['/proxy', '/proxy/v1/messages'], ['/a/b.c/d_e~f-g/', '/a/b.c/d_e~f-g/v1/messages'], ['/base//', '/base/v1/messages'], ['/...', '/.../v1/messages']] as const) {
      seen = [];
      const rec = (await make({ baseUrl: `${base}${p}` }).callApi(SOLO)).metadata.graderEvidence;
      assert.equal(seen[0]!.url, posted, p);
      assert.equal(rec['callShape'].endpoint, `${base}${posted}`, p);
      assert.equal(graderBaseUrlProblem(`${base}${p}`), undefined, p);
    }
  });

  it('an address with no "//" after its scheme is not a URL the grader takes', () => {
    for (const baseUrl of ['https:api.example.com', 'https:/api.example.com', 'http:127.0.0.1:1']) {
      assert.throws(() => make({ baseUrl }), (e: Error) => e.message === 'grader: baseUrl is not a URL', baseUrl);
      assert.notEqual(graderBaseUrlProblem(baseUrl), undefined, baseUrl);
    }
  });

  it('the request asks for no content encoding', async () => {
    await make().callApi(SOLO);
    assert.equal(seen[0]!.headers['accept-encoding'], 'identity');
  });

  it('a reply in a content encoding ends the slot after one request, whatever the bound: it is not decoded and never asked again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchorset-encoded-'));
    const logPath = join(dir, 'requests.jsonl');
    const ep = await startFakeEndpoint({ port: 0, logPath, mode: 'encoded' });
    try {
      const { value: e, waits } = await withShortWaits(() => rejection(make({ baseUrl: `http://127.0.0.1:${ep.port}`, maxReasks: 3 }).callApi(SOLO)));
      assert.equal(e.message, 'grader: the response is in a content encoding the request did not ask for');
      assert.deepEqual(waits, []);
      const requests = readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers['accept-encoding'], 'identity');
      assert.equal(requests[0].response.status, 200);
    } finally {
      await ep.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the header alone decides: gzip, br, deflate, a list and an unknown name are refused; identity, in any case and with spaces around it, is taken, as no header is', async () => {
    for (const encoding of ['gzip', 'br', 'deflate', 'identity, gzip', 'x-unknown']) {
      seen = [];
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
        res.end('{}');
      };
      const e = await rejection(make({ maxReasks: 2 }).callApi(SOLO));
      assert.equal(e.message, 'grader: the response is in a content encoding the request did not ask for', encoding);
      assert.equal(seen.length, 1, encoding);
    }
    for (const encoding of ['identity', 'Identity', ' identity ']) {
      seen = [];
      respond = (req, res, s) => {
        res.setHeader('content-encoding', encoding);
        okResponder()(req, res, s);
      };
      assert.equal((await make().callApi(SOLO)).output, '{"pass":true,"reason":"ok"}', encoding);
    }
  });
});

describe('the head of a response: one verdict from both graders for each content-encoding header and each stated length', () => {
  // What each response head ends in, as bytes on the wire (each character below is one byte). "record": the reply is
  // taken. "refused": the response is in a content encoding; one request, never asked again. "transport": the platform's
  // parser refuses the head before the grader sees it, so the ask is a failed connection, asked again within the bound.
  // The Python grader's self-test holds the same table (examples/importers/inspect/selftest.py, HEADER_CASES and
  // LENGTH_CASES), and the second test below gives this one to both graders.
  type Verdict = 'record' | 'refused' | 'transport';
  const HEADER_CASES: [string, Verdict][] = [
    ['', 'record'],
    ['content-encoding: identity\r\n', 'record'],
    ['content-encoding: Identity\r\n', 'record'],
    ['content-encoding: IDENTITY\r\n', 'record'],
    ['content-encoding:  identity  \r\n', 'record'],
    ['content-encoding:\tidentity\t\r\n', 'record'],
    ['Content-Encoding: identity\r\n', 'record'],
    // a no-break space is white space to `trim`
    ['content-encoding: \xa0identity\r\n', 'record'],
    ['content-encoding: identity\xa0\r\n', 'record'],
    // a header that is there and empty states an encoding that is not identity
    ['content-encoding: \r\n', 'refused'],
    ['content-encoding:\r\n', 'refused'],
    // byte 0x85 is white space to Python's strip() and not to `trim`
    ['content-encoding: identity\x85\r\n', 'refused'],
    ['content-encoding: \x85identity\r\n', 'refused'],
    ['content-encoding: identit\xe9\r\n', 'refused'],
    ['content-encoding: gzip\r\n', 'refused'],
    ['Content-Encoding: gzip\r\n', 'refused'],
    ['content-encoding: identity, gzip\r\n', 'refused'],
    ['content-encoding: identity\r\ncontent-encoding: identity\r\n', 'refused'],
    ['content-encoding: identity\r\ncontent-encoding: gzip\r\n', 'refused'],
    ['content-encoding: iden\ttity\r\n', 'refused'],
    ['x-note: a\x85\r\ncontent-encoding: gzip\r\n', 'refused'],
    ['x-note: a\x85\r\n', 'record'],
    ['x-note: caf\xe9\xa0\r\n', 'record'],
    // a control character in a header, a line with no colon. (A folded header line and a space before a header's colon are
    // not here: the platform takes or refuses them by its version. Node 22.21 takes both and Node 25.6 refuses both; the
    // Python grader refuses both on every version, and its self-test says so.)
    ['content-encoding: \x0bidentity\x0c\r\n', 'transport'],
    ['content-encoding: iden\x0btity\r\n', 'transport'],
    ['content-encoding: identity\x0c\r\n', 'transport'],
    ['content-encoding: identity\x1c\r\n', 'transport'],
    ['content-encoding: identity\x00\r\n', 'transport'],
    ['content-encoding: identity\x7f\r\n', 'transport'],
    ['content-encoding: identity\rx\r\n', 'transport'],
    ['x-note: a\x0bb\r\n', 'transport'],
    ['x-note: a\x1fb\r\n', 'transport'],
    ['this line has no colon\r\n', 'transport'],
  ];
  // The same for the length: whether the server states the body's length itself, the header bytes ("<n>" is that length), the verdict.
  const LENGTH_CASES: [boolean, string, Verdict][] = [
    [false, '', 'record'],
    [false, 'content-length: <n>\r\n', 'record'],
    [false, 'Content-Length:  <n> \r\n', 'record'],
    [true, 'content-length: <n>\r\n', 'transport'],
    [true, 'content-length: 5\r\n', 'transport'],
    [true, 'transfer-encoding: chunked\r\n', 'transport'],
    [false, 'content-length: abc\r\n', 'transport'],
    [false, 'content-length: -1\r\n', 'transport'],
    [false, 'content-length: +<n>\r\n', 'transport'],
    [false, 'content-length: <n>, <n>\r\n', 'transport'],
    [false, 'content-length:\r\n', 'transport'],
    [false, 'content-length: 1_0\r\n', 'transport'],
    [false, 'content-length: \xd9\xa1\r\n', 'transport'],
  ];
  const CASES: [boolean, string, Verdict][] = [...HEADER_CASES.map(([h, v]): [boolean, string, Verdict] => [true, h, v]), ...LENGTH_CASES];
  const BODY = Buffer.from(JSON.stringify({ id: 'msg_test_1', type: 'message', role: 'assistant', model: 'judge-served-2026', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"pass":true,"reason":"ok"}' }] }), 'utf8');
  const ENCODED = 'grader: the response is in a content encoding the request did not ask for';

  /** Answers the case whose number is in the request's path (`/<who><i>/v1/messages`), with its bytes written to the socket as they are: no library writes or checks the head. */
  const rawResponder: Respond = (req) => {
    const i = Number(/^\/[a-z]+([0-9]+)\//.exec(req.url ?? '')?.[1]);
    const [stated, header] = CASES[i]!;
    const head = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n${stated ? `content-length: ${BODY.byteLength}\r\n` : ''}connection: close\r\n${header.replaceAll('<n>', String(BODY.byteLength))}\r\n`;
    req.socket.end(Buffer.concat([Buffer.from(head, 'latin1'), BODY]));
  };
  const requestsOf = (who: string, i: number): number => seen.filter((s) => s.url.startsWith(`/${who}${i}/`)).length;

  it('the JavaScript grader: identity, in any case and with the white space `trim` removes around it, is taken, as no header is; an empty header, byte 0x85, a list and two lines are refused after one request; a head the platform refuses is a failed connection, asked again', async () => {
    assert.equal(new Set(CASES.map(([s, h]) => `${s}${h}`)).size, CASES.length, 'a case is listed twice');
    respond = rawResponder;
    for (const [i, [, header, verdict]] of CASES.entries()) {
      const { value, waits } = await withShortWaits(() => make({ baseUrl: `${base}/js${i}`, maxReasks: 1 }).callApi(SOLO).then((r) => r.output, (e: Error) => e));
      const got = value === '{"pass":true,"reason":"ok"}' ? 'record' : !(value instanceof Error) ? 'another reply' : value.message === ENCODED ? 'refused' : /^grader: transport error \([A-Za-z_0-9]+\); no reply after 2 asks/.test(value.message) ? 'transport' : value.message;
      assert.equal(got, verdict, JSON.stringify(header));
      assert.equal(requestsOf('js', i), verdict === 'transport' ? 2 : 1, JSON.stringify(header));
      assert.deepEqual(waits, verdict === 'transport' ? [2000] : [], JSON.stringify(header));
    }
  });

  it('the Python grader gives the same verdict for every one of them, with the same number of requests', async (t) => {
    const venv = process.env['ANCHORSET_INSPECT_VENV'];
    const py = [...(venv === undefined ? [] : [join(venv, 'bin', 'python')]), 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import inspect_ai']).status === 0);
    if (py === undefined) {
      t.skip('no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)');
      return;
    }
    respond = rawResponder;
    const d = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(new URL('../examples/importers/inspect', import.meta.url).pathname)})
from inspect_ai.model import ChatMessageUser, GenerateConfig
import recording_grader as rg
waits = []
async def no_wait(seconds):
    waits.append(seconds)
rg._wait = no_wait
out = []
for i in range(${CASES.length}):
    waits.clear()
    g = rg.RecordingGrader("judge-requested", base_url=f"${base}/py{i}", config=GenerateConfig(max_tokens=256), thinking="NOT_SENT", effort="NOT_SENT", max_reasks=1)
    try:
        o = asyncio.run(g.generate([ChatMessageUser(content="q")], [], "none", GenerateConfig(max_tokens=256)))
        got = "record" if o.metadata["graderEvidence"]["reply"] == '{"pass":true,"reason":"ok"}' else "another reply"
    except ValueError as e:
        m = str(e)
        got = "refused" if m == ${JSON.stringify(ENCODED)} else "transport" if m.startswith("grader: transport error (") and "; no reply after 2 asks" in m else m
    out.append([got, list(waits)])
print(json.dumps(out))
`;
    // Not spawnSync: the server that answers the Python grader runs in this process.
    const r = await promisify(execFile)(py, ['-c', d], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', PYTHONDONTWRITEBYTECODE: '1', ANTHROPIC_API_KEY: KEY } });
    const python = JSON.parse(r.stdout) as [string, number[]][];
    assert.equal(python.length, CASES.length);
    for (const [i, [, header, verdict]] of CASES.entries()) {
      assert.equal(python[i]![0], verdict, `the Python grader, ${JSON.stringify(header)}`);
      assert.equal(requestsOf('py', i), verdict === 'transport' ? 2 : 1, `the Python grader, ${JSON.stringify(header)}`);
      assert.deepEqual(python[i]![1], verdict === 'transport' ? [2] : [], `the Python grader, ${JSON.stringify(header)}`);
    }
  });
});

describe('the two graders hold a base URL to one rule, and record the same endpoint', () => {
  // The rule: the address is one a URL parser leaves as written. A lower-case scheme (https, or http for the literal
  // address 127.0.0.1 or [::1]); a host that is a name of lower-case labels, four decimal numbers with dots, or [::1]; a port only when it
  // is not the scheme's own; a path of plain segments. Every address below is given to both graders and to the
  // importers' check: each is taken by all three or refused by all three, and a taken one is recorded as one endpoint.
  const LABEL_63 = 'a'.repeat(63);
  const TAKEN: [string, string][] = [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://api.example.com', 'https://api.example.com/v1/messages'],
    ['https://api.example.com/', 'https://api.example.com/v1/messages'],
    ['https://api.example.com/base//', 'https://api.example.com/base/v1/messages'],
    ['https://api.example.com:8443/x', 'https://api.example.com:8443/x/v1/messages'],
    ['https://gateway.example/anthropic', 'https://gateway.example/anthropic/v1/messages'],
    ['http://127.0.0.1:1', 'http://127.0.0.1:1/v1/messages'],
    ['http://127.0.0.1:18765', 'http://127.0.0.1:18765/v1/messages'],
    ['https://localhost', 'https://localhost/v1/messages'],
    ['https://localhost:8443/p', 'https://localhost:8443/p/v1/messages'],
    ['http://[::1]:18765', 'http://[::1]:18765/v1/messages'],
    ['http://[::1]:1', 'http://[::1]:1/v1/messages'],
    ['http://[::1]:1/p', 'http://[::1]:1/p/v1/messages'],
    ['http://127.0.0.1', 'http://127.0.0.1/v1/messages'],
    ['http://[::1]', 'http://[::1]/v1/messages'],
    ['http://127.0.0.1:443', 'http://127.0.0.1:443/v1/messages'],
    ['https://[::1]', 'https://[::1]/v1/messages'],
    ['https://[::1]:8443', 'https://[::1]:8443/v1/messages'],
    ['https://h', 'https://h/v1/messages'],
    ['https://h:1', 'https://h:1/v1/messages'],
    ['https://h:80', 'https://h:80/v1/messages'],
    ['https://h:65535', 'https://h:65535/v1/messages'],
    ['https://h/a/', 'https://h/a/v1/messages'],
    ['https://h//', 'https://h/v1/messages'],
    ['https://h/...', 'https://h/.../v1/messages'],
    ['https://h/a.b/c_d~e-f', 'https://h/a.b/c_d~e-f/v1/messages'],
    ['https://h/v1', 'https://h/v1/v1/messages'],
    ['https://h/v1/messages', 'https://h/v1/messages/v1/messages'],
    ['https://h/Base', 'https://h/Base/v1/messages'],
    ['https://1.2.3.4', 'https://1.2.3.4/v1/messages'],
    ['https://0.0.0.0', 'https://0.0.0.0/v1/messages'],
    ['https://255.255.255.255:65535', 'https://255.255.255.255:65535/v1/messages'],
    ['https://a-b.c1.example', 'https://a-b.c1.example/v1/messages'],
    ['https://1a.example', 'https://1a.example/v1/messages'],
    ['https://1.2.3.x', 'https://1.2.3.x/v1/messages'],
    ['https://127.0.0.1.example', 'https://127.0.0.1.example/v1/messages'],
    ['https://a--b.example', 'https://a--b.example/v1/messages'],
    ['https://abc--d.example', 'https://abc--d.example/v1/messages'],
    ['https://a.b.c.d.e', 'https://a.b.c.d.e/v1/messages'],
    [`https://${LABEL_63}.example`, `https://${LABEL_63}.example/v1/messages`],
  ];
  const PATHS = ['/a/../b', '/a/./b', '/..', '/.', '/a//b', '//a', '/a%20b', '/a%2e%2e/b', '/a;b', '/a:b', '/café', '/a,b', '/a+b', '/a=b', '/a&b', '/a!b', "/a'b", '/a(b)', '/a*b', '/a$b', '/a[b]', '/a|b', '/a"b', '/a<b', '/a^b', '/a`b', '/a{b}'];
  const REFUSED: string[] = [
    // a letter in upper case, in the scheme or the host
    'HTTPS://API.EXAMPLE.COM', 'Https://h', 'hTTp://127.0.0.1:1', 'http://LOCALHOST:1', 'http://Localhost:1', 'https://API.example.com/Base', 'https://h.Example', 'https://[::1]X',
    // a closing dot, an empty label, a hyphen at an end of a label, an underscore, a reserved label, a label or a name too long
    'https://h.', 'http://localhost.:1', 'https://a..b', 'https://.h', 'https://.', 'https://-h', 'https://h-', 'https://h-.example', 'https://exa_mple.com', 'https://xn--bcher-kva.example', 'https://ab--c.example',
    `https://${LABEL_63}a.example`, `https://${Array(5).fill(LABEL_63).join('.')}`,
    // a host that reads as a number: short, hexadecimal, octal, with a leading zero, of three or five parts, out of range
    'https://1', 'https://example.123', 'https://example.0x1', 'https://h.1', 'https://0x7f.0.0.1', 'http://127.1:1', 'http://0x7f.0.0.1:1', 'http://0X7F.0.0.1:1', 'http://2130706433:1', 'http://017700000001:1',
    'http://127.0.0.01:1', 'http://127.0.0.001:1', 'http://0127.0.0.1:1', 'http://0177.0.0.1:1', 'http://127.0.0.1.:1', 'http://127.0.0.1.1:1', 'http://127.0.1:1', 'https://1.2.3', 'https://1.2.3.4.5', 'https://1.2.3.256',
    'https://1.2.3.1000', 'https://01.2.3.4', 'https://1.2.3.04', 'https://0x1.2.3.4', 'https://1.2.3.4.', 'https://1.2..4', 'https://1.2.3.0x4',
    // a percent escape or a letter outside ASCII in the host
    'https://%68.example', 'https://h%2eexample', 'https://h%00', 'https://%31%32%37.0.0.1', 'https://b\u00fccher.example', 'https://\uff48', 'https://h\u3002example', 'https://\u24d7.example', 'https://h\u00ad.example', 'https://\u0131.example',
    // IPv6 in any form but [::1]
    'https://[0:0:0:0:0:0:0:1]', 'http://[0:0:0:0:0:0:0:1]:1', 'https://[::1]x', 'https://[::1', 'https://::1]', 'https://::1', 'https://[::]', 'https://[]', 'https://[::2]', 'http://[::2]:1', 'https://[::ffff:127.0.0.1]',
    'http://[::ffff:127.0.0.1]:1', 'http://[::ffff:7f00:1]:1', 'https://[::127.0.0.1]', 'https://[fe80::1%25en0]', 'https://[fe80::1%en0]', 'https://[::1%lo0]', 'http://[::1%25lo0]:1', 'https://[::0001]', 'https://[0::1]',
    'https://[::01]', 'https://[2001:db8::1]', 'https://[2001:DB8::1]', 'https://[::1].', 'https://[[::1]]', 'https://[::1]]', 'https://[::1][::1]', 'https://[localhost]', 'https://[127.0.0.1]',
    // a port that is the scheme's own, empty, zero, out of range, or not decimal digits with no leading zero
    'https://h:443', 'http://127.0.0.1:80', 'http://localhost:80', 'http://[::1]:80', 'https://[::1]:443', 'http://example.com:80', 'https://h:', 'https://[::1]:', 'https://h:0', 'https://h:00', 'https://h:080', 'https://h:0443',
    'https://h:65536', 'https://h:99999', 'https://h:100000', 'https://h:+1', 'https://h:-1', 'https://h:1:2', 'https://h::1', 'https://h:1e3', 'https://h:0x50', 'https://h:\u0661', 'https://h:\uff11', 'https://h:1a', 'https://h:a',
    // white space, a line end, a NUL or another control character, anywhere
    ' https://api.example.com', 'https://api.example.com ', 'https://api.example.com/a b', 'https://api.example.com/\t', 'https:// h', 'https://h /', 'https://h\t', 'https://\th', 'ht\ttps://h', 'https://h\n', '\nhttps://h',
    'https://h\r\n', 'https://h/\n', 'https://h\n.example', 'https://h\u000b', 'https://h\u000c', 'https://h\u0000', 'https://h/a\u0000', '\u0000https://h', 'https://h\u0000.example', 'https://h:1\u0000', 'https://h\u0001',
    'https://h\u001f', 'https://h\u007f', 'https://h\u0080', 'https://h\u0085', 'https://h\u00a0', 'https://h\u2028', 'https://h\u2029', 'https://h\u200b', 'https://h\ufeff', '\ufeffhttps://h', 'https://h/\u001c',
    // a backslash
    'https:\\\\h', 'https://h\\', 'https://api.example.com\\x', 'https:/\\h', 'https://h/a\\b', 'https://h\\@x',
    // user information, a query, a fragment
    'https://@api.example.com', 'https://u@h', 'https://u:p@h', 'https://h@', 'https://api.example.com/a@b', 'https://h?', 'https://h?x', 'https://h#', 'https://api.example.com/#', 'https://api.example.com/?',
    // not a scheme, "//", a host and a path; or another scheme
    'https:api.example.com', 'https:/api.example.com', 'http:127.0.0.1:1', 'https:///h', 'https:////h', 'https://', 'https:///', 'api.example.com', 'h', '//h', '://h', 'file:///etc/x', 'ftp://example.com', 'ws://h', 'wss://h',
    'not a url', 'https+x://h', 'httpss://h',
    // plain http to a host that is not one of the two literal addresses 127.0.0.1 and [::1]: the name localhost is such a host
    'http://example.com', 'http://127.0.0.2:1', 'http://0.0.0.0:1', 'http://localhost.localdomain:1', 'http://127.0.0.1.example:1', 'http://localhost.example:1', 'http://api.anthropic.com',
    'http://localhost', 'http://localhost:1', 'http://localhost:18765', 'http://localhost:8080/p', 'http://localhost/', 'http://ip6-localhost:1', 'http://127.1.2.3:1', 'http://h:1',
    // a path that is not plain segments
    ...PATHS.map((p) => `https://h${p}`),
    ...PATHS.map((p) => `http://127.0.0.1:1${p}/`),
  ];

  /** Addresses made from parts, good and bad, and then changed by one character at a place the seed picks: the same list on every run. */
  function madeAddresses(count: number): string[] {
    const rng = mulberry32(seedFromString('the two graders, one address rule'));
    const pick = <T>(xs: readonly T[]): T => xs[randomInt(rng, xs.length)]!;
    const schemes = ['https', 'https', 'https', 'http', 'http', 'HTTPS', 'Http', 'ftp', 'https:', ''];
    const labels = ['a', 'h', 'api', 'example', 'com', 'localhost', 'a-b', 'a1', '1a', '0', '1', '7', '10', '127', '255', '256', '01', '0x7f', 'x0', 'xn--a', 'ab--c', 'a--b', '-a', 'a-', 'A', 'a_b', '', '%61', 'é', LABEL_63, `${LABEL_63}a`];
    const goodLabels = ['a', 'h', 'api', 'example', 'com', 'localhost', 'a-b', 'a1', '1a', '0', '127', 'x0', 'a--b', LABEL_63];
    const wholeHosts = ['localhost', '127.0.0.1', '[::1]', '[::1]', '[::]', '[0::1]', '[::1', '::1', '1.2.3.4', '0.0.0.0', '255.255.255.255', 'api.anthropic.com'];
    const ports = ['', '', '', ':1', ':80', ':443', ':8080', ':18765', ':65535', ':65536', ':0', ':01', ':', ':a', ':1:2', ':+1'];
    const paths = ['', '', '/', '//', '/a', '/a/', '/a/b', '/A.b_c~d-e', '/..', '/.', '/a//b', '/%41', '/a b', '/a?b', '/a#b', '/...'];
    const strange = ['.', '-', ':', '/', '@', '\\', '%', '[', ']', ' ', '\t', '\n', '\u0000', '\u007f', '\u00e9', 'A', 'Z', '0', '9', 'x', '_', '?', '#', '+', '~'];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      // Half of them from parts that are all good, so that a single change decides; the rest from every part.
      const good = randomInt(rng, 2) === 0;
      const part = <T>(all: readonly T[], sound: readonly T[]): T => pick(good ? sound : all);
      const name = (): string => [...Array.from({ length: randomInt(rng, 3) }, () => part(labels, goodLabels)), pick(goodLabels.slice(0, 4))].join('.');
      const scheme = part(schemes, ['https', 'https', 'http']);
      const host = randomInt(rng, 3) === 0 ? part(wholeHosts, scheme === 'http' ? ['127.0.0.1', '[::1]'] : ['localhost', '127.0.0.1', '[::1]', '1.2.3.4', 'api.anthropic.com']) : good && scheme === 'http' ? '127.0.0.1' : good ? name() : Array.from({ length: 1 + randomInt(rng, 4) }, () => pick(labels)).join('.');
      let address = `${scheme}://${host}${part(ports, ['', '', ':1', ':8080', ':18765', ':65535'])}${part(paths, ['', '/', '//', '/a', '/a/', '/a/b', '/A.b_c~d-e', '/...'])}`;
      const change = randomInt(rng, good ? 6 : 4);
      const at = randomInt(rng, address.length + 1);
      if (change === 0) address = address.slice(0, at) + pick(strange) + address.slice(at);
      else if (change === 1) address = address.slice(0, at) + pick(strange) + address.slice(at + 1);
      out.push(address);
    }
    return out;
  }

  it('each address is taken by both graders, with one endpoint, or refused by both; the importers refuse what the graders refuse, and nothing else', (t) => {
    const venv = process.env['ANCHORSET_INSPECT_VENV'];
    const py = [...(venv === undefined ? [] : [join(venv, 'bin', 'python')]), 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import inspect_ai']).status === 0);
    if (py === undefined) {
      t.skip('no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)');
      return;
    }
    const made = madeAddresses(6000);
    const urls = [...TAKEN.map(([u]) => u), ...REFUSED, ...made];
    assert.equal(new Set([...TAKEN.map(([u]) => u), ...REFUSED]).size, TAKEN.length + REFUSED.length, 'an address is listed twice');
    const d = `
import json, sys
sys.path.insert(0, ${JSON.stringify(new URL('../examples/importers/inspect', import.meta.url).pathname)})
import recording_grader as rg
out = []
for u in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    try:
        host, origin, port, secure, prefix, posted = rg.parse_base_url(u)
        out.append(origin + posted)
    except ValueError:
        out.append(None)
print(json.dumps(out))
`;
    const r = spawnSync(py, ['-c', d], { input: JSON.stringify(urls), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env['PATH'] ?? '', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(r.status, 0, r.stderr);
    const python = JSON.parse(r.stdout) as (string | null)[];
    const Grader = loadGrader();
    const javascript = urls.map((baseUrl) => {
      try {
        return (new Grader({ id: 'file://grader-provider.cjs', config: { model: 'judge-requested', max_tokens: 256, ...STATED, baseUrl } }) as unknown as { target: { url: string } }).target.url;
      } catch {
        return null;
      }
    });
    assert.equal(python.length, urls.length);
    // Every address, the listed and the made: one answer from both graders, and the importers' check agrees.
    urls.forEach((u, i) => {
      assert.equal(javascript[i], python[i], `${JSON.stringify(u)}: the JavaScript grader ${JSON.stringify(javascript[i])}, the Python grader ${JSON.stringify(python[i])}`);
      assert.equal(graderBaseUrlProblem(u) === undefined, javascript[i] !== null, JSON.stringify(u));
    });
    // The listed ones: the answer is the one written here, not only the same on both sides.
    TAKEN.forEach(([u, endpoint], i) => assert.equal(javascript[i], endpoint, u));
    REFUSED.forEach((u, i) => assert.equal(javascript[TAKEN.length + i], null, JSON.stringify(u)));
    // A taken address is recorded as it was written: the endpoint opens with the address, less its closing slashes.
    urls.forEach((u, i) => {
      if (javascript[i] !== null) assert.equal(javascript[i], `${u.replace(/\/+$/, '')}/v1/messages`, u);
    });
    // Both kinds are among the made addresses, in number.
    const madeTaken = javascript.slice(TAKEN.length + REFUSED.length).filter((x) => x !== null).length;
    assert.ok(madeTaken > 300 && made.length - madeTaken > 2000, `${madeTaken} of ${made.length} made addresses were taken`);
    assert.ok(TAKEN.length >= 40 && REFUSED.length >= 200);
  });

  it('the JavaScript grader and the importers refuse every listed address with no Python at hand, and take the others as written', () => {
    for (const [u, endpoint] of TAKEN) {
      assert.equal((make({ baseUrl: u }) as unknown as { target: { url: string } }).target.url, endpoint, u);
      assert.equal(graderBaseUrlProblem(u), undefined, u);
    }
    for (const u of REFUSED) {
      assert.throws(() => make({ baseUrl: u }), /^Error: grader: baseUrl /, JSON.stringify(u));
      assert.notEqual(graderBaseUrlProblem(u), undefined, JSON.stringify(u));
    }
  });

  it('plain http is taken for the literal addresses 127.0.0.1 and [::1] and for no name: http to localhost is refused in the words of that rule, and https to localhost is taken', () => {
    for (const u of ['http://localhost', 'http://localhost:1', 'http://localhost:18765', 'http://localhost:18765/p', 'http://example.com', 'http://127.0.0.2:1']) {
      assert.throws(() => make({ baseUrl: u }), (e: Error) => e.message === 'grader: baseUrl must be https (http only for 127.0.0.1 and [::1])', u);
      assert.equal(graderBaseUrlProblem(u), 'is plain http to a host that is not 127.0.0.1 or [::1]', u);
    }
    for (const u of ['http://127.0.0.1:18765', 'http://[::1]:18765', 'https://localhost', 'https://localhost:8443']) {
      assert.doesNotThrow(() => make({ baseUrl: u }), u);
      assert.equal(graderBaseUrlProblem(u), undefined, u);
    }
    const source = readFileSync(GRADER_PATH, 'utf8');
    assert.ok(source.includes("const LOOPBACK = new Set(['127.0.0.1', '[::1]']);"));
    assert.ok(!source.includes('(localhost, 127.0.0.1, [::1])') && !source.includes('for a loopback host'));
  });

  it('no refusal shows the address', () => {
    for (const u of ['https://SECRET-token.example', 'https://secret-token.example:443', 'https://secret-token.example./x', 'https://[secret-token]', 'https://h:secret-token', 'https://secret_token.example']) {
      assert.throws(() => make({ baseUrl: u }), (e: Error) => !/secret/i.test(e.message), u);
      assert.doesNotMatch(String(graderBaseUrlProblem(u)), /secret/i);
    }
  });
});
