// The release gate on the tree a release is made from. It refuses a tree whose package.json is not the
// publishable one, a tree that holds a path which is never published, and a tree in which
// `npm publish --dry-run` fails. Every refusal names the field. Nothing here is a warning.
//
//   node tools/release-tree-check.ts [tree]      (default: the tree this file is in)
//
// It takes no flag: an argument that starts with "-" is a usage error, never a tree and never a pass. A
// tree whose name starts with "-" is given as "./-name".
//
// The dry run runs only when every check before it holds: npm is never started in a
// tree that was refused. It builds dist/ in the tree (the `prepack` script), so the tree needs its
// development dependencies installed. It sends nothing to the registry.
//
// The dry run is told `--ignore-scripts=false` on its command line, which outranks npm's environment and its
// user, project and global settings: a setting that skips lifecycle scripts cannot make prepack silently not
// run. And a dry run that exits 0 is not enough: after it, every file the manifest points the package at
// (`main`, `types`, `typings`, `module`, `browser`, `bin`, `exports`) must be a file in the tree (a link must lead to a
// file inside the tree) and must be in the list of files the dry run says it would pack, or the release would ship
// without its entry points. The dry run is asked for that list (`--json`); a dry run that does not give it is refused.
// A project `.npmrc` is refused outright, like `publishConfig`: it configures the publish from inside the tree.
//
// exit 0: every check holds · 2: refused · 64: usage · 70: internal error
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isEntryPoint, runAsProcess, textIo } from "../src/cli.ts";
import { parseJsonText, utf8Text } from "../src/identity.ts";

type Io = { out: (s: string) => void; err: (s: string) => void };

/** One reason the tree is refused. `field` is what to look at: a key of package.json, a path of the tree (written with a leading "./"), or the command. */
export type TreeProblem = { readonly field: string; readonly problem: string };

/**
 * What `npm publish --dry-run` did in the tree. `status` is `undefined` when npm did not run to an exit code. `files` is the
 * list of paths the dry run says the tarball would hold, as npm printed it; `undefined` when npm gave no readable list.
 */
export type DryRunResult = { readonly status: number | undefined; readonly lastLines: readonly string[]; readonly files?: readonly string[] | undefined };

export const PACKAGE_NAME = "anchorset";
export const PUBLIC_REPOSITORY_URL = "git+https://github.com/ogous/anchorset.git";
export const DRY_RUN_FIELD = "npm publish --dry-run";

/**
 * Paths that are never published. A tree that holds one of them is not releasable, whatever its package.json says.
 * `.env` and `.npmrc` are what any project keeps out of a release; `.ledger` is this project's own ledger folder.
 */
export const NEVER_PUBLISHED: readonly string[] = [
  ".env",
  ".npmrc",
  ".ledger",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The problems of a parsed package.json, as the value of a release. Pure.
 *
 * `private` must be absent: `"private": false` is refused too, because the key itself says the file was
 * made for something other than a release. `repository` must be the object form with the public URL, exactly:
 * the string shorthand, another host, another owner and a URL without the `git+` prefix are refused,
 * since the registry ties a release's provenance to this field. `publishConfig` must be absent as well:
 * it sets npm's configuration for the publish from inside the tree (the registry, the tag, and on some
 * npm versions a value that outranks the command line), and a released package.json has none.
 */
export function packageProblems(pkg: unknown): TreeProblem[] {
  if (!isRecord(pkg)) return [{ field: "package.json", problem: "package.json is not a JSON object" }];
  const problems: TreeProblem[] = [];
  if (Object.hasOwn(pkg, "private")) {
    problems.push({ field: "private", problem: `package.json has the key "private" (${JSON.stringify(pkg["private"])}); a released one has no such key` });
  }
  if (Object.hasOwn(pkg, "publishConfig")) {
    problems.push({ field: "publishConfig", problem: `package.json has the key "publishConfig" (${JSON.stringify(pkg["publishConfig"])}); a released one has no such key, and it would configure the publish from inside the tree` });
  }
  if (pkg["name"] !== PACKAGE_NAME) {
    problems.push({ field: "name", problem: `package.json "name" is ${JSON.stringify(pkg["name"]) ?? "absent"}; it must be ${JSON.stringify(PACKAGE_NAME)}` });
  }
  const repository = Object.hasOwn(pkg, "repository") ? pkg["repository"] : undefined;
  if (!isRecord(repository)) {
    const got = repository === undefined ? "absent" : `${JSON.stringify(repository)}, not an object`;
    problems.push({ field: "repository.url", problem: `package.json "repository" is ${got}; "repository.url" must be ${JSON.stringify(PUBLIC_REPOSITORY_URL)}` });
    return problems;
  }
  if (repository["type"] !== "git") {
    problems.push({ field: "repository.type", problem: `package.json "repository.type" is ${JSON.stringify(repository["type"]) ?? "absent"}; it must be "git"` });
  }
  if (repository["url"] !== PUBLIC_REPOSITORY_URL) {
    problems.push({ field: "repository.url", problem: `package.json "repository.url" is ${JSON.stringify(repository["url"]) ?? "absent"}; it must be ${JSON.stringify(PUBLIC_REPOSITORY_URL)}` });
  }
  return problems;
}

