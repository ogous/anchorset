import { caseSetHash, MAX_RUN_SLOTS, parseRunArtifact, RUN_SCHEMA, runArtifactProblems } from './artifact.ts';
import type { PacketBasis, RunArtifact } from './artifact.ts';
import { CALL_SHAPE_FIELDS, CALL_SHAPE_SCHEMA, callShapeHash, containsGap, NOT_SENT, validateCallShape } from './callshape.ts';
import type { CallShape } from './callshape.ts';
import { InputError } from './errors.ts';
import type { InputErrorCode } from './errors.ts';
import { barHash, parseBarFile } from './gate.ts';
import type { BarFile } from './gate.ts';
import { canonicalJson, findIllFormed, findNulls, GAP, hashOf, IDENTITY_FIELDS, isSha256Hex, keySegment, MAX_DRAWS_PER_CASE, NO_JUDGE, NO_SEED, outputHashOf, parseJsonBytes, parseJsonText, readsAsGap, sha256Hex, utf8Text } from './identity.ts';
import type { Gap, IdentityField, NoSeed } from './identity.ts';
import { FAIL_REASONS, finalAttempt, JUDGE_UNMEASURED_REASONS, STOPS, TRANSPORT_REASONS, unknownStops } from './scoring.ts';
import type { Attempt, Case, Draw } from './scoring.ts';
import { RUN_INPUT_SCHEMA } from './version.ts';

/*
 * The run-input format (`anchorset.run-input/v1`) and the one writer from it to the run artifact. A manifest states what
 * the user knows about the run (the bar, the case count, the models, the prompts, the settings, the packets); a file of
 * JSON lines holds one row per attempt. Nothing the manifest leaves out is defaulted: an identity field it does not
 * state is "UNKNOWN", a stop a row does not state is "UNKNOWN", and the comparisons that depend on them refuse. The
 * fields the run derives (the case-set, bar and call-shape hashes) are never stated. The rules of an attempt list are the
 * artifact's, reached through parseRunArtifact on the exact value that is returned; this reader checks only what the
 * artifact cannot express (the row structure, the source of each case field, and that `draw` and `attempt` are used
 * consistently) and names the line of each problem. Pure: the caller reads the files and hands in their bytes.
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const q = (s: string): string => JSON.stringify(s);

/** Problems collected with the code each one is of; thrown as one InputError whose code is theirs when they share one. */
type Problems = { add: (text: string, code?: InputErrorCode) => void; size: () => number; throwIfAny: () => void };
function problems(): Problems {
  const list: { text: string; code: InputErrorCode }[] = [];
  return {
    add: (text, code = 'INVALID_ARGUMENT') => void list.push({ text, code }),
    size: () => list.length,
    throwIfAny: () => {
      if (list.length === 0) return;
      const first = (list[0] as { code: InputErrorCode }).code;
      throw new InputError(list.every((p) => p.code === first) ? first : 'INVALID_ARGUMENT', list.map((p) => p.text));
    },
  };
}

/** A value hashed into an identity field: a file's bytes, a list of files, a JSON value, a hash already made, or unknown. */
export type HashedValue = { file: string } | { files: string[] } | { json: unknown } | { sha256: string } | Gap;
/**
 * A call shape: unknown (every key "UNKNOWN"); stated whole, inline or in a file; or stated as the keys sent with one
 * statement that no other key was sent.
 */
export type SettingsValue = { kind: 'unknown' } | { kind: 'inline'; shape: Obj } | { kind: 'file'; file: string } | { kind: 'sent'; sent: Obj };
type Side = { modelRequested: string; modelServed: string; harnessVersion: string; settings: SettingsValue };
export type JudgeStopWord = 'end' | 'tool-use';
export type PacketsValue = { basis: 'recorded' } | { basis: 'declared'; source: string };

/** A manifest that has passed parseRunInputManifest. Every key it did not state is here as "UNKNOWN" or absent. */
export type RunInputManifest = {
  schema: typeof RUN_INPUT_SCHEMA;
  origin: 'produced';
  graded: 'by-judge' | 'by-code';
  bar: string;
  caseCount: number;
  drawsPerCase?: number;
  cases?: string;
  sameForEveryCase?: { class: string };
  expectByClass?: Record<string, string>;
  rubric: HashedValue;
  seed: number | NoSeed | Gap;
  system: Side & { prompt: HashedValue; tools: HashedValue };
  /** Absent exactly when graded by code. */
  judge?: Side & { definition: HashedValue; gradedReplyStop?: JudgeStopWord };
  packets?: PacketsValue;
};

const MANIFEST_KEYS = ['schema', 'origin', 'graded', 'bar', 'caseCount', 'drawsPerCase', 'cases', 'sameForEveryCase', 'expectByClass', 'rubric', 'seed', 'system', 'judge', 'packets'] as const;
const SYSTEM_KEYS = ['modelRequested', 'modelServed', 'prompt', 'tools', 'harnessVersion', 'settings'] as const;
const JUDGE_KEYS = ['modelRequested', 'modelServed', 'definition', 'harnessVersion', 'settings', 'gradedReplyStop'] as const;
const DERIVED = ['caseSetHash', 'barHash', 'systemCallShapeHash', 'judgeCallShapeHash'] as const;
/** Where a key that is not the manifest's is stated, when the user wrote an identity field or a run-file key by its own name. */
const STATED_AS: Readonly<Record<string, string>> = {
  rubricHash: 'rubric',
  systemModelRequested: 'system.modelRequested',
  systemModelServed: 'system.modelServed',
  systemPromptHash: 'system.prompt',
  systemToolsHash: 'system.tools',
  systemHarnessVersion: 'system.harnessVersion',
  judgeDefinitionHash: 'judge.definition',
  judgeModelRequested: 'judge.modelRequested',
  judgeModelServed: 'judge.modelServed',
  judgeHarnessVersion: 'judge.harnessVersion',
  identity: 'rubric, seed, system and judge',
  callShapes: 'system.settings and judge.settings',
  draws: 'the grades file (--grades)',
  grades: 'the --grades flag, not the manifest',
};
const JUDGE_STOP_WORDS: readonly JudgeStopWord[] = ['end', 'tool-use'];

function closedKeys(o: Obj, allowed: readonly string[], at: string, p: Problems): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if ((DERIVED as readonly string[]).includes(k)) p.add(`${at}.${keySegment(k)}: the run derives this from what it holds; state the things it comes from, not the hash`);
    else if (Object.hasOwn(STATED_AS, k)) p.add(`${at}.${keySegment(k)}: unknown key; state it as ${STATED_AS[k]}`);
    else p.add(`${at}.${keySegment(k)}: unknown key (the manifest is closed; allowed here: ${allowed.join(', ')})`);
  }
}

