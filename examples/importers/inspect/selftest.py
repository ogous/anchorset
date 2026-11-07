# Self-test of the recording grader (recording_grader.py), the counterpart of the JavaScript grader's tests.
# It runs against a standard-library HTTP server on 127.0.0.1 in this process. No other host is reached, and no
# provider key is used: the key is a dummy value in a variable this test sets.
#
#   python selftest.py        (needs inspect_ai; prints one line per check; exit 0 when all pass, 1 otherwise)
import ast
import asyncio
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from inspect_ai.model import ChatMessageAssistant, ChatMessageSystem, ChatMessageUser, GenerateConfig  # noqa: E402

import recording_grader as rg  # noqa: E402

WIRE = "anthropic-messages/v1"
WIRE_OPENAI = "openai-responses/v1"
KEY_ENV = "SELFTEST_KEY"
KEY = "selftest-dummy-credential-0123456789"
os.environ[KEY_ENV] = KEY

CALL_SHAPE_KEYS = [
    "endpoint", "apiVersion", "betaFlags", "thinkingMode", "thinkingBudgetTokens", "effort", "toolChoice", "toolChoiceName",
    "strictTools", "parallelToolUse", "temperature", "topP", "topK", "frequencyPenalty", "presencePenalty", "samplingSeed",
    "maxOutputTokens", "stopSequences", "responseFormat", "contextPolicy", "stream", "timeoutMs",
]


def sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


DEL = object()  # in a canned or a set reply: take this key out


def omsg(text: str, status: str = "completed", **extra: Any) -> dict[str, Any]:
    """A Responses message item with one output_text part."""
    return {"type": "message", "id": "msg_selftest", "role": "assistant", "status": status, **extra, "content": [{"type": "output_text", "text": text, "annotations": []}]}


def oreasoning() -> dict[str, Any]:
    return {"type": "reasoning", "id": "rs_selftest", "summary": [], "encrypted_content": "ENCRYPTED-SELFTEST-TEXT", "status": "completed"}