/** The folder a tree holds when the plugin ships in it. */
export const PLUGIN_FOLDER = "plugin";
/** The heading of the README's section on the plugin. A tree without the plugin must not hold this line. */
export const README_PLUGIN_HEADING = "## Use it from Claude Code";
const BUILD_MARKER = /<!--\s*with-plugin:/;
const PLUGIN_COMMAND = /\bclaude plugin (?:marketplace add|install)\b/;

/**
 * The problems of a released tree's README. A released README holds no `with-plugin` marker line, and, when the tree
 * does not hold the plugin, neither the section's heading nor a command that installs the plugin. Pure.
 */
export function readmeProblems(text: string, holdsPlugin: boolean): TreeProblem[] {
  const problems: TreeProblem[] = [];
  const lines = text.split("\n").map((l) => l.trimEnd());
  if (lines.some((l) => BUILD_MARKER.test(l))) {
    problems.push({ field: "./README.md", problem: "README.md holds a with-plugin marker line: this tree is not releasable" });
  }
  if (!holdsPlugin && lines.some((l) => l === README_PLUGIN_HEADING || PLUGIN_COMMAND.test(l))) {
    problems.push({ field: "./README.md", problem: `README.md describes the plugin (${JSON.stringify(README_PLUGIN_HEADING)}, or a command that installs it), which this tree does not hold` });
  }
  return problems;
}

/** Whether the tree holds `path`. Only "there is no such path" says no: a path that cannot be looked at is taken as held. */
function holds(root: string, path: string): boolean {
  try {
    // lstat, not stat: a link that points nowhere is still a path in the tree.
    lstatSync(join(root, path));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ENOTDIR");
  }
}

/** The problems of the tree at `root` that can be read without running anything: its package.json, the paths it must not hold and its README. */
export function treeProblems(root: string): TreeProblem[] {
  const problems: TreeProblem[] = [];
  let bytes: Uint8Array | undefined;
  try {
    bytes = readFileSync(join(root, "package.json"));
  } catch (e) {
    problems.push({ field: "package.json", problem: `cannot read package.json in ${root}: ${(e as Error).message}` });
  }
  if (bytes !== undefined) {
    const decoded = utf8Text(bytes);
    if ("problem" in decoded) problems.push({ field: "package.json", problem: `package.json: ${decoded.problem}` });
    else {
      // The library's one JSON reader: a key given twice is a problem, so a second "private" cannot hide behind the first.
      const parsed = parseJsonText(decoded.text);
      if ("problem" in parsed) problems.push({ field: "package.json", problem: `package.json: ${parsed.problem}` });
      else problems.push(...packageProblems(parsed.json));
    }
  }
  for (const path of NEVER_PUBLISHED) {
    // "./" marks a path of the tree, apart from a key of package.json, in the list of fields.
    if (holds(root, path)) problems.push({ field: `./${path}`, problem: `the tree holds ${path}, which is never published: this tree is not releasable` });
  }
  // The README: a tree with none says nothing about a plugin; one that is there and cannot be read is not known to be clean.
  if (holds(root, "README.md")) {
    let readme: Uint8Array | undefined;
    try {
      readme = readFileSync(join(root, "README.md"));
    } catch (e) {
      problems.push({ field: "./README.md", problem: `cannot read README.md in ${root}: ${(e as Error).message}` });
    }
    if (readme !== undefined) {
      const decoded = utf8Text(readme);
      if ("problem" in decoded) problems.push({ field: "./README.md", problem: `README.md: ${decoded.problem}` });
      else problems.push(...readmeProblems(decoded.text, holds(root, PLUGIN_FOLDER)));
    }
  }
  return problems;
}

