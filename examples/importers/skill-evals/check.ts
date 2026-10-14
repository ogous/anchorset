/**
 * The offline check of a flow directory, before anything is graded.
 *
 *   node examples/importers/skill-evals/check.ts --flow <dir> --variant <name> --cases <cases.json> --reps <n>
 *        [--select <pointer>] [--bar <bar.json>]
 *
 * It reads every row of one variant and the trace of every finished slot of a stated case, and prints what was read
 * (the sha256 of `results.jsonl` and of `_state.json`, the superseded error lines, the excluded cases) and, for every
 * declared rep, whether it is whole and so can be re-graded (`regrade.ts --rep <k>`), with every problem of a rep
 * that is not. It makes no call, needs no key and writes nothing.
 *
 * It takes no `--rep`. A rep is whole when every case of the cases file holds a finished answer in it (and, with
 * `--select`, the selector selects a non-empty string on each). A rep that is not whole is listed, not refused: the
 * re-grade requires only the rep it grades. When NO rep is whole, nothing can be re-graded and the check refuses,
 * with every problem of every rep. Whatever refuses a flow in any rep (a row outside the profile, a trace that cannot
 * be read, a case of the cases file with no row at all) refuses here too.
 *
 * The cases file is the user's declaration: a case the flow holds and the cases file does not is excluded and
 * listed, with its rows and error lines. A `_state.json` that is not there is said so; its sha256 is then "UNKNOWN".
 *
 * `--reps` has no default: completeness is checked against the count the user declares, never against the rows seen.
 * It is at most 100000, and so is the number of slots of the flow it declares (the cases of the cases file times
 * `--reps`): a larger number is a usage error, before the flow is read.
 * `--select` is a JSON Pointer (RFC 6901) into the assistant turn. To check the whole turn, leave the flag out: an
 * empty value is a usage error, here and in the re-grade script. `--bar` is optional: with it, the classes and
 * labels of `cases.json` are checked against the bar, as an importer checks them.
 *
 * Exit codes, as the importers': 0 the flow reads and at least one rep is whole, 2 refused, 64 usage, 65 a cases
 * file or bar that does not validate, 70 an error the check did not foresee. Never 1.
 *
 * It imports only from `./flow.ts`, `./selector.ts` and `../shared.ts`.
 */
import { IMPORT_EXIT, inputJsonText, isEntryPoint, loadBar, parseCasesFile, parseCasesFileShape, parseFlagList, oneLineIo, positiveIntFlag, printFailure, readOrUsage, runImporterAsProcess } from '../shared.ts';
import type { CasesFile, Io } from '../shared.ts';
import { FlowRefusal, hasNoStateFile, HEADER_COUNT_BOUND, readFlow, slotLabel } from './flow.ts';
import type { FlowProblem } from './flow.ts';
import { parsePointer, SELECTOR_SYNTAX, selectorLabel, trySelect } from './selector.ts';

export const USAGE = 'usage: node examples/importers/skill-evals/check.ts --flow <dir> --variant <name> --cases <cases.json> --reps <n> [--select <pointer>] [--bar <bar.json>]';

const REQUIRED = ['--flow', '--variant', '--cases', '--reps'] as const;
const OPTIONAL = ['--select', '--bar'] as const;
type Args = Record<(typeof REQUIRED)[number], string> & Partial<Record<(typeof OPTIONAL)[number], string>>;

/**
 * The flags, by the shared flag parser: each at most once, none unknown, none with an empty value, the four required
 * ones given. An empty `--select` is a usage error here as in the re-grade script: the whole turn is the flag left out.
 */
export function parseCheckFlags(argv: readonly string[]): Args {
  return parseFlagList(argv, USAGE, REQUIRED, OPTIONAL) as Args;
}

