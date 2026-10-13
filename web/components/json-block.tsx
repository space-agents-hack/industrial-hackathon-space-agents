import { compactJson, formatJson, isLongText } from "@/lib/trace";
import { cn } from "@/lib/utils";

const BOX = "rounded-sm border bg-muted/60 font-mono text-xs break-words whitespace-pre-wrap";
const INLINE_LIMIT = 90;

// JSON (or plain text) from the agent, in three sizes: one line when it fits, a block when it
// does not, and collapsed behind a preview when it is long, so a 500-row tool result does not
// push the rest of the trace off the screen.
export function JsonBlock({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: unknown;
  tone?: "neutral" | "red";
}) {
  const text = formatJson(value);
  const box = cn(BOX, tone === "red" && "border-red-200 bg-red-50 text-red-900");
  const oneLine = typeof value === "string" ? value : JSON.stringify(value);

  if (typeof oneLine === "string" && oneLine.length <= INLINE_LIMIT && !oneLine.includes("\n")) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <code className={cn(box, "min-w-0 px-1.5 py-0.5")}>{oneLine}</code>
      </div>
    );
  }

  if (!isLongText(text)) {
    return (
      <div className="grid gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <pre className={cn(box, "px-2 py-1.5 leading-relaxed")}>{text}</pre>
      </div>
    );
  }

  const lines = text.split("\n").length;
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
        {label}
        <span className="ml-1.5">
          ({lines > 1 ? `${lines} lines` : `${text.length.toLocaleString("en-US")} characters`})
        </span>
        <span className="ml-1.5 font-mono group-open:hidden">{compactJson(value, 72)}</span>
      </summary>
      <pre className={cn(box, "mt-1 max-h-96 overflow-auto px-2 py-1.5 leading-relaxed")}>{text}</pre>
    </details>
  );
}
