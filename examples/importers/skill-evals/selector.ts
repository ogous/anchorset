/**
 * The field selector: which part of a stored assistant turn the judge is shown.
 *
 * A selector is a JSON Pointer (RFC 6901) into the assistant turn parsed as JSON. `/reply` selects the string under
 * the key `reply`; `/items/0/text` walks into a list. The empty selector means "the whole turn": the stored text is
 * returned as it is, and it need not be JSON. (RFC 6901 reads the empty pointer as the whole parsed document; here
 * it is the whole stored text, since a turn that is shown whole is shown unparsed.) That is this module's own
 * spelling. On a command line the whole turn has one spelling, the flag left out: `check.ts` and `regrade.ts` both
 * refuse an empty `--select` as a usage error, and a re-grade file's header then says "NOT_SENT".
 *
 * The selected text is computed from the stored bytes by this stated rule, never stated by the user. A turn the
 * selector cannot be applied to is refused: the text is not JSON, an object in it holds a key twice, the pointer does
 * not resolve, or the selected value is not a non-empty string of well-formed Unicode. Nothing is trimmed, joined or
 * converted.
 *
 * This file is pure and hashes nothing. `selectorDefinition` is the value an importer puts into the judge's
 * definition, so that a changed selector is a changed judge. The hash of a stored output stays over the whole
 * assistant turn in every case; a selector never changes it.
 *
 * It imports only from `../shared.ts` and `./strict.ts`.
 */
import { ImportRefusal, ImportUsageError, isObject, parseJsonStrict, typeName } from '../shared.ts';
import { isWellFormedText, UNPAIRED_SURROGATE } from './strict.ts';

/** The name and version of the selection rule. A change to how a pointer is read is a new name. */
export const SELECTOR_SYNTAX = 'json-pointer-rfc6901/v1';
/** The selector that selects the whole turn. */
export const WHOLE_TURN = '';

/** What an importer hashes into the judge's definition: the rule's name and the selector's own text, unchanged. */
export type SelectorDefinition = { syntax: typeof SELECTOR_SYNTAX; pointer: string };

/**
 * The reference tokens of a JSON Pointer, unescaped (`~1` is `/`, then `~0` is `~`). A text that is not a JSON
 * Pointer (a non-empty one that does not start with `/`, or a `~` not followed by `0` or `1`) is a usage error:
 * the selector is the user's own flag, not a fact of the file.
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === WHOLE_TURN) return [];
  if (!pointer.startsWith('/')) throw new ImportUsageError(`the selector ${JSON.stringify(pointer)} is not a JSON Pointer (RFC 6901): it must be empty or start with "/"`);
  if (/~(?![01])/.test(pointer)) throw new ImportUsageError(`the selector ${JSON.stringify(pointer)} is not a JSON Pointer (RFC 6901): "~" must be followed by 0 or 1`);
  // The order matters: "~01" is the key "~1", not "/".
  return pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The selector as an importer hashes it. Validates the pointer; hashes nothing. */
export function selectorDefinition(pointer: string): SelectorDefinition {
  parsePointer(pointer);
  return { syntax: SELECTOR_SYNTAX, pointer };
}

/** How the selector is named in a message. */
export const selectorLabel = (pointer: string): string => (pointer === WHOLE_TURN ? 'selector "" (the whole turn)' : `selector ${JSON.stringify(pointer)}`);

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/** The selected text, or why the selector cannot be applied to this turn. Never throws on a valid pointer. */
export function trySelect(answerText: string, pointer: string): { value: string } | { why: string } {
  const tokens = parsePointer(pointer);
  if (pointer === WHOLE_TURN) {
    if (answerText === '') return { why: 'the turn is empty' };
    return isWellFormedText(answerText) ? { value: answerText } : { why: `the turn: ${UNPAIRED_SURROGATE}` };
  }
  // The path's one strict reader: a turn in which a key is given twice is not one document, and is refused whole,
  // whichever key the pointer walks through.
  const parsed = parseJsonStrict(answerText);
  if ('why' in parsed) return { why: parsed.notJson ? `the turn is ${parsed.why}` : `in the turn, ${parsed.why}` };
  let at: unknown = parsed.value;
  let walked = '';
  for (const token of tokens) {
    const here = walked === '' ? 'the document' : JSON.stringify(walked);
    if (Array.isArray(at)) {
      // RFC 6901: an index is "0" or digits with no leading zero; "-" names the element after the last, which never exists.
      if (!ARRAY_INDEX.test(token) || Number(token) >= at.length) return { why: `the pointer does not resolve: ${here} is a list of ${at.length}, with no element ${JSON.stringify(token)}` };
      at = at[Number(token)];
    } else if (isObject(at)) {
      if (!Object.hasOwn(at, token)) return { why: `the pointer does not resolve: ${here} has no key ${JSON.stringify(token)}` };
      at = at[token];
    } else {
      return { why: `the pointer does not resolve: ${here} is ${typeName(at)}, with nothing below it` };
    }
    walked += `/${token.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  }
  if (typeof at !== 'string') return { why: `the selected value is ${typeName(at)}, not a string` };
  if (at === '') return { why: 'the selected value is an empty string' };
  // A turn that is well-formed text can spell an unpaired surrogate with an escape ("\ud800"); the selected text is
  // hashed into the packet, where such a text and another would have one hash.
  if (!isWellFormedText(at)) return { why: `the selected value: ${UNPAIRED_SURROGATE}` };
  return { value: at };
}

/** The selected text of one turn. Refuses (`IMPORT_PACKET`) when the selector cannot be applied to it. */
export function select(answerText: string, pointer: string): string {
  const r = trySelect(answerText, pointer);
  if ('why' in r) throw new ImportRefusal('IMPORT_PACKET', [selectorLabel(pointer)], `${selectorLabel(pointer)}: ${r.why}`);
  return r.value;
}

/**
 * The selected text of every slot, in the order given. Refuses (`IMPORT_PACKET`) with every slot the selector cannot
 * be applied to listed as `<case>#<draw>`.
 */
export function selectAll(slots: readonly { caseId: string; draw: number; answer: string }[], pointer: string): string[] {
  const out: string[] = [];
  const off: { slot: string; why: string }[] = [];
  for (const s of slots) {
    const r = trySelect(s.answer, pointer);
    if ('why' in r) off.push({ slot: `${s.caseId}#${s.draw}`, why: r.why });
    else out.push(r.value);
  }
  if (off.length > 0) {
    throw new ImportRefusal('IMPORT_PACKET', off.map((o) => o.slot), `${selectorLabel(pointer)} cannot be applied to ${off.length} of ${slots.length} slot(s): ${off.map((o) => `${o.slot}: ${o.why}`).join('; ')}`);
  }
  return out;
}
