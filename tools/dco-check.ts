// The Developer Certificate of Origin check CONTRIBUTING.md names. Every commit of a range must carry a
// `Signed-off-by: Name <address>` line at the start of a line, and the address must be the one of the commit's author or of
// its committer (so a maintainer who applies someone else's patch can sign it off). A merge commit is not asked for one.
// Nothing here is a warning: one commit without the line refuses the range.
//
//   node tools/dco-check.ts <base>..<head>      (run inside the repository; ci.yml runs it on pull requests)
//
// It takes one argument, a range of two revisions joined by "..". Anything else, and any argument that starts with "-", is a
// usage error. A range git cannot read is an internal error, never a pass. A range of no commits passes.
//
// exit 0: every commit is signed off · 2: refused · 64: usage · 70: internal error
import { spawnSync } from "node:child_process";
import { isEntryPoint, runAsProcess, textIo } from "../src/cli.ts";

type Io = { out: (s: string) => void; err: (s: string) => void };

/** One commit as the check reads it. `parents` is empty for a root commit and has two or more for a merge. */
export type CommitRecord = {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorEmail: string;
  readonly committerEmail: string;
  readonly message: string;
};

const SIGNOFF = /^Signed-off-by: ([^<>\r\n]*[^<>\s]) <([^<>\s@]+@[^<>\s@]+)>[ \t]*\r?$/gm;

/** The problems of a list of commits, as "<10 characters of the id>: <what>", one per commit that fails. Pure. */
export function signoffProblems(commits: readonly CommitRecord[]): string[] {
  const problems: string[] = [];
  for (const c of commits) {
    if (c.parents.length > 1) continue;
    const emails = [...c.message.matchAll(SIGNOFF)].map((m) => (m[2] as string).toLowerCase());
    if (emails.length === 0) {
      problems.push(`${c.sha.slice(0, 10)}: no Signed-off-by line of the form "Signed-off-by: Name <address>" at the start of a line`);
    } else if (!emails.some((e) => e === c.authorEmail.toLowerCase() || e === c.committerEmail.toLowerCase())) {
      problems.push(`${c.sha.slice(0, 10)}: no Signed-off-by line carries the address of the commit's author or committer`);
    }
  }
  return problems;
}

const RECORD = "\x1e";
const FIELD = "\x1f";
/** The format `git log` is asked for: a record mark, then id, parents, author address, committer address and the message, split by a field mark. */
export const LOG_FORMAT = "--format=%x1e%H%x1f%P%x1f%ae%x1f%ce%x1f%B";

/** Reads the text `git log` wrote in LOG_FORMAT. A text that is not that shape throws; it is never read as an empty list. Pure. */
export function parseCommits(text: string): CommitRecord[] {
  if (text === "") return [];
  if (!text.startsWith(RECORD)) throw new Error("the git log text is not the shape this check asked for (no record mark)");
  return text.slice(1).split(RECORD).map((rec) => {
    const f = rec.split(FIELD);
    if (f.length !== 5) throw new Error(`the git log text is not the shape this check asked for (${f.length} fields in a record, expected 5)`);
    const [sha, parents, authorEmail, committerEmail, message] = f as [string, string, string, string, string];
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("the git log text is not the shape this check asked for (an id that is not hexadecimal)");
    return { sha, parents: parents === "" ? [] : parents.split(" "), authorEmail, committerEmail, message };
  });
}

/** The commits of `range` in the repository at `cwd`. */
export function readCommits(range: string, cwd: string): CommitRecord[] {
  const r = spawnSync("git", ["log", "--no-color", LOG_FORMAT, range, "--"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git log ${range} exited ${String(r.status)}: ${(r.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
  return parseCommits(r.stdout);
}

const RANGE = /^[0-9A-Za-z_][0-9A-Za-z._/@~^-]*\.\.[0-9A-Za-z_][0-9A-Za-z._/@~^-]*$/;

export function main(argv: readonly string[], io: Io): number {
  const text = textIo(io);
  const [range, ...rest] = argv;
  if (range === undefined || rest.length > 0 || !RANGE.test(range) || range.includes("...")) {
    text.err("usage: node tools/dco-check.ts <base>..<head>");
    return 64;
  }
  try {
    const commits = readCommits(range, process.cwd());
    const problems = signoffProblems(commits);
    if (problems.length === 0) {
      text.out(`dco-check: ok, ${commits.length} commit${commits.length === 1 ? "" : "s"} in ${range} (a merge commit is not asked for a line)`);
      return 0;
    }
    text.err("REFUSED DCO");
    text.err(`  ${problems.length} of ${commits.length} commits in ${range} lack a sign-off: add it with \`git commit -s --amend\` (or \`git rebase --signoff\` for several) and push again`);
    for (const p of problems) text.err(`  - ${p}`);
    return 2;
  } catch (e) {
    // Uncaught, this would be exit 1 with a stack trace. Nothing unforeseen is ever a pass.
    text.err(`internal error: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ")}`);
    return 70;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) runAsProcess(main, "dco-check");
