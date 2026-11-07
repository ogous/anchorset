# The recording grader for inspect_ai (anchorset importer example).
#
# It is an inspect_ai model provider, registered as "recording". It makes the judge's call itself: one blocking HTTP
# request per ask, no redirect, one deadline per ask
# from the moment a socket exists (each connection attempt and the handshake run under a per-operation timeout; a name
# lookup is not interrupted, and a deadline that passed during one is seen when it returns). It returns
# the reply with a record of the slot (schema example.grader-evidence/v8) in
# ModelOutput.metadata and in the assistant message's metadata. The record is the grader's own declaration of what
# it sent and what came back; it is not independent evidence.
#
# THE WIRE. The model argument `wire` is required and has no default. It is one of two names:
#   anthropic-messages/v1   Anthropic's Messages API:  POST <base>/v1/messages
#   openai-responses/v1     OpenAI's Responses API:    POST <base>/responses
# A wire name versions two things together: how the request is built and how the reply is taken from the response. The
# settings, the request, the checks of a 200 body, the record's keys and the gateway variable are each fixed by the
# wire (the JavaScript grader, promptfoo/grader-provider.cjs, holds the same rules, and a test compares the records the
# two write over the same exchanges); a setting of the other wire is refused when the grader is built, before any call.
# The Anthropic record is the version 7 record plus `schema` v8 and `wire`. The output cap is the generation setting
# `max_tokens` on both wires (the tool's own name for it); it is sent as `max_tokens` on the first and as
# `max_output_tokens` on the second, where it is an integer of at least 16. Both caps are integers below 2^53.
# The OpenAI request always sends `store: false` and `truncation: "disabled"`; neither is a setting, and both are
# recorded (`sent.store`, `sent.truncation`). This grader hands the tool one user message and no system text, so the
# OpenAI request holds no `instructions`. A 200 body is held to these checks, in this order, before any text is joined: it
# is a JSON object whose `object` is "response"; `error` is absent or null; `status` is "completed" or "incomplete";
# `incomplete_details` is absent or null with "completed" and an object with a printable `reason` with "incomplete"; an
# echoed `truncation` is "disabled" and an echoed `store` is false; `id`, `model` and `usage` follow the form rules below;
# `output` is a list of items that each have a plain `type`. Anything else is a malformed body: the slot ends with no
# record and is never asked again. The reply is the text of the `output_text` parts of the `message` items, joined; a
# reasoning item is never read. The record lists the output items in `contentTypes`: a reasoning item as "reasoning", a
# message item's parts as "message/<part type>" when the item's status is "completed" and it holds no `phase`, otherwise as
# "message[status=<s>]/<part type>" or "message[phase=<p>]/<part type>" (the label is written as it is; the importers read
# a completed message with `phase` absent or exactly "final_answer", and any other phase stays unreadable). Whether a reply is read at all is the importer's
# rule, never the grader's: this file reads no verdict. An `output` list may be empty on this wire (a "completed" reply
# with it is unreadable at import, and an "incomplete" one with the reason "max_output_tokens" is a cut); on the other
# wire an empty `content` list is a malformed body.
#
# One call of the tool is one slot. A slot is asked once, and asked again, at most `max_reasks` times (a stated model
# argument, 0 to 3, no default), only when an ask ended in one of five things the grader sees without reading the
# reply's text: the deadline passed, the connection failed, a status 5xx, a status 429, or a status 200 that is a cut
# (on the Anthropic wire a stop_reason of exactly "max_tokens"; on the OpenAI wire a status of "incomplete" with the
# reason "max_output_tokens", and no other reason). Every ask of a slot sends the same bytes. A finished reply is never asked
# again, whatever it says (on the OpenAI wire an "incomplete" reply of any other reason is recorded, not asked again);
# nor is any other 4xx, a redirect, a malformed body or a response in a content encoding. A
# status other than 200 is judged by the status alone: its body is never read.
#
# An ask is in the record only when its slot ends with a record: the record then holds every ask of the slot. A slot
# ends without one when the bound is used up with no reply, or when an ask ends in something that is never asked
# again. The call then raises, and Inspect keeps no record of a call that raises. If the slot made more than one
# ask, the error's text lists them (call number, call id, what each ended in), and that text is the only place they
# are. A slot that ends on its first ask raises that failure as it came, and with a bound of 0 every slot has one ask.
# Inspect's own cancellation is raised as it came too, with no list.
#
# The text of a cut reply that is asked again is not recorded; its sha256 and the number of its UTF-8 bytes are. A cut
# reply that ends the slot, because the bound is used up, is the slot's last ask and is recorded whole.
#
# `promptSha256` in the record is the sha256 of the prompt as the tool handed it to the grader. Inspect hands a list of
# messages and no text; the grader takes exactly one user message, and the hash is over that message's content, so here
# it always equals `sent.user`. The promptfoo grader writes the same field over what promptfoo hands it, which is the
# JSON text of a message list, so the two values are not comparable across tools. `sent.system` and `sent.user` are the
# hashes of the texts sent, on both.
#
# The key goes in the `x-api-key` header on the Anthropic wire and in `authorization: Bearer <key>` on the OpenAI wire. The
# gateway variable that is checked before any call is ANTHROPIC_BASE_URL on the first; on the second it is each of
# OPENAI_BASE_URL, OPENAI_API_BASE_URL, OPENAI_API_HOST and OPENAI_HOST, by the same rule: any one set (non-empty) and not
# equal to the stated base URL, or set with no base URL stated, refuses the grader before any call, naming the variable.
#
# The base URL is taken only in its plain form, the one a URL parser leaves as written: "https://", or "http://" for
# the two literal addresses 127.0.0.1 and [::1] and for no name (not "localhost": a name is whatever the machine's
# resolver says it is); a host that is a lower-case name, four decimal numbers with dots, or [::1]; a port only when it is
# not the scheme's own; and a path of plain segments (letters, digits, ".", "_", "~" and "-", no "." or ".." segment,
# no percent escape). No user information, query or fragment. The promptfoo grader holds it to the same rule, so both
# record the same endpoint for the same address. The request asks for no content encoding, and a response that states
# one is refused, not decoded: a content-encoding header that is there is taken only when it reads "identity", in any
# case, once the white space JavaScript's trim removes is taken off its ends. A header that is there and empty is refused.
# A response whose head holds a control character, a line that is not a header, or a length stated twice, not in digits
# or beside a transfer encoding, is a failed connection, as it is to the promptfoo grader, whose platform refuses such a
# head before the grader sees it. A folded header line and a space before a header's colon are a failed connection here
# too; there the platform decides by its version (Node 22.21 takes both, Node 25.6 refuses both).
#
# Python standard library plus inspect_ai only: no provider SDK. The file's sha256 is in a run's identity, so it
# must stand alone.
import asyncio
import hashlib
import http.client
import json
import math
import os
import platform
import re
import socket
import threading
import time
import uuid
from typing import Any

