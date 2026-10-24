import { dbFailure } from "@/lib/admin-route";
import { requireImportManager } from "@/lib/regulation-imports";

// Cancel an import. The agent stops before its next file; files already stored stay in the library.
export async function DELETE(_request: Request, ctx: RouteContext<"/api/regulations/imports/[id]">) {
  const { id } = await ctx.params;
  const context = await requireImportManager(id);
  if (context instanceof Response) return context;

  const { error } = await context.supabase.rpc("cancel_regulation_import", { job: id });
  if (error) return dbFailure(`DELETE /api/regulations/imports/${id}`, error, "The import could not be cancelled.");
  return Response.json({ ok: true });
}