GOOD_TEXT = "Reasoning.\n\nGRADE: C"
# Canned Responses replies by name, each a function of the request number: the keys they set replace the default reply's.
OCANNED: dict[str, Any] = {
    "cut": lambda n: {"id": f"resp_cut_{n:04d}", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": [omsg("CUT-REPLY-TEXT GRA", "incomplete")],
                      "usage": {"input_tokens": 31, "output_tokens": 256, "output_tokens_details": {"reasoning_tokens": 7}}},
    "cut-whole": lambda n: {"id": f"resp_cutw_{n:04d}", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": [omsg(GOOD_TEXT)]},
    "cut-reasoning": lambda n: {"id": f"resp_cutr_{n:04d}", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": [oreasoning()]},
    "cut-empty": lambda n: {"id": f"resp_cute_{n:04d}", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []},
    "content-filter": lambda n: {"status": "incomplete", "incomplete_details": {"reason": "content_filter"}, "output": [omsg(GOOD_TEXT)]},
    "other-reason": lambda n: {"status": "incomplete", "incomplete_details": {"reason": "max_messages"}, "output": [omsg(GOOD_TEXT)]},
    "refusal": lambda n: {"output": [{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": [{"type": "refusal", "refusal": "REFUSAL-TEXT"}]}]},
    "refusal-after": lambda n: {"output": [{"type": "message", "id": "m", "role": "assistant", "status": "completed",
                                           "content": [{"type": "output_text", "text": GOOD_TEXT, "annotations": []}, {"type": "refusal", "refusal": "REFUSAL-TEXT"}]}]},
    "refusal-before": lambda n: {"output": [{"type": "message", "id": "m", "role": "assistant", "status": "completed",
                                            "content": [{"type": "refusal", "refusal": "REFUSAL-TEXT"}, {"type": "output_text", "text": GOOD_TEXT, "annotations": []}]}]},
    "reasoning": lambda n: {"output": [oreasoning(), omsg(GOOD_TEXT)], "usage": {"input_tokens": 10, "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 12}}},
    "message-incomplete": lambda n: {"output": [omsg(GOOD_TEXT, "incomplete")]},
    "phase": lambda n: {"output": [omsg(GOOD_TEXT, phase="final_answer")]},
    "phase-commentary": lambda n: {"output": [omsg(GOOD_TEXT, phase="commentary")]},
    "phase-other": lambda n: {"output": [omsg(GOOD_TEXT, phase="draft")]},
    "empty-output": lambda n: {"output": []},
    "empty-message": lambda n: {"output": [{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": []}, omsg(GOOD_TEXT)]},
    "function-call": lambda n: {"output": [{"type": "function_call", "id": "fc", "call_id": "c", "name": "f", "arguments": "{}", "status": "completed"}]},
    "two-messages": lambda n: {"output": [omsg("a"), omsg("b")]},
    "no-counter": lambda n: {"usage": {"input_tokens": 10, "output_tokens": 5}},
}


class Server:
    """Records every request whole and answers by a mode that a check sets."""

    def __init__(self, openai: bool = False) -> None:
        # a stand-in for the Responses API (the route is the same for every path: only POST is answered), with canned replies named "r:<name>" in a script
        self.openai = openai
        self.requests: list[dict[str, Any]] = []
        self.mode = "ok"
        # modes for the first requests, one each, used up in order; after them every request gets `mode`
        self.script: list[str] = []
        self.response: dict[str, Any] = {}
        # the text of the one text block of a reply in the mode "cut-with"
        self.cut_text = ""
        # the header lines of a reply in the mode "raw-header", written to the socket as these bytes
        self.raw_header = b""
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *args: Any) -> None:
                pass

            def do_POST(self) -> None:
                n = int(self.headers.get("content-length", "0"))
                raw = self.rfile.read(n)
                outer.requests.append({"method": "POST", "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "raw": raw})
                m = outer.script.pop(0) if outer.script else outer.mode
                if m.startswith("r:"):
                    # a canned Responses reply, applied on the default one
                    r = outer.reply(raw)
                    for k, v in OCANNED[m[2:]](len(outer.requests)).items():
                        if v is DEL:
                            r.pop(k, None)
                        else:
                            r[k] = v
                    self._send(200, json.dumps(r).encode())
                elif m.isdigit() and m not in ("307", "400"):
                    # an error status; the body is one the grader must never record
                    headers = {"retry-after": "120"} if m == "429" else {}
                    self._send(int(m), b'{"type":"error","error":{"type":"some_error","message":"SECRET-BODY-TEXT"}}', headers)
                elif m == "500-if-marked":
                    # a status 500 for every request whose body holds the marker, a whole reply for every other
                    if b"[[selftest:500]]" in raw:
                        self._send(500, b'{"type":"error","error":{"type":"some_error","message":"SECRET-BODY-TEXT"}}')
                    else:
                        self._send(200, json.dumps(outer.reply(raw)).encode())
                elif m == "cut":
                    r = outer.reply(raw)
                    r.update({"id": f"msg_cut_{len(outer.requests):04d}", "stop_reason": "max_tokens", "content": [{"type": "text", "text": "CUT-REPLY-TEXT GRA"}],
                              "usage": {"input_tokens": 31, "output_tokens": 256, "output_tokens_details": {"thinking_tokens": 7}}})
                    self._send(200, json.dumps(r).encode())
                elif m in ("cut-with", "cut-two-blocks", "cut-surrogate"):
                    r = outer.reply(raw)
                    content = {
                        "cut-with": [{"type": "text", "text": outer.cut_text}],
                        "cut-two-blocks": [{"type": "text", "text": "GRADE"}, {"type": "text", "text": ": C"}],
                        "cut-surrogate": [{"type": "text", "text": "GRA\ud800"}],
                    }[m]
                    r.update({"id": f"msg_cut_{len(outer.requests):04d}", "stop_reason": "max_tokens", "content": content})
                    self._send(200, json.dumps(r).encode())
                elif m == "drop":
                    # the socket is closed with no response
                    self.close_connection = True
                    return
                elif m == "400":
                    self._send(400, b'{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type.disabled is not supported for this model"}}')
                elif m == "307":
                    self.send_response(307)
                    self.send_header("location", "/v1/messages")
                    self.send_header("content-length", "0")
                    self.end_headers()
                elif m == "sleep-1":
                    time.sleep(1)
                    self._send(200, json.dumps(outer.reply(raw)).encode())
                elif m == "sleep":
                    time.sleep(3)
                    self._send(200, json.dumps(outer.reply(raw)).encode())
                elif m == "drip":
                    self.send_response(200)
                    self.send_header("content-length", "100000")
                    self.end_headers()
                    try:
                        for _ in range(60):
                            self.wfile.write(b" ")
                            self.wfile.flush()
                            time.sleep(0.1)
                    except OSError:
                        pass
                elif m.startswith("stallbody-"):
                    # a status, its headers, and a body that never comes: the grader must judge the status alone
                    self.send_response(int(m.split("-")[1]))
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", "1000")
                    self.end_headers()
                    self.wfile.flush()
                    time.sleep(3)
                elif m == "short":
                    # a status 200 whose body ends before the length it declared: the part sent is not a whole JSON value
                    self.send_response(200)
                    self.send_header("content-length", "500")
                    self.end_headers()
                    self.wfile.write(b'{"id":')
                elif m == "short-whole":
                    # the same, where the part sent happens to be a whole reply
                    body = json.dumps(outer.reply(raw)).encode()
                    self.send_response(200)
                    self.send_header("content-length", str(len(body) + 40))
                    self.end_headers()
                    self.wfile.write(body)
                elif m == "huge":
                    # a declared length above the cap, and no body
                    self.send_response(200)
                    self.send_header("content-length", str(rg.MAX_RESPONSE_BYTES + 1))
                    self.end_headers()
                    self.wfile.flush()
                    time.sleep(3)
                elif m == "gzip-header":
                    self._send(200, json.dumps(outer.reply(raw)).encode(), {"content-encoding": "gzip"})
                elif m == "identity-header":
                    self._send(200, json.dumps(outer.reply(raw)).encode(), {"content-encoding": "identity"})
                elif m.startswith("raw-header"):
                    # a whole reply (or, as "raw-header-400", a status 400) whose head holds the stated bytes as they are: no library writes or checks them;
                    # as "raw-header-no-length" the server states no length of its own, and "<n>" in the stated bytes is the body's length
                    body = json.dumps(outer.reply(raw)).encode()
                    status = b"400 Bad Request" if m == "raw-header-400" else b"200 OK"
                    length = b"" if m == "raw-header-no-length" else b"content-length: " + str(len(body)).encode() + b"\r\n"
                    self.wfile.write(b"HTTP/1.0 " + status + b"\r\ncontent-type: application/json\r\n" + length + outer.raw_header.replace(b"<n>", str(len(body)).encode()) + b"\r\n" + body)
                elif m == "badutf8":
                    self._send(200, json.dumps(outer.reply(raw)).encode().replace(b"Reasoning", b"Reason\xffing"))
                elif m == "bom":
                    self._send(200, b"\xef\xbb\xbf" + json.dumps(outer.reply(raw)).encode())
                elif m == "notjson":
                    self._send(200, b"not json")
                elif m == "nan":
                    self._send(200, b'{"id":"x","model":"m","stop_reason":"end_turn","content":[{"type":"text","text":"a"}],"v":NaN}')
                elif m == "noid":
                    r = outer.reply(raw)
                    del r["id"]
                    self._send(200, json.dumps(r).encode())
                else:
                    self._send(200, json.dumps(outer.reply(raw)).encode())

            def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        # Twenty calls connect at once in one check: the default queue of five waiting connections is too short for it.
        class Server(ThreadingHTTPServer):
            request_queue_size = 128

        self.httpd = Server(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def reply(self, raw: bytes) -> dict[str, Any]:
        body = json.loads(raw)
        if self.openai:
            r_o: dict[str, Any] = {
                "id": f"resp_selftest_{len(self.requests):04d}", "object": "response", "status": "completed", "error": None, "incomplete_details": None,
                "model": body["model"] + "-served", "truncation": "disabled", "store": False, "previous_response_id": None,
                "output": [omsg("Reasoning.\n\nGRADE: C")],
                "usage": {"input_tokens": 10, "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 15},
            }
            for k, v in self.response.items():
                if v is DEL:
                    r_o.pop(k, None)
                else:
                    r_o[k] = v
            return r_o
        r: dict[str, Any] = {
            "id": f"msg_selftest_{len(self.requests):04d}",
            "type": "message",
            "role": "assistant",
            "model": body["model"] + "-served",
            "content": [{"type": "text", "text": "Reasoning.\n\nGRADE: C"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
        r.update(self.response)
        return r

    def reset(self, mode: str = "ok", response: dict[str, Any] | None = None, script: list[str] | None = None) -> None:
        self.requests.clear()
        self.mode = mode
        self.script = list(script or [])
        self.response = response or {}

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


SERVER = Server()
OSERVER = Server(openai=True)


def make(max_tokens: int = 64, temperature: float | None = None, base_url: str | None = None, **args: Any) -> rg.RecordingGrader:
    cfg: dict[str, Any] = {"max_tokens": max_tokens}
    if temperature is not None:
        cfg["temperature"] = temperature
    args.setdefault("api_key_env", KEY_ENV)
    args.setdefault("wire", WIRE)
    args.setdefault("thinking", "NOT_SENT")
    args.setdefault("effort", "NOT_SENT")
    # a bound of 0 re-asks is one ask per slot
    args.setdefault("max_reasks", 0)
    return rg.RecordingGrader("fake-judge", base_url=SERVER.url if base_url is None else base_url, config=GenerateConfig(**cfg), **args)


def call(g: rg.RecordingGrader, text: str = "Question: refund?\nGRADE please.", **kw: Any) -> Any:
    msgs = kw.pop("input", [ChatMessageUser(content=text)])
    return asyncio.run(g.generate(msgs, kw.pop("tools", []), kw.pop("tool_choice", "none"), kw.pop("config", g_config(g))))


def g_config(g: rg.RecordingGrader) -> GenerateConfig:
    cfg: dict[str, Any] = {"max_tokens": g.max_tokens}
    if g.temperature is not None:
        cfg["temperature"] = g.temperature
    return GenerateConfig(**cfg)


def raises(fn: Any, *types: type) -> bool:
    try:
        fn()
    except types or (Exception,):
        return True
    return False


def has_null(x: Any) -> bool:
    if x is None:
        return True
    if isinstance(x, dict):
        return any(has_null(v) for v in x.values())
    if isinstance(x, list):
        return any(has_null(v) for v in x)
    return False


RESULTS: list[tuple[str, bool, str]] = []


def check(name: str):
    def deco(fn: Any):
        try:
            fn()
            RESULTS.append((name, True, ""))
        except AssertionError as e:
            RESULTS.append((name, False, f"assertion: {e}"))
        except Exception as e:  # a crash in a check is a failure
            RESULTS.append((name, False, f"{type(e).__name__}: {e}"))
        return fn

    return deco


@check("whole received request equals the record (temperature sent as 0.7)")
def _():
    SERVER.reset()
    user = "Question: refund?\nCRITERION: be kind. éè ☃"
    out = call(make(temperature=0.7), user)
    assert len(SERVER.requests) == 1, len(SERVER.requests)
    req = SERVER.requests[0]
    ev = out.metadata["graderEvidence"]
    assert req["method"] == "POST" and req["path"] == "/v1/messages", req["path"]
    h = req["headers"]
    assert set(h) == {"host", "accept-encoding", "content-length", "content-type", "anthropic-version", "x-api-key"}, sorted(h)
    assert h["content-type"] == "application/json" and h["anthropic-version"] == "2023-06-01" and h["x-api-key"] == KEY
    assert ev["callShape"]["apiVersion"] == h["anthropic-version"]
    body = json.loads(req["raw"])
    assert set(body) == {"model", "max_tokens", "messages", "temperature"}, sorted(body)
    assert body == {"model": "fake-judge", "max_tokens": 64, "messages": [{"role": "user", "content": user}], "temperature": 0.7}
    assert req["raw"] == json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert ev["requestedModel"] == "fake-judge" and ev["promptSha256"] == sha(user)
    assert ev["sent"] == {"system": "NOT_SENT", "user": sha(user), "thinking": "NOT_SENT", "output_config": "NOT_SENT"}
    assert ev["schema"] == "example.grader-evidence/v8" and ev["wire"] == "anthropic-messages/v1" and "reading" not in ev
    assert set(ev) == {"schema", "wire", "grader", "graderRunId", "callSeq", "callId", "promptSha256", "sent", "requestedModel", "servedModel", "responseId", "stopReason", "contentTypes", "thinkingTokens", "usage", "reply", "callShape", "reask"}, sorted(ev)
    assert ev["reask"] == {"max": 0, "earlier": []} and ev["usage"] == {"input_tokens": 10, "output_tokens": 5}
    assert b"reask" not in req["raw"] and "easks" not in json.dumps(ev["callShape"])
    cs = ev["callShape"]
    assert cs["schema"] == "anchorset.callshape/v1" and cs["endpoint"] == SERVER.url + "/v1/messages"
    assert cs["temperature"] == 0.7 and cs["maxOutputTokens"] == 64 and cs["timeoutMs"] == 60000 and cs["contextPolicy"] == "none"
    assert cs["extras"] == {} and set(cs) == {"schema", "extras", *CALL_SHAPE_KEYS}, sorted(set(cs) ^ {"schema", "extras", *CALL_SHAPE_KEYS})
    sent_keys = {"temperature", "maxOutputTokens", "endpoint", "apiVersion", "contextPolicy", "timeoutMs"}
    assert all(cs[k] == "NOT_SENT" for k in CALL_SHAPE_KEYS if k not in sent_keys), cs
    assert not any(v == "UNKNOWN" for v in cs.values())


@check("no temperature configured: not in the body, NOT_SENT in the call shape")
def _():
    SERVER.reset()
    out = call(make())
    body = json.loads(SERVER.requests[0]["raw"])
    assert set(body) == {"model", "max_tokens", "messages"}, sorted(body)
    assert out.metadata["graderEvidence"]["callShape"]["temperature"] == "NOT_SENT"


@check("an integer-valued temperature is written as an integer")
def _():
    SERVER.reset()
    out = call(make(temperature=0.0))
    assert json.loads(SERVER.requests[0]["raw"])["temperature"] == 0
    t = out.metadata["graderEvidence"]["callShape"]["temperature"]
    assert t == 0 and isinstance(t, int) and not isinstance(t, bool)


@check("one request per call")
def _():
    SERVER.reset()
    g = make()
    for i in range(3):
        call(g)
        assert len(SERVER.requests) == i + 1, (i, len(SERVER.requests))


@check("the message conversion: only one user message with a string content; anything else raises with no request")
def _():
    SERVER.reset()
    g = make()
    bad = {
        "two messages": [ChatMessageUser(content="a"), ChatMessageUser(content="b")],
        "system then user": [ChatMessageSystem(content="s"), ChatMessageUser(content="u")],
        "assistant message": [ChatMessageAssistant(content="a")],
        "empty content": [ChatMessageUser(content="")],
        "no message": [],
    }
    for name, msgs in bad.items():
        assert raises(lambda m=msgs: call(g, input=m)), name
    from inspect_ai._util.content import ContentText

    assert raises(lambda: call(g, input=[ChatMessageUser(content=[ContentText(text="x")])])), "list content"
    from inspect_ai.tool import ToolInfo

    assert raises(lambda: call(g, tools=[ToolInfo(name="t", description="d")])), "a tool"
    assert raises(lambda: call(g, tool_choice="auto")), "tool_choice auto"
    assert raises(lambda: call(g, config=GenerateConfig(max_tokens=64, top_p=0.5))), "a generation setting not sent"
    assert raises(lambda: call(g, config=GenerateConfig(max_tokens=64, stop_seqs=["x"]))), "stop sequences"
    assert len(SERVER.requests) == 0, len(SERVER.requests)


@check("construction refuses what the grader cannot send (settings, model args, key argument), no request")
def _():
    SERVER.reset()
    st = {"wire": WIRE, "thinking": "NOT_SENT", "effort": "NOT_SENT", "max_reasks": 0}
    assert raises(lambda: rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8, top_p=0.5), **st))
    assert raises(lambda: rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(), **st))
    assert raises(lambda: rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8), seed=1, **st))
    assert raises(lambda: rg.RecordingGrader("m", base_url=SERVER.url, api_key="k", config=GenerateConfig(max_tokens=8), **st))
    assert raises(lambda: make(timeout_ms=0))
    assert len(SERVER.requests) == 0


@check("a base URL with user information, a query, a fragment, a bad path or plain http to a host that is not 127.0.0.1 or [::1] raises before any request")
def _():
    SERVER.reset()
    p = SERVER.port
    for u in [f"http://user:pw@127.0.0.1:{p}", f"http://user@127.0.0.1:{p}", f"http://127.0.0.1:{p}?a=1", f"http://127.0.0.1:{p}#f",
              f"http://127.0.0.1:{p}/a b", f"http://127.0.0.1:{p}/../x", "http://example.com", f"http://localhost:{p}", "ftp://127.0.0.1", "127.0.0.1:1", ""]:
        assert raises(lambda u=u: make(base_url=u)), u
    assert len(SERVER.requests) == 0
    assert make(base_url=f"http://127.0.0.1:{p}/").url == f"http://127.0.0.1:{p}/v1/messages"
    assert make(base_url=f"http://127.0.0.1:{p}/proxy/").url == f"http://127.0.0.1:{p}/proxy/v1/messages"


@check("a base URL is taken only as a URL parser leaves it: the plain forms are taken and recorded as written, every other spelling of a host, a port or a scheme is refused in one wording, with no request")
def _():
    def refusal_of(fn: Any) -> Exception:
        try:
            fn()
        except ValueError as e:
            return e
        raise AssertionError("the address was taken")

    SERVER.reset()
    p = SERVER.port
    taken = {
        "https://api.anthropic.com": ("api.anthropic.com", 443, True, "https://api.anthropic.com/v1/messages"),
        "https://api.example.com/": ("api.example.com", 443, True, "https://api.example.com/v1/messages"),
        "https://gateway.example/anthropic": ("gateway.example", 443, True, "https://gateway.example/anthropic/v1/messages"),
        "https://api.example.com:8443/Base//": ("api.example.com", 8443, True, "https://api.example.com:8443/Base/v1/messages"),
        "http://127.0.0.1:18765": ("127.0.0.1", 18765, False, "http://127.0.0.1:18765/v1/messages"),
        "https://localhost": ("localhost", 443, True, "https://localhost/v1/messages"),
        "https://localhost:8443/p": ("localhost", 8443, True, "https://localhost:8443/p/v1/messages"),
        "http://[::1]:1/p": ("::1", 1, False, "http://[::1]:1/p/v1/messages"),
        "http://127.0.0.1": ("127.0.0.1", 80, False, "http://127.0.0.1/v1/messages"),
        "https://[::1]": ("::1", 443, True, "https://[::1]/v1/messages"),
        "https://1.2.3.4": ("1.2.3.4", 443, True, "https://1.2.3.4/v1/messages"),
        "https://255.255.255.255:65535": ("255.255.255.255", 65535, True, "https://255.255.255.255:65535/v1/messages"),
        "https://a-b.c1.example": ("a-b.c1.example", 443, True, "https://a-b.c1.example/v1/messages"),
        "https://1.2.3.x": ("1.2.3.x", 443, True, "https://1.2.3.x/v1/messages"),
        "https://h:80": ("h", 80, True, "https://h:80/v1/messages"),
    }
    for u, (host, port, secure, endpoint) in taken.items():
        got_host, origin, got_port, got_secure, _prefix, posted = rg.parse_base_url(u, rg.POSTED_PATH)
        assert (got_host, got_port, got_secure, origin + posted) == (host, port, secure, endpoint), (u, got_host, got_port, got_secure, origin + posted)
    refused = [
        # upper case, a closing dot, an empty label, a hyphen at an end, an underscore, a reserved label, a label too long
        "HTTPS://API.EXAMPLE.COM", "Https://h", "http://LOCALHOST:1", "https://API.example.com", "https://h.", "http://localhost.:1", "https://a..b", "https://.h", "https://-h", "https://h-",
        "https://exa_mple.com", "https://xn--bcher-kva.example", "https://ab--c.example", "https://" + "a" * 64 + ".example",
        # a host that reads as a number
        "https://1", "https://example.123", "https://example.0x1", "http://127.1:1", "http://0x7f.0.0.1:1", "http://2130706433:1", "http://127.0.0.01:1", "http://0177.0.0.1:1", "http://127.0.0.1.:1",
        "https://1.2.3", "https://1.2.3.4.5", "https://1.2.3.256", "https://01.2.3.4", "https://1.2.3.4.",
        # a percent escape or a letter outside ASCII in the host
        "https://%68.example", "https://h%2eexample", "https://b\u00fccher.example", "https://\uff48", "https://h\u3002example",
        # IPv6 in any form but [::1]
        "https://[0:0:0:0:0:0:0:1]", "http://[0:0:0:0:0:0:0:1]:1", "https://[::1]x", "https://[::1", "https://::1", "https://[::]", "https://[::2]", "https://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]:1",
        "https://[fe80::1%25en0]", "https://[::1%lo0]", "https://[0::1]", "https://[::0001]", "https://[2001:db8::1]",
        # a port that is the scheme's own, empty, zero, out of range or not plain digits
        "https://h:443", "http://127.0.0.1:80", "http://localhost:80", "https://h:", "https://h:0", "https://h:080", "https://h:65536", "https://h:99999", "https://h:+1", "https://h:1:2", "https://h:\u0661",
        # a control character
        "https://h\x00", "https://h/a\x00", "https://h:1\x00", "https://h\x7f", "https://h\x1f", "https://h\x85",
    ]
    for u in refused:
        e = refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))
        assert str(e) in (rg.PLAIN_FORM_WORDS, "grader: base_url path must hold plain segments only"), (u, str(e))
        assert raises(lambda u=u: make(base_url=u)), u
    for u in ("\x00https://h", "https:h", "https:/h", "https://", "h"):
        assert str(refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))) == "grader: base_url is not a URL", u
    for u in ("ftp://h", "file://h/etc/x", "wss://h"):
        assert str(refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))) == "grader: base_url must be an http or https URL", u
    # white space, a line end and a backslash keep their own wording; plain http to another host keeps its own
    for u in (" https://h", "https://h ", "https://h\t", "https://h\n", "\nhttps://h", "https://h\r\n", "https://h\x0b", "https://h\x0c", "https://h\\x", "https:\\\\h"):
        assert str(refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))) == "grader: base_url must hold no whitespace, user information, query or fragment", u
    # plain http is taken for the two literal addresses and for nothing else: the name localhost is whatever the machine's resolver says it is
    for u in ("http://example.com", "http://127.0.0.2:1", "http://0.0.0.0:1", "http://localhost.example:1", "http://localhost", "http://localhost:1", "http://localhost:18765", f"http://localhost:{p}",
              "http://localhost:18765/p", "http://localhost.localdomain:1", "http://ip6-localhost:1", "http://127.1.2.3:1"):
        assert str(refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))) == "grader: base_url must be https (http only for 127.0.0.1 and [::1])", u
        assert raises(lambda u=u: make(base_url=u)), u
    assert rg.LOOPBACK == {"127.0.0.1", "[::1]"}, rg.LOOPBACK
    # no refusal shows the address
    for u in ("https://SECRET-token.example", "https://secret-token.example:443", "https://[secret-token]", "https://h:secret-token"):
        assert "secret" not in str(refusal_of(lambda u=u: rg.parse_base_url(u, rg.POSTED_PATH))).lower(), u
    assert make(base_url=f"http://127.0.0.1:{p}").url == f"http://127.0.0.1:{p}/v1/messages" and make(base_url="https://localhost").url == "https://localhost/v1/messages"
    assert len(SERVER.requests) == 0


@check("a 307 raises, records nothing, and is not followed")
def _():
    SERVER.reset("307")
    assert raises(lambda: call(make()))
    assert len(SERVER.requests) == 1, len(SERVER.requests)


@check("a 500, a non-JSON body, a NaN constant and a response without an id each raise (one request each)")
def _():
    for mode in ["500", "notjson", "nan", "noid"]:
        SERVER.reset(mode)
        assert raises(lambda: call(make())), mode
        assert len(SERVER.requests) == 1, (mode, len(SERVER.requests))


@check("the deadline is honoured for a server that sleeps, and for one that drips its body; the request is made once")
def _():
    for mode in ["sleep", "drip"]:
        SERVER.reset(mode)
        g = make(timeout_ms=400)
        t0 = time.monotonic()
        try:
            call(g)
            raise AssertionError(f"{mode}: the call returned")
        except rg._Deadline:
            pass
        dt = time.monotonic() - t0
        assert dt < 1.5, (mode, dt)
        assert len(SERVER.requests) == 1, (mode, len(SERVER.requests))


@check("servedModel is the response's field when it differs from the requested one; the tool's fields carry it")
def _():
    SERVER.reset("ok", {"model": "judge-served-xyz", "id": "msg_abc"})
    out = call(make())
    ev = out.metadata["graderEvidence"]
    assert ev["requestedModel"] == "fake-judge" and ev["servedModel"] == "judge-served-xyz" and ev["responseId"] == "msg_abc"
    assert out.model == "judge-served-xyz"
    m = out.choices[0].message
    assert m.id == "msg_abc" and m.model == "judge-served-xyz" and m.content == ev["reply"]
    assert m.metadata == {"graderEvidence": ev} and out.metadata == {"graderEvidence": ev}
    assert out.choices[0].stop_reason == "stop" and ev["stopReason"] == "end_turn"


@check("content blocks: text blocks are concatenated, the types are listed in order; the raw stop is recorded and mapped")
def _():
    SERVER.reset("ok", {"content": [{"type": "thinking", "thinking": "t", "signature": "s"}, {"type": "text", "text": "A"}, {"type": "text", "text": "B"}], "stop_reason": "max_tokens"})
    out = call(make())
    ev = out.metadata["graderEvidence"]
    assert ev["contentTypes"] == ["thinking", "text", "text"] and ev["reply"] == "AB" and ev["stopReason"] == "max_tokens"
    assert out.choices[0].stop_reason == "max_tokens"
    SERVER.reset("ok", {"stop_reason": "something_new"})
    out = call(make())
    assert out.metadata["graderEvidence"]["stopReason"] == "something_new" and out.choices[0].stop_reason == "unknown"


THINKING_FORMS = [
    ("adaptive", {"type": "adaptive"}, {"thinkingMode": "adaptive", "thinkingBudgetTokens": "NOT_SENT"}),
    ("between_tools", {"type": "between_tools"}, {"thinkingMode": "between-tools", "thinkingBudgetTokens": "NOT_SENT"}),
    ("disabled", {"type": "disabled"}, {"thinkingMode": "off", "thinkingBudgetTokens": "NOT_SENT"}),
    ("enabled", {"type": "enabled", "budget_tokens": 2048}, {"thinkingMode": "budgeted", "thinkingBudgetTokens": 2048}),
]


@check("thinking: each closed form is sent verbatim as the top-level thinking key, recorded as sent, and mapped into the call shape")
def _():
    for name, form, shape in THINKING_FORMS:
        SERVER.reset()
        out = call(make(thinking=form))
        body = json.loads(SERVER.requests[0]["raw"])
        assert body["thinking"] == form and set(body) == {"model", "max_tokens", "messages", "thinking"}, (name, sorted(body))
        ev = out.metadata["graderEvidence"]
        assert ev["sent"]["thinking"] == form and ev["sent"]["output_config"] == "NOT_SENT", name
        assert all(ev["callShape"][k] == v for k, v in shape.items()) and ev["callShape"]["effort"] == "NOT_SENT", name


@check("effort: each word is sent as output_config, recorded as sent, and mapped into the call shape")
def _():
    for effort in ["low", "medium", "high", "xhigh", "max"]:
        SERVER.reset()
        out = call(make(effort=effort))
        body = json.loads(SERVER.requests[0]["raw"])
        assert body["output_config"] == {"effort": effort} and set(body) == {"model", "max_tokens", "messages", "output_config"}, (effort, sorted(body))
        ev = out.metadata["graderEvidence"]
        assert ev["sent"]["output_config"] == {"effort": effort} and ev["sent"]["thinking"] == "NOT_SENT"
        assert ev["callShape"]["effort"] == effort and ev["callShape"]["thinkingMode"] == "NOT_SENT"


@check("NOT_SENT sends nothing: neither key is in the body, and the record says so")
def _():
    SERVER.reset()
    out = call(make(wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT"))
    raw = SERVER.requests[0]["raw"]
    assert b"thinking" not in raw and b"output_config" not in raw
    ev = out.metadata["graderEvidence"]
    assert [ev["sent"]["thinking"], ev["sent"]["output_config"], ev["callShape"]["thinkingMode"], ev["callShape"]["thinkingBudgetTokens"], ev["callShape"]["effort"]] == ["NOT_SENT"] * 5


@check("thinking and effort are required, with no default: a missing one raises at construction, before any request")
def _():
    SERVER.reset()
    for missing in ["thinking", "effort"]:
        args: dict[str, Any] = {"wire": WIRE, "thinking": "NOT_SENT", "effort": "NOT_SENT", "max_reasks": 0, "api_key_env": KEY_ENV}
        del args[missing]
        try:
            rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8), **args)
            raise AssertionError(f"{missing}: constructed")
        except ValueError as e:
            assert missing in str(e), (missing, str(e))
    assert len(SERVER.requests) == 0


@check("every other form of thinking and effort raises at construction, before any request")
def _():
    SERVER.reset()
    bad_thinking = [
        {}, {"type": "auto"}, {"type": "between-tools"}, {"type": "off"}, {"type": "ADAPTIVE"}, {"type": "adaptive", "display": "summarized"},
        {"type": "adaptive", "zeta": 1}, {"type": "disabled", "typed": True},
        {"type": "adaptive", "budget_tokens": 1024}, {"type": "disabled", "budget_tokens": 1024}, {"type": "enabled"}, {"type": "enabled", "budget_tokens": 0},
        {"type": "enabled", "budget_tokens": -5}, {"type": "enabled", "budget_tokens": 10.5}, {"type": "enabled", "budget_tokens": "2048"}, {"type": "enabled", "budget_tokens": 2**53}, {"type": "enabled", "budget_tokens": 10**30},
        {"type": "enabled", "budget_tokens": True}, {"type": "enabled", "budget_tokens": 1024, "extra": 1}, {"budget_tokens": 1024},
        "adaptive", "not_sent", "NOT-SENT", "", None, True, 5, ["adaptive"],
    ]
    for t in bad_thinking:
        assert raises(lambda t=t: make(thinking=t)), t
    for e in ["minimal", "HIGH", "High", "highest", "", "none", "not_sent", None, 3, True, {"effort": "high"}, ["high"], " high"]:
        assert raises(lambda e=e: make(effort=e)), e
    assert len(SERVER.requests) == 0


@check("the thinking object handed is copied: changing it afterwards changes nothing that is sent")
def _():
    SERVER.reset()
    form = {"type": "enabled", "budget_tokens": 1500}
    g = make(thinking=form)
    form["budget_tokens"] = 9
    call(g)
    assert json.loads(SERVER.requests[0]["raw"])["thinking"] == {"type": "enabled", "budget_tokens": 1500}


@check("a thinking block then a text block: the reply, the message content and the output are the text block's text; no thinking text, signature or data is recorded")
def _():
    thought, sig = "secret reasoning that must not be recorded", "sig-abcdef0123456789"
    SERVER.reset("ok", {"content": [{"type": "thinking", "thinking": thought, "signature": sig}, {"type": "text", "text": "Reasoning.\n\nGRADE: C"}],
                        "usage": {"input_tokens": 9, "output_tokens": 40, "output_tokens_details": {"thinking_tokens": 17}}})
    out = call(make())
    ev = out.metadata["graderEvidence"]
    assert ev["reply"] == "Reasoning.\n\nGRADE: C" and ev["contentTypes"] == ["thinking", "text"] and ev["thinkingTokens"] == 17
    m = out.choices[0].message
    assert isinstance(m.content, str) and m.content == "Reasoning.\n\nGRADE: C" and out.completion == "Reasoning.\n\nGRADE: C"
    dumped = out.model_dump_json() + json.dumps(ev)
    assert thought not in dumped and sig not in dumped
    SERVER.reset("ok", {"content": [{"type": "redacted_thinking", "data": "REDACTED-DATA-XYZ"}, {"type": "text", "text": "T2"}]})
    out = call(make())
    assert out.metadata["graderEvidence"]["contentTypes"] == ["redacted_thinking", "text"] and out.completion == "T2"
    assert "REDACTED-DATA-XYZ" not in out.model_dump_json()
    SERVER.reset("ok", {"content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "T3"}]})
    assert call(make()).completion == "T3"


@check("thinkingTokens: the integer at usage.output_tokens_details.thinking_tokens, 0 included; ABSENT when the response has no counter; a counter that is there and malformed raises")
def _():
    SERVER.reset("ok", {"usage": {"input_tokens": 9, "output_tokens": 4, "output_tokens_details": {"thinking_tokens": 0}}})
    assert call(make()).metadata["graderEvidence"]["thinkingTokens"] == 0
    SERVER.reset("ok", {"usage": {"input_tokens": 9, "output_tokens": 400, "output_tokens_details": {"thinking_tokens": 321}}})
    assert call(make()).metadata["graderEvidence"]["thinkingTokens"] == 321
    for usage in [{}, {"input_tokens": 9, "output_tokens": 4}, {"output_tokens_details": {}}]:
        SERVER.reset("ok", {"usage": usage})
        assert call(make()).metadata["graderEvidence"]["thinkingTokens"] == "ABSENT", usage
    for bad in [-1, 1.5, "12", None, True, {}]:
        SERVER.reset("ok", {"usage": {"input_tokens": 9, "output_tokens": 4, "output_tokens_details": {"thinking_tokens": bad}}})
        assert raises(lambda: call(make())), bad
    SERVER.reset("ok", {"usage": {"output_tokens_details": 5}})
    assert raises(lambda: call(make()))
    # a null at any level is refused the same way, and so is a usage that is not an object
    for usage in [None, 5, "x", [], {"output_tokens_details": None}, {"output_tokens_details": {"thinking_tokens": None}}]:
        SERVER.reset("ok", {"usage": usage})
        assert raises(lambda: call(make())), usage


@check("a failed call (a 400 for a setting the model does not accept) uses up its call number and records nothing")
def _():
    SERVER.reset("400")
    g = make(thinking={"type": "disabled"})
    assert raises(lambda: call(g))
    SERVER.reset()
    assert call(g).metadata["graderEvidence"]["callSeq"] >= 2


@check("regrade.py: --thinking and --effort are required for a run and are refused with --check; bad JSON text for --thinking is a usage error")
def _():
    import io
    from contextlib import redirect_stderr

    import regrade

    base = ["--log", "no-such-log.json", "--epochs", "1", "--judge-model", "m", "--max-tokens", "5", "--out-dir", "no-such-dir", "--base-url", "http://127.0.0.1:1", "--wire", WIRE]

    def code(extra: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with redirect_stderr(err):
            return regrade.main(base + extra), err.getvalue()

    c, msg = code(["--effort", "low", "--max-reasks", "0"])
    assert c == 64 and "--thinking" in msg, (c, msg)
    c, msg = code(["--thinking", "NOT_SENT", "--max-reasks", "0"])
    assert c == 64 and "--effort" in msg, (c, msg)
    c, msg = code([])
    assert c == 64 and "--thinking" in msg and "--effort" in msg and "--max-reasks" in msg, (c, msg)
    for bad in ['{"type":"adaptive"', '{"type":"adaptive","type":"disabled"}', '{"type":"enabled","budget_tokens":NaN}', "", "nonsense"]:
        c, msg = code(["--thinking", bad, "--effort", "low", "--max-reasks", "0"])
        assert c == 64 and "--thinking" in msg, (bad, c, msg)
    err = io.StringIO()
    with redirect_stderr(err):
        c = regrade.main(["--log", "x.json", "--epochs", "1", "--check", "--wire", WIRE, "--thinking", "NOT_SENT"])
    assert c == 64 and "--check" in err.getvalue()
    err = io.StringIO()
    with redirect_stderr(err):
        c = regrade.main(["--log", "x.json", "--epochs", "1", "--check", "--effort", "low"])
    assert c == 64
    # a flag given twice is refused, and the JSON text of a string or of anything but an object is not a spelling of NOT_SENT
    for extra in (["--thinking", "NOT_SENT", "--thinking", '{"type":"adaptive"}', "--effort", "NOT_SENT", "--max-reasks", "0"],
                  ["--thinking", "NOT_SENT", "--effort", "low", "--effort", "high", "--max-reasks", "0"]):
        c, msg = code(extra)
        assert c == 64 and ("--thinking" in msg or "--effort" in msg), (extra, c, msg)
    for bad in ['"NOT_SENT"', "5", "[]", "null", "true"]:
        c, msg = code(["--thinking", bad, "--effort", "NOT_SENT", "--max-reasks", "0"])
        assert c == 64 and "--thinking" in msg, (bad, c, msg)
    # an empty --effort is not NOT_SENT: the run is refused before any request (a valid log, a reachable endpoint, a key)
    import tempfile

    SERVER.reset()
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "source.json")
    with tempfile.TemporaryDirectory() as tmp:
        err = io.StringIO()
        with redirect_stderr(err):
            c = regrade.main(["--log", source, "--epochs", "1", "--judge-model", "m", "--max-tokens", "5", "--out-dir", tmp, "--base-url", SERVER.url,
                              "--api-key-env", KEY_ENV, "--wire", WIRE, "--thinking", "NOT_SENT", "--effort", "", "--max-reasks", "0"])
        assert c != 0 and len(SERVER.requests) == 0, (c, err.getvalue())
    assert regrade.thinking_from_text("NOT_SENT") == "NOT_SENT"
    assert regrade.thinking_from_text('{"type": "enabled", "budget_tokens": 2048}') == {"type": "enabled", "budget_tokens": 2048}


@check("the key is nowhere in the record, the message or the output")
def _():
    SERVER.reset()
    out = call(make(temperature=0.5))
    assert KEY not in json.dumps(out.metadata)
    assert KEY not in out.model_dump_json()
    assert KEY not in repr(out)


@check("a missing key variable raises before any request")
def _():
    SERVER.reset()
    g = make(api_key_env="SELFTEST_NO_SUCH_VARIABLE")
    assert raises(lambda: call(g))
    assert len(SERVER.requests) == 0


@check("a key put in api_key_env by mistake is refused without being echoed, before any request")
def _():
    SERVER.reset()
    secret = "mistaken-credential-0123456789"
    for bad in [secret, "has space", "1LEADING_DIGIT", "A-B"]:
        try:
            make(api_key_env=bad)
            raise AssertionError(f"{bad!r}: the grader was made")
        except ValueError as e:
            assert secret not in str(e) and bad not in str(e), str(e)
    g = make(api_key_env="SELFTEST_NO_SUCH_VARIABLE")
    try:
        call(g)
        raise AssertionError("the call returned")
    except ValueError as e:
        assert "SELFTEST_NO_SUCH_VARIABLE" not in str(e), str(e)
    assert len(SERVER.requests) == 0


@check("a deadline that passes during the connect stops the call before the request is sent")
def _():
    SERVER.reset()
    real = rg.http.client.HTTPConnection.connect

    def slow(self: Any) -> None:
        real(self)
        time.sleep(0.5)

    rg.http.client.HTTPConnection.connect = slow
    try:
        g = make(timeout_ms=200)
        try:
            call(g)
            raise AssertionError("the call returned")
        except rg._Deadline:
            pass
    finally:
        rg.http.client.HTTPConnection.connect = real
    assert len(SERVER.requests) == 0, len(SERVER.requests)


@check("twenty concurrent calls (twenty threads) give twenty distinct call sequence numbers, in one run id")
def _():
    SERVER.reset()
    g = make()
    outs: list[Any] = []
    lock = threading.Lock()

    def work() -> None:
        o = call(g)
        with lock:
            outs.append(o)

    ts = [threading.Thread(target=work) for _ in range(20)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    seqs = sorted(o.metadata["graderEvidence"]["callSeq"] for o in outs)
    assert len(seqs) == 20 and seqs == list(range(seqs[0], seqs[0] + 20)), seqs
    assert len({o.metadata["graderEvidence"]["callId"] for o in outs}) == 20
    assert len({o.metadata["graderEvidence"]["graderRunId"] for o in outs}) == 1
    assert len(SERVER.requests) == 20


@check("the record survives a JSON round trip unchanged and holds no null")
def _():
    SERVER.reset()
    out = call(make(temperature=0.7))
    ev = out.metadata["graderEvidence"]
    assert json.loads(json.dumps(ev)) == ev
    assert not has_null(ev)


@check("the grader file imports only the standard library and inspect_ai, and its recorded sha256 is the file's")
def _():
    with open(os.path.join(HERE, "recording_grader.py"), "rb") as f:
        raw = f.read()
    tree = ast.parse(raw)
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            mods |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom):
            assert n.level == 0 and n.module is not None
            mods.add(n.module.split(".")[0])
    outside = {m for m in mods if m not in sys.stdlib_module_names and m != "inspect_ai"}
    assert not outside, outside
    assert rg.GRADER_SHA256 == hashlib.sha256(raw).hexdigest()
    assert b"\r" not in raw
    SERVER.reset()
    ev = call(make()).metadata["graderEvidence"]
    assert ev["grader"] == {"name": "anchorset-recording-grader", "language": "python", "sha256": rg.GRADER_SHA256, "runtime": rg.RUNTIME}
    assert rg.RUNTIME.startswith("python 3.")


@check("should_retry is false for every error, and the grader holds one connection")
def _():
    g = make()
    assert g.should_retry(RuntimeError("x")) is False and g.should_retry(TimeoutError()) is False
    assert g.max_connections() == 1


# ---- the bounded, recorded re-ask ------------------------------------------------------------------------------------


class Waits:
    """Replaces the grader's wait between two asks by a recorder, so a check does not wait; `seen` lists the seconds asked for."""

    def __enter__(self) -> "Waits":
        self.real = rg._wait
        self.seen: list[float] = []

        async def fake(seconds: float) -> None:
            self.seen.append(seconds)

        rg._wait = fake
        return self

    def __exit__(self, *exc: Any) -> None:
        rg._wait = self.real


def error_of(fn: Any) -> Exception:
    try:
        fn()
    except Exception as e:
        return e
    raise AssertionError("the call returned")


def record_of(out: Any) -> dict[str, Any]:
    return out.metadata["graderEvidence"]


UUID = r"[0-9a-f-]{36}"


@check("max_reasks is required: a grader without it raises before any request")
def _():
    SERVER.reset()
    try:
        rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", api_key_env=KEY_ENV)
        raise AssertionError("constructed")
    except ValueError as e:
        assert 'model arg "max_reasks" is required (no default)' in str(e), str(e)
    assert len(SERVER.requests) == 0


@check('max_reasks of -1, 4, 1.5, "2" or None raises before any request')
def _():
    SERVER.reset()
    for bad in [-1, 4, 1.5, "2", None, True, False, [1], {}, float("nan"), "", "0", 100, 2.0]:
        try:
            make(max_reasks=bad)
            raise AssertionError(f"{bad!r}: constructed")
        except ValueError as e:
            assert "max_reasks must be an integer from 0 to 3" in str(e), (bad, str(e))
    for good in [0, 1, 2, 3]:
        assert make(max_reasks=good).max_reasks == good
    assert len(SERVER.requests) == 0


@check("a finished reply is asked once under max_reasks 3")
def _():
    SERVER.reset()
    with Waits() as w:
        ev = record_of(call(make(max_reasks=3)))
    assert len(SERVER.requests) == 1 and ev["reask"] == {"max": 3, "earlier": []} and w.seen == [], (len(SERVER.requests), ev["reask"], w.seen)


@check("a cut reply is asked again with the same bytes")
def _():
    SERVER.reset(script=["cut"])
    g = make(max_reasks=2, temperature=0.0)
    with Waits() as w:
        out = call(g)
    assert len(SERVER.requests) == 2, len(SERVER.requests)
    a, b = SERVER.requests
    assert a["raw"] == b["raw"] and a["path"] == b["path"]
    for h in ("content-type", "anthropic-version", "x-api-key", "content-length"):
        assert a["headers"][h] == b["headers"][h], h
    assert w.seen == [], "no wait after a cut reply"
    ev = record_of(out)
    assert ev["stopReason"] == "end_turn" and ev["reply"] == "Reasoning.\n\nGRADE: C" and out.choices[0].stop_reason == "stop"
    assert ev["usage"] == {"input_tokens": 10, "output_tokens": 5} and ev["reask"]["max"] == 2 and len(ev["reask"]["earlier"]) == 1
    e = ev["reask"]["earlier"][0]
    assert list(e) == ["reason", "callSeq", "callId", "httpStatus", "responseId", "servedModel", "stopReason", "contentTypes", "thinkingTokens", "usage", "replySha256", "replyUtf8Bytes"], list(e)
    assert {**e, "callId": "", "callSeq": 0} == {"reason": "truncated", "callSeq": 0, "callId": "", "httpStatus": 200, "responseId": "msg_cut_0001", "servedModel": "fake-judge-served",
                                              "stopReason": "max_tokens", "contentTypes": ["text"], "thinkingTokens": 7, "usage": {"input_tokens": 31, "output_tokens": 256},
                                              "replySha256": sha("CUT-REPLY-TEXT GRA"), "replyUtf8Bytes": 18}, e
    # two consecutive call numbers and two call ids
    assert ev["callSeq"] == e["callSeq"] + 1 and e["callId"] != ev["callId"]
    # the cut reply's text is recorded nowhere, and the tool is handed the last ask only
    assert "CUT-REPLY-TEXT" not in out.model_dump_json()
    assert out.usage is not None and out.usage.input_tokens == 10 and out.usage.output_tokens == 5
    assert out.choices[0].message.id == ev["responseId"]


@check("a 529 is asked again, and so is a 429; a retry-after header is not read")
def _():
    for status, reason in [("529", "server-error"), ("500", "server-error"), ("599", "server-error"), ("429", "rate-limited")]:
        SERVER.reset(script=[status])
        with Waits() as w:
            out = call(make(max_reasks=1))
        assert len(SERVER.requests) == 2 and SERVER.requests[0]["raw"] == SERVER.requests[1]["raw"], (status, len(SERVER.requests))
        assert w.seen == [2], (status, w.seen)
        ev = record_of(out)
        e = ev["reask"]["earlier"][0]
        assert list(e) == ["reason", "callSeq", "callId", "httpStatus", "detail"], list(e)
        assert (e["reason"], e["httpStatus"], e["detail"]) == (reason, int(status), f"the endpoint answered status {status}"), e
        assert ev["callSeq"] == e["callSeq"] + 1 and ev["stopReason"] == "end_turn"
        assert "SECRET-BODY-TEXT" not in out.model_dump_json()


@check("a passed deadline is asked again, and so is a deadline that passes while the body is read")
def _():
    for mode in ["sleep", "drip"]:
        SERVER.reset(script=[mode])
        with Waits() as w:
            out = call(make(max_reasks=1, timeout_ms=400))
        assert len(SERVER.requests) == 2 and SERVER.requests[0]["raw"] == SERVER.requests[1]["raw"], (mode, len(SERVER.requests))
        e = record_of(out)["reask"]["earlier"][0]
        assert (e["reason"], e["httpStatus"], e["detail"]) == ("timeout", "NO_RESPONSE", "the call passed its deadline of 400 ms"), e
        assert w.seen == [2]


@check("a dropped connection is asked again")
def _():
    SERVER.reset(script=["drop"])
    with Waits() as w:
        out = call(make(max_reasks=1))
    assert len(SERVER.requests) == 2 and SERVER.requests[0]["raw"] == SERVER.requests[1]["raw"], len(SERVER.requests)
    e = record_of(out)["reask"]["earlier"][0]
    assert e["reason"] == "transport" and e["httpStatus"] == "NO_RESPONSE", e
    import re as _re

    assert _re.fullmatch(r"transport error \([A-Za-z_0-9]+\)", e["detail"]), e["detail"]
    assert w.seen == [2]


@check("a connection that cannot be made at all is a transport error too")
def _():
    SERVER.reset()
    import socket as _socket

    probe = _socket.socket()
    probe.bind(("127.0.0.1", 0))
    dead = probe.getsockname()[1]
    probe.close()
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=1, base_url=f"http://127.0.0.1:{dead}")))
    assert "transport error" in str(e) and "no reply after 2 asks" in str(e), str(e)
    assert w.seen == [2] and len(SERVER.requests) == 0


