# Re-grade the stored outputs of an Inspect log through the recording grader (anchorset importer example).
#
#   python regrade.py --log <system log> --epochs <N> --check
#   python regrade.py --log <system log> --epochs <N> --wire <anthropic-messages/v1 | openai-responses/v1>
#                     --judge-model <name> --max-tokens <n> --out-dir <dir> --effort <NOT_SENT | a word of the wire>
#                     --max-reasks <0 | 1 | 2 | 3> --base-url <url>
#                     [--template-file <file>] [--instructions-file <file>]
#                     [--temperature <x>] [--timeout-ms <n>] [--api-key-env <NAME>] [--go-on-and-count]
#                  and, by wire:
#                     anthropic-messages/v1:  --thinking <NOT_SENT | JSON object>  [--api-version <v>]
#                     openai-responses/v1:    --verbosity <NOT_SENT | low | medium | high>
#
# It runs ONE eval. The solver replays each sample's stored output and calls no model; the scorer is
# model_graded_qa(template=<text>, instructions=<text>, model=<the recording grader>), with epochs=N, the log in the
# JSON format and fail_on_error=True. No response cache is used: this script sets none, the scorer asks for none, and
# the grader refuses a cache setting. The template and the instructions are always passed as
# text, never as a path. Without a file flag the script passes the two default texts beside it.
# The system log itself need not come from a tested version of the tool: it is read for its stored answers only. The script
# refuses it, before any call, when it does not state how many answers it holds (`results.total_samples`, the dataset's samples
# times the epochs) or when the number it reads differs. Its sha256 and the version it states are written into the graded log,
# under `/eval/metadata/anchorset_system_log`, as a recorded claim: nothing compares them and no check rests on them.
# Every flag is taken at most once and by its whole name, and a flag stated with an empty value is a usage error: the
# script never picks between two stated settings and never puts a default in place of a stated one.
# A number is taken only in its plain form, in ASCII digits: `--epochs`, `--max-tokens` and `--timeout-ms` as a positive
# integer with no sign, no leading zero, no underscore and no space; `--temperature` as a plain decimal such as 0, 0.5 or
# 1, with no sign and no exponent. Any other spelling is a usage error, never a number Python would make of it.
# `--wire` has no default and a run needs it: it says how the request is built and how the reply is read, and it selects the
# set of flags the run needs. A flag of the other wire is a usage error (64): `--thinking` and `--api-version` belong to the
# Anthropic wire, `--verbosity` to the OpenAI wire. `--max-tokens` keeps its name on both wires and is sent as the wire's
# output cap (`max_output_tokens` on the OpenAI wire, which takes no less than 16). The gateway variable that is checked is
# ANTHROPIC_BASE_URL on the first wire and each of OPENAI_BASE_URL, OPENAI_API_BASE_URL, OPENAI_API_HOST and OPENAI_HOST on the
# second; the key is read from ANTHROPIC_API_KEY or OPENAI_API_KEY unless `--api-key-env` names another variable. `--check` takes
# no wire: it makes no call and reads the source log only.
# `--thinking` (Anthropic), `--verbosity` (OpenAI) and `--effort` have no default and a run needs them: NOT_SENT sends nothing; otherwise
# `--thinking` is the JSON text of one of the four request objects ({"type":"adaptive"}, {"type":"between_tools"},
# {"type":"disabled"}, {"type":"enabled","budget_tokens":<n>}) and `--effort` is one word. The grader refuses every other form before any call.
# `--max-reasks` has no default either: it is the bound of re-asks one slot may be given, 0 to 3; 0 asks every slot once.
# The grader asks a slot again, inside its one call for that slot, only after an ask that got no reply (a passed
# deadline, a failed connection, a status 5xx, a status 429) or a reply cut at the output cap, and never after a finished
# reply. This script passes no retry option to the tool and keeps fail_on_error=True. It lets the grader work on one slot
# at a time: a slot's call, its re-asks and the waits between them included, has returned or raised before the next begins.
# `--base-url` has no default either: the endpoint decides where the key goes, so it is stated, never inherited from the
# grader's default host.
#
# The re-grade stops at the first slot the importer will refuse: a last ask that did not stop with "end_turn" (on the OpenAI wire
# "completed"), a refusal part, content that is not zero or more thinking blocks (reasoning items) and one text block (one completed
# message with one output_text part), or a reply whose last non-empty line is not exactly "GRADE: " and
# one capital letter (the importer's own tests of a finished and readable grade, in the importer's order: the stop comes before the content). The slot's grade is then not written to the
# log and no later slot is paid for; the exit is 2. `--go-on-and-count` goes on instead, counts such slots and prints
# `slots the importer will refuse: <k>`. A label that differs from the tool's own reading is found only at import.
# A lost slot ends the re-grade as well, and `--go-on-and-count` does not change that: when the grader's call raises (no reply
# within the bound of re-asks, a status that is not asked again, a served model id or a response id of a form the grader
# refuses), the slot has no record to count, no later slot is called, and the exit is 2.
#
# Exit codes: 0 done; 2 refused; 64 usage.
#   64  the flags, the key, the tool's version, the list of tested versions or a missing package, a setting the grader refuses, an --out-dir that
#       cannot be made or cannot be written to. Nothing was sent.
#   2   before the eval: a text file or a source log that cannot be read or replayed, or that does not state how many answers
#       it holds or holds another number. Nothing was sent.
#   2   during the eval: a slot whose call failed, a slot the importer will refuse, an eval that did not succeed,
#       that raised or that was interrupted (Ctrl-C). The slots called before that point were sent and are paid for;
#       the log, when there is one, is kept and is not importable. The asks of a slot that was interrupted are in no
#       record, and may be billed.
# An error the script did not foresee is exit 2 too, on one line. It never ends in a traceback of its own.
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import re
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
TESTED_VERSIONS_FILE = os.path.join(os.path.dirname(HERE), "tested-versions.json")
TESTED_VERSIONS_SCHEMA = "example.tested-versions/v1"
TESTED_ENTRY_KEYS = {"version", "testedOn", "fixtures", "badFixtures", "runtimes", "gradingPathRead"}
SYSTEM_LOG_MARKER = "anchorset_system_log"
GAP = "UNKNOWN"
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


