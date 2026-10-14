# Re-grade the stored outputs of an Inspect log through the recording grader (anchorset importer example).
#
#   python regrade.py --log <system log> --epochs <N> --check
#   python regrade.py --log <system log> --epochs <N> --judge-model <name> --max-tokens <n> --out-dir <dir>
#                     --thinking <NOT_SENT | JSON object> --effort <NOT_SENT | low | medium | high | xhigh | max>
#                     --max-reasks <0 | 1 | 2 | 3> --base-url <url>
#                     [--template-file <file>] [--instructions-file <file>]
#                     [--temperature <x>] [--timeout-ms <n>] [--api-version <v>] [--api-key-env <NAME>] [--go-on-and-count]
#
# It runs ONE eval. The solver replays each sample's stored output and calls no model; the scorer is
# model_graded_qa(template=<text>, instructions=<text>, model=<the recording grader>), with epochs=N, the log in the
# JSON format and fail_on_error=True. No response cache is used: this script sets none, the scorer asks for none, and
# the grader refuses a cache setting. The template and the instructions are always passed as
# text, never as a path. Without a file flag the script passes the two default texts beside it.
# Every flag is taken at most once and by its whole name, and a flag stated with an empty value is a usage error: the
# script never picks between two stated settings and never puts a default in place of a stated one.
# A number is taken only in its plain form, in ASCII digits: `--epochs`, `--max-tokens` and `--timeout-ms` as a positive
# integer with no sign, no leading zero, no underscore and no space; `--temperature` as a plain decimal such as 0, 0.5 or
# 1, with no sign and no exponent. Any other spelling is a usage error, never a number Python would make of it.
# `--thinking` and `--effort` have no default and a run needs both: NOT_SENT sends nothing; otherwise `--thinking` is the
# JSON text of one of the four request objects ({"type":"adaptive"}, {"type":"between_tools"}, {"type":"disabled"},
# {"type":"enabled","budget_tokens":<n>}) and `--effort` is one word. The grader refuses every other form before any call.
# `--max-reasks` has no default either: it is the bound of re-asks one slot may be given, 0 to 3; 0 asks every slot once.
# The grader asks a slot again, inside its one call for that slot, only after an ask that got no reply (a passed
# deadline, a failed connection, a status 5xx, a status 429) or a reply cut at the output cap, and never after a finished
# reply. This script passes no retry option to the tool and keeps fail_on_error=True. It lets the grader work on one slot
# at a time: a slot's call, its re-asks and the waits between them included, has returned or raised before the next begins.
# `--base-url` has no default either: the endpoint decides where the key goes, so it is stated, never inherited from the
# grader's default host.
#
# The re-grade stops at the first slot the importer will refuse: a last ask that did not stop with "end_turn", content that
# is not zero or more thinking blocks and one text block, or a reply whose last non-empty line is not exactly "GRADE: " and
# one capital letter (the importer's own tests of a finished and readable grade). The slot's grade is then not written to the
# log and no later slot is paid for; the exit is 2. `--go-on-and-count` goes on instead, counts such slots and prints
# `slots the importer will refuse: <k>`. A label that differs from the tool's own reading is found only at import.
# A lost slot ends the re-grade as well, and `--go-on-and-count` does not change that: when the grader's call raises (no reply
# within the bound of re-asks, a status that is not asked again, a served model id or a response id of a form the grader
# refuses), the slot has no record to count, no later slot is called, and the exit is 2.
#
# Exit codes: 0 done; 2 refused; 64 usage.
#   64  the flags, the key, the tool's version or a missing package, a setting the grader refuses, an --out-dir that
#       cannot be made or cannot be written to. Nothing was sent.
#   2   before the eval: a text file or a source log that cannot be read or replayed. Nothing was sent.
#   2   during the eval: a slot whose call failed, a slot the importer will refuse, an eval that did not succeed,
#       that raised or that was interrupted (Ctrl-C). The slots called before that point were sent and are paid for;
#       the log, when there is one, is kept and is not importable. The asks of a slot that was interrupted are in no
#       record, and may be billed.
# An error the script did not foresee is exit 2 too, on one line. It never ends in a traceback of its own.
from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import os
import re
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
TESTED_INSPECT_VERSION = "0.3.275"
EXIT_REFUSED = 2
EXIT_USAGE = 64
# The pause before each slot's call, in seconds, in which the tool can cancel a slot after an interrupt (see `guarded_generate`).
INTERRUPT_PAUSE_S = 0.05


