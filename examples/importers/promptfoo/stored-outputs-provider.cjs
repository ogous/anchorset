'use strict';
// The stored-outputs provider for promptfoo (anchorset importer example).
//
// It is the "system" of the re-grade: it calls nothing and replays `stored.json` (case id -> the output, a string).
// It writes the draw index, which promptfoo hands to a system provider as `context.repeatIndex` and to no one else,
// into the row's metadata, where the importer reads it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORED_SCHEMA = 'example.stored-output/v1';

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

module.exports = class StoredOutputsProvider {
  constructor(options) {
    const config = options && options.config !== undefined ? options.config : {};
    if (!isObject(config)) throw new Error('stored-outputs: config must be an object');
    for (const k of Object.keys(config)) {
      // The tool's own bookkeeping: it puts `basePath` (the config's folder) into every provider's config.
      if (k === 'basePath') {
        if (typeof config.basePath !== 'string') throw new Error("stored-outputs: config.basePath, the tool's own key, must be a string when present");
        // A relative one would resolve a stored file against the working folder.
        if (!path.isAbsolute(config.basePath)) throw new Error("stored-outputs: config.basePath, the tool's own key, must be an absolute path: pass the config as -c \"$PWD/promptfooconfig.yaml\"");
        continue;
      }
      if (k !== 'storedFile') throw new Error(`stored-outputs: config key "${k}" is not read`);
    }
    const file = config.storedFile === undefined ? path.join(__dirname, 'stored.json') : config.storedFile;
    if (typeof file !== 'string' || file === '') throw new Error('stored-outputs: config.storedFile must be a non-empty string');
    // A relative path is resolved against the config's folder when the tool supplies it, else against this file's folder;
    // never against the working folder.
    const root = typeof config.basePath === 'string' ? config.basePath : __dirname;
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
    } catch {
      throw new Error('stored-outputs: the stored file cannot be read as JSON');
    }
    if (!isObject(stored)) throw new Error('stored-outputs: the stored file must be an object of case id to output');
    this.stored = stored;
  }

  id() {
    return 'stored-outputs';
  }

  async callApi(_prompt, context) {
    const vars = context && context.vars;
    const caseId = isObject(vars) ? vars.case_id : undefined;
    if (typeof caseId !== 'string' || caseId === '') throw new Error('stored-outputs: the test needs a non-empty string variable case_id');
    if (!Object.hasOwn(this.stored, caseId)) throw new Error(`stored-outputs: case "${caseId}" is not in the stored file`);
    const output = this.stored[caseId];
    if (typeof output !== 'string') throw new Error(`stored-outputs: the stored output of case "${caseId}" is not a string`);
    const repeatIndex = context.repeatIndex;
    if (!Number.isInteger(repeatIndex) || repeatIndex < 0) throw new Error('stored-outputs: the tool did not hand a repeat index');
    const outputSha256 = crypto.createHash('sha256').update(output, 'utf8').digest('hex');
    return { output, metadata: { storedOutput: { schema: STORED_SCHEMA, caseId, repeatIndex, outputSha256 } } };
  }
};
