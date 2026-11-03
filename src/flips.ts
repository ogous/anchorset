import { runArtifactProblems } from './artifact.ts';
import type { RunArtifact } from './artifact.ts';
import { InputError, RefusalError } from './errors.ts';
import { GAP, JUDGE_FIELDS, NO_JUDGE } from './identity.ts';
import { SYSTEM_SIDE_FIELDS } from './judgechange.ts';
import { unknownStops } from './scoring.ts';
import { repeatFlips as repeatFlipsOfDraws } from './stability.ts';
import type { RepeatFlipReport } from './stability.ts';
import type { BootstrapOptions } from './stats.ts';

/** The one value of the stored-output declaration, the word `judge-change` plans use. */
export const STORED_OUTPUTS_DECLARED = 'system-side-not-compared';
/** Options of `repeatFlips`. Leaving `storedOutputs` out keeps every refusal of an unknown stop. */
export type RepeatFlipOptions = { storedOutputs?: typeof STORED_OUTPUTS_DECLARED };

/**
 * Label flips among the repeat draws of one run: the one public entry of the stability measurement. It takes the run,
 * not its draws, so that it can read what the run says about its packets before it reads a draw.
 *
 * `flips` rests on two locks, and this is the first. A flip is a label difference between draws of one stored output
 * shown in one packet, and only a run that recorded the packet of every attempt can show that. A run whose packet
 * basis is "declared" (every run an importer writes) was never observed to have shown the same packet twice, so the
 * whole run is refused: PACKET_MISMATCH naming `packetBasis`, different-output cases included. A basis that is
 * unknown is refused as IDENTITY_GAP. Only "recorded" and "NO_JUDGE" (no judge, so no packet) are admitted.
 * The second lock is the draw-level one (unknown output hashes and system stops, an unknown packet on a one-output
 * case, a slot that holds no grade), which the draws-level function in `stability.ts` holds and which runs after this one.
 *
 * Between them sits the judge's identity. Draws are shown to come from one judge only when that judge is known, so a run
 * with a judge is refused as IDENTITY_GAP when its rubric or any judge field is unknown. A run graded by code has no
 * judge to know, and its rubric hash is not read.
 *
 * Also refused: a run that does not say how many draws each case has (IDENTITY_GAP on `drawsPerCase`).
 *
 * `options.storedOutputs` is the user's declaration that the graded texts are stored ones, whose stops nobody observed.
 * It lets an unknown stop through the second lock on a run with recorded packets, a known judge and rubric, at least one
 * unknown stop, and one output in each case; each of these is a refusal naming its fields. The shares then hold for the
 * texts as they stand, a cut-off answer included, and `notCompared` says so. The declaration is not hashed and can be
 * made after seeing the results, so it records a choice and does not show when the choice was made.
 *
 * Before either lock, the parser's own checks run over the run (the ones `gateRuns` runs), so a caller that skipped
 * `parseRunArtifact` gets an INVALID_ARTIFACT input error naming the field, not a number from a malformed run. A
 * missing bootstrap setting is an INVALID_ARGUMENT input error.
 */
export function repeatFlips(run: RunArtifact, bootstrap: BootstrapOptions, options: RepeatFlipOptions = {}): RepeatFlipReport {
  if (typeof bootstrap !== 'object' || bootstrap === null) {
    throw new InputError('INVALID_ARGUMENT', ['bootstrap: required (iterations, seed and alpha)']);
  }
  const stored = options.storedOutputs;
  if (stored !== undefined && stored !== STORED_OUTPUTS_DECLARED) {
    throw new InputError('INVALID_ARGUMENT', [`storedOutputs: must be ${STORED_OUTPUTS_DECLARED}, got ${String(stored)}`]);
  }
  const invalid = runArtifactProblems(run);
  if (invalid.length > 0) throw new InputError('INVALID_ARTIFACT', invalid);
  const basis = run.packetBasis;
  if (basis === 'declared') {
    throw new RefusalError(
      'PACKET_MISMATCH',
      ['packetBasis'],
      `the run's packets are declared${run.packetSource === undefined ? '' : ` (${run.packetSource})`}, not recorded; draws are shown to have been graded in one packet only when the packet of every attempt was observed. flips needs a run whose own harness recorded its packets`,
    );
  }
  if (basis === GAP) {
    throw new RefusalError('IDENTITY_GAP', ['packetBasis'], 'the run does not say whether its packets were recorded or declared, so draws cannot be shown to have been graded in one packet');
  }
  if (basis !== 'recorded' && basis !== NO_JUDGE) {
    throw new RefusalError('IDENTITY_GAP', ['packetBasis'], `packetBasis ${String(basis)} is not one flips admits (recorded, or ${NO_JUDGE} for a run with no judge)`);
  }
  if (stored !== undefined && run.identity.judgeDefinitionHash === NO_JUDGE) {
    throw new RefusalError('UNSUPPORTED_DESIGN', ['judgeDefinitionHash'], 'stored outputs were declared on a run graded by code; the declaration is for a judge grading stored texts');
  }
  if (run.identity.judgeDefinitionHash !== NO_JUDGE) {
    const unknown = (['rubricHash', ...JUDGE_FIELDS] as const).filter((f) => run.identity[f] === GAP);
    if (unknown.length > 0) {
      throw new RefusalError('IDENTITY_GAP', unknown, 'the run does not say who graded it, so its draws cannot be shown to come from one judge');
    }
  }
  const perCase = run.identity.drawsPerCase;
  if (typeof perCase !== 'number') {
    throw new RefusalError('IDENTITY_GAP', ['drawsPerCase'], 'the run does not say how many draws each case has, so a case cannot be shown to hold all of its draws');
  }
  const caseIds = run.cases.map((c) => c.id);
  if (stored === undefined) {
    // A run graded by code has no judge to grade a stored text, so the declaration is no way forward for it.
    const graded = run.identity.judgeDefinitionHash === NO_JUDGE ? {} : { hint: `if these are stored outputs, say so with --stored-outputs ${STORED_OUTPUTS_DECLARED}` };
    return repeatFlipsOfDraws(run.draws, perCase, caseIds, bootstrap, graded);
  }
  const unknownStopDraws = unknownStops(run.draws).length;
  if (unknownStopDraws === 0) {
    throw new RefusalError('UNSUPPORTED_DESIGN', ['systemStop'], 'stored outputs were declared, but every system stop in the run is known; the run needs no declaration');
  }
  const report = repeatFlipsOfDraws(run.draws, perCase, caseIds, bootstrap, { admitUnknown: true });
  return { ...report, notCompared: { fields: [...SYSTEM_SIDE_FIELDS, 'systemStop'], unknownStopDraws, draws: run.draws.length } };
}
