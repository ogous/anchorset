// Regenerates the two run files of the `conditions` example: node examples/conditions/generate.ts [out-dir]
// The data are synthetic. A refund bot answers four questions, twice each; a judge grades each answer through a
// provider's batch route. The two runs use the same models, settings and prompts. They differ in how the judge's
// requests went out (one batch, or two) and in what the responses carried, and one label differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { barHash, CALL_SHAPE_SCHEMA, callShapeHash, caseSetHash, hashOf, NOT_RETURNED, NOT_SENT, outputHashOf, packetHashOf, parseBarFile, parseRunArtifact, RUN_SCHEMA, sha256Hex } from '../../src/index.ts';
import type { BarFile, CallRecord, CallShape, Case, Draw, RunArtifact, RunConditions } from '../../src/index.ts';

const dir = process.argv[2] ?? import.meta.dirname;
const write = (name: string, value: unknown): void => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

const bar: BarFile = parseBarFile({ labels: ['1', '2', '3', '4', '5'], classes: { reply_quality: { direction: 'floor', minPassRate: 0.5 } }, knownFailures: [] });
const cases: Case[] = [
  { id: 'q01', klass: 'reply_quality', input: { message: 'How long do refunds usually take to show up?' }, expect: '4' },
  { id: 'q02', klass: 'reply_quality', input: { message: 'I returned the jacket a month ago and still have not seen the refund.' }, expect: '4' },
  { id: 'q03', klass: 'reply_quality', input: { message: 'Can I return an item I bought on sale?' }, expect: '4' },
  { id: 'q04', klass: 'reply_quality', input: { message: 'Do you refund the shipping cost?' }, expect: '4' },
];
const replyOf = (id: string): string => `Thanks for asking about ${id}: refunds reach your card within five to seven working days.`;

const shape = (endpoint: string, toolChoice: 'none' | 'named', maxOutputTokens: number): CallShape => ({
  schema: CALL_SHAPE_SCHEMA,
  endpoint,
  apiVersion: '2026-01-01',
  betaFlags: [],
  thinkingMode: 'off',
  thinkingBudgetTokens: NOT_SENT,
  effort: NOT_SENT,
  toolChoice,
  toolChoiceName: toolChoice === 'named' ? 'grade' : NOT_SENT,
  strictTools: toolChoice === 'named' ? true : NOT_SENT,
  parallelToolUse: NOT_SENT,
  temperature: NOT_SENT,
  topP: NOT_SENT,
  topK: NOT_SENT,
  frequencyPenalty: NOT_SENT,
  presencePenalty: NOT_SENT,
  samplingSeed: NOT_SENT,
  maxOutputTokens,
  stopSequences: NOT_SENT,
  responseFormat: toolChoice === 'named' ? { kind: 'tool', name: 'grade' } : { kind: 'text' },
  contextPolicy: 'none',
  stream: false,
  timeoutMs: 60000,
  extras: {},
});
// The system is called one request at a time; the judge through the batch route, so the route says which path it took.
const systemShape = shape('https://api.example.com/v1/messages', 'none', 512);
const judgeShape = shape('https://api.example.com/v1/messages/batches', 'named', 256);
const SERVING = ['example.service_tier', 'example.speed'];

type Read = {
  name: string;
  labels: Record<string, string>;
  /** The batch of each draw: one batch for both draws of a case, or one batch per draw. */
  batchOf: (drawIndex: number) => string;
  batches: RunConditions['judge'] & object;
  sentAt: string;
  speed: string;
  cacheRead: number;
};

const judgeRequest = (id: string) => ({ model: 'example-judge', max_tokens: 256, tool_choice: { type: 'tool', name: 'grade' }, messages: [{ role: 'user', content: `Grade the reply to "${id}".` }] });
const systemRequest = (id: string) => ({ model: 'example-model-a', max_tokens: 512, messages: [{ role: 'user', content: (cases.find((c) => c.id === id) as Case).input }] });