def count_problems(log: Any, read: int) -> list[str]:
    """The log must state how many answers it holds, and the number read must be that number. The count is
    `results.total_samples`: the dataset's samples times the epochs, one per sample entry of the log. The tool fills an unstated
    field with 0 when it reads the log, so what the file stated is told from what the tool filled in by the fields set. Where the log
    also states `completed_samples`, that too must be the number read: an answer that did not complete is not a stored output."""
    results = getattr(log, "results", None)
    stated = getattr(results, "model_fields_set", None) or set()
    if "total_samples" not in stated:
        return ["the log does not state how many answers it holds (results.total_samples)"]
    problems: list[str] = []
    if results.total_samples != read:
        problems.append(f"the log states {results.total_samples} answers (results.total_samples) and {read} were read")
    if "completed_samples" in stated and results.completed_samples != read:
        problems.append(f"the log states {results.completed_samples} completed answers (results.completed_samples) and {read} were read")
    return problems


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
    problems.extend(count_problems(log, len(samples)))
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
# The four variables the OpenAI wire's gateway check looks at (recording_grader.OPENAI_ADDRESS_VARIABLES; a test compares them).
OPENAI_ADDRESS_VARIABLES = ("OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_HOST", "OPENAI_HOST")
THINKING_BLOCKS = ("thinking", "redacted_thinking")
WIRE_ANTHROPIC = "anthropic-messages/v1"
WIRE_OPENAI = "openai-responses/v1"
WIRES = (WIRE_ANTHROPIC, WIRE_OPENAI)
# The importer's stop and content tables (shared.ts: STOP_MAP, OPENAI_INCOMPLETE_MAP, OPENAI_REASONING, OPENAI_ANSWER, OPENAI_ANSWER_FINAL; a test compares them):
# the one stop of each wire that finishes a reply, what an "incomplete" OpenAI reply maps to by its reason, and the labels of a reasoning item
# and of the two readable answers (a completed message with no phase, and the same with phase exactly final_answer). Every other word has no mapping.
STOP_MAP = {WIRE_ANTHROPIC: {"end_turn": "end"}, WIRE_OPENAI: {"completed": "end"}}
OPENAI_INCOMPLETE_MAP = {"max_output_tokens": "cut", "content_filter": "content-filter"}
OPENAI_REASONING = "reasoning"
OPENAI_ANSWER = "message/output_text"
OPENAI_ANSWER_FINAL = "message[phase=final_answer]/output_text"


