/**
 * Stored answers from a promptfoo run of your own system.
 *
 *   node examples/importers/promptfoo/stored-from-result.ts --in <result.json> --out <stored.json>
 *
 * The re-grade replays one stored answer per case (`stored-outputs-provider.cjs` reads `stored.json`, an object from case
 * id to answer text). This script writes that file from the result file of an earlier run of your system
 * (`promptfoo eval -o result.json`, by a promptfoo version in `tested-versions.json`): the answer of each row
 * (`response.output`) under its test's `case_id` variable. It copies no grade and nothing else.
 *
 * The whole file is refused, and nothing is written, when:
 *   - the tool version or format is not a tested one (`IMPORT_TOOL_VERSION`);
 *   - the file compares more than one prompt or provider, or a test names its own provider or a fixed `providerOutput`
 *     (`IMPORT_JUDGE_SELECTION`): the re-grade needs one system's answer per case;
 *   - a row has no non-empty string `case_id` variable, or two tests share one with different variables (`IMPORT_CASE_ID`);
 *   - a row is one the tool marked as an error, or its answer is not text (`IMPORT_OUTPUT_UNFINISHED`). A row that failed
 *     one of your assertions is an answer like any other and is kept;
 *   - one case has two different answers (`IMPORT_OUTPUTS_DIFFER`), as repeats of a system that does not answer the same
 *     way twice do: the re-grade measures the judge on one fixed answer, so choose it by running the system once.
 * It never overwrites --out. Exit codes: 0 written, 2 refused, 64 usage, 70 an unexpected error.
 *
 * Read on promptfoo 0.125.1, 2026-11-06: a run of the built-in `echo` provider with `--repeat 2` and one failing
 * `icontains` assertion holds each answer at `results.results[i].response.output`, the test's variables at `.vars`,
 * failureReason 0 on a passing row and 1, with the assertion's reason in `error`, on a failing one. The tests use the
 * result files under `fixtures/` and `by-version/`, whose rows have the same form.
 *
 * It imports only from `../shared.ts`, `./import.ts`, the library's public entry and Node built-ins.
 */
import { basename } from 'node:path';
import {
  asArr,
  asObj,
  assertOutFree,
  ImportRefusal,
  IMPORT_EXIT,
  isEntryPoint,
  loadTestedVersions,
  oneLineIo,
  parseFlagList,
  parseSourceFile,
  peek,
  printFailure,
  readOrUsage,
  runImporterAsProcess,
  shape,
  writeExclusive,
} from '../shared.ts';
import type { Io, TestedSet } from '../shared.ts';
import { sha256Hex } from '../../../src/index.ts';
import { assertOneSystem, assertTestedPromptfoo, oneVarsPerCase, toolErrorWords } from './import.ts';

const USAGE = 'usage: node examples/importers/promptfoo/stored-from-result.ts --in <result.json> --out <stored.json>   (both required)';

/** The stored answers of a promptfoo result file, one per case id. Pure over the bytes. */
export function storedFromResult(bytes: Uint8Array, fileName: string, tested: TestedSet = loadTestedVersions('promptfoo')): { stored: Record<string, string>; version: string; rows: number } {
  const { json } = parseSourceFile(bytes, fileName, 'promptfoo');
  const version = assertTestedPromptfoo(json, tested, 'stored-from-result.ts');
  const root = asObj(json, '/');
  const results = asObj(root['results'], '/results');
  const rows = asArr(results['results'], '/results/results').map((raw, i) => asObj(raw, `/results/results/${i}`));
  if (rows.length === 0) throw shape('/results/results', 'a non-empty array', rows);
  assertOneSystem(asObj(root['config'], '/config'), results, rows, 'the re-grade needs one answer per case, so run your system with one prompt and one provider');

  const noCase: string[] = [];
  const unfinished: string[] = [];
  const kept: { caseId: string; vars: Record<string, unknown>; path: string; output: string }[] = [];
  rows.forEach((row, i) => {
    const path = `/results/results/${i}`;
    const caseId = peek(row, 'vars', 'case_id');
    if (typeof caseId !== 'string' || caseId === '') {
      noCase.push(`${path}/vars/case_id`);
      return;
    }
    // A row that failed one of your assertions (failureReason 1) holds an answer like any other; a row the tool marked as
    // an error does not (the importer's own rule, `toolErrorWords`).
    const marked = toolErrorWords(row);
    const output = peek(row, 'response', 'output');
    if (marked.length > 0) unfinished.push(`${path} (case ${caseId}): ${marked.join('; ')}`);
    else if (typeof output !== 'string') unfinished.push(`${path} (case ${caseId}): the answer is ${output === undefined ? 'missing' : `not text (${Array.isArray(output) ? 'an array' : typeof output})`}`);
    else kept.push({ caseId, vars: asObj(row['vars'], `${path}/vars`), path, output });
  });
  if (noCase.length > 0) {
    throw new ImportRefusal('IMPORT_CASE_ID', noCase, `${noCase.length} rows have no non-empty string variable case_id (first: ${noCase[0]}); give every test one, as the re-grade's config does`);
  }
  if (unfinished.length > 0) {
    throw new ImportRefusal('IMPORT_OUTPUT_UNFINISHED', unfinished.map((u) => u.split(' ')[0] as string), `${unfinished.length} rows hold no answer: ${unfinished.join('; ')}`);
  }
  // Two tests that share a case id (the importer's own rule, `oneVarsPerCase`), before the answers are compared.
  oneVarsPerCase(kept);
  const answers = new Map<string, Set<string>>();
  for (const r of kept) answers.set(r.caseId, (answers.get(r.caseId) ?? new Set<string>()).add(r.output));
  const differ = [...answers].filter(([, outs]) => outs.size > 1).map(([id]) => id);
  if (differ.length > 0) {
    throw new ImportRefusal(
      'IMPORT_OUTPUTS_DIFFER',
      differ.map((id) => `case ${id}`),
      `${differ.length} cases have more than one answer in this file (${differ.join(', ')}); the re-grade measures the judge on one fixed answer per case, so run your system once (no --repeat) for the answers you want to keep`,
    );
  }
  return { stored: Object.fromEntries([...answers].map(([id, outs]) => [id, [...outs][0] as string])), version, rows: rows.length };
}

/** Runs the command; returns the exit code: 0 written, 2 refused, 64 usage, 70 an unexpected error. */
export function main(argv: readonly string[], rawIo: Io): number {
  const io = oneLineIo(rawIo);
  try {
    const args = parseFlagList(argv, USAGE, ['--in', '--out']);
    const inPath = args['--in'] as string;
    const outPath = args['--out'] as string;
    assertOutFree(outPath);
    const { stored, version, rows } = storedFromResult(readOrUsage(inPath), basename(inPath));
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    writeExclusive(outPath, text);
    io.out(`stored answers: ${Object.keys(stored).length} cases from ${rows} rows of a promptfoo ${version} result file, written to ${outPath}`);
    io.out(`stored file sha256: ${sha256Hex(text)}`);
    return IMPORT_EXIT.written;
  } catch (e) {
    return printFailure(rawIo, e);
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess(main, 'stored-from-result');
}
