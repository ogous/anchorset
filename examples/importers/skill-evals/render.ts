/**
 * The judge prompt of a re-grade: a template with exactly three tokens, `{question}`, `{answer}` and `{criterion}`,
 * filled by single-pass plain substitution. The substituted text is never scanned again, so a token (or any brace)
 * inside a question, an answer or a criterion stays as it is.
 *
 * The template itself is held to a narrow form, checked before any call: each of the three tokens exactly once, and
 * no other brace anywhere. A doubled brace, a `{name}` outside the three, a format specification, an index or a
 * lone brace refuses. A template can therefore not show a JSON object literally; it says the answer's form in words,
 * and a system text (which is not a template) may show it.
 *
 * Two of these rules are the shared module's and are called, not copied: the brace and token-name rule
 * (`templateProblem`) and the single-pass renderer (`skeletonFromTemplate` with `renderSkeleton`). What is this
 * path's own is one rule, "each token exactly once", and the refusal of an empty part.
 *
 * This file is pure. It imports only from `../shared.ts`.
 */
import { ImportRefusal, renderSkeleton, skeletonFromTemplate, templateProblem } from '../shared.ts';

/** The three tokens of a template, and no other. */
export const TEMPLATE_TOKENS = ['question', 'answer', 'criterion'] as const;
export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];
/** The three texts a slot's prompt is rendered from. */
export type Parts = Record<TemplateToken, string>;

/** Every reason the template is outside the form above; empty when it is inside it. */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  // The shared rule: as braces, the template holds only the plain tokens of the three names.
  const brace = templateProblem(template, TEMPLATE_TOKENS);
  if (brace !== undefined) problems.push(brace);
  // This path's own rule: each of the three exactly once.
  for (const token of TEMPLATE_TOKENS) {
    const n = template.split(`{${token}}`).length - 1;
    if (n === 0) problems.push(`{${token}} is missing`);
    else if (n > 1) problems.push(`{${token}} appears ${n} times, not once`);
  }
  return problems;
}

/** Refuses (`IMPORT_PACKET`) a template outside the form, with every reason. */
export function checkTemplate(template: string): void {
  const problems = templateProblems(template);
  if (problems.length > 0) throw new ImportRefusal('IMPORT_PACKET', ['template'], `the template is refused before any call: ${problems.join('; ')}`);
}

/** The template with each token replaced by its text, in one pass over the template. An empty part is refused. */
export function renderTemplate(template: string, parts: Parts): string {
  checkTemplate(template);
  const empty = TEMPLATE_TOKENS.filter((t) => parts[t] === '');
  if (empty.length > 0) throw new ImportRefusal('IMPORT_PACKET', empty, empty.map((t) => `${t}: the text is empty`).join('; '));
  // The shared renderer: the template is cut at its tokens once, and each part is put in as it is, never scanned.
  const [rendered] = renderSkeleton(skeletonFromTemplate(template, TEMPLATE_TOKENS), parts);
  if (rendered === undefined) throw new Error('renderTemplate: the shared renderer returned no message');
  return rendered;
}

/** The text handed to the grader: the JSON text of the message list `[system, user]`, or `[user]` with no system text. */
export function promptTextOf(system: string | undefined, user: string): string {
  const list = system === undefined ? [{ role: 'user', content: user }] : [{ role: 'system', content: system }, { role: 'user', content: user }];
  return JSON.stringify(list);
}
