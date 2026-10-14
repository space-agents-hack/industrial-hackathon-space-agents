// The admin forms' one way to call their route handlers. Every failure becomes a sentence: the
// route's own `error` when it sent one (the database's refusal, the agent's answer), otherwise a
// generic one with the status.
export type SendResult<T> = { ok: true; body: T } | { ok: false; error: string };

export async function sendJson<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  payload: unknown,
): Promise<SendResult<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) return { ok: false, error: body.error ?? `The request failed (${response.status}).` };
    return { ok: true, body };
  } catch {
    return { ok: false, error: "The server did not answer." };
  }
}