from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    GenerateConfig,
    ModelAPI,
    ModelOutput,
    ModelUsage,
    modelapi,
)
from inspect_ai.model._model_output import ChatCompletionChoice
from inspect_ai.tool import ToolChoice, ToolInfo

RECORD_SCHEMA = "example.grader-evidence/v8"
WIRE_ANTHROPIC = "anthropic-messages/v1"
WIRE_OPENAI = "openai-responses/v1"
WIRES = (WIRE_ANTHROPIC, WIRE_OPENAI)
CALL_SHAPE_SCHEMA = "anchorset.callshape/v1"
NOT_SENT = "NOT_SENT"
GRADER_NAME = "anchorset-recording-grader"
DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_API_VERSION = "2023-06-01"
DEFAULT_TIMEOUT_MS = 60000
# the longest deadline an ask may be given: one hour; a larger value is refused when the grader is built, before any
# call, as the JavaScript grader refuses it (a timer there takes no more than 2147483647 ms)
MAX_TIMEOUT_MS = 3600000
DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY"
DEFAULT_OPENAI_KEY_ENV = "OPENAI_API_KEY"
POSTED_PATH = "/v1/messages"
OPENAI_POSTED_PATH = "/responses"
# The three variables promptfoo 0.125.1 reads for an OpenAI address, and OPENAI_HOST as well (the JavaScript grader holds the same list). Each is checked by the one rule.
OPENAI_ADDRESS_VARIABLES = ("OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_HOST", "OPENAI_HOST")
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
KEY_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# A key is visible ASCII with no space. Any other character (a line feed, a control character, a letter outside ASCII)
# is refused before the headers are built, and the key is never put into a message.
KEY_FORM = re.compile(r"[\x21-\x7e]+")
# The hosts plain http is taken for: the two literal loopback addresses. The name "localhost" is not one of them: the key
# would go, in clear text, to whatever address the machine's resolver gives for that name.
LOOPBACK = {"127.0.0.1", "[::1]"}
# The host of a base URL, as it must be written. A name: labels of lower-case letters, digits and hyphens, joined by
# single dots, each 1 to 63 characters, none opening or closing with a hyphen and none with hyphens in its third and
# fourth places (the reserved form, "xn--" among them); the last label opens with a letter; 253 characters at most.
# An IPv4 address: four decimal numbers, 0 to 255, with no leading zero. An IPv6 address: [::1] and no other.
HOST_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
IPV4_PART = re.compile(r"0|[1-9][0-9]{0,2}")
PORT_FORM = re.compile(r"[1-9][0-9]{0,4}")
PLAIN_FORM_WORDS = (
    "grader: base_url must be written in its plain form: a lower-case scheme and host (a name, four decimal numbers with dots, "
    "or [::1]) and a port only when it is not the scheme's own"
)
# A response id is copied into the record, into an attempt's detail and into an error text a terminal shows: it is held
# to 1 to 200 visible ASCII characters with no space, the importers' form for it, so it can carry no line feed and no
# control character. A response whose id is of any other form is malformed, as one with no id is.
RESPONSE_ID_FORM = re.compile(r"[\x21-\x7e]{1,200}")
# What the importers hold a free-text value of a record to (shared.ts, isPrintableLine): visible ASCII, single spaces between words,
# none at either end, at most 200 characters. A model id, an API version and a stop reason are copied into the record and into the
# run's identity, so the grader refuses to send, or to record, one that the importers would refuse after the bill.
PRINTABLE_LINE = re.compile(r"[\x21-\x7e]+( [\x21-\x7e]+)*")
MAX_LINE = 200
# The spellings of a gap in the library (readsAsGap in src/identity.ts): a value that reads as one is refused at import.
GAP_SPELLINGS = {"unknown", "na", "none", "null", "nil", "undefined", "notsent"}
# The characters JavaScript's String.prototype.trim removes (WhiteSpace and LineTerminator of the language). Python's
# strip() removes another set (bytes 0x1c to 0x1f and 0x85 among them), so a header's value is trimmed by this list.
JS_TRIM = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
# A control character in a header's name or value: any but the tab. A head that holds one is not well-formed.
HEAD_CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
# model_args the provider takes on each wire (`wire` itself is looked at apart); anything else raises (it never drops a setting silently)
ALLOWED_MODEL_ARGS_ANTHROPIC = {"timeout_ms", "api_version", "api_key_env", "thinking", "effort", "max_reasks"}
ALLOWED_MODEL_ARGS_OPENAI = {"timeout_ms", "api_key_env", "effort", "verbosity", "max_reasks"}
# the smallest output cap OpenAI's Responses API accepts
OPENAI_MIN_OUTPUT_TOKENS = 16
# a cap is an integer below this (the largest integer the JavaScript grader holds exactly, plus one)
INTEGER_BOUND = 2**53
# the most re-asks a slot may be given: the stated bound is an integer from 0 to this
MAX_REASKS_CEILING = 3
# the closed list of what an earlier ask of a slot can have ended in; nothing else is ever asked again
REASK_REASONS = ("timeout", "transport", "server-error", "rate-limited", "truncated")
# the wait, in seconds, before a re-ask when the ask before it got no reply: the first value when that ask was the slot's
# first, the second when it was the slot's second, the third when it was the slot's third; a cut reply counts as an ask
# here, though no wait follows one: after a cut reply and then an ask with no reply, the wait is the second value; no
# retry-after header is read: the server does not steer the grader
REASK_WAITS_S = (2, 4, 8)
NO_RESPONSE = "NO_RESPONSE"
# the efforts the grader sends on the Anthropic wire
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# the efforts OpenAI's pages list; no table of what a model accepts: a word the model refuses is a 4xx on the first ask
OPENAI_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
VERBOSITIES = ("low", "medium", "high")
# a type, a status or a phase that is copied into the record: a plain lower-case identifier, so a value can never forge the "/" and
# "[...]" of a label made from it
TYPE_FORM = re.compile(r"[a-z][a-z0-9_]{0,59}")
# the only generation settings the request carries
SENT_CONFIG_FIELDS = {"max_tokens", "temperature"}
# the tool's word for each raw Messages stop reason; anything else is "unknown"
STOP_WORDS = {
    "end_turn": "stop",
    "max_tokens": "max_tokens",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
    "refusal": "content_filter",
}
# the tool's word for a Responses status, and for the reason of an "incomplete" one; anything else is "unknown"
OPENAI_STOP_WORDS = {"completed": "stop"}
OPENAI_INCOMPLETE_WORDS = {"max_output_tokens": "max_tokens", "content_filter": "content_filter"}


def stop_word(wire: str, stop_reason: str, incomplete_reason: str | None) -> str:
    """The tool's word for a recorded stop: for a Messages stop_reason, the table above; for a Responses status, "stop" for
    "completed" and, for "incomplete", the word of its reason. Anything else is "unknown"."""
    if wire != WIRE_OPENAI:
        return STOP_WORDS.get(stop_reason, "unknown")
    if stop_reason == "incomplete":
        return OPENAI_INCOMPLETE_WORDS.get(incomplete_reason or "", "unknown")
    return OPENAI_STOP_WORDS.get(stop_reason, "unknown")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# One value per process.