/**
 * The paths a `npm publish --dry-run --json` says it would pack, or `undefined` if the output is not one of the two
 * shapes npm prints: the result itself (an object with a `files` list; npm 11.9.0), or one object whose only key is this
 * package's name and whose value is that result (npm 11.17.0). An object with a `files` key is read as the result
 * itself, so a `files` that is no list is never passed over for a second reading. Pure.
 */
export function packedFiles(stdout: string): string[] | undefined {
  const parsed = parseJsonText(stdout);
  if ("problem" in parsed || !isRecord(parsed.json)) return undefined;
  let result: Record<string, unknown> = parsed.json;
  if (!Object.hasOwn(result, "files")) {
    const keys = Object.keys(result);
    const inner = result[PACKAGE_NAME];
    if (keys.length !== 1 || keys[0] !== PACKAGE_NAME || !isRecord(inner)) return undefined;
    result = inner;
  }
  const files = result["files"];
  if (!Array.isArray(files)) return undefined;
  const paths: string[] = [];
  for (const f of files) {
    if (!isRecord(f) || typeof f["path"] !== "string") return undefined;
    paths.push(f["path"]);
  }
  return paths;
}

/**
 * Runs `npm publish --dry-run` in the tree. The flags are fixed here, and a flag on the command line outranks npm's
 * configuration: `--ignore-scripts=false` makes prepack (which builds dist/) run whatever the environment or an .npmrc says;
 * `--json` makes npm print the list of files it would pack.
 */
export function npmPublishDryRun(root: string): DryRunResult {
  const r = spawnSync("npm", ["publish", "--dry-run", "--ignore-scripts=false", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error === undefined ? "" : `\n${r.error.message}`}`;
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  return { status: r.status ?? undefined, lastLines: lines.slice(-12), files: r.status === 0 ? packedFiles(r.stdout ?? "") : undefined };
}

/** Every path the manifest enters the package through, as `[field, target]`: `main`, `types`, `typings`, `module`, `browser` (a string, or each string value of its map), each `bin` and each string leaf of `exports`. Pure. */
export function entryTargets(pkg: unknown): Array<[string, string]> {
  if (!isRecord(pkg)) return [];
  const targets: Array<[string, string]> = [];
  for (const key of ["main", "types", "typings", "module"]) {
    const v = pkg[key];
    if (typeof v === "string") targets.push([key, v]);
  }
  const browser = pkg["browser"];
  if (typeof browser === "string") targets.push(["browser", browser]);
  else if (isRecord(browser)) for (const v of Object.values(browser)) if (typeof v === "string") targets.push(["browser", v]);
  const bin = pkg["bin"];
  if (typeof bin === "string") targets.push(["bin", bin]);
  else if (isRecord(bin)) for (const v of Object.values(bin)) if (typeof v === "string") targets.push(["bin", v]);
  const walk = (v: unknown): void => {
    if (typeof v === "string") targets.push(["exports", v]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isRecord(v)) Object.values(v).forEach(walk);
  };
  if (Object.hasOwn(pkg, "exports")) walk(pkg["exports"]);
  return targets;
}

/**
 * The entry points of the manifest that the tree does not hold, read after a dry run that built them, and, when the
 * dry run's list of packed files is given, those the tarball would not hold. A target must be a relative path inside
 * the tree and a file there (a link counts only if it leads to a file inside the tree); a target with a wildcard needs the
 * folder before the wildcard, and in the tarball at least one file below it. A target that cannot be looked at is not known to be there.
 */
export function entryPointProblems(root: string, packed?: readonly string[]): TreeProblem[] {
  let pkg: unknown;
  try {
    const decoded = utf8Text(readFileSync(join(root, "package.json")));
    const parsed = "problem" in decoded ? undefined : parseJsonText(decoded.text);
    pkg = parsed === undefined || "problem" in parsed ? undefined : parsed.json;
  } catch {
    pkg = undefined;
  }
  if (pkg === undefined) return [{ field: "package.json", problem: "package.json cannot be read after the dry run" }];
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return [{ field: "package.json", problem: `${root} cannot be resolved after the dry run` }];
  }
  const within = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const problems: TreeProblem[] = [];
  for (const [field, target] of entryTargets(pkg)) {
    const wildcard = target.includes("*");
    const absolute = resolve(root, target.split("*")[0] ?? "");
    const inside = within(resolve(root), absolute) && !isAbsolute(target);
    let present = false;
    if (inside) {
      try {
        const real = realpathSync(absolute); // follows links: a link out of the tree is not a file of the tree
        if (within(realRoot, real)) {
          const s = statSync(real);
          present = wildcard ? s.isDirectory() : s.isFile();
        }
      } catch {
        present = false;
      }
    }
    if (!present) {
      problems.push({ field, problem: `package.json "${field}" points at ${JSON.stringify(target)}, which is not ${wildcard ? "a folder" : "a file"} in the tree after \`${DRY_RUN_FIELD}\` (a build that did not run, a link that leads out of the tree, or a path outside the tree)` });
      continue;
    }
    if (packed !== undefined) {
      const norm = relative(resolve(root), absolute).split(sep).join("/");
      const inTarball = wildcard ? packed.some((p) => p.startsWith(`${norm}/`)) : packed.includes(norm);
      if (!inTarball) {
        problems.push({ field, problem: `package.json "${field}" points at ${JSON.stringify(target)}, which is in the tree but not in the list of files \`${DRY_RUN_FIELD}\` would pack (the manifest's "files" leaves it out)` });
      }
    }
  }
  return problems;
}