@check("the waits are 2, 4, then 8 seconds, by the number of the re-ask, and none after a cut")
def _():
    assert rg.REASK_WAITS_S == (2, 4, 8)
    SERVER.reset(script=["503", "503", "503"])
    with Waits() as w:
        ev = record_of(call(make(max_reasks=3)))
    assert w.seen == [2, 4, 8], w.seen
    seqs = [e["callSeq"] for e in ev["reask"]["earlier"]] + [ev["callSeq"]]
    assert seqs == list(range(seqs[0], seqs[0] + 4)), seqs
    SERVER.reset(script=["cut", "500"])
    with Waits() as w:
        ev = record_of(call(make(max_reasks=3)))
    assert w.seen == [4] and [e["reason"] for e in ev["reask"]["earlier"]] == ["truncated", "server-error"], (w.seen, ev["reask"])


@check("the wait is real: one re-ask after a 529 takes two seconds")
def _():
    SERVER.reset(script=["529"])
    t0 = time.monotonic()
    ev = record_of(call(make(max_reasks=1)))
    dt = time.monotonic() - t0
    assert 1.95 <= dt < 4, dt
    assert len(ev["reask"]["earlier"]) == 1


@check("a 400, 401, 403, 404, 408, 409, 413, 422 or 425 is never asked again")
def _():
    for status in ["400", "401", "403", "404", "408", "409", "413", "422", "425", "499", "600"]:
        SERVER.reset(status if status == "400" else "ok", script=[] if status == "400" else [status])
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert str(e) == f"grader: the endpoint answered status {status}", (status, str(e))
        assert len(SERVER.requests) == 1 and w.seen == [], (status, len(SERVER.requests), w.seen)


@check("a redirect is never asked again")
def _():
    SERVER.reset("307")
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=3)))
    assert str(e) == "grader: the endpoint answered status 307", str(e)
    assert len(SERVER.requests) == 1 and w.seen == []


@check("a status 200 with a malformed body is never asked again")
def _():
    for mode in ["notjson", "nan", "noid"]:
        SERVER.reset(mode)
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert str(e).startswith("grader: ") and len(SERVER.requests) == 1 and w.seen == [], (mode, str(e), len(SERVER.requests))
    bad = [
        {"content": []}, {"content": [{"text": "x"}]}, {"usage": {"output_tokens_details": {"thinking_tokens": -1}}}, {"usage": {"input_tokens": "many", "output_tokens": 5}},
        # the same with a cut stop: a body the grader cannot read is not a cut reply
        {"stop_reason": "max_tokens", "content": [{"type": "text"}]}, {"stop_reason": "max_tokens", "usage": {"input_tokens": 5}},
    ]
    for over in bad:
        SERVER.reset("ok", over)
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert str(e).startswith("grader: ") and len(SERVER.requests) == 1 and w.seen == [], (over, str(e), len(SERVER.requests))


@check("a finished reply with no grade line, with prose, with a refusal stop or with a tool block is never asked again")
def _():
    replies: list[dict[str, Any]] = [
        {"content": [{"type": "text", "text": "Reasoning with no grade line."}]},
        {"content": [{"type": "text", "text": "GRADE: C and then more prose."}]},
        {"content": [{"type": "text", "text": ""}]},
        {"content": [{"type": "text", "text": "```\nGRADE: C\n```"}]},
        {"stop_reason": "refusal"}, {"stop_reason": "stop_sequence"}, {"stop_reason": "pause_turn"}, {"stop_reason": "something_new"},
        {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "toolu_1", "name": "t", "input": {}}]},
        # only the exact word is a cut: no other spelling is asked again
        {"stop_reason": "MAX_TOKENS"},
        {"content": [{"type": "text", "text": "GRADE"}, {"type": "text", "text": ": C"}]},
    ]
    for over in replies:
        SERVER.reset("ok", over)
        with Waits() as w:
            ev = record_of(call(make(max_reasks=3)))
        assert len(SERVER.requests) == 1 and w.seen == [], (over, len(SERVER.requests))
        assert ev["reask"] == {"max": 3, "earlier": []} and ev["stopReason"] == over.get("stop_reason", "end_turn"), (over, ev["reask"], ev["stopReason"])


@check('"max_tokens " with a trailing space is not a cut reply and not a recordable stop: it ends the slot after one request, where it used to be recorded')
def _():
    SERVER.reset("ok", {"stop_reason": "max_tokens "})
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=3)))
    assert isinstance(e, ValueError) and str(e).startswith("grader: the response stop_reason is not one printable line"), str(e)
    assert len(SERVER.requests) == 1 and w.seen == [], len(SERVER.requests)


@check("the bound holds on cut replies: max_reasks 2 and three cut replies give exactly 3 requests")
def _():
    for bound in [0, 1, 2, 3]:
        SERVER.reset("cut")
        with Waits() as w:
            out = call(make(max_reasks=bound))
        ev = record_of(out)
        assert len(SERVER.requests) == 1 + bound and w.seen == [], (bound, len(SERVER.requests))
        assert ev["stopReason"] == "max_tokens" and out.choices[0].stop_reason == "max_tokens" and ev["reask"]["max"] == bound
        assert [e["reason"] for e in ev["reask"]["earlier"]] == ["truncated"] * bound
        ids = [e["responseId"] for e in ev["reask"]["earlier"]] + [ev["responseId"]]
        assert len(set(ids)) == 1 + bound, ids
        assert len({r["raw"] for r in SERVER.requests}) == 1


@check("the bound holds with no reply: max_reasks 1 gives exactly 2 requests, and the message lists both asks")
def _():
    import re as _re

    SERVER.reset("529")
    g = make(max_reasks=1)
    with Waits() as w:
        e = error_of(lambda: call(g))
    assert len(SERVER.requests) == 2 and w.seen == [2], (len(SERVER.requests), w.seen)
    assert isinstance(e, ValueError)
    assert _re.fullmatch(
        rf"grader: the endpoint answered status 529; no reply after 2 asks, the bound of 1 re-ask\(s\) is used up: "
        rf"ask 1 \(callSeq (\d+), callId {UUID}\): server-error, the endpoint answered status 529; "
        rf"ask 2 \(callSeq (\d+), callId {UUID}\): server-error, the endpoint answered status 529", str(e)), str(e)
    m = _re.findall(r"callSeq (\d+)", str(e))
    # the two numbers are used up: the next slot takes the one after them
    SERVER.reset()
    assert record_of(call(g))["callSeq"] == int(m[1]) + 1
    # a cut ask before the failures is listed too, by its response id, and never by its text
    SERVER.reset("500", script=["cut"])
    with Waits():
        e = error_of(lambda: call(make(max_reasks=2)))
    assert len(SERVER.requests) == 3
    assert "no reply after 3 asks, the bound of 2 re-ask(s) is used up" in str(e) and "truncated, response msg_cut_0001" in str(e), str(e)
    assert "CUT-REPLY-TEXT" not in str(e) and "SECRET-BODY-TEXT" not in str(e)


