# Inputs of examples/importers/fixtures.sh for Inspect: the system's own log, and the plain (built-in grader) log.
# Synthetic refund-bot text only. No model is called: a solver writes each stored output.
#
#   python fixture_inputs.py source        <log dir>   the system's log, 3 samples (becomes fixtures/source.json)
#   python fixture_inputs.py source-short  <log dir>   a 3-sample source with short targets (re-graded into short-targets.json)
#   python fixture_inputs.py source-thinking <log dir> a 3-sample source whose first and third outputs carry the marker [[thinking]],
#        which makes the fake endpoint answer with a thinking block before the text block (re-graded into thinking.json)
#   python fixture_inputs.py source-reask <log dir>    a 3-sample source whose first output carries [[times:1:truncated]] and whose
#        second carries [[times:1:http-529]]: the fake endpoint cuts, or answers 529 to, the FIRST request with a given body
#        and answers every later one whole, so one slot of each of those cases is asked twice (re-graded into reask.json
#        and reask-new-judge.json)
#   python fixture_inputs.py source-reask-exhausted <log dir>  a 3-sample source whose first output carries
#        [[times:2:truncated]]: under a bound of one re-ask, both asks of one slot are cut (re-graded into
#        bad-fixtures/reask-exhausted.json)
#   python fixture_inputs.py mixed-wires <source log> <log dir> <epochs> <port>
#        re-grade through the recording grader with a scorer of its own, named model_graded_qa, that grades the samples c1 and c2 on the OpenAI
#        wire and c3 on the Anthropic wire (the stand-in's two routes, on 127.0.0.1:<port>): one file that holds the records of two wires, which
#        the importer refuses (bad-fixtures/mixed-wires.json). A Python file that only this script uses.
#   python fixture_inputs.py plain <source log> <log dir> <epochs>
#        re-grade with Inspect's own provider "anthropic/claude-fake-1" as the grader (the base URL and a dummy key come
#        from the environment: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY), so the log holds no record of the call.
#        The fake endpoint does not stream, so streaming is off and max_tokens is 1024 (the client refuses a long
#        non-streaming request).
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

from inspect_ai import Task, eval
from inspect_ai.dataset import Sample
from inspect_ai.log import read_eval_log
from inspect_ai.model import GenerateConfig, ModelOutput, get_model
from inspect_ai.scorer import accuracy, model_graded_qa, scorer, stderr
from inspect_ai.solver import Generate, TaskState, solver

POLICY = "The reply follows the refund policy (within 30 days or damaged goods, never more than once)."
SETS = {
    "source": [
        ("c1", "My blender arrived broken. Can I get my money back?", POLICY,
         "Your order arrived damaged, so you are eligible for a full refund. I have started it."),
        ("c2", "I bought shoes 45 days ago and want a refund.", POLICY,
         "Refunds are only possible within 30 days. Your purchase was 45 days ago, so I cannot refund it."),
        ("c3", "Please refund my last order.", POLICY, "Sure, I refunded it twice to be safe. [[strict:fail]]"),
    ],
    "source-thinking": [
        ("c1", "My blender arrived broken. Can I get my money back?", POLICY,
         "Your order arrived damaged, so you are eligible for a full refund. I have started it. [[thinking]]"),
        ("c2", "I bought shoes 45 days ago and want a refund.", POLICY,
         "Refunds are only possible within 30 days. Your purchase was 45 days ago, so I cannot refund it."),
        ("c3", "Please refund my last order.", POLICY,
         "Sure, I refunded it twice to be safe. [[thinking]]"),
    ],
    "source-reask": [
        ("c1", "My blender arrived broken. Can I get my money back?", POLICY,
         "Your order arrived damaged, so you are eligible for a full refund. I have started it. [[times:1:truncated]]"),
        ("c2", "I bought shoes 45 days ago and want a refund.", POLICY,
         "Refunds are only possible within 30 days. Your purchase was 45 days ago, so I cannot refund it. [[times:1:http-529]]"),
        ("c3", "Please refund my last order.", POLICY, "Sure, I refunded it twice to be safe. [[strict:fail]]"),
    ],
    "source-reask-exhausted": [
        ("c1", "My blender arrived broken. Can I get my money back?", POLICY,
         "Your order arrived damaged, so you are eligible for a full refund. I have started it. [[times:2:truncated]]"),
        ("c2", "I bought shoes 45 days ago and want a refund.", POLICY,
         "Refunds are only possible within 30 days. Your purchase was 45 days ago, so I cannot refund it."),
        ("c3", "Please refund my last order.", POLICY, "Sure, I refunded it twice to be safe. [[strict:fail]]"),
    ],
    "source-short": [
        ("c1", "How many business days does a refund take to arrive?", "4", "The answer is 4."),
        ("c2", "Is a refund possible for a damaged item? Answer Yes or No.", "Yes", "Yes"),
        ("c3", "Please refund my last order.", "The reply restates the request.", "Please refund my last order."),
    ],
}


