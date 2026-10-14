import { Badge } from "@/components/ui/badge";
import { type Tone, statusLabel, statusTone } from "@/lib/trace";
import { cn } from "@/lib/utils";

// Neutral queued, blue running, amber awaiting approval, green succeeded, red failed. The colours
// themselves are tokens in app/globals.css, with their dark values.
const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border bg-muted text-secondary-foreground",
  blue: "border-progress-border bg-progress-surface text-progress",
  amber: "border-attention-border bg-attention-surface text-attention",
  green: "border-success-border bg-success-surface text-success",
  red: "border-danger-border bg-danger-surface text-danger",
};

export function ToneBadge({
  tone,
  pulse = false,
  className,
  children,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn(TONE_CLASSES[tone], className)}>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")}
      />
      {children}
    </Badge>
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <ToneBadge tone={statusTone(status)} pulse={status === "running"} className={className}>
      {statusLabel(status)}
    </ToneBadge>
  );
}