@check("max_reasks 0 is the grader as it was: a 500 raises after one request, a cut reply is returned after one request")
def _():
    SERVER.reset("500")
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=0)))
    assert str(e) == "grader: the endpoint answered status 500" and len(SERVER.requests) == 1 and w.seen == [], (str(e), len(SERVER.requests))
    SERVER.reset("cut")
    out = call(make(max_reasks=0))
    ev = record_of(out)
    assert len(SERVER.requests) == 1 and ev["stopReason"] == "max_tokens" and ev["reask"] == {"max": 0, "earlier": []}
    assert out.completion == "CUT-REPLY-TEXT GRA"
    SERVER.reset("drop")
    e = error_of(lambda: call(make(max_reasks=0)))
    assert isinstance(e, ValueError) and str(e).startswith("grader: transport error (") and len(SERVER.requests) == 1, str(e)


@check("callSeq over every ask of concurrent calls (ten threads, some slots asked twice) is a run of consecutive numbers, each once")
def _():
    SERVER.reset(script=["cut"] * 6)
    g = make(max_reasks=3)
    outs: list[Any] = []
    lock = threading.Lock()

    def work() -> None:
        o = call(g)
        with lock:
            outs.append(o)

    with Waits():
        ts = [threading.Thread(target=work) for _ in range(10)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    recs = [record_of(o) for o in outs]
    seqs = sorted(s for r in recs for s in [*[e["callSeq"] for e in r["reask"]["earlier"]], r["callSeq"]])
    assert len(seqs) == 16 and seqs == list(range(seqs[0], seqs[0] + 16)), seqs
    ids = [i for r in recs for i in [*[e["callId"] for e in r["reask"]["earlier"]], r["callId"]]]
    assert len(set(ids)) == 16 and len(SERVER.requests) == 16
    for r in recs:
        own = [*[e["callSeq"] for e in r["reask"]["earlier"]], r["callSeq"]]
        assert own == sorted(own), own
    assert all(r["stopReason"] == "end_turn" for r in recs)


@check("the tool's cancellation during a wait ends the slot: no further request")
def _():
    SERVER.reset("529")
    g = make(max_reasks=3)

    async def run() -> None:
        task = asyncio.ensure_future(g.generate([ChatMessageUser(content="x")], [], "none", g_config(g)))
        await asyncio.sleep(0.3)
        task.cancel()
        try:
            await task
            raise AssertionError("the call returned")
        except asyncio.CancelledError:
            pass

    t0 = time.monotonic()
    asyncio.run(run())
    assert time.monotonic() - t0 < 1.5
    assert len(SERVER.requests) == 1, len(SERVER.requests)


@check('usage is two integers, or "ABSENT"; one counter without the other, or a malformed one, raises')
def _():
    for usage, expected in [
        ({"input_tokens": 9, "output_tokens": 4}, {"input_tokens": 9, "output_tokens": 4}),
        ({"input_tokens": 0, "output_tokens": 0}, {"input_tokens": 0, "output_tokens": 0}),
        ({"input_tokens": 9, "output_tokens": 4, "cache_read_input_tokens": 3, "output_tokens_details": {"thinking_tokens": 2}}, {"input_tokens": 9, "output_tokens": 4}),
        ({}, "ABSENT"),
        ({"output_tokens_details": {"thinking_tokens": 2}}, "ABSENT"),
    ]:
        SERVER.reset("ok", {"usage": usage})
        out = call(make())
        assert record_of(out)["usage"] == expected, (usage, record_of(out)["usage"])
        assert (out.usage is None) == (expected == "ABSENT")
    for usage in [{"input_tokens": 9}, {"output_tokens": 4}, {"input_tokens": -1, "output_tokens": 4}, {"input_tokens": 1.5, "output_tokens": 4},
                  {"input_tokens": "9", "output_tokens": 4}, {"input_tokens": 9, "output_tokens": None}, {"input_tokens": True, "output_tokens": 4}, {"input_tokens": 2**53, "output_tokens": 4}]:
        SERVER.reset("ok", {"usage": usage})
        e = error_of(lambda: call(make()))
        assert "the token usage is malformed" in str(e), (usage, str(e))


@check("no detail text and no error message holds the key; the record of a re-asked slot holds no null")
def _():
    SERVER.reset(script=["503", "drop", "cut"])
    with Waits():
        out = call(make(max_reasks=3))
    ev = record_of(out)
    assert [e["reason"] for e in ev["reask"]["earlier"]] == ["server-error", "transport", "truncated"], ev["reask"]
    assert KEY not in json.dumps(ev) and KEY not in out.model_dump_json()
    assert json.loads(json.dumps(ev)) == ev and not has_null(ev)
    SERVER.reset("drop")
    with Waits():
        e = error_of(lambda: call(make(max_reasks=1)))
    assert "no reply after 2 asks" in str(e) and KEY not in str(e) and KEY not in repr(e)


@check("max_retries, timeout and attempt_timeout in the generation settings refuse before any request")
def _():
    SERVER.reset()
    for name, value in [("max_retries", 2), ("timeout", 30), ("attempt_timeout", 30)]:
        # at construction: the grader cannot be built with it
        try:
            rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8, **{name: value}), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0, api_key_env=KEY_ENV)
            raise AssertionError(f"{name}: constructed")
        except ValueError as e:
            assert name in str(e) and "does not send" in str(e), (name, str(e))
        # and at the call: the tool cannot hand it for one call either
        g = make(max_reasks=3)
        e = error_of(lambda: call(g, config=GenerateConfig(max_tokens=64, **{name: value})))
        assert name in str(e) and "does not send" in str(e), (name, str(e))
    assert len(SERVER.requests) == 0


@check("regrade.py: --max-reasks is required for a run, refused with --check, and 4, -1 and x are usage errors")
def _():
    import io
    from contextlib import redirect_stderr

    import regrade

    base = ["--log", "no-such-log.json", "--epochs", "1", "--judge-model", "m", "--max-tokens", "5", "--out-dir", "no-such-dir", "--base-url", "http://127.0.0.1:1", "--wire", WIRE, "--thinking", "NOT_SENT", "--effort", "NOT_SENT"]

    def code(args: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with redirect_stderr(err):
            return regrade.main(args), err.getvalue()

    c, msg = code(base)
    assert c == 64 and "--max-reasks" in msg, (c, msg)
    for bad in ["4", "-1", "x", "1.5", "", " 1", "01", "10", "٣", "+1"]:
        c, msg = code(base + ["--max-reasks", bad])
        assert c == 64 and "--max-reasks must be an integer from 0 to 3" in msg, (bad, c, msg)
    c, msg = code(base + ["--max-reasks", "1", "--max-reasks", "2"])
    assert c == 64 and "--max-reasks" in msg, (c, msg)
    c, msg = code(["--log", "x.json", "--epochs", "1", "--check", "--max-reasks", "0"])
    assert c == 64 and "--check" in msg, (c, msg)
    # a stated bound in range gets past the flags: the next refusal is the log that does not exist
    for good in ["0", "1", "2", "3"]:
        c, msg = code(base + ["--max-reasks", good])
        assert c == 2 and "source log" in msg, (good, c, msg)


# ---- the status before the body, the short body, the key, the cut reply's hash -----------------------------------------


@check("a 400, 401 or 307 whose body stalls is judged by its status: one request, no wait for the body, never a timeout")
def _():
    for status in ["400", "401", "403", "307", "302"]:
        SERVER.reset(f"stallbody-{status}")
        t0 = time.monotonic()
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3, timeout_ms=1500)))
        dt = time.monotonic() - t0
        assert str(e) == f"grader: the endpoint answered status {status}", (status, str(e))
        assert len(SERVER.requests) == 1 and w.seen == [], (status, len(SERVER.requests), w.seen)
        assert dt < 1.0, (status, dt)


@check("a 529 or a 429 whose body stalls is a server error or a rate limit by its status, not a timeout")
def _():
    for status, reason in [("529", "server-error"), ("429", "rate-limited")]:
        SERVER.reset(script=[f"stallbody-{status}"])
        t0 = time.monotonic()
        with Waits() as w:
            ev = record_of(call(make(max_reasks=1, timeout_ms=1500)))
        assert time.monotonic() - t0 < 1.0
        e = ev["reask"]["earlier"][0]
        assert (e["reason"], e["httpStatus"]) == (reason, int(status)) and len(SERVER.requests) == 2 and w.seen == [2], (e, len(SERVER.requests))


@check("a status 200 whose body ends before its declared length is a transport error and is asked again, even when the part sent is a whole reply")
def _():
    for mode in ["short", "short-whole"]:
        SERVER.reset(script=[mode])
        with Waits() as w:
            ev = record_of(call(make(max_reasks=1)))
        e = ev["reask"]["earlier"][0]
        assert (e["reason"], e["httpStatus"], e["detail"]) == ("transport", "NO_RESPONSE", "transport error (IncompleteRead)"), (mode, e)
        assert len(SERVER.requests) == 2 and w.seen == [2] and ev["responseId"] == "msg_selftest_0002", (mode, len(SERVER.requests), ev["responseId"])
        # with a bound of 0 it raises, and the short body is never taken as the reply
        SERVER.reset(mode)
        err = error_of(lambda: call(make(max_reasks=0)))
        assert str(err) == "grader: transport error (IncompleteRead)" and len(SERVER.requests) == 1, (mode, str(err))


@check("a declared length above the cap is refused at once, with no wait for the body, and never asked again")
def _():
    SERVER.reset("huge")
    t0 = time.monotonic()
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=3, timeout_ms=1500)))
    assert str(e) == "grader: the response is larger than the cap" and time.monotonic() - t0 < 1.0, (str(e), time.monotonic() - t0)
    assert len(SERVER.requests) == 1 and w.seen == []


@check("a content encoding the request did not ask for is refused and never asked again; identity is taken")
def _():
    SERVER.reset("gzip-header")
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=3)))
    assert str(e) == "grader: the response is in a content encoding the request did not ask for" and len(SERVER.requests) == 1 and w.seen == [], str(e)
    assert SERVER.requests[0]["headers"].get("accept-encoding") == "identity", SERVER.requests[0]["headers"]
    SERVER.reset("identity-header")
    assert record_of(call(make()))["stopReason"] == "end_turn"


@check("a body that is not UTF-8, or opens with a byte-order mark, is not JSON and is never asked again")
def _():
    for mode in ["badutf8", "bom"]:
        SERVER.reset(mode)
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert str(e) == "grader: the response is not JSON" and len(SERVER.requests) == 1 and w.seen == [], (mode, str(e))


@check("a key with a line feed, a carriage return, a space, a control character or a non-ASCII character is refused before any request, and never echoed")
def _():
    import io
    import traceback

    name = "SELFTEST_BAD_KEY"
    for bad in [KEY + "\n", KEY + "\r", KEY + "\r\n", "\n" + KEY, KEY[:10] + "\n" + KEY[10:], KEY + " ", " " + KEY, KEY + "\t", KEY + "\x01", KEY + "\x7f", KEY + "\u00e9", KEY + "\u2713", "\n"]:
        os.environ[name] = bad
        try:
            SERVER.reset()
            g = make(max_reasks=3, api_key_env=name)
            with Waits() as w:
                e = error_of(lambda: call(g))
            assert isinstance(e, ValueError) and str(e).startswith("grader: the key in the variable named in api_key_env holds a character that is not visible ASCII"), (repr(bad), str(e))
            shown = io.StringIO()
            traceback.print_exception(type(e), e, e.__traceback__, file=shown)
            for text in [str(e), repr(e), shown.getvalue()]:
                assert KEY not in text and KEY[:10] not in text and KEY[10:] not in text, repr(bad)
            assert len(SERVER.requests) == 0 and w.seen == [], (repr(bad), len(SERVER.requests))
        finally:
            del os.environ[name]
    # every visible ASCII character is taken
    os.environ[name] = "".join(chr(c) for c in range(0x21, 0x7F))
    try:
        SERVER.reset()
        call(make(api_key_env=name))
        assert SERVER.requests[0]["headers"]["x-api-key"] == os.environ[name]
    finally:
        del os.environ[name]


@check("a cut ask records the sha256 and the UTF-8 length of the text that was cut, and never the text")
def _():
    for text, n in [("CUT-REPLY-TEXT GRA", 18), ("", 0), ("é✓ GRA", 9), ("a\nb", 3)]:
        SERVER.reset("ok", script=["cut-with"])
        SERVER.cut_text = text
        with Waits():
            out = call(make(max_reasks=1))
        e = record_of(out)["reask"]["earlier"][0]
        assert (e["replySha256"], e["replyUtf8Bytes"]) == (hashlib.sha256(text.encode("utf-8")).hexdigest(), n), (text, e)
        assert text == "" or text not in out.model_dump_json()
    # two text blocks are hashed as the joined text, which is what a last ask would have recorded as its reply
    SERVER.reset("ok", script=["cut-two-blocks"])
    with Waits():
        e = record_of(call(make(max_reasks=1)))["reask"]["earlier"][0]
    assert (e["replySha256"], e["replyUtf8Bytes"], e["contentTypes"]) == (sha("GRADE: C"), 8, ["text", "text"]), e


@check("a cut reply that holds an unpaired surrogate has no hash: the slot ends and is not asked again")
def _():
    SERVER.reset("ok", script=["cut-surrogate"])
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=3)))
    assert isinstance(e, ValueError) and str(e) == "grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own", str(e)
    assert len(SERVER.requests) == 1 and w.seen == []



@check("timeout_ms is at most 3600000 (one hour): a larger value raises when the grader is built, in the JavaScript grader's words, before any request")
def _():
    SERVER.reset()
    words = "grader: timeout_ms must be a positive integer of at most 3600000 (one hour)"
    assert rg.MAX_TIMEOUT_MS == 3600000
    for v in [3600001, 2**31 - 1, 2**31, 2**53, 10**30, 0, -1, 1.5, "60000", True]:
        e = error_of(lambda v=v: make(timeout_ms=v))
        assert isinstance(e, ValueError) and str(e) == words, (v, str(e))
    assert len(SERVER.requests) == 0
    out = call(make(timeout_ms=3600000))
    assert record_of(out)["callShape"]["timeoutMs"] == 3600000 and len(SERVER.requests) == 1


@check("a response id that is not 1 to 200 visible ASCII characters is a malformed reply: raised after one request, never asked again, never shown")
def _():
    words = "grader: the response id is not 1 to 200 visible ASCII characters with no space; it is not shown"
    hostile = ["msg_1\nREFUSED forged line", "msg_1\r", "msg_\u001b[2J\u001b[31mRED", "msg_1\u0000", "msg_1\u007f", "msg 1", " msg_1", "msg_1\t",
               "msg_\u00e9", "msg_\u2713", "msg_\u202e1", "m" * 201]
    for stop in ("end_turn", "max_tokens"):
        for bad in hostile:
            SERVER.reset("ok", {"id": bad, "stop_reason": stop})
            with Waits() as w:
                e = error_of(lambda: call(make(max_reasks=3)))
            assert isinstance(e, ValueError) and str(e) == words, (stop, bad, str(e))
            assert bad not in str(e) and len(SERVER.requests) == 1 and w.seen == [], (stop, bad, len(SERVER.requests))
    every = "".join(chr(c) for c in range(0x21, 0x7F))
    for good in ["m", "m" * 200, every]:
        SERVER.reset("ok", {"id": good})
        assert record_of(call(make()))["responseId"] == good, good


@check("a model name or an API version the importer would refuse is refused at construction, before any request; a served model, id or stop reason it would refuse ends the slot")
def _():
    SERVER.reset()
    gaps = ["UNKNOWN", "unknown", "N/A", "none", "null", "NOT_SENT", "not-sent", "Undefined"]
    not_a_line = ["judge\nforged line", "judge\r", "judge\u001b[2J", "judge\tid", "judge  id", " judge", "judge ", "judg\u00e9", "j" * 201]
    for name in gaps + not_a_line:
        e = error_of(lambda name=name: rg.RecordingGrader(name, base_url=SERVER.url, config=GenerateConfig(max_tokens=8), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0, api_key_env=KEY_ENV))
        assert isinstance(e, ValueError) and str(e).startswith("grader: the model name must be one printable line"), (name, str(e))
        if name not in gaps:
            assert name not in str(e), name
    for v in gaps + ["2023-06-01\u0001", "2023-06-01\u007f", "2023\u00e9", "v" * 201]:
        e = error_of(lambda v=v: make(api_version=v))
        assert isinstance(e, ValueError) and str(e).startswith("grader: api_version must be "), (v, str(e))
        if v not in gaps:
            assert v not in str(e), v
    # a value that holds white space is a non-empty string: it is refused with the reason that is true of it
    for v in ["a b", "2023-06-01\n", " 2023-06-01", "2023\t06"]:
        e = error_of(lambda v=v: make(api_version=v))
        assert isinstance(e, ValueError) and str(e) == "grader: api_version must be 1 to 200 visible ASCII characters with no space that do not read as unknown; the value is not shown", (v, str(e))
    for v in ["", 7]:
        e = error_of(lambda v=v: make(api_version=v))
        assert isinstance(e, ValueError) and str(e) == "grader: api_version must be a non-empty string", (v, str(e))
    assert len(SERVER.requests) == 0
    # a plain id, one with single spaces and one of 200 characters are taken; so is a plain API version
    for name in ["judge-requested", "claude-judge 2026", "j" * 200]:
        rg.RecordingGrader(name, base_url=SERVER.url, config=GenerateConfig(max_tokens=8), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0, api_key_env=KEY_ENV)
    make(api_version="2024-01-01")
    # the grader's gap spellings are the library's list (src/identity.ts, GAP_SPELLINGS)
    assert rg.GAP_SPELLINGS == {"unknown", "na", "none", "null", "nil", "undefined", "notsent"}
    # a served model, an id or a stop reason of a form the importer refuses: raised after one request, whatever the bound, and shown nowhere
    for field, bad in [("model", "judge served"), ("model", "judge\nforged"), ("model", "judge\u001b[2J"), ("model", "judg\u00e9"), ("model", "m" * 201), ("model", "unknown"),
                       ("stop_reason", "end turn\nforged"), ("stop_reason", "end_turn\r"), ("stop_reason", "end  turn"), ("stop_reason", "s" * 201), ("stop_reason", "none"),
                       ("id", "unknown"), ("id", "N/A")]:
        SERVER.reset("ok", {field: bad})
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert isinstance(e, ValueError) and str(e).startswith("grader: the response "), (field, bad, str(e))
        assert len(SERVER.requests) == 1 and w.seen == [], (field, bad, len(SERVER.requests))
        if bad not in ("unknown", "none", "N/A"):
            assert bad not in str(e), (field, bad)



def _regrade_main(extra: list[str], source: str | None = None, out_dir: str | None = None, check: bool = False, reasks: int = 0) -> tuple[int, str, str]:
    """regrade.main on the source log, against the selftest server, with stdout and stderr taken."""
    import io
    from contextlib import redirect_stderr, redirect_stdout

    import regrade

    src = source or os.path.join(HERE, "fixtures", "source.json")
    args = ["--log", src, "--epochs", "1"] if check else ["--log", src, "--epochs", "1", "--judge-model", "fake-judge", "--max-tokens", "64", "--api-key-env", KEY_ENV,
                                                          "--wire", WIRE, "--thinking", "NOT_SENT", "--effort", "NOT_SENT", "--max-reasks", str(reasks)]
    if out_dir is not None:
        args += ["--out-dir", out_dir]
    # a flag that `extra` states is taken out of the helper's own list with its value: the script takes every flag once
    args = [x for i, x in enumerate(args) if not ((x.startswith("--") and x in extra) or (i > 0 and args[i - 1].startswith("--") and args[i - 1] in extra))]
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = regrade.main(args + extra)
    return code, out.getvalue(), err.getvalue()


@check("regrade.py: --base-url is required for a run, and --go-on-and-count is refused with --check")
def _():
    import tempfile

    SERVER.reset()
    with tempfile.TemporaryDirectory() as tmp:
        c, _out, err = _regrade_main([], out_dir=os.path.join(tmp, "o"))
        assert c == 64 and "--base-url" in err and "a run needs" in err, (c, err)
        assert not os.path.exists(os.path.join(tmp, "o")) and len(SERVER.requests) == 0
    c, _out, err = _regrade_main(["--check", "--go-on-and-count"], check=True)
    assert c == 64 and "--check" in err, (c, err)


