'use strict';
// The recording grader for promptfoo (anchorset importer example).
//
// It is a promptfoo provider, named in the config as the grader of one `llm-rubric` assertion. It makes the
// judge's call itself over the Anthropic Messages wire format, one request per ask, no redirect, and returns the
// reply with a record of the slot in `metadata.graderEvidence` (schema example.grader-evidence/v7).
// The record is the grader's own declaration of what it sent and what came back; it is not independent evidence.
//
// One call of the tool is one slot. A slot is asked once, and asked again, at most `maxReasks` times (a stated
// setting, 0 to 3, no default), only when an ask ended in one of five things the grader sees without reading the
// reply's text: the deadline passed, the connection failed, a status 5xx, a status 429, or a status 200 whose
// stop_reason is exactly "max_tokens". Every ask of a slot sends the same bytes. A finished reply is never asked
// again, whatever it says; nor is any other 4xx, a redirect, a malformed body or a response in a content encoding. A
// status other than 200 is judged by the status alone: its body is never read.
//
// An ask is in the record only when its slot ends with a record: the record then holds every ask of the slot. A slot
// ends without one when the bound is used up with no reply, or when an ask ends in something that is never asked
// again. The call then throws, and promptfoo keeps no record of a call that throws. If the slot made more than one
// ask, the error's text lists them (call number, call id, what each ended in), and that text is the only place they
// are. A slot that ends on its first ask raises that failure as it came, and with a bound of 0 every slot has one ask.
// promptfoo's own abort is raised as it came too, with no list.
//
// Run by promptfoo, one more slot leaves no record. promptfoo 0.123.1 keeps what this grader returns only when it can
// extract a JSON object from the reply. When it cannot (a cut reply that ended the slot is one such reply), its result
// file holds its own error for that row and nothing of the slot: neither the record nor the slot's asks.
//
// The text of a cut reply that is asked again is not recorded; its sha256 and the number of its UTF-8 bytes are. A cut
// reply that ends the slot, because the bound is used up, is the slot's last ask and is recorded whole.
//
// `promptSha256` in the record is the sha256 of the prompt as the tool handed it to the grader. promptfoo hands one
// text, the JSON text of a message list ([system, user] or [user]), and the hash is over that text. The Inspect grader
// writes the same field over what Inspect hands it, which is one user message and no such text, so the two values are
// not comparable across tools. `sent.system` and `sent.user` are the hashes of the texts sent, on both.
//
// The base URL is taken only in its plain form, the one a URL parser leaves as written: "https://", or "http://" for
// the two literal addresses 127.0.0.1 and [::1] and for no name (not "localhost": a name is whatever the machine's
// resolver says it is); a host that is a lower-case name, four decimal numbers with dots, or [::1]; a port only when it is
// not the scheme's own; and a path of plain segments (letters, digits, ".", "_", "~" and "-", no "." or ".." segment,
// no percent escape). No user information, query or fragment. The Inspect grader holds it to the same rule, so both
// record the same endpoint for the same address. The request asks for no content encoding, and a response that states
// one is refused, not decoded: a content-encoding header that is there is taken only when it reads "identity", in any
// case, once the white space `trim` removes is taken off its ends. A header that is there and empty is refused.
// A response whose head holds a control character, a line that is not a header, or a length stated twice, not in digits
// or beside a transfer encoding, never reaches this grader: the platform refuses it, and the ask ends as a failed
// connection, as it does in the Inspect grader. A folded header line and a space before a header's colon are the
// platform's to take or refuse, by its version (Node 22.21 takes both, Node 25.6 refuses both); the Inspect grader
// refuses both.
//
// Platform built-ins only: the file's sha256 is in a run's identity, so it must stand alone.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The promptfoo versions this grader and its importer were tested on stand in one list, tested-versions.json, one folder up.
// The importer refuses a result file of any other version, and it refuses it after the re-grade has been paid for; so when
// promptfoo itself runs this file, the grader stops before its first call under any other version. A list that cannot be read
// or is malformed stops it too: it never guesses what was tested. The list is not read when promptfoo is not the host.
const TESTED_VERSIONS_FILE = path.join(__dirname, '..', 'tested-versions.json');
const TESTED_VERSIONS_SCHEMA = 'example.tested-versions/v1';
const TESTED_ENTRY_KEYS = ['badFixtures', 'fixtures', 'gradingPathRead', 'runtimes', 'testedOn', 'version'];
const RECORD_SCHEMA = 'example.grader-evidence/v7';
const CALL_SHAPE_SCHEMA = 'anchorset.callshape/v1';
const NOT_SENT = 'NOT_SENT';
const GRADER_NAME = 'anchorset-recording-grader';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60000;
// The longest deadline an ask may be given: one hour. A larger value is refused when the grader is built, before any
// call: a platform timer takes no more than 2147483647 ms, and Node runs one set beyond that after 1 ms, so every ask
// would end as a passed deadline while the record states the larger value.
const MAX_TIMEOUT_MS = 3600000;
const DEFAULT_KEY_ENV = 'ANTHROPIC_API_KEY';
const POSTED_PATH = '/v1/messages';
const ALLOWED_CONFIG = new Set(['model', 'max_tokens', 'temperature', 'baseUrl', 'timeoutMs', 'apiVersion', 'apiKeyEnv', 'thinking', 'effort', 'maxReasks']);
// The most re-asks a slot may be given. The stated bound is an integer from 0 to this.
const MAX_REASKS_CEILING = 3;
// The closed list of what an earlier ask of a slot can have ended in. Nothing else is ever asked again.
const REASK_REASONS = ['timeout', 'transport', 'server-error', 'rate-limited', 'truncated'];
// The wait before a re-ask when the ask before it got no reply: the first value when that ask was the slot's first,
// the second when it was the slot's second, the third when it was the slot's third. A cut reply counts as an ask here,
// though no wait follows one: after a cut reply and then an ask with no reply, the wait is the second value. No
// retry-after header is read: the server does not steer the grader.
const REASK_WAITS_MS = [2000, 4000, 8000];
const NO_RESPONSE = 'NO_RESPONSE';
// The efforts the grader sends. The rule by which a reply is read is not the grader's: the importer is told it, at import.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The hosts plain http is taken for: the two literal loopback addresses. The name "localhost" is not one of them: the key
// would go, in clear text, to whatever address the machine's resolver gives for that name.
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const KEY_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A key is visible ASCII with no space. Any other character (a line feed, a control character, a letter outside
// ASCII) is refused before the headers are built, and the key is never put into a message.
const KEY_FORM = /^[\x21-\x7e]+$/;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// A response id is copied into the record, into an attempt's detail and into an error text a terminal shows: it is held
// to 1 to 200 visible ASCII characters with no space, the importers' form for it, so it can carry no line feed and no
// control character. A response whose id is of any other form is malformed, as one with no id is.
const RESPONSE_ID_FORM = /^[\x21-\x7e]{1,200}$/;
// What the importers hold a free-text value of a record to (shared.ts, isPrintableLine): visible ASCII, single spaces between words,
// none at either end, at most 200 characters. A model id, an API version and a stop reason are copied into the record and into the
// run's identity, so the grader refuses to send, or to record, one that the importers would refuse after the bill.
const PRINTABLE_LINE = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const MAX_LINE = 200;
// The spellings of a gap in the library (readsAsGap in src/identity.ts): a value that reads as one is refused at import.
const GAP_SPELLINGS = new Set(['unknown', 'na', 'none', 'null', 'nil', 'undefined', 'notsent']);
const readsAsGap = (s) => GAP_SPELLINGS.has(s.toLowerCase().replace(/[-_ ./]/g, ''));
const isPrintableLine = (s) => typeof s === 'string' && s.length <= MAX_LINE && PRINTABLE_LINE.test(s);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// One value per process.
const graderRunId = crypto.randomUUID();
const graderSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const runtime = `node ${process.version}`;
let callSeq = 0;

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const nonEmptyString = (x) => typeof x === 'string' && x.length > 0;

// The host of a base URL, as it must be written. A name: labels of lower-case letters, digits and hyphens, joined by
// single dots, each 1 to 63 characters, none opening or closing with a hyphen and none with hyphens in its third and
// fourth places (the reserved form, "xn--" among them); the last label opens with a letter; 253 characters at most.
// An IPv4 address: four decimal numbers, 0 to 255, with no leading zero. An IPv6 address: [::1] and no other.
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PART = /^(0|[1-9][0-9]{0,2})$/;
const PORT_FORM = /^[1-9][0-9]{0,4}$/;
const PLAIN_FORM_WORDS =
  "grader: baseUrl must be written in its plain form: a lower-case scheme and host (a name, four decimal numbers with dots, or [::1]) and a port only when it is not the scheme's own";

function plainHost(host) {
  if (host === '[::1]') return true;
  if (host.length > 253) return false;
  const labels = host.split('.');
  if (labels.every((l) => /^[0-9]+$/.test(l))) return labels.length === 4 && labels.every((l) => IPV4_PART.test(l) && Number(l) <= 255);
  return labels.every((l) => HOST_LABEL.test(l) && l.slice(2, 4) !== '--') && /^[a-z]/.test(labels[labels.length - 1]);
}

/**
 * The base URL, taken only when it is written in the form a URL parser leaves as written, and refused before any call
 * otherwise. The rule, which the Inspect grader (`parse_base_url`) and the importers (`graderBaseUrlProblem`) hold too:
 *
 *   - visible ASCII only, with no "?", "#", "@" or backslash: no user information, query or fragment;
 *   - "https://", or "http://" for the literal address 127.0.0.1 or [::1] and for no other host, in lower case
 *     ("localhost" is a name like any other: taken over https, refused over plain http);
 *   - a host as HOST_LABEL, IPV4_PART and plainHost say: a lower-case name, four decimal numbers, or [::1];
 *   - a port only when it is stated as 1 to 65535 with no leading zero and is not the scheme's own (443, 80);
 *   - a path of plain segments: each letters, digits, ".", "_", "~" and "-" only, none of them "." or "..", none
 *     empty, no percent escape. Closing slashes are dropped.
 *
 * The endpoint is built from the address as written. Node's own parser is then asked, as a second lock: what it makes
 * of the address must be the address (with the one "/" it adds to an address that has no path). No refusal shows the
 * URL: it may hold a credential.
 */
function parseBaseUrl(raw) {
  if (!nonEmptyString(raw)) throw new Error('grader: baseUrl must be a non-empty string');
  if (/[ \t\n\r\f\v?#@\\]/.test(raw)) throw new Error('grader: baseUrl must hold no whitespace, user information, query or fragment');
  // As written: a scheme, "//", the host with its port, then the path.
  const written = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]+)(\/[^]*)?$/.exec(raw);
  if (written === null) throw new Error('grader: baseUrl is not a URL');
  const scheme = written[1];
  if (scheme.toLowerCase() !== 'https' && scheme.toLowerCase() !== 'http') throw new Error('grader: baseUrl must be an http or https URL');
  if (scheme !== 'https' && scheme !== 'http') throw new Error(PLAIN_FORM_WORDS);
  const authority = written[2];
  // The port is what follows the first colon outside the brackets of [::1].
  const colon = authority.startsWith('[') ? authority.indexOf(':', authority.indexOf(']') + 1) : authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (!plainHost(host)) throw new Error(PLAIN_FORM_WORDS);
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (!PORT_FORM.test(port) || Number(port) > 65535 || Number(port) === (scheme === 'https' ? 443 : 80)) throw new Error(PLAIN_FORM_WORDS);
  }
  if (scheme !== 'https' && !LOOPBACK.has(host)) throw new Error('grader: baseUrl must be https (http only for 127.0.0.1 and [::1])');
  const writtenPath = written[3] === undefined ? '' : written[3];
  const path = writtenPath.replace(/\/+$/, '');
  if (path !== '' && (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path) || path.split('/').some((s) => s === '.' || s === '..'))) {
    throw new Error('grader: baseUrl path must hold plain segments only');
  }
  const origin = `${scheme}://${authority}`;
  // The second lock: the platform's parser leaves the address as written.
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(PLAIN_FORM_WORDS);
  }
  if (!/^[\x21-\x7e]+$/.test(raw) || u.href !== (writtenPath === '' ? `${raw}/` : raw) || u.origin !== origin || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new Error(PLAIN_FORM_WORDS);
  }
  return { url: `${origin}${path}${POSTED_PATH}`, origin };
}