function pathOf(v: unknown, at: string, p: Problems): string {
  if (typeof v === 'string' && v !== '') return v;
  p.add(`${at}: must be a path, a non-empty string`);
  return '';
}

function identityText(v: unknown, at: string, p: Problems): string {
  if (v === undefined || v === GAP) return GAP;
  if (typeof v !== 'string' || v === '') p.add(`${at}: must be a non-empty string, or "${GAP}"`);
  else if (v === NO_JUDGE || v === NO_SEED) p.add(`${at}: "${v}" is a marker the run reserves; write the value, or "${GAP}"`);
  else if (readsAsGap(v)) p.add(`${at}: ${q(v)} reads as a gap; write the value, or "${GAP}" for one you do not know`);
  else return v;
  return GAP;
}

function hashedOf(v: unknown, at: string, p: Problems): HashedValue {
  if (v === undefined || v === GAP) return GAP;
  const forms = '{ "file": <path> }, { "files": [<path>, ...] }, { "json": <value> }, { "sha256": <hash> } or "UNKNOWN"';
  if (!isObj(v) || Object.keys(v).length !== 1) {
    p.add(`${at}: must be one of ${forms}`);
    return GAP;
  }
  if ('file' in v) return { file: pathOf(v['file'], `${at}.file`, p) };
  if ('files' in v) {
    const list = v['files'];
    if (!Array.isArray(list) || list.length === 0) {
      p.add(`${at}.files: must be a non-empty list of paths`);
      return GAP;
    }
    const paths = list.map((x, i) => pathOf(x, `${at}.files[${i}]`, p));
    const twice = paths.filter((x, i) => x !== '' && paths.indexOf(x) !== i);
    if (twice.length > 0) p.add(`${at}.files: names ${[...new Set(twice)].map(q).join(', ')} twice; name each file once`);
    return { files: paths };
  }
  if ('json' in v) {
    const j = v['json'];
    if (containsGap(j)) p.add(`${at}.json: holds "${GAP}"; for a value you do not know, write "${GAP}" itself in place of the {json} object`);
    else if (typeof j === 'string' && readsAsGap(j)) p.add(`${at}.json: ${q(j)} reads as a gap; write the value, or "${GAP}" in place of the {json} object for one you do not know`);
    return { json: j };
  }
  if ('sha256' in v) {
    if (!isSha256Hex(v['sha256'])) p.add(`${at}.sha256: must be a full 64-character lowercase sha256`);
    return { sha256: String(v['sha256']) };
  }
  p.add(`${at}: must be one of ${forms}`);
  return GAP;
}

function settingsOf(v: unknown, at: string, p: Problems): SettingsValue {
  if (v === undefined || v === GAP) return { kind: 'unknown' };
  if (!isObj(v)) {
    p.add(`${at}: must be a whole ${CALL_SHAPE_SCHEMA} object, { "file": <path> }, { "sent": {...}, "everyOtherKey": "${NOT_SENT}" } or "${GAP}"`);
    return { kind: 'unknown' };
  }
  if ('sent' in v || 'everyOtherKey' in v) {
    closedKeys(v, ['sent', 'everyOtherKey'], at, p);
    if (v['everyOtherKey'] !== NOT_SENT) p.add(`${at}.everyOtherKey: must be "${NOT_SENT}": the statement that the harness sent no setting it does not list in "sent"`);
    const sent = v['sent'];
    if (!isObj(sent)) {
      p.add(`${at}.sent: must be an object of the call-shape keys the harness sent, with their values`);
      return { kind: 'unknown' };
    }
    for (const [k, x] of Object.entries(sent)) {
      const kAt = `${at}.sent.${keySegment(k)}`;
      if (!CALL_SHAPE_FIELDS.includes(k)) p.add(`${kAt}: not a key of a call shape (the keys are ${CALL_SHAPE_FIELDS.join(', ')})`);
      else if (x === NOT_SENT || x === GAP) p.add(`${kAt}: "sent" lists what was sent, with its value; a key not sent is left out of it, and a statement with a key not known is not this one (write the whole call shape)`);
      else if (containsGap(x)) p.add(`${kAt}: holds "${GAP}"; "sent" lists known values only (write the whole call shape to state a value not known)`);
    }
    return { kind: 'sent', sent };
  }
  if (Object.keys(v).length === 1 && 'file' in v) return { kind: 'file', file: pathOf(v['file'], `${at}.file`, p) };
  return { kind: 'inline', shape: v };
}

function seedOf(v: unknown, at: string, p: Problems): number | NoSeed | Gap {
  if (v === undefined || v === GAP) return GAP;
  if (v === NO_SEED) return NO_SEED;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  p.add(`${at}: must be a whole number from 0 to 4294967295, "${NO_SEED}" for a harness that made no random choice, or "${GAP}"`);
  return GAP;
}

function countOf(v: unknown, at: string, max: number, p: Problems): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max) return v;
  p.add(`${at}: must be a whole number from 1 to ${max}`);
  return 0;
}

