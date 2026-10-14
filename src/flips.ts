import { runArtifactProblems } from './artifact.ts';
import type { RunArtifact } from './artifact.ts';
import { InputError, RefusalError } from './errors.ts';
import { GAP, NO_JUDGE } from './identity.ts';
import { repeatFlips as repeatFlipsOfDraws } from './stability.ts';
import type { RepeatFlipReport } from './stability.ts';
import type { BootstrapOptions } from './stats.ts';

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
 * case, a slot that measured nothing), which the draws-level function in `stability.ts` holds and which runs after this one.
 *
 * Also refused: a run that does not say how many draws each case has (IDENTITY_GAP on `drawsPerCase`).
 *
 * Before either lock, the parser's own checks run over the run (the ones `gateRuns` runs), so a caller that skipped
 * `parseRunArtifact` gets an INVALID_ARTIFACT input error naming the field, not a number from a malformed run. A
 * missing bootstrap setting is an INVALID_ARGUMENT input error.
 */
export function repeatFlips(run: RunArtifact, bootstrap: BootstrapOptions): RepeatFlipReport {
  if (typeof bootstrap !== 'object' || bootstrap === null) {
    throw new InputError('INVALID_ARGUMENT', ['bootstrap: required (iterations, seed and alpha)']);
  }
  const invalid = runArtifactProblems(run);
  if (invalid.length > 0) throw new InputError('INVALID_ARTIFACT', invalid);
  const basis = run.packetBasis;
  if (basis === 'declared') {
    throw new RefusalError(
      'PACKET_MISMATCH',
      ['packetBasis'],
      `the run's packets are declared${run.packetSource === undefined ? '' : ` (${run.packetSource})`}, not recorded; labels that differ between draws are shown to differ by the grader alone only when the packet of every attempt was observed. flips needs a run whose own harness recorded its packets`,
    );
  }
  if (basis === GAP) {
    throw new RefusalError('IDENTITY_GAP', ['packetBasis'], 'the run does not say whether its packets were recorded or declared, so draws cannot be shown to have been graded in one packet');
  }
  if (basis !== 'recorded' && basis !== NO_JUDGE) {
    throw new RefusalError('IDENTITY_GAP', ['packetBasis'], `packetBasis ${String(basis)} is not one flips admits (recorded, or ${NO_JUDGE} for a run with no judge)`);
  }
  const perCase = run.identity.drawsPerCase;
  if (typeof perCase !== 'number') {
    throw new RefusalError('IDENTITY_GAP', ['drawsPerCase'], 'the run does not say how many draws each case has, so a case cannot be shown to hold all of its draws');
  }
  return repeatFlipsOfDraws(run.draws, perCase, run.cases.map((c) => c.id), bootstrap);
}
