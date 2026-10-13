import { Badge } from "@/components/ui/badge";
import { type Tone, statusLabel, statusTone } from "@/lib/trace";
import { cn } from "@/lib/utils";

// The only place status colours are defined: neutral queued, blue running, amber awaiting
// approval, green succeeded, red failed.
const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-700",
  blue: "border-blue-300 bg-blue-50 text-blue-800",
  amber: "border-amber-400 bg-amber-50 text-amber-900",
  green: "border-emerald-300 bg-emerald-50 text-emerald-800",
  red: "border-red-300 bg-red-50 text-red-800",
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