/**
 * A gateway the user's other tools honour: the environment variable ANTHROPIC_BASE_URL. This grader never reads it as an
 * address, so with no base URL stated, or another one, the key in the key variable (which may be the gateway's credential)
 * would go to the public host. Refused when the grader is built, before any call. The variable is named and its value is
 * never printed. An empty variable is not set. Under promptfoo the address to state is `baseUrl` in this provider's config,
 * and promptfoo still writes its result file, with an error in every row.
 */
function assertNoGatewayVariable(statedBaseUrl) {
  const gateway = process.env.ANTHROPIC_BASE_URL;
  if (gateway === undefined || gateway === '' || statedBaseUrl === gateway) return;
  const how = statedBaseUrl === undefined ? 'no base URL was stated, so the grader would use its default' : 'the base URL stated differs from it';
  throw new Error(`grader: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it: ${how}, and the key would go there instead of to the address your other tools use. State the same address as \`baseUrl\` in the grader's config, or unset the variable. No call was made.`);
}

/**
 * The version of promptfoo, when promptfoo is the process that runs this file: the nearest package above its entry file that
 * names itself is promptfoo, and its package.json states the version. Run by any other program (the re-grade script of skill-evals, a
 * test) the nearest package is not promptfoo, or there is no entry file to look at, and this grader has no version to check.
 * Returns undefined for "not promptfoo", and a string (possibly one that is not a version) when it is.
 */
