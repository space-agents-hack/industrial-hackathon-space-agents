"use client";

import { MessageSquareText, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CHAT_MAX_MESSAGE_CHARS,
  type ChatTurn,
  pageFromPath,
  parseChatAnswer,
  suggestionsFor,
} from "@/lib/assistant";

// The conversation lives in this component, which sits in the app layout: Next.js keeps a layout
// mounted while the person moves between pages, so the conversation survives navigation. It is
// also kept per project in this tab, so a reload keeps it too. Nothing is stored on the server
// (agent_service/domain/assistant.py).
function storageKey(projectId: string): string {
  return `assistant:${projectId}`;
}

function loadTurns(projectId: string): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (t): t is ChatTurn =>
            typeof t === "object" &&
            t !== null &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function saveTurns(projectId: string, turns: ChatTurn[]): void {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(turns));
  } catch {
    // Private windows can refuse storage; the conversation then lasts until a reload.
  }
}

function errorOf(body: unknown, status: number): string {
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : `The server answered ${status}.`;
}

// The bubble at the bottom right of every page inside a project, and the panel it opens (SYS-39,
// #31): questions about the project's regulations, cases and runs, answered by the organisation's
// model, with the page the person is on as the starting point.
export function Assistant({ projectId, projectName }: { projectId: string; projectName: string }) {
  const pathname = usePathname();
  const page = pageFromPath(pathname);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [lastCost, setLastCost] = useState<number | null>(null);
  // The agent's notices about the last answer (#37), under it; not kept with the conversation.
  const [notices, setNotices] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Read after mount: sessionStorage does not exist on the server, and reading it during the
  // first render would make the server and client HTML differ.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser-only state once
    setTurns(loadTurns(projectId));
  }, [projectId]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [turns, waiting, open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // The model's name, asked for when the panel first opens; each answer names it again, so a
  // change in Admin shows on the next answer.
  useEffect(() => {
    if (!open || model !== null) return;
    let cancelled = false;
    fetch(`/api/chat/model?project_id=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        const name = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : null;
        if (!cancelled && typeof name === "string") setModel(name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, model, projectId]);

  // `before` is the conversation the question follows: all of it, or all but an unanswered
  // question that is being asked again.
  async function ask(question: string, before: ChatTurn[] = turns) {
    const text = question.trim();
    if (!text || waiting) return;
    const next: ChatTurn[] = [...before, { role: "user", content: text }];
    setTurns(next);
    saveTurns(projectId, next);
    setDraft("");
    setError(null);
    setNotices([]);
    setWaiting(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, path: pathname, messages: next }),
      });
      const body: unknown = await response.json().catch(() => null);
      const answer = response.ok ? parseChatAnswer(body) : null;
      if (!answer) {
        // The question stays in the list, unanswered, so it can be asked again with one click.
        setError(errorOf(body, response.status));
        return;
      }
      const answered: ChatTurn[] = [...next, { role: "assistant", content: answer.answer }];
      setTurns(answered);
      saveTurns(projectId, answered);
      setModel(answer.model);
      setLastCost(answer.costUsd);
      setNotices(answer.notices);
    } catch {
      setError("The question could not be sent: the server did not answer.");
    } finally {
      setWaiting(false);
    }
  }

  function retry() {
    const last = turns[turns.length - 1];
    if (last?.role !== "user") return;
    void ask(last.content, turns.slice(0, -1));
  }

  function clear() {
    setTurns([]);
    saveTurns(projectId, []);
    setError(null);
    setLastCost(null);
    setNotices([]);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a new line, as in every chat.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
    if (event.key === "Escape") setOpen(false);
  }

  const unanswered = turns.length > 0 && turns[turns.length - 1].role === "user" && !waiting;
  const where = page.run_id ? "this run" : page.case_id ? "this case" : page.regulation_id ? "this regulation" : null;

  return (
    <>
      {open ? (
        <section
          aria-label="Assistant"
          className="fixed right-4 bottom-20 z-40 flex h-[min(34rem,calc(100dvh-7rem))] w-[min(26rem,calc(100vw-2rem))] flex-col rounded-lg border bg-card shadow-lg"
        >
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <div className="grid min-w-0">
              <h2 className="text-sm font-medium">Ask about {projectName}</h2>
              {where ? <span className="text-xs text-muted-foreground">Starting from {where}</span> : null}
            </div>
            {turns.length > 0 ? (
              <Button variant="ghost" size="xs" className="ml-auto" onClick={clear} disabled={waiting}>
                Clear
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              className={turns.length > 0 ? "" : "ml-auto"}
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <X />
            </Button>
          </header>

          <div ref={list} className="grid flex-1 content-start gap-2 overflow-y-auto px-3 py-3 text-sm" aria-live="polite">
            {turns.length === 0 ? (
              <div className="grid gap-2">
                <p className="text-muted-foreground">
                  Answers come from this project&apos;s regulations, cases and runs, and the page you are on. The
                  conversation stays while you move between pages.
                </p>
                {suggestionsFor(page).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-md border px-2.5 py-1.5 text-left hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              turns.map((t, i) => (
                <p
                  key={i}
                  className={
                    t.role === "user"
                      ? "ml-8 justify-self-end rounded-md bg-primary px-2.5 py-1.5 break-words whitespace-pre-wrap text-primary-foreground"
                      : "mr-4 rounded-md border bg-background px-2.5 py-1.5 break-words whitespace-pre-wrap"
                  }
                >
                  {t.content}
                </p>
              ))
            )}
            {notices.length > 0 && !waiting ? (
              <ul className="mr-4 grid gap-1 text-xs font-medium text-attention">
                {notices.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
            {waiting ? <p className="text-muted-foreground">Reading the project…</p> : null}
            {error ? (
              <div role="alert" className="grid gap-1.5 rounded-md border border-danger-border bg-danger-surface px-2.5 py-1.5 text-danger">
                <p>{error}</p>
                {unanswered ? (
                  <Button variant="outline" size="xs" className="w-fit" onClick={retry}>
                    Ask again
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t px-3 py-2">
            <Textarea
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={CHAT_MAX_MESSAGE_CHARS}
              placeholder="Why did you add R-012? Is the obligation on … captured?"
              aria-label="Your question"
              rows={2}
              // Fixed, not sized to its content: a long placeholder would widen it past the panel.
              className="max-h-32 min-h-10 resize-none field-sizing-fixed"
              disabled={waiting}
            />
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={model ?? undefined}>
                Model: <code className="font-mono">{model ?? "…"}</code>
                {lastCost !== null ? (
                  <span title="Estimated cost of the last answer, from public price lists">{` · $${lastCost.toFixed(3)}`}</span>
                ) : null}
              </span>
              <Button type="submit" size="sm" disabled={waiting || !draft.trim()}>
                Ask
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <Button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Close the assistant" : "Ask the assistant"}
        className="fixed right-4 bottom-4 z-40 size-12 rounded-full shadow-md"
      >
        {open ? <X className="size-5" /> : <MessageSquareText className="size-5" />}
      </Button>
    </>
  );
}
