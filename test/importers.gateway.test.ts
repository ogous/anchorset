import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { gatewayVariableProblem } from '../examples/importers/shared.ts';
import { loadTestedVersions } from '../examples/importers/shared.ts';
import { scratchEnv, skipOrFail } from './helpers.ts';

// Two guards of the paid step, on every path, in the grader files themselves and in `regrade.py`:
//   1. the gateway variable (ANTHROPIC_BASE_URL): the tools' own Anthropic providers honour it, the recording graders never
//      read it as an address, so a user behind a gateway would send the gateway's credential to the public host;
//   2. the tool version: an importer refuses a file of a version outside the tested list, and it refuses it after the re-grade
//      has been paid for, so the version is checked before the first call.
// Nothing here makes a call or reaches a host: a grader is built, never asked.

const root = join(import.meta.dirname, '..');
const GRADER_PATH = join(root, 'examples', 'importers', 'promptfoo', 'grader-provider.cjs');
const REGRADE_PY = join(root, 'examples', 'importers', 'inspect', 'regrade.py');
const GRADER_PY = join(root, 'examples', 'importers', 'inspect', 'recording_grader.py');
const require = createRequire(import.meta.url);
const PROMPTFOO_SET = loadTestedVersions('promptfoo').versions;
const INSPECT_SET = loadTestedVersions('inspect_ai').versions;
const PROMPTFOO_NEWEST = PROMPTFOO_SET[PROMPTFOO_SET.length - 1] as string;
const INSPECT_NEWEST = INSPECT_SET[INSPECT_SET.length - 1] as string;

type ProviderClass = new (options: unknown) => unknown;
/** A fresh copy of the module (its per-process state starts clean). */
function loadGrader(): ProviderClass {
  delete require.cache[GRADER_PATH];
  return require(GRADER_PATH) as ProviderClass;
}
const CONFIG = { wire: 'anthropic-messages/v1', model: 'judge-requested', max_tokens: 256, baseUrl: 'http://127.0.0.1:18765', thinking: 'NOT_SENT', effort: 'NOT_SENT', maxReasks: 0 };
const make = (config: Record<string, unknown> = {}): unknown => new (loadGrader())({ id: 'file://grader-provider.cjs', config: { ...CONFIG, ...config } });

const savedGateway = process.env['ANTHROPIC_BASE_URL'];
const savedArgv1 = process.argv[1];
afterEach(() => {
  if (savedGateway === undefined) delete process.env['ANTHROPIC_BASE_URL'];
  else process.env['ANTHROPIC_BASE_URL'] = savedGateway;
  if (savedArgv1 === undefined) process.argv.length = 1;
  else process.argv[1] = savedArgv1;
});

describe('the JavaScript recording grader: the gateway variable', () => {
  const GATEWAY = 'http://gateway.invalid:4000';
  const PROMPTFOO_TAIL = " State the same address as `baseUrl` in the grader's config, or unset the variable. No call was made.";

  it('refuses at construction, before any call, when the variable is set and no base URL is stated, or another one is; it names the variable and never its value', () => {
    process.env['ANTHROPIC_BASE_URL'] = GATEWAY;
    for (const baseUrl of [undefined, 'http://127.0.0.1:18765', `${GATEWAY}/`]) {
      assert.throws(
        () => make({ baseUrl }),
        (e: unknown) => {
          const m = (e as Error).message;
          assert.match(m, /^grader: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it/);
          assert.ok(!m.includes('gateway.invalid'), 'the value is never printed');
          // The first half is the other scripts' own words; the tail is the grader's own, true when the tool runs the file: nothing
          // is said to be unwritten (the tool writes its error rows), and the setting is named as the config key it is.
          const shared = gatewayVariableProblem(GATEWAY, baseUrl, 'ANTHROPIC_BASE_URL') as string;
          assert.ok(m.slice('grader: '.length).startsWith(shared.slice(0, shared.indexOf(' State the same address'))), "the first half is the other scripts' words");
          assert.ok(m.endsWith(PROMPTFOO_TAIL), m);
          assert.ok(!m.includes('Nothing was written') && !m.includes('--base-url'), 'no statement that is untrue under the tool');
          return true;
        },
        String(baseUrl),
      );
    }
  });

  it('constructs when the same address is stated, when the variable is empty and when it is not set', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:18765';
    assert.doesNotThrow(() => make());
    process.env['ANTHROPIC_BASE_URL'] = '';
    assert.doesNotThrow(() => make());
    delete process.env['ANTHROPIC_BASE_URL'];
    assert.doesNotThrow(() => make());
  });
});