def replay(stored: dict[str, str]):
    @solver
    def replay_stored():
        async def solve(state: TaskState, generate: Generate) -> TaskState:
            state.output = ModelOutput.from_content("stored-outputs", stored[str(state.sample_id)])
            state.messages.append(state.output.message)
            return state

        return solve

    return replay_stored()


def main(argv: list[str]) -> int:
    mode = argv[0]
    if mode in SETS:
        rows = SETS[mode]
        task = Task(name="refund_bot", dataset=[Sample(id=i, input=q, target=t) for i, q, t, _ in rows],
                    solver=replay({i: o for i, _, _, o in rows}))
        logs = eval(task, model="mockllm/refund-bot", log_dir=argv[1], log_format="json", max_connections=1, display="none")
    elif mode == "mixed-wires":
        sys.path.insert(0, HERE)
        import recording_grader  # noqa: F401  registers the provider "recording"; it calls nothing by itself

        src = read_eval_log(argv[1])
        samples = src.samples or []
        stored = {str(s.id): s.output.choices[0].message.content for s in samples}
        base = f"http://127.0.0.1:{int(argv[4])}"
        cfg = GenerateConfig(max_tokens=256, temperature=0)
        openai = get_model("recording/fake-judge-old", config=cfg, base_url=f"{base}/v1", memoize=False,
                           wire="openai-responses/v1", effort="NOT_SENT", verbosity="NOT_SENT", max_reasks=0)
        anthropic = get_model("recording/fake-judge-old", config=cfg, base_url=base, memoize=False,
                              wire="anthropic-messages/v1", thinking="NOT_SENT", effort="NOT_SENT", max_reasks=0)

        @scorer(metrics=[accuracy(), stderr()], name="model_graded_qa")
        def mixed(template: str, instructions: str, model):
            on_openai = model_graded_qa(template=template, instructions=instructions, model=model)
            on_anthropic = model_graded_qa(template=template, instructions=instructions, model=anthropic)

            async def score(state, target):
                return await (on_anthropic if state.sample_id == "c3" else on_openai)(state, target)

            return score

        with open(os.path.join(HERE, "template.txt"), "rb") as f:
            template = f.read().decode("utf-8")
        with open(os.path.join(HERE, "instructions.txt"), "rb") as f:
            instructions = f.read().decode("utf-8")
        task = Task(name="regrade", dataset=[Sample(id=s.id, input=s.input, target=s.target) for s in samples],
                    solver=replay(stored), scorer=mixed(template=template, instructions=instructions, model=openai))
        logs = eval(task, model="mockllm/unused-system", log_dir=argv[2], log_format="json", epochs=int(argv[3]),
                    fail_on_error=True, display="none")
    elif mode == "plain":
        src = read_eval_log(argv[1])
        samples = src.samples or []
        stored = {str(s.id): s.output.choices[0].message.content for s in samples}
        task = Task(name="regrade", dataset=[Sample(id=s.id, input=s.input, target=s.target) for s in samples],
                    solver=replay(stored), scorer=model_graded_qa(model=get_model(
                        "anthropic/claude-fake-1", streaming=False, config=GenerateConfig(max_tokens=1024))))
        logs = eval(task, model="mockllm/unused-system", log_dir=argv[2], log_format="json", epochs=int(argv[3]),
                    fail_on_error=True, display="none")
    else:
        print("usage: see the header", file=sys.stderr)
        return 64
    print(f"status: {logs[0].status}")
    return 0 if logs[0].status == "success" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
