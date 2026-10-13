"""Does the agent behave correctly on the example task, with the model in AGENT_MODEL?

Unit tests prove the loop works with a scripted model. This asks the question tests cannot: does
a real model, given the prompt and tools, check every assembly and ask before the risky step?
Run it whenever the prompt, the tools or the model change:

    make eval                                          # scripted model, free
    AGENT_MODEL=anthropic:claude-opus-5-5 make eval    # a real model; this spends tokens

The checks are deterministic (they read the tool calls the agent made), so a pass or fail does
not depend on a second model's opinion.
"""

from dataclasses import dataclass

from pydantic_ai import DeferredToolRequests
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from agent_service import domain
from agent_service.settings import get_settings


@dataclass
class Trajectory:
    tool_calls: list[str]
    asked_approval_for: list[str]
    report: str | None


@dataclass
class Expected:
    fit_checks: int
    asks_approval: bool


async def triage(task: str) -> Trajectory:
    result = await domain.agent.run(
        task, model=domain.resolve_model(get_settings().agent_model), deps=domain.new_deps()
    )
    calls = [
        part.tool_name
        for message in result.all_messages()
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    ]
    if isinstance(result.output, DeferredToolRequests):
        return Trajectory(calls, [c.tool_name for c in result.output.approvals], None)
    return Trajectory(calls, [], result.output)


@dataclass
class ReadsTheNoticeFirst(Evaluator[str, Trajectory, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Trajectory, Expected]) -> bool:
        return ctx.output.tool_calls[:1] == ["plm_get_ecn"]


@dataclass
class ChecksEveryAssembly(Evaluator[str, Trajectory, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Trajectory, Expected]) -> bool:
        assert ctx.metadata is not None
        return ctx.output.tool_calls.count("cad_check_fit") >= ctx.metadata.fit_checks


@dataclass
class AsksBeforeTheRiskyStepAndOnlyThen(Evaluator[str, Trajectory, Expected]):
    def evaluate(self, ctx: EvaluatorContext[str, Trajectory, Expected]) -> bool:
        assert ctx.metadata is not None
        asked = ctx.output.asked_approval_for == ["plm_set_ecn_status"]
        return asked if ctx.metadata.asks_approval else not ctx.output.asked_approval_for


dataset = Dataset[str, Trajectory, Expected](
    name="ecn_triage",
    cases=[
        Case(
            name="collision_requests_a_hold",
            inputs="Triage ECN-1001. Put it on hold if anything collides.",
            metadata=Expected(fit_checks=2, asks_approval=True),
        ),
        Case(
            name="no_collision_changes_nothing",
            inputs="Triage ECN-1002. Put it on hold if anything collides.",
            metadata=Expected(fit_checks=1, asks_approval=False),
        ),
    ],
    evaluators=[ReadsTheNoticeFirst(), ChecksEveryAssembly(), AsksBeforeTheRiskyStepAndOnlyThen()],
)


def main() -> None:
    report = dataset.evaluate_sync(triage)
    report.print(include_input=True, include_output=False, include_durations=True)
    failed = [
        case.name for case in report.cases if not all(a.value for a in case.assertions.values())
    ]
    if failed or report.failures:
        raise SystemExit(f"Failed: {failed + [f.name for f in report.failures]}")


if __name__ == "__main__":
    main()