GRADER_RUN_ID = str(uuid.uuid4())
with open(__file__, "rb") as _f:
    GRADER_SHA256 = hashlib.sha256(_f.read()).hexdigest()
RUNTIME = f"python {platform.python_version()}"
_SEQ = {"n": 0}
_SEQ_LOCK = threading.Lock()


def _next_seq() -> int:
    # Taken before the request is built or sent: concurrent calls get distinct numbers, and a number is used up by
    # a call that fails.
    with _SEQ_LOCK:
        _SEQ["n"] += 1
        return _SEQ["n"]


def reads_as_gap(s: str) -> bool:
    return re.sub(r"[-_ ./]", "", s.lower()) in GAP_SPELLINGS


def is_printable_line(s: Any) -> bool:
    return isinstance(s, str) and len(s) <= MAX_LINE and PRINTABLE_LINE.fullmatch(s) is not None


def _non_empty_str(x: Any) -> bool:
    return isinstance(x, str) and len(x) > 0


def _number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _plain_host(host: str) -> bool:
    if host == "[::1]":
        return True
    if len(host) > 253:
        return False
    labels = host.split(".")
    if all(re.fullmatch(r"[0-9]+", x) for x in labels):
        return len(labels) == 4 and all(IPV4_PART.fullmatch(x) and int(x) <= 255 for x in labels)
    return all(HOST_LABEL.fullmatch(x) and x[2:4] != "--" for x in labels) and re.fullmatch(r"[a-z].*", labels[-1]) is not None


def parse_base_url(raw: Any, posted_path: str) -> tuple[str, str, int, bool, str, str]:
    """The base URL, taken only when it is written in the form a URL parser leaves as written, and refused before any
    call otherwise. The rule, which the promptfoo grader (`parseBaseUrl`) holds too, so that both record one endpoint:

      - visible ASCII only, with no "?", "#", "@" or backslash: no user information, query or fragment;
      - "https://", or "http://" for the literal address 127.0.0.1 or [::1] and for no other host, in lower case
        ("localhost" is a name like any other: taken over https, refused over plain http);
      - a host as HOST_LABEL, IPV4_PART and _plain_host say: a lower-case name, four decimal numbers, or [::1];
      - a port only when it is stated as 1 to 65535 with no leading zero and is not the scheme's own (443, 80);
      - a path of plain segments: each letters, digits, ".", "_", "~" and "-" only, none of them "." or "..", none
        empty, no percent escape. Closing slashes are dropped.

    The address is read by this rule alone, with no URL library, and the endpoint is built from it as written. No
    refusal shows the URL: it may hold a credential.

    `posted_path` is the wire's route, added after the path ("/v1/messages", or "/responses"); it has no default.

    Returns (the host to connect to, origin, port, secure, path_prefix, the whole path posted to).
    """
    if not _non_empty_str(raw):
        raise ValueError("grader: base_url must be a non-empty string")
    if re.search(r"[ \t\n\r\f\v?#@\\]", raw):
        raise ValueError("grader: base_url must hold no whitespace, user information, query or fragment")
    # As written: a scheme, "//", the host with its port, then the path.
    written = re.fullmatch(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/]+)(/.*)?", raw, re.DOTALL)
    if written is None:
        raise ValueError("grader: base_url is not a URL")
    scheme, authority, written_path = written.group(1), written.group(2), written.group(3) or ""
    if scheme.lower() not in ("http", "https"):
        raise ValueError("grader: base_url must be an http or https URL")
    if scheme not in ("http", "https"):
        raise ValueError(PLAIN_FORM_WORDS)
    secure = scheme == "https"
    default_port = 443 if secure else 80
    # The port is what follows the first colon outside the brackets of [::1].
    colon = authority.find(":", authority.find("]") + 1) if authority.startswith("[") else authority.find(":")
    host = authority if colon == -1 else authority[:colon]
    if not _plain_host(host):
        raise ValueError(PLAIN_FORM_WORDS)
    use_port = default_port
    if colon != -1:
        port = authority[colon + 1:]
        if not PORT_FORM.fullmatch(port) or int(port) > 65535 or int(port) == default_port:
            raise ValueError(PLAIN_FORM_WORDS)
        use_port = int(port)
    if not secure and host not in LOOPBACK:
        raise ValueError("grader: base_url must be https (http only for 127.0.0.1 and [::1])")
    path = written_path.rstrip("/")
    if path and (not re.fullmatch(r"(/[A-Za-z0-9._~-]+)+", path) or any(s in (".", "..") for s in path.split("/"))):
        raise ValueError("grader: base_url path must hold plain segments only")
    if not re.fullmatch(r"[\x21-\x7e]+", raw):
        raise ValueError(PLAIN_FORM_WORDS)
    return ("::1" if host == "[::1]" else host), f"{scheme}://{authority}", use_port, secure, path, path + posted_path


def parse_thinking(v: Any) -> tuple[dict[str, Any] | None, str, Any]:
    """The `thinking` model argument: the string NOT_SENT, or exactly one of the four objects, sent verbatim.

    Returns (the request value as a private copy, or None for NOT_SENT; the call shape's mode; its budget)."""
    refusal = ValueError(
        'grader: thinking must be "NOT_SENT" or one of {"type":"adaptive"}, {"type":"between_tools"}, {"type":"disabled"}, '
        '{"type":"enabled","budget_tokens":<positive integer>}, with no other key'
    )
    if isinstance(v, str) and v == NOT_SENT:
        return None, NOT_SENT, NOT_SENT
    if not isinstance(v, dict) or not all(isinstance(k, str) for k in v):
        raise refusal
    keys = sorted(v)
    if keys == ["type"]:
        t = v["type"]
        if t == "adaptive":
            return {"type": "adaptive"}, "adaptive", NOT_SENT
        if t == "between_tools":
            return {"type": "between_tools"}, "between-tools", NOT_SENT
        if t == "disabled":
            return {"type": "disabled"}, "off", NOT_SENT
        raise refusal
    b = v.get("budget_tokens")
    if keys == ["budget_tokens", "type"] and v["type"] == "enabled" and isinstance(b, int) and not isinstance(b, bool) and 0 < b < 2**53:
        return {"type": "enabled", "budget_tokens": b}, "budgeted", b
    raise refusal


def parse_effort(v: Any, words: tuple[str, ...]) -> str:
    """The `effort` model argument: NOT_SENT or one of the closed words of the wire."""
    if isinstance(v, str) and (v == NOT_SENT or v in words):
        return v
    raise ValueError(f'grader: effort must be "NOT_SENT" or one of {", ".join(words)}')