@check("regrade.py --check refuses a data marker in a question, an answer or a criterion, and a template with a stray brace, as the importer does; no request")
def _():
    import tempfile

    SERVER.reset()
    src = os.path.join(HERE, "fixtures", "source.json")
    with open(src, encoding="utf-8") as f:
        log = json.load(f)
    c, out, err = _regrade_main(["--check"], check=True)
    assert c == 0, (c, err)
    for field, where in (("input", "question"), ("target", "criterion")):
        for marker in ("[BEGIN DATA]", "[end data]"):
            edited = json.loads(json.dumps(log))
            edited["samples"][1][field] += " " + marker
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "edited.json")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(edited, f)
                c, out, err = _regrade_main(["--check"], source=path, check=True)
                assert c == 2 and "data marker" in err and "sample" in err, (field, marker, c, err)
    edited = json.loads(json.dumps(log))
    edited["samples"][0]["output"]["completion"] += " [BEGIN DATA]"
    edited["samples"][0]["output"]["choices"][0]["message"]["content"] += " [BEGIN DATA]"
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "edited.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(edited, f)
        c, out, err = _regrade_main(["--check"], source=path, check=True)
        assert c == 2 and "data marker" in err, (c, err)
        for text in ("{question} {answer} {criterion} {instructions} {", "{{question}} {answer} {criterion} {instructions}", "{question!r} {answer} {criterion} {instructions}", "{other} {answer}"):
            t = os.path.join(tmp, "template.txt")
            with open(t, "w", encoding="utf-8") as f:
                f.write(text)
            c, out, err = _regrade_main(["--check", "--template-file", t], check=True)
            assert c == 2 and "template text holds a brace" in err, (text, c, err)
        t = os.path.join(tmp, "template.txt")
        with open(t, "w", encoding="utf-8") as f:
            f.write("Q {question} A {answer} C {criterion} {instructions}")
        c, out, err = _regrade_main(["--check", "--template-file", t], check=True)
        assert c == 0, (c, err)
    assert len(SERVER.requests) == 0


@check("regrade.py: a key that is not visible ASCII is refused before the log directory exists, with no request and the key not shown")
def _():
    import tempfile

    SERVER.reset()
    saved = os.environ[KEY_ENV]
    try:
        for bad in (KEY + "\n", KEY + " x", KEY + "\u00e9", "\t" + KEY):
            os.environ[KEY_ENV] = bad
            with tempfile.TemporaryDirectory() as tmp:
                out_dir = os.path.join(tmp, "o")
                c, _out, err = _regrade_main(["--base-url", SERVER.url], out_dir=out_dir)
                assert c == 64 and "not visible ASCII" in err and KEY not in err, (c, err)
                assert not os.path.exists(out_dir) and len(SERVER.requests) == 0, bad
    finally:
        os.environ[KEY_ENV] = saved


@check("regrade.py: the re-grade stops at the first slot the importer will refuse (one request, exit 2), and with --go-on-and-count calls every slot, counts them and exits 0")
def _():
    import tempfile

    # every reply is cut at the output cap: the last ask did not stop with end_turn
    SERVER.reset("cut")
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
        assert c == 2, (c, out, err)
        assert len(SERVER.requests) == 1, len(SERVER.requests)
        assert "REFUSED the re-grade stopped at the first slot the importer will refuse" in err and '"max_tokens", not "end_turn"' in err, err
        assert "slots the importer will refuse" not in out
    SERVER.reset("cut")
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url, "--go-on-and-count"], out_dir=os.path.join(tmp, "o"))
        assert c == 0, (c, out, err)
        assert len(SERVER.requests) == 3, len(SERVER.requests)
        assert "slots the importer will refuse: 3 (the importer will refuse this log: " in out, out
    # a reply with no strict reading is a slot the importer refuses as well
    SERVER.reset("ok", {"content": [{"type": "text", "text": "Reasoning with no grade line."}]})
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
        assert c == 2 and len(SERVER.requests) == 1 and "no strict reading" in err, (c, err, len(SERVER.requests))
    # a good run prints the count with a zero too
    SERVER.reset()
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
        assert c == 0 and len(SERVER.requests) == 3 and "slots the importer will refuse: 0" in out, (c, out, err)
    # the strict reading is the importer's: the last non-empty line, exactly GRADE: and one capital letter; JavaScript's white space
    import regrade

    assert regrade.strict_grade("x\nGRADE: C\n\n") == "C" and regrade.strict_grade("GRADE: C\nthen prose") is None and regrade.strict_grade("GRADE:  C") is None
    assert regrade.strict_grade("GRADE: C\n\ufeff\n") == "C" and regrade.strict_grade("GRADE: C\n\x1c") is None and regrade.strict_grade("") is None
    assert regrade.strict_grade("GRADE: c") is None and regrade.strict_grade("GRADE: CI") is None



@check("regrade.py: a slot whose call raises (a served model id with a space, a response id of another form, a status 500) ends the re-grade at that slot: one request, exit 2, with --go-on-and-count too")
def _():
    import tempfile

    lost = (("ok", {"model": "bad id"}), ("ok", {"id": "msg 1"}), ("500", None))
    for mode, response in lost:
        for extra in ([], ["--go-on-and-count"]):
            SERVER.reset(mode, response)
            with tempfile.TemporaryDirectory() as tmp:
                c, out, err = _regrade_main(["--base-url", SERVER.url, *extra], out_dir=os.path.join(tmp, "o"))
            assert c == 2, (mode, response, extra, c, out, err)
            assert len(SERVER.requests) == 1, (mode, response, extra, len(SERVER.requests))
            assert "REFUSED the re-grade stopped at the first slot whose call failed" in err and "No later slot was called" in err, err
            assert "slots the importer will refuse" not in out, out


class YieldingWaits:
    """Replaces the grader's wait between two asks by a short real one that hands control back to the event loop, as the
    real wait does: the tool can start the other samples' grader calls during it. `seen` lists the seconds asked for."""

    def __enter__(self) -> "YieldingWaits":
        import asyncio

        self.real = rg._wait
        self.seen: list[float] = []

        async def short(seconds: float) -> None:
            self.seen.append(seconds)
            await asyncio.sleep(0.3)

        rg._wait = short
        return self

    def __exit__(self, *exc: Any) -> None:
        rg._wait = self.real


@check("regrade.py: a slot that gets no reply within a bound of 1 or 2 re-asks (status 500, status 429, a dropped connection) ends the re-grade at that slot: 1 plus the bound requests, exit 2, with --go-on-and-count too")
def _():
    import tempfile

    for mode in ("500", "429", "drop"):
        for bound in (1, 2):
            for extra in ([], ["--go-on-and-count"]):
                SERVER.reset(mode)
                with YieldingWaits() as w, tempfile.TemporaryDirectory() as tmp:
                    c, out, err = _regrade_main(["--base-url", SERVER.url, *extra], out_dir=os.path.join(tmp, "o"), reasks=bound)
                assert c == 2, (mode, bound, extra, c, out, err)
                # the one lost slot was asked 1 + bound times, with a wait before each re-ask, and no other slot was asked at all
                assert len(SERVER.requests) == 1 + bound, (mode, bound, extra, len(SERVER.requests))
                assert len(w.seen) == bound, (mode, bound, extra, w.seen)
                assert "REFUSED the re-grade stopped at the first slot whose call failed" in err and "No later slot was called" in err, err
                assert "slots the importer will refuse" not in out, out


@check("regrade.py: one sample whose slot gets a status 500 on every ask, the other samples clean, a bound of 1: the first slot is asked twice and no other slot is asked; marked last, the two clean slots are asked once each before it")
def _():
    import tempfile

    with open(os.path.join(HERE, "fixtures", "source.json"), encoding="utf-8") as f:
        log = json.load(f)
    assert len(log["samples"]) == 3
    for marked, requests in ((0, 2), (2, 4)):
        edited = json.loads(json.dumps(log))
        edited["samples"][marked]["output"]["completion"] += " [[selftest:500]]"
        edited["samples"][marked]["output"]["choices"][0]["message"]["content"] += " [[selftest:500]]"
        SERVER.reset("500-if-marked")
        with YieldingWaits() as w, tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "edited.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(edited, f)
            c, out, err = _regrade_main(["--base-url", SERVER.url], source=path, out_dir=os.path.join(tmp, "o"), reasks=1)
        assert c == 2, (marked, c, out, err)
        assert len(SERVER.requests) == requests, (marked, len(SERVER.requests))
        failed = [b"[[selftest:500]]" in r["raw"] for r in SERVER.requests]
        assert failed == [False] * (requests - 2) + [True, True], (marked, failed)
        assert w.seen == [2], (marked, w.seen)
        assert "REFUSED the re-grade stopped at the first slot whose call failed" in err and "No later slot was called" in err, err


@check("regrade.py: --judge-model UNKNOWN, --api-version UNKNOWN and a model name that is not one printable line make no request and leave no log directory")
def _():
    import tempfile

    SERVER.reset()
    for extra in (["--judge-model", "UNKNOWN"], ["--judge-model", "none"], ["--judge-model", "j" * 201], ["--api-version", "UNKNOWN"], ["--api-version", "n/a"]):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = os.path.join(tmp, "o")
            # the helper takes its own model flag out when `extra` states one
            code, _out, err = _regrade_main(["--base-url", SERVER.url, *extra], out_dir=out_dir)
            assert code == 64, (extra, code, err)
            assert err.startswith("usage error: the grader refused its settings") and "was given twice" not in err, (extra, err)
            assert not os.path.exists(out_dir) and len(SERVER.requests) == 0, extra


# ---- a slot that ends with no record, the base URL's path, the deadline's text, the cache -----------------------------


@check("a slot that ends with no record after an earlier ask lists every ask of the slot in the error text; a slot that ends on its first ask is raised as it came")
def _():
    import re as _re

    seconds = (
        ("400", "grader: the endpoint answered status 400"),
        ("307", "grader: the endpoint answered status 307"),
        ("notjson", "grader: the response is not JSON"),
        ("noid", "grader: the response lacks id, model, stop_reason or content"),
        ("gzip-header", "grader: the response is in a content encoding the request did not ask for"),
        ("cut-surrogate", "grader: the cut reply holds an unpaired surrogate; it has no UTF-8 bytes of its own"),
    )
    for second, words in seconds:
        SERVER.reset(script=["cut", second])
        with Waits() as w:
            e = error_of(lambda: call(make(max_reasks=3)))
        assert len(SERVER.requests) == 2 and w.seen == [], (second, len(SERVER.requests), w.seen)
        tail = rf"; the slot ends with no record after 2 asks: ask 1 \(callSeq \d+, callId {UUID}\): truncated, response msg_cut_0001; ask 2 \(callSeq \d+, callId {UUID}\): ended the slot"
        assert _re.fullmatch(_re.escape(words) + tail, str(e)), (second, str(e))
        assert "CUT-REPLY-TEXT" not in str(e) and "SECRET-BODY-TEXT" not in str(e) and KEY not in str(e), str(e)
    # an ask with no reply, then a status that is never asked again
    SERVER.reset(script=["529", "403"])
    with Waits() as w:
        e = error_of(lambda: call(make(max_reasks=1)))
    assert len(SERVER.requests) == 2 and w.seen == [2], (len(SERVER.requests), w.seen)
    assert _re.fullmatch(
        rf"grader: the endpoint answered status 403; the slot ends with no record after 2 asks: ask 1 \(callSeq \d+, callId {UUID}\): server-error, the endpoint answered status 529; ask 2 \(callSeq \d+, callId {UUID}\): ended the slot",
        str(e),
    ), str(e)
    # the two call numbers in the text are consecutive, and the next slot takes the one after them
    a, b = (int(n) for n in _re.findall(r"callSeq (\d+)", str(e)))
    SERVER.reset()
    assert b == a + 1 and record_of(call(make()))["callSeq"] >= b + 1
    # a slot that ends on its first ask: the failure as it came, with no list
    SERVER.reset("400")
    assert str(error_of(lambda: call(make(max_reasks=3)))) == "grader: the endpoint answered status 400"


@check("the base URL's path holds plain segments only: a dot segment, an empty segment, a percent escape and any other character are refused before any request, in one wording; an address with no // is refused")
def _():
    SERVER.reset()
    u = SERVER.url
    paths = ["/a/../b", "/a/./b", "/..", "/.", "/a//b", "//a", "/a%20b", "/a%2e%2e/b", "/a;b", "/a:b", "/café", "/a,b", "/a+b", "/a=b", "/a&b", "/a!b", "/a'b", "/a(b)", "/a*b", "/a$b",
             "/a[b]", "/a|b", '/a"b', "/a<b", "/a^b", "/a`b", "/a{b}"]
    for p in paths:
        for url in (u + p, u + p + "/"):
            e = error_of(lambda url=url: make(base_url=url))
            assert str(e) == "grader: base_url path must hold plain segments only", (url, str(e))
    assert "secret-token" not in str(error_of(lambda: make(base_url=u + "/secret-token;x")))
    for url in ("https:api.example.com", "https:/api.example.com", "http:127.0.0.1:1"):
        assert raises(lambda url=url: make(base_url=url)), url
    for p, posted in (("", "/v1/messages"), ("/", "/v1/messages"), ("/proxy", "/proxy/v1/messages"), ("/a/b.c/d_e~f-g/", "/a/b.c/d_e~f-g/v1/messages"), ("/base//", "/base/v1/messages"), ("/...", "/.../v1/messages")):
        assert make(base_url=u + p).url == u + posted, p
    assert len(SERVER.requests) == 0


@check("the text of a passed deadline gives the milliseconds as an integer, for any deadline the grader takes")
def _():
    for ms in (1, 150, 60000, 999999, 1000000, 1234567, 3600000):
        assert str(rg._deadline(ms)) == f"grader: the call passed its deadline of {ms} ms", str(rg._deadline(ms))
    # and as the call raises it, under a bound of 0
    SERVER.reset("sleep")
    e = error_of(lambda: call(make(timeout_ms=150)))
    assert str(e) == "grader: the call passed its deadline of 150 ms", str(e)


@check("a response cache setting is one the grader does not take: cache True and cache False both raise when the grader is built")
def _():
    SERVER.reset()
    for value in (True, False):
        e = error_of(lambda value=value: rg.RecordingGrader("m", base_url=SERVER.url, config=GenerateConfig(max_tokens=8, cache=value), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0, api_key_env=KEY_ENV))
        assert "generation settings the grader does not send" in str(e) and "cache" in str(e), str(e)
    assert len(SERVER.requests) == 0


# ---- regrade.py: the flags, the exit codes, the ids ---------------------------------------------------------------------


def _regrade_plain(args: list[str]) -> tuple[int, str, str]:
    """regrade.main on exactly these arguments, with stdout and stderr taken."""
    import io
    from contextlib import redirect_stderr, redirect_stdout

    import regrade

    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = regrade.main(args)
    return code, out.getvalue(), err.getvalue()


@check("regrade.py: every flag is taken at most once, by its whole name; a second one and a shortened one are usage errors")
def _():
    values = {"--log": "x.json", "--epochs": "1", "--template-file": "t.txt", "--instructions-file": "i.txt", "--judge-model": "m", "--out-dir": "o", "--base-url": "http://127.0.0.1:1",
              "--max-tokens": "5", "--temperature": "0", "--timeout-ms": "1000", "--api-version": "2023-06-01", "--api-key-env": KEY_ENV, "--wire": WIRE, "--thinking": "NOT_SENT", "--effort": "NOT_SENT", "--max-reasks": "0"}
    run = [x for k, v in values.items() for x in (k, v)]
    for flag, value in values.items():
        c, _out, err = _regrade_plain(run + [flag, value])
        assert c == 64 and f"{flag} was given twice" in err, (flag, c, err)
    c, _out, err = _regrade_plain(run + ["--go-on-and-count", "--go-on-and-count"])
    assert c == 64 and "--go-on-and-count was given twice" in err, (c, err)
    c, _out, err = _regrade_plain(["--log", "x.json", "--epochs", "1", "--check", "--check"])
    assert c == 64 and "--check was given twice" in err, (c, err)
    # a shortened flag is not the flag
    for short, whole in (("--base", "--base-url"), ("--judge", "--judge-model"), ("--think", "--thinking"), ("--out", "--out-dir"), ("--api-key", "--api-key-env")):
        args = [short if x == whole else x for x in run]
        c, _out, err = _regrade_plain(args)
        assert c == 64 and "usage error" in err, (short, c, err)


@check("regrade.py: a flag stated with an empty value is a usage error, never the default: --api-key-env, --template-file, --instructions-file, --out-dir, --base-url, --api-version, --log")
def _():
    import tempfile

    SERVER.reset()
    for flag in ("--api-key-env", "--template-file", "--instructions-file", "--out-dir", "--base-url", "--api-version", "--log"):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = os.path.join(tmp, "o")
            base = ["--log", os.path.join(HERE, "fixtures", "source.json"), "--epochs", "1", "--judge-model", "fake-judge", "--max-tokens", "64", "--api-key-env", KEY_ENV,
                    "--wire", WIRE, "--thinking", "NOT_SENT", "--effort", "NOT_SENT", "--max-reasks", "0", "--base-url", SERVER.url, "--out-dir", out_dir]
            # the flag's own pair is taken out, and the flag is stated once, empty
            args = [x for i, x in enumerate(base) if not (x == flag or (i > 0 and base[i - 1] == flag))] + [flag, ""]
            c, _out, err = _regrade_plain(args)
            assert c == 64 and f"{flag} was given an empty value" in err, (flag, c, err)
            assert not os.path.exists(out_dir) and len(SERVER.requests) == 0, flag
    # in a check too
    for flag in ("--template-file", "--instructions-file"):
        c, _out, err = _regrade_plain(["--log", os.path.join(HERE, "fixtures", "source.json"), "--epochs", "1", "--check", flag, ""])
        assert c == 64 and f"{flag} was given an empty value" in err, (flag, c, err)
    c, _out, err = _regrade_plain(["--log", "", "--epochs", "1", "--check"])
    assert c == 64 and "--log was given an empty value" in err, (c, err)


@check("regrade.py: a setting the grader refuses is a usage error (64), with no request and no log directory: a bad --effort, --temperature 2 and 1.5, a base URL the grader does not take (plain http to the name localhost is one), a --timeout-ms beyond one hour")
def _():
    import tempfile

    SERVER.reset()
    for extra in (["--effort", "bogus"], ["--temperature", "2"], ["--temperature", "1.5"], ["--temperature", "1.0000001"], ["--base-url", SERVER.url + "/a/../b"],
                  ["--base-url", "http://example.com"], ["--base-url", f"http://localhost:{SERVER.port}"], ["--timeout-ms", "3600001"], ["--thinking", '{"type":"other"}']):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = os.path.join(tmp, "o")
            base = ["--log", os.path.join(HERE, "fixtures", "source.json"), "--epochs", "1", "--judge-model", "fake-judge", "--max-tokens", "64", "--api-key-env", KEY_ENV,
                    "--wire", WIRE, "--thinking", "NOT_SENT", "--effort", "NOT_SENT", "--max-reasks", "0", "--base-url", SERVER.url, "--out-dir", out_dir]
            args = [x for i, x in enumerate(base) if not (x == extra[0] or (i > 0 and base[i - 1] == extra[0]))] + extra
            c, _out, err = _regrade_plain(args)
            assert c == 64, (extra, c, err)
            assert err.startswith("usage error: the grader refused its settings") and "Nothing was written and no call was made." in err, (extra, err)
            assert "Traceback" not in err and len(err.strip().split("\n")) == 1, (extra, err)
            assert not os.path.exists(out_dir) and len(SERVER.requests) == 0, extra


