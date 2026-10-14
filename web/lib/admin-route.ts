import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type DbError, describeDbError } from "@/lib/admin";
import { AgentAdminError } from "@/lib/agent-admin";
import { isPlatformAdmin, managesOrganization } from "@/lib/current-org";
import type { Database } from "@/lib/database.types";
import { type SessionUser, createClient, getSessionUser } from "@/lib/supabase/server";

// The first lines of every admin route handler. The role is asked of the database on each
// request (my_access()), never taken from the page that sent it: a hidden button is not a
// permission, and an admin demoted a minute ago must be refused now. The RPC that does the
// write checks again in the same transaction; this check only avoids calling the agent (which
// acts with the secret key) on behalf of someone who may not.

type Context = { supabase: SupabaseClient<Database>; user: SessionUser };

export function fail(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function requireManager(org: string): Promise<Context | Response> {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return fail("Not signed in.", 401);
  if (!(await managesOrganization(supabase, org))) {
    return fail("Only an admin of this organisation can do this.", 403);
  }
  return { supabase, user };
}

export async function requirePlatformAdmin(): Promise<Context | Response> {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return fail("Not signed in.", 401);
  if (!(await isPlatformAdmin(supabase))) return fail("Only a platform admin can do this.", 403);
  return { supabase, user };
}

// A refusal from one of the platform functions, as a response the page can show as it is.
export function dbFailure(where: string, error: DbError, fallback: string): Response {
  const { message, status } = describeDbError(error, fallback);
  if (status === 500) console.error(`${where} failed`, error);
  return fail(message, status);
}

export function agentFailure(where: string, error: unknown): Response {
  if (error instanceof AgentAdminError) {
    console.error(`${where}: agent call failed (${error.status ?? "no answer"})`);
    // 409 from /providers/models is a state the person can fix; everything else is the agent's.
    return fail(error.userMessage, error.status === 409 ? 409 : 502);
  }
  console.error(`${where}: agent call failed`, error);
  return fail("The agent call failed.", 502);
}