/** A manifest, checked whole: every problem is listed, and none is defaulted away. Throws InputError. */
export function parseRunInputManifest(json: unknown): RunInputManifest {
  const p = problems();
  if (!isObj(json)) throw new InputError('INVALID_ARGUMENT', ['manifest: must be one JSON object']);
  const nulls: string[] = [];
  findNulls(json, 'manifest', nulls);
  for (const n of nulls) p.add(`${n} (leave the key out, or write "${GAP}")`);
  const illFormed: string[] = [];
  findIllFormed(json, 'manifest', illFormed);
  for (const n of illFormed) p.add(n);
  closedKeys(json, MANIFEST_KEYS, 'manifest', p);
  if (json['schema'] !== RUN_INPUT_SCHEMA) p.add(`manifest.schema: must be "${RUN_INPUT_SCHEMA}"`);
  if (json['origin'] !== 'produced') {
    p.add(`manifest.origin: ${json['origin'] === undefined ? 'is required' : `is ${JSON.stringify(json['origin'])}`}; it must be "produced": write-run reads only rows that your own eval code wrote. A result file of another tool goes through that tool's importer, where one exists (docs/IMPORTERS.md)`);
  }
  const graded = json['graded'];
  if (graded !== 'by-judge' && graded !== 'by-code') p.add(`manifest.graded: ${graded === undefined ? 'is required' : `is ${JSON.stringify(graded)}`}; it is "by-judge" or "by-code"`);
  const byJudge = graded === 'by-judge';
  const bar = 'bar' in json ? pathOf(json['bar'], 'manifest.bar', p) : (p.add('manifest.bar: is required: the path of the bar file'), '');
  const caseCount = 'caseCount' in json ? countOf(json['caseCount'], 'manifest.caseCount', MAX_RUN_SLOTS, p) : (p.add('manifest.caseCount: is required: how many cases the run holds (the rows alone cannot show a case that was never run)'), 0);
  const drawsPerCase = 'drawsPerCase' in json ? countOf(json['drawsPerCase'], 'manifest.drawsPerCase', MAX_DRAWS_PER_CASE, p) : undefined;
  const cases = 'cases' in json ? pathOf(json['cases'], 'manifest.cases', p) : undefined;
  let sameForEveryCase: { class: string } | undefined;
  if ('sameForEveryCase' in json) {
    const s = json['sameForEveryCase'];
    if (!isObj(s)) p.add('manifest.sameForEveryCase: must be { "class": <class of the bar> }');
    else {
      closedKeys(s, ['class'], 'manifest.sameForEveryCase', p);
      const k = s['class'];
      if (typeof k !== 'string' || k === '') p.add('manifest.sameForEveryCase.class: must be a class of the bar, a non-empty string');
      else sameForEveryCase = { class: k };
    }
  }
  let expectByClass: Record<string, string> | undefined;
  if ('expectByClass' in json) {
    const e = json['expectByClass'];
    if (!isObj(e) || Object.keys(e).length === 0) p.add('manifest.expectByClass: must be an object of class -> expected label, naming every class that holds a case');
    else {
      for (const [k, v] of Object.entries(e)) if (typeof v !== 'string' || v === '') p.add(`manifest.expectByClass.${keySegment(k)}: must be a label of the bar, a non-empty string`);
      expectByClass = e as Record<string, string>;
    }
  }
  const rubric = hashedOf(json['rubric'], 'manifest.rubric', p);
  const seed = seedOf(json['seed'], 'manifest.seed', p);

  const sys = json['system'] ?? {};
  let system: RunInputManifest['system'] = { modelRequested: GAP, modelServed: GAP, harnessVersion: GAP, settings: { kind: 'unknown' }, prompt: GAP, tools: GAP };
  if (!isObj(sys)) p.add('manifest.system: must be an object');
  else {
    closedKeys(sys, SYSTEM_KEYS, 'manifest.system', p);
    system = {
      modelRequested: identityText(sys['modelRequested'], 'manifest.system.modelRequested', p),
      modelServed: identityText(sys['modelServed'], 'manifest.system.modelServed', p),
      harnessVersion: identityText(sys['harnessVersion'], 'manifest.system.harnessVersion', p),
      settings: settingsOf(sys['settings'], 'manifest.system.settings', p),
      prompt: hashedOf(sys['prompt'], 'manifest.system.prompt', p),
      tools: hashedOf(sys['tools'], 'manifest.system.tools', p),
    };
  }
  let judge: RunInputManifest['judge'];
  if ('judge' in json && !byJudge) p.add('manifest.judge: a run graded by code has no judge; leave the block out');
  if (byJudge) {
    const j = json['judge'] ?? {};
    if (!isObj(j)) p.add('manifest.judge: must be an object');
    else {
      closedKeys(j, JUDGE_KEYS, 'manifest.judge', p);
      const stop = j['gradedReplyStop'];
      if (stop !== undefined && !(JUDGE_STOP_WORDS as readonly unknown[]).includes(stop)) p.add(`manifest.judge.gradedReplyStop: must be "end" or "tool-use": the stop of the judge's reply on every graded row`);
      judge = {
        modelRequested: identityText(j['modelRequested'], 'manifest.judge.modelRequested', p),
        modelServed: identityText(j['modelServed'], 'manifest.judge.modelServed', p),
        harnessVersion: identityText(j['harnessVersion'], 'manifest.judge.harnessVersion', p),
        settings: settingsOf(j['settings'], 'manifest.judge.settings', p),
        definition: hashedOf(j['definition'], 'manifest.judge.definition', p),
        ...(stop === 'end' || stop === 'tool-use' ? { gradedReplyStop: stop } : {}),
      };
    }
  }
  let packets: PacketsValue | undefined;
  if ('packets' in json) {
    const k = json['packets'];
    if (!byJudge) p.add('manifest.packets: a run graded by code shows no judge a packet; leave the block out');
    else if (!isObj(k)) p.add('manifest.packets: must be { "basis": "recorded" } or { "basis": "declared", "source": <text> }');
    else {
      closedKeys(k, k['basis'] === 'declared' ? ['basis', 'source'] : ['basis'], 'manifest.packets', p);
      if (k['basis'] === 'recorded') packets = { basis: 'recorded' };
      else if (k['basis'] === 'declared') {
        const source = k['source'];
        if (typeof source !== 'string' || source === '') p.add('manifest.packets.source: required with "declared": name the description the packet hashes were made from');
        else packets = { basis: 'declared', source };
      } else p.add('manifest.packets.basis: must be "recorded" (your code hashed each packet as it showed it) or "declared" (the hashes were made later from a description)');
    }
  }
  p.throwIfAny();
  return {
    schema: RUN_INPUT_SCHEMA,
    origin: 'produced',
    graded: graded as RunInputManifest['graded'],
    bar,
    caseCount,
    ...(drawsPerCase === undefined ? {} : { drawsPerCase }),
    ...(cases === undefined ? {} : { cases }),
    ...(sameForEveryCase === undefined ? {} : { sameForEveryCase }),
    ...(expectByClass === undefined ? {} : { expectByClass }),
    rubric,
    seed,
    system,
    ...(judge === undefined ? {} : { judge }),
    ...(packets === undefined ? {} : { packets }),
  };
}

const hashedPaths = (h: HashedValue): string[] => (h === GAP ? [] : 'file' in h ? [h.file] : 'files' in h ? h.files : []);
const settingsPaths = (s: SettingsValue): string[] => (s.kind === 'file' ? [s.file] : []);

/** Every path the manifest names, each once, in the order: bar, cases, rubric, the system's, the judge's. */
export function runInputPaths(m: RunInputManifest): string[] {
  const all = [
    m.bar,
    ...(m.cases === undefined ? [] : [m.cases]),
    ...hashedPaths(m.rubric),
    ...hashedPaths(m.system.prompt),
    ...hashedPaths(m.system.tools),
    ...settingsPaths(m.system.settings),
    ...(m.judge === undefined ? [] : [...hashedPaths(m.judge.definition), ...settingsPaths(m.judge.settings)]),
  ];
  return [...new Set(all)];
}

/** One line of a JSON-lines file, read as an object. */
type Line = { line: number; value: Obj };

