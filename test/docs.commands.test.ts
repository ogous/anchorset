// The commands a reader copies from the README and from the "try it first" block of the importers guide are run here,
// at zero spend, so a change to the tool that breaks a printed command fails a test. Nothing here pins the wording of a
// page: only what stands inside a `sh` or `bash` block is read. Synthetic example data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

/** The lines of every `sh` or `bash` block of a page, in order, each with the heading it stands under. */
function commandLines(rel: string): { heading: string; line: string }[] {
  const out: { heading: string; line: string }[] = [];
  let heading = '';
  let inBlock = false;
  for (const l of read(rel).split('\n')) {
    if (/^```(sh|bash)\s*$/.test(l)) inBlock = true;
    else if (l.startsWith('```')) inBlock = false;
    else if (inBlock && l.trim() !== '') out.push({ heading, line: l.trim() });
    else if (!inBlock && /^#{1,4} /.test(l)) heading = l.replace(/^#+ /, '');
  }
  return out;
}

const sh = (line: string, env: Record<string, string> = {}): number => {
  const r = spawnSync('bash', ['-c', line], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  return r.status ?? -1;
};

// A command that cannot be run here: it needs the network, another folder or a tool that is not this repository's.
const NOT_RUN = [/^git clone /, /^cd anchorset$/, /^claude plugin /, /^npm install anchorset$/, /^OUT="\$\(mktemp -d\)"$/];
// The one demo that is built to fail: the README says so, and the gate's exit code for a regression is 1.
const EXPECTED_EXIT: Record<string, number> = { demo: 1 };

test('README.md: every `npm run` it prints names a script of package.json and exits as the page says (the gate demo 1, the others 0)', () => {
  const lines = commandLines('README.md').map((c) => c.line);
  const runs = lines.filter((l) => l.startsWith('npm run '));
  assert.ok(runs.length >= 5, `expected the five demo commands, found ${runs.length}`);
  for (const l of runs) {
    const m = /^npm run --silent ([a-z:-]+)$/.exec(l);
    assert.ok(m !== null, `not of the form "npm run --silent <script>": ${l}`);
    const name = m[1] as string;
    const script = scripts[name];
    assert.ok(script !== undefined, `package.json has no script "${name}"`);
    assert.equal(sh(script), EXPECTED_EXIT[name] ?? 0, l);
  }
});

test('README.md and docs/CLI.md: a command printed with placeholders uses a command and flags that the help text of that command lists', () => {
  let checked = 0;
  for (const rel of ['README.md', 'docs/CLI.md']) {
    for (const { line } of commandLines(rel)) {
      const m = /^node (?:anchorset\/)?src\/cli\.ts ([a-z-]+) (.*)$/.exec(line);
      if (m === null || !line.includes('<')) continue;
      const help = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), m[1] as string, '--help'], { encoding: 'utf8' });
      assert.equal(help.status, 0, `${rel}: no help for the command of: ${line}`);
      for (const flag of (m[2] as string).match(/--[a-z-]+/g) ?? []) {
        // The whole flag, so that `--rating` is not found inside `--ratings`.
        assert.ok(new RegExp(`(?<![a-z-])${flag}(?![a-z-])`).test(help.stdout), `${rel}: ${m[1]} --help does not list ${flag} (${line})`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 5, `expected a command with placeholders for each method, found ${checked}`);
});

test('README.md: every other command it prints is one of the few that cannot be run here', () => {
  for (const { line } of commandLines('README.md')) {
    if (line.startsWith('npm run ') || /^node src\/cli\.ts /.test(line)) continue;
    assert.ok(NOT_RUN.some((rx) => rx.test(line)), `README.md prints a command this test neither runs nor knows: ${line}`);
  }
});

test('the READMEs of the two examples: every command they print runs and exits 0, except the gate demo, which exits 1', () => {
  let ran = 0;
  for (const rel of ['examples/refund-bot/README.md', 'examples/judge-change/README.md']) {
    for (const { line } of commandLines(rel)) {
      const m = /^npm run --silent ([a-z:-]+)$/.exec(line);
      if (m !== null) {
        const script = scripts[m[1] as string];
        assert.ok(script !== undefined, `${rel}: package.json has no script "${m[1]}"`);
        assert.equal(sh(script), EXPECTED_EXIT[m[1] as string] ?? 0, `${rel}: ${line}`);
      } else {
        assert.match(line, /^node tools\/study-check\.ts examples\/judge-change\/manifest\.json$/, `${rel} prints a command this test does not know: ${line}`);
        assert.equal(sh(line), 0, `${rel}: ${line}`);
      }
      ran++;
    }
  }
  assert.equal(ran, 6);
});

const work = mkdtempSync(join(tmpdir(), 'anchorset-docs-commands-'));
after(() => rmSync(work, { recursive: true, force: true }));

test('docs/IMPORTERS.md, "Try it first": the block runs as printed with Node alone; every line exits 0, and `gate` refuses the imported files (exit 2)', () => {
  const block = commandLines('docs/IMPORTERS.md').filter((c) => c.heading.startsWith('Try it first')).map((c) => c.line);
  assert.ok(block.length >= 4, `expected the trial block, found ${block.length} line(s)`);
  let gates = 0;
  let reports = 0;
  for (const l of block) {
    // The page makes its own scratch folder with mktemp; here the folder is this test's, removed afterwards.
    const line = l.replace(/^OUT="\$\(mktemp -d\)" && /, '');
    const isGate = / src\/cli\.ts gate /.test(line);
    assert.equal(sh(line, { OUT: work }), isGate ? 2 : 0, l);
    if (isGate) gates++;
    if (/ src\/cli\.ts judge-change /.test(line)) reports++;
  }
  assert.equal(reports, 1, 'the trial runs judge-change once');
  assert.equal(gates, 1, 'the trial shows gate refusing the imported files once');
});

test('README.md, "Get your results in", and docs/RUN_FORMAT.md, "The quickest way": each block runs as printed; write-run writes the run and validate exits 0 on it', () => {
  for (const [rel, heading] of [['README.md', 'Get your results in'], ['docs/RUN_FORMAT.md', 'The quickest way']] as const) {
    const block = commandLines(rel).filter((c) => c.heading === heading).map((c) => c.line);
    assert.equal(block.length, 3, `${rel}: expected the three lines of the block, found ${block.length}`);
    // The page makes its own scratch folder with mktemp; here it is a fresh folder of this test's, removed afterwards.
    const out = mkdtempSync(join(work, 'quick-'));
    for (const line of block) {
      if (/^OUT="\$\(mktemp -d\)"$/.test(line)) continue;
      assert.match(line, /^node src\/cli\.ts (write-run|validate) /, `${rel}: ${line}`);
      assert.equal(sh(line, { OUT: out }), 0, `${rel}: ${line}`);
    }
    assert.ok(existsSync(join(out, 'run.json')), rel);
  }
});

test('docs/CLI.md, "In CI": the code-fence recipe runs as printed on the demo files; the summary holds the report in a text block, and the step keeps the gate\'s exit code', () => {
  const block = commandLines('docs/CLI.md').filter((c) => c.heading === 'In CI' && c.line.includes('GITHUB_STEP_SUMMARY')).map((c) => c.line);
  assert.equal(block.length, 1, `expected the recipe's one line, found ${block.length}`);
  // The page's files sit beside a clone in anchorset/; here they are the demo's, and the CLI is this tree's.
  const files: Record<string, string> = { 'baseline.json': 'examples/refund-bot/baseline.json', 'candidate.json': 'examples/refund-bot/candidate.json', 'bar.json': 'examples/refund-bot/bar.json' };
  const line = block.join('\n').replaceAll('anchorset/src/cli.ts', 'src/cli.ts').replace(/\b(baseline|candidate|bar)\.json\b/g, (f) => files[f] as string);
  // As GitHub Actions runs a step (bash -e, with pipefail), and as a plain shell runs it.
  for (const [refused, extra, flags] of [[false, ' --allow-differ systemModelServed,systemCallShapeHash', ['-eo', 'pipefail']], [true, '', ['-eo', 'pipefail']], [false, ' --allow-differ systemModelServed,systemCallShapeHash', []]] as const) {
    const summary = join(work, `summary-${refused ? 'refused' : 'gated'}-${flags.length}.md`);
    const r = spawnSync('bash', [...flags, '-c', line.replace('--bar examples/refund-bot/bar.json', `--bar examples/refund-bot/bar.json${extra}`)], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    // The demo holds a regression (1); without the declared axes the gate refuses (2). The step keeps either.
    assert.equal(r.status, refused ? 2 : 1, r.stderr);
    const text = readFileSync(summary, 'utf8');
    assert.ok(text.startsWith('```text\n') && text.endsWith('\n```\n'), text);
    assert.match(text, refused ? /\nREFUSED IDENTITY_MISMATCH\n/ : /\nverdict: REGRESSION \(exit 1\)\n/);
  }
});
