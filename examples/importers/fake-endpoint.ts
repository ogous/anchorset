// A local stand-in for a hosted Messages API, for rehearsals and fixture generation. Standard library only.
//
// Wire format: POST /v1/messages with a JSON body { model, max_tokens, messages, system? }; the answer is a
// Messages-shaped response { id, type, role, model, content, stop_reason, stop_sequence, usage }.
// Any other method or path is answered 404. Nothing here checks a key; the log redacts the value of the headers `x-api-key`, `authorization`, `proxy-authorization`, `cookie` and `api-key`.
//
// THE VERDICT RULE (deterministic, from the prompt text only). The prompt text is the system text, a newline,
// then the text of every message, in order. The verdict is:
//   1. "fail" if the prompt holds the marker [[verdict:fail]];
//   2. "pass" if it holds [[verdict:pass]] (when both are present, fail wins);
//   3. "fail" if the requested model id contains "strict" and the prompt holds [[strict:fail]];
//   4. "pass" otherwise.
// So two judges (one model id with "strict" in it, one without) differ exactly on the cases that carry
// [[strict:fail]], and no verdict ever depends on time, a counter or chance. A failure mode depends on a per-body
// counter under the [[times:...]] marker only (below).
//
// THE SERVED ID is the requested id plus "-served-20260101", so it never equals the requested one. The response
// id is "msg_fake_<seq>", seq counting this server's requests from 1, four digits.
//
// REPLY FORMAT: "json" gives {"pass": <bool>, "score": 1|0, "reason": "..."}; "grade" gives a sentence, a blank
// line and "GRADE: C" (pass) or "GRADE: I" (fail). Set by --reply-format, or per request by [[format:grade]] /
// [[format:json]] in the prompt.
//
// GRADE P: a prompt holding [[grade:p]] gets the reply "<sentence>\n\nGRADE: P", a letter no bar holds, whatever the
// verdict rule and the format say (the failure modes below still apply to it).
//
// FAILURE MODES, set by --mode for every request or per request by [[mode:<name>]] in the prompt (the marker wins):
//   normal       a clean, finished, readable reply
//   truncated    the verdict cut in the middle, stop_reason "max_tokens"
//   no-verdict   a finished reply holding no verdict
//   prose        a finished reply with prose around the verdict
//   empty        a finished reply whose text is ""
//   not-json     a finished reply that is plain prose with no verdict at all
//   refusal      a finished-looking reply with stop_reason "refusal"
//   stop-seq     a clean reply with stop_reason "stop_sequence"
//   tool-use     stop_reason "tool_use" and a tool_use content block, no text
//   non-text     a thinking block with some thinking text, then the text block (readable since record v4; it is the one canned reply whose thinking text is not empty)
//   http-500     status 500 and an error body
//   http-529     status 529 and an error body (the server is overloaded)
//   http-429     status 429 and an error body (the rate limit)
//   http-400     status 400 and an error body (the request is rejected)
//   redirect     status 307 with a Location header (to a path on this server)
//   encoded      a clean reply whose body is gzip-compressed, with the header `content-encoding: gzip`, whatever the
//                request's accept-encoding says
//   stall        the request is never answered: the connection stays open until the client or this server closes it
//   drop         the socket is closed with no response
// An unknown mode name is answered 400, never silently treated as normal.
//
// A FAILURE MODE FOR THE FIRST REQUESTS ONLY: the one marker [[times:<n>:<mode>]] in the prompt, n from 1 to 9. The
// first n requests whose BODY BYTES ARE EQUAL are answered in that mode; later requests with the same bytes are
// answered as if the marker were not there. This is the server's only state besides the request number: a counter
// per body, kept for bodies that hold the marker and for no other. Any other n, an unknown mode, a marker that is not
// closed and a second marker in one prompt are answered 400 and counted nowhere. A request in the mode `stall` or
// `drop` is counted and logged like any other; its log line says "NO_RESPONSE" in place of a status.
//
// THINKING AND FENCE MARKERS (per request, from the prompt; they compose with a mode and with each other):
//   [[thinking]]           a thinking block with an empty thinking text and a signature, then the text block;
//                          usage.output_tokens_details.thinking_tokens is 12
//   [[redacted-thinking]]  a redacted_thinking block with a data string, then the text block; the counter is 12
//   [[no-counter]]         the response's usage holds no output_tokens_details (as an older model's does not)
//   [[fence]]              the reply text is the clean reply inside one code fence opened by three backticks and `json`
// Without a thinking marker the counter is 0. The request keys `thinking` and `output_config` are accepted and, like
// the whole body, logged as sent; nothing here checks them and no reply depends on them.
//
// LONG REPLY: --long-reply <chars> (or [[long-reply]] for 20000) puts that many filler characters before the
// verdict, in the reply's text.
//
// It binds to 127.0.0.1 only; any other host is refused.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 18765;
export const LOOPBACK_HOST = '127.0.0.1';
export const SERVED_SUFFIX = '-served-20260101';
export const LONG_REPLY_DEFAULT = 20000;
export const MODES = [
  'normal', 'truncated', 'no-verdict', 'prose', 'empty', 'not-json', 'refusal', 'stop-seq', 'tool-use', 'non-text', 'http-500', 'redirect',
  'http-529', 'http-429', 'http-400', 'stall', 'drop', 'encoded',
] as const;
export type Mode = (typeof MODES)[number];
export type ReplyFormat = 'json' | 'grade';
export interface FakeEndpointOptions {
  host?: string;
  port?: number;
  logPath?: string;
  mode?: Mode;
  replyFormat?: ReplyFormat;
  longReply?: number;
}
export interface RunningEndpoint {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

const CREDENTIAL_HEADERS = new Set(['x-api-key', 'authorization', 'proxy-authorization', 'cookie', 'api-key']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const isMode = (x: string): x is Mode => (MODES as readonly string[]).includes(x);

/** The verdict of the documented rule. */
export function verdictOf(promptText: string, requestedModel: string): 'pass' | 'fail' {
  if (promptText.includes('[[verdict:fail]]')) return 'fail';
  if (promptText.includes('[[verdict:pass]]')) return 'pass';
  if (requestedModel.includes('strict') && promptText.includes('[[strict:fail]]')) return 'fail';
  return 'pass';
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
};

const promptTextOf = (body: Record<string, unknown>): string => {
  const parts: string[] = [textOf(body['system'])];
  if (Array.isArray(body['messages'])) {
    for (const m of body['messages']) {
      if (typeof m === 'object' && m !== null) parts.push(textOf((m as { content?: unknown }).content));
    }
  }
  return parts.join('\n');
};

const verdictReply = (format: ReplyFormat, verdict: 'pass' | 'fail'): string =>
  format === 'json'
    ? JSON.stringify({ pass: verdict === 'pass', score: verdict === 'pass' ? 1 : 0, reason: `Local fake judge: ${verdict}.` })
    : `Local fake judge reasoning.\n\nGRADE: ${verdict === 'pass' ? 'C' : 'I'}`;

export function startFakeEndpoint(options: FakeEndpointOptions = {}): Promise<RunningEndpoint> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    return Promise.reject(new Error(`fake-endpoint binds to ${LOOPBACK_HOST} only; refusing host "${host}"`));
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error(`invalid port ${String(port)}`));
  const defaultMode: Mode = options.mode ?? 'normal';
  if (!isMode(defaultMode)) return Promise.reject(new Error(`unknown mode "${String(defaultMode)}"`));
  const defaultFormat: ReplyFormat = options.replyFormat ?? 'json';
  if (defaultFormat !== 'json' && defaultFormat !== 'grade') return Promise.reject(new Error(`unknown reply format "${String(defaultFormat)}"`));
  const defaultLong = options.longReply ?? 0;
  if (!Number.isInteger(defaultLong) || defaultLong < 0) return Promise.reject(new Error('longReply must be a non-negative integer'));
  const logPath = options.logPath;
  if (logPath !== undefined) {
    // An existing file is never truncated: the log of an earlier run is evidence.
    try {
      writeFileSync(logPath, '', { flag: 'wx' });
    } catch (e) {
      return Promise.reject(new Error((e as NodeJS.ErrnoException).code === 'EEXIST' ? `--log ${logPath} exists; fake-endpoint never overwrites a log` : `cannot create --log ${logPath}: ${(e as Error).message}`));
    }
  }
  let seq = 0;
  // How often each body that holds a [[times:...]] marker was seen, by its bytes.
  const seenBodies = new Map<string, number>();

