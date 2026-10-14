/**
 * The one check of this path that the shared module does not hold: a text with no unpaired surrogate.
 *
 * The library takes the hash of a text from its UTF-8 bytes, and a text that holds an unpaired surrogate has none of
 * its own: every unpaired surrogate is written as the same replacement character, so two different texts would be the
 * same bytes. The library refuses to hash such a text (a `TypeError`). This path refuses it first, where the text is
 * read, as a refusal that names the file, the row and the field. A file cannot decode to such a text (the shared
 * `decodeUtf8` refuses the bytes); a JSON escape such as `"\ud800"` can spell one.
 *
 * The other strict readers (the UTF-8 decoder, the JSON reader that refuses a key given twice, the count readers) are
 * the shared module's. This file is pure and imports nothing.
 */

/** Whether a text holds no unpaired surrogate: every high surrogate is followed by a low one, and no low one stands alone. */
export function isWellFormedText(text: string): boolean {
  return text.isWellFormed();
}

/** What a message says of a text that `isWellFormedText` refuses. */
export const UNPAIRED_SURROGATE = 'the text holds an unpaired surrogate (it is not well-formed Unicode), so it has no UTF-8 bytes of its own, and no hash';