/** Runs the check; returns the exit code. Prints what was read to `io.out`, a refusal or an error to `io.err`. */
export function main(argv: readonly string[], given: Io): number {
  // Every line printed holds text of the flow (a path, a case id, a trace file's name, a problem's detail): each is one printed line.
  const io = oneLineIo(given);
  try {
    const args = parseCheckFlags(argv);
    // `--reps`: digits only, from 1 to the path's count bound, with no default.
    const reps = positiveIntFlag('--reps', args['--reps'], USAGE, HEADER_COUNT_BOUND);
    const pointer = args['--select'];
    if (pointer !== undefined) parsePointer(pointer);
    // Both files through the path's strict reader first: UTF-8 with nothing replaced, and no key given twice.
    const bar = args['--bar'] === undefined ? undefined : loadBar(inputJsonText('bar', readOrUsage(args['--bar'])));
    // With a bar, the classes and labels are checked against it; without one, the shape of the file alone.
    const casesText = inputJsonText('cases', readOrUsage(args['--cases']));
    const cases: CasesFile = bar === undefined ? parseCasesFileShape(casesText) : parseCasesFile(casesText, bar);
    const flow = readFlow(args['--flow'], args['--variant'], cases, reps);

    // Every problem of every rep: what the reader found (a slot with no row, a row that is not a finished answer)
    // and, with a selector, every finished slot it cannot be applied to.
    const byRep = new Map<number, FlowProblem[]>(flow.notWhole.map((r) => [r.rep, [...r.problems]]));
    if (pointer !== undefined) {
      for (const s of flow.slots) {
        const got = trySelect(s.answer, pointer);
        if ('why' in got) {
          const problem: FlowProblem = { code: 'IMPORT_PACKET', field: slotLabel(s.caseId, s.draw), message: `${slotLabel(s.caseId, s.draw)}: ${selectorLabel(pointer)} cannot be applied: ${got.why}` };
          const list = byRep.get(s.draw);
          if (list === undefined) byRep.set(s.draw, [problem]);
          else list.push(problem);
        }
      }
    }
    const repNumbers = Array.from({ length: reps }, (_, k) => k);
    const whole = repNumbers.filter((k) => !byRep.has(k));
    // No rep can be re-graded: a refusal, with every problem of every rep in the order of the reps.
    if (whole.length === 0) throw new FlowRefusal(repNumbers.flatMap((k) => byRep.get(k) ?? []), `the flow: none of its ${reps} declared rep(s) is whole, so none can be re-graded`);

    const nCases = Object.keys(cases).length;
    io.out(`read: flow ${args['--flow']}, variant ${flow.variant}, row profile ${flow.rowProfile}`);
    io.out(`cases: ${nCases} in the cases file; reps declared: ${reps}`);
    for (const k of repNumbers) {
      const problems = byRep.get(k);
      if (problems === undefined) io.out(`rep ${k}: whole (${nCases} finished answer${nCases === 1 ? '' : 's'}, each with its trace); it can be re-graded with --rep ${k}`);
      else {
        io.out(`rep ${k}: NOT whole; it cannot be re-graded (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
        for (const p of problems) io.out(`  ${p.code}: ${p.message}`);
      }
    }
    io.out(`reps that can be re-graded: ${whole.join(', ')} (${whole.length} of ${reps})`);
    io.out(`excluded cases (in the flow, not in the cases file; never graded, their traces not read): ${flow.excluded.length}`);
    for (const c of flow.excluded) {
      const rowsText = c.rows.map((r) => `results.jsonl line ${r.line} (rep ${r.rep}, ${r.finished ? 'a finished answer' : 'not a finished answer'})`);
      const errorsText = c.errorLines.length > 0 ? [`errors.jsonl line ${c.errorLines.join(', ')}`] : [];
      io.out(`  ${c.caseId}: ${[...(rowsText.length > 0 ? rowsText : ['no row']), ...errorsText].join('; ')}`);
    }
    io.out(`results.jsonl sha256: ${flow.resultsSha256}`);
    io.out(hasNoStateFile(flow) ? `_state.json sha256: ${flow.stateSha256} (the flow holds no _state.json; harness_sha is ${flow.harnessSha} too)` : `_state.json sha256: ${flow.stateSha256}`);
    io.out(`superseded error lines: ${flow.superseded.length}`);
    for (const e of flow.superseded) io.out(`  errors.jsonl line ${e.line}: ${slotLabel(e.caseId, e.draw)} (a later attempt at this slot wrote its row)`);
    if (flow.unusedTraces.length > 0) io.out(`trace files no row names (not read, not bound): ${flow.unusedTraces.join(', ')}`);
    io.out(pointer === undefined ? 'selector: none given; the judge would be shown the whole assistant turn' : `${selectorLabel(pointer)} (${SELECTOR_SYNTAX}): selects a non-empty string on every slot of each whole rep`);
    io.out(bar === undefined ? 'cases: the classes and labels were not checked against a bar (no --bar)' : 'cases: every class and label is in the bar');
    io.out('nothing was written and no call was made');
    return IMPORT_EXIT.written;
  } catch (e) {
    return printFailure(io, e);
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runImporterAsProcess(main, 'skill-evals check');
}