def strict_grade(reply: str) -> str | None:
    """The importer's strict reading of a reply (strictGrade in import.ts): its last non-empty line must be exactly `GRADE: ` and one capital letter."""
    for line in reversed(reply.split("\n")):
        if line.strip(JS_WHITE_SPACE) == "":
            continue
        m = re.fullmatch(r"GRADE: ([A-Z])", line)
        return m.group(1) if m else None
    return None


def judge_stop_of(wire: str, stop_reason: Any, incomplete_reason: Any = None) -> str | None:
    """The library's judge stop for a recorded stop, or None when it is not one a finished reply has (judgeStopOf in shared.ts):
    "end" for the one finishing stop of the wire, "content-filter" for an OpenAI "incomplete" with the reason content_filter."""
    table = STOP_MAP.get(wire, {})
    if isinstance(stop_reason, str) and stop_reason in table:
        return table[stop_reason]
    if wire == WIRE_OPENAI and stop_reason == "incomplete" and isinstance(incomplete_reason, str) and OPENAI_INCOMPLETE_MAP.get(incomplete_reason) == "content-filter":
        return "content-filter"
    return None


def content_is_readable(wire: str, types: list[str]) -> bool:
    """Zero or more thinking blocks (reasoning items) and then exactly one text block (one `message/output_text`), last (contentIsReadable
    in shared.ts). An empty list is never readable."""
    if not types:
        return False
    if wire == WIRE_OPENAI:
        return types[-1] in (OPENAI_ANSWER, OPENAI_ANSWER_FINAL) and all(t == OPENAI_REASONING for t in types[:-1])
    return types[-1] == "text" and all(t in THINKING_BLOCKS for t in types[:-1])


def importer_refusal(evidence: dict[str, Any]) -> str | None:
    """Why the importer will refuse the slot this record belongs to, or None: the importer's tests of a finished and readable grade, in
    its order. The stop comes first, then a refusal part, then the shape of the content, and the reply's text last: an "incomplete" OpenAI
    response whose message is completed carries the readable-looking label `message/output_text`, so a content check first would read a cut
    or filtered reply as a finished one."""
    wire = evidence.get("wire")
    if wire not in WIRES:
        return f"the record names the wire {json.dumps(wire)[:60]}, not one of {', '.join(WIRES)}"
    openai = wire == WIRE_OPENAI
    stop = evidence.get("stopReason")
    incomplete = evidence.get("incompleteReason") if openai else None
    if judge_stop_of(wire, stop, incomplete) != "end":
        if openai:
            return f'the judge stopped with status "{stop}"' + (f" ({incomplete})" if stop == "incomplete" else "") + ', not "completed"'
        return f'the judge stopped with "{stop}", not "end_turn"'
    types = evidence.get("contentTypes")
    if not (isinstance(types, list) and all(isinstance(t, str) for t in types)):
        return f"the reply holds content of type {json.dumps(types)}, which is not a list of types"
    if openai and any(t.endswith("/refusal") for t in types):
        return f"the response holds a refusal part (content types {json.dumps(types)}); a refusal is never graded, whatever text stands beside it"
    if not content_is_readable(wire, types):
        if openai:
            return f"the reply holds content of type {json.dumps(types)}, not zero or more reasoning items followed by exactly one completed message with one output_text part"
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


class TestedVersionsProblem(Exception):
    """The list of tested versions cannot be read or is malformed. The script refuses: it never guesses what was tested."""


# The list is a short file: all three readers refuse one over this many bytes.
TESTED_VERSIONS_MAX_BYTES = 1024 * 1024


