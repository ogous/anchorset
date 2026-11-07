// The paid-API guard: no test of the importers may reach a paid API, whatever the machine's environment holds.
// These tests pin, in the test sources themselves, the three ways a test could reach a real host:
//   1. a subprocess that runs a grader and inherits this process's environment (a real key, a gateway address);
//   2. a grader built with a base URL that is not on 127.0.0.1 or [::1], where a call could follow;
//   3. a grader's default host (no base URL stated) reached by a call.
// The third is held by the first two together with the graders' own rules: a grader whose key is a sentinel and whose
// base URL is loopback cannot send a real key anywhere. Synthetic customer-support refund-bot data only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SENTINEL_KEYS, scratchEnv } from './helpers.ts';

const testDir = import.meta.dirname;
const SELF = 'importers.paid-api-guard.test.ts';
const sources = readdirSync(testDir)
  .filter((f) => /^importers\..*\.test\.ts$/.test(f) && f !== SELF)
  .sort()
  .map((f) => ({ file: f, text: readFileSync(join(testDir, f), 'utf8') }));

// ---- the environment of a subprocess ---------------------------------------------------------------------------------------

test('scratchEnv is built from scratch: the machine\'s PATH, two sentinel keys and what a test adds; no address variable, whatever this process holds', () => {
  const held = ['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_HOST', 'OPENAI_HOST', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NODE_OPTIONS'];
  const saved = held.map((k) => [k, process.env[k]] as const);
  const savedKeys = [process.env['ANTHROPIC_API_KEY'], process.env['OPENAI_API_KEY']];
  try {
    for (const k of held) process.env[k] = 'https://must-not-travel.example.invalid';
    process.env['ANTHROPIC_API_KEY'] = 'a-real-looking-key-that-must-not-travel';
    process.env['OPENAI_API_KEY'] = 'another-real-looking-key-that-must-not-travel';
    const env = scratchEnv();
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PATH']);
    assert.equal(env['ANTHROPIC_API_KEY'], SENTINEL_KEYS.ANTHROPIC_API_KEY);
    assert.equal(env['OPENAI_API_KEY'], SENTINEL_KEYS.OPENAI_API_KEY);
    for (const v of Object.values(env)) assert.ok(!v.includes('must-not-travel'), v);
    // a test that sets one on purpose, to see the grader refuse it, adds it; only that one
    assert.deepEqual(Object.keys(scratchEnv({ OPENAI_BASE_URL: 'https://gateway.example.test/v1' })).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH'].sort());
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const [k, v] of [['ANTHROPIC_API_KEY', savedKeys[0]], ['OPENAI_API_KEY', savedKeys[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the sentinel keys are no key of any account: neither has the form of a key of either provider', () => {
  for (const v of Object.values(SENTINEL_KEYS)) {
    assert.ok(v.startsWith('sentinel-'), v);
    assert.ok(!/^sk-/.test(v), v);
  }
  assert.notEqual(SENTINEL_KEYS.ANTHROPIC_API_KEY, SENTINEL_KEYS.OPENAI_API_KEY);
});

// ---- a source scan: no test passes this process's environment on -------------------------------------------------------------

test('no importer test source hands this process\'s whole environment to a subprocess', () => {
  const found = sources.filter((s) => /\.\.\.process\.env\b/.test(s.text) || /\benv:\s*process\.env\b/.test(s.text)).map((s) => s.file);
  assert.deepEqual(found, [], 'a test spawns a process with the inherited environment; build it with scratchEnv() from helpers.ts');
});

/** The text of every call of one of `names` in a source, from the name to its closing parenthesis; strings and template literals are skipped over. */
function callsOf(text: string, names: readonly string[]): string[] {
  const out: string[] = [];
  // not a property (`asyncio.run(` in a Python driver text is not the alias `run`)
  const re = new RegExp(`(?<![.\\w$])(?:${names.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    const skipQuoted = (quote: string): void => {
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          i += 2;
          let braces = 1;
          while (i < text.length && braces > 0) {
            if (text[i] === '{') braces += 1;
            else if (text[i] === '}') braces -= 1;
            else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
              skipQuoted(text[i] as string);
            }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
    };
    while (i < text.length && depth > 0) {
      const c = text[i] as string;
      if (c === "'" || c === '"' || c === '`') skipQuoted(c);
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

test('every subprocess call in an importer test states its environment, whatever the call names', () => {
  // No filter on what the call runs: a version probe or a helper script states `env` as well (it may be as small as { PATH }), so that no
  // child ever inherits this process's keys or gateway addresses by an oversight. An alias of `promisify(execFile)` is a call too.
  let checked = 0;
  const bad: string[] = [];
  for (const s of sources) {
    const aliases = [...s.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*(?:execFile|execFileSync)\s*\)/g)].map((m) => m[1] as string);
    for (const call of callsOf(s.text, ['spawnSync', 'spawn', 'execFileSync', 'execFile', ...aliases])) {
      // `promisify(execFile)(...)` is read as the call `execFile)(...`; a bare `promisify(execFile)` with no arguments is the alias itself
      checked += 1;
      if (!/\benv\b/.test(call)) bad.push(`${s.file}: ${call.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    // `promisify(execFile)(py, [...], { ... })` called at once, with no alias
    for (const call of callsOf(s.text, ['promisify\\(\\s*execFile\\s*\\)'])) {
      checked += 1;
      if (!/\benv\b/.test(call)) bad.push(`${s.file}: ${call.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  }
  assert.ok(checked > 0, 'the scan found no call to check: it is out of date');
  assert.deepEqual(bad, []);
});

test('the scan of every call finds an alias of promisify(execFile), a call at once, and a probe with a small environment', () => {
  const sample = "const run = promisify(execFile);\nawait run(a, [b], { encoding: 'utf8' });\nawait promisify(execFile)(c, [d], { env: { PATH } });\nspawnSync(py, ['-c', 'import x'], { env: { PATH } });\nspawnSync(py, ['-c', 'import x']);";
  const aliases = [...sample.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*(?:execFile|execFileSync)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(aliases, ['run']);
  assert.deepEqual(callsOf(sample, ['run']), ["run(a, [b], { encoding: 'utf8' })"]);
  assert.deepEqual(callsOf(sample, ['promisify\\(\\s*execFile\\s*\\)']), ['promisify(execFile)(c, [d], { env: { PATH } })'].map((x) => x));
  assert.deepEqual(callsOf(sample, ['spawnSync']).map((c) => /\benv\b/.test(c)), [true, false]);
});

test('the scan of calls is sound: it sees a nested call, a template and a string holding a parenthesis', () => {
  const sample = "x();\nspawnSync(process.execPath, [`a(${f('b)')})`, 'c)'], { env: scratchEnv() });\ny();";
  assert.deepEqual(callsOf(sample, ['spawnSync']), ["spawnSync(process.execPath, [`a(${f('b)')})`, 'c)'], { env: scratchEnv() })"]);
  assert.deepEqual(callsOf('spawn(a, { stdio: [1] })\nspawn(b)', ['spawn']), ['spawn(a, { stdio: [1] })', 'spawn(b)']);
});

// ---- a source scan: no test builds a grader with a base URL outside loopback and then calls it -----------------------------

/**
 * The lines of a test source that state a base URL, a gateway address or a host variable together with an address that is
 * not on 127.0.0.1 or [::1]. Each is a string the test compares, a configuration the grader refuses at construction, or a
 * value checked by a pure function; none is a grader that makes a call. The count per file is pinned, so a new one is
 * a conscious change: it must be a constructor-only or pure use, and this table says so.
 */
const NON_LOOPBACK = /(baseUrl|base_url|base-url|BASE_URL|_HOST|baseURL)[^\n]*?https?:\/\/(?!(?:127\.0\.0\.1|\[::1\])(?=[:/]))[^\s'"`/\\]+/;
const PURE_USES: Readonly<Record<string, { count: number; why: string }>> = {
  'importers.grader.test.ts': { count: 10, why: 'constructor tests (the grader refuses the address, or builds with no call), and gateway-variable tests that refuse before any call' },
  'importers.inspect.test.ts': { count: 2, why: 'a log edited in memory so that the importer refuses its base_url; no grader runs' },
  'importers.shared.test.ts': { count: 16, why: 'pure functions that compare an address with a record (graderConfigProblems, gatewayProblemFor); no grader is built' },
  'importers.skill-evals.import.test.ts': { count: 2, why: 'a re-grade file edited in memory so that the importer refuses its address; no grader runs' },
  'importers.skill-evals.regrade.test.ts': { count: 5, why: 'a stub grader factory records the configuration; the real grader is never built with these addresses' },
};

test('a non-loopback base URL appears in a test only in a constructor-only or pure use, and the count per file is pinned', () => {
  const counts = Object.fromEntries(sources.map((s) => [s.file, s.text.split('\n').filter((l) => NON_LOOPBACK.test(l)).length]).filter(([, n]) => (n as number) > 0));
  assert.deepEqual(counts, Object.fromEntries(Object.entries(PURE_USES).map(([f, v]) => [f, v.count])), 'a test names a base URL outside loopback; if it makes no call, add it to PURE_USES with the reason, and if it does, give it 127.0.0.1');
});

test('a grader built in a test that calls it is built with a base URL from a local stand-in, never a literal outside loopback', () => {
  // `callApi` is the only way a grader makes a request. A line that both builds a grader with a literal base URL and calls it must be loopback.
  const bad = sources.flatMap((s) => s.text.split('\n').flatMap((l, i) => (/callApi\(/.test(l) && NON_LOOPBACK.test(l) ? [`${s.file}:${i + 1}`] : [])));
  assert.deepEqual(bad, []);
});

test('the pinned table names no file that is not there', () => {
  const files = new Set(sources.map((s) => s.file));
  for (const f of Object.keys(PURE_USES)) assert.ok(files.has(f), f);
});
