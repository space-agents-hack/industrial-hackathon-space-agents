"""Does the requirement writer behave correctly on a small made-up case, with the model in
AGENT_MODEL?

Unit tests prove the loop works with a scripted model. This asks what tests cannot: given the
prompts and tools, does a real model read the regulation that applies and leave out the one that
does not, write a requirement for each obligation that applies to this product, and ask before
approving? Run it whenever a prompt, a tool description or the model changes:

    make eval                                          # scripted model, free
    AGENT_MODEL=anthropic:claude-sonnet-5-5 make eval  # a real model; this spends tokens

It runs through the real runner (prepare, execute, approve, resume) on an in-memory store, so the
trace, the pause and the submission are the ones production makes. The checks are deterministic:
they read what was stored and called, not a second model's opinion.

What this does NOT measure: quality on the dev case (#14 scores that with Certivity's answer key
in the database), or the wording of requirements.
"""

import json
from dataclasses import dataclass, field

from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from agent_service import runner
from agent_service.domain import certivity
from agent_service.settings import Settings
from tests.fakes import ORG, InMemoryRunStore

# A made-up library: one regulation for the product, one that is not about it. Paragraph texts
# are written for this eval, not taken from the UNECE documents.
LIBRARY = {
    ("UN R148", "00"): [
        ("1", "1. Scope. This Regulation applies to signalling lamps of vehicles.", 1),
        (
            "2.1",
            "2.1. 'Rear position lamp' means a lamp that indicates the rear of the vehicle.",
            2,
        ),
        (
            "5.4.2",
            "5.4.2. The colour of the light emitted by the rear position lamp shall be red.",
            5,
        ),
        (
            "5.4.3",
            "5.4.3. The luminous intensity of the rear position lamp shall be at least 4 cd "
            "on the reference axis and shall not exceed 17 cd in any direction.",
            5,
        ),
        (
            "5.5.1",
            "5.5.1. The colour of the light emitted by the front position lamp shall be white.",
            6,
        ),
        ("Annex 5 2", "2. The lamp shall be tested at 13.5 V for lamps of 12 V systems.", 40),
    ],
    ("UN R43", "01"): [
        ("5.1", "5.1. Toughened safety glass panes shall fragment into small particles.", 3),
        ("5.2", "5.2. The light transmittance of windscreens shall be at least 70 per cent.", 4),
    ],
}

CASE_TEXT = """# Rear position lamp RPL-2

A red LED rear position lamp for passenger cars (category M1), 12 V system.
It has one function only: rear position. No stop, no direction indicator."""


@dataclass
class Expected:
    reads: set[str]
    skips: set[str]
    # Labels of paragraphs that must each be cited by at least one requirement.
    covers: set[str]
    # Labels no requirement may cite: obligations of another device.
    never: set[str] = field(default_factory=set[str])


@dataclass
class Outcome:
    read: set[str]
    cited: set[str]
    asked_approval_for: list[str]
    approved_before_asking: int
    status: str
    problems: list[str]
    requirements: int


async def write(task: str) -> Outcome:
    store = InMemoryRunStore()
    for (code, label), paragraphs in LIBRARY.items():
        store.add_version(code, label, paragraphs)
    case_id = store.add_parsed_case("eval-rear-lamp", CASE_TEXT)
    run_id = store.add_run(task, case_id=case_id)
    settings = Settings()

    plan = await runner.prepare(store, settings, run_id)
    status = await runner.execute(store, settings, plan)
    approved_early = sum(r.status == "approved" for r in await store.run_requirements(run_id))
    asked = [a.tool_name for a in store.approvals]
    if status == "awaiting_approval":
        store.decide(run_id, "approved")
        plan = await runner.prepare(store, settings, run_id)
        status = await runner.execute(store, settings, plan)

    rows = [r for r in await store.run_requirements(run_id) if r.status != "rejected"]
    read = {
        code
        for call in store.payloads(run_id, "tool_call")
        if call["tool_name"] == "write_requirements"
        for code in call["args"].get("regulations", [])
    }
    problems = [store.errors.get(run_id) or ""] if status != "succeeded" else []
    if status == "succeeded":
        data = json.loads(store.outputs[run_id] or "{}")
        index = await store.regulation_index(ORG)
        problems = [str(p) for p in certivity._tool("validate").validate(data, index=index)]
    return Outcome(
        read=read,
        cited={r.paragraph or "" for r in rows},
        asked_approval_for=asked,
        approved_before_asking=approved_early,
        status=status,
        problems=problems,
        requirements=len(rows),
    )


@dataclass
class ReadsWhatAppliesOnly(Evaluator[str, Outcome, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Outcome, Expected]) -> bool:
        assert ctx.metadata is not None
        return ctx.metadata.reads <= ctx.output.read and not (ctx.metadata.skips & ctx.output.read)


@dataclass
class CoversEveryObligation(Evaluator[str, Outcome, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Outcome, Expected]) -> bool:
        assert ctx.metadata is not None
        return ctx.metadata.covers <= ctx.output.cited


@dataclass
class LeavesOutAnotherDevice(Evaluator[str, Outcome, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Outcome, Expected]) -> bool:
        assert ctx.metadata is not None
        return not (ctx.metadata.never & ctx.output.cited)


@dataclass
class AsksBeforeApproving(Evaluator[str, Outcome, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Outcome, Expected]) -> bool:
        return (
            ctx.output.asked_approval_for == ["export_requirements"]
            and ctx.output.approved_before_asking == 0
        )


@dataclass
class EndsWithAValidFile(Evaluator[str, Outcome, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Outcome, Expected]) -> bool:
        return ctx.output.status == "succeeded" and not ctx.output.problems


dataset = Dataset[str, Outcome, Expected](
    name="requirements_writer",
    cases=[
        Case(
            name="rear_position_lamp",
            inputs="Write the requirements for this rear position lamp.",
            metadata=Expected(
                reads={"UN R148"},
                skips={"UN R43"},
                covers={"5.4.2", "5.4.3", "Annex 5 2"},
                never={"5.5.1"},
            ),
        ),
    ],
    evaluators=[
        ReadsWhatAppliesOnly(),
        CoversEveryObligation(),
        AsksBeforeApproving(),
        EndsWithAValidFile(),
    ],
)


def main() -> None:
    # The scripted writer cites every "shall" it sees: it cannot tell a front lamp from a rear
    # one, and is not meant to. That judgement is only asked of a real model.
    if Settings().agent_model != "scripted":
        dataset.add_evaluator(LeavesOutAnotherDevice())
    report = dataset.evaluate_sync(write)
    report.print(include_input=True, include_output=True, include_durations=True)
    failed = [
        case.name for case in report.cases if not all(a.value for a in case.assertions.values())
    ]
    if failed or report.failures:
        raise SystemExit(f"Failed: {failed + [f.name for f in report.failures]}")


if __name__ == "__main__":
    main()