function hostPromptfooVersion() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return undefined;
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(entry));
  } catch {
    return undefined;
  }
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        pkg = undefined;
      }
      // A package.json that names nothing is not the package: promptfoo ships one inside its entry folder (`{"type": "module"}`),
      // and the walk goes on to the one above it. One that names another package ends the walk: this is not promptfoo.
      if (isObject(pkg) && typeof pkg.name === 'string') {
        if (pkg.name !== 'promptfoo') return undefined;
        return typeof pkg.version === 'string' ? pkg.version : 'unreadable';
      }
      // One that cannot be read, in a folder that is called promptfoo, is promptfoo's own and says nothing of its version.
      if (pkg === undefined && path.basename(dir) === 'promptfoo') return 'unreadable';
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The list is a short file: all three readers refuse one over this many bytes. */
const TESTED_VERSIONS_MAX_BYTES = 1024 * 1024;

/** A real calendar date, written YYYY-MM-DD, in the years 0001 to 9999. The same arithmetic stands in the two other readers. */
function isCalendarDate(s) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/** The promptfoo versions in the one list of tested versions, oldest first. Anything malformed, for either tool, throws. */
function testedPromptfooVersions() {
  const bad = (what) => new Error(`grader: examples/importers/tested-versions.json ${what}. No call was made.`);
  const onlyKeys = (o, keys) => isObject(o) && Object.keys(o).sort().join() === keys.join();
  let root;
  let formatsPlain = true;
  try {
    const bytes = fs.readFileSync(TESTED_VERSIONS_FILE);
    if (bytes.length > TESTED_VERSIONS_MAX_BYTES) throw new Error('over the limit');
    // Bytes that are not UTF-8 stop here, and a byte order mark stays in the text, where the parser refuses it.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // `2.0` and `2e0` parse to 2: a format is told by how it is written, which the parser gives the reviver.
    root = JSON.parse(text, (key, value, context) => {
      if (key === 'format' && typeof value === 'number' && !/^[1-9][0-9]*$/.test(context?.source ?? '')) formatsPlain = false;
      return value;
    });
    // JSON.parse keeps the last of two equal keys: a list that gives a key twice is told by reading it back with the keys counted.
    const keys = text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? [];
    const counted = (v) => (Array.isArray(v) ? v.reduce((n, x) => n + counted(x), 0) : isObject(v) ? Object.values(v).reduce((n, x) => n + 1 + counted(x), 0) : 0);
    if (keys.length !== counted(root)) throw new Error('a key is given twice');
  } catch (e) {
    throw bad(`cannot be read (${e.name})`);
  }
  if (!formatsPlain) throw bad('a format must be written as a plain positive whole number');
  if (!onlyKeys(root, ['schema', 'tools'])) throw bad('must be an object with exactly the keys schema and tools');
  if (root.schema !== TESTED_VERSIONS_SCHEMA) throw bad(`schema must be ${TESTED_VERSIONS_SCHEMA}`);
  if (!onlyKeys(root.tools, ['inspect_ai', 'promptfoo'])) throw bad('tools must hold exactly inspect_ai and promptfoo');
  for (const name of ['inspect_ai', 'promptfoo']) {
    const tool = root.tools[name];
    if (!onlyKeys(tool, ['format', 'versions'])) throw bad(`${name} must hold exactly format and versions`);
    if (!Number.isSafeInteger(tool.format) || tool.format < 1) throw bad(`${name}.format must be a positive integer`);
    if (!Array.isArray(tool.versions) || tool.versions.length === 0) throw bad(`${name}.versions must be a non-empty list`);
    for (const [i, entry] of tool.versions.entries()) {
      const at = `${name}.versions[${i}]`;
      if (!onlyKeys(entry, TESTED_ENTRY_KEYS)) throw bad(`${at} must hold exactly ${TESTED_ENTRY_KEYS.join(', ')}`);
      if (!TESTED_ENTRY_KEYS.every((k) => typeof entry[k] === 'string' && entry[k].trim() !== '' && entry[k].isWellFormed())) throw bad(`${at}: every value must be a non-empty, well-formed string`);
      if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(entry.version)) throw bad(`${at}.version is not a version`);
      if (!isCalendarDate(entry.testedOn)) throw bad(`${at}.testedOn must be a real date, YYYY-MM-DD`);
    }
    if (new Set(tool.versions.map((e) => e.version)).size !== tool.versions.length) throw bad(`${name}.versions lists a version twice`);
  }
  return root.tools.promptfoo.versions.map((e) => e.version);
}