function runOf(r: Read): RunArtifact {
  const draws: Draw[] = cases.flatMap((c) => [0, 1].map((d) => {
    const reply = replyOf(c.id);
    const system: CallRecord = {
      role: 'system',
      requestHash: hashOf(systemRequest(c.id)),
      sentAt: r.sentAt,
      servedModel: 'example-model-a-2026-01-15',
      receivedAt: r.sentAt.replace(':00Z', ':02Z'),
      usage: { inputTokensTotal: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 },
      serving: {},
    };
    const judge: CallRecord = {
      role: 'judge',
      requestHash: hashOf(judgeRequest(c.id)),
      submission: r.batchOf(d),
      sentAt: (r.batches.submissions.find((s) => s.id === r.batchOf(d)) as { submittedAt: string }).submittedAt,
      servedModel: 'example-judge-2026-02-01',
      receivedAt: 'UNKNOWN',
      usage: { inputTokensTotal: 900, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheRead === 0 ? 800 : 0, outputTokens: 12 },
      serving: { 'example.service_tier': 'standard', 'example.speed': r.speed },
    };
    const label = d === 1 && r.labels[c.id] !== undefined ? (r.labels[c.id] as string) : '4';
    return {
      caseId: c.id,
      drawIndex: d,
      attempts: [{ kind: 'graded' as const, label, outputHash: outputHashOf(reply), systemStop: 'end' as const, judgeStop: 'tool-use' as const, packetHash: packetHashOf({ message: (c.input as { message: string }).message }, reply), calls: [system, judge] }],
    };
  }));
  return {
    schema: RUN_SCHEMA,
    identity: {
      caseSetHash: caseSetHash(cases),
      rubricHash: hashOf({ rubric: 'refund-bot reply quality', version: 1 }),
      barHash: barHash(bar),
      systemModelRequested: 'example-model-a',
      systemModelServed: 'example-model-a-2026-01-15',
      systemCallShapeHash: callShapeHash(systemShape),
      systemPromptHash: sha256Hex('You are the refund assistant for an online store.'),
      systemToolsHash: hashOf([]),
      systemHarnessVersion: 'refund-harness 1.5.0',
      judgeDefinitionHash: hashOf({ prompt: 'Grade the reply from 1 to 5.', tools: ['grade'] }),
      judgeModelRequested: 'example-judge',
      judgeModelServed: 'example-judge-2026-02-01',
      judgeCallShapeHash: callShapeHash(judgeShape),
      judgeHarnessVersion: 'refund-harness 1.5.0',
      seed: 'NO_SEED',
      drawsPerCase: 2,
    },
    callShapes: { system: systemShape, judge: judgeShape },
    cases,
    draws,
    packetBasis: 'recorded',
    conditions: { system: { concurrency: 4, servingKeys: [], submissions: [] }, judge: r.batches },
  };
}

// January: both draws of a case went in one batch. The response carried no speed label yet, and nothing was cached.
const january = runOf({
  name: 'january',
  labels: {},
  batchOf: () => 'batch-jan',
  batches: { concurrency: 'UNKNOWN', servingKeys: SERVING, submissions: [{ id: 'batch-jan', kind: 'provider-batch', size: 8, sharedWith: [], submittedAt: '2026-01-15T09:00:00Z', endedAt: '2026-01-15T09:41:00Z', recordedAt: '2026-01-15T09:45:00Z' }] },
  sentAt: '2026-01-15T08:50:00Z',
  speed: NOT_RETURNED,
  cacheRead: 0,
});
// February: the two draws of a case went in two batches, an hour apart. Each response carried a speed label, and most
// of each judge prompt was read from the cache. One second draw got a different label.
const february = runOf({
  name: 'february',
  labels: { q03: '3' },
  batchOf: (d) => (d === 0 ? 'batch-feb-1' : 'batch-feb-2'),
  batches: {
    concurrency: 'UNKNOWN',
    servingKeys: SERVING,
    submissions: [
      { id: 'batch-feb-1', kind: 'provider-batch', size: 4, sharedWith: [], submittedAt: '2026-02-12T09:00:00Z', endedAt: '2026-02-12T09:20:00Z', recordedAt: '2026-02-12T09:22:00Z' },
      { id: 'batch-feb-2', kind: 'provider-batch', size: 4, sharedWith: [], submittedAt: '2026-02-12T10:00:00Z', endedAt: '2026-02-12T10:18:00Z', recordedAt: '2026-02-12T10:21:00Z' },
    ],
  },
  sentAt: '2026-02-12T08:50:00Z',
  speed: 'standard',
  cacheRead: 800,
});

write('bar.json', bar);
write('january.json', parseRunArtifact(january));
write('february.json', parseRunArtifact(february));