def parse_verbosity(v: Any) -> str:
    """The `verbosity` model argument (the OpenAI wire): NOT_SENT or one of the closed words."""
    if isinstance(v, str) and (v == NOT_SENT or v in VERBOSITIES):
        return v
    raise ValueError(f'grader: verbosity must be "NOT_SENT" or one of {", ".join(VERBOSITIES)}')


def thinking_tokens_of(data: dict[str, Any], key: str = "thinking_tokens", name: str = "thinking-token") -> Any:
    """The thinking-token counter of a response body (the Anthropic wire: `thinking_tokens`; the OpenAI wire: `reasoning_tokens`), or
    "ABSENT" when the body has none. A counter that is there and is not a non-negative integer stops the call, and a null or a
    non-object at any level on the way to it is "there"."""
    if "usage" not in data:
        return "ABSENT"
    usage = data["usage"]
    if not isinstance(usage, dict):
        raise ValueError(f"grader: the {name} counter is malformed (usage is not an object)")
    if "output_tokens_details" not in usage:
        return "ABSENT"
    details = usage["output_tokens_details"]
    if not isinstance(details, dict):
        raise ValueError(f"grader: the {name} counter is malformed (usage.output_tokens_details is not an object)")
    if key not in details:
        return "ABSENT"
    n = details[key]
    if not isinstance(n, int) or isinstance(n, bool) or n < 0 or n >= INTEGER_BOUND:
        raise ValueError(f"grader: the {name} counter is not a non-negative integer")
    return n


def usage_of(data: dict[str, Any]) -> Any:
    """The token usage of a response body as the response gave it: {"input_tokens", "output_tokens"}, or "ABSENT" when the
    body states neither. One counter without the other, or one that is not a non-negative integer, stops the call.
    (thinking_tokens_of has by then refused a usage that is not an object.)"""
    if "usage" not in data:
        return "ABSENT"
    usage = data["usage"]
    if "input_tokens" not in usage and "output_tokens" not in usage:
        return "ABSENT"

    def counter(n: Any) -> bool:
        return isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 2**53

    if not counter(usage.get("input_tokens")) or not counter(usage.get("output_tokens")):
        raise ValueError("grader: the token usage is malformed (input_tokens and output_tokens must both be non-negative integers)")
    return {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}


def parse_messages(data: Any) -> dict[str, Any]:
    """The checks of a status 200 body on the Anthropic wire (unchanged since version 7) and the reply taken from it. `cut` is a
    stop_reason of exactly "max_tokens"."""
    if (
        not isinstance(data, dict)
        or not _non_empty_str(data.get("id"))
        or not _non_empty_str(data.get("model"))
        or not _non_empty_str(data.get("stop_reason"))
        or not isinstance(data.get("content"), list)
        or len(data["content"]) == 0
    ):
        raise ValueError("grader: the response lacks id, model, stop_reason or content")
    # The id is not shown: it is the part of the response that is not of the form a record and a terminal can hold.
    if not RESPONSE_ID_FORM.fullmatch(data["id"]):
        raise ValueError("grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown")
    # The served model is copied into the record and the run's identity, as the id is: the same form, and not shown.
    if not RESPONSE_ID_FORM.fullmatch(data["model"]):
        raise ValueError("grader: the response model is not 1 to 200 visible ASCII characters with no space; it is not shown")
    # The stop reason is copied into the record and printed by the importer: one printable line, and not shown.
    if not is_printable_line(data["stop_reason"]):
        raise ValueError("grader: the response stop_reason is not one printable line (visible ASCII, single spaces, at most 200 characters); it is not shown")
    # A value the importers read as a gap is refused at import: so it is here, with nothing shown.
    if reads_as_gap(data["id"]) or reads_as_gap(data["model"]) or reads_as_gap(data["stop_reason"]):
        raise ValueError("grader: the response id, model or stop_reason reads as unknown; it is not shown")
    thinking_tokens = thinking_tokens_of(data)
    usage = usage_of(data)
    # The reply is the text of the response's text blocks, joined (one block in every reply the importer accepts). A thinking block's text, signature or data is never read or recorded. A reply
    # with other shapes of content (two text blocks, a tool block) is recorded as it came and refused at import.
    content_types: list[str] = []
    reply = ""
    for block in data["content"]:
        if not isinstance(block, dict) or not _non_empty_str(block.get("type")):
            raise ValueError("grader: a content block has no type")
        content_types.append(block["type"])
        if block["type"] == "text":
            if not isinstance(block.get("text"), str):
                raise ValueError("grader: a text block has no text")
            reply += block["text"]
    return {
        "servedModel": data["model"], "responseId": data["id"], "stopReason": data["stop_reason"], "contentTypes": content_types,
        "thinkingTokens": thinking_tokens, "usage": usage, "text": reply, "cut": data["stop_reason"] == "max_tokens",
    }


