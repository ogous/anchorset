export type RefusalCode =
  | 'IDENTITY_MISMATCH'
  | 'IDENTITY_GAP'
  | 'HASH_MISMATCH'
  | 'PACKET_MISMATCH'
  | 'ITEM_SET_MISMATCH'
  | 'LABELS_MISMATCH'
  | 'INCOMPLETE_RUN'
  | 'UNSUPPORTED_DESIGN'
  | 'MEASUREMENT_NOT_RUNNABLE';

/** A comparison the library will not stand behind. `fields` names what blocked it. */
export class RefusalError extends Error {
  readonly code: RefusalCode;
  readonly fields: readonly string[];
  constructor(code: RefusalCode, fields: readonly string[], message: string) {
    super(`${code}: ${message}`);
    this.name = 'RefusalError';
    this.code = code;
    this.fields = fields;
  }
}

export type InputErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_LABEL'
  | 'UNKNOWN_CLASS'
  | 'UNKNOWN_CASE'
  | 'INCOMPLETE_DRAWS'
  | 'INVALID_DRAWS'
  | 'INVALID_ARTIFACT'
  | 'INVALID_CALL_SHAPE'
  | 'INVALID_BAR'
  | 'INVALID_PLAN'
  | 'INVALID_LEDGER'
  | 'EMPTY_SAMPLE';

/** Malformed or incomplete input. `problems` lists every issue found, not just the first. */
export class InputError extends Error {
  readonly code: InputErrorCode;
  readonly problems: readonly string[];
  constructor(code: InputErrorCode, problems: readonly string[]) {
    super(`${code}: ${problems.join('; ')}`);
    this.name = 'InputError';
    this.code = code;
    this.problems = problems;
  }
}
