// The assistant behind the bubble on every page of a project (SYS-39, #28, #31): the
// conversation as the browser keeps it and sends it, the page it is asked from, and the agent's
// answer. Pure, so the route and the panel check the same shapes and node --test covers them. The
// limits are the agent's (agent_service/domain/assistant.py); checking them here too gives the
// person a sentence instead of the agent's 422.

import { isUuid } from "./validation.ts";

export type ChatRole = "user" | "assistant";
// `notices`: what the agent said about how an answer was found (#37), kept with the answer it
// belongs to in the tab's conversation. Never sent back to the agent.
export type ChatTurn = { role: ChatRole; content: string; notices?: string[] };
// `notices`: what the agent says about how the answer was found, shown as it is under the answer
// whatever the model wrote (a search that matched words only, #37).
export type ChatAnswer = { answer: string; model: string; costUsd: number | null; notices: string[] };
// Where the question is asked from. The agent checks every id belongs to the project.
export type ChatPage = { path: string; run_id?: string; case_id?: string; regulation_id?: string };
export type ChatRequest = { projectId: string; page: ChatPage; messages: ChatTurn[] };

export const CHAT_MAX_MESSAGE_CHARS = 4000;
// The agent keeps only the last 24 turns for the model; more than 200 is not a conversation.
export const CHAT_MAX_TURNS = 200;
const MAX_PATH = 500;

// What the panel offers on an empty conversation, by the page it opens on.
export function suggestionsFor(page: ChatPage): string[] {
  if (page.run_id) {
    return [
      "Why did you add R-001?",
      "Which obligations of the chosen regulations might this run have missed?",
      "Which regulations did this run use, and why?",
    ];
  }
  if (page.case_id) {
    return ["What does this case describe?", "Which regulations are likely to apply to it?"];
  }
  return [
    "What is in this project so far?",
    "Which regulations does this project use?",
    "What did the latest run produce?",
  ];
}

// The page's ids, read from the URL: /runs/{id}, /projects/{p}/cases/{id}, /regulations/{id}.
export function pageFromPath(path: string): ChatPage {
  const clean = path.split(/[?#]/)[0].slice(0, MAX_PATH) || "/";
  const parts = clean.split("/").filter(Boolean);
  const page: ChatPage = { path: clean };
  if (parts[0] === "runs" && parts[1] && isUuid(parts[1])) page.run_id = parts[1];
  if (parts[0] === "projects" && parts[2] === "cases" && parts[3] && isUuid(parts[3])) page.case_id = parts[3];
  if (parts[0] === "regulations" && parts[1] && isUuid(parts[1])) page.regulation_id = parts[1];
  return page;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTurns(value: unknown): ChatTurn[] | string {
  if (!Array.isArray(value)) return "Expected the conversation as a list of messages.";
  const turns: ChatTurn[] = [];
  for (const m of value) {
    if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return "Each message needs a role (user or assistant) and a content.";
    }
    const content = m.content.trim();
    if (!content) return "A message is empty.";
    if (content.length > CHAT_MAX_MESSAGE_CHARS) {
      return `A message is over ${CHAT_MAX_MESSAGE_CHARS} characters.`;
    }
    turns.push({ role: m.role, content });
  }
  if (turns.length === 0) return "There is no question.";
  if (turns.length > CHAT_MAX_TURNS) return "The conversation is too long. Clear it and ask again.";
  if (turns[turns.length - 1].role !== "user") return "The last message must be the question.";
  return turns;
}

// The body of POST /api/chat: { project_id, path, messages }, the question last. The page's ids
// are derived from the path here, not taken from the browser, so there is one way to name them.
// A string is the reason for refusing it.
export function parseChatRequest(body: unknown): ChatRequest | string {
  if (!isRecord(body)) {
    return 'Expected a JSON body like { "project_id": "...", "path": "/", "messages": [...] }.';
  }
  if (typeof body.project_id !== "string" || !isUuid(body.project_id)) return "project_id must be a project id.";
  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path : "/";
  const messages = parseTurns(body.messages);
  if (typeof messages === "string") return messages;
  return { projectId: body.project_id, page: pageFromPath(path), messages };
}

// The agent's answer, or null if it is not in the expected form.
export function parseChatAnswer(body: unknown): ChatAnswer | null {
  if (!isRecord(body) || typeof body.answer !== "string" || typeof body.model !== "string") return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  const cost = typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) ? usage.cost_usd : null;
  const notices = Array.isArray(body.notices) ? body.notices.filter((n): n is string => typeof n === "string") : [];
  return { answer: body.answer, model: body.model, costUsd: cost, notices };
}
