// Regenerates the synthetic demo data in this folder: node examples/refund-bot/generate.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANCHOR_SCHEMA, barHash, CALL_SHAPE_SCHEMA, caseSetHash, callShapeHash, hashOf, NO_JUDGE, NOT_SENT, outputHashOf, packetHashOf, parseBarFile, RATINGS_SCHEMA, RUN_SCHEMA, sha256Hex } from '../../src/index.ts';
import { seedFromString } from '../../src/rng.ts';
import type { BarFile, CallShape, Case, Draw, RunArtifact, RunIdentity } from '../../src/index.ts';

const dir = import.meta.dirname;
const write = (name: string, value: unknown): void => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

// Would the bot hand this conversation to a human? Lowest to highest.
const labels = ['none', 'review', 'handoff'];

const bar: BarFile = parseBarFile({
  labels,
  classes: {
    must_handoff: { direction: 'floor', nonCompensable: true, minPassRate: 1.0 },
    should_review: { direction: 'floor', minPassRate: 0.9 },
    routine: { direction: 'ceiling', minPassRate: 0.9 },
  },
  knownFailures: [],
});

const messages: [string, string, string][] = [
  ['h01', 'must_handoff', 'I was charged three times for the same order and my bank calls it fraud. Fix this today.'],
  ['h02', 'must_handoff', 'I am the account holder\'s attorney. Send all further correspondence to me.'],
  ['h03', 'must_handoff', 'Someone logged into my account and placed two orders I did not make.'],
  ['h04', 'must_handoff', 'The courier left my parcel outside and it was stolen. I have a police report number.'],
  ['h05', 'must_handoff', 'Close my account and send me a full export of the data you hold on me.'],
  ['v01', 'should_review', 'The item arrived two days after the 30-day window. Can I still return it?'],
  ['v02', 'should_review', 'I got a partial refund but the shipping fee was not included.'],
  ['v03', 'should_review', 'My discount code did not apply at checkout. Can you refund the difference?'],
  ['v04', 'should_review', 'I returned the jacket a month ago and still have not seen the refund.'],
  ['v05', 'should_review', 'The tracking says delivered but the package is nowhere to be found.'],
  ['r01', 'routine', 'How long do refunds usually take to show up?'],
  ['r02', 'routine', 'Where do I find my order number?'],
  ['r03', 'routine', 'Can I return an item I bought on sale?'],
  ['r04', 'routine', 'Do you ship to Canada?'],
  ['r05', 'routine', 'What is your return address?'],
  ['r06', 'routine', 'Can I change the delivery date?'],
  ['r07', 'routine', 'Is there a restocking fee?'],
  ['r08', 'routine', 'Do you offer gift receipts?'],
  ['r09', 'routine', 'Can I exchange for a different colour instead of a refund?'],
  ['r10', 'routine', 'Which payment methods do you accept?'],
];

const expectFor: Record<string, string> = { must_handoff: 'handoff', should_review: 'review', routine: 'none' };
const cases: Case[] = messages.map(([id, klass, message]) => ({ id, klass, input: { message }, expect: expectFor[klass] as string }));

function draws(overrides: Record<string, string[]>): Draw[] {
  return cases.flatMap((c) =>
    (overrides[c.id] ?? [c.expect, c.expect, c.expect]).map((label, drawIndex) => ({
      caseId: c.id,
      drawIndex,
      attempts: [{ kind: 'graded' as const, label, outputHash: sha256Hex(`route: ${label}`), systemStop: 'tool-use' as const, judgeStop: NO_JUDGE, packetHash: NO_JUDGE }],
    })),
  );
}

const systemPrompt = 'You are the refund assistant for an online store. Decide whether to hand the conversation to a human.';
// The bot answers through one forced routing tool.
const routeTool = { name: 'route', input: { label: labels } };
const shape: CallShape = {
  schema: CALL_SHAPE_SCHEMA,
  endpoint: 'example-provider:messages',
  apiVersion: '2026-01-01',
  betaFlags: [],
  thinkingMode: 'off',
  thinkingBudgetTokens: NOT_SENT,
  effort: NOT_SENT,
  toolChoice: 'named',
  toolChoiceName: 'route',
  strictTools: true,
  parallelToolUse: false,
  temperature: 0,
  topP: NOT_SENT,
  topK: NOT_SENT,
  frequencyPenalty: NOT_SENT,
  presencePenalty: NOT_SENT,
  samplingSeed: NOT_SENT,
  maxOutputTokens: 512,
  stopSequences: NOT_SENT,
  responseFormat: { kind: 'tool', name: 'route' },
  contextPolicy: 'none',
  stream: false,
  timeoutMs: 30000,
  extras: {},
};

const identity = (systemModelServed: string, callShape: CallShape): RunIdentity => ({
  caseSetHash: caseSetHash(cases),
  rubricHash: hashOf({ rubric: 'refund-bot handoff routing', version: 1, labels }),
  barHash: barHash(bar),
  systemModelRequested: 'example-model-a',
  systemModelServed,
  systemCallShapeHash: callShapeHash(callShape),
  systemPromptHash: sha256Hex(systemPrompt),
  systemToolsHash: hashOf([routeTool]),
  systemHarnessVersion: 'refund-harness 1.4.0',
  judgeDefinitionHash: NO_JUDGE,
  judgeModelRequested: NO_JUDGE,
  judgeModelServed: NO_JUDGE,
  judgeCallShapeHash: NO_JUDGE,
  judgeHarnessVersion: NO_JUDGE,
  seed: seedFromString('refund-bot demo'),
  drawsPerCase: 3,
});