/** Refuses, before any call, a promptfoo of a version outside the tested list. */
function assertTestedPromptfoo() {
  const found = hostPromptfooVersion();
  if (found === undefined) return;
  const tested = testedPromptfooVersions();
  if (tested.includes(found)) return;
  const what = found === 'unreadable' ? 'a promptfoo whose version cannot be read' : `promptfoo ${found}`;
  throw new Error(`grader: ${what} is running this grader; the importer was tested on promptfoo ${tested.join(', ')} and refuses a result file of any other version, after the re-grade is paid for. Your stored answers need not change. Grade from a separate environment: npm install --prefix .anchorset-grade promptfoo@${tested[tested.length - 1]}. No call was made.`);
}

/**
 * What the process environment can change about the request without the record knowing: a disabled certificate check, and
 * an environment proxy (Node's NODE_USE_ENV_PROXY or --use-env-proxy), which sends the request to another server than the
 * recorded endpoint. Either stops the call. A proxy is allowed only for a target at 127.0.0.1 or [::1] that NO_PROXY names.
 */
function assertEnvironmentIsPlain(target) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('grader: NODE_TLS_REJECT_UNAUTHORIZED=0 turns the certificate check off; the record cannot say who answers');
  }
  const switchOn =
    (process.env.NODE_USE_ENV_PROXY !== undefined && process.env.NODE_USE_ENV_PROXY !== '') ||
    process.execArgv.some((a) => a === '--use-env-proxy' || a.startsWith('--use-env-proxy=')) ||
    /(^|\s)--use-env-proxy(\s|=|$)/.test(process.env.NODE_OPTIONS || '');
  if (!switchOn) return;
  const refusal = new Error('grader: an environment proxy is on; the record cannot say which server answers');
  const u = new URL(target.url);
  if (!LOOPBACK.has(u.hostname)) throw refusal;
  const bare = (h) => h.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(bare).filter((e) => e !== '');
  const host = bare(u.hostname);
  if (!noProxy.some((e) => e === '*' || e === host || e === `${host}:${u.port}`)) throw refusal;
}

/**
 * The body of a response as text, read from the stream and refused beyond the cap (the deadline bounds time, not memory).
 * Bytes that are not UTF-8 are not replaced: such a body is not JSON, and a byte-order mark is kept, so it is not JSON either.
 */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('grader: the response is larger than 32 MiB');
  if (res.body === null) return '';
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('grader: the response is larger than 32 MiB');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('grader: the response is not JSON');
  }
}

/**
 * The `thinking` setting: the string NOT_SENT, or exactly one of the four objects, which is sent verbatim. Returns
 * the request value (a private copy, or undefined for NOT_SENT) and what the call shape says for it.
 */
