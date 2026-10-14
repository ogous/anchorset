import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LONG_REPLY_DEFAULT, MODES, SERVED_SUFFIX, startFakeEndpoint, verdictOf } from '../examples/importers/fake-endpoint.ts';
import type { FakeEndpointOptions } from '../examples/importers/fake-endpoint.ts';

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
