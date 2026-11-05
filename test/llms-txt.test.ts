// llms.txt is the index a coding agent reads first (the llmstxt.org shape: a title, a one-paragraph summary, then
// sections of links). These tests keep it in step with what the package ships, so that a document added to the package
// and left out of the index, or an index link to a page that is not there, fails a test. Nothing here pins its wording.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const files = (JSON.parse(read('package.json')) as { files: string[] }).files;
const PREFIX = 'https://raw.githubusercontent.com/ogous/anchorset/main/';

/** The link targets of the lines under one `## ` heading of a Markdown page, in order. */
function linksUnder(text: string, heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('## ')) inside = l === `## ${heading}`;
    else if (inside) for (const m of l.matchAll(/\]\(([^)#]+)\)/g)) out.push(m[1] as string);
  }
  return out;
}

const index = read('llms.txt');
const shippedDocs = files.filter((f) => f.startsWith('docs/')).sort();

test('llms.txt has the llmstxt.org shape: the title, then a one-paragraph summary as a quote', () => {
  const lines = index.split('\n');
  assert.equal(lines[0], '# anchorset');
  assert.equal(lines[1], '');
  assert.match(lines[2] ?? '', /^> \S/);
});

test('the package ships llms.txt', () => {
  assert.ok(files.includes('llms.txt'), 'package.json "files" leaves llms.txt out');
});

test('every link of llms.txt is a raw link to the main branch, of a file that is in the tree and in the package', () => {
  const all = [...index.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] as string);
  assert.ok(all.length > 0);
  for (const url of all) {
    assert.ok(url.startsWith(PREFIX), `${url}: not a raw link to the main branch`);
    const rel = url.slice(PREFIX.length);
    assert.ok(existsSync(join(root, rel)), `${rel}: llms.txt links to it, but it is not in the tree`);
    assert.ok(files.includes(rel), `${rel}: llms.txt links to it, but the package does not ship it`);
  }
});

test('the Docs section of llms.txt names every document the package ships from docs/, each once', () => {
  const listed = linksUnder(index, 'Docs').map((u) => u.slice(PREFIX.length));
  assert.equal(new Set(listed).size, listed.length, 'a document is listed twice');
  assert.deepEqual([...listed].sort(), shippedDocs);
});

test('the README and llms.txt list the same documents', () => {
  const readme = linksUnder(read('README.md'), 'Docs').filter((l) => l.startsWith('docs/'));
  const listed = linksUnder(index, 'Docs').map((u) => u.slice(PREFIX.length));
  assert.deepEqual([...readme].sort(), [...listed].sort());
});