class Usage(Exception):
    pass


class _Once(argparse.Action):
    """A flag with a value, refused when given twice: the script never picks between two stated settings."""

    def __call__(self, parser: Any, namespace: Any, values: Any, option_string: Any = None) -> None:
        if getattr(namespace, self.dest, None) is not None:
            raise Usage(f"{option_string} was given twice")
        setattr(namespace, self.dest, values)


class _OnceSwitch(argparse.Action):
    """A flag with no value, refused when given twice, as a flag with a value is."""

    def __init__(self, option_strings: Any, dest: str, **kwargs: Any) -> None:
        super().__init__(option_strings, dest, nargs=0, default=False, **kwargs)

    def __call__(self, parser: Any, namespace: Any, values: Any, option_string: Any = None) -> None:
        if getattr(namespace, self.dest, False):
            raise Usage(f"{option_string} was given twice")
        setattr(namespace, self.dest, True)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:
        raise Usage(message)


def read_text(path: str) -> str:
    with open(path, "rb") as f:
        return f.read().decode("utf-8")


def thinking_from_text(text: str) -> Any:
    """`NOT_SENT`, or the JSON text of the request's thinking object (an object, no duplicate key, no NaN). The grader checks the form."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        keys = [k for k, _ in items]
        if len(set(keys)) != len(keys):
            raise ValueError("the JSON text holds a key twice")
        return dict(items)

    def constant(name: str) -> Any:
        raise ValueError(f"the JSON text holds the constant {name}")

    if text == "NOT_SENT":
        return text
    value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise ValueError("the JSON text is not an object")
    return value


def resource_hazard(text: str, what: str) -> str | None:
    """The tool reads a template or instructions text as a resource when it names an existing local file or parses
    as a URL with a scheme and holds `://` or no white space. Such a text is refused before the scorer is built."""
    from urllib.parse import urlparse

    if text.strip() == "":
        return f"{what} is empty; the tool would substitute its own default"
    try:
        parsed = urlparse(text)
    except ValueError:
        return None
    # the tool's own condition ("://") and, stricter, any scheme in a text with no white space at all
    if parsed.scheme and ("://" in text or not any(c.isspace() for c in text)):
        return f"{what} parses as a URL with the scheme {parsed.scheme!r}; the tool would read it as a resource"
    try:
        if os.path.exists(text):
            return f"{what} names an existing local file; the tool would read it as a resource"
    except (ValueError, OSError):
        pass
    try:
        from inspect_ai._util.file import filesystem

        if filesystem(text).exists(text):
            return f"{what} names an existing file; the tool would read it as a resource"
    except Exception:
        pass
    return None


def _stored_content(out: Any) -> Any:
    """The content of the one output message of a sample, or None when there is not exactly one choice with a message."""
    choices = getattr(out, "choices", None)
    if not choices or len(choices) != 1:
        return None
    return getattr(getattr(choices[0], "message", None), "content", None)


def source_problems(log: Any) -> list[str]:
    """The source-log contract. Every problem names every sample concerned. Nothing is picked or repaired. A field a
    sample lacks is a problem of that sample, never an error of this function."""
    problems: list[str] = []
    if getattr(log, "status", None) != "success":
        problems.append(f"the log's status is {getattr(log, 'status', None)!r}, not 'success'")
    samples = getattr(log, "samples", None)
    if not samples:
        problems.append("the log holds no samples")
        return problems
    # By type and value: the integer 1 and the string "1" are two ids. They are refused below in their own words.
    by_id: dict[tuple[str, Any], list[Any]] = {}
    for s in samples:
        ident = getattr(s, "id", None)
        label = f"sample {ident!r} epoch {getattr(s, 'epoch', '?')}"
        if isinstance(ident, bool) or not (isinstance(ident, int) or (isinstance(ident, str) and ident != "")):
            problems.append(f"{label}: the id must be a non-empty string or an integer")
            continue
        by_id.setdefault((type(ident).__name__, ident), []).append(s)
        if getattr(s, "error", None) is not None:
            problems.append(f"{label}: the sample has an error")
        out = getattr(s, "output", None)
        choices = getattr(out, "choices", None)
        content = _stored_content(out)
        if out is None or not choices:
            problems.append(f"{label}: the sample has no output")
        elif len(choices) != 1:
            problems.append(f"{label}: the sample has {len(choices)} choices; exactly one is replayed")
        elif not isinstance(content, str):
            problems.append(f"{label}: the output message's content is not one string")
        elif content == "":
            problems.append(f"{label}: the output is empty")
        elif content != getattr(out, "completion", None):
            problems.append(f"{label}: the output message's content differs from output.completion")
        question = getattr(s, "input", None)
        target = getattr(s, "target", None)
        if not isinstance(question, str):
            problems.append(f"{label}: the input is not one string (a list of parts or a chat-message input)")
        if not isinstance(target, str):
            problems.append(f"{label}: the target is not one string (a list of targets)")
        if getattr(s, "choices", None):
            problems.append(f"{label}: the sample offers answer choices; only a plain question is replayed")
        # The tool rewrites a data marker before it fills its template, and the importer does not copy that rewriting: it refuses the slot.
        parts = [question if isinstance(question, str) else "", target if isinstance(target, str) else "", content if isinstance(content, str) else ""]
        if any(DATA_MARKER.search(t) for t in parts):
            problems.append(f"{label}: the question, answer or criterion holds a data marker ([BEGIN DATA] or [END DATA]), which the tool rewrites before filling its template; the importer does not copy that rewriting")
    for (_kind, ident), group in by_id.items():
        if len(group) > 1:
            epochs = [getattr(g, "epoch", "?") for g in group]
            contents = {c if isinstance(c, str) else None for c in (_stored_content(getattr(g, "output", None)) for g in group)}
            problems.append(
                f"id {ident!r} occurs {len(group)} times (epochs {epochs}), with "
                + ("equal outputs" if len(contents) == 1 else "outputs that differ")
                + "; there must be exactly one stored output per case, and the script never picks one"
            )
    # The importer reads a case id as a string and refuses a log in which two ids are equal as strings and differ as
    # values. That refusal would come after the re-grade is paid for, so it is made here.
    by_text: dict[str, list[Any]] = {}
    for kind, ident in sorted(by_id, key=lambda k: (str(k[1]), k[0])):
        by_text.setdefault(str(ident), []).append(ident)
    for same in by_text.values():
        if len(same) > 1:
            problems.append(f"the ids {' and '.join(repr(i) for i in same)} are equal as strings and differ as values; the importer refuses such a log, since it reads a case id as a string")
    return problems


# JavaScript's String.prototype.trim: the white space the importer's reading skips (Python's strip() has another set).
JS_WHITE_SPACE = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
DATA_MARKER = re.compile(r"\[(?:begin|end) data\]", re.IGNORECASE)
TEMPLATE_TOKENS = ("question", "answer", "criterion", "instructions")
THINKING_BLOCKS = ("thinking", "redacted_thinking")


def strict_grade(reply: str) -> str | None:
    """The importer's strict reading of a reply (strictGrade in import.ts): its last non-empty line must be exactly `GRADE: ` and one capital letter."""
    for line in reversed(reply.split("\n")):
        if line.strip(JS_WHITE_SPACE) == "":
            continue
        m = re.fullmatch(r"GRADE: ([A-Z])", line)
        return m.group(1) if m else None
    return None