/** A JSON-lines file: UTF-8 with no byte-order mark, one JSON object per line, a final newline allowed, no blank line. */
function jsonLines(bytes: Uint8Array, name: string, p: Problems): Line[] {
  const t = utf8Text(bytes);
  if ('problem' in t) {
    p.add(`${name}: ${t.problem}`);
    return [];
  }
  const pieces = t.text.split('\n');
  if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();
  if (pieces.length === 0) {
    p.add(`${name}: holds no line; it holds one JSON object per line`);
    return [];
  }
  const out: Line[] = [];
  pieces.forEach((piece, i) => {
    const at = `${name} line ${i + 1}`;
    if (piece.trim() === '') return p.add(`${at}: a blank line; the file holds one JSON object per line, and no blank line`);
    const parsed = parseJsonText(piece);
    if ('problem' in parsed) return p.add(`${at}: ${parsed.problem}`);
    if (!isObj(parsed.json)) return p.add(`${at}: must be one JSON object`);
    const ill: string[] = [];
    findIllFormed(parsed.json, at, ill);
    for (const x of ill) p.add(x);
    out.push({ line: i + 1, value: parsed.json });
  });
  return out;
}

const CASE_FIELD_KEYS = ['class', 'expect', 'input'] as const;
type CaseField = (typeof CASE_FIELD_KEYS)[number];
const SLOT_KEYS = ['case', 'draw', 'attempt'] as const;
const ROW_KEYS = [...SLOT_KEYS, 'grade', 'failed', 'unmeasured', 'role', 'detail', 'answer', 'answerHash', 'stop', 'judgeStop', 'packetHash', ...CASE_FIELD_KEYS] as const;

/** A row read: where it goes, the attempt it records, and the case fields it carries. */
export type GradeRow = { line: number; caseId: string; draw?: number; attempt?: number; record: Attempt; fields: Partial<Record<CaseField, unknown>> };

type RowContext = { byJudge: boolean; packets: PacketsValue | undefined; gradedReplyStop: JudgeStopWord | undefined };

/** A stop word, or "UNKNOWN" when the row leaves it out; on a failed row it is required and may be "NOT_SENT". Moved from the example writer. */
function stopOf(v: unknown, at: string, failedRow: boolean, p: Problems, name = 'stop'): string {
  if (v === undefined) {
    if (failedRow) p.add(`${at}: ${name} is required on a failed row (the stop that goes with the reason, or "${NOT_SENT}"): a failed attempt's stop is never guessed`);
    return GAP;
  }
  if (typeof v === 'string' && ((STOPS as readonly string[]).includes(v) || v === GAP || (failedRow && v === NOT_SENT))) return v;
  p.add(`${at}: ${name} is ${JSON.stringify(v)}; it is one of ${STOPS.join(', ')}, ${GAP}${failedRow ? `, ${NOT_SENT}` : ''}`);
  return GAP;
}

function outputOf(r: Obj, at: string, p: Problems): string {
  const hasText = 'answer' in r;
  const hasHash = 'answerHash' in r;
  if (hasText === hasHash) {
    p.add(`${at}: give exactly one of answer (the text) and answerHash (the sha256 of its UTF-8 bytes)${hasText ? '; this row gives both' : ''}`);
    return GAP;
  }
  if (hasText) {
    if (typeof r['answer'] !== 'string') p.add(`${at}: answer must be the answer's text, a string`);
    else return outputHashOf(r['answer']);
    return GAP;
  }
  if (!isSha256Hex(r['answerHash'])) p.add(`${at}: answerHash must be a full 64-character lowercase sha256 of the answer's UTF-8 bytes`);
  return String(r['answerHash']);
}

function packetOf(r: Obj, at: string, ctx: RowContext, p: Problems): string {
  if (!ctx.byJudge) {
    if ('packetHash' in r) p.add(`${at}: packetHash is not allowed in a run graded by code`);
    return NO_JUDGE;
  }
  if (ctx.packets === undefined) {
    if ('packetHash' in r) p.add(`${at}: packetHash is given, but the manifest states no packets.basis; state how the hashes were made ("recorded" or "declared")`);
    return GAP;
  }
  if (!('packetHash' in r)) {
    p.add(`${at}: packetHash is required: the manifest states packets.basis "${ctx.packets.basis}", so every judge row carries the sha256 of what the judge was shown`);
    return GAP;
  }
  if (!isSha256Hex(r['packetHash'])) p.add(`${at}: packetHash must be a full 64-character lowercase sha256`);
  return String(r['packetHash']);
}

function detailOf(r: Obj, at: string, p: Problems): string {
  if (typeof r['detail'] === 'string') return r['detail'];
  p.add(`${at}: detail is required on this row, a string (it may be empty)`);
  return '';
}

