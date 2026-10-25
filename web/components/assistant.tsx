"use client";

import { ArrowUp, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { type FormEvent, Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";

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
        ).map((t) => {
          const notices = Array.isArray(t.notices) ? t.notices.filter((n): n is string => typeof n === "string") : [];
          return notices.length > 0 ? { role: t.role, content: t.content, notices } : { role: t.role, content: t.content };
        })
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

// The bar at the bottom of every page inside a project, and the panel it opens (SYS-39, #31):
// questions about the project's regulations, cases and runs, answered by the organisation's model,
// with the page the person is on as the starting point.
//
// The launcher is drawn as a text field with a send button, as in Sereno, not as a round icon: a
// lone speech-bubble icon in a corner was easy to miss and did not say what it was for, while a
// field that reads "Ask about <project>" says both before anyone clicks. It is still a button, and
// typing happens in the panel.
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
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Read after mount: sessionStorage does not exist on the server, and reading it during the
  // first render would make the server and client HTML differ.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser-only state once
    setTurns(loadTurns(projectId));
  }, [projectId]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [turns, waiting, open]);

  // The launcher is hidden while the panel is open, so closing the panel puts focus back on it;
  // otherwise a keyboard user would be dropped at the top of the page.
  useEffect(() => {
    if (open) input.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
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
    setWaiting(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          path: pathname,
          messages: next.map(({ role, content }) => ({ role, content })),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      const answer = response.ok ? parseChatAnswer(body) : null;
      if (!answer) {
        // The question stays in the list, unanswered, so it can be asked again with one click.
        setError(errorOf(body, response.status));
        return;
      }
      const answered: ChatTurn[] = [
        ...next,
        { role: "assistant", content: answer.answer, ...(answer.notices.length > 0 ? { notices: answer.notices } : {}) },
      ];
      setTurns(answered);
      saveTurns(projectId, answered);
      setModel(answer.model);
      setLastCost(answer.costUsd);
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
  const where = page.run_id ? "this draft" : page.case_id ? "this part" : page.regulation_id ? "this regulation" : null;

  return (
    <>
      {open ? (
        <section
          aria-label="Assistant"
          className="fixed right-4 bottom-4 z-40 flex h-[min(40rem,calc(100dvh-2rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-[0_8px_32px_rgb(0_0_0/0.14)]"
        >
          <header className="flex items-center gap-2.5 border-b px-4 py-3">
            <MessageSquareText aria-hidden className="size-4 shrink-0 text-tint" strokeWidth={1.75} />
            <div className="grid min-w-0">
              <h2 className="truncate text-sm font-semibold">Ask about {projectName}</h2>
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

          <div ref={list} className="grid flex-1 content-start gap-2.5 overflow-y-auto px-4 py-4 text-sm" aria-live="polite">
            {turns.length === 0 ? (
              <div className="grid gap-2">
                <p className="text-muted-foreground">
                  Answers come from this project&apos;s regulations, parts and drafts, and the page you are on. The
                  conversation stays while you move between pages.
                </p>
                {suggestionsFor(page).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              turns.map((t, i) => (
                <Fragment key={i}>
                  <p
                    className={
                      t.role === "user"
                        ? "ml-10 justify-self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 break-words whitespace-pre-wrap text-primary-foreground"
                        : "mr-6 justify-self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2 break-words whitespace-pre-wrap"
                    }
                  >
                    {t.content}
                  </p>
                  {t.notices?.length ? (
                    <ul role="note" className="mr-4 -mt-1 grid gap-1 text-xs font-medium text-attention">
                      {t.notices.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </Fragment>
              ))
            )}
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

          <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t px-4 py-3">
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

      {open ? null : (
        // Centred on the page column, not the window: from `md` the 16rem sidebar takes the left of
        // the window, so the centre of what the person reads is 8rem to the right of the window's.
        // z-30 keeps it under the phone drawer's backdrop; `main`'s bottom padding (6rem) keeps the
        // last row of every page above it.
        <button
          ref={launcher}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label={`Ask the assistant about ${projectName}`}
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
          className="fixed left-1/2 z-30 flex h-12 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-2xl border bg-card pr-2 pl-4 text-left text-sm text-muted-foreground shadow-[0_4px_16px_rgb(0_0_0/0.12)] transition-[color,box-shadow] outline-none hover:text-foreground hover:shadow-[0_6px_20px_rgb(0_0_0/0.16)] focus-visible:ring-2 focus-visible:ring-ring md:left-[calc(50%+8rem)] md:w-[min(30rem,calc(100%-18rem))]"
        >
          {waiting ? (
            <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-tint" />
          ) : (
            <MessageSquareText aria-hidden className="size-4 shrink-0 text-tint" strokeWidth={1.75} />
          )}
          <span className="min-w-0 flex-1 truncate">{waiting ? "Reading the project…" : `Ask about ${projectName}`}</span>
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </span>
        </button>
      )}
    </>
  );
}