@check("regrade.py: an --out-dir that cannot be made (a file is in the way) is a usage error on one line, with no request")
def _():
    import tempfile

    SERVER.reset()
    with tempfile.TemporaryDirectory() as tmp:
        blocker = os.path.join(tmp, "a-file")
        with open(blocker, "w", encoding="utf-8") as f:
            f.write("x")
        for out_dir in (blocker, os.path.join(blocker, "under")):
            c, _out, err = _regrade_main(["--base-url", SERVER.url], out_dir=out_dir)
            assert c == 64 and err.startswith("usage error: --out-dir cannot be made") and "no call was made" in err, (out_dir, c, err)
            assert "Traceback" not in err and len(err.strip().split("\n")) == 1, err
    assert len(SERVER.requests) == 0


@check("regrade.py: an eval that raises is exit 2 on one line, and the line says earlier slots may have been sent and paid for")
def _():
    import tempfile

    import inspect_ai

    real = inspect_ai.eval

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("the tool broke\nwith a second line")

    SERVER.reset()
    inspect_ai.eval = broken
    try:
        with tempfile.TemporaryDirectory() as tmp:
            c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
    finally:
        inspect_ai.eval = real
    assert c == 2, (c, out, err)
    assert err.startswith("refused: the eval ended with an error (RuntimeError): the tool broke\\nwith a second line."), err
    assert "may already have been sent and paid for" in err and "Traceback" not in err and len(err.strip().split("\n")) == 1, err


@check("regrade.py: a slot whose call fails says, with its refusal, that the slots before it were sent and paid for")
def _():
    import tempfile

    with open(os.path.join(HERE, "fixtures", "source.json"), encoding="utf-8") as f:
        log = json.load(f)
    edited = json.loads(json.dumps(log))
    edited["samples"][2]["output"]["completion"] += " [[selftest:500]]"
    edited["samples"][2]["output"]["choices"][0]["message"]["content"] += " [[selftest:500]]"
    SERVER.reset("500-if-marked")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "edited.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(edited, f)
        c, out, err = _regrade_main(["--base-url", SERVER.url], source=path, out_dir=os.path.join(tmp, "o"))
    assert c == 2 and len(SERVER.requests) == 3, (c, len(SERVER.requests), err)
    assert "REFUSED the re-grade stopped at the first slot whose call failed" in err and "The slots called before it were sent and are paid for" in err, err
    # a stop at a slot the importer will refuse says the same
    SERVER.reset("cut")
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
    assert c == 2 and "The slots called up to it were sent and are paid for" in err, (c, err)


@check("regrade.py: the check of the source log never ends in a traceback: a sample that lacks a field is a listed problem, and a check that raises is exit 2 on one line")
def _():
    from types import SimpleNamespace

    import regrade

    problems = regrade.source_problems(SimpleNamespace(status="success", samples=[SimpleNamespace(id="a"), SimpleNamespace(id="b", epoch=1, error=None, output=SimpleNamespace(choices=[SimpleNamespace()]), input="q", target="t")]))
    assert any("sample 'a'" in p and "no output" in p for p in problems), problems
    assert any("sample 'b'" in p and "not one string" in p for p in problems), problems
    assert regrade.source_problems(SimpleNamespace()) and regrade.source_problems(None), "a log with no samples is a problem"
    real = regrade.source_problems

    def broken(log: Any) -> list[str]:
        raise AttributeError("'Sample' object has no attribute 'output'")

    regrade.source_problems = broken
    try:
        c, _out, err = _regrade_main(["--check"], check=True)
    finally:
        regrade.source_problems = real
    assert c == 2 and err.startswith("refused: the source log cannot be checked (AttributeError): ") and "Nothing was sent." in err, (c, err)
    assert "Traceback" not in err and len(err.strip().split("\n")) == 1, err


@check('regrade.py: the ids 1 and "1" are two ids that read as one case at import: refused before any request in those words, and never counted as one id that occurs twice')
def _():
    import tempfile

    SERVER.reset()
    with open(os.path.join(HERE, "fixtures", "source.json"), encoding="utf-8") as f:
        log = json.load(f)
    edited = json.loads(json.dumps(log))
    edited["samples"][0]["id"] = 1
    edited["samples"][1]["id"] = "1"
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "edited.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(edited, f)
        c, _out, err = _regrade_main(["--check"], source=path, check=True)
        assert c == 2, (c, err)
        assert "the ids 1 and '1' are equal as strings and differ as values" in err and "the importer refuses" in err, err
        assert "occurs 2 times" not in err, err
        # the same id twice, of one type, is still one id that occurs twice
        edited["samples"][1]["id"] = 1
        with open(path, "w", encoding="utf-8") as f:
            json.dump(edited, f)
        c, _out, err = _regrade_main(["--check"], source=path, check=True)
        assert c == 2 and "id 1 occurs 2 times" in err, (c, err)
    assert len(SERVER.requests) == 0


# ---- the content-encoding header as both graders read it, an interrupted eval, the numeric flags, the log directory -----


# What each response header ends in, as bytes on the wire. The JavaScript grader's tests hold the same table (test/importers.grader.test.ts,
# HEADER_CASES), and one test there runs both graders over it. "record": the reply is taken. "refused": the response is in a content
# encoding, one request, never asked again. "transport": the head is not one the JavaScript platform's parser takes, so there it is a
# failed connection, and here it is one too: asked again within the bound.
HEADER_CASES: list[tuple[bytes, str]] = [
    (b"", "record"),
    (b"content-encoding: identity\r\n", "record"),
    (b"content-encoding: Identity\r\n", "record"),
    (b"content-encoding: IDENTITY\r\n", "record"),
    (b"content-encoding:  identity  \r\n", "record"),
    (b"content-encoding:\tidentity\t\r\n", "record"),
    (b"Content-Encoding: identity\r\n", "record"),
    # a no-break space is white space to JavaScript's trim, and so it is here
    (b"content-encoding: \xa0identity\r\n", "record"),
    (b"content-encoding: identity\xa0\r\n", "record"),
    # a header that is there and empty states an encoding that is not identity
    (b"content-encoding: \r\n", "refused"),
    (b"content-encoding:\r\n", "refused"),
    # byte 0x85 is white space to Python's strip() and not to JavaScript's trim()
    (b"content-encoding: identity\x85\r\n", "refused"),
    (b"content-encoding: \x85identity\r\n", "refused"),
    (b"content-encoding: identit\xe9\r\n", "refused"),
    (b"content-encoding: gzip\r\n", "refused"),
    (b"Content-Encoding: gzip\r\n", "refused"),
    (b"content-encoding: identity, gzip\r\n", "refused"),
    (b"content-encoding: identity\r\ncontent-encoding: identity\r\n", "refused"),
    (b"content-encoding: identity\r\ncontent-encoding: gzip\r\n", "refused"),
    (b"content-encoding: iden\ttity\r\n", "refused"),
    (b"x-note: a\x85\r\ncontent-encoding: gzip\r\n", "refused"),
    (b"x-note: a\x85\r\n", "record"),
    (b"x-note: caf\xe9\xa0\r\n", "record"),
    # a control character in a header, a line with no colon
    (b"content-encoding: \x0bidentity\x0c\r\n", "transport"),
    (b"content-encoding: iden\x0btity\r\n", "transport"),
    (b"content-encoding: identity\x0c\r\n", "transport"),
    (b"content-encoding: identity\x1c\r\n", "transport"),
    (b"content-encoding: identity\x00\r\n", "transport"),
    (b"content-encoding: identity\x7f\r\n", "transport"),
    (b"content-encoding: identity\rx\r\n", "transport"),
    (b"x-note: a\x0bb\r\n", "transport"),
    (b"x-note: a\x1fb\r\n", "transport"),
    (b"this line has no colon\r\n", "transport"),
]
# Two forms the JavaScript platform takes or refuses by its version (Node 22.21 takes both, Node 25.6 refuses both): a folded
# header line, and a space before a header's colon. Here both are a failed connection on every version. They are in no table
# the two graders share.
HEADER_CASES_BY_NODE_VERSION: list[bytes] = [
    b"content-encoding: identity\r\n gzip\r\n",
    b"x-note: a\r\n\tb\r\n",
    b"x-note : a\r\n",
]


# The same for the length of a response: (the server's mode, the header bytes, the verdict). "<n>" is the body's length in bytes.
LENGTH_CASES: list[tuple[str, bytes, str]] = [
    ("raw-header-no-length", b"", "record"),
    ("raw-header-no-length", b"content-length: <n>\r\n", "record"),
    ("raw-header-no-length", b"Content-Length:  <n> \r\n", "record"),
    ("raw-header", b"content-length: <n>\r\n", "transport"),
    ("raw-header", b"content-length: 5\r\n", "transport"),
    ("raw-header", b"transfer-encoding: chunked\r\n", "transport"),
    ("raw-header-no-length", b"content-length: abc\r\n", "transport"),
    ("raw-header-no-length", b"content-length: -1\r\n", "transport"),
    ("raw-header-no-length", b"content-length: +<n>\r\n", "transport"),
    ("raw-header-no-length", b"content-length: <n>, <n>\r\n", "transport"),
    ("raw-header-no-length", b"content-length:\r\n", "transport"),
    ("raw-header-no-length", b"content-length: 1_0\r\n", "transport"),
    ("raw-header-no-length", b"content-length: \xd9\xa1\r\n", "transport"),
]


@check("the content-encoding header: absent or identity (in any case, with the white space JavaScript's trim removes around it) is taken; a header that is there and empty, one with byte 0x85, a list and two lines are refused after one request; a control character in the head is a failed connection")
def _():
    encoded = "grader: the response is in a content encoding the request did not ask for"
    assert len({h for h, _ in HEADER_CASES}) == len(HEADER_CASES)
    for header, verdict in HEADER_CASES + [(h, "transport") for h in HEADER_CASES_BY_NODE_VERSION]:
        SERVER.reset("raw-header")
        SERVER.raw_header = header
        with Waits() as w:
            try:
                got = "record" if record_of(call(make(max_reasks=1)))["reply"] == "Reasoning.\n\nGRADE: C" else "another reply"
            except ValueError as e:
                got = "refused" if str(e) == encoded else "transport" if str(e).startswith("grader: transport error (MalformedHeader); no reply after 2 asks") else str(e)
        assert got == verdict, (header, verdict, got)
        assert (len(SERVER.requests), w.seen) == ((2, [2]) if verdict == "transport" else (1, [])), (header, len(SERVER.requests), w.seen)
    # with a bound of 0 a head that is not well-formed raises as it came, and it is judged before the status: a 400 with such a head is a failed connection too
    for mode in ("raw-header", "raw-header-400"):
        SERVER.reset(mode)
        SERVER.raw_header = b"x-note: a\x0bb\r\n"
        e = error_of(lambda: call(make(max_reasks=0)))
        assert str(e) == "grader: transport error (MalformedHeader)" and len(SERVER.requests) == 1, (mode, str(e))
    SERVER.reset("raw-header-400")
    SERVER.raw_header = b"x-note: fine\r\n"
    assert str(error_of(lambda: call(make(max_reasks=3)))) == "grader: the endpoint answered status 400" and len(SERVER.requests) == 1
    # a length stated twice (equal or not), beside a transfer encoding, or not in digits, is a head the JavaScript platform refuses: a failed connection here too
    for mode, header, verdict in LENGTH_CASES:
        SERVER.reset(mode)
        SERVER.raw_header = header
        with Waits() as w:
            try:
                got = "record" if record_of(call(make(max_reasks=1)))["reply"] == "Reasoning.\n\nGRADE: C" else "another reply"
            except ValueError as e:
                got = "transport" if str(e).startswith("grader: transport error (MalformedHeader); no reply after 2 asks") else str(e)
        assert got == verdict and len(SERVER.requests) == (2 if verdict == "transport" else 1), (mode, header, verdict, got, len(SERVER.requests))
    # the characters trimmed are JavaScript's, the whole list and nothing else
    assert rg.JS_TRIM == " \t\n\v\f\r                 　﻿"
    assert "\x85" not in rg.JS_TRIM and "\x1c" not in rg.JS_TRIM and "​" not in rg.JS_TRIM and "᠎" not in rg.JS_TRIM


def _regrade_process(args: list[str], interrupts: int = 0) -> tuple[int, str, str]:
    """regrade.py as a process of its own, on exactly these arguments. With `interrupts`, the process is sent that many real
    SIGINTs, the first once the server has seen a request, so that an ask is in flight, and each later one 0.3 s after the one before."""
    import signal
    import subprocess

    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_BASE_URL"}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # a process started in the background has SIGINT ignored: the child takes Python's own handler back, as a terminal gives it
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "regrade.py"), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                         preexec_fn=lambda: signal.signal(signal.SIGINT, signal.default_int_handler))
    if interrupts:
        t0 = time.monotonic()
        while len(SERVER.requests) < 1 and p.poll() is None and time.monotonic() - t0 < 60:
            time.sleep(0.05)
        for _ in range(interrupts):
            time.sleep(0.3)
            if p.poll() is None:
                p.send_signal(signal.SIGINT)
    try:
        out, err = p.communicate(timeout=120)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
        return -1, out, err
    return p.returncode, out, err


def regrade_module() -> Any:
    import regrade

    return regrade


def _run_args(out_dir: str, **over: str) -> list[str]:
    flags = {"--log": os.path.join(HERE, "fixtures", "source.json"), "--epochs": "1", "--judge-model": "fake-judge", "--max-tokens": "64", "--api-key-env": KEY_ENV,
             "--wire": WIRE, "--thinking": "NOT_SENT", "--effort": "NOT_SENT", "--max-reasks": "0", "--base-url": SERVER.url, "--out-dir": out_dir}
    flags.update({"--" + k.replace("_", "-"): v for k, v in over.items()})
    return [x for pair in flags.items() for x in pair]


@check("regrade.py: an eval that returns no log (the tool's answer to an interrupt) is exit 2 on one line that says how many slots had been called and that the interrupted slot's asks are in no record and may be billed")
def _():
    import tempfile

    import inspect_ai

    real = inspect_ai.eval
    SERVER.reset()
    inspect_ai.eval = lambda *args, **kwargs: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
    finally:
        inspect_ai.eval = real
    assert c == 2 and out == "", (c, out, err)
    assert err.startswith("refused: the eval was interrupted and returned no log. 0 slot(s) had been called by then"), err
    assert "are in no record and may be billed" in err and "IndexError" not in err and "did not foresee" not in err and "Traceback" not in err, err
    assert len(err.strip().split("\n")) == 1, err


@check("regrade.py: an interrupt raised out of the eval (KeyboardInterrupt, a cancellation) is that line and exit 2 too, never the tool's silent exit 130")
def _():
    import tempfile

    import inspect_ai

    real = inspect_ai.eval
    for raised in (KeyboardInterrupt(), asyncio.CancelledError()):
        def interrupted(*args: Any, raised: BaseException = raised, **kwargs: Any) -> Any:
            raise raised

        SERVER.reset()
        inspect_ai.eval = interrupted
        try:
            with tempfile.TemporaryDirectory() as tmp:
                c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(tmp, "o"))
        finally:
            inspect_ai.eval = real
        assert c == 2 and out == "", (c, out, err)
        assert err.startswith("refused: the eval was interrupted before it returned. 0 slot(s) had been called by then") and "may be billed" in err and len(err.strip().split("\n")) == 1, err


@check("regrade.py: a real SIGINT while the first slot's call is in flight ends in that line and exit 2, never in an IndexError; the line counts the slots called, and the run of 12 slots stops short of its end")
def _():
    import re as _re
    import tempfile

    # every request is held for a second, so the interrupt arrives while the first slot's one ask is in flight
    SERVER.reset("sleep-1")
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_process(_run_args(os.path.join(tmp, "o"), epochs="4", timeout_ms="20000"), interrupts=1)
    assert c == 2, (c, out, err)
    assert "IndexError" not in err and "did not foresee" not in err and "Traceback" not in err, err
    line = [x for x in err.strip().split("\n") if x.startswith("refused: the eval was interrupted ")]
    assert len(line) == 1 and "are in no record and may be billed" in line[0], err
    # with a bound of 0 a slot is one request: the line's count is the number of requests the server saw
    called = int(_re.search(r"(\d+) slot\(s\) had been called by then", line[0]).group(1))
    assert called == len(SERVER.requests), (called, len(SERVER.requests))
    # without the pause before each slot's call every one of the 12 slots was called after the interrupt
    assert 1 <= called < 12, called


@check("regrade.py: a second SIGINT ends in the same line and exit 2, with one slot called, and not in the tool's exit 130 with no line")
def _():
    import tempfile

    SERVER.reset("sleep")
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_process(_run_args(os.path.join(tmp, "o"), epochs="4", timeout_ms="20000"), interrupts=2)
    assert c == 2, (c, out, err)
    line = [x for x in err.strip().split("\n") if x.startswith("refused: the eval was interrupted ")]
    assert len(line) == 1 and "1 slot(s) had been called by then" in line[0] and "may be billed" in line[0] and "Traceback" not in err, err
    assert len(SERVER.requests) == 1, len(SERVER.requests)


@check("regrade.py: --epochs, --max-tokens and --timeout-ms are plain ASCII digits and --temperature a plain decimal: an underscore, a sign, a space, another script's digits, an exponent, inf and nan are usage errors (64), with no request and no log directory")
def _():
    import tempfile

    SERVER.reset()
    not_integers = ["1_0", "+2", " 2", "2 ", " 2 ", "٢", "２", "02", "00", "2.0", "2e0", "0x2", "-1", "", "two", "1,000", "١٠"]
    bad = [(flag, v) for flag in ("--epochs", "--max-tokens", "--timeout-ms") for v in not_integers]
    bad += [("--epochs", "0"), ("--max-tokens", "0"), ("--timeout-ms", "0"), ("--epochs", "9" * 400), ("--max-tokens", "9" * 400), ("--timeout-ms", "9" * 5000), ("--max-tokens", str(2**53)), ("--epochs", str(2**53))]
    bad += [("--temperature", v) for v in ["0_1", "0_5", "+0.5", "-0", "-0.0", "-1", " 0.5", "0.5 ", ".5", "5.", "1e0", "1E-1", "inf", "-inf", "nan", "NaN", "Infinity", "0x1", "٠", "0.٥", "00", "01", "0,5", "", "0." + "5" * 5000]]
    for flag, value in bad:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = os.path.join(tmp, "o")
            c, out, err = _regrade_plain(_run_args(out_dir, **{flag[2:].replace("-", "_"): value}))
            assert c == 64, (flag, value, c, err)
            # a value that opens with a hyphen and is not a number is refused by the flag reader, as a flag with no value; every other one by the flag's own form
            own = f"usage error: {flag} must be a p"
            assert err.startswith(own) or (value.startswith("-") and err.startswith(f"usage error: argument {flag}: expected one argument")), (flag, value, err)
            assert "Traceback" not in err and len(err.strip().split("\n")) == 1, (flag, value, err)
            assert not os.path.exists(out_dir) and len(SERVER.requests) == 0, (flag, value)
    # the value is shown on one line, in ASCII
    c, out, err = _regrade_plain(_run_args("unused", epochs="٢\n"))
    assert c == 64 and 'found "\\\\u0662\\\\n"' in err, err
    # the largest integer taken is 2^53 - 1; --epochs is not run at that size here, so it is shown by a check
    assert regrade_module().positive_int_flag("--epochs", str(2**53 - 1)) == 2**53 - 1 and regrade_module().decimal_flag("--temperature", "0.25") == 0.25
    # in a check too, where --epochs is the one numeric flag
    for value in not_integers + ["0"]:
        c, out, err = _regrade_plain(["--log", os.path.join(HERE, "fixtures", "source.json"), "--epochs", value, "--check"])
        assert c == 64 and err.startswith("usage error: --epochs ") and "No request was made" not in out, (value, c, out, err)
    c, out, err = _regrade_plain(["--log", os.path.join(HERE, "fixtures", "source.json"), "--epochs", "10", "--check"])
    assert c == 0 and "10 epoch(s) would be run" in out, (c, out, err)
    # the plain forms are taken, and sent as they read: 3 samples at 2 epochs are 6 requests, each with these settings
    for temperature, sent in (("0", 0), ("1", 1), ("0.5", 0.5), ("0.25", 0.25), ("1.0", 1), ("0.0", 0)):
        SERVER.reset()
        with tempfile.TemporaryDirectory() as tmp:
            c, out, err = _regrade_plain(_run_args(os.path.join(tmp, "o"), epochs="2", max_tokens="77", timeout_ms="3600000", temperature=temperature))
        assert c == 0 and len(SERVER.requests) == 6, (temperature, c, err, len(SERVER.requests))
        for r in SERVER.requests:
            body = json.loads(r["raw"])
            assert body["max_tokens"] == 77 and body["temperature"] == sent and type(body["temperature"]) is type(sent), (temperature, body)


