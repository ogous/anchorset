// Regenerates the run file that docs/RUN_FORMAT.md quotes: node examples/run-format/generate.ts [out-dir]
// The data are synthetic. Without an argument the files are written into this folder.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { barHash, CALL_SHAPE_SCHEMA, callShapeHash, caseSetHash, hashOf, NOT_SENT, outputHashOf, packetHashOf, parseBarFile, parseRunArtifact, RUN_SCHEMA, sha256Hex } from '../../src/index.ts';
import type { BarFile, CallShape, Case, Draw, RunArtifact } from '../../src/index.ts';

const dir = process.argv[2] ?? import.meta.dirname;
const write = (name: string, value: unknown): void => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

// A judge grades each reply of a refund bot from 1 to 5. A reply passes at 4 or above.
const bar: BarFile = parseBarFile({
  labels: ['1', '2', '3', '4', '5'],
  classes: { reply_quality: { direction: 'floor', minPassRate: 0.5 } },
  knownFailures: [],
});

const cases: Case[] = [
  { id: 'q01', klass: 'reply_quality', input: { message: 'How long do refunds usually take to show up?' }, expect: '4' },
  { id: 'q02', klass: 'reply_quality', input: { message: 'I returned the jacket a month ago and still have not seen the refund.' }, expect: '4' },
  { id: 'q03', klass: 'reply_quality', input: { message: 'Can I return an item I bought on sale?' }, expect: '4' },
];
const messageOf = (id: string): string => ((cases.find((c) => c.id === id) as Case).input as { message: string }).message;

// What the bot said on each draw. The run file keeps the sha256 of each reply, never the text.
const replies: Record<string, string> = {
  'q01#0': 'Refunds reach your card within five to seven working days of our receiving the item.',
  'q01#1': 'Once the item is back with us, the refund takes five to seven working days.',
  'q02#0': 'I am sorry for the wait. I have found the return and passed it to the refunds team, who will write to you today.',
  'q02#1': 'I am sorry about that. Your return arrived on the 3rd; I have asked the refunds team to release the payment.',
  'q03#1': 'Yes. Sale items can be returned within 30 days, like any other item.',
};
// On q03, draw 0, the reply ran into the output budget and was cut off. No output is graded: the failure record is hashed.
const truncated = { failed: 'truncated', detail: 'the reply reached maxOutputTokens (512)' };

// The call shape of each role: every key is present, and a setting the harness did not send says so.
const shape = (toolChoice: 'none' | 'named', name: string | undefined, maxOutputTokens: number): CallShape => ({
  schema: CALL_SHAPE_SCHEMA,
  endpoint: 'example-provider:messages',
  apiVersion: '2026-01-01',
  betaFlags: [],
  thinkingMode: 'off',
  thinkingBudgetTokens: NOT_SENT,
  effort: NOT_SENT,
  toolChoice,
  toolChoiceName: name ?? NOT_SENT,
  strictTools: name === undefined ? NOT_SENT : true,
  parallelToolUse: NOT_SENT,
  temperature: 0,
  topP: NOT_SENT,
  topK: NOT_SENT,
  frequencyPenalty: NOT_SENT,
  presencePenalty: NOT_SENT,
  samplingSeed: NOT_SENT,
  maxOutputTokens,
  stopSequences: NOT_SENT,
  responseFormat: name === undefined ? { kind: 'text' } : { kind: 'tool', name },
  contextPolicy: 'none',
  stream: false,
  timeoutMs: 30000,
  extras: {},
});
const systemShape = shape('none', undefined, 512);
const judgeShape = shape('named', 'grade', 256);

const systemPrompt = 'You are the refund assistant for an online store. Answer the customer in two sentences at most.';
const judgePrompt = 'Grade the reply to the customer from 1 to 5 against the rubric. Answer through the grade tool.';
const gradeTool = { name: 'grade', input: { grade: ['1', '2', '3', '4', '5'] } };
const rubric = { rubric: 'refund-bot reply quality', version: 1, passAt: '4' };

// One graded attempt: the reply's hash, why the system stopped, why the judge stopped, and what the judge was shown.
const graded = (caseId: string, drawIndex: number, label: string) => {
  const reply = replies[`${caseId}#${drawIndex}`] as string;
  return { kind: 'graded' as const, label, outputHash: outputHashOf(reply), systemStop: 'end' as const, judgeStop: 'tool-use' as const, packetHash: packetHashOf({ message: messageOf(caseId) }, reply) };
};

const q02 = graded('q02', 0, '5');
const draws: Draw[] = [
  { caseId: 'q01', drawIndex: 0, attempts: [graded('q01', 0, '5')] },
  // The first call to the system timed out and was retried. The slot keeps both attempts; only the last one measured anything.
  { caseId: 'q01', drawIndex: 1, attempts: [{ kind: 'unmeasured', role: 'system', reason: 'timeout', detail: 'no response within 30000 ms' }, graded('q01', 1, '4')] },
  // The judge's first call got a server error. The retry grades the same stored reply: same output, stop and packet.
  {
    caseId: 'q02',
    drawIndex: 0,
    attempts: [{ kind: 'unmeasured', role: 'judge', reason: 'server-error', detail: 'the judge call returned HTTP 500', outputHash: q02.outputHash, systemStop: q02.systemStop, packetHash: q02.packetHash }, q02],
  },
  { caseId: 'q02', drawIndex: 1, attempts: [graded('q02', 1, '4')] },
  // A truncated reply is the system's own failure. It is never graded and never retried, and it fails the case.
  { caseId: 'q03', drawIndex: 0, attempts: [{ kind: 'failed', reason: 'truncated', detail: truncated.detail, outputHash: outputHashOf(truncated), systemStop: 'max-tokens' }] },
  { caseId: 'q03', drawIndex: 1, attempts: [graded('q03', 1, '4')] },
];

const run: RunArtifact = {
  schema: RUN_SCHEMA,
  identity: {
    caseSetHash: caseSetHash(cases),
    rubricHash: hashOf(rubric),
    barHash: barHash(bar),
    systemModelRequested: 'example-model-a',
    systemModelServed: 'example-model-a-2026-01-15',
    systemCallShapeHash: callShapeHash(systemShape),
    systemPromptHash: sha256Hex(systemPrompt),
    systemToolsHash: hashOf([]),
    systemHarnessVersion: 'refund-harness 1.4.0',
    judgeDefinitionHash: hashOf({ prompt: judgePrompt, tools: [gradeTool] }),
    judgeModelRequested: 'example-judge',
    judgeModelServed: 'example-judge-2026-02-01',
    judgeCallShapeHash: callShapeHash(judgeShape),
    judgeHarnessVersion: 'refund-harness 1.4.0',
    seed: 20260115,
    drawsPerCase: 2,
  },
  callShapes: { system: systemShape, judge: judgeShape },
  cases,
  draws,
  packetBasis: 'recorded',
};

write('bar.json', bar);
write('run.json', parseRunArtifact(run));