def is_calendar_date(s: str) -> bool:
    """A real calendar date, written YYYY-MM-DD, in the years 0001 to 9999. The same arithmetic stands in the two other readers."""
    m = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", s, flags=re.ASCII)
    if m is None:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    return y >= 1 and 1 <= mo <= 12 and 1 <= d <= [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]


def tested_inspect_versions() -> list[str]:
    """The inspect_ai versions in the one list of tested versions, oldest first. Anything malformed, for either tool, raises."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        keys = [k for k, _ in items]
        if len(set(keys)) != len(keys):
            raise ValueError("a key is given twice")
        return dict(items)

    try:
        with open(TESTED_VERSIONS_FILE, "rb") as f:
            data = f.read(TESTED_VERSIONS_MAX_BYTES + 1)
        if len(data) > TESTED_VERSIONS_MAX_BYTES:
            raise ValueError("over the limit")
        root = json.loads(data.decode("utf-8"), object_pairs_hook=pairs)
    except (OSError, ValueError, RecursionError) as e:
        raise TestedVersionsProblem(f"cannot be read ({type(e).__name__})") from None
    if not isinstance(root, dict) or set(root) != {"schema", "tools"}:
        raise TestedVersionsProblem("must be an object with exactly the keys schema and tools")
    if root["schema"] != TESTED_VERSIONS_SCHEMA:
        raise TestedVersionsProblem(f"schema must be {TESTED_VERSIONS_SCHEMA}")
    tools = root["tools"]
    if not isinstance(tools, dict) or set(tools) != {"inspect_ai", "promptfoo"}:
        raise TestedVersionsProblem("tools must hold exactly inspect_ai and promptfoo")
    found: dict[str, list[str]] = {}
    for name, tool in tools.items():
        if not isinstance(tool, dict) or set(tool) != {"format", "versions"}:
            raise TestedVersionsProblem(f"{name} must hold exactly format and versions")
        if not isinstance(tool["format"], int) or isinstance(tool["format"], bool) or not 1 <= tool["format"] <= 2**53 - 1:
            raise TestedVersionsProblem(f"{name}.format must be a positive integer")
        entries = tool["versions"]
        if not isinstance(entries, list) or not entries:
            raise TestedVersionsProblem(f"{name}.versions must be a non-empty list")
        for i, entry in enumerate(entries):
            at = f"{name}.versions[{i}]"
            if not isinstance(entry, dict) or set(entry) != TESTED_ENTRY_KEYS:
                raise TestedVersionsProblem(f"{at} must hold exactly {', '.join(sorted(TESTED_ENTRY_KEYS))}")
            if not all(isinstance(entry[k], str) and entry[k].strip(JS_WHITE_SPACE) != "" and not any(0xD800 <= ord(c) <= 0xDFFF for c in entry[k]) for k in TESTED_ENTRY_KEYS):
                raise TestedVersionsProblem(f"{at}: every value must be a non-empty, well-formed string")
            if re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]*", entry["version"], flags=re.ASCII) is None:
                raise TestedVersionsProblem(f"{at}.version is not a version")
            if not is_calendar_date(entry["testedOn"]):
                raise TestedVersionsProblem(f"{at}.testedOn must be a real date, YYYY-MM-DD")
        versions = [e["version"] for e in entries]
        if len(set(versions)) != len(versions):
            raise TestedVersionsProblem(f"{name}.versions lists a version twice")
        found[name] = versions
    return found["inspect_ai"]


def tested_versions_refusal(e: TestedVersionsProblem) -> int:
    print(f"usage error: examples/importers/tested-versions.json {one_line(str(e))}. Nothing was written and no call was made.", file=sys.stderr)
    return EXIT_USAGE


def missing_package(e: ModuleNotFoundError) -> int:
    """A package this script needs is not installed: one line on stderr that says what to install, and exit 64, never a traceback."""
    name = e.name or ""
    try:
        newest = tested_inspect_versions()[-1]
    except TestedVersionsProblem as problem:
        return tested_versions_refusal(problem)
    if name == "inspect_ai" or name.startswith("inspect_ai."):
        print(f"usage error: the Python module {e.name!r} is not installed. Install a tool version this importer was tested with: pip install inspect_ai=={newest}", file=sys.stderr)
    else:
        print(f"usage error: the Python module {e.name!r} is not installed (it is a dependency of inspect_ai, or of the scripts beside this one). Install a tool version this importer was tested with, which brings its dependencies: pip install inspect_ai=={newest}", file=sys.stderr)
    return EXIT_USAGE


def tool_version_problem(tested: list[str]) -> str | None:
    """The inspect_ai versions this importer was tested on. The importer refuses a graded log of any other version, and it refuses it
    after the re-grade has been paid for, so the installed tool is checked here, before the first call and in a check too. Not installed
    is not answered here: the import that follows says so."""
    try:
        found = importlib.metadata.version("inspect_ai")
    except importlib.metadata.PackageNotFoundError:
        return None
    if found in tested:
        return None
    return (
        f"usage error: inspect_ai {one_line(found)} is installed, and this importer was tested on inspect_ai {', '.join(tested)}.\n"
        "Your system's log need not come from a tested version: it is read for its stored answers, and the run records its\n"
        "sha256 and the version it states. A log the tested tool cannot read is refused; one it misreads may not be detected. Grade from a separate environment:\n"
        f"python -m venv .anchorset-grade && .anchorset-grade/bin/pip install inspect_ai=={tested[-1]}\n"
        "Nothing was written and no call was made."
    )


# The spellings of a gap: the library's `readsAsGap`, on the same characters.
GAP_SPELLINGS = {"unknown", "na", "none", "null", "nil", "undefined", "notsent"}


def recorded_version(value: Any) -> str:
    """The version a system log states, as the run may record it, or `UNKNOWN`: when none is stated, when it is not text of visible
    ASCII (a space, a line feed, a control character or a character outside ASCII counts as unprintable), when it holds `;` or `,`
    (it stands in a line that uses both), or when it spells a gap. It is never repaired and never copied in part."""
    if not isinstance(value, str) or re.fullmatch(r"[\x21-\x7e]+", value) is None or ";" in value or "," in value:
        return GAP
    return GAP if re.sub(r"[-_ ./]", "", value.lower()) in GAP_SPELLINGS else value


def system_log_record(path: str, log: Any) -> dict[str, str]:
    """What the run records of the system log: its sha256 and the version it states. A recorded claim: nothing compares it."""
    with open(path, "rb") as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()
    packages = getattr(getattr(log, "eval", None), "packages", None)
    stated = packages.get("inspect_ai") if isinstance(packages, dict) else None
    return {"sha256": sha256, "tool": "inspect_ai", "version": recorded_version(stated)}


def system_log_line(record: dict[str, str]) -> str:
    stated = GAP if record["version"] == GAP else f"inspect_ai {record['version']}"
    return f"system log: sha256 {record['sha256']}, stated version {stated} (recorded, not required)"


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
    p.add_argument("--wire", action=_Once)
    p.add_argument("--verbosity", action=_Once)
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
                        ("--base-url", a.base_url), ("--api-version", a.api_version), ("--api-key-env", a.api_key_env), ("--wire", a.wire)):
        if value == "":
            print(f"usage error: {flag} was given an empty value; leave the flag out, or state a value", file=sys.stderr)
            return EXIT_USAGE
    run_only = {"--judge-model": a.judge_model, "--out-dir": a.out_dir, "--base-url": a.base_url, "--max-tokens": a.max_tokens,
                "--temperature": a.temperature, "--timeout-ms": a.timeout_ms, "--api-version": a.api_version, "--api-key-env": a.api_key_env,
                "--wire": a.wire, "--verbosity": a.verbosity,
                "--thinking": a.thinking, "--effort": a.effort, "--max-reasks": a.max_reasks, "--go-on-and-count": a.go_on_and_count or None}
    given = [k for k, v in run_only.items() if v is not None]
    if a.check and given:
        print(f"usage error: --check makes no call and takes none of {given}", file=sys.stderr)
        return EXIT_USAGE
    if not a.check:
        # `--wire` selects the flags a run needs, so it is looked at first: a missing or unknown wire is a usage error.
        if a.wire is None:
            print(f"usage error: a run needs ['--wire']: one of {', '.join(WIRES)} (no default); it selects the other flags a run needs", file=sys.stderr)
            return EXIT_USAGE
        if a.wire not in WIRES:
            print(f"usage error: --wire must be one of {', '.join(WIRES)}, found {json.dumps(one_line(a.wire)[:60])}", file=sys.stderr)
            return EXIT_USAGE
        openai = a.wire == WIRE_OPENAI
        # A flag of the other wire is not taken and not ignored: the run would otherwise state a setting the wire does not send.
        for flag, value, belongs in (("--thinking", a.thinking, WIRE_ANTHROPIC), ("--api-version", a.api_version, WIRE_ANTHROPIC), ("--verbosity", a.verbosity, WIRE_OPENAI)):
            if value is not None and belongs != a.wire:
                print(f"usage error: {flag} is a flag of the {belongs} wire only; the wire stated is {a.wire}", file=sys.stderr)
                return EXIT_USAGE
        own = "--verbosity" if openai else "--thinking"
        missing = [k for k in ("--judge-model", "--out-dir", "--max-tokens", own, "--effort", "--max-reasks", "--base-url") if run_only[k] is None]
        if missing:
            print(f"usage error: a run needs {missing}", file=sys.stderr)
            return EXIT_USAGE
        if a.judge_model == "" or any(c.isspace() for c in a.judge_model):
            print("usage error: --judge-model must be a name with no white space", file=sys.stderr)
            return EXIT_USAGE
        if not re.fullmatch(r"[0-3]", a.max_reasks, flags=re.ASCII):
            print("usage error: --max-reasks must be an integer from 0 to 3 (the re-asks one slot may be given; 0 asks every slot once)", file=sys.stderr)
            return EXIT_USAGE
        thinking: Any = None
        if not openai:
            try:
                thinking = thinking_from_text(a.thinking)
            except ValueError as e:
                print(f"usage error: --thinking must be NOT_SENT or the JSON text of one object ({e})", file=sys.stderr)
                return EXIT_USAGE
        # A gateway the user's other tools honour: the grader never reads this variable, so unless the same address is stated
        # the key would go to the address stated here and not to the gateway. The variable is named; its value is never printed.
        # An empty variable is not set. The wire says which variables are looked at: one for Anthropic, four for OpenAI.
        for name in OPENAI_ADDRESS_VARIABLES if openai else ("ANTHROPIC_BASE_URL",):
            gateway = os.environ.get(name)
            if gateway and a.base_url != gateway:
                how = "the base URL stated differs from it"
                # A bare host can never equal a base URL, so for the two HOST variables the one remedy is to unset the variable.
                hint = "Unset the variable." if name.endswith("_HOST") else "State the same address with --base-url, or unset the variable."
                print(f"usage error: the environment variable {name} is set, and this grader never reads it: {how}, and the key would go there instead of to the address your other tools use. {hint} Nothing was written and no call was made.", file=sys.stderr)
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
    try:
        tested = tested_inspect_versions()
    except TestedVersionsProblem as e:
        return tested_versions_refusal(e)
    version_problem = tool_version_problem(tested)
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
    try:
        system_log = system_log_record(a.log, log)
    except OSError as e:
        print(f"refused: the source log cannot be read for its sha256 ({type(e).__name__}): {one_line(str(e))}. Nothing was sent.", file=sys.stderr)
        return EXIT_REFUSED
    if a.check:
        print(system_log_line(system_log))
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

    key_env = (recording_grader.DEFAULT_OPENAI_KEY_ENV if a.wire == WIRE_OPENAI else recording_grader.DEFAULT_KEY_ENV) if a.api_key_env is None else a.api_key_env
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

    model_args: dict[str, Any] = {"wire": a.wire, "effort": a.effort, "max_reasks": int(a.max_reasks)}
    if a.wire == WIRE_OPENAI:
        model_args["verbosity"] = a.verbosity
    else:
        model_args["thinking"] = thinking
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
    task = Task(name="regrade", dataset=dataset, solver=replay_stored(), scorer=scorer, metadata={SYSTEM_LOG_MARKER: system_log})
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