def importer_refusal(evidence: dict[str, Any]) -> str | None:
    """Why the importer will refuse the slot this record belongs to, or None: the importer's tests of a finished and readable grade."""
    stop = evidence.get("stopReason")
    if stop != "end_turn":
        return f'the judge stopped with "{stop}", not "end_turn"'
    types = evidence.get("contentTypes")
    if not (isinstance(types, list) and types and types[-1] == "text" and all(t in THINKING_BLOCKS for t in types[:-1])):
        return f"the reply holds content of type {json.dumps(types)}, not zero or more thinking blocks followed by exactly one text block"
    if strict_grade(evidence.get("reply", "")) is None:
        return 'the reply has no strict reading: its last non-empty line is not exactly "GRADE: " and one capital letter'
    return None


def template_problem(template: str) -> str | None:
    """The importer's single-pass template check (templateProblem in shared.ts): only the four plain tokens may be in braces."""
    rest = re.sub(r"\{(?:" + "|".join(TEMPLATE_TOKENS) + r")\}", "", template)
    if re.search(r"[{}]", rest):
        return "a brace that is not one of the four plain tokens {question}, {answer}, {criterion}, {instructions} (a doubled brace, a format specification, a conversion, an index, or another name)"
    return None


def one_line(text: str) -> str:
    """A text on one printable line: every character that is not visible ASCII or a space is written as an escape.

    This is the Python script's own escaper, and it is stricter than the library's `oneLine`: it escapes every non-ASCII
    character, which the library keeps, and it writes its escapes in Python's forms (ESC is `\\x1b` here and `\\u001b` there)."""
    return "".join(c if " " <= c <= "~" else c.encode("unicode_escape").decode("ascii") for c in text)


