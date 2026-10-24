// The run page's chat (#28, SYS-39): the conversation as the browser keeps it and sends it, and
// the agent's answer. Pure, so the route and the panel check the same shapes and node --test
// covers them. The limits are the agent's (agent_service/domain/run_chat.py); checking them here
// too gives the person a sentence instead of the agent's 422.

export type ChatRole = "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };
export type ChatAnswer = { answer: string; model: string; costUsd: number | null };

export const CHAT_MAX_MESSAGE_CHARS = 4000;
// The agent keeps only the last 24 turns for the model; more than 200 is not a conversation.
export const CHAT_MAX_TURNS = 200;

// Questions the panel offers on an empty conversation: the two the feature was asked for.
export const CHAT_SUGGESTIONS = [
  "Which regulations did this run use, and why?",
  "Why did you add R-001?",
  "Which obligations of the chosen regulations might this run have missed?",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The body of POST /api/runs/{id}/chat: { messages: [...] }, the question last. A string is the
// reason for refusing it.
export function parseChatRequest(body: unknown): ChatTurn[] | string {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return 'Expected a JSON body like { "messages": [{ "role": "user", "content": "..." }] }.';
  }
  const turns: ChatTurn[] = [];
  for (const m of body.messages) {
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

// The agent's answer, or null if it is not in the expected form.
export function parseChatAnswer(body: unknown): ChatAnswer | null {
  if (!isRecord(body) || typeof body.answer !== "string" || typeof body.model !== "string") return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  const cost = typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) ? usage.cost_usd : null;
  return { answer: body.answer, model: body.model, costUsd: cost };
}
