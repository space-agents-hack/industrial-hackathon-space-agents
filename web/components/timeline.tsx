import { JsonBlock } from "@/components/json-block";
import { ToneBadge } from "@/components/status-badge";
import {
  type EventStep,
  type TimelineItem,
  type ToolStep,
  formatElapsed,
  formatUtc,
  isEmptyArgs,
  statusLabel,
  statusTone,
  summarizeEvent,
  toolStepStatus,
} from "@/lib/trace";

export function Timeline({
  items,
  startedAt,
  runFinished,
}: {
  items: TimelineItem[];
  startedAt: string;
  runFinished: boolean;
}) {
  return (
    <ol className="divide-y rounded-md border bg-card">
      {items.map((item) => {
        const at = item.type === "tool" ? item.startedAt : item.event.createdAt;
        return (
          <li key={item.key} className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[4.5rem_1fr]">
            <time
              dateTime={at}
              title={formatUtc(at)}
              className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums"
            >
              {formatElapsed(startedAt, at)}
            </time>
            <div className="min-w-0">
              {item.type === "tool" ? (
                <ToolRow step={item} startedAt={startedAt} runFinished={runFinished} />
              ) : (
                <EventRow step={item} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ToolRow({
  step,
  startedAt,
  runFinished,
}: {
  step: ToolStep;
  startedAt: string;
  runFinished: boolean;
}) {
  const status = toolStepStatus(step, runFinished);

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-muted-foreground">Tool</span>
        <code className="font-mono text-[0.8rem] font-semibold break-all">{step.toolName}</code>
        <ToneBadge tone={status.tone} pulse={status.label === "Running"}>
          {status.label}
        </ToneBadge>
      </div>

      {isEmptyArgs(step.args) ? null : <JsonBlock label="Arguments" value={step.args} />}

      {step.approval ? (
        <p className="text-xs">
          {step.approval.state === "requested" ? (
            <span className="text-attention">Needs a person&apos;s approval before it runs.</span>
          ) : (
            <span className={step.approval.state === "approved" ? "text-success" : "text-danger"}>
              {step.approval.state === "approved" ? "Approved" : "Denied"} by a person
              {step.approval.note ? <>: &ldquo;{step.approval.note}&rdquo;</> : "."}
            </span>
          )}
        </p>
      ) : null}

      {step.result ? (
        <JsonBlock
          label={`${step.result.isError ? "Error" : "Result"} at ${formatElapsed(startedAt, step.result.at)}`}
          value={step.result.value}
          tone={step.result.isError ? "red" : "neutral"}
        />
      ) : null}
    </div>
  );
}

function EventRow({ step }: { step: EventStep }) {
  const { event } = step;
  switch (event.kind) {
    case "status":
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <ToneBadge tone={statusTone(event.payload.status)}>{statusLabel(event.payload.status)}</ToneBadge>
          {event.payload.detail ? (
            <span className="min-w-0 break-words text-muted-foreground">{event.payload.detail}</span>
          ) : null}
        </div>
      );
    case "text":
      return (
        <div className="grid gap-0.5">
          <span className="text-xs text-muted-foreground">Agent</span>
          <p className="break-words whitespace-pre-wrap">{event.payload.text}</p>
        </div>
      );
    case "error":
      return (
        <div className="grid gap-0.5">
          <span className="text-xs font-medium text-danger">Error</span>
          <p className="break-words whitespace-pre-wrap text-danger">{event.payload.message}</p>
        </div>
      );
    case "unknown":
      return (
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">{summarizeEvent(event)}</span>
          <JsonBlock label="Payload" value={event.payload} />
        </div>
      );
    default:
      // Tool and approval events are folded into a ToolRow by buildTimeline. If one ever arrives
      // here it is still shown, as its one-line summary.
      return <p className="break-words text-muted-foreground">{summarizeEvent(event)}</p>;
  }
}