def parse_responses(data: Any) -> dict[str, Any]:
    """The checks of a status 200 body on the OpenAI wire, in this order, all of them before any text is joined, and the reply taken
    from it. Every failure is a malformed body: the slot ends, with no record, and is not asked again. No value of the body is shown in
    a message. Fields the grader does not read may hold anything (`encrypted_content` of a reasoning item included); none is read or
    recorded."""
    # 1. A JSON object whose `object` is "response".
    if not isinstance(data, dict) or data.get("object") != "response":
        raise ValueError('grader: the response is not a Responses object (its object is not "response")')
    # 2. `error` is absent or null. (null is taken in this field and in incomplete_details, and nowhere else.)
    if "error" in data and data["error"] is not None:
        raise ValueError("grader: the response holds an error that is not null on a status 200")
    # 3. `status` is completed or incomplete: failed, in_progress, cancelled, queued and anything else are malformed.
    status = data.get("status")
    if not isinstance(status, str) or status not in ("completed", "incomplete"):
        raise ValueError('grader: the response status is neither "completed" nor "incomplete"; the value is not shown')
    # 4. incomplete_details fits the status.
    incomplete_reason = "ABSENT"
    details = data.get("incomplete_details")
    if status == "completed":
        if details is not None:
            raise ValueError('grader: the response is "completed" and holds incomplete_details')
    else:
        reason = details.get("reason") if isinstance(details, dict) else None
        if not isinstance(details, dict) or not is_printable_line(reason) or reads_as_gap(reason) or reason == "ABSENT":
            raise ValueError('grader: the response is "incomplete" and its incomplete_details hold no printable reason; the value is not shown')
        incomplete_reason = reason
    # 5. Echoes: the truncation and the store that were sent. A key that is there and holds anything else, null included, is malformed.
    if "truncation" in data and not (isinstance(data["truncation"], str) and data["truncation"] == "disabled"):
        raise ValueError('grader: the response echoes a truncation other than "disabled"')
    if "store" in data and data["store"] is not False:
        raise ValueError("grader: the response echoes a store other than false")
    # 6. id, model, usage and output.
    if not _non_empty_str(data.get("id")) or not _non_empty_str(data.get("model")) or not isinstance(data.get("output"), list):
        raise ValueError("grader: the response lacks id, model or output")
    if not RESPONSE_ID_FORM.fullmatch(data["id"]):
        raise ValueError("grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown")
    if not RESPONSE_ID_FORM.fullmatch(data["model"]):
        raise ValueError("grader: the response model is not 1 to 200 visible ASCII characters with no space; it is not shown")
    if reads_as_gap(data["id"]) or reads_as_gap(data["model"]):
        raise ValueError("grader: the response id or model reads as unknown; it is not shown")
    thinking_tokens = thinking_tokens_of(data, "reasoning_tokens", "reasoning-token")
    usage = usage_of(data)
    content_types: list[str] = []
    reply = ""
    for item in data["output"]:
        if not isinstance(item, dict) or not isinstance(item.get("type"), str) or not TYPE_FORM.fullmatch(item["type"]):
            raise ValueError("grader: an output item has no type of the plain form (a lower-case identifier); it is not shown")
        if item["type"] == "reasoning":
            content_types.append("reasoning")
            continue
        if item["type"] != "message":
            content_types.append(item["type"])
            continue
        if not isinstance(item.get("status"), str) or not TYPE_FORM.fullmatch(item["status"]):
            raise ValueError("grader: a message item has no status of the plain form; it is not shown")
        if "phase" in item and (not isinstance(item["phase"], str) or not TYPE_FORM.fullmatch(item["phase"])):
            raise ValueError("grader: a message item holds a phase that is not of the plain form; it is not shown")
        if not isinstance(item.get("content"), list):
            raise ValueError("grader: a message item has no content list")
        # The label is written as it is. The importers read a completed message with phase absent or exactly "final_answer"; the other forms say in the record why a message is not taken as the answer.
        label = f"message[status={item['status']}]" if item["status"] != "completed" else (f"message[phase={item['phase']}]" if "phase" in item else "message")
        # A message with no parts still shows in the list, by its bare label: it must not vanish beside a message that is complete.
        if len(item["content"]) == 0:
            content_types.append(label)
        for part in item["content"]:
            if not isinstance(part, dict) or not isinstance(part.get("type"), str) or not TYPE_FORM.fullmatch(part["type"]):
                raise ValueError("grader: a content part has no type of the plain form; it is not shown")
            content_types.append(f"{label}/{part['type']}")
            if part["type"] == "output_text":
                if not isinstance(part.get("text"), str):
                    raise ValueError("grader: an output_text part has no text")
                reply += part["text"]
    return {
        "servedModel": data["model"], "responseId": data["id"], "stopReason": status, "incompleteReason": incomplete_reason,
        "contentTypes": content_types, "thinkingTokens": thinking_tokens, "usage": usage, "text": reply,
        "cut": status == "incomplete" and incomplete_reason == "max_output_tokens",
    }


async def _wait(seconds: float) -> None:
    """The wait between two asks of a slot. The tool's own cancellation ends it, and with it the slot."""
    await asyncio.sleep(seconds)


def convert_prompt(input: list[ChatMessage]) -> str:
    """Exactly one message, of role user, with a string content; anything else raises."""
    if len(input) != 1:
        raise ValueError(f"grader: expected exactly one message, got {len(input)}")
    m = input[0]
    if m.role != "user":
        raise ValueError(f"grader: the one message must have role user, got {m.role}")
    if not isinstance(m.content, str) or m.content == "":
        raise ValueError("grader: the message content must be a non-empty string")
    return m.content


class _Deadline(Exception):
    pass


class _Transport(ValueError):
    """The connection failed or was dropped before a whole response was read. `name` is the error's class name."""

    def __init__(self, name: str) -> None:
        super().__init__(f"grader: transport error ({name})")
        self.name = name


def _deadline(timeout_ms: int) -> _Deadline:
    """What a passed deadline raises: the deadline in whole milliseconds, as it was stated."""
    return _Deadline(f"grader: the call passed its deadline of {timeout_ms} ms")


def _head_is_malformed(msg: Any) -> bool:
    """Whether the head of a response is one the JavaScript grader's platform refuses before that grader sees it: a line
    that is not a header (no colon, a space before the colon, a bare carriage return), which the parser here reports as a
    defect or leaves as a body; a control character other than the tab in a header's name or value (a folded line holds
    one); or a length that is stated twice, not in digits, or beside a transfer encoding. Such a response is a
    failed connection there, so it is one here."""
    if msg.defects or msg.get_payload():
        return True
    if any(HEAD_CONTROL.search(name) or HEAD_CONTROL.search(value) for name, value in msg.items()):
        return True
    lengths = msg.get_all("content-length") or []
    if len(lengths) > 1 or (lengths and msg.get("transfer-encoding") is not None):
        return True
    return any(re.fullmatch(r"[0-9]+", v.strip(" \t")) is None for v in lengths)


def _post(host: str, port: int, secure: bool, path: str, headers: dict[str, str], body: bytes, timeout_ms: int) -> tuple[int, bytes]:
    """One blocking request, made exactly once. The deadline runs from the moment a socket exists: a watchdog
    closes the socket when it passes, and the request is not sent when the deadline passed during the connect
    (each connection attempt and the handshake run under a per-operation timeout only, and a name lookup under none).
    No redirect is followed (http.client never does), and no proxy is used.

    A response whose head is not well-formed (`_head_is_malformed`) is a transport error, whatever its status. A status
    other than 200 is returned with no body, before any byte of the body is read: the caller judges it by the
    status alone, so a body that stalls cannot turn a 4xx or a redirect into a passed deadline. A status 200 whose body
    ends before the length the response declared is a transport error, as a dropped connection is; one in a content
    encoding the request did not ask for is refused; one that declares more than the cap is refused at once."""
    timeout_s = timeout_ms / 1000
    start = time.monotonic()
    state = {"fired": False}
    conn: http.client.HTTPConnection
    if secure:
        conn = http.client.HTTPSConnection(host, port, timeout=timeout_s)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout_s)

    socks: list[socket.socket] = []

    def kill() -> None:
        state["fired"] = True
        for sock in socks:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    timer = threading.Timer(timeout_s, kill)
    timer.daemon = True
    timer.start()
    try:
        conn.connect()
        if state["fired"] or time.monotonic() - start >= timeout_s:
            raise _deadline(timeout_ms)
        if conn.sock is not None:
            # kept here because the connection hands its socket to the response and forgets it
            socks.append(conn.sock)
            conn.sock.settimeout(max(0.001, timeout_s - (time.monotonic() - start)))
        conn.request("POST", path, body=body, headers=headers)
        res = conn.getresponse()
        if _head_is_malformed(res.msg):
            raise _Transport("MalformedHeader")
        if res.status != 200:
            return res.status, b""
        # http.client asks for no content encoding ("accept-encoding: identity") and decodes none: a response that states
        # one is refused by its header, before any byte of the body is read. It is not asked again. A header that is there
        # is judged as it is (two of them as their values joined by ", "): an empty one is not "no header", and its ends
        # are trimmed by JavaScript's list of white space, so that both graders refuse the same values.
        stated = res.getheader("content-encoding")
        if stated is not None and stated.strip(JS_TRIM).lower() != "identity":
            raise ValueError("grader: the response is in a content encoding the request did not ask for")
        if res.length is not None and res.length > MAX_RESPONSE_BYTES:
            raise ValueError("grader: the response is larger than the cap")
        data = res.read(MAX_RESPONSE_BYTES + 1)
        if state["fired"]:
            raise _deadline(timeout_ms)
        if len(data) > MAX_RESPONSE_BYTES:
            raise ValueError("grader: the response is larger than the cap")
        # A read with a size returns what came when the connection closes early; the count of bytes still owed says so.
        if res.length:
            raise _Transport("IncompleteRead")
        return res.status, data
    except _Deadline:
        raise
    except (OSError, http.client.HTTPException) as e:
        if state["fired"] or isinstance(e, TimeoutError) or time.monotonic() - start >= timeout_s:
            raise _deadline(timeout_ms) from None
        raise _Transport(type(e).__name__) from None
    finally:
        timer.cancel()
        try:
            conn.close()
        except OSError:
            pass