@check("regrade.py: an --out-dir that exists and cannot be written to, or cannot be entered, is a usage error (64) on one line before anything is sent")
def _():
    import stat
    import tempfile

    SERVER.reset()
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise AssertionError("this check cannot run as root: a directory's mode does not bind root")
    for mode in (stat.S_IRUSR | stat.S_IXUSR, stat.S_IRUSR | stat.S_IWUSR, 0):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = os.path.join(tmp, "o")
            os.mkdir(out_dir)
            os.chmod(out_dir, mode)
            try:
                c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=out_dir)
                assert c == 64, (oct(mode), c, out, err)
                assert err.startswith("usage error: --out-dir cannot be written to") and "nothing was written and no call was made" in err, (oct(mode), err)
                assert "Traceback" not in err and len(err.strip().split("\n")) == 1 and "during the eval" not in err, err
                # one level down too: a directory to be made under one that cannot be written to
                c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=os.path.join(out_dir, "under"))
                assert c == 64 and err.startswith("usage error: --out-dir cannot be "), (oct(mode), c, err)
            finally:
                os.chmod(out_dir, stat.S_IRWXU)
    assert len(SERVER.requests) == 0
    # a directory that exists and can be written to is taken, as before
    with tempfile.TemporaryDirectory() as tmp:
        c, out, err = _regrade_main(["--base-url", SERVER.url], out_dir=tmp)
        assert c == 0 and len(SERVER.requests) == 3, (c, err)


@check("the three statements of the plain-http rule name the two literal addresses and never the name localhost")
def _():
    with open(os.path.join(HERE, "recording_grader.py"), encoding="utf-8") as f:
        py = f.read()
    with open(os.path.join(HERE, "..", "promptfoo", "grader-provider.cjs"), encoding="utf-8") as f:
        js = f.read()
    assert 'LOOPBACK = {"127.0.0.1", "[::1]"}' in py and "const LOOPBACK = new Set(['127.0.0.1', '[::1]']);" in js
    for name, text in (("recording_grader.py", py), ("grader-provider.cjs", js)):
        assert "http only for 127.0.0.1 and [::1]" in text and "(localhost, 127.0.0.1, [::1])" not in text and "for a loopback host" not in text, name


@check("the two graders' files state the rules a user needs: an ask is in the record only when the slot ends with one, what promptSha256 is, and nothing addressed to a reader of the other copies")
def _():
    with open(os.path.join(HERE, "recording_grader.py"), encoding="utf-8") as f:
        py = f.read()
    with open(os.path.join(HERE, "..", "promptfoo", "grader-provider.cjs"), encoding="utf-8") as f:
        js = f.read()
    with open(os.path.join(HERE, "regrade.py"), encoding="utf-8") as f:
        rp = f.read()
    for name, text in (("recording_grader.py", py), ("grader-provider.cjs", js)):
        assert "Every ask is in the record." not in text, name
        assert "An ask is in the record only when its slot ends with a record" in text, name
        assert "The same rule and the same first words as the other paths" not in text and "The tail is this" not in text, name
        assert "The text of a cut reply is not recorded; its" not in text, name
        assert "`promptSha256`" in text and "not comparable across tools" in text, name
        assert "plain segments" in text and "content encoding" in text, name
    assert "nothing was sent, or the eval did not succeed" not in rp and "the response cache off" not in rp


# ---------------------------------------------------------------------------------------------------------------
# The OpenAI Responses wire (the counterpart of the JavaScript grader's tests of that wire)
# ---------------------------------------------------------------------------------------------------------------

OKEY_ENV = "SELFTEST_OPENAI_KEY"
OKEY = "selftest-openai-dummy-credential-9876543210"
os.environ[OKEY_ENV] = OKEY
OPENAI_CALL_SHAPE_KEYS = CALL_SHAPE_KEYS


def omake(max_tokens: int = 64, temperature: float | None = None, base_url: str | None = None, **args: Any) -> rg.RecordingGrader:
    cfg: dict[str, Any] = {"max_tokens": max_tokens}
    if temperature is not None:
        cfg["temperature"] = temperature
    args.setdefault("api_key_env", OKEY_ENV)
    args.setdefault("wire", WIRE_OPENAI)
    args.setdefault("effort", "NOT_SENT")
    args.setdefault("verbosity", "NOT_SENT")
    args.setdefault("max_reasks", 0)
    return rg.RecordingGrader("fake-judge", base_url=OSERVER.url if base_url is None else base_url, config=GenerateConfig(**cfg), **args)


def ocall(g: rg.RecordingGrader, script: list[str] | None = None, response: dict[str, Any] | None = None) -> Any:
    OSERVER.reset(script=script, response=response)
    return call(g)


@check("OpenAI wire: the whole received request equals the record (store, truncation, effort, verbosity and a temperature sent)")
def _():
    OSERVER.reset()
    user = "Question: refund?\nCRITERION: be kind. éè ☃"
    out = call(omake(temperature=0.7, effort="high", verbosity="low"), user)
    assert len(OSERVER.requests) == 1
    req = OSERVER.requests[0]
    ev = out.metadata["graderEvidence"]
    assert req["method"] == "POST" and req["path"] == "/responses", req["path"]
    h = req["headers"]
    assert set(h) == {"host", "accept-encoding", "content-length", "content-type", "authorization"}, sorted(h)
    assert h["authorization"] == f"Bearer {OKEY}" and h["content-type"] == "application/json" and h["accept-encoding"] == "identity"
    body = json.loads(req["raw"])
    assert list(body) == ["model", "input", "max_output_tokens", "store", "truncation", "temperature", "reasoning", "text"], list(body)
    assert body == {"model": "fake-judge", "input": [{"role": "user", "content": user}], "max_output_tokens": 64, "store": False, "truncation": "disabled",
                    "temperature": 0.7, "reasoning": {"effort": "high"}, "text": {"verbosity": "low"}}
    assert req["raw"] == json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert ev["schema"] == "example.grader-evidence/v8" and ev["wire"] == "openai-responses/v1" and "reading" not in ev
    assert set(ev) == {"schema", "wire", "grader", "graderRunId", "callSeq", "callId", "promptSha256", "sent", "requestedModel", "servedModel", "responseId", "stopReason",
                       "incompleteReason", "contentTypes", "thinkingTokens", "usage", "reply", "callShape", "reask"}, sorted(ev)
    assert ev["sent"] == {"system": "NOT_SENT", "user": sha(user), "reasoning": {"effort": "high"}, "text": {"verbosity": "low"}, "store": False, "truncation": "disabled"}
    assert ev["stopReason"] == "completed" and ev["incompleteReason"] == "ABSENT" and ev["contentTypes"] == ["message/output_text"]
    assert ev["thinkingTokens"] == 0 and ev["usage"] == {"input_tokens": 10, "output_tokens": 5} and ev["reply"] == GOOD_TEXT
    assert ev["servedModel"] == "fake-judge-served" and ev["requestedModel"] == "fake-judge" and ev["promptSha256"] == sha(user)
    cs = ev["callShape"]
    assert cs["endpoint"] == OSERVER.url + "/responses" and cs["apiVersion"] == "NOT_SENT" and cs["thinkingMode"] == "NOT_SENT" and cs["thinkingBudgetTokens"] == "NOT_SENT"
    assert cs["effort"] == "high" and cs["temperature"] == 0.7 and cs["maxOutputTokens"] == 64 and cs["contextPolicy"] == "none" and cs["timeoutMs"] == 60000
    assert cs["extras"] == {"openai.store": False, "openai.verbosity": "low"}
    assert set(cs) == {"schema", "extras", *CALL_SHAPE_KEYS}
    assert not has_null(ev)
    # a model's reply is the text of the output_text parts: the default reply reaches the tool whole
    assert out.choices[0].message.content == GOOD_TEXT and out.choices[0].stop_reason == "stop"


@check("OpenAI wire: nothing sent is in the request when it is not stated (no temperature, effort or verbosity), and the extras hold store only")
def _():
    OSERVER.reset()
    out = call(omake())
    body = json.loads(OSERVER.requests[0]["raw"])
    assert list(body) == ["model", "input", "max_output_tokens", "store", "truncation"], list(body)
    ev = out.metadata["graderEvidence"]
    assert ev["sent"]["reasoning"] == "NOT_SENT" and ev["sent"]["text"] == "NOT_SENT" and ev["callShape"]["effort"] == "NOT_SENT" and ev["callShape"]["temperature"] == "NOT_SENT"
    assert ev["callShape"]["extras"] == {"openai.store": False}


@check("OpenAI wire: the base URL path comes before /responses, and the default address is https://api.openai.com/v1 (no call is made)")
def _():
    p = OSERVER.port
    assert omake(base_url=f"http://127.0.0.1:{p}/proxy/").url == f"http://127.0.0.1:{p}/proxy/responses"
    assert rg.parse_base_url("https://api.openai.com/v1", rg.OPENAI_POSTED_PATH)[1:] == ("https://api.openai.com", 443, True, "/v1", "/v1/responses")
    default = rg.RecordingGrader("m", config=GenerateConfig(max_tokens=16), wire=WIRE_OPENAI, effort="NOT_SENT", verbosity="NOT_SENT", max_reasks=0, api_key_env=OKEY_ENV)
    assert default.url == "https://api.openai.com/v1/responses" and default.key_env == OKEY_ENV
    other = rg.RecordingGrader("m", config=GenerateConfig(max_tokens=16), wire=WIRE_OPENAI, effort="NOT_SENT", verbosity="NOT_SENT", max_reasks=0)
    assert other.key_env == "OPENAI_API_KEY"
    anthropic = rg.RecordingGrader("m", config=GenerateConfig(max_tokens=16), wire=WIRE, thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0)
    assert anthropic.url == "https://api.anthropic.com/v1/messages" and anthropic.key_env == "ANTHROPIC_API_KEY"


@check("wire: required with no default, one of the two names; the settings are the wire's own, before any request")
def _():
    OSERVER.reset()
    SERVER.reset()
    base = {"effort": "NOT_SENT", "max_reasks": 0, "api_key_env": OKEY_ENV}

    def build(max_tokens: int | None = 64, temperature: float | None = None, **args: Any) -> rg.RecordingGrader:
        cfg: dict[str, Any] = {} if max_tokens is None else {"max_tokens": max_tokens}
        if temperature is not None:
            cfg["temperature"] = temperature
        return rg.RecordingGrader("m", base_url=OSERVER.url, config=GenerateConfig(**cfg), **args)

    for wire in [None, "", "openai", "anthropic-messages/v2", "OPENAI-RESPONSES/V1", 5, ["openai-responses/v1"]]:
        args = {**base, "verbosity": "NOT_SENT", "thinking": "NOT_SENT"}
        if wire is not None:
            args["wire"] = wire
        e = error_of(lambda args=args: build(**args))
        assert "wire" in str(e), (wire, str(e))
    ok = {**base, "wire": WIRE_OPENAI, "verbosity": "NOT_SENT"}
    assert build(**ok).wire == WIRE_OPENAI
    for k, v in [("thinking", "NOT_SENT"), ("api_version", "2023-06-01"), ("top_p", 1), ("seed", 1), ("store", False), ("truncation", "disabled"), ("service_tier", "auto"), ("stream", True)]:
        e = error_of(lambda k=k, v=v: build(**{**ok, k: v}))
        assert f'model arg "{k}" is not one the grader sends on the openai-responses/v1 wire' in str(e), (k, str(e))
    for k in ("effort", "verbosity", "max_reasks"):
        e = error_of(lambda k=k: build(**{a: b for a, b in ok.items() if a != k}))
        assert k in str(e) and "required" in str(e), (k, str(e))
    # the other wire's settings are refused on the Anthropic wire too
    aok = {**base, "wire": WIRE, "thinking": "NOT_SENT"}
    assert build(**aok).wire == WIRE
    for k, v in [("verbosity", "low"), ("store", False)]:
        e = error_of(lambda k=k, v=v: build(**{**aok, k: v}))
        assert f'model arg "{k}" is not one the grader sends on the anthropic-messages/v1 wire' in str(e), (k, str(e))
    # the cap: an integer of at least 16 below 2^53 on the OpenAI wire, a positive integer below 2^53 on the Anthropic one
    for cap in [None, 0, 15, -1, 2**53, 10**21]:
        assert raises(lambda cap=cap: build(max_tokens=cap, **ok)), cap
    for cap in [None, 0, -1, 2**53, 10**21]:
        assert raises(lambda cap=cap: build(max_tokens=cap, **aok)), cap
    assert build(max_tokens=16, **ok).max_tokens == 16 and build(max_tokens=1, **aok).max_tokens == 1 and build(max_tokens=2**53 - 1, **ok).max_tokens == 2**53 - 1
    # the temperature range is [0, 2] on the OpenAI wire and [0, 1] on the Anthropic wire
    assert build(temperature=2, **ok).temperature == 2 and raises(lambda: build(temperature=2.1, **ok)) and raises(lambda: build(temperature=-0.1, **ok))
    assert build(temperature=1, **aok).temperature == 1 and raises(lambda: build(temperature=1.5, **aok))
    # effort: any of the seven words of the OpenAI wire, and verbosity one of three
    for e in ["none", "minimal", "low", "medium", "high", "xhigh", "max", "NOT_SENT"]:
        assert build(**{**ok, "effort": e}).effort == e, e
    for e in ["HIGH", "", "highest", None, 3, ["low"], " low"]:
        assert raises(lambda e=e: build(**{**ok, "effort": e})), e
    for v in ["low", "medium", "high", "NOT_SENT"]:
        assert build(**{**ok, "verbosity": v}).verbosity == v, v
    for v in ["LOW", "", "verbose", None, 3]:
        assert raises(lambda v=v: build(**{**ok, "verbosity": v})), v
    for e in ["none", "minimal"]:
        assert raises(lambda e=e: build(**{**aok, "effort": e})), e
    assert len(OSERVER.requests) == 0 and len(SERVER.requests) == 0


@check("OpenAI wire: each of the four address variables set, with no base URL or another one, refuses the grader before any call, naming the variable and showing no value; equal to the base URL it is taken; the Anthropic wire is not stopped by them")
def _():
    OSERVER.reset()
    secret = "https://secret-gateway.example.com/v1"
    names = ("OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_HOST", "OPENAI_HOST")
    assert rg.OPENAI_ADDRESS_VARIABLES == names
    try:
        for name in names:
            os.environ[name] = secret
            try:
                for base in (None, OSERVER.url):
                    e = error_of(lambda base=base: rg.RecordingGrader("m", base_url=base, config=GenerateConfig(max_tokens=16), wire=WIRE_OPENAI, effort="NOT_SENT", verbosity="NOT_SENT", max_reasks=0))
                    assert f"the environment variable {name} is set, and this grader never reads it" in str(e) and secret not in str(e), (name, str(e))
                    # the wire is looked at first, then the gateway, before any other setting
                    e = error_of(lambda base=base: rg.RecordingGrader("m", base_url=base, config=GenerateConfig(), wire=WIRE_OPENAI))
                    assert name in str(e), (name, str(e))
                assert rg.RecordingGrader("m", base_url=secret, config=GenerateConfig(max_tokens=16), wire=WIRE_OPENAI, effort="NOT_SENT", verbosity="NOT_SENT", max_reasks=0).url == secret + "/responses"
                # it is the other wire's business: an Anthropic grader is not stopped by it
                assert make().wire == WIRE
            finally:
                del os.environ[name]
            os.environ[name] = ""
            try:
                assert omake().wire == WIRE_OPENAI
            finally:
                del os.environ[name]
    finally:
        for name in names:
            os.environ.pop(name, None)
    os.environ["ANTHROPIC_BASE_URL"] = secret
    try:
        assert omake().wire == WIRE_OPENAI
        assert "ANTHROPIC_BASE_URL" in str(error_of(lambda: make()))
    finally:
        del os.environ["ANTHROPIC_BASE_URL"]
    assert len(OSERVER.requests) == 0


@check("OpenAI wire: the key is read from the variable named, goes in the authorization header only, and is not in the record or the output")
def _():
    out = ocall(omake())
    assert OKEY not in json.dumps(out.metadata) and OKEY not in out.model_dump_json()
    h = OSERVER.requests[0]["headers"]
    assert [k for k, v in h.items() if OKEY in v] == ["authorization"], h
    saved = os.environ.pop(OKEY_ENV)
    try:
        OSERVER.reset()
        assert raises(lambda: call(omake()))
        assert len(OSERVER.requests) == 0
    finally:
        os.environ[OKEY_ENV] = saved


# A body that is malformed on the OpenAI wire ends the slot at once: one request, nothing recorded, never asked again (a bound of 2 re-asks is stated).
MALFORMED = {
    "not a Responses object (object is chat.completion)": {"object": "chat.completion"},
    "no object": {"object": DEL},
    "object null": {"object": None},
    "error set": {"error": {"message": "m", "type": "t", "param": None, "code": None}},
    "error empty object": {"error": {}},
    "error false": {"error": False},
    "status failed": {"status": "failed"},
    "status in_progress": {"status": "in_progress"},
    "status cancelled": {"status": "cancelled"},
    "status queued": {"status": "queued"},
    "status missing": {"status": DEL},
    "status null": {"status": None},
    "completed with incomplete_details": {"incomplete_details": {"reason": "max_output_tokens"}},
    "completed with empty incomplete_details": {"incomplete_details": {}},
    "incomplete without incomplete_details": {"status": "incomplete", "incomplete_details": None},
    "incomplete with no reason": {"status": "incomplete", "incomplete_details": {}},
    "incomplete with a null reason": {"status": "incomplete", "incomplete_details": {"reason": None}},
    "incomplete with a reason that is not one line": {"status": "incomplete", "incomplete_details": {"reason": "two\nlines"}},
    "incomplete with a reason that reads as unknown": {"status": "incomplete", "incomplete_details": {"reason": "unknown"}},
    "incomplete with the reason ABSENT": {"status": "incomplete", "incomplete_details": {"reason": "ABSENT"}},
    "truncation auto echoed": {"truncation": "auto"},
    "truncation null echoed": {"truncation": None},
    "store true echoed": {"store": True},
    "store null echoed": {"store": None},
    "store 0 echoed": {"store": 0},
    "no id": {"id": DEL},
    "id with a space": {"id": "resp 1"},
    "id that reads as unknown": {"id": "UNKNOWN"},
    "no model": {"model": DEL},
    "model with a space": {"model": "bad id"},
    "no output": {"output": DEL},
    "output not a list": {"output": "text"},
    "output item without a type": {"output": [{"id": "x"}]},
    "output item type upper case": {"output": [{"type": "Message"}]},
    "output item type with a slash": {"output": [{"type": "message/output_text"}]},
    "output item not an object": {"output": ["x"]},
    "message without a status": {"output": [{"type": "message", "content": []}]},
    "message status with a bracket": {"output": [{"type": "message", "status": "x]/y", "content": []}]},
    "message phase null": {"output": [omsg(GOOD_TEXT, phase=None)]},
    "message phase not plain": {"output": [omsg(GOOD_TEXT, phase="Final Answer")]},
    "message content not a list": {"output": [{"type": "message", "status": "completed", "content": "text"}]},
    "part without a type": {"output": [{"type": "message", "status": "completed", "content": [{"text": "x"}]}]},
    "part type not plain": {"output": [{"type": "message", "status": "completed", "content": [{"type": "output text", "text": "x"}]}]},
    "output_text part without text": {"output": [{"type": "message", "status": "completed", "content": [{"type": "output_text"}]}]},
    "usage not an object": {"usage": 5},
    "usage with one counter": {"usage": {"input_tokens": 10}},
    "usage counter negative": {"usage": {"input_tokens": -1, "output_tokens": 5}},
    "usage counter a string": {"usage": {"input_tokens": "10", "output_tokens": 5}},
    "reasoning counter negative": {"usage": {"input_tokens": 1, "output_tokens": 1, "output_tokens_details": {"reasoning_tokens": -1}}},
    "reasoning counter a float": {"usage": {"input_tokens": 1, "output_tokens": 1, "output_tokens_details": {"reasoning_tokens": 1.5}}},
    "reasoning counter null": {"usage": {"input_tokens": 1, "output_tokens": 1, "output_tokens_details": {"reasoning_tokens": None}}},
    "output_tokens_details null": {"usage": {"input_tokens": 1, "output_tokens": 1, "output_tokens_details": None}},
}


