export const TOOL_NAME = 'anchorset';
/** Kept equal to package.json "version" (checked by a test). */
export const TOOL_VERSION = '0.1.0';

/** The schema string of a ratings file (`agree --ratings`) and of an anchor file (`drift --old`, `--new`); both are required in the file. */
export const RATINGS_SCHEMA = 'anchorset.ratings/v1';
export const ANCHOR_SCHEMA = 'anchorset.anchor/v1';

/**
 * The contract string each `--json` object of a command carries as `schema`, beside `tool`: the four reports, and the
 * one refusal object that any command prints under `--json` when it refuses. The judge-change report keeps its own
 * `contracts` block; its report schema is not versioned here (docs/MIGRATIONS.md).
 */
export const REPORT_SCHEMAS = Object.freeze({
  gate: 'anchorset.gate-report/v1',
  agree: 'anchorset.agree-report/v1',
  drift: 'anchorset.drift-report/v1',
  flips: 'anchorset.flips-report/v1',
  refusal: 'anchorset.refusal/v1',
} as const);
