// Adds a preserved licence banner to every compiled file in dist/, so that copies of the npm
// package keep the copyright and licence notice even when the source headers are gone. Runs after
// `tsc` in `npm run build`. A shebang line stays first.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// REUSE-IgnoreStart
const BANNER =
  "/*! anchorset | Copyright 2026 Ogous Chan Ali | SPDX-License-Identifier: Apache-2.0 | " +
  "see LICENSE and NOTICE | please cite: see CITATION.cff */";
// REUSE-IgnoreEnd

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : [],
  );
}

for (const f of files("dist")) {
  const text = readFileSync(f, "utf8");
  if (text.includes(BANNER)) continue;
  const out = text.startsWith("#!")
    ? text.replace(/^(#![^\n]*\n)/, `$1${BANNER}\n`)
    : `${BANNER}\n${text}`;
  writeFileSync(f, out);
}