@check("OpenAI wire: a malformed 200 body (every form of the checks, in order) ends the slot with no record: one request, never asked again, nothing of the body shown")
def _():
    for what, over in MALFORMED.items():
        OSERVER.reset(response=over)
        try:
            e = error_of(lambda: call(omake(max_reasks=2)))
        except AssertionError:
            raise AssertionError(f"{what}: the call returned a record")
        assert isinstance(e, ValueError) and "no reply after" not in str(e) and "the slot ends with no record" not in str(e), (what, str(e))
        assert len(OSERVER.requests) == 1, (what, len(OSERVER.requests))
        assert "SECRET" not in str(e) and "bad id" not in str(e) and "two\nlines" not in str(e), (what, str(e))


@check("OpenAI wire: the checks run in a fixed order (object, then error, then status, then incomplete_details, then the echoes, then the ids), so a body with two faults is refused for the first")
def _():
    over = {"object": "chat.completion", "error": {"message": "m"}, "status": "failed", "truncation": "auto", "id": DEL}
    expected = ["Responses object", "holds an error", "neither", "incomplete_details", "truncation", "lacks id"]
    order = ["object", "error", "status", "incomplete_details", "truncation", "id"]
    for i, key in enumerate(order):
        bad = {"object": "chat.completion", "error": {"message": "m"}, "status": "failed", "incomplete_details": {"reason": "x"}, "truncation": "auto", "id": DEL}
        for earlier in order[:i]:
            bad.pop(earlier)
        if key == "incomplete_details":
            bad["status"] = "completed"
        OSERVER.reset(response=bad)
        e = error_of(lambda: call(omake()))
        assert expected[i] in str(e), (key, str(e))


@check("OpenAI wire: null is taken in error and incomplete_details, and nowhere else; an absent error, incomplete_details, truncation and store are taken")
def _():
    out = ocall(omake(), response={"error": None, "incomplete_details": None})
    assert out.metadata["graderEvidence"]["stopReason"] == "completed"
    out = ocall(omake(), response={"error": DEL, "incomplete_details": DEL, "truncation": DEL, "store": DEL, "previous_response_id": DEL})
    assert out.metadata["graderEvidence"]["incompleteReason"] == "ABSENT"
    out = ocall(omake(), response={"truncation": "disabled", "store": False, "metadata": {"a": None}, "unread": [None]})
    assert out.metadata["graderEvidence"]["contentTypes"] == ["message/output_text"]


@check("OpenAI wire: contentTypes lists the output items in order (reasoning, message parts, the bracketed forms, an empty message, any other item), and the reply is the text of the output_text parts only")
def _():
    cases = [
        ("reasoning", ["reasoning", "message/output_text"], GOOD_TEXT, 12),
        ("message-incomplete", ["message[status=incomplete]/output_text"], GOOD_TEXT, 0),
        ("phase", ["message[phase=final_answer]/output_text"], GOOD_TEXT, 0),
        ("phase-commentary", ["message[phase=commentary]/output_text"], GOOD_TEXT, 0),
        ("empty-output", [], "", 0),
        ("empty-message", ["message", "message/output_text"], GOOD_TEXT, 0),
        ("function-call", ["function_call"], "", 0),
        ("two-messages", ["message/output_text", "message/output_text"], "ab", 0),
        ("refusal", ["message/refusal"], "", 0),
        ("refusal-after", ["message/output_text", "message/refusal"], GOOD_TEXT, 0),
        ("refusal-before", ["message/refusal", "message/output_text"], GOOD_TEXT, 0),
    ]
    for name, types, reply, tokens in cases:
        out = ocall(omake(), script=[f"r:{name}"])
        ev = out.metadata["graderEvidence"]
        assert ev["contentTypes"] == types and ev["reply"] == reply and ev["thinkingTokens"] == tokens, (name, ev["contentTypes"], ev["reply"], ev["thinkingTokens"])
        assert ev["stopReason"] == "completed" and ev["reask"]["earlier"] == [], name
        assert "ENCRYPTED-SELFTEST-TEXT" not in json.dumps(ev) and "REFUSAL-TEXT" not in json.dumps(ev), name
    out = ocall(omake(), script=["r:no-counter"])
    assert out.metadata["graderEvidence"]["thinkingTokens"] == "ABSENT"
    out = ocall(omake(), response={"usage": DEL})
    ev = out.metadata["graderEvidence"]
    assert ev["thinkingTokens"] == "ABSENT" and ev["usage"] == "ABSENT" and out.usage is None


@check("OpenAI wire: a cut is exactly status incomplete with the reason max_output_tokens: asked again within the bound with the same bytes, the earlier ask carries incompleteReason, its text only as a sha256 and a length")
def _():
    with Waits() as w:
        OSERVER.reset(script=["r:cut", "ok"])
        out = call(omake(max_reasks=2))
    reqs = OSERVER.requests
    assert len(reqs) == 2 and reqs[0]["raw"] == reqs[1]["raw"] and w.seen == []
    ev = out.metadata["graderEvidence"]
    cut = ev["reask"]["earlier"][0]
    assert ev["stopReason"] == "completed" and ev["reask"]["max"] == 2 and len(ev["reask"]["earlier"]) == 1
    assert list(cut) == ["reason", "callSeq", "callId", "httpStatus", "responseId", "servedModel", "stopReason", "incompleteReason", "contentTypes", "thinkingTokens", "usage", "replySha256", "replyUtf8Bytes"], list(cut)
    assert cut["reason"] == "truncated" and cut["stopReason"] == "incomplete" and cut["incompleteReason"] == "max_output_tokens" and cut["httpStatus"] == 200
    assert cut["contentTypes"] == ["message[status=incomplete]/output_text"] and cut["thinkingTokens"] == 7 and cut["usage"] == {"input_tokens": 31, "output_tokens": 256}
    assert cut["replySha256"] == sha("CUT-REPLY-TEXT GRA") and cut["replyUtf8Bytes"] == len("CUT-REPLY-TEXT GRA")
    assert "CUT-REPLY-TEXT" not in json.dumps(ev) and cut["callSeq"] != ev["callSeq"] and cut["callId"] != ev["callId"]
    assert not has_null(ev)
    # a cut with no message at all, and one with an empty output, are cuts too
    for name in ("cut-reasoning", "cut-empty", "cut-whole"):
        with Waits():
            out = ocall(omake(max_reasks=1), script=[f"r:{name}", "ok"])
        ev = out.metadata["graderEvidence"]
        assert len(OSERVER.requests) == 2 and ev["reask"]["earlier"][0]["reason"] == "truncated" and ev["reask"]["earlier"][0]["incompleteReason"] == "max_output_tokens", name
    # the bound used up: the last ask is the slot's last, recorded whole, and states why it was incomplete
    with Waits():
        out = ocall(omake(max_reasks=1), script=["r:cut", "r:cut-whole"])
    ev = out.metadata["graderEvidence"]
    assert len(OSERVER.requests) == 2 and ev["stopReason"] == "incomplete" and ev["incompleteReason"] == "max_output_tokens" and ev["reply"] == GOOD_TEXT
    assert out.choices[0].stop_reason == "max_tokens"
    out = ocall(omake(max_reasks=0), script=["r:cut"])
    assert len(OSERVER.requests) == 1 and out.metadata["graderEvidence"]["reask"] == {"max": 0, "earlier": []}


@check("OpenAI wire: every other incomplete reason, and every completed reply whatever it holds, is final: one request, recorded, never asked again")
def _():
    for name, reason in (("content-filter", "content_filter"), ("other-reason", "max_messages")):
        out = ocall(omake(max_reasks=3), script=[f"r:{name}"])
        ev = out.metadata["graderEvidence"]
        assert len(OSERVER.requests) == 1 and ev["stopReason"] == "incomplete" and ev["incompleteReason"] == reason and ev["reask"]["earlier"] == [], name
    assert ocall(omake(max_reasks=3), script=["r:content-filter"]).choices[0].stop_reason == "content_filter"
    assert ocall(omake(max_reasks=3), script=["r:other-reason"]).choices[0].stop_reason == "unknown"
    for name in ("refusal", "refusal-after", "refusal-before", "message-incomplete", "phase-commentary", "phase-other", "empty-output", "function-call", "two-messages"):
        out = ocall(omake(max_reasks=3), script=[f"r:{name}"])
        assert len(OSERVER.requests) == 1 and out.metadata["graderEvidence"]["reask"]["earlier"] == [], name
    for text in ("", "not json", "GRADE:", "```json\n{}\n```"):
        out = ocall(omake(max_reasks=3), response={"output": [omsg(text)]})
        assert len(OSERVER.requests) == 1 and out.metadata["graderEvidence"]["reply"] == text


@check("OpenAI wire: the other asks that are asked again (a deadline, a failed connection, 5xx, 429) and those that are not (4xx, a redirect, a content encoding), with the waits 2, 4 and 8 s")
def _():
    with Waits() as w:
        out = ocall(omake(max_reasks=3), script=["503", "429", "500", "ok"])
    ev = out.metadata["graderEvidence"]
    assert w.seen == [2, 4, 8] and [a["reason"] for a in ev["reask"]["earlier"]] == ["server-error", "rate-limited", "server-error"], (w.seen, ev["reask"])
    assert [a["httpStatus"] for a in ev["reask"]["earlier"]] == [503, 429, 500] and set(ev["reask"]["earlier"][0]) == {"reason", "callSeq", "callId", "httpStatus", "detail"}
    with Waits():
        out = ocall(omake(max_reasks=2), script=["drop", "ok"])
    assert out.metadata["graderEvidence"]["reask"]["earlier"][0]["reason"] == "transport"
    for status in ("400", "401", "403", "404", "422", "307", "301"):
        with Waits() as w:
            e = error_of(lambda status=status: ocall(omake(max_reasks=3), script=[status]))
        assert len(OSERVER.requests) == 1 and w.seen == [] and "SECRET-BODY-TEXT" not in str(e) and f"status {status}" in str(e), (status, str(e))
    with Waits():
        e = error_of(lambda: ocall(omake(max_reasks=1), script=["429", "429"]))
    assert len(OSERVER.requests) == 2 and "no reply after 2 asks, the bound of 1 re-ask(s) is used up" in str(e) and "SECRET-BODY-TEXT" not in str(e)
    e = error_of(lambda: ocall(omake(max_reasks=0), script=["503"]))
    assert len(OSERVER.requests) == 1 and str(e) == "grader: the endpoint answered status 503"
    # the cut ask then an ask with no reply: the wait is the second value
    with Waits() as w:
        out = ocall(omake(max_reasks=3), script=["r:cut", "503", "ok"])
    assert w.seen == [4] and [a["reason"] for a in out.metadata["graderEvidence"]["reask"]["earlier"]] == ["truncated", "server-error"], w.seen


@check("OpenAI wire: the call numbers of a slot are distinct, and a call that fails uses its number up")
def _():
    OSERVER.reset(script=["r:cut", "ok"])
    with Waits():
        a = call(omake(max_reasks=1)).metadata["graderEvidence"]
    assert a["reask"]["earlier"][0]["callSeq"] + 1 == a["callSeq"]
    OSERVER.reset(script=["400"])
    assert raises(lambda: call(omake()))
    OSERVER.reset()
    b = call(omake()).metadata["graderEvidence"]
    assert b["callSeq"] >= a["callSeq"] + 2 and b["graderRunId"] == a["graderRunId"] and b["callId"] != a["callId"]


@check("OpenAI wire: the status comes before the content (the importer's order): a cut or filtered reply whose message is completed, and a refusal beside a readable part in either order, are never graded")
def _():
    import regrade

    def refusal_of_mode(name: str | None, over: dict[str, Any] | None = None, reasks: int = 0) -> str | None:
        OSERVER.reset(script=None if name is None else [f"r:{name}"], response=over)
        with Waits():
            ev = call(omake(max_reasks=reasks)).metadata["graderEvidence"]
        return regrade.importer_refusal(ev)

    assert refusal_of_mode(None) is None
    why = refusal_of_mode("cut-whole")
    assert why is not None and 'status "incomplete" (max_output_tokens)' in why and "not \"completed\"" in why, why
    why = refusal_of_mode("content-filter")
    assert why is not None and 'status "incomplete" (content_filter)' in why, why
    why = refusal_of_mode("other-reason")
    assert why is not None and "(max_messages)" in why, why
    for name in ("refusal", "refusal-after", "refusal-before"):
        why = refusal_of_mode(name)
        assert why is not None and "refusal part" in why, (name, why)
    for name in ("message-incomplete", "phase-commentary", "phase-other", "empty-output", "function-call", "two-messages", "empty-message"):
        why = refusal_of_mode(name)
        assert why is not None and "not zero or more reasoning items followed by exactly one completed message with one output_text part" in why, (name, why)
    assert refusal_of_mode("reasoning") is None
    assert refusal_of_mode("phase") is None  # phase final_answer is read like an absent phase
    why = refusal_of_mode(None, {"output": [omsg("a reply with no grade line")]})
    assert why is not None and "no strict reading" in why
    # a cut that is the last ask of a bound used up is the slot's stop, not its content
    why = refusal_of_mode("cut-whole", reasks=0)
    assert why is not None and "incomplete" in why


@check("OpenAI wire: the stop and content tables, and the importer's tests of a record, are the same words on both wires")
def _():
    import regrade

    assert regrade.STOP_MAP == {"anthropic-messages/v1": {"end_turn": "end"}, "openai-responses/v1": {"completed": "end"}}
    assert regrade.OPENAI_INCOMPLETE_MAP == {"max_output_tokens": "cut", "content_filter": "content-filter"}
    assert regrade.judge_stop_of("openai-responses/v1", "completed") == "end"
    assert regrade.judge_stop_of("openai-responses/v1", "incomplete", "content_filter") == "content-filter"
    assert regrade.judge_stop_of("openai-responses/v1", "incomplete", "max_output_tokens") is None
    assert regrade.judge_stop_of("openai-responses/v1", "incomplete", "max_messages") is None
    assert regrade.judge_stop_of("openai-responses/v1", "end_turn") is None
    assert regrade.judge_stop_of("anthropic-messages/v1", "end_turn") == "end"
    assert regrade.judge_stop_of("anthropic-messages/v1", "completed") is None
    assert regrade.judge_stop_of("anthropic-messages/v1", "incomplete", "content_filter") is None
    assert regrade.judge_stop_of("anthropic-messages/v1", "max_tokens") is None
    for wire, types, ok in [
        ("openai-responses/v1", ["message/output_text"], True), ("openai-responses/v1", ["reasoning", "reasoning", "message/output_text"], True),
        ("openai-responses/v1", [], False), ("openai-responses/v1", ["reasoning"], False), ("openai-responses/v1", ["message/output_text", "reasoning"], False),
        ("openai-responses/v1", ["message[status=incomplete]/output_text"], False), ("openai-responses/v1", ["message[phase=final_answer]/output_text"], True),
        ("openai-responses/v1", ["reasoning", "message[phase=final_answer]/output_text"], True), ("openai-responses/v1", ["message[phase=commentary]/output_text"], False),
        ("openai-responses/v1", ["message[phase=final_answer]/refusal"], False), ("openai-responses/v1", ["message[phase=final_answer]/output_text", "reasoning"], False),
        ("openai-responses/v1", ["message[phase=null]/output_text"], False), ("anthropic-messages/v1", ["message[phase=final_answer]/output_text"], False),
        ("openai-responses/v1", ["message/output_text", "message/output_text"], False), ("openai-responses/v1", ["text"], False), ("openai-responses/v1", ["thinking", "message/output_text"], False),
        ("anthropic-messages/v1", ["text"], True), ("anthropic-messages/v1", ["thinking", "redacted_thinking", "text"], True), ("anthropic-messages/v1", [], False),
        ("anthropic-messages/v1", ["reasoning", "text"], False), ("anthropic-messages/v1", ["message/output_text"], False), ("anthropic-messages/v1", ["text", "text"], False),
    ]:
        assert regrade.content_is_readable(wire, types) is ok, (wire, types)
    assert "wire" in (regrade.importer_refusal({"wire": "other", "stopReason": "completed"}) or "")


@check("regrade.py: --wire is required for a run and selects the flags; a flag of the other wire is a usage error; --check takes no wire")
def _():
    import io
    from contextlib import redirect_stderr

    import regrade

    def code(args: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with redirect_stderr(err):
            return regrade.main(args), err.getvalue()

    common = ["--log", "no-such-log.json", "--epochs", "1", "--judge-model", "m", "--max-tokens", "16", "--out-dir", "no-such-dir", "--base-url", "http://127.0.0.1:1", "--effort", "NOT_SENT", "--max-reasks", "0"]
    c, msg = code(common + ["--thinking", "NOT_SENT"])
    assert c == 64 and "--wire" in msg, (c, msg)
    c, msg = code(common + ["--wire", "openai", "--verbosity", "NOT_SENT"])
    assert c == 64 and "--wire must be one of" in msg, (c, msg)
    c, msg = code(common + ["--wire", WIRE_OPENAI])
    assert c == 64 and "--verbosity" in msg and "a run needs" in msg, (c, msg)
    c, msg = code(common + ["--wire", WIRE])
    assert c == 64 and "--thinking" in msg and "a run needs" in msg, (c, msg)
    for extra in (["--thinking", "NOT_SENT"], ["--api-version", "2023-06-01"]):
        c, msg = code(common + ["--wire", WIRE_OPENAI, "--verbosity", "NOT_SENT"] + extra)
        assert c == 64 and f"{extra[0]} is a flag of the anthropic-messages/v1 wire only" in msg, (extra, c, msg)
    c, msg = code(common + ["--wire", WIRE, "--thinking", "NOT_SENT", "--verbosity", "low"])
    assert c == 64 and "--verbosity is a flag of the openai-responses/v1 wire only" in msg, (c, msg)
    c, msg = code(common + ["--wire", WIRE_OPENAI, "--wire", WIRE_OPENAI, "--verbosity", "NOT_SENT"])
    assert c == 64 and "given twice" in msg, (c, msg)
    c, msg = code(common + ["--wire", "", "--verbosity", "NOT_SENT"])
    assert c == 64 and "empty value" in msg, (c, msg)
    c, msg = code(["--log", "x.json", "--epochs", "1", "--check", "--wire", WIRE_OPENAI])
    assert c == 64 and "--check" in msg, (c, msg)
    # the OpenAI gateway variables: each stops a run that states another address
    for name in rg.OPENAI_ADDRESS_VARIABLES:
        os.environ[name] = "https://secret-gateway.example.com/v1"
        try:
            c, msg = code(common + ["--wire", WIRE_OPENAI, "--verbosity", "NOT_SENT"])
        finally:
            del os.environ[name]
        assert c == 64 and f"the environment variable {name} is set, and this grader never reads it" in msg and "secret-gateway" not in msg, (name, c, msg)
    assert regrade.OPENAI_ADDRESS_VARIABLES == rg.OPENAI_ADDRESS_VARIABLES


def main() -> int:
    failed = 0
    for name, ok, why in RESULTS:
        print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"\n      {why}"))
        failed += 0 if ok else 1
    print(f"{len(RESULTS) - failed} passed, {failed} failed")
    SERVER.close()
    OSERVER.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