/** The attempt one row records. Moved from the example writer's attemptOf, with every problem collected. */
function attemptOf(r: Obj, at: string, ctx: RowContext, p: Problems): Attempt | undefined {
  const kinds = (['grade', 'failed', 'unmeasured'] as const).filter((k) => k in r);
  if (kinds.length !== 1) {
    p.add(`${at}: a row holds exactly one of grade, failed and unmeasured; this one holds ${kinds.length === 0 ? 'none' : kinds.join(' and ')}`);
    return undefined;
  }
  const kind = kinds[0] as 'grade' | 'failed' | 'unmeasured';
  const allowedOn = (extra: readonly string[], what: string): void => {
    for (const k of Object.keys(r)) {
      if (!(ROW_KEYS as readonly string[]).includes(k)) p.add(`${at}: unknown key ${q(k)} (a row's keys are ${ROW_KEYS.join(', ')})`);
      else if (![...SLOT_KEYS, ...CASE_FIELD_KEYS, ...extra].includes(k)) p.add(`${at}: ${k} is not allowed on ${what}`);
    }
  };
  if (kind === 'grade') {
    allowedOn(['grade', 'answer', 'answerHash', 'stop', 'judgeStop', 'packetHash'], 'a grade row');
    const g = r['grade'];
    let label = '';
    if (typeof g === 'number') p.add(`${at}: grade is the number ${g}; a grade is a label of the bar, written as a string ("${g}")`);
    else if (typeof g !== 'string' || g === '') p.add(`${at}: grade must be a label of the bar, a non-empty string`);
    else label = g;
    const outputHash = outputOf(r, at, p);
    const systemStop = stopOf(r['stop'], at, false, p);
    let judgeStop: string = NO_JUDGE;
    if (!ctx.byJudge) {
      if ('judgeStop' in r) p.add(`${at}: judgeStop is not allowed in a run graded by code`);
    } else if (ctx.gradedReplyStop !== undefined) {
      if ('judgeStop' in r) p.add(`${at}: judgeStop is given in the row and by judge.gradedReplyStop in the manifest; give it in one place`);
      judgeStop = ctx.gradedReplyStop;
    } else if (!('judgeStop' in r)) {
      p.add(`${at}: judgeStop is required on a grade row of a run graded by a judge ("end" or "tool-use"), or state it once as judge.gradedReplyStop in the manifest`);
    } else {
      judgeStop = stopOf(r['judgeStop'], at, false, p, 'judgeStop');
      if (judgeStop === GAP) p.add(`${at}: judgeStop must be a stop word: a graded attempt's judge stop is never "${GAP}"`);
    }
    return { kind: 'graded', label, outputHash, systemStop: systemStop as never, judgeStop: judgeStop as never, packetHash: packetOf(r, at, ctx, p) };
  }
  if (kind === 'failed') {
    const reason = r['failed'];
    // A truncated answer has text, so its output hash is the answer's (the run format's definition); the other failures
    // have no answer, and their output hash is the hash of the failure note.
    const truncated = reason === 'truncated';
    allowedOn(truncated ? ['failed', 'detail', 'stop', 'answer', 'answerHash'] : ['failed', 'detail', 'stop'], truncated ? 'a truncated row' : 'a failed row without an answer');
    if (typeof reason !== 'string' || !(FAIL_REASONS as readonly string[]).includes(reason)) p.add(`${at}: failed is ${JSON.stringify(reason)}; it is one of ${FAIL_REASONS.join(', ')}`);
    const detail = detailOf(r, at, p);
    const systemStop = stopOf(r['stop'], at, true, p);
    const outputHash = truncated ? outputOf(r, at, p) : outputHashOf({ failed: String(reason), detail });
    return { kind: 'failed', reason: String(reason) as never, detail, outputHash, systemStop: systemStop as never };
  }
  const reason = r['unmeasured'];
  const role = r['role'];
  if (role === 'system') {
    allowedOn(['unmeasured', 'role', 'detail'], 'a row unmeasured by the system');
    if (typeof reason !== 'string' || !(TRANSPORT_REASONS as readonly string[]).includes(reason)) p.add(`${at}: unmeasured is ${JSON.stringify(reason)}; for the system it is one of ${TRANSPORT_REASONS.join(', ')}`);
    return { kind: 'unmeasured', role: 'system', reason: String(reason) as never, detail: detailOf(r, at, p) };
  }
  if (role === 'judge') {
    if (!ctx.byJudge) {
      p.add(`${at}: a run graded by code has no judge attempt (role "judge")`);
      return undefined;
    }
    allowedOn(['unmeasured', 'role', 'detail', 'answer', 'answerHash', 'stop', 'packetHash'], 'a row unmeasured by the judge');
    if (typeof reason !== 'string' || !(JUDGE_UNMEASURED_REASONS as readonly string[]).includes(reason)) p.add(`${at}: unmeasured is ${JSON.stringify(reason)}; for the judge it is one of ${JUDGE_UNMEASURED_REASONS.join(', ')}`);
    return { kind: 'unmeasured', role: 'judge', reason: String(reason) as never, detail: detailOf(r, at, p), outputHash: outputOf(r, at, p), systemStop: stopOf(r['stop'], at, false, p) as never, packetHash: packetOf(r, at, ctx, p) };
  }
  p.add(`${at}: role is required with unmeasured: "system" (the system gave no response) or "judge" (the judge gave no grade)`);
  return undefined;
}

const indexOf = (v: unknown, at: string, key: string, p: Problems): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  p.add(`${at}: ${key} must be a whole number from 0`);
  return undefined;
};

/** The rows of a grades file: every problem of every line is listed. `name` names the file in each problem. */
export function parseGradeRows(bytes: Uint8Array, manifest: RunInputManifest, name = 'grades'): GradeRow[] {
  const p = problems();
  const rows = readRows(bytes, manifest, name, p);
  p.throwIfAny();
  return rows;
}

function readRows(bytes: Uint8Array, m: RunInputManifest, name: string, p: Problems): GradeRow[] {
  const ctx: RowContext = { byJudge: m.graded === 'by-judge', packets: m.packets, gradedReplyStop: m.judge?.gradedReplyStop };
  const out: GradeRow[] = [];
  for (const { line, value: r } of jsonLines(bytes, name, p)) {
    const at = `${name} line ${line}`;
    for (const [k, v] of Object.entries(r)) if (v === null) p.add(`${at}: ${keySegment(k)} is null; null is not allowed (leave the key out)`);
    const c = r['case'];
    if (typeof c !== 'string' || c === '') p.add(`${at}: case is required, the case id as a non-empty string`);
    const draw = indexOf(r['draw'], at, 'draw', p);
    const attempt = indexOf(r['attempt'], at, 'attempt', p);
    const fields: Partial<Record<CaseField, unknown>> = {};
    for (const f of CASE_FIELD_KEYS) {
      if (!(f in r) || r[f] === null) continue;
      if (f !== 'input' && (typeof r[f] !== 'string' || r[f] === '')) p.add(`${at}: ${f} must be a non-empty string`);
      fields[f] = r[f];
    }
    const record = attemptOf(r, at, ctx, p);
    if (record === undefined || typeof c !== 'string') continue;
    out.push({ line, caseId: c, ...(draw === undefined ? {} : { draw }), ...(attempt === undefined ? {} : { attempt }), record, fields });
  }
  return out;
}

/** A case of the case file. */
type CaseLine = { line: number; id: string; fields: Partial<Record<CaseField, unknown>> };

function readCaseFile(bytes: Uint8Array, name: string, p: Problems): CaseLine[] {
  const out: CaseLine[] = [];
  const seen = new Set<string>();
  for (const { line, value } of jsonLines(bytes, name, p)) {
    const at = `${name} line ${line}`;
    for (const k of Object.keys(value)) if (!['id', ...CASE_FIELD_KEYS].includes(k)) p.add(`${at}: unknown key ${q(k)} (a case's keys are id, class, expect, input)`);
    for (const [k, v] of Object.entries(value)) if (v === null) p.add(`${at}: ${keySegment(k)} is null; null is not allowed (leave the key out)`);
    const id = value['id'];
    if (typeof id !== 'string' || id === '') {
      p.add(`${at}: id is required, a non-empty string`);
      continue;
    }
    if (seen.has(id)) p.add(`${at}: case ${q(id)} is listed twice`);
    seen.add(id);
    const fields: Partial<Record<CaseField, unknown>> = {};
    for (const f of CASE_FIELD_KEYS) {
      if (!(f in value) || value[f] === null) continue;
      if (f !== 'input' && (typeof value[f] !== 'string' || value[f] === '')) p.add(`${at}: ${f} must be a non-empty string`);
      fields[f] = value[f];
    }
    out.push({ line, id, fields });
  }
  return out;
}

/** What the files named by the manifest hash to, by the form the manifest gave. */
function hashOfValue(h: HashedValue, role: string, files: ReadonlyMap<string, Uint8Array>, inputs: InputFile[], p: Problems): string {
  if (h === GAP) return GAP;
  if ('sha256' in h) return h.sha256;
  if ('json' in h) return hashOf(h.json);
  const one = (path: string): string => {
    const bytes = files.get(path);
    if (bytes === undefined) {
      p.add(`${path}: was not read (named by ${role})`);
      return GAP;
    }
    const sha256 = sha256Hex(bytes);
    inputs.push({ role, path, sha256 });
    return sha256;
  };
  if ('file' in h) return one(h.file);
  return hashOf(h.files.map(one));
}