function parseThinking(v) {
  const refusal = new Error('grader: config.thinking must be "NOT_SENT" or one of {"type":"adaptive"}, {"type":"between_tools"}, {"type":"disabled"}, {"type":"enabled","budget_tokens":<positive integer>}, with no other key');
  if (v === NOT_SENT) return { body: undefined, mode: NOT_SENT, budget: NOT_SENT };
  if (!isObject(v)) throw refusal;
  const keys = Object.keys(v).sort().join();
  if (keys === 'type') {
    if (v.type === 'adaptive') return { body: { type: 'adaptive' }, mode: 'adaptive', budget: NOT_SENT };
    if (v.type === 'between_tools') return { body: { type: 'between_tools' }, mode: 'between-tools', budget: NOT_SENT };
    if (v.type === 'disabled') return { body: { type: 'disabled' }, mode: 'off', budget: NOT_SENT };
    throw refusal;
  }
  if (keys === 'budget_tokens,type' && v.type === 'enabled' && Number.isSafeInteger(v.budget_tokens) && v.budget_tokens > 0) {
    return { body: { type: 'enabled', budget_tokens: v.budget_tokens }, mode: 'budgeted', budget: v.budget_tokens };
  }
  throw refusal;
}

/** The `effort` setting: NOT_SENT or one of the closed words. */
function parseEffort(v) {
  if (v === NOT_SENT || (typeof v === 'string' && EFFORTS.includes(v))) return v;
  throw new Error(`grader: config.effort must be "NOT_SENT" or one of ${EFFORTS.join(', ')}`);
}

/** The thinking-token counter of a response body, or ABSENT when the body has none. A counter that is there and is not a non-negative integer stops the call, and a null or a non-object at any level on the way to it is "there". */
function thinkingTokensOf(body) {
  if (!('usage' in body)) return 'ABSENT';
  const usage = body.usage;
  if (!isObject(usage)) throw new Error('grader: the thinking-token counter is malformed (usage is not an object)');
  if (!('output_tokens_details' in usage)) return 'ABSENT';
  const details = usage.output_tokens_details;
  if (!isObject(details)) throw new Error('grader: the thinking-token counter is malformed (usage.output_tokens_details is not an object)');
  if (!('thinking_tokens' in details)) return 'ABSENT';
  if (!Number.isSafeInteger(details.thinking_tokens) || details.thinking_tokens < 0) throw new Error('grader: the thinking-token counter is not a non-negative integer');
  return details.thinking_tokens;
}

/**
 * The token usage of a response body as the response gave it: `{ input_tokens, output_tokens }`, or ABSENT when the
 * body states neither. One counter without the other, or one that is not a non-negative integer, stops the call.
 * (`thinkingTokensOf` has by then refused a `usage` that is not an object.)
 */
function usageOf(body) {
  if (!('usage' in body)) return 'ABSENT';
  const usage = body.usage;
  if (!('input_tokens' in usage) && !('output_tokens' in usage)) return 'ABSENT';
  const counter = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!counter(usage.input_tokens) || !counter(usage.output_tokens)) throw new Error('grader: the token usage is malformed (input_tokens and output_tokens must both be non-negative integers)');
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
}

/** A wait of `ms` that the tool's own abort ends at once. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The name of a failed connection's error, for a detail text: a code or a class name in plain letters, never a message. */
function transportName(e) {
  const c = e.cause;
  if (isObject(c) || c instanceof Error) {
    if (typeof c.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(c.code)) return c.code;
    if (typeof c.name === 'string' && /^[A-Za-z]{1,60}$/.test(c.name)) return c.name;
  }
  return 'Error';
}

/** The handed prompt: the JSON text of [system, user] or [user], each message holding only a string role and content. */
function convertPrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error('grader: the prompt must be a string (the JSON text of a message list)');
  let list;
  try {
    list = JSON.parse(prompt);
  } catch {
    throw new Error('grader: the prompt is not JSON text');
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 2) throw new Error('grader: the prompt must be [system, user] or [user]');
  for (const m of list) {
    if (!isObject(m) || Object.keys(m).sort().join() !== 'content,role' || !nonEmptyString(m.content)) {
      throw new Error('grader: each message must hold exactly a role and a non-empty string content');
    }
  }
  const roles = list.map((m) => m.role).join();
  if (roles !== 'user' && roles !== 'system,user') throw new Error('grader: the prompt must be [system, user] or [user]');
  const user = list[list.length - 1].content;
  const system = list.length === 2 ? list[0].content : undefined;
  return { system, user };
}