const baselineDraws = draws({ v01: ['review', 'handoff', 'review'], r07: ['none', 'review', 'none'] });
// One call timed out and was retried: the slot keeps both attempts, and only the retry measured anything.
const retried = baselineDraws.find((d) => d.caseId === 'r02' && d.drawIndex === 1);
if (retried !== undefined) retried.attempts = [{ kind: 'unmeasured', role: 'system', reason: 'timeout', detail: 'no response within 30000 ms' }, ...retried.attempts];

const baseline: RunArtifact = {
  schema: RUN_SCHEMA,
  identity: identity('example-model-a-2026-01-15', shape),
  callShapes: { system: shape, judge: NO_JUDGE },
  packetBasis: NO_JUDGE,
  cases,
  draws: baselineDraws,
};

// The alias moved to a newer model and the temperature changed: one must-handoff case breaks, r07 is fixed.
const candidateShape: CallShape = { ...shape, temperature: 0.3 };
const candidate: RunArtifact = {
  schema: RUN_SCHEMA,
  identity: identity('example-model-a-2026-06-01', candidateShape),
  callShapes: { system: candidateShape, judge: NO_JUDGE },
  packetBasis: NO_JUDGE,
  cases,
  draws: draws({ v01: ['review', 'handoff', 'review'], h03: ['handoff', 'review', 'handoff'] }),
};

write('bar.json', bar);
write('baseline.json', baseline);
write('candidate.json', candidate);

// The same 20 messages with a judge in the loop, for `flips`: the bot's routing was read by an LLM judge, three
// draws per case. The bot runs at temperature 0, so for 18 cases the three draws hold one stored output and only
// the judge's grades can differ: they do on v02 and r05. On v01 and h03 the bot itself answered differently between
// draws, so a label difference there (v01) mixes the bot's variation with the judge's.
const judgeShape: CallShape = { ...shape, toolChoiceName: 'grade', responseFormat: { kind: 'tool', name: 'grade' }, maxOutputTokens: 256 };
const judgedLabels: Record<string, string[]> = { v02: ['review', 'review', 'handoff'], r05: ['none', 'review', 'none'], v01: ['review', 'handoff', 'review'] };
const freshOutputs = ['v01', 'h03'];
const judgedDraws: Draw[] = cases.flatMap((c) =>
  [0, 1, 2].map((drawIndex) => {
    const reply = freshOutputs.includes(c.id) ? `reply to ${c.id}, wording ${drawIndex + 1}` : `reply to ${c.id}`;
    const label = (judgedLabels[c.id] ?? [c.expect, c.expect, c.expect])[drawIndex] as string;
    const packetHash = packetHashOf({ message: (c.input as { message: string }).message }, reply);
    return { caseId: c.id, drawIndex, attempts: [{ kind: 'graded' as const, label, outputHash: outputHashOf(reply), systemStop: 'tool-use' as const, judgeStop: 'tool-use' as const, packetHash }] };
  }),
);
const judged: RunArtifact = {
  schema: RUN_SCHEMA,
  identity: {
    ...identity('example-model-a-2026-01-15', shape),
    judgeDefinitionHash: hashOf({ judge: 'refund-bot routing judge', version: 1, labels }),
    judgeModelRequested: 'example-judge',
    judgeModelServed: 'example-judge-2026-01-15',
    judgeCallShapeHash: callShapeHash(judgeShape),
    judgeHarnessVersion: 'refund-harness 1.4.0',
  },
  callShapes: { system: shape, judge: judgeShape },
  packetBasis: 'recorded',
  cases,
  draws: judgedDraws,
};
write('judged.json', judged);

// Three raters on 20 transcripts, all shown the same packet.
const truth = ['none', 'none', 'review', 'handoff', 'none', 'review', 'none', 'handoff', 'none', 'review',
  'none', 'none', 'review', 'none', 'handoff', 'none', 'review', 'none', 'none', 'review'];
const items = truth.map((_, i) => `t${String(i + 1).padStart(2, '0')}`);
const flips: Record<string, Record<number, string>> = {
  'rater-a': { 2: 'none', 7: 'review' },
  'rater-b': { 9: 'none', 12: 'handoff', 18: 'review' },
  'rater-c': { 2: 'none', 5: 'handoff', 16: 'none' },
};
const ratings: Record<string, Record<string, string>> = {};
const packetHashes: Record<string, Record<string, string>> = {};
for (const [rater, f] of Object.entries(flips)) {
  ratings[rater] = Object.fromEntries(items.map((id, i) => [id, f[i] ?? (truth[i] as string)]));
  packetHashes[rater] = Object.fromEntries(items.map((id) => [id, hashOf({ packet: id, format: 'transcript-v2' })]));
}
write('ratings.json', { schema: RATINGS_SCHEMA, raterIdentity: 'persistent', categories: labels, ratings, packetHashes, bootstrap: { iterations: 2000, seed: 7, alpha: 0.05 } });

// The same 24 anchor items judged before and after a judge prompt edit. The new judge is stricter:
// three review -> handoff and one none -> review. Rates move, the flagged items stay the same.
const anchors = Array.from({ length: 24 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
const oldVerdicts = Object.fromEntries(anchors.map((id, i) => [id, i < 12 ? 'none' : i < 20 ? 'review' : 'handoff']));
const newVerdicts: Record<string, string> = { ...oldVerdicts, a13: 'handoff', a14: 'handoff', a15: 'handoff', a01: 'review' };
const anchorPackets = Object.fromEntries(anchors.map((id) => [id, hashOf({ packet: id, format: 'transcript-v2' })]));
write('anchor_old.json', { schema: ANCHOR_SCHEMA, labels, verdicts: oldVerdicts, packetHashes: anchorPackets });
write('anchor_new.json', { schema: ANCHOR_SCHEMA, labels, verdicts: newVerdicts, packetHashes: anchorPackets });