/** The call shape a settings value states: unknown keys stay "UNKNOWN", and a declaration expands to every key it does not list as "NOT_SENT". */
function shapeOf(s: SettingsValue, at: string, role: string, files: ReadonlyMap<string, Uint8Array>, inputs: InputFile[], p: Problems): Obj {
  const unknown = (): Obj => ({ schema: CALL_SHAPE_SCHEMA, ...Object.fromEntries(CALL_SHAPE_FIELDS.map((k) => [k, GAP])) });
  let shape: unknown;
  if (s.kind === 'unknown') return unknown();
  if (s.kind === 'inline') shape = s.shape;
  else if (s.kind === 'sent') shape = { schema: CALL_SHAPE_SCHEMA, ...Object.fromEntries(CALL_SHAPE_FIELDS.map((k) => [k, k === 'extras' ? {} : NOT_SENT])), ...s.sent };
  else {
    const bytes = files.get(s.file);
    if (bytes === undefined) {
      p.add(`${s.file}: was not read (named by ${role})`);
      return unknown();
    }
    inputs.push({ role, path: s.file, sha256: sha256Hex(bytes) });
    const read = parseJsonBytes(bytes);
    if ('problem' in read) {
      p.add(`${s.file}: ${read.problem}`, 'INVALID_CALL_SHAPE');
      return unknown();
    }
    shape = read.json;
  }
  const bad = validateCallShape(shape, at);
  for (const x of bad) p.add(x, 'INVALID_CALL_SHAPE');
  return bad.length === 0 ? (shape as Obj) : unknown();
}

/** A file the manifest named: its role (the manifest key that named it), its path as the manifest gives it, and its sha256. */
export type InputFile = { role: string; path: string; sha256: string };

/** A statement the user made about their harness in place of a per-key or per-row value, as the report prints it. */
export type Declaration = { key: string; statement: string };

/** What a run holds, as the reports of write-run and validate print it. Facts only: none of them decides anything. */
export type RunFacts = {
  graded: 'by-judge' | 'by-code';
  cases: number;
  drawsPerCase: number | Gap;
  /** `declared`: cases times drawsPerCase; `missing`: the slots ("case#draw") with no record, listed only when the count is known. */
  slots: { declared: number | Gap; recorded: number; missing: string[] };
  unknownIdentityFields: IdentityField[];
  /** Slots where an attempt records its system stop as "UNKNOWN". */
  unknownStopSlots: string[];
  /** Slots whose final attempt holds no grade, with its role and reason. */
  noGrade: { slot: string; role: 'system' | 'judge'; reason: string }[];
  packetBasis: PacketBasis;
};

/** The facts of a parsed run. */
export function runFacts(run: RunArtifact): RunFacts {
  const n = run.identity.drawsPerCase;
  const present = new Set(run.draws.map((d) => `${d.caseId}#${d.drawIndex}`));
  const missing = n === GAP ? [] : run.cases.flatMap((c) => Array.from({ length: n }, (_, i) => `${c.id}#${i}`).filter((k) => !present.has(k)));
  const noGrade = run.draws.flatMap((d) => {
    const a = finalAttempt(d);
    return a.kind === 'unmeasured' ? [{ slot: `${d.caseId}#${d.drawIndex}`, role: a.role, reason: a.reason }] : [];
  }).sort((x, y) => (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0));
  return {
    graded: run.identity.judgeDefinitionHash === NO_JUDGE ? 'by-code' : 'by-judge',
    cases: run.cases.length,
    drawsPerCase: n,
    slots: { declared: n === GAP ? GAP : run.cases.length * n, recorded: run.draws.length, missing },
    unknownIdentityFields: IDENTITY_FIELDS.filter((f) => run.identity[f] === GAP),
    unknownStopSlots: unknownStops(run.draws),
    noGrade,
    packetBasis: run.packetBasis,
  };
}

/** The facts write-run reports beside the run's own. */
export type RunInputFacts = RunFacts & { origin: 'produced'; rows: number; inputs: InputFile[]; declarations: Declaration[] };

/** The names the problems give the two files the caller read itself. */
export type RunInputNames = { grades: string };

/**
 * The run a manifest and its rows describe, checked whole, or an InputError listing every problem with its place.
 * `files` holds the bytes of every path runInputPaths names, keyed by the path as the manifest gives it. The run is
 * returned as parseRunArtifact read it from its own JSON text: what the caller writes is what was checked.
 */
