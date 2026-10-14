# Security

anchorset is a library and a command-line tool that reads local JSON files and writes a report. It makes no
network call of its own and has no runtime dependencies.

## Reporting a vulnerability

Please report a suspected vulnerability privately through GitHub's "Report a vulnerability" button on the
repository's Security tab. Do not open a public issue for it. You should get an answer within seven days.

Useful in a report: the version or commit, the command and input that show the problem, and what you expected.

## What counts

- A crafted input file that makes the tool write outside the paths it was given, run code, or accept a comparison
  it documents as refused.
- A way to make a ledger record validate although a field was changed and its hashes were not recomputed, or to
  make the tool rewrite or damage an existing ledger line. The ledger is not signed or chained: whoever can write
  the file can write a consistent record, and that is not a vulnerability.

A wrong statistic or a refusal that should not fire is a bug, not a vulnerability: open an ordinary issue.

## Supported versions

Only the latest released version is supported while the version is below 1.0.
