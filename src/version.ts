export const TOOL_NAME = 'anchorset';
/** Kept equal to package.json "version" (checked by a test). */
export const TOOL_VERSION = '0.4.0';

/** The schema string of a ratings file (`agree --ratings`) and of an anchor file (`drift --old`, `--new`); both are required in the file. */
export const RATINGS_SCHEMA = 'anchorset.ratings/v2';
export const ANCHOR_SCHEMA = 'anchorset.anchor/v1';

/** The schema string of a run-input manifest (`write-run --manifest`, `validate --manifest`), required in the file. Its rows carry none. */
export const RUN_INPUT_SCHEMA = 'anchorset.run-input/v1';

/**
 * The contract string each `--json` object of a command carries as `schema`, beside `tool`: the reports, and the
 * one refusal object that any command prints under `--json` when it refuses (`validate` prints its own report on that exit
 * too: it predicts the gate's refusals and refuses no comparison itself). The judge-change report keeps its own
 * `contracts` block; its report schema is not versioned here (docs/MIGRATIONS.md).
 */
export const REPORT_SCHEMAS = Object.freeze({
  gate: 'anchorset.gate-report/v2',
  agree: 'anchorset.agree-report/v2',
  drift: 'anchorset.drift-report/v2',
  flips: 'anchorset.flips-report/v2',
  'write-run': 'anchorset.write-run-report/v1',
  validate: 'anchorset.validate-report/v1',
  refusal: 'anchorset.refusal/v2',
} as const);