def _reject_constant(name: str) -> Any:
    raise ValueError(f"grader: the response holds the non-JSON constant {name}")


@modelapi(name="recording")
class RecordingGrader(ModelAPI):
    def __init__(
        self,
        model_name: str,
        base_url: str | None = None,
        api_key: str | None = None,
        config: GenerateConfig = GenerateConfig(),
        **model_args: Any,
    ) -> None:
        super().__init__(model_name, base_url, None, [], config)
        # The wire first: it fixes every other setting and the gateway variable that is checked. It has no default.
        if "wire" not in model_args:
            raise ValueError(f'grader: model arg "wire" is required (no default): one of {", ".join(WIRES)}')
        wire = model_args["wire"]
        if not isinstance(wire, str) or wire not in WIRES:
            raise ValueError(f'grader: model arg "wire" must be one of {", ".join(WIRES)}')
        openai = wire == WIRE_OPENAI
        # A gateway the user's other tools honour: the environment variable ANTHROPIC_BASE_URL on the Anthropic wire, and each of the four
        # OPENAI_* address variables on the OpenAI wire. This grader never reads one as an address, so with no base URL stated, or another
        # one, the key in the key variable (which may be the gateway's credential) would go to the public host. Refused when the grader is
        # built, before any call, and before any other setting is looked at. The variable is named and its value is never printed. An empty
        # variable is not set. The address to state is the base URL the model is built with (`--base-url` when regrade.py builds it).
        for name in OPENAI_ADDRESS_VARIABLES if openai else ("ANTHROPIC_BASE_URL",):
            gateway = os.environ.get(name)
            if gateway and base_url != gateway:
                how = "no base URL was stated, so the grader would use its default" if base_url is None else "the base URL stated differs from it"
                # A bare host can never equal a base URL, so for the two HOST variables the one remedy is to unset the variable.
                hint = "Unset the variable." if name.endswith("_HOST") else "State the same address as the grader's base URL, or unset the variable."
                raise ValueError(f"grader: the environment variable {name} is set, and this grader never reads it: {how}, and the key would go there instead of to the address your other tools use. {hint} No call was made.")
        if api_key is not None:
            raise ValueError("grader: the key is read from the environment, never passed")
        allowed = ALLOWED_MODEL_ARGS_OPENAI if openai else ALLOWED_MODEL_ARGS_ANTHROPIC
        for k in model_args:
            if k != "wire" and k not in allowed:
                raise ValueError(f'grader: model arg "{k}" is not one the grader sends on the {wire} wire; it never drops a setting silently')
        # No default for these: a judge's settings are stated, never inherited from the provider.
        for k in ("effort", "verbosity") if openai else ("thinking", "effort"):
            if k not in model_args:
                raise ValueError(f'grader: model arg "{k}" is required (no default); "{NOT_SENT}" sends nothing')
        thinking_body, thinking_mode, thinking_budget = (None, NOT_SENT, NOT_SENT) if openai else parse_thinking(model_args["thinking"])
        effort = parse_effort(model_args["effort"], OPENAI_EFFORTS if openai else EFFORTS)
        verbosity = parse_verbosity(model_args["verbosity"]) if openai else NOT_SENT
        # No default here either: every re-ask is a paid call, so how many a slot may get is stated. 0 asks once.
        if "max_reasks" not in model_args:
            raise ValueError(f'grader: model arg "max_reasks" is required (no default): an integer from 0 to {MAX_REASKS_CEILING}; 0 asks every slot once')
        max_reasks = model_args["max_reasks"]
        if not isinstance(max_reasks, int) or isinstance(max_reasks, bool) or not 0 <= max_reasks <= MAX_REASKS_CEILING:
            raise ValueError(f"grader: max_reasks must be an integer from 0 to {MAX_REASKS_CEILING}")
        extra = {k for k, v in config.model_dump(exclude_none=True).items()} - SENT_CONFIG_FIELDS
        if extra:
            raise ValueError(f"grader: generation settings the grader does not send: {sorted(extra)}")
        if not _non_empty_str(model_name):
            raise ValueError("grader: the model name is required")
        # Before any call: a model id the importer would refuse (one that reads as a gap, or is not one printable line) is refused here, not after the bill.
        if not is_printable_line(model_name) or reads_as_gap(model_name):
            raise ValueError("grader: the model name must be one printable line (visible ASCII, single spaces, at most 200 characters) that does not read as unknown; the value is not shown")
        # The cap is the tool's `max_tokens`; the OpenAI wire sends it as `max_output_tokens`, an integer of at least 16. Both are held below 2^53.
        mt = config.max_tokens
        if openai:
            if not isinstance(mt, int) or isinstance(mt, bool) or not OPENAI_MIN_OUTPUT_TOKENS <= mt < INTEGER_BOUND:
                raise ValueError(f"grader: max_tokens is required on the {wire} wire, an integer of at least {OPENAI_MIN_OUTPUT_TOKENS} (it is sent as max_output_tokens)")
        elif not isinstance(mt, int) or isinstance(mt, bool) or not 0 < mt < INTEGER_BOUND:
            raise ValueError("grader: max_tokens is required, a positive integer")
        temp = config.temperature
        temperature_max = 2 if openai else 1
        if temp is not None and not (_number(temp) and 0 <= temp <= temperature_max):
            raise ValueError(f"grader: temperature must be a number in [0, {temperature_max}]")
        timeout_ms = model_args.get("timeout_ms", DEFAULT_TIMEOUT_MS)
        if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 0 < timeout_ms <= MAX_TIMEOUT_MS:
            raise ValueError(f"grader: timeout_ms must be a positive integer of at most {MAX_TIMEOUT_MS} (one hour)")
        # The API version is the Anthropic wire's header; the OpenAI wire has none (the argument is refused above).
        api_version = NOT_SENT if openai else model_args.get("api_version", DEFAULT_API_VERSION)
        if not openai:
            if not _non_empty_str(api_version):
                raise ValueError("grader: api_version must be a non-empty string")
            # The same: an API version that is not 1 to 200 visible ASCII characters, or reads as a gap, is refused here, as the importer refuses it.
            if not RESPONSE_ID_FORM.fullmatch(api_version) or reads_as_gap(api_version):
                raise ValueError("grader: api_version must be 1 to 200 visible ASCII characters with no space that do not read as unknown; the value is not shown")
        key_env = model_args.get("api_key_env", DEFAULT_OPENAI_KEY_ENV if openai else DEFAULT_KEY_ENV)
        if not isinstance(key_env, str) or not KEY_ENV_NAME.fullmatch(key_env):
            # the value is not echoed: a key put here by mistake must not reach an error message
            raise ValueError("grader: api_key_env must be the name of an environment variable (letters, digits and underscores)")
        self.wire = wire
        self.thinking_body = thinking_body
        self.thinking_mode = thinking_mode
        self.thinking_budget = thinking_budget
        self.effort = effort
        self.verbosity = verbosity
        self.max_reasks = max_reasks
        self.requested_model = model_name
        self.max_tokens = mt
        # an integer-valued temperature is written as an integer, as the JavaScript grader writes it
        self.temperature: int | float | None = None if temp is None else (int(temp) if float(temp).is_integer() else float(temp))
        self.timeout_ms = timeout_ms
        self.api_version = api_version
        self.key_env = key_env
        self.host, self.origin, self.port, self.secure, _prefix, self.path = parse_base_url(
            (DEFAULT_OPENAI_BASE_URL if openai else DEFAULT_BASE_URL) if base_url is None else base_url,
            OPENAI_POSTED_PATH if openai else POSTED_PATH,
        )
        self.url = self.origin + self.path

    def should_retry(self, ex: BaseException) -> bool:
        return False

    def max_connections(self) -> int:
        return 1

    def _ask(self, headers: dict[str, str], payload: bytes) -> tuple[dict[str, Any] | None, dict[str, Any] | None, Exception | None]:
        """One ask: one blocking request, made once, under one deadline from the moment a socket exists.

        Returns (None, the reply, None) for a status 200 with a well-formed body, or (what the ask ended in, None, the
        error) for an ask that got no reply and may be asked again: the deadline, a failed connection, a 5xx, a 429.
        Anything else raises and ends the slot."""
        try:
            status, raw = _post(self.host, self.port, self.secure, self.path, headers, payload, self.timeout_ms)
        except _Deadline as e:
            return {"reason": "timeout", "httpStatus": NO_RESPONSE, "detail": f"the call passed its deadline of {self.timeout_ms} ms"}, None, e
        except _Transport as e:
            return {"reason": "transport", "httpStatus": NO_RESPONSE, "detail": f"transport error ({e.name})"}, None, e
        if status != 200:
            # The body of an error is not read (`_post` returns none), parsed or recorded. A redirect is a status like any other 3xx: never followed.
            error = ValueError(f"grader: the endpoint answered status {status}")
            if 500 <= status <= 599:
                return {"reason": "server-error", "httpStatus": status, "detail": f"the endpoint answered status {status}"}, None, error
            if status == 429:
                return {"reason": "rate-limited", "httpStatus": status, "detail": f"the endpoint answered status {status}"}, None, error
            raise error
        try:
            data = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (ValueError, UnicodeDecodeError):
            raise ValueError("grader: the response is not JSON") from None
        return None, (parse_responses(data) if self.wire == WIRE_OPENAI else parse_messages(data)), None

    async def generate(self, input: list[ChatMessage], tools: list[ToolInfo], tool_choice: ToolChoice, config: GenerateConfig):
        seq = _next_seq()
        call_id = str(uuid.uuid4())
        user = convert_prompt(input)
        if len(tools) != 0:
            raise ValueError("grader: the grader sends no tool")
        if tool_choice != "none":
            raise ValueError(f"grader: tool_choice must be none, got {tool_choice!r}")
        unsent = set(config.model_dump(exclude_none=True)) - SENT_CONFIG_FIELDS
        if unsent:
            raise ValueError(f"grader: generation settings the grader does not send: {sorted(unsent)}")
        if config.max_tokens != self.max_tokens or (config.temperature is not None and config.temperature != self.temperature):
            raise ValueError("grader: the generation settings handed differ from the model's own")
        api_key = os.environ.get(self.key_env)
        if not _non_empty_str(api_key):
            raise ValueError("grader: the key variable named in api_key_env is not set")
        # Before any header is built, and without the value: an error of the HTTP client about a header carries it.
        if not KEY_FORM.fullmatch(api_key):
            raise ValueError(
                "grader: the key in the variable named in api_key_env holds a character that is not visible ASCII (a space, a line feed, "
                "a control character or a character outside ASCII); the request is not sent and the key is not shown"
            )

        # The request and the call shape are built here from the same variables.
        openai = self.wire == WIRE_OPENAI
        body: dict[str, Any]
        if openai:
            # Key order is the documented order; store and truncation are always sent and are not settings. One user message and no system
            # text is handed to this grader, so there is no `instructions`.
            body = {"model": self.requested_model, "input": [{"role": "user", "content": user}], "max_output_tokens": self.max_tokens, "store": False, "truncation": "disabled"}
            if self.temperature is not None:
                body["temperature"] = self.temperature
            if self.effort != NOT_SENT:
                body["reasoning"] = {"effort": self.effort}
            if self.verbosity != NOT_SENT:
                body["text"] = {"verbosity": self.verbosity}
        else:
            body = {"model": self.requested_model, "max_tokens": self.max_tokens, "messages": [{"role": "user", "content": user}]}
            if self.temperature is not None:
                body["temperature"] = self.temperature
            if self.thinking_body is not None:
                body["thinking"] = dict(self.thinking_body)
            if self.effort != NOT_SENT:
                body["output_config"] = {"effort": self.effort}
        call_shape: dict[str, Any] = {
            "schema": CALL_SHAPE_SCHEMA,
            "endpoint": self.url,
            "apiVersion": NOT_SENT if openai else self.api_version,
            "betaFlags": NOT_SENT,
            "thinkingMode": NOT_SENT if openai else self.thinking_mode,
            "thinkingBudgetTokens": NOT_SENT if openai else self.thinking_budget,
            "effort": self.effort,
            "toolChoice": NOT_SENT,
            "toolChoiceName": NOT_SENT,
            "strictTools": NOT_SENT,
            "parallelToolUse": NOT_SENT,
            "temperature": NOT_SENT if self.temperature is None else self.temperature,
            "topP": NOT_SENT,
            "topK": NOT_SENT,
            "frequencyPenalty": NOT_SENT,
            "presencePenalty": NOT_SENT,
            "samplingSeed": NOT_SENT,
            "maxOutputTokens": self.max_tokens,
            "stopSequences": NOT_SENT,
            "responseFormat": NOT_SENT,
            "contextPolicy": "none",
            "stream": NOT_SENT,
            "timeoutMs": self.timeout_ms,
            # `store` and `verbosity` are not named keys of the call shape. (`truncation` is: it is the context policy above.)
            "extras": {"openai.store": False, **({} if self.verbosity == NOT_SENT else {"openai.verbosity": self.verbosity})} if openai else {},
        }
        # Serialised once: every ask of this slot sends these bytes and these headers.
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = (
            {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
            if openai
            else {"content-type": "application/json", "anthropic-version": self.api_version, "x-api-key": api_key}
        )

        # The asks of this slot before the last, in the order made. Each ask has its own call number and call id.
        earlier: list[dict[str, Any]] = []

        def ask_text(i: int, a: dict[str, Any]) -> str:
            return f"ask {i + 1} (callSeq {a['callSeq']}, callId {a['callId']}): {a['reason']}" + (
                f", response {a['responseId']}" if a["reason"] == "truncated" else f", {a['detail']}"
            )

        def ends_slot(e: Exception) -> Exception:
            # What is raised when an ask ends the slot with no record. The tool keeps no record of a call that raises, so
            # when the slot made an ask before this one, the text lists every ask of the slot: nothing else holds them.
            # A slot that ends on its first ask raises the failure as it came. The tool's own cancellation is not an
            # Exception and never comes here.
            if not earlier:
                return e
            asks = [ask_text(i, a) for i, a in enumerate(earlier)] + [f"ask {len(earlier) + 1} (callSeq {seq}, callId {call_id}): ended the slot"]
            return ValueError(f"{e}; the slot ends with no record after {len(asks)} asks: " + "; ".join(asks))

        while True:
            try:
                none, got, error = self._ask(headers, payload)
            except Exception as e:
                ended = ends_slot(e)
                if ended is e:
                    raise
                raise ended from e
            if got is not None and not (got["cut"] and len(earlier) < self.max_reasks):
                # The slot's last ask: a reply that is not cut, whatever it says, or a cut reply with the bound used up.
                last = got
                break
            if got is not None:
                # A reply cut at the output cap. Its text is not recorded and not read; its sha256 and its length in UTF-8
                # bytes are recorded, so the record says which text was cut. It is asked again at once.
                try:
                    cut_bytes = got["text"].encode("utf-8")
                except UnicodeEncodeError:
                    # A text with an unpaired surrogate has no UTF-8 bytes of its own, so no hash: such a body ends the slot.
                    raise ends_slot(ValueError("grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own")) from None
                earlier.append({
                    "reason": "truncated", "callSeq": seq, "callId": call_id, "httpStatus": 200, "responseId": got["responseId"],
                    "servedModel": got["servedModel"], "stopReason": got["stopReason"],
                    # the OpenAI wire's earlier cut asks also state why the response was incomplete
                    **({"incompleteReason": got["incompleteReason"]} if openai else {}),
                    "contentTypes": got["contentTypes"], "thinkingTokens": got["thinkingTokens"], "usage": got["usage"],
                    "replySha256": hashlib.sha256(cut_bytes).hexdigest(), "replyUtf8Bytes": len(cut_bytes),
                })
            else:
                assert none is not None and error is not None
                ask = {"reason": none["reason"], "callSeq": seq, "callId": call_id, "httpStatus": none["httpStatus"], "detail": none["detail"]}
                if len(earlier) >= self.max_reasks:
                    # With a bound of 0 the slot has this one ask, and its failure is raised as it came. Otherwise the message
                    # lists every ask of the slot: the tool keeps no record of a call that raises, so nothing else holds them.
                    if self.max_reasks == 0:
                        raise error
                    asks = [*earlier, ask]
                    each = [ask_text(i, a) for i, a in enumerate(asks)]
                    raise ValueError(
                        f"grader: {ask['detail']}; no reply after {len(asks)} asks, the bound of {self.max_reasks} re-ask(s) is used up: " + "; ".join(each)
                    )
                earlier.append(ask)
                await _wait(REASK_WAITS_S[len(earlier) - 1])
            # The list is closed: an ask that ended in anything else was raised above, and is never asked again.
            if earlier[-1]["reason"] not in REASK_REASONS:
                raise ValueError("grader: an ask ended in a way that is not on the closed list; the slot is not asked again")
            # The next ask takes its number and its id here, before its request is sent.
            seq = _next_seq()
            call_id = str(uuid.uuid4())

        reply = last["text"]
        sent: dict[str, Any] = (
            {
                "system": NOT_SENT,
                "user": sha256_hex(user),
                "reasoning": NOT_SENT if self.effort == NOT_SENT else {"effort": self.effort},
                "text": NOT_SENT if self.verbosity == NOT_SENT else {"verbosity": self.verbosity},
                "store": False,
                "truncation": "disabled",
            }
            if openai
            else {
                "system": NOT_SENT,
                "user": sha256_hex(user),
                "thinking": NOT_SENT if self.thinking_body is None else dict(self.thinking_body),
                "output_config": NOT_SENT if self.effort == NOT_SENT else {"effort": self.effort},
            }
        )
        evidence: dict[str, Any] = {
            "schema": RECORD_SCHEMA,
            "wire": self.wire,
            "grader": {"name": GRADER_NAME, "language": "python", "sha256": GRADER_SHA256, "runtime": RUNTIME},
            "graderRunId": GRADER_RUN_ID,
            "callSeq": seq,
            "callId": call_id,
            "promptSha256": sha256_hex(user),
            "sent": sent,
            "requestedModel": self.requested_model,
            "servedModel": last["servedModel"],
            "responseId": last["responseId"],
            "stopReason": last["stopReason"],
            **({"incompleteReason": last["incompleteReason"]} if openai else {}),
            "contentTypes": last["contentTypes"],
            "thinkingTokens": last["thinkingTokens"],
            "usage": last["usage"],
            "reply": reply,
            "callShape": call_shape,
            "reask": {"max": self.max_reasks, "earlier": earlier},
        }
        message = ChatMessageAssistant(
            id=last["responseId"], content=reply, model=last["servedModel"], source="generate", metadata={"graderEvidence": evidence}
        )
        # The tool is handed the usage of the last ask, which is the one it sees; the record holds every ask's.
        usage = last["usage"]
        model_usage = None
        if usage != "ABSENT":
            model_usage = ModelUsage(
                input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"], total_tokens=usage["input_tokens"] + usage["output_tokens"]
            )
        return ModelOutput(
            model=last["servedModel"],
            choices=[ChatCompletionChoice(message=message, stop_reason=stop_word(self.wire, last["stopReason"], last.get("incompleteReason")))],
            usage=model_usage,
            metadata={"graderEvidence": evidence},
        )