/**
 * Every problem of the tree. The dry run is asked for only when nothing else is wrong; a dry run that
 * did not end with exit code 0, for any reason, is a problem; and after a dry run that did, so is a manifest
 * entry point that the tree does not hold.
 */
export function releaseTreeProblems(root: string, dryRun: (root: string) => DryRunResult = npmPublishDryRun): { problems: TreeProblem[]; dryRunRan: boolean; dryRunLines: readonly string[] } {
  const problems = treeProblems(root);
  if (problems.length > 0) return { problems, dryRunRan: false, dryRunLines: [] };
  const r = dryRun(root);
  if (r.status !== 0) {
    problems.push({ field: DRY_RUN_FIELD, problem: `\`${DRY_RUN_FIELD}\` ${r.status === undefined ? "did not run to an exit code" : `exited ${r.status}`} in ${root}` });
  } else if (!Array.isArray(r.files)) {
    // Fail closed: a dry run that exited 0 but gave no readable list of files cannot show that the entry points are packed.
    problems.push({ field: DRY_RUN_FIELD, problem: `\`${DRY_RUN_FIELD}\` exited 0 in ${root} but gave no readable list of the files it would pack, so the entry points of the manifest cannot be shown to be in the tarball` });
  } else {
    problems.push(...entryPointProblems(root, r.files));
  }
  return { problems, dryRunRan: true, dryRunLines: r.lastLines };
}

export function main(argv: readonly string[], io: Io): number {
  // A path or a line of npm's output may hold anything: the library's printer writes each as one line.
  const text = textIo(io);
  const flags = argv.filter((a) => a.startsWith("-"));
  const paths = argv.filter((a) => !a.startsWith("-"));
  if (flags.length > 0 || paths.length > 1) {
    text.err("usage: node tools/release-tree-check.ts [tree]");
    return 64;
  }
  try {
    const root = resolve(paths[0] ?? join(import.meta.dirname, ".."));
    const { problems, dryRunRan, dryRunLines } = releaseTreeProblems(root);
    if (problems.length === 0) {
      text.out(`release-tree-check: ok for ${root} (package.json has no "private" and no "publishConfig" key, "repository.url" is ${PUBLIC_REPOSITORY_URL}, no path that is never published, \`${DRY_RUN_FIELD}\` exited 0 with scripts on, and every entry point of the manifest is in the tree and in the tarball's file list)`);
      return 0;
    }
    text.err("REFUSED RELEASE_TREE");
    text.err(`  fields: ${problems.map((p) => p.field).join(", ")}`);
    text.err(`  ${root} is not a tree a release can be made from`);
    for (const p of problems) text.err(`  - ${p.problem}`);
    if (dryRunRan) for (const l of dryRunLines) text.err(`      ${l}`);
    else text.err(`  \`${DRY_RUN_FIELD}\` was not run: npm is not started in a refused tree`);
    return 2;
  } catch (e) {
    // Uncaught, this would be exit 1 with a stack trace. Nothing unforeseen is ever a pass.
    text.err(`internal error: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " ")}`);
    return 70;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) runAsProcess(main, "release-tree-check");