describe('the JavaScript recording grader: the tool version, when promptfoo runs it', () => {
  /** A folder shaped as an installed promptfoo: <dir>/node_modules/<name>/package.json and an entry file under dist/. */
  function installed(pkg: Record<string, unknown> | string): { entry: string; done: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'anchorset-pf-'));
    const home = join(dir, 'node_modules', 'promptfoo');
    mkdirSync(join(home, 'dist', 'src'), { recursive: true });
    writeFileSync(join(home, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
    // As the real package has it: the folder of the entry file holds a package.json of its own that names nothing (`{"type": "module"}`).
    writeFileSync(join(home, 'dist', 'src', 'package.json'), '{"type": "module"}');
    const entry = join(home, 'dist', 'src', 'entrypoint.js');
    writeFileSync(entry, '');
    return { entry, done: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const under = (entry: string, fn: () => void): void => {
    process.argv[1] = entry;
    fn();
  };

  it('holds no version of its own: it reads the one list', () => {
    const text = readFileSync(GRADER_PATH, 'utf8');
    assert.ok(text.includes("path.join(__dirname, '..', 'tested-versions.json')"));
    assert.doesNotMatch(text, /TESTED_PROMPTFOO_VERSION/);
  });

  it('refuses at construction, before any call, under a promptfoo of another version; it names the version, the whole set and the install line', () => {
    for (const version of ['0.124.0', '0.123.0', '1.0.0']) {
      const { entry, done } = installed({ name: 'promptfoo', version });
      try {
        under(entry, () =>
          assert.throws(() => make(), (e: unknown) => {
            const m = (e as Error).message;
            assert.match(m, new RegExp(`^grader: promptfoo ${version.replaceAll('.', '\\.')} is running this grader`));
            assert.ok(m.includes(`tested on promptfoo ${PROMPTFOO_SET.join(', ')}`) && m.includes(`npm install --prefix .anchorset-grade promptfoo@${PROMPTFOO_NEWEST}`) && m.toLowerCase().includes('no call was made'), m);
            return true;
          }, version),
        );
      } finally {
        done();
      }
    }
  });

  it('refuses when the package that holds the entry file is promptfoo and states no version it can read', () => {
    for (const pkg of [{ name: 'promptfoo' }, { name: 'promptfoo', version: 7 }, '{ not json']) {
      const { entry, done } = installed(pkg);
      try {
        under(entry, () => assert.throws(() => make(), /^Error: grader: .*promptfoo/, JSON.stringify(pkg)));
      } finally {
        done();
      }
    }
  });

  it('constructs under each tested version, and when the process is not promptfoo at all', () => {
    for (const version of PROMPTFOO_SET) {
      const { entry, done } = installed({ name: 'promptfoo', version });
      try {
        under(entry, () => assert.doesNotThrow(() => make(), version));
      } finally {
        done();
      }
    }
    const { entry, done } = installed({ name: 'promptfoo', version: PROMPTFOO_NEWEST });
    try {
      under(entry, () => assert.doesNotThrow(() => make()));
    } finally {
      done();
    }
    // `regrade.ts` runs the grader under Node alone, and the unit tests run it under the test runner: the nearest package is not promptfoo.
    const other = mkdtempSync(join(tmpdir(), 'anchorset-other-'));
    try {
      writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
      writeFileSync(join(other, 'main.js'), '');
      under(join(other, 'main.js'), () => assert.doesNotThrow(() => make()));
      under(join(other, 'does-not-exist.js'), () => assert.doesNotThrow(() => make()));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    assert.doesNotThrow(() => make());
  });
});

// ---- the Python side -------------------------------------------------------------------------------------------------------

/** The first Python of 3.10 or later on this machine (regrade.py's annotations need it), or undefined. */
function python(): string | undefined {
  return ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { env: { PATH: process.env['PATH'] ?? '' } }).status === 0);
}
/** A Python that has inspect_ai (the venv named by ANCHORSET_INSPECT_VENV first), or undefined. */
function pythonWithInspect(): string | undefined {
  const venv = process.env['ANCHORSET_INSPECT_VENV'];
  return [...(venv === undefined ? [] : [join(venv, 'bin', 'python')]), 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import inspect_ai'], { env: { PATH: process.env['PATH'] ?? '' } }).status === 0);
}

describe('regrade.py: the tool version, before any call', () => {
  // The driver stands in for the installed package's metadata and keeps the package itself out of reach, so that what ends the run is the script's own check.
  const driver = (version: string): string => `import runpy, sys, importlib.metadata as m; m.version = lambda n: ${JSON.stringify(version)}; sys.modules["inspect_ai"] = None; sys.exit(runpy.run_path(${JSON.stringify(REGRADE_PY)}, run_name="not_main")["main"](sys.argv[1:]))`;
  const RUN = ['--log', 'no-such-log.json', '--epochs', '1', '--judge-model', 'm', '--max-tokens', '16', '--out-dir', 'o', '--wire', 'anthropic-messages/v1', '--thinking', 'NOT_SENT', '--effort', 'NOT_SENT', '--max-reasks', '0', '--base-url', 'http://127.0.0.1:18765'];
  const CHECK = ['--log', 'no-such-log.json', '--epochs', '1', '--check'];
  const runWith = (py: string, version: string, args: string[]) => spawnSync(py, ['-c', driver(version), ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });

  it('holds no version of its own: it reads the one list', () => {
    const text = readFileSync(REGRADE_PY, 'utf8');
    assert.ok(text.includes('"tested-versions.json"'));
    assert.doesNotMatch(text, /TESTED_INSPECT_VERSION/);
  });

  it('exits 64 on another inspect_ai version, in a check and in a run, naming the version, the whole set and the install line, and writes nothing', (t) => {
    const py = python();
    if (py === undefined) {
      skipOrFail(t, 'no Python 3.10 or later on this machine');
      return;
    }
    for (const version of ['0.3.276', '0.3.274', '0.4.0', '0.3.275.post1']) {
      for (const args of [CHECK, RUN]) {
        const r = runWith(py, version, args);
        assert.equal(r.status, 64, r.stderr);
        assert.ok(r.stderr.startsWith(`usage error: inspect_ai ${version} is installed, and this importer was tested on inspect_ai ${INSPECT_SET.join(', ')}.\n`), r.stderr);
        assert.ok(r.stderr.includes(`.anchorset-grade/bin/pip install inspect_ai==${INSPECT_NEWEST}`), r.stderr);
        assert.match(r.stderr, /no call was made/);
        assert.doesNotMatch(r.stderr, /Traceback/);
      }
    }
  });

  it('goes on under each tested version (here it ends on the blocked import, which is the next thing it does)', (t) => {
    const py = python();
    if (py === undefined) {
      skipOrFail(t, 'no Python 3.10 or later on this machine');
      return;
    }
    for (const version of INSPECT_SET) {
      for (const args of [CHECK, RUN]) {
        const r = runWith(py, version, args);
        assert.equal(r.status, 64, r.stderr);
        assert.ok(r.stderr.includes(`pip install inspect_ai==${INSPECT_NEWEST}`), r.stderr);
        assert.doesNotMatch(r.stderr, /is installed, and this importer was tested on inspect_ai/);
      }
    }
  });

  it('a missing package that is not inspect_ai is not answered with the inspect_ai install line alone: the module is named', (t) => {
    const py = python();
    if (py === undefined) {
      skipOrFail(t, 'no Python 3.10 or later on this machine');
      return;
    }
    const d = `import runpy, sys; m = runpy.run_path(${JSON.stringify(REGRADE_PY)}, run_name="not_main"); sys.exit(m["missing_package"](ModuleNotFoundError("x", name="tiktoken")))`;
    const r = spawnSync(py, ['-c', d], { env: scratchEnv(), encoding: 'utf8' });
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /'tiktoken'/);
    assert.match(r.stderr, /dependency of inspect_ai/);
  });
});

describe('recording_grader.py: the gateway variable', () => {
  it('refuses at construction, before any call, when the variable is set and no base URL is stated, or another one is; the same address, an empty variable and none are accepted', (t) => {
    const py = pythonWithInspect();
    if (py === undefined) {
      skipOrFail(t, 'no Python with inspect_ai on this machine (set ANCHORSET_INSPECT_VENV)');
      return;
    }
    const d = `
import os, sys
sys.path.insert(0, ${JSON.stringify(join(root, 'examples', 'importers', 'inspect'))})
from inspect_ai.model import GenerateConfig
import recording_grader as rg
def build(base_url):
    return rg.RecordingGrader("m", base_url=base_url, config=GenerateConfig(max_tokens=8), wire="anthropic-messages/v1", thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0)
GATEWAY = "http://127.0.0.1:4000"
os.environ["ANTHROPIC_BASE_URL"] = GATEWAY
for url in (None, "http://127.0.0.1:18765", GATEWAY + "/"):
    try:
        build(url)
    except ValueError as e:
        m = str(e)
        assert m.startswith("grader: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it"), m
        assert "4000" not in m, m
        assert m.endswith("State the same address as the grader's base URL, or unset the variable. No call was made."), m
        assert "Nothing was written" not in m and "--base-url" not in m, m
    else:
        raise SystemExit("not refused: " + repr(url))
build(GATEWAY)
os.environ["ANTHROPIC_BASE_URL"] = ""
build(None)
del os.environ["ANTHROPIC_BASE_URL"]
build(None)
print("ok")
`;
    const r = spawnSync(py, ['-c', d], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stdout.trim(), 'ok');
  });

  // Needs no Python: the guard is in the shipped file, in the grader's own words (not the scripts' tail, which says "nothing was written"
  // and names a flag a bare Inspect run does not have).
  it('holds the guard in its source, with a tail that is true when Inspect runs the file', () => {
    const tail = ", and the key would go there instead of to the address your other tools use. {hint} No call was made.";
    const source = readFileSync(GRADER_PY, 'utf8');
    assert.ok(source.includes('the environment variable {name} is set, and this grader never reads it: ') && source.includes(tail), 'the words');
    assert.ok(source.includes('"State the same address as the grader\'s base URL, or unset the variable."') && source.includes('hint = "Unset the variable." if name.endswith("_HOST")'), 'the remedies: a bare host is only ever unset');
    assert.ok(source.includes('for name in OPENAI_ADDRESS_VARIABLES if openai else ("ANTHROPIC_BASE_URL",):') && source.includes('os.environ.get(name)'), 'the variables are read at construction, one list for each wire');
    assert.ok(source.includes('OPENAI_ADDRESS_VARIABLES = ("OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_HOST", "OPENAI_HOST")'), 'the four OpenAI variables');
    assert.ok(!source.includes('Nothing was written'), 'nothing is said to be unwritten');
  });
});