# A number as a flag states it: ASCII digits only, in the one plain spelling. Python's own readers take more (an
# underscore between digits, a sign, white space at the ends, the digits of other scripts, an exponent, inf and nan).
INTEGER_FORM = re.compile(r"0|[1-9][0-9]*")
DECIMAL_FORM = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?")
# The integers are held below 2^53, the bound the JavaScript scripts of this folder hold theirs to; it has 16 digits.
INTEGER_BOUND = 2**53


def positive_int_flag(flag: str, text: str) -> int:
    """A count: a positive integer in plain ASCII digits, below 2^53. Anything else raises Usage."""
    if INTEGER_FORM.fullmatch(text) is None or len(text) > 16 or not 1 <= int(text) < INTEGER_BOUND:
        raise Usage(f"{flag} must be a positive integer in plain ASCII digits (no sign, no leading zero, no underscore, no space, below 2^53), found {json.dumps(one_line(text))}")
    return int(text)


def decimal_flag(flag: str, text: str) -> float:
    """A plain decimal in ASCII digits, such as 0, 0.5 or 1. Whether it is in range is the grader's to say. Anything else raises Usage."""
    if DECIMAL_FORM.fullmatch(text) is None or len(text) > 32:
        raise Usage(f"{flag} must be a plain decimal number in ASCII digits, such as 0, 0.5 or 1 (no sign, no exponent, no underscore, no space), found {json.dumps(one_line(text))}")
    return float(text)


class SlotRefused(Exception):
    """Raised inside the grader's call when the slot just graded is one the importer will refuse and the re-grade is to stop."""


def missing_package(e: ModuleNotFoundError) -> int:
    """A package this script needs is not installed: one line on stderr that says what to install, and exit 64, never a traceback."""
    name = e.name or ""
    if name == "inspect_ai" or name.startswith("inspect_ai."):
        print(f"usage error: the Python module {e.name!r} is not installed. Install the tool version this importer was tested with: pip install inspect_ai=={TESTED_INSPECT_VERSION}", file=sys.stderr)
    else:
        print(f"usage error: the Python module {e.name!r} is not installed (it is a dependency of inspect_ai, or of the scripts beside this one). Install the tool version this importer was tested with, which brings its dependencies: pip install inspect_ai=={TESTED_INSPECT_VERSION}", file=sys.stderr)
    return EXIT_USAGE


def tool_version_problem() -> str | None:
    """The one inspect_ai version this importer was tested on. The importer refuses a log of any other version, and it refuses it
    after the re-grade has been paid for, so the version is checked here, before the first call and in a check too. Not installed
    is not answered here: the import that follows says so."""
    try:
        found = importlib.metadata.version("inspect_ai")
    except importlib.metadata.PackageNotFoundError:
        return None
    if found == TESTED_INSPECT_VERSION:
        return None
    return (
        f"usage error: inspect_ai {found} is installed, and this importer was tested on inspect_ai {TESTED_INSPECT_VERSION} only; "
        f"it refuses a log of any other version, after the re-grade is paid for. Install the tested one: pip install inspect_ai=={TESTED_INSPECT_VERSION}. "
        "Nothing was written and no call was made."
    )


def main(argv: list[str]) -> int:
    """The script: its exit code. An error it did not foresee is one line and the code of a refusal, never a traceback."""
    try:
        return _main(argv)
    except KeyboardInterrupt:
        # An interrupt (Ctrl-C) outside the eval, which has its own line: before it started, or after it returned.
        print("refused: regrade.py was interrupted. If the eval had started, slots may already have been sent and paid for, and a log in --out-dir is not importable.", file=sys.stderr)
        return EXIT_REFUSED
    except Exception as e:
        print(
            f"refused: regrade.py ended on an error it did not foresee ({type(e).__name__}): {one_line(str(e))}. "
            "If the eval had started, slots may already have been sent and paid for, and a log in --out-dir is not importable.",
            file=sys.stderr,
        )
        return EXIT_REFUSED


