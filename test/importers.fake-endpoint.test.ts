import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LONG_REPLY_DEFAULT, MESSAGES_ONLY_MODES, MODES, OPENAI_ONLY_MODES, OPENAI_ROUTE_MODES, SERVED_DATED_MARKER, SERVED_SUFFIX, startFakeEndpoint, verdictOf } from '../examples/importers/fake-endpoint.ts';
import type { FakeEndpointOptions, Mode } from '../examples/importers/fake-endpoint.ts';

const SECRET = 'test-dummy-credential-123';

async function withEndpoint(opts: FakeEndpointOptions, fn: (url: string, logPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-endpoint-'));
  const logPath = join(dir, 'log.jsonl');
  const ep = await startFakeEndpoint({ port: 0, logPath, ...opts });
  try {
    await fn(`http://127.0.0.1:${ep.port}`, logPath);
  } finally {
    await ep.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Reply { status: number; json: any; headers: Headers }
async function ask(url: string, prompt: string, model = 'judge-a', extra: Record<string, unknown> = {}): Promise<Reply> {
  const r = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-api-key': SECRET, authorization: `Bearer ${SECRET}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 256, system: 'Be a judge.', messages: [{ role: 'user', content: prompt }], ...extra }),
  });
  return { status: r.status, json: await r.json(), headers: r.headers };
}
const text = (r: Reply): string => r.json.content.map((b: any) => b.text ?? '').join('');

test('response shape: a Messages-style message with one text block and a clean stop', async () => {
  await withEndpoint({}, async (url) => {
    const r = await ask(url, 'Grade this.');
    assert.equal(r.status, 200);
    assert.equal(r.json.type, 'message');
    assert.equal(r.json.role, 'assistant');
    assert.equal(r.json.id, 'msg_fake_0001');
    assert.equal(r.json.stop_reason, 'end_turn');
    assert.deepEqual(r.json.content.map((b: any) => b.type), ['text']);
    assert.deepEqual(JSON.parse(text(r)), { pass: true, score: 1, reason: 'Local fake judge: pass.' });
    assert.equal((await ask(url, 'again')).json.id, 'msg_fake_0002');
  });
});

test('verdict rule: markers, strict judge, default pass; fail wins over pass', async () => {
  assert.equal(verdictOf('plain', 'judge-a'), 'pass');
  assert.equal(verdictOf('[[verdict:fail]]', 'judge-a'), 'fail');
  assert.equal(verdictOf('[[verdict:pass]]', 'judge-a'), 'pass');
  assert.equal(verdictOf('[[verdict:pass]] [[verdict:fail]]', 'judge-a'), 'fail');
  assert.equal(verdictOf('[[strict:fail]]', 'judge-a'), 'pass');
  assert.equal(verdictOf('[[strict:fail]]', 'judge-strict'), 'fail');
  await withEndpoint({}, async (url) => {
    assert.equal(JSON.parse(text(await ask(url, 'x [[verdict:fail]]'))).pass, false);
    assert.equal(JSON.parse(text(await ask(url, 'x [[strict:fail]]', 'judge-a'))).pass, true);
    assert.equal(JSON.parse(text(await ask(url, 'x [[strict:fail]]', 'judge-strict'))).pass, false);
  });
});

test('grade format: sentence, blank line, GRADE letter; by flag and by marker', async () => {
  await withEndpoint({ replyFormat: 'grade' }, async (url) => {
    assert.match(text(await ask(url, 'ok')), /\n\nGRADE: C$/);
    assert.match(text(await ask(url, 'no [[verdict:fail]]')), /\n\nGRADE: I$/);
    assert.equal(JSON.parse(text(await ask(url, 'x [[format:json]]'))).pass, true);
  });
});

test('grade P marker: the reply ends GRADE: P in either format, whatever the verdict rule says', async () => {
  await withEndpoint({}, async (url) => {
    assert.match(text(await ask(url, 'x [[grade:p]]')), /\n\nGRADE: P$/);
    assert.match(text(await ask(url, 'x [[grade:p]] [[verdict:fail]]')), /\n\nGRADE: P$/);
    assert.match(text(await ask(url, 'x [[grade:p]] [[mode:prose]]')), /GRADE: P/);
    assert.equal(JSON.parse(text(await ask(url, 'x'))).pass, true); // without the marker nothing changes
  });
  await withEndpoint({ replyFormat: 'grade' }, async (url) => {
    assert.match(text(await ask(url, 'no marker')), /\n\nGRADE: C$/);
    assert.match(text(await ask(url, 'x [[grade:p]]')), /\n\nGRADE: P$/);
  });
});

test('served id differs from the requested one', async () => {
  await withEndpoint({}, async (url) => {
    const r = await ask(url, 'x', 'judge-a');
    assert.notEqual(r.json.model, 'judge-a');
    assert.equal(r.json.model, `judge-a${SERVED_SUFFIX}`);
  });
});

test('request log: one JSON line per request, full body, credential values redacted, no key anywhere', async () => {
  await withEndpoint({}, async (url, logPath) => {
    await ask(url, 'first');
    await ask(url, 'second [[verdict:fail]]');
    const raw = readFileSync(logPath, 'utf8');
    assert.ok(!raw.includes(SECRET), 'the key must not be in the log');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[0].method, 'POST');
    assert.equal(lines[0].path, '/v1/messages');
    assert.equal(lines[0].headers['x-api-key'], '<redacted>');
    assert.equal(lines[0].headers['authorization'], '<redacted>');
    assert.equal(lines[0].headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(lines[0].bodyJson, { model: 'judge-a', max_tokens: 256, system: 'Be a judge.', messages: [{ role: 'user', content: 'first' }] });
    assert.equal(lines[1].verdict, 'fail');
    assert.equal(lines[1].response.status, 200);
  });
});

test('unknown route and bad bodies are answered 404 / 400 and still logged', async () => {
  await withEndpoint({}, async (url, logPath) => {
    assert.equal((await fetch(`${url}/other`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${url}/v1/messages`)).status, 404);
    assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', body: '{"model":"m"}' })).status, 400);
    assert.equal((await ask(url, 'x [[mode:bogus]]')).status, 400);
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 5);
  });
});

test('failure modes (flag and marker): each produces the documented reply', async () => {
  const expectations: Record<string, (r: Reply) => void> = {
    normal: (r) => { assert.equal(r.json.stop_reason, 'end_turn'); assert.equal(JSON.parse(text(r)).pass, true); },
    truncated: (r) => {
      assert.equal(r.json.stop_reason, 'max_tokens');
      assert.throws(() => JSON.parse(text(r)));
      assert.ok(text(r).startsWith('{"pass"'));
    },
    'no-verdict': (r) => { assert.equal(r.json.stop_reason, 'end_turn'); assert.deepEqual(Object.keys(JSON.parse(text(r))), ['reason']); },
    prose: (r) => {
      assert.equal(r.json.stop_reason, 'end_turn');
      assert.throws(() => JSON.parse(text(r)));
      assert.ok(text(r).startsWith('Here is my verdict: {"pass":true'));
    },
    empty: (r) => { assert.equal(text(r), ''); assert.equal(r.json.stop_reason, 'end_turn'); },
    'not-json': (r) => { assert.throws(() => JSON.parse(text(r))); assert.ok(!text(r).includes('pass')); },
    refusal: (r) => assert.equal(r.json.stop_reason, 'refusal'),
    'stop-seq': (r) => assert.equal(r.json.stop_reason, 'stop_sequence'),
    'tool-use': (r) => { assert.equal(r.json.stop_reason, 'tool_use'); assert.deepEqual(r.json.content.map((b: any) => b.type), ['tool_use']); },
    'non-text': (r) => assert.deepEqual(r.json.content.map((b: any) => b.type), ['thinking', 'text']),
    'http-500': (r) => { assert.equal(r.status, 500); assert.equal(r.json.type, 'error'); },
    redirect: (r) => { assert.equal(r.status, 307); assert.equal(r.headers.get('location'), '/v1/messages'); },
    'http-429': (r) => { assert.equal(r.status, 429); assert.equal(r.json.type, 'error'); },
    'http-529': (r) => { assert.equal(r.status, 529); assert.equal(r.json.type, 'error'); },
    'http-400': (r) => { assert.equal(r.status, 400); assert.equal(r.json.type, 'error'); },
    // The client here decodes the body, so the reply reads as a clean one; the header says how it came.
    encoded: (r) => { assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'gzip'); assert.equal(JSON.parse(text(r)).pass, true); },
  };
  // The two modes that give no response at all have a test of their own below: there is no reply to look at here.
  const NO_RESPONSE = ['stall', 'drop'];
  const answering = MODES.filter((m) => !NO_RESPONSE.includes(m));
  assert.deepEqual([...Object.keys(expectations), ...NO_RESPONSE].sort(), [...MODES].sort());
  for (const mode of answering) {
    await withEndpoint({}, async (url) => {
      expectations[mode]!(await ask(url, `x [[mode:${mode}]]`));
    });
    await withEndpoint({ mode }, async (url) => {
      expectations[mode]!(await ask(url, 'x'));
    });
  }
  // the marker wins over the flag
  await withEndpoint({ mode: 'empty' }, async (url) => {
    assert.equal(JSON.parse(text(await ask(url, 'x [[mode:normal]]'))).pass, true);
  });
});

test('long-reply mode: filler before the verdict, by flag and by marker', async () => {
  await withEndpoint({ longReply: 20000 }, async (url) => {
    const t = text(await ask(url, 'x'));
    assert.equal(t.length, 20000 + 2 + JSON.stringify({ pass: true, score: 1, reason: 'Local fake judge: pass.' }).length);
    assert.equal(JSON.parse(t.slice(t.indexOf('\n\n') + 2)).pass, true);
  });
  await withEndpoint({ replyFormat: 'grade' }, async (url) => {
    const t = text(await ask(url, 'x [[long-reply]]'));
    assert.ok(t.length > LONG_REPLY_DEFAULT);
    assert.match(t, /\n\nGRADE: C$/);
    assert.ok(text(await ask(url, 'short')).length < 100);
  });
});

test('binding: loopback only; a non-loopback host is refused, the default port is fixed, 0 gives a free one', async () => {
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.5', '::1', '']) {
    await assert.rejects(startFakeEndpoint({ host, port: 0 }), /127\.0\.0\.1 only/);
  }
  const ep = await startFakeEndpoint({ port: 0 });
  try {
    assert.equal(ep.host, '127.0.0.1');
    assert.ok(ep.port > 0);
    const addr = ep.server.address();
    assert.ok(addr !== null && typeof addr === 'object' && addr.address === '127.0.0.1');
  } finally {
    await ep.close();
  }
  await assert.rejects(startFakeEndpoint({ port: 70000 }), /invalid port/);
  await assert.rejects(startFakeEndpoint({ port: 0, mode: 'bogus' as never }), /unknown mode/);
});

test('a port already in use: the message says another endpoint may still be running, and names the port', async () => {
  const first = await startFakeEndpoint({ port: 0 });
  try {
    await assert.rejects(startFakeEndpoint({ port: first.port }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, new RegExp(`^127\\.0\\.0\\.1:${first.port} is already in use; `));
      assert.match(e.message, /another fake endpoint \(or a leftover of an earlier rehearsal\) may still be running/);
      assert.match(e.message, /--port/);
      return true;
    });
  } finally {
    await first.close();
  }
});

test('an existing --log file is refused and left as it was, never truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-endpoint-log-'));
  try {
    const logPath = join(dir, 'keep.jsonl');
    writeFileSync(logPath, 'an earlier log\n');
    await assert.rejects(startFakeEndpoint({ port: 0, logPath }), /exists/);
    assert.equal(readFileSync(logPath, 'utf8'), 'an earlier log\n');
    // a fresh path still works, and the log starts empty
    const fresh = join(dir, 'fresh.jsonl');
    const ep = await startFakeEndpoint({ port: 0, logPath: fresh });
    await ep.close();
    assert.equal(readFileSync(fresh, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('thinking marker: an empty thinking text with a signature, then the text block, and a thinking-token count', async () => {
  await withEndpoint({}, async (url) => {
    const r = await ask(url, 'x [[thinking]]');
    assert.equal(r.status, 200);
    assert.equal(r.json.stop_reason, 'end_turn');
    assert.deepEqual(r.json.content.map((b: any) => b.type), ['thinking', 'text']);
    assert.equal(r.json.content[0].thinking, '');
    assert.ok(typeof r.json.content[0].signature === 'string' && r.json.content[0].signature.length > 0);
    assert.equal(JSON.parse(r.json.content[1].text).pass, true);
    assert.equal(r.json.usage.output_tokens_details.thinking_tokens, 12);
    // without the marker: one text block and a counter of zero
    const plain = await ask(url, 'x');
    assert.deepEqual(plain.json.content.map((b: any) => b.type), ['text']);
    assert.equal(plain.json.usage.output_tokens_details.thinking_tokens, 0);
  });
});

test('no-counter marker: the response has no thinking-token counter, with or without a thinking block', async () => {
  await withEndpoint({}, async (url) => {
    const a = await ask(url, 'x [[no-counter]]');
    assert.deepEqual(a.json.content.map((b: any) => b.type), ['text']);
    assert.equal('output_tokens_details' in a.json.usage, false);
    const b = await ask(url, 'x [[thinking]] [[no-counter]]');
    assert.deepEqual(b.json.content.map((x: any) => x.type), ['thinking', 'text']);
    assert.equal('output_tokens_details' in b.json.usage, false);
    assert.equal(b.json.usage.output_tokens, 20);
  });
});

test('redacted-thinking marker: a redacted block with data, then the text block', async () => {
  await withEndpoint({}, async (url) => {
    const r = await ask(url, 'x [[redacted-thinking]]');
    assert.deepEqual(r.json.content.map((b: any) => b.type), ['redacted_thinking', 'text']);
    assert.ok(typeof r.json.content[0].data === 'string' && r.json.content[0].data.length > 0);
    assert.equal('thinking' in r.json.content[0], false);
    assert.equal(r.json.usage.output_tokens_details.thinking_tokens, 12);
  });
});

test('fence marker: the reply is the verdict object inside one json code fence', async () => {
  await withEndpoint({}, async (url) => {
    const t = text(await ask(url, 'x [[fence]]'));
    assert.match(t, /^```json\n\{.*\}\n```$/s);
    assert.equal(JSON.parse(t.split('\n')[1] as string).pass, true);
    assert.equal(JSON.parse(text(await ask(url, 'x'))).pass, true); // no marker, no fence
  });
});

test('the two request keys, thinking and output_config, are accepted and logged as sent; their absence is logged as absence', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const sent = { thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort: 'high' } };
    assert.equal((await ask(url, 'one', 'judge-a', sent)).status, 200);
    assert.equal((await ask(url, 'two')).status, 200);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines[0].bodyJson.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.deepEqual(lines[0].bodyJson.output_config, { effort: 'high' });
    assert.equal('thinking' in lines[1].bodyJson, false);
    assert.equal('output_config' in lines[1].bodyJson, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The modes that give no reply, and the one stateful marker
// ---------------------------------------------------------------------------------------------------------------

type RawReply = { status: number; json: any };
/** A request sent as raw bytes: the status and the parsed body, or the name of the error when no answer came. */
async function askRaw(url: string, body: string, timeoutMs = 4000): Promise<RawReply | { failed: string }> {
  try {
    const r = await fetch(`${url}/v1/messages`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { failed: (e as Error).name };
  }
}
const answered = async (url: string, body: string): Promise<RawReply> => {
  const r = await askRaw(url, body);
  if ('failed' in r) throw new Error(`no answer: ${r.failed}`);
  return r;
};
const bodyOf = (prompt: string, model = 'judge-a'): string => JSON.stringify({ model, max_tokens: 256, messages: [{ role: 'user', content: prompt }] });
const logOf = (logPath: string): any[] => readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('[[times:1:truncated]]: the first request is cut and the second, with the same body, is whole', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const body = bodyOf('grade this [[times:1:truncated]]');
    const first = await answered(url, body);
    const second = await answered(url, body);
    const third = await answered(url, body);
    assert.deepEqual([first.status, first.json.stop_reason], [200, 'max_tokens']);
    assert.deepEqual([second.status, second.json.stop_reason], [200, 'end_turn']);
    assert.deepEqual(JSON.parse(second.json.content[0].text), { pass: true, score: 1, reason: 'Local fake judge: pass.' });
    assert.equal(third.json.stop_reason, 'end_turn');
    assert.deepEqual(logOf(logPath).map((l) => l.mode), ['truncated', 'normal', 'normal']);
  });
});

test('[[times:1:truncated]]: a body that differs by one byte is cut again', async () => {
  await withEndpoint({}, async (url) => {
    const a = bodyOf('grade this [[times:1:truncated]]');
    const b = bodyOf('grade this [[times:1:truncated]] ');
    assert.equal((await answered(url, a)).json.stop_reason, 'max_tokens');
    assert.equal((await answered(url, b)).json.stop_reason, 'max_tokens');
    // Equal JSON values in other bytes are another body: the counter is on the bytes, not on the parsed value.
    const spaced = a.replace('{"model"', '{ "model"');
    assert.deepEqual(JSON.parse(spaced), JSON.parse(a));
    assert.equal((await answered(url, spaced)).json.stop_reason, 'max_tokens');
    assert.equal((await answered(url, a)).json.stop_reason, 'end_turn');
    assert.equal((await answered(url, b)).json.stop_reason, 'end_turn');
  });
});

test('[[times:<n>:<mode>]]: the first n equal requests get the mode, later ones the mode that holds without the marker', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const body = bodyOf('x [[times:2:http-529]] [[mode:no-verdict]]');
    const got: number[] = [];
    for (let i = 0; i < 4; i++) got.push((await answered(url, body)).status);
    assert.deepEqual(got, [529, 529, 200, 200]);
    assert.deepEqual(logOf(logPath).map((l) => l.mode), ['http-529', 'http-529', 'no-verdict', 'no-verdict']);
  });
  // The counter is this server's own, and 9 is the most it counts to.
  await withEndpoint({ mode: 'prose' }, async (url, logPath) => {
    const body = bodyOf('x [[times:9:truncated]]');
    for (let i = 0; i < 10; i++) await answered(url, body);
    assert.deepEqual(logOf(logPath).map((l) => l.mode), [...Array.from({ length: 9 }, () => 'truncated'), 'prose']);
  });
});

test('the modes http-429, http-529, http-400, stall and drop answer as documented', async () => {
  for (const m of ['http-429', 'http-529', 'http-400', 'stall', 'drop']) assert.ok((MODES as readonly string[]).includes(m), m);
  await withEndpoint({}, async (url, logPath) => {
    const r429 = await answered(url, bodyOf('a [[mode:http-429]]'));
    assert.deepEqual([r429.status, r429.json.type, r429.json.error.type], [429, 'error', 'rate_limit_error']);
    const r529 = await answered(url, bodyOf('a [[mode:http-529]]'));
    assert.deepEqual([r529.status, r529.json.type, r529.json.error.type], [529, 'error', 'overloaded_error']);
    const r400 = await answered(url, bodyOf('a [[mode:http-400]]'));
    assert.deepEqual([r400.status, r400.json.type, r400.json.error.type], [400, 'error', 'invalid_request_error']);
    // drop: the socket is closed with no response at all.
    assert.deepEqual(await askRaw(url, bodyOf('a [[mode:drop]]')), { failed: 'TypeError' });
    // stall: the request is never answered; the client's own deadline ends it.
    const t0 = Date.now();
    assert.deepEqual(await askRaw(url, bodyOf('a [[mode:stall]]'), 300), { failed: 'TimeoutError' });
    assert.ok(Date.now() - t0 >= 250);
    const log = logOf(logPath);
    assert.deepEqual(log.map((l) => l.mode), ['http-429', 'http-529', 'http-400', 'drop', 'stall']);
    // A request that got no reply is still in the log, and the log says so in place of a status.
    assert.deepEqual(log.slice(3).map((l) => l.response), [{ status: 'NO_RESPONSE', body: 'drop' }, { status: 'NO_RESPONSE', body: 'stall' }]);
  });
  // By flag as well as by marker.
  await withEndpoint({ mode: 'http-429' }, async (url) => {
    assert.equal((await answered(url, bodyOf('plain'))).status, 429);
  });
});

test('a stalled request does not keep the server from closing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-endpoint-'));
  try {
    const ep = await startFakeEndpoint({ port: 0, logPath: join(dir, 'log.jsonl'), mode: 'stall' });
    const pending = askRaw(`http://127.0.0.1:${ep.port}`, bodyOf('x'), 5000);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await ep.close();
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(await pending, { failed: 'TypeError' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without the marker, two equal requests get equal replies but for the id', async () => {
  await withEndpoint({}, async (url) => {
    const body = bodyOf('grade this [[strict:fail]]', 'judge-strict');
    const a = await answered(url, body);
    const b = await answered(url, body);
    assert.deepEqual([a.json.id, b.json.id], ['msg_fake_0001', 'msg_fake_0002']);
    assert.deepEqual({ ...a.json, id: '' }, { ...b.json, id: '' });
    assert.equal(a.status, b.status);
  });
  // A failure mode without the marker never ends: no counter is kept for it.
  await withEndpoint({}, async (url) => {
    const body = bodyOf('grade this [[mode:truncated]]');
    for (let i = 0; i < 3; i++) assert.equal((await answered(url, body)).json.stop_reason, 'max_tokens');
  });
});

test('[[times:0:truncated]] and [[times:1:nonsense]] are answered 400', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const bad = [
      '[[times:0:truncated]]', '[[times:1:nonsense]]', '[[times:10:truncated]]', '[[times:-1:truncated]]', '[[times:1.5:truncated]]', '[[times::truncated]]', '[[times:1:]]', '[[times:1]]',
      '[[times:x:truncated]]', '[[times:01:truncated]]',
      // Two markers in one prompt: which one counts is not defined, so neither does.
      '[[times:1:truncated]] [[times:1:http-529]]', '[[times:1:truncated]] [[times:1:truncated]]',
      // A marker that opens and is never closed.
      '[[times:1:truncated',
    ];
    for (const marker of bad) {
      const r = await answered(url, bodyOf(`grade ${marker}`));
      assert.equal(r.status, 400, marker);
      assert.equal(r.json.error.type, 'invalid_request_error', marker);
      assert.match(r.json.error.message, /times/, marker);
    }
    // Never silently treated as normal, and never counted: the same body is refused again.
    assert.equal((await answered(url, bodyOf('grade [[times:0:truncated]]'))).status, 400);
    assert.ok(logOf(logPath).every((l) => l.response.status === 400));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Responses route: POST /v1/responses
// ---------------------------------------------------------------------------------------------------------------

interface RReply { status: number; json: any; headers: Headers }
/** A request to the Responses route, with the body in the form the grader sends (instructions, then input as messages). */
async function askR(url: string, prompt: string, model = 'judge-a', extra: Record<string, unknown> = {}): Promise<RReply> {
  const r = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ model, input: [{ role: 'user', content: prompt }], instructions: 'Be a judge.', max_output_tokens: 256, store: false, truncation: 'disabled', ...extra }),
  });
  return { status: r.status, json: await r.json(), headers: r.headers };
}
const textR = (r: RReply): string => r.json.output.flatMap((i: any) => (i.type === 'message' ? i.content : [])).map((p: any) => p.text ?? '').join('');
const types = (r: RReply): string[] => r.json.output.map((i: any) => (i.type === 'message' ? `message/${i.content.map((p: any) => p.type).join('+')}` : i.type));
const RESPONSE_KEYS = ['error', 'id', 'incomplete_details', 'model', 'object', 'output', 'previous_response_id', 'status', 'store', 'truncation', 'usage'];

test('Responses route, shape: object, completed, null error and details, an echo of truncation and store, one message item', async () => {
  await withEndpoint({}, async (url) => {
    const r = await askR(url, 'Grade this.');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), RESPONSE_KEYS);
    assert.equal(r.json.id, 'resp_fake_0001');
    assert.equal(r.json.object, 'response');
    assert.equal(r.json.status, 'completed');
    assert.equal(r.json.error, null);
    assert.equal(r.json.incomplete_details, null);
    assert.equal(r.json.truncation, 'disabled');
    assert.equal(r.json.store, false);
    assert.equal(r.json.previous_response_id, null);
    assert.deepEqual(r.json.output, [{ type: 'message', id: 'msg_fake_0001', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: textR(r), annotations: [] }] }]);
    assert.deepEqual(JSON.parse(textR(r)), { pass: true, score: 1, reason: 'Local fake judge: pass.' });
    assert.deepEqual(r.json.usage, { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 });
    assert.equal((await askR(url, 'again')).json.id, 'resp_fake_0002');
  });
});

test('Responses route, served id: the requested id by default, a dated one under [[served:dated]]; the Messages route keeps its suffix', async () => {
  await withEndpoint({}, async (url) => {
    assert.equal((await askR(url, 'x', 'judge-a')).json.model, 'judge-a');
    assert.equal((await askR(url, `x ${SERVED_DATED_MARKER}`, 'judge-a')).json.model, `judge-a${SERVED_SUFFIX}`);
    assert.equal((await ask(url, 'x', 'judge-a')).json.model, `judge-a${SERVED_SUFFIX}`);
    // The marker has no counterpart on the Messages route: refused, never silently ignored.
    const m = await ask(url, `x ${SERVED_DATED_MARKER}`);
    assert.equal(m.status, 400);
    assert.equal(m.json.type, 'error');
  });
});

test('Responses route, prompt: instructions and input (a string, or messages with string or part content) feed the verdict rule', async () => {
  await withEndpoint({}, async (url) => {
    const post = async (b: Record<string, unknown>): Promise<any> => (await fetch(`${url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'judge-strict', ...b }) })).json();
    const pass = (j: any): boolean => JSON.parse(j.output[0].content[0].text).pass;
    assert.equal(pass(await post({ input: 'plain' })), true);
    assert.equal(pass(await post({ input: 'x [[verdict:fail]]' })), false);
    assert.equal(pass(await post({ instructions: '[[verdict:fail]]', input: 'plain' })), false);
    assert.equal(pass(await post({ input: [{ role: 'user', content: [{ type: 'input_text', text: '[[strict:fail]]' }] }] })), false);
    const graded = await post({ input: 'x [[format:grade]]' });
    assert.match(graded.output[0].content[0].text, /GRADE: C$/);
  });
});

test('Responses route, log: the whole body as sent, the path, and credential redaction', async () => {
  await withEndpoint({}, async (url, logPath) => {
    await askR(url, 'first');
    const raw = readFileSync(logPath, 'utf8');
    assert.ok(!raw.includes(SECRET));
    const line = logOf(logPath)[0];
    assert.equal(line.path, '/v1/responses');
    assert.equal(line.headers['authorization'], '<redacted>');
    assert.deepEqual(line.bodyJson, { model: 'judge-a', input: [{ role: 'user', content: 'first' }], instructions: 'Be a judge.', max_output_tokens: 256, store: false, truncation: 'disabled' });
    assert.equal(line.response.status, 200);
  });
});

test('Responses route, bad requests: 404 for another path, 400 for no model, no input or a body that is not an object', async () => {
  await withEndpoint({}, async (url, logPath) => {
    assert.equal((await fetch(`${url}/v1/responses`)).status, 404);
    assert.equal((await fetch(`${url}/v1/responses/resp_1`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{}' })).status, 404);
    const bad = (b: string): Promise<Response> => fetch(`${url}/v1/responses`, { method: 'POST', body: b });
    assert.equal((await bad('not json')).status, 400);
    assert.equal((await bad('{"model":"m"}')).status, 400);
    assert.equal((await bad('{"model":"m","messages":[]}')).status, 400);
    assert.equal((await bad('{"input":"x"}')).status, 400);
    const r = await bad('{"model":"m","input":7}');
    assert.equal(r.status, 400);
    const j = (await r.json()) as any;
    assert.deepEqual(Object.keys(j.error).sort(), ['code', 'message', 'param', 'type']);
    assert.equal((await askR(url, 'x [[mode:bogus]]')).status, 400);
    assert.equal(logOf(logPath).length, 9);
  });
});

test('Responses route, modes: each answers as documented, by flag and by marker', async () => {
  const msgs = (r: RReply): any[] => r.json.output.filter((i: any) => i.type === 'message');
  const expectations: Record<string, (r: RReply) => void> = {
    normal: (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['message/output_text']); assert.equal(JSON.parse(textR(r)).pass, true); assert.equal(msgs(r)[0].phase, 'final_answer'); },
    truncated: (r) => {
      assert.equal(r.json.status, 'incomplete');
      assert.deepEqual(r.json.incomplete_details, { reason: 'max_output_tokens' });
      assert.throws(() => JSON.parse(textR(r)));
      assert.ok(textR(r).startsWith('{"pass"'));
      assert.equal(msgs(r)[0].status, 'incomplete');
    },
    'truncated-verdict-whole': (r) => {
      assert.deepEqual([r.json.status, r.json.incomplete_details], ['incomplete', { reason: 'max_output_tokens' }]);
      assert.equal(JSON.parse(textR(r)).pass, true); // a whole verdict a reading rule accepts, cut only by the response status
      assert.equal(msgs(r)[0].status, 'completed');
    },
    'truncated-reasoning': (r) => {
      assert.deepEqual([r.json.status, r.json.incomplete_details], ['incomplete', { reason: 'max_output_tokens' }]);
      assert.deepEqual(types(r), ['reasoning']);
      assert.deepEqual(r.json.output[0], { type: 'reasoning', id: 'rs_fake_0001', summary: [], encrypted_content: 'ZmFrZS1lbmNyeXB0ZWQ=', status: 'completed' });
    },
    'no-verdict': (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(Object.keys(JSON.parse(textR(r))), ['reason']); },
    prose: (r) => { assert.equal(r.json.status, 'completed'); assert.throws(() => JSON.parse(textR(r))); assert.ok(textR(r).startsWith('Here is my verdict: {"pass":true')); },
    empty: (r) => { assert.equal(textR(r), ''); assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['message/output_text']); },
    'not-json': (r) => { assert.throws(() => JSON.parse(textR(r))); assert.ok(!textR(r).includes('pass')); },
    refusal: (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['message/refusal']); },
    'refusal-after-text': (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['message/output_text+refusal']); assert.equal(JSON.parse(textR(r)).pass, true); },
    'refusal-before-text': (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['message/refusal+output_text']); assert.equal(JSON.parse(textR(r)).pass, true); },
    'content-filter': (r) => {
      assert.deepEqual([r.json.status, r.json.incomplete_details], ['incomplete', { reason: 'content_filter' }]);
      assert.equal(JSON.parse(textR(r)).pass, true);
      assert.equal(msgs(r)[0].status, 'completed');
    },
    'message-incomplete': (r) => { assert.equal(r.json.status, 'completed'); assert.equal(msgs(r)[0].status, 'incomplete'); assert.equal(JSON.parse(textR(r)).pass, true); },
    'phase-absent': (r) => { assert.equal(r.json.status, 'completed'); assert.ok(!('phase' in msgs(r)[0])); assert.equal(msgs(r)[0].status, 'completed'); assert.equal(JSON.parse(textR(r)).pass, true); },
    'phase-commentary': (r) => { assert.equal(r.json.status, 'completed'); assert.equal(msgs(r)[0].phase, 'commentary'); assert.equal(msgs(r)[0].status, 'completed'); assert.equal(JSON.parse(textR(r)).pass, true); },
    'tool-use': (r) => { assert.equal(r.json.status, 'completed'); assert.deepEqual(types(r), ['function_call']); assert.equal(textR(r), ''); },
    'non-text': (r) => { assert.deepEqual(types(r), ['reasoning', 'message/output_text']); assert.equal(r.json.usage.output_tokens_details.reasoning_tokens, 12); },
    'http-500': (r) => { assert.equal(r.status, 500); assert.deepEqual(Object.keys(r.json), ['error']); },
    'http-503': (r) => { assert.equal(r.status, 503); assert.equal(r.json.error.type, 'service_unavailable_error'); },
    'http-429': (r) => { assert.equal(r.status, 429); assert.equal(r.json.error.type, 'rate_limit_error'); },
    'http-400': (r) => { assert.equal(r.status, 400); assert.equal(r.json.error.type, 'invalid_request_error'); },
    redirect: (r) => { assert.equal(r.status, 307); assert.equal(r.headers.get('location'), '/v1/responses'); },
    encoded: (r) => { assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'gzip'); assert.equal(JSON.parse(textR(r)).pass, true); },
    'status-failed': (r) => { assert.equal(r.status, 200); assert.equal(r.json.status, 'failed'); assert.equal(r.json.error, null); assert.deepEqual(r.json.output, []); },
    'error-set': (r) => { assert.equal(r.status, 200); assert.equal(r.json.status, 'completed'); assert.notEqual(r.json.error, null); assert.equal(typeof r.json.error.message, 'string'); },
    'bad-object': (r) => { assert.equal(r.status, 200); assert.equal(r.json.object, 'chat.completion'); assert.equal(r.json.status, 'completed'); },
    'echo-truncation-auto': (r) => { assert.equal(r.json.status, 'completed'); assert.equal(r.json.truncation, 'auto'); assert.equal(r.json.store, false); },
    'echo-store-true': (r) => { assert.equal(r.json.status, 'completed'); assert.equal(r.json.store, true); assert.equal(r.json.truncation, 'disabled'); },
  };
  const NO_RESPONSE = ['stall', 'drop']; // tested on their own below: there is no reply to look at
  assert.deepEqual([...Object.keys(expectations), ...NO_RESPONSE].sort(), [...OPENAI_ROUTE_MODES].sort());
  for (const mode of Object.keys(expectations)) {
    await withEndpoint({}, async (url) => { expectations[mode]!(await askR(url, `x [[mode:${mode}]]`)); });
    await withEndpoint({ mode: mode as Mode }, async (url) => { expectations[mode]!(await askR(url, 'x')); });
  }
  await withEndpoint({ mode: 'empty' }, async (url) => {
    assert.equal(JSON.parse(textR(await askR(url, 'x [[mode:normal]]'))).pass, true); // the marker wins over the flag
  });
});

test('Responses route, the route-only modes are exactly the list and every other mode is shared with the Messages route', () => {
  assert.deepEqual([...OPENAI_ONLY_MODES].sort(), ['bad-object', 'content-filter', 'echo-store-true', 'echo-truncation-auto', 'error-set', 'http-503', 'message-incomplete', 'phase-absent', 'phase-commentary', 'refusal-after-text', 'refusal-before-text', 'status-failed', 'truncated-reasoning', 'truncated-verdict-whole']);
  assert.deepEqual([...MESSAGES_ONLY_MODES].sort(), ['http-529', 'stop-seq']);
  assert.deepEqual(OPENAI_ROUTE_MODES.filter((m) => !(OPENAI_ONLY_MODES as readonly string[]).includes(m)).sort(), MODES.filter((m) => !(MESSAGES_ONLY_MODES as readonly string[]).includes(m)).sort());
});

test('Responses route, no counterpart: stop-seq, http-529 and [[redacted-thinking]] are answered 400 here, never as normal; the Messages route refuses the new modes', async () => {
  await withEndpoint({}, async (url, logPath) => {
    for (const p of ['x [[mode:stop-seq]]', 'x [[mode:http-529]]', 'x [[redacted-thinking]]']) {
      const r = await askR(url, p);
      assert.equal(r.status, 400, p);
      assert.equal(r.json.error.type, 'invalid_request_error', p);
      assert.match(r.json.error.message, /no counterpart/, p);
    }
    for (const mode of OPENAI_ONLY_MODES) {
      const m = await ask(url, `x [[mode:${mode}]]`);
      assert.equal(m.status, 400, mode);
      assert.match(m.json.error.message, /no counterpart/, mode);
    }
    assert.ok(logOf(logPath).every((l) => l.response.status === 400));
  });
  // The flag has the same effect as the marker.
  await withEndpoint({ mode: 'stop-seq' }, async (url) => { assert.equal((await askR(url, 'x')).status, 400); });
  await withEndpoint({ mode: 'phase-absent' }, async (url) => { assert.equal((await ask(url, 'x')).status, 400); });
});

test('Responses route, thinking markers: [[thinking]] adds a reasoning item and 12 tokens; [[no-counter]] drops the details', async () => {
  await withEndpoint({}, async (url) => {
    const t = await askR(url, 'x [[thinking]]');
    assert.deepEqual(types(t), ['reasoning', 'message/output_text']);
    assert.equal(t.json.usage.output_tokens_details.reasoning_tokens, 12);
    assert.equal(t.json.output[0].encrypted_content, 'ZmFrZS1lbmNyeXB0ZWQ=');
    const n = await askR(url, 'x [[no-counter]]');
    assert.equal('output_tokens_details' in n.json.usage, false);
    const both = await askR(url, 'x [[thinking]] [[no-counter]]');
    assert.deepEqual(types(both), ['reasoning', 'message/output_text']);
    assert.equal('output_tokens_details' in both.json.usage, false);
    assert.equal((await askR(url, 'x')).json.usage.output_tokens_details.reasoning_tokens, 0);
  });
});

test('Responses route, fence, grade P and long reply markers work as on the Messages route', async () => {
  await withEndpoint({}, async (url) => {
    assert.match(textR(await askR(url, 'x [[fence]]')), /^```json\n\{"pass":true/);
    assert.match(textR(await askR(url, 'x [[grade:p]]')), /\n\nGRADE: P$/);
    assert.ok(textR(await askR(url, 'x [[long-reply]]')).startsWith('x'.repeat(20000)));
  });
  await withEndpoint({ longReply: 50 }, async (url) => {
    assert.ok(textR(await askR(url, 'x')).startsWith('x'.repeat(50)));
  });
});

test('Responses route, [[times:<n>:<mode>]] counts equal bodies as on the Messages route, in the one request sequence', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const body = JSON.stringify({ model: 'judge-a', input: 'grade [[times:2:truncated]]' });
    const go = async (): Promise<any> => (await fetch(`${url}/v1/responses`, { method: 'POST', body })).json();
    const a = await go();
    const b = await go();
    const c = await go();
    assert.deepEqual([a.status, b.status, c.status], ['incomplete', 'incomplete', 'completed']);
    assert.deepEqual([a.id, c.id], ['resp_fake_0001', 'resp_fake_0003']);
    assert.deepEqual(logOf(logPath).map((l) => l.mode), ['truncated', 'truncated', 'normal']);
    // A mode with no counterpart under the marker is answered 400 too, and counted.
    const d = (await (await fetch(`${url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'judge-a', input: 'grade [[times:1:stop-seq]]' }) })).json()) as any;
    assert.match(d.error.message, /no counterpart/);
    // The Messages route and this one share the sequence.
    assert.equal((await ask(url, 'x')).json.id, 'msg_fake_0005');
  });
});

test('Responses route, stall and drop: no reply, logged as NO_RESPONSE', async () => {
  await withEndpoint({}, async (url, logPath) => {
    const raw = async (prompt: string, timeoutMs = 4000): Promise<unknown> => {
      try {
        const r = await fetch(`${url}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'judge-a', input: prompt }), signal: AbortSignal.timeout(timeoutMs) });
        return r.status;
      } catch (e) {
        return (e as Error).name;
      }
    };
    assert.equal(await raw('a [[mode:drop]]'), 'TypeError');
    assert.equal(await raw('a [[mode:stall]]', 300), 'TimeoutError');
    assert.deepEqual(logOf(logPath).map((l) => l.response), [{ status: 'NO_RESPONSE', body: 'drop' }, { status: 'NO_RESPONSE', body: 'stall' }]);
  });
});