module.exports = class RecordingGrader {
  constructor(options) {
    const config = options && options.config !== undefined ? options.config : {};
    if (!isObject(config)) throw new Error('grader: config must be an object');
    // First of all, before any other setting is looked at: a gateway the grader would ignore sends the key to the public host.
    assertNoGatewayVariable(config.baseUrl);
    for (const k of Object.keys(config)) {
      // The tool's own bookkeeping: it puts `basePath` (the config's folder) into every provider's config. It is not a
      // setting of the call: never sent, never recorded, never in the call shape.
      if (k === 'basePath') {
        if (typeof config.basePath !== 'string') throw new Error("grader: config.basePath, the tool's own key, must be a string when present");
        continue;
      }
      if (!ALLOWED_CONFIG.has(k)) throw new Error(`grader: config key "${k}" is not one the grader sends; it never drops a setting silently`);
    }
    if (!nonEmptyString(config.model)) throw new Error('grader: config.model is required');
    // Before any call: a model id the importer would refuse (one that reads as a gap, or is not one printable line) is refused here, not after the bill.
    if (!isPrintableLine(config.model) || readsAsGap(config.model)) throw new Error('grader: config.model must be one printable line (visible ASCII, single spaces, at most 200 characters) that does not read as unknown; the value is not shown');
    if (!Number.isInteger(config.max_tokens) || config.max_tokens <= 0) throw new Error('grader: config.max_tokens is required, a positive integer');
    if (config.temperature !== undefined && !(typeof config.temperature === 'number' && Number.isFinite(config.temperature) && config.temperature >= 0 && config.temperature <= 1)) {
      throw new Error('grader: config.temperature must be a number in [0, 1]');
    }
    const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`grader: config.timeoutMs must be a positive integer of at most ${MAX_TIMEOUT_MS} (one hour)`);
    const apiVersion = config.apiVersion === undefined ? DEFAULT_API_VERSION : config.apiVersion;
    if (!nonEmptyString(apiVersion)) throw new Error('grader: config.apiVersion must be a non-empty string');
    // The same: an API version that is not 1 to 200 visible ASCII characters, or reads as a gap, is refused here, as the importer refuses it.
    if (!RESPONSE_ID_FORM.test(apiVersion) || readsAsGap(apiVersion)) throw new Error('grader: config.apiVersion must be 1 to 200 visible ASCII characters with no space that do not read as unknown; the value is not shown');
    const keyEnv = config.apiKeyEnv === undefined ? DEFAULT_KEY_ENV : config.apiKeyEnv;
    if (!nonEmptyString(keyEnv)) throw new Error('grader: config.apiKeyEnv must be a non-empty string');
    // The name of a variable, never a key: a key put here by mistake is refused, so it is never carried in the config.
    if (!KEY_ENV_NAME.test(keyEnv)) throw new Error('grader: config.apiKeyEnv must be the name of an environment variable (letters, digits and underscores)');
    // No default for either: a judge's settings are stated, never inherited from the provider.
    for (const k of ['thinking', 'effort']) {
      if (config[k] === undefined) throw new Error(`grader: config.${k} is required (no default)`);
    }
    const thinking = parseThinking(config.thinking);
    const effort = parseEffort(config.effort);
    // No default here either: every re-ask is a paid call, so how many a slot may get is stated. 0 asks once.
    if (config.maxReasks === undefined) throw new Error(`grader: config.maxReasks is required (no default): an integer from 0 to ${MAX_REASKS_CEILING}; 0 asks every slot once`);
    if (!Number.isInteger(config.maxReasks) || config.maxReasks < 0 || config.maxReasks > MAX_REASKS_CEILING) throw new Error(`grader: config.maxReasks must be an integer from 0 to ${MAX_REASKS_CEILING}`);
    this.maxReasks = config.maxReasks;
    this.thinking = thinking;
    this.effort = effort;
    this.model = config.model;
    this.maxTokens = config.max_tokens;
    this.temperature = config.temperature;
    this.timeoutMs = timeoutMs;
    this.apiVersion = apiVersion;
    this.keyEnv = keyEnv;
    this.target = parseBaseUrl(config.baseUrl === undefined ? DEFAULT_BASE_URL : config.baseUrl);
    // Before any call: a promptfoo the importer would refuse after the bill. (The gateway variable is checked first, above.)
    assertTestedPromptfoo();
  }

  id() {
    return 'recording-grader';
  }

  /**
   * One ask: one request, made once, under one deadline that covers the request and the reading of the body.
   * Returns `{ reply }` for a status 200 with a well-formed body, or `{ none, error }` for an ask that got no reply
   * and may be asked again (the deadline, a failed connection, a 5xx, a 429). Anything else throws and ends the slot.
   */
  async ask(payload, headers, toolSignal) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = toolSignal === undefined ? deadline : AbortSignal.any([deadline, toolSignal]);
    // What a failed fetch or a failed read of the body is: the tool's own abort ends the slot; then the deadline; then a
    // failed connection, which the platform reports as a TypeError with a cause. Any other error is raised as it came.
    const noReply = (e) => {
      if (toolSignal !== undefined && toolSignal.aborted) throw e;
      if (e instanceof Error && e.message.startsWith('grader: ')) throw e;
      if (deadline.aborted) return { none: { reason: 'timeout', httpStatus: NO_RESPONSE, detail: `the call passed its deadline of ${this.timeoutMs} ms` }, error: e };
      if (e instanceof TypeError && e.cause !== undefined) return { none: { reason: 'transport', httpStatus: NO_RESPONSE, detail: `transport error (${transportName(e)})` }, error: e };
      throw e;
    };
    let res;
    try {
      // A redirect is not followed and is not a transport error: it comes back as its own status.
      res = await fetch(this.target.url, { method: 'POST', redirect: 'manual', headers, body: payload, signal });
    } catch (e) {
      return noReply(e);
    }
    if (res.status !== 200) {
      // Judged by the status alone, before any byte of the body is read: the body of an error is cancelled, never
      // awaited, parsed or recorded, so a body that stalls cannot turn a 4xx into a passed deadline that is asked again.
      if (res.body !== null) res.body.cancel().catch(() => undefined);
      const error = new Error(`grader: the endpoint answered status ${res.status}`);
      if (res.status >= 500 && res.status <= 599) return { none: { reason: 'server-error', httpStatus: res.status, detail: `the endpoint answered status ${res.status}` }, error };
      if (res.status === 429) return { none: { reason: 'rate-limited', httpStatus: res.status, detail: `the endpoint answered status ${res.status}` }, error };
      throw error;
    }
    // The request asked for no content encoding, and this grader decodes none: a response that states one is refused by
    // its header, before any byte of the body is read, whatever the platform would make of the body. It is not asked again.
    const stated = res.headers.get('content-encoding');
    if ((stated === null ? 'identity' : stated).trim().toLowerCase() !== 'identity') {
      if (res.body !== null) res.body.cancel().catch(() => undefined);
      throw new Error('grader: the response is in a content encoding the request did not ask for');
    }
    let text;
    try {
      text = await readCapped(res);
    } catch (e) {
      return noReply(e);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('grader: the response is not JSON');
    }
    if (!isObject(data) || !nonEmptyString(data.id) || !nonEmptyString(data.model) || !nonEmptyString(data.stop_reason) || !Array.isArray(data.content) || data.content.length === 0) {
      throw new Error('grader: the response lacks id, model, stop_reason or content');
    }
    // The id is not shown: it is the part of the response that is not of the form a record and a terminal can hold.
    if (!RESPONSE_ID_FORM.test(data.id)) throw new Error('grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown');
    // The served model is copied into the record and the run's identity, as the id is: the same form, and not shown.
    if (!RESPONSE_ID_FORM.test(data.model)) throw new Error('grader: the response model is not 1 to 200 visible ASCII characters with no space; it is not shown');
    // The stop reason is copied into the record and printed by the importer: one printable line, and not shown.
    if (!isPrintableLine(data.stop_reason)) throw new Error('grader: the response stop_reason is not one printable line (visible ASCII, single spaces, at most 200 characters); it is not shown');
    // A value the importers read as a gap is refused at import: so it is here, with nothing shown.
    if (readsAsGap(data.id) || readsAsGap(data.model) || readsAsGap(data.stop_reason)) throw new Error('grader: the response id, model or stop_reason reads as unknown; it is not shown');
    const thinkingTokens = thinkingTokensOf(data);
    const usage = usageOf(data);
    // The reply is the text of the response's text blocks, joined (one block in every reply the importer accepts). A thinking block's text, signature or data is never read or recorded. A reply
    // with other shapes of content (two text blocks, a tool block) is recorded as it came and refused at import.
    const contentTypes = [];
    let reply = '';
    for (const block of data.content) {
      if (!isObject(block) || !nonEmptyString(block.type)) throw new Error('grader: a content block has no type');
      contentTypes.push(block.type);
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw new Error('grader: a text block has no text');
        reply += block.text;
      }
    }
    return { reply: { servedModel: data.model, responseId: data.id, stopReason: data.stop_reason, contentTypes, thinkingTokens, usage, text: reply } };
  }

  /**
   * What is checked before a call is built: the environment (a certificate check turned off, an environment proxy), the key
   * variable set, and the key visible ASCII. Returns the key. Run by `callApi` before every call; a program that makes the
   * calls and creates a file of its own (the re-grade script of skill-evals) runs it once before the file exists, so that a
   * refusal with no request leaves no file. The key is never in a message.
   */
  preflight() {
    assertEnvironmentIsPlain(this.target);
    const apiKey = process.env[this.keyEnv];
    if (!nonEmptyString(apiKey)) throw new Error('grader: the key variable named in apiKeyEnv is not set');
    // Before any header is built, and without the value: a platform error about a header could carry it.
    if (!KEY_FORM.test(apiKey)) throw new Error('grader: the key in the variable named in apiKeyEnv holds a character that is not visible ASCII (a space, a line feed, a control character or a character outside ASCII); the request is not sent and the key is not shown');
    return apiKey;
  }

  async callApi(prompt, _context, callOptions) {
    // Taken before any await: concurrent calls get distinct numbers (a number is used up by a call that fails).
    callSeq += 1;
    let seq = callSeq;
    let callId = crypto.randomUUID();

    const { system, user } = convertPrompt(prompt);
    const apiKey = this.preflight();

    // The request and the call shape are built here from the same variables.
    const body = { model: this.model, max_tokens: this.maxTokens, messages: [{ role: 'user', content: user }] };
    if (system !== undefined) body.system = system;
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.thinking.body !== undefined) body.thinking = this.thinking.body;
    if (this.effort !== NOT_SENT) body.output_config = { effort: this.effort };
    const callShape = {
      schema: CALL_SHAPE_SCHEMA,
      endpoint: this.target.url,
      apiVersion: this.apiVersion,
      betaFlags: NOT_SENT,
      thinkingMode: this.thinking.mode,
      thinkingBudgetTokens: this.thinking.budget,
      effort: this.effort,
      toolChoice: NOT_SENT,
      toolChoiceName: NOT_SENT,
      strictTools: NOT_SENT,
      parallelToolUse: NOT_SENT,
      temperature: this.temperature === undefined ? NOT_SENT : this.temperature,
      topP: NOT_SENT,
      topK: NOT_SENT,
      frequencyPenalty: NOT_SENT,
      presencePenalty: NOT_SENT,
      samplingSeed: NOT_SENT,
      maxOutputTokens: this.maxTokens,
      stopSequences: NOT_SENT,
      responseFormat: NOT_SENT,
      contextPolicy: 'none',
      stream: NOT_SENT,
      timeoutMs: this.timeoutMs,
      extras: {},
    };
    // Serialised once: every ask of this slot sends these bytes and these headers.
    const payload = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'accept-encoding': 'identity', 'anthropic-version': this.apiVersion, 'x-api-key': apiKey };
    const toolSignal = callOptions && callOptions.abortSignal instanceof AbortSignal ? callOptions.abortSignal : undefined;

    // The asks of this slot before the last, in the order made. Each ask has its own call number and call id.
    const earlier = [];
    const askText = (a, i) => `ask ${i + 1} (callSeq ${a.callSeq}, callId ${a.callId}): ${a.reason}${a.reason === 'truncated' ? `, response ${a.responseId}` : `, ${a.detail}`}`;
    // What is raised when an ask ends the slot with no record. The tool keeps no record of a call that throws, so when
    // the slot made an ask before this one, the text lists every ask of the slot: nothing else holds them. A slot that
    // ends on its first ask raises the failure as it came, and so does the tool's own abort.
    const endsSlot = (e) => {
      if (earlier.length === 0 || (toolSignal !== undefined && toolSignal.aborted)) return e;
      const words = e instanceof Error ? e.message : String(e);
      const asks = [...earlier.map(askText), `ask ${earlier.length + 1} (callSeq ${seq}, callId ${callId}): ended the slot`];
      return new Error(`${words}; the slot ends with no record after ${asks.length} asks: ${asks.join('; ')}`, { cause: e });
    };
    for (;;) {
      let got;
      try {
        got = await this.ask(payload, headers, toolSignal);
      } catch (e) {
        throw endsSlot(e);
      }
      if (got.reply !== undefined && !(got.reply.stopReason === 'max_tokens' && earlier.length < this.maxReasks)) {
        // The slot's last ask: a reply that is not cut, whatever it says, or a cut reply with the bound used up.
        const last = got.reply;
        const graderEvidence = {
          schema: RECORD_SCHEMA,
          grader: { name: GRADER_NAME, language: 'js', sha256: graderSha256, runtime },
          graderRunId,
          callSeq: seq,
          callId,
          promptSha256: sha256(prompt),
          sent: {
            system: system === undefined ? NOT_SENT : sha256(system),
            user: sha256(user),
            thinking: this.thinking.body === undefined ? NOT_SENT : this.thinking.body,
            output_config: this.effort === NOT_SENT ? NOT_SENT : { effort: this.effort },
          },
          requestedModel: this.model,
          servedModel: last.servedModel,
          responseId: last.responseId,
          stopReason: last.stopReason,
          contentTypes: last.contentTypes,
          thinkingTokens: last.thinkingTokens,
          usage: last.usage,
          reply: last.text,
          callShape,
          reask: { max: this.maxReasks, earlier },
        };
        return { output: last.text, metadata: { graderEvidence } };
      }
      if (got.reply !== undefined) {
        // A reply cut at the output cap. Its text is not recorded and not read; its sha256 and its length in UTF-8
        // bytes are recorded, so the record says which text was cut. It is asked again at once.
        const cut = got.reply;
        // A text with an unpaired surrogate has no UTF-8 bytes of its own, so no hash: such a body ends the slot.
        if (Buffer.from(cut.text, 'utf8').toString('utf8') !== cut.text) throw endsSlot(new Error('grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own'));
        earlier.push({ reason: 'truncated', callSeq: seq, callId, httpStatus: 200, responseId: cut.responseId, servedModel: cut.servedModel, stopReason: cut.stopReason, contentTypes: cut.contentTypes, thinkingTokens: cut.thinkingTokens, usage: cut.usage, replySha256: sha256(cut.text), replyUtf8Bytes: Buffer.byteLength(cut.text, 'utf8') });
      } else {
        const ask = { reason: got.none.reason, callSeq: seq, callId, httpStatus: got.none.httpStatus, detail: got.none.detail };
        if (earlier.length >= this.maxReasks) {
          // With a bound of 0 the slot has this one ask, and its failure is raised as it came. Otherwise the message
          // lists every ask of the slot: the tool keeps no record of a call that throws, so nothing else holds them.
          if (this.maxReasks === 0) throw got.error;
          const asks = [...earlier, ask];
          const each = asks.map(askText);
          throw new Error(`grader: ${ask.detail}; no reply after ${asks.length} asks, the bound of ${this.maxReasks} re-ask(s) is used up: ${each.join('; ')}`);
        }
        earlier.push(ask);
        await wait(REASK_WAITS_MS[earlier.length - 1], toolSignal);
      }
      // The list is closed: an ask that ended in anything else was raised above, and is never asked again.
      if (!REASK_REASONS.includes(earlier[earlier.length - 1].reason)) throw new Error('grader: an ask ended in a way that is not on the closed list; the slot is not asked again');
      if (toolSignal !== undefined && toolSignal.aborted) throw toolSignal.reason;
      // The next ask takes its number and its id here, before its request is sent.
      callSeq += 1;
      seq = callSeq;
      callId = crypto.randomUUID();
    }
  }
};