def _main(argv: list[str]) -> int:
    if sys.version_info < (3, 10):
        print(f"usage error: this script needs Python 3.10 or later (inspect_ai does); this is Python {sys.version_info[0]}.{sys.version_info[1]}", file=sys.stderr)
        return EXIT_USAGE
    # Every flag at most once, and by its whole name: a shortened flag is not taken for the flag it opens.
    p = _Parser(prog="regrade.py", add_help=True, allow_abbrev=False)
    p.add_argument("--log", required=True, action=_Once)
    # The four numbers are read as text and converted below, by this script's own forms: argparse's `type=int` and
    # `type=float` would take every spelling Python takes.
    p.add_argument("--epochs", required=True, action=_Once)
    p.add_argument("--check", action=_OnceSwitch)
    p.add_argument("--go-on-and-count", action=_OnceSwitch)
    p.add_argument("--template-file", action=_Once)
    p.add_argument("--instructions-file", action=_Once)
    p.add_argument("--judge-model", action=_Once)
    p.add_argument("--out-dir", action=_Once)
    p.add_argument("--base-url", action=_Once)
    p.add_argument("--max-tokens", action=_Once)
    p.add_argument("--temperature", action=_Once)
    p.add_argument("--timeout-ms", action=_Once)
    p.add_argument("--api-version", action=_Once)
    p.add_argument("--api-key-env", action=_Once)
    p.add_argument("--thinking", action=_Once)
    p.add_argument("--effort", action=_Once)
    p.add_argument("--max-reasks", action=_Once)
    try:
        a = p.parse_args(argv)
    except Usage as e:
        print(f"usage error: {e}", file=sys.stderr)
        return EXIT_USAGE
    try:
        epochs = positive_int_flag("--epochs", a.epochs)
        max_tokens = None if a.max_tokens is None else positive_int_flag("--max-tokens", a.max_tokens)
        timeout_ms = None if a.timeout_ms is None else positive_int_flag("--timeout-ms", a.timeout_ms)
        temperature = None if a.temperature is None else decimal_flag("--temperature", a.temperature)
    except Usage as e:
        print(f"usage error: {e}", file=sys.stderr)
        return EXIT_USAGE
    # A flag stated with an empty value is not the flag left out: the default is never put in its place. (`--thinking`,
    # `--effort`, `--max-reasks` and `--judge-model` have refusals of their own below.)
    for flag, value in (("--log", a.log), ("--template-file", a.template_file), ("--instructions-file", a.instructions_file), ("--out-dir", a.out_dir),
                        ("--base-url", a.base_url), ("--api-version", a.api_version), ("--api-key-env", a.api_key_env)):
        if value == "":
            print(f"usage error: {flag} was given an empty value; leave the flag out, or state a value", file=sys.stderr)
            return EXIT_USAGE
    run_only = {"--judge-model": a.judge_model, "--out-dir": a.out_dir, "--base-url": a.base_url, "--max-tokens": a.max_tokens,
                "--temperature": a.temperature, "--timeout-ms": a.timeout_ms, "--api-version": a.api_version, "--api-key-env": a.api_key_env,
                "--thinking": a.thinking, "--effort": a.effort, "--max-reasks": a.max_reasks, "--go-on-and-count": a.go_on_and_count or None}
    given = [k for k, v in run_only.items() if v is not None]
    if a.check and given:
        print(f"usage error: --check makes no call and takes none of {given}", file=sys.stderr)
        return EXIT_USAGE
    if not a.check:
        missing = [k for k in ("--judge-model", "--out-dir", "--max-tokens", "--thinking", "--effort", "--max-reasks", "--base-url") if run_only[k] is None]
        if missing:
            print(f"usage error: a run needs {missing}", file=sys.stderr)
            return EXIT_USAGE
        if a.judge_model == "" or any(c.isspace() for c in a.judge_model):
            print("usage error: --judge-model must be a name with no white space", file=sys.stderr)
            return EXIT_USAGE
        if not re.fullmatch(r"[0-3]", a.max_reasks, flags=re.ASCII):
            print("usage error: --max-reasks must be an integer from 0 to 3 (the re-asks one slot may be given; 0 asks every slot once)", file=sys.stderr)
            return EXIT_USAGE
        try:
            thinking = thinking_from_text(a.thinking)
        except ValueError as e:
            print(f"usage error: --thinking must be NOT_SENT or the JSON text of one object ({e})", file=sys.stderr)
            return EXIT_USAGE
        # A gateway the user's other tools honour: the grader never reads this variable, so unless the same address is stated
        # the key would go to the address stated here and not to the gateway. The variable is named; its value is never printed.
        # An empty variable is not set.
        gateway = os.environ.get("ANTHROPIC_BASE_URL")
        if gateway and a.base_url != gateway:
            how = "the base URL stated differs from it"
            print(f"usage error: the environment variable ANTHROPIC_BASE_URL is set, and this grader never reads it: {how}, and the key would go there instead of to the address your other tools use. State the same address with --base-url, or unset the variable. Nothing was written and no call was made.", file=sys.stderr)
            return EXIT_USAGE

    # the two texts, always text; refused before anything is built when the tool would read one as a resource
    try:
        template = read_text(os.path.join(HERE, "template.txt") if a.template_file is None else a.template_file)
        instructions = read_text(os.path.join(HERE, "instructions.txt") if a.instructions_file is None else a.instructions_file)
    except (OSError, UnicodeDecodeError) as e:
        print(f"refused: cannot read a text file ({type(e).__name__}): {e}", file=sys.stderr)
        return EXIT_REFUSED
    hazards = [h for h in (resource_hazard(template, "the template text"), resource_hazard(instructions, "the instructions text")) if h]
    if hazards:
        for h in hazards:
            print(f"refused: {h}", file=sys.stderr)
        return EXIT_REFUSED

    tp = template_problem(template)
    if tp is not None:
        print(f"refused: the template text holds {tp}; the importer renders the four tokens by plain substitution only", file=sys.stderr)
        return EXIT_REFUSED

    # Before the log is read and before anything is sent, in a check and in a run: a tool of another version.
    version_problem = tool_version_problem()
    if version_problem is not None:
        print(version_problem, file=sys.stderr)
        return EXIT_USAGE
    try:
        from inspect_ai.log import read_eval_log
    except ModuleNotFoundError as e:
        return missing_package(e)

    try:
        log = read_eval_log(a.log)
    except Exception as e:
        print(f"refused: the source log cannot be read ({type(e).__name__}): {e}", file=sys.stderr)
        return EXIT_REFUSED
    try:
        problems = source_problems(log)
    except Exception as e:
        print(f"refused: the source log cannot be checked ({type(e).__name__}): {one_line(str(e))}. Nothing was sent.", file=sys.stderr)
        return EXIT_REFUSED
    if problems:
        print(f"refused: the source log cannot be replayed ({len(problems)} problem(s)). Nothing was sent.", file=sys.stderr)
        for line in problems:
            print(f"  - {line}", file=sys.stderr)
        return EXIT_REFUSED
    samples = log.samples or []
    if a.check:
        print(f"check passed: {len(samples)} sample(s), one stored output each; {epochs} epoch(s) would be run. No request was made.")
        return 0

    # ----- a run -----
    try:
        from inspect_ai import Task, eval
        from inspect_ai.dataset import Sample
        from inspect_ai.model import GenerateConfig, ModelOutput, get_model
        from inspect_ai.scorer import model_graded_qa
        from inspect_ai.solver import Generate, TaskState, solver

        import recording_grader  # registers the provider "recording"; it calls nothing by itself
    except ModuleNotFoundError as e:
        return missing_package(e)

    key_env = recording_grader.DEFAULT_KEY_ENV if a.api_key_env is None else a.api_key_env
    if not recording_grader.KEY_ENV_NAME.fullmatch(key_env):
        print("usage error: --api-key-env must be the name of an environment variable (letters, digits and underscores)", file=sys.stderr)
        return EXIT_USAGE
    if not os.environ.get(key_env):
        print("usage error: the key variable named by --api-key-env (or the default) is not set", file=sys.stderr)
        return EXIT_USAGE
    # The grader checks the key's form at its first call, when the log directory would exist: it is checked here, before it does, and the key is not shown.
    if not recording_grader.KEY_FORM.fullmatch(os.environ[key_env]):
        print("usage error: the key in the variable named by --api-key-env (or the default) holds a character that is not visible ASCII (a space, a line feed, a control character or a character outside ASCII); nothing was written and no call was made", file=sys.stderr)
        return EXIT_USAGE

    # By the id as a string: the check above refused a log in which two ids are equal as strings.
    stored = {str(s.id): s.output.choices[0].message.content for s in samples}
    dataset = [Sample(id=s.id, input=s.input, target=s.target) for s in samples]

    @solver
    def replay_stored():
        async def solve(state: TaskState, generate: Generate) -> TaskState:
            state.output = ModelOutput.from_content("stored-outputs", stored[str(state.sample_id)])
            state.messages.append(state.output.message)
            return state

        return solve

    model_args: dict[str, Any] = {"thinking": thinking, "effort": a.effort, "max_reasks": int(a.max_reasks)}
    if timeout_ms is not None:
        model_args["timeout_ms"] = timeout_ms
    if a.api_version is not None:
        model_args["api_version"] = a.api_version
    if a.api_key_env is not None:
        model_args["api_key_env"] = a.api_key_env
    cfg: dict[str, Any] = {"max_tokens": max_tokens}
    if temperature is not None:
        cfg["temperature"] = temperature
    try:
        # not memoised: the tool would hand back a model built earlier in this process, and the wrapper below is this run's own
        grader = get_model(f"recording/{a.judge_model}", config=GenerateConfig(**cfg), base_url=a.base_url, memoize=False, **model_args)
    except Exception as e:
        # A setting the grader refuses is a mistake in the flags, as in the re-grade script of skill-evals: a usage error.
        print(f"usage error: the grader refused its settings ({type(e).__name__}): {one_line(str(e))}. Nothing was written and no call was made.", file=sys.stderr)
        return EXIT_USAGE
    # The re-grade stops at the first slot the importer will refuse (or, with --go-on-and-count, counts them): the grader's call is
    # looked at once it has returned, by the importer's own tests of a finished and readable grade. A call that raises instead of
    # returning is a lost slot, and it stops the re-grade whatever the flag says. The wrapper changes nothing the
    # grader sends or records; it raises to end the eval (fail_on_error=True) or lists the slot.
    refusable: list[str] = []
    stopped: list[str] = []
    lost: list[str] = []
    calls: list[None] = []
    graded_api = grader.api
    graded_generate = graded_api.generate

    # One slot at a time. The grader waits between two asks of a slot that got no reply, and the tool starts the other samples'
    # grader calls during that wait; without the lock they would all pass the test of `stopped` before the first one raises, and
    # be paid for. The lock is held for a slot's whole call, its re-asks and their waits included, so a second slot enters only
    # after the first has returned or raised.
    one_slot_at_a_time = asyncio.Lock()

    async def guarded_generate(*args: Any, **kwargs: Any) -> Any:
        async with one_slot_at_a_time:
            # Control goes back to the tool for a moment before the slot is called. An ask blocks until its reply, so an
            # interrupt (Ctrl-C) that arrives during one reaches the tool only afterwards; without this pause the slot that was
            # waiting for the lock is called, and paid for, before the tool has cancelled it, and so is every later one
            # (seen with inspect_ai 0.3.275: every slot of a run was called after one interrupt). The pause is a wait by the
            # clock, so it is no guarantee: the line printed after an interrupt counts the slots that were called.
            await asyncio.sleep(INTERRUPT_PAUSE_S)
            return await guarded_one(*args, **kwargs)

    async def guarded_one(*args: Any, **kwargs: Any) -> Any:
        # The tool has the other samples waiting for the grader when this run stops: once it has, no further call is made.
        if stopped:
            raise SlotRefused(f"not called: the re-grade stopped at {stopped[0]}")
        calls.append(None)
        number = len(calls)
        try:
            output = await graded_generate(*args, **kwargs)
        except BaseException as e:
            # A lost slot: the call raised (no reply within the bound of re-asks, a status that is not asked again, a response the
            # grader refuses). The tool writes no grade for it, the importer will refuse the log, and no later slot is paid for,
            # with --go-on-and-count too: that flag counts the slots that have a record, and a lost slot has none.
            if not stopped:
                lost.append(f"call number {number} of this run ({type(e).__name__}): {one_line(str(e))}")
                stopped.append(lost[0])
            raise
        evidence = (output.metadata or {}).get("graderEvidence", {})
        why = importer_refusal(evidence)
        if why is not None:
            label = f"the grader's call number {evidence.get('callSeq')}"
            refusable.append(label)
            if not a.go_on_and_count:
                stopped.append(f"{label}: {why}")
                raise SlotRefused(f"{label}: {why}")
        return output

    graded_api.generate = guarded_generate  # type: ignore[method-assign]
    scorer = model_graded_qa(template=template, instructions=instructions, model=grader)
    task = Task(name="regrade", dataset=dataset, solver=replay_stored(), scorer=scorer)
    try:
        os.makedirs(a.out_dir, exist_ok=True)
    except OSError as e:
        print(f"usage error: --out-dir cannot be made ({type(e).__name__}: {one_line(str(e))}); nothing was written and no call was made", file=sys.stderr)
        return EXIT_USAGE
    # A directory that was there already is not made, so nothing above has shown that the log can be written into it. Checked
    # here, before the eval is started: the tool would refuse it itself, as an eval that failed, when no call has been made.
    if not os.path.isdir(a.out_dir) or not os.access(a.out_dir, os.W_OK | os.X_OK):
        print("usage error: --out-dir cannot be written to (it must be a directory this user can write to and enter); nothing was written and no call was made", file=sys.stderr)
        return EXIT_USAGE
    def interrupted(how: str) -> str:
        # A slot whose call was under way when the interrupt came has no record anywhere: its request may have reached the endpoint all the same.
        return (
            f"refused: the eval was interrupted {how}. {len(calls)} slot(s) had been called by then: those that had returned were sent and are paid for, "
            "and the asks of a slot that was interrupted are in no record and may be billed. If --out-dir holds a log, it is not importable."
        )

    # No cache argument is passed, because the tool's eval takes none: its response cache is asked for by a generate call or by a
    # `cache` generation setting. The scorer's call asks for none, and the grader refuses a `cache` setting when it is built.
    try:
        logs = eval(
            task,
            model="mockllm/unused-system",
            log_dir=a.out_dir,
            log_format="json",
            epochs=epochs,
            fail_on_error=True,
            display="none",
        )
        if not logs:
            # The tool's answer to an interrupt (Ctrl-C): no log is returned.
            print(interrupted("and returned no log"), file=sys.stderr)
            return EXIT_REFUSED
        status = logs[0].status
        location = logs[0].location
        failure = getattr(getattr(logs[0], "error", None), "message", None)
    except (KeyboardInterrupt, asyncio.CancelledError):
        # A second interrupt, or one the tool hands on: raised out of the eval. Neither is an Exception, and the tool's own
        # hook would end the process on it with no line at all.
        print(interrupted("before it returned"), file=sys.stderr)
        return EXIT_REFUSED
    except Exception as e:
        print(
            f"refused: the eval ended with an error ({type(e).__name__}): {one_line(str(e))}. {len(calls)} slot(s) had been called by then: "
            "they may already have been sent and paid for. If --out-dir holds a log, it is not importable.",
            file=sys.stderr,
        )
        return EXIT_REFUSED
    print(f"status: {status}")
    print(f"log: {location}")
    if lost:
        print(f"REFUSED the re-grade stopped at the first slot whose call failed: {lost[0]}. No later slot was called, with or without --go-on-and-count; the log is kept and is not importable. The slots called before it were sent and are paid for, and so may this slot's own asks be.", file=sys.stderr)
        return EXIT_REFUSED
    if stopped:
        print(f"REFUSED the re-grade stopped at the first slot the importer will refuse: {stopped[0]}. No later slot was called; the log is kept and is not importable. The slots called up to it were sent and are paid for. --go-on-and-count goes on instead and counts the slots the importer will refuse.", file=sys.stderr)
        return EXIT_REFUSED
    if status == "success":
        shown = ", ".join(refusable[:20]) + (f", and {len(refusable) - 20} more" if len(refusable) > 20 else "")
        print(f"slots the importer will refuse: {len(refusable)}" + (f" (the importer will refuse this log: {shown})" if refusable else ""))
        return 0
    why = "" if not isinstance(failure, str) or failure == "" else f": {one_line(failure)}"
    print(f"refused: the eval did not succeed (status {one_line(str(status))}){why}. {len(calls)} slot(s) had been called: they may already have been sent and paid for. The log is kept and is not importable.", file=sys.stderr)
    return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