  const handle = (req: IncomingMessage, res: ServerResponse, bytes: Buffer): void => {
    const raw = bytes.toString('utf8');
    seq += 1;
    const mySeq = seq;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = CREDENTIAL_HEADERS.has(name.toLowerCase()) ? '<redacted>' : Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    let bodyJson: unknown = null;
    try {
      bodyJson = JSON.parse(raw);
    } catch {
      bodyJson = null;
    }
    let status = 200;
    let extraHeaders: Record<string, string> = {};
    let payload: unknown;
    let usedMode: string = defaultMode;
    let verdict: string = 'none';
    let noResponse: 'stall' | 'drop' | undefined;
    let gzip = false;
    const path = (req.url ?? '').split('?', 1)[0];

    const fail = (code: number, type: string, message: string): void => {
      status = code;
      payload = { type: 'error', error: { type, message } };
    };

    if (req.method !== 'POST' || path !== '/v1/messages') {
      fail(404, 'not_found_error', 'local fake: unknown route');
    } else if (typeof bodyJson !== 'object' || bodyJson === null || Array.isArray(bodyJson)) {
      fail(400, 'invalid_request_error', 'local fake: body is not a JSON object');
    } else {
      const body = bodyJson as Record<string, unknown>;
      const model = body['model'];
      if (typeof model !== 'string' || model === '' || !Array.isArray(body['messages'])) {
        fail(400, 'invalid_request_error', 'local fake: model and messages are required');
      } else {
        const prompt = promptTextOf(body);
        const modeMarker = /\[\[mode:([a-z0-9-]+)\]\]/.exec(prompt)?.[1];
        usedMode = modeMarker ?? defaultMode;
        // The one stateful marker. It must stand once and whole; anything else that opens like it is refused below.
        const timesOpens = prompt.split('[[times:').length - 1;
        const times = /\[\[times:([1-9]):([a-z0-9-]+)\]\]/.exec(prompt);
        const timesBad = timesOpens > 0 && (timesOpens !== 1 || times === null || !isMode(times[2] as string));
        if (timesOpens > 0 && !timesBad && times !== null) {
          // The key is the body's bytes, each byte one character: two bodies are one key only when their bytes are equal.
          const key = bytes.toString('latin1');
          const count = (seenBodies.get(key) ?? 0) + 1;
          seenBodies.set(key, count);
          if (count <= Number(times[1])) usedMode = times[2] as string;
        }
        const formatMarker = /\[\[format:(json|grade)\]\]/.exec(prompt)?.[1] as ReplyFormat | undefined;
        const format = formatMarker ?? defaultFormat;
        const long = prompt.includes('[[long-reply]]') ? Math.max(defaultLong, LONG_REPLY_DEFAULT) : defaultLong;
        if (timesBad) {
          fail(400, 'invalid_request_error', 'local fake: a [[times:<n>:<mode>]] marker must stand once in a prompt, with n from 1 to 9 and a known mode');
        } else if (!isMode(usedMode)) {
          fail(400, 'invalid_request_error', `local fake: unknown mode "${usedMode}"`);
        } else {
          const v = verdictOf(prompt, model);
          verdict = v;
          const plain = prompt.includes('[[grade:p]]') ? 'Local fake judge reasoning.\n\nGRADE: P' : verdictReply(format, v);
          const clean = prompt.includes('[[fence]]') ? `\`\`\`json\n${plain}\n\`\`\`` : plain;
          const thinkingBlock: Record<string, unknown> | undefined = prompt.includes('[[redacted-thinking]]')
            ? { type: 'redacted_thinking', data: 'ZmFrZS1yZWRhY3RlZA==' }
            : prompt.includes('[[thinking]]')
              ? { type: 'thinking', thinking: '', signature: 'fake-signature' }
              : undefined;
          let text = clean;
          let stop = 'end_turn';
          let content: unknown[] | undefined;
          switch (usedMode) {
            case 'normal': break;
            case 'truncated': text = clean.slice(0, Math.max(1, Math.floor(clean.length / 2))); stop = 'max_tokens'; break;
            case 'no-verdict': text = format === 'json' ? JSON.stringify({ reason: 'Local fake judge: no verdict given.' }) : 'Local fake judge reasoning with no grade line.'; break;
            case 'prose': text = `Here is my verdict: ${clean} I hope that helps.`; break;
            case 'empty': text = ''; break;
            case 'not-json': text = 'I cannot put this in the requested form, but the reply seems fine.'; break;
            case 'refusal': stop = 'refusal'; break;
            case 'stop-seq': stop = 'stop_sequence'; break;
            case 'tool-use':
              stop = 'tool_use';
              content = [{ type: 'tool_use', id: `toolu_fake_${String(mySeq).padStart(4, '0')}`, name: 'fake_tool', input: {} }];
              break;
            case 'non-text': content = [{ type: 'thinking', thinking: 'Local fake thinking.', signature: 'fake' }, { type: 'text', text: clean }]; break;
            case 'http-500': fail(500, 'api_error', 'local fake: internal error'); break;
            case 'http-529': fail(529, 'overloaded_error', 'local fake: overloaded'); break;
            case 'http-429': fail(429, 'rate_limit_error', 'local fake: rate limited'); break;
            case 'http-400': fail(400, 'invalid_request_error', 'local fake: the request is rejected'); break;
            case 'encoded': gzip = true; break;
            case 'stall': noResponse = 'stall'; break;
            case 'drop': noResponse = 'drop'; break;
            case 'redirect':
              status = 307;
              extraHeaders = { location: '/v1/messages' };
              payload = { type: 'error', error: { type: 'redirect', message: 'local fake: redirected' } };
              break;
          }
          if (status === 200 && noResponse === undefined) {
            if (long > 0 && content === undefined) text = `${'x'.repeat(long)}\n\n${text}`;
            payload = {
              id: `msg_fake_${String(mySeq).padStart(4, '0')}`,
              type: 'message',
              role: 'assistant',
              model: model + SERVED_SUFFIX,
              content: content ?? [...(thinkingBlock === undefined ? [] : [thinkingBlock]), { type: 'text', text }],
              stop_reason: stop,
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                ...(prompt.includes('[[no-counter]]') ? {} : { output_tokens_details: { thinking_tokens: thinkingBlock === undefined ? 0 : 12 } }),
              },
            };
          }
        }
      }
    }
    const out = JSON.stringify(payload);
    if (logPath !== undefined) {
      const record = {
        seq: mySeq,
        method: req.method ?? '',
        path: req.url ?? '',
        headers,
        bodyJson,
        mode: usedMode,
        verdict,
        response: noResponse === undefined ? { status, body: payload } : { status: 'NO_RESPONSE', body: noResponse },
      };
      appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    }
    if (noResponse === 'drop') {
      req.socket.destroy();
      return;
    }
    // Never answered. The socket stays open until the client gives up or the server is closed.
    if (noResponse === 'stall') return;
    // The log holds the reply as JSON either way; only the bytes on the wire are compressed.
    const sent = gzip ? gzipSync(out) : Buffer.from(out, 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': sent.byteLength, ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...extraHeaders });
    res.end(sent);
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"request_too_large","message":"local fake: body too large"}}');
        return;
      }
      handle(req, res, Buffer.concat(chunks));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(`${LOOPBACK_HOST}:${port} is already in use; another fake endpoint (or a leftover of an earlier rehearsal) may still be running. Stop it, or start this one with --port <another port>`)
          : e,
      );
    });
    server.listen(port, LOOPBACK_HOST, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        host: LOOPBACK_HOST,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

async function main(argv: string[]): Promise<void> {
  const known = new Set(['--port', '--host', '--log', '--mode', '--reply-format', '--long-reply']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i] ?? '') || argv[i + 1] === undefined) {
      console.error(`usage: node examples/importers/fake-endpoint.ts [--port N] [--host 127.0.0.1] [--log FILE] [--mode ${MODES.join('|')}] [--reply-format json|grade] [--long-reply CHARS]`);
      process.exit(64);
    }
  }
  const opts: FakeEndpointOptions = {};
  const port = flagValue(argv, '--port');
  const host = flagValue(argv, '--host');
  const log = flagValue(argv, '--log');
  const mode = flagValue(argv, '--mode');
  const fmt = flagValue(argv, '--reply-format');
  const long = flagValue(argv, '--long-reply');
  if (port !== undefined) opts.port = Number(port);
  if (host !== undefined) opts.host = host;
  if (log !== undefined) opts.logPath = log;
  if (mode !== undefined) opts.mode = mode as Mode;
  if (fmt !== undefined) opts.replyFormat = fmt as ReplyFormat;
  if (long !== undefined) opts.longReply = Number(long);
  try {
    const running = await startFakeEndpoint(opts);
    console.error(`fake-endpoint listening on ${running.host}:${running.port}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(64);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