export function runFromInput(m: RunInputManifest, rowBytes: Uint8Array, files: ReadonlyMap<string, Uint8Array>, names: RunInputNames = { grades: 'grades' }): { run: RunArtifact; bar: BarFile; facts: RunInputFacts } {
  const p = problems();
  const byJudge = m.graded === 'by-judge';
  const inputs: InputFile[] = [];

  // The files: the bar, the case file, every hashed value and every settings file.
  let bar: BarFile | undefined;
  const barBytes = files.get(m.bar);
  if (barBytes === undefined) p.add(`${m.bar}: was not read (named by bar)`);
  else {
    inputs.push({ role: 'bar', path: m.bar, sha256: sha256Hex(barBytes) });
    const read = parseJsonBytes(barBytes);
    if ('problem' in read) p.add(`${m.bar}: ${read.problem}`, 'INVALID_BAR');
    else {
      try {
        bar = parseBarFile(read.json);
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        for (const x of e.problems) p.add(`${m.bar}: ${x}`, e.code);
      }
    }
  }
  let caseLines: CaseLine[] | undefined;
  if (m.cases !== undefined) {
    const bytes = files.get(m.cases);
    if (bytes === undefined) p.add(`${m.cases}: was not read (named by cases)`);
    else {
      inputs.push({ role: 'cases', path: m.cases, sha256: sha256Hex(bytes) });
      caseLines = readCaseFile(bytes, m.cases, p);
    }
  }
  const rubricHash = hashOfValue(m.rubric, 'rubric', files, inputs, p);
  const systemPromptHash = hashOfValue(m.system.prompt, 'system.prompt', files, inputs, p);
  const systemToolsHash = hashOfValue(m.system.tools, 'system.tools', files, inputs, p);
  const systemShape = shapeOf(m.system.settings, 'manifest.system.settings', 'system.settings', files, inputs, p);
  const judgeDefinitionHash = m.judge === undefined ? NO_JUDGE : hashOfValue(m.judge.definition, 'judge.definition', files, inputs, p);
  const judgeShape: Obj | typeof NO_JUDGE = m.judge === undefined ? NO_JUDGE : shapeOf(m.judge.settings, 'manifest.judge.settings', 'judge.settings', files, inputs, p);
  const rows = readRows(rowBytes, m, names.grades, p);
  p.throwIfAny();
  const theBar = bar as BarFile;

  // Across the rows: draw and attempt are used throughout or not at all, the slots and attempts are whole, and the cases match.
  const at = (r: GradeRow): string => `${names.grades} line ${r.line}`;
  const throughout = (has: (r: GradeRow) => boolean, key: string): boolean => {
    const some = rows.filter(has);
    if (some.length > 0 && some.length < rows.length) {
      const lacking = rows.filter((r) => !has(r)).map((r) => r.line);
      p.add(`${names.grades}: ${key} is given on some rows and not on others (not on line${lacking.length === 1 ? '' : 's'} ${listLines(lacking)}); give it on every row or on none`);
    }
    return some.length === rows.length;
  };
  const withDraw = throughout((r) => r.draw !== undefined, 'draw');
  const withAttempt = throughout((r) => r.attempt !== undefined, 'attempt');
  let drawsPerCase = 1;
  if (withDraw) {
    if (m.drawsPerCase === undefined) p.add(`manifest.drawsPerCase: is required when the rows carry "draw": the highest draw in the rows cannot show that a draw was never run`);
    else drawsPerCase = m.drawsPerCase;
  } else if (m.drawsPerCase !== undefined && rows.every((r) => r.draw === undefined)) {
    p.add('manifest.drawsPerCase: is given, but no row carries "draw"; with no draw column each case has one draw (leave drawsPerCase out), and with one, every row says which draw it is');
  }
  for (const r of rows) if (withDraw && r.draw !== undefined && r.draw >= drawsPerCase && m.drawsPerCase !== undefined) p.add(`${at(r)}: draw ${r.draw} is outside 0 to ${drawsPerCase - 1} (drawsPerCase ${drawsPerCase})`);

  const slots = new Map<string, { caseId: string; drawIndex: number; rows: GradeRow[] }>();
  for (const r of rows) {
    const d = r.draw ?? 0;
    const key = `${r.caseId}#${d}`;
    const s = slots.get(key) ?? { caseId: r.caseId, drawIndex: d, rows: [] };
    s.rows.push(r);
    slots.set(key, s);
  }
  for (const [key, s] of slots) {
    if (!withAttempt) {
      if (s.rows.length > 1) p.add(`${names.grades}: slot ${key} has ${s.rows.length} rows (lines ${listLines(s.rows.map((r) => r.line))}); with no attempt column each slot is one row, and a retry needs "attempt"`);
      continue;
    }
    const numbers = s.rows.map((r) => r.attempt as number);
    const twice = numbers.filter((x, i) => numbers.indexOf(x) !== i);
    if (twice.length > 0) p.add(`${names.grades}: slot ${key} gives attempt ${[...new Set(twice)].join(', ')} more than once (lines ${listLines(s.rows.map((r) => r.line))})`);
    else {
      const sorted = [...numbers].sort((x, y) => x - y);
      if (sorted.some((x, i) => x !== i)) p.add(`${names.grades}: slot ${key} has attempts ${sorted.join(', ')}; they are numbered 0, 1, 2, ... with no gap`);
    }
    s.rows.sort((x, y) => (x.attempt as number) - (y.attempt as number));
  }

  // The case set: the case file's, in its order, or the ids in the rows, sorted, so that the order of the rows does not
  // move a byte of the run.
  const rowIds = [...new Set(rows.map((r) => r.caseId))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const ids = caseLines === undefined ? rowIds : caseLines.map((c) => c.id);
  if (caseLines !== undefined) {
    const known = new Set(ids);
    for (const r of rows) if (!known.has(r.caseId)) p.add(`${at(r)}: case ${q(r.caseId)} is not in the case file ${m.cases as string} (an unmatched case)`, 'UNKNOWN_CASE');
  }
  if (ids.length !== m.caseCount) p.add(`manifest.caseCount: is ${m.caseCount}, but the ${caseLines === undefined ? 'rows name' : 'case file lists'} ${ids.length} case${ids.length === 1 ? '' : 's'}`);

  // Each case field from exactly one source.
  const rowsOf = new Map<string, GradeRow[]>();
  for (const r of rows) rowsOf.set(r.caseId, [...(rowsOf.get(r.caseId) ?? []), r]);
  const value = new Map<string, Partial<Record<CaseField, unknown>>>(ids.map((id) => [id, {}]));
  const MANIFEST_SOURCE: Partial<Record<CaseField, string>> = { class: 'manifest.sameForEveryCase', expect: 'manifest.expectByClass' };
  for (const f of CASE_FIELD_KEYS) {
    const inFile = (caseLines ?? []).some((c) => f in c.fields);
    const inRows = rows.some((r) => f in r.fields);
    const inManifest = (f === 'class' && m.sameForEveryCase !== undefined) || (f === 'expect' && m.expectByClass !== undefined);
    const sources = [inFile ? `the case file` : '', inRows ? 'the rows' : '', inManifest ? (MANIFEST_SOURCE[f] as string) : ''].filter(Boolean);
    if (sources.length > 1) {
      p.add(`${f}: is given in ${sources.join(' and ')}; each case field comes from one source for the whole run, also where the values agree`);
      continue;
    }
    if (sources.length === 0) {
      const where = f === 'input' ? 'the case file or the rows' : f === 'class' ? 'the case file, the rows or manifest.sameForEveryCase' : 'the case file, the rows or manifest.expectByClass';
      p.add(`${f}: every case needs one; give it in ${where}`);
      continue;
    }
    if (inFile) {
      for (const c of caseLines ?? []) {
        if (f in c.fields) (value.get(c.id) as Partial<Record<CaseField, unknown>>)[f] = c.fields[f];
        else p.add(`${m.cases as string} line ${c.line}: ${f} is given for other cases of the file and not for ${q(c.id)}; give it for every case`);
      }
    } else if (inRows) {
      if (!throughout((r) => f in r.fields, f)) continue;
      for (const id of ids) {
        const own = rowsOf.get(id) ?? [];
        if (own.length === 0) {
          p.add(`${f}: case ${q(id)} has no row to give it`);
          continue;
        }
        const first = own[0] as GradeRow;
        const differ = own.filter((r) => canonicalJson(r.fields[f]) !== canonicalJson(first.fields[f]));
        if (differ.length > 0) p.add(`${names.grades}: ${f} of case ${q(id)} differs between its rows (lines ${listLines([first.line, ...differ.map((r) => r.line)])}); a case has one ${f}`);
        (value.get(id) as Partial<Record<CaseField, unknown>>)[f] = first.fields[f];
      }
    } else if (f === 'class') {
      for (const id of ids) (value.get(id) as Partial<Record<CaseField, unknown>>)['class'] = m.sameForEveryCase?.class;
    }
  }
  // expectByClass needs the classes first, whichever source they came from.
  if (m.expectByClass !== undefined) {
    const map = m.expectByClass;
    for (const k of Object.keys(map)) if (!Object.hasOwn(theBar.classes, k)) p.add(`manifest.expectByClass.${keySegment(k)}: ${q(k)} is not a class of the bar (${Object.keys(theBar.classes).join(', ')})`, 'UNKNOWN_CLASS');
    const missingClasses = new Set<string>();
    for (const id of ids) {
      const v = value.get(id) as Partial<Record<CaseField, unknown>>;
      const k = v['class'];
      if (typeof k !== 'string') continue;
      if (Object.hasOwn(map, k)) v['expect'] = map[k];
      else missingClasses.add(k);
    }
    for (const k of missingClasses) p.add(`manifest.expectByClass: names no expected label for class ${q(k)}, which holds a case; name every class that holds one`);
  }
  const cases: Case[] = ids.map((id) => {
    const v = value.get(id) as Partial<Record<CaseField, unknown>>;
    return { id, klass: v['class'] as string, input: v['input'], expect: v['expect'] as string };
  });
  for (const c of cases) {
    if (typeof c.klass === 'string' && !Object.hasOwn(theBar.classes, c.klass)) p.add(`case ${q(c.id)}: class ${q(c.klass)} is not a class of the bar (${Object.keys(theBar.classes).join(', ')})`, 'UNKNOWN_CLASS');
    if (typeof c.expect === 'string' && !theBar.labels.includes(c.expect)) p.add(`case ${q(c.id)}: expect ${q(c.expect)} is not a label of the bar (${theBar.labels.join(', ')})`, 'UNKNOWN_LABEL');
  }
  for (const r of rows) {
    if (r.record.kind === 'graded' && r.record.label !== '' && !theBar.labels.includes(r.record.label)) p.add(`${at(r)}: grade ${q(r.record.label)} is not a label of the bar (${theBar.labels.join(', ')})`, 'UNKNOWN_LABEL');
  }
  p.throwIfAny();

  // The run, through the one artifact schema and its validator, on the exact value that is returned.
  const order = new Map(ids.map((id, i) => [id, i]));
  const drawList = [...slots.values()].sort((x, y) => (order.get(x.caseId) as number) - (order.get(y.caseId) as number) || x.drawIndex - y.drawIndex);
  const draws: Draw[] = drawList.map((s) => ({ caseId: s.caseId, drawIndex: s.drawIndex, attempts: s.rows.map((r) => r.record) }));
  const shapeHash = (shape: Obj, prefix: string): string => callShapeHash(shape as unknown as CallShape, prefix);
  const identity = {
    caseSetHash: caseSetHash(cases),
    rubricHash,
    barHash: barHash(theBar),
    systemModelRequested: m.system.modelRequested,
    systemModelServed: m.system.modelServed,
    systemCallShapeHash: shapeHash(systemShape, 'manifest.system.settings'),
    systemPromptHash,
    systemToolsHash,
    systemHarnessVersion: m.system.harnessVersion,
    judgeDefinitionHash,
    judgeModelRequested: m.judge === undefined ? NO_JUDGE : m.judge.modelRequested,
    judgeModelServed: m.judge === undefined ? NO_JUDGE : m.judge.modelServed,
    judgeCallShapeHash: judgeShape === NO_JUDGE ? NO_JUDGE : shapeHash(judgeShape, 'manifest.judge.settings'),
    judgeHarnessVersion: m.judge === undefined ? NO_JUDGE : m.judge.harnessVersion,
    seed: m.seed,
    drawsPerCase,
  };
  const value_ = {
    schema: RUN_SCHEMA,
    identity,
    callShapes: { system: systemShape, judge: judgeShape },
    cases,
    draws,
    packetBasis: !byJudge ? NO_JUDGE : m.packets === undefined ? GAP : m.packets.basis,
    ...(m.packets?.basis === 'declared' ? { packetSource: m.packets.source } : {}),
  };
  const json = JSON.parse(JSON.stringify(value_)) as unknown;
  const bad = runArtifactProblems(json);
  if (bad.length > 0) {
    // A problem with an attempt is named by the line it came from.
    const lineOf = (i: number, j: number): string => {
      const s = drawList[i];
      const r = s?.rows[j];
      return s === undefined || r === undefined ? `slot ${i}` : `${names.grades} line ${r.line} (slot ${s.caseId}#${s.drawIndex}, attempt ${j})`;
    };
    throw new InputError('INVALID_ARTIFACT', bad.map((x) => {
      const a = /^artifact\.draws\[(\d+)\]\.attempts\[(\d+)\](\.)?/.exec(x);
      if (a !== null) return `${lineOf(Number(a[1]), Number(a[2]))}: ${x.slice(a[0].length).replace(/^: /, '')}`;
      const d = /^artifact\.draws\[(\d+)\]\.attempts/.exec(x);
      if (d !== null) {
        const s = drawList[Number(d[1])];
        return `${names.grades}: slot ${s === undefined ? d[1] : `${s.caseId}#${s.drawIndex}`}${x.slice(d[0].length)}`;
      }
      return `the run written from this input: ${x}`;
    }));
  }
  const run = parseRunArtifact(json);
  const declarations: Declaration[] = [];
  const sentStatement = (s: SettingsValue): string | undefined => {
    if (s.kind !== 'sent') return undefined;
    const keys = Object.keys(s.sent);
    return `the harness sent ${keys.length === 0 ? 'no setting' : keys.join(', ')}, and no other call-shape key ("${NOT_SENT}")${keys.includes('extras') ? '' : ', with no provider extras ({})'}`;
  };
  const sys = sentStatement(m.system.settings);
  if (sys !== undefined) declarations.push({ key: 'system.settings', statement: sys });
  const jud = m.judge === undefined ? undefined : sentStatement(m.judge.settings);
  if (jud !== undefined) declarations.push({ key: 'judge.settings', statement: jud });
  if (m.judge?.gradedReplyStop !== undefined) declarations.push({ key: 'judge.gradedReplyStop', statement: `the judge's reply stopped with "${m.judge.gradedReplyStop}" on every graded row` });
  return { run, bar: theBar, facts: { ...runFacts(run), origin: 'produced', rows: rows.length, inputs, declarations } };
}

/** Line numbers for a problem: the first ten, and how many more. */
function listLines(lines: readonly number[]): string {
  return lines.length > 10 ? `${lines.slice(0, 10).join(', ')} and ${lines.length - 10} more` : lines.join(', ');
}
