// Re-runs a study manifest (docs/JUDGE_CHANGE.md): verifies every input file by its sha256,
// recomputes the judge-change report with this version of the library, and compares every in-scope
// cell with the value as published. Each release runs every released manifest.
//
//   node tools/study-check.ts <manifest.json> [--json]
//
// exit 0: every cell matches · 1: a cell differs · 2: refused · 64: usage · 65: invalid input · 70: internal error
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEntryPoint, printRefusal, runAsProcess, textIo } from "../src/cli.ts";
import { InputError, RefusalError } from "../src/errors.ts";
import { parseBarFile } from "../src/gate.ts";
import { hashOf, parseJsonText, sha256Hex, utf8Text } from "../src/identity.ts";
import { judgeChangeRuns, parseJudgeChangePlan } from "../src/judgechange.ts";
import { checkStudyCells, parseStudyManifest, studyInputName } from "../src/study.ts";
import { TOOL_NAME, TOOL_VERSION } from "../src/version.ts";

type Io = { out: (s: string) => void; err: (s: string) => void };

/** The bytes of a file. A file that cannot be read is invalid input that names it: the one place where an error of the file system is expected. */
function readBytes(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new InputError("INVALID_ARGUMENT", [`cannot read ${path}: ${(e as Error).message}`]);
  }
}

/**
 * The value of the JSON file `name` from its bytes, read by the library's one decoder and its one JSON reader.
 * Bytes that are not UTF-8, a byte-order mark, a text nested too deep and a text in which an object gives a key
 * twice are invalid input that names the file. A text that is not JSON throws the parser's own error.
 */
function readJson(name: string, bytes: Uint8Array): unknown {
  const decoded = utf8Text(bytes);
  if ("problem" in decoded) throw new InputError("INVALID_ARGUMENT", [`${name}: ${decoded.problem}`]);
  const parsed = parseJsonText(decoded.text);
  if (!("problem" in parsed)) return parsed.json;
  if (parsed.notJson) JSON.parse(decoded.text);
  throw new InputError("INVALID_ARGUMENT", [`${name}: ${parsed.problem}`]);
}

export function main(argv: readonly string[], io: Io): number {
  // Every text line below may hold what a file or the command line gave (a path, a cell's name, a problem): the
  // library's printer writes each as one line, whatever it holds. The --json report goes to `io` as it is.
  const text = textIo(io);
  // Exactly one path and, optionally, one --json: any other flag, a second path or a repeated --json is a usage error.
  const jsonFlags = argv.filter((a) => a === "--json");
  const paths = argv.filter((a) => !a.startsWith("-"));
  const path = paths[0];
  if (path === undefined || paths.length !== 1 || jsonFlags.length > 1 || argv.length !== paths.length + jsonFlags.length) {
    text.err("usage: node tools/study-check.ts <manifest.json> [--json]");
    return 64;
  }
  try {
    const manifest = parseStudyManifest(readJson(path, readBytes(path)));
    const dir = dirname(path);
    const files = manifest.inputs.map((f) => ({ ...f, bytes: readBytes(join(dir, f.path)) }));
    const changed = files.filter((f) => sha256Hex(f.bytes) !== f.sha256).map((f) => f.path);
    if (changed.length > 0) throw new RefusalError("HASH_MISMATCH", changed, `these files are not the ones the manifest names: ${changed.join(", ")}`);
    const json = (role: string): unknown => {
      const f = files.find((x) => x.role === role) as (typeof files)[number];
      return readJson(f.path, f.bytes);
    };
    const inputs = files.filter((f) => ["run", "reference", "tie-break", "resample-indices"].includes(f.role)).map((f) => ({ name: studyInputName(f.path), bytes: f.bytes }));
    const report = judgeChangeRuns(inputs, parseBarFile(json("bar")), parseJudgeChangePlan(json("plan")));
    const result = checkStudyCells(manifest, report);
    // The report names the library version that made it. A later version that changes nothing else makes the first run's
    // report but for that one field; the check says so, and never calls it "byte for byte".
    const firstRunReport = hashOf(report) === manifest.firstRun.resultSha256 ? "byte for byte" : hashOf({ ...report, tool: { ...report.tool, version: manifest.library.version } }) === manifest.firstRun.resultSha256 ? "apart from the tool version" : "differs";
    const out = { study: manifest.study, tool: `${TOOL_NAME} ${TOOL_VERSION}`, cells: manifest.cells.length, ...result, excluded: manifest.excluded.length, resultSha256: hashOf(report), firstRunResultSha256: manifest.firstRun.resultSha256, firstRunReport };
    if (jsonFlags.length === 1) io.out(JSON.stringify(out, null, 2));
    else {
      text.out(`${manifest.study}: ${result.matched} of ${manifest.cells.length} in-scope cells match (${manifest.excluded.length} excluded, each with its reason) · ${TOOL_NAME} ${TOOL_VERSION}`);
      for (const m of result.mismatches) text.out(`  DIFFERS  ${m.name}: published ${m.expected}, recomputed ${m.got}  (${m.path})`);
      if (result.mismatches.length > 0) text.out(`  the manifest was last verified by ${manifest.lastVerified.version} (${manifest.lastVerified.commit}); the expected values stay as published`);
      const said = firstRunReport === "byte for byte" ? "is the first run's, byte for byte" : firstRunReport === "apart from the tool version" ? `is the first run's apart from the tool version (${manifest.library.version} in the manifest, ${TOOL_VERSION} here)` : "differs from the first run's in some field outside the cells, or in a cell";
      text.out(`  cell list ${manifest.cellsSha256} · this report ${said}`);
    }
    return result.mismatches.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusalError) {
      printRefusal(text, e);
      return 2;
    }
    if (e instanceof InputError) {
      text.err(`invalid input (${e.code})`);
      for (const p of e.problems) text.err(`  - ${p}`);
      return 65;
    }
    // The parser's own refusal of a text that is not JSON (readJson). An error that merely carries a code is not invalid input.
    if (e instanceof SyntaxError) {
      text.err(`invalid input: ${(e as Error).message}`);
      return 65;
    }
    // Anything else was not foreseen. Uncaught, it would end the process with exit 1, which here means "a cell differs".
    text.err(`internal error: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ")}`);
    return 70;
  }
}

// As the CLI does: a reader that closed its end of the pipe never turns the exit code into 1, which here means "a cell differs".
// A write that fails for any other reason is exit 70, with a line that names this tool.
if (isEntryPoint(import.meta.url, process.argv[1])) runAsProcess(main, "study-check");
