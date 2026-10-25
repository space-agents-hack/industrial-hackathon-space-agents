import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  MAX_PASSWORD_BYTES,
  PROVIDERS,
  capShare,
  describeDbError,
  formatModelPrice,
  formatMonth,
  formatUsd,
  looksLikeTeamId,
  formatUsdPerMtok,
  generatePassword,
  listNeedsKey,
  modelName,
  modelSourceOf,
  parseAddPerson,
  parseCreateOrganization,
  parseModelList,
  parseOrganizationName,
  parseRenameOrganization,
  parseProviderEndpoint,
  parseProviderKey,
  parseRemoveMember,
  parseSetMember,
  parseSetPassword,
  parseSettings,
  shortId,
  summarizeAuditEvent,
} from "./admin.ts";
import { OPENROUTER_RESULTS, openRouterAuthUrl, openRouterResultMessage, requestOrigin } from "./openrouter-oauth.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

test("the providers are exactly the ones the database accepts", () => {
  // The latest migration that sets the check is the one in force.
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const checks = readdirSync(dir)
    .sort()
    .flatMap((name) => [...readFileSync(new URL(name, dir), "utf8").matchAll(/\bprovider in \(([^)]+)\)/g)]);
  const check = checks.at(-1);
  assert.ok(check);
  const allowed = check[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(PROVIDERS.map((p) => p.id).sort(), allowed.sort());
});

test("a stored model maps to its picker, including OpenAI's three prefixes", () => {
  assert.equal(modelSourceOf("scripted"), "scripted");
  assert.equal(modelSourceOf("anthropic:claude-opus-5-5"), "anthropic");
  assert.equal(modelSourceOf("openai-responses:gpt-5"), "openai");
  assert.equal(modelSourceOf("openai-chat:gpt-5"), "openai");
  assert.equal(modelSourceOf("openrouter:anthropic/claude-opus-5-5"), "openrouter");
  assert.equal(modelSourceOf("deepseek:deepseek-chat"), "deepseek");
  // Ollama tags carry their own colon; the first one is the prefix.
  assert.equal(modelSourceOf("ollama:llama3.1:8b"), "ollama");
  assert.equal(modelName("ollama:llama3.1:8b"), "llama3.1:8b");
  assert.equal(modelSourceOf(null), null);
  assert.equal(modelSourceOf("mistral:large"), null);
  assert.equal(modelSourceOf(":nothing"), null);
});

test("only direct providers need a key to list models", () => {
  assert.equal(listNeedsKey("scripted"), false);
  assert.equal(listNeedsKey("openrouter"), false);
  assert.equal(listNeedsKey("anthropic"), true);
  assert.equal(listNeedsKey("deepseek"), true);
  assert.equal(listNeedsKey("ollama"), true);
});

test("model ids and prices read the way someone choosing a model needs", () => {
  assert.equal(modelName("openrouter:anthropic/claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(modelName("scripted"), "scripted");
  assert.equal(formatUsdPerMtok(15), "$15.00");
  assert.equal(formatUsdPerMtok(3), "$3.00");
  assert.equal(formatUsdPerMtok(0.075), "$0.075");
  assert.equal(formatUsdPerMtok(0.5), "$0.50");
  assert.equal(formatUsdPerMtok(0.00001), "$0.00");
  assert.equal(formatUsdPerMtok(0), "free");
  assert.equal(formatModelPrice({ promptUsdPerMtok: 3, completionUsdPerMtok: 15 }), "$3.00 in / $15.00 out per M tokens");
  assert.equal(formatModelPrice({ promptUsdPerMtok: 0, completionUsdPerMtok: 0 }), "free");
  assert.equal(formatModelPrice({ promptUsdPerMtok: null, completionUsdPerMtok: 15 }), "price not published");
});

test("parseModelList keeps well-formed entries once each", () => {
  const models = parseModelList({
    models: [
      { id: "anthropic:claude-opus-5-5", label: "Claude Opus", prompt_usd_per_mtok: 5, completion_usd_per_mtok: 25 },
      { id: "anthropic:claude-opus-5-5", label: "duplicate" },
      { id: "no-prefix", label: "x" },
      { id: "openai:gpt-5", label: "", prompt_usd_per_mtok: -1, completion_usd_per_mtok: "2" },
      "junk",
    ],
  });
  assert.deepEqual(models, [
    { id: "anthropic:claude-opus-5-5", label: "Claude Opus", promptUsdPerMtok: 5, completionUsdPerMtok: 25 },
    { id: "openai:gpt-5", label: "gpt-5", promptUsdPerMtok: null, completionUsdPerMtok: null },
  ]);
  assert.deepEqual(parseModelList(null), []);
});

test("settings: an empty field is null (the default), never zero", () => {
  assert.deepEqual(parseSettings({ org: ORG, model: "", max_model_requests: "", monthly_cost_cap_usd: " " }), {
    ok: true,
    value: { org: ORG, model: null, maxModelRequests: null, monthlyCostCapUsd: null },
  });
  assert.deepEqual(parseSettings({ org: ORG, model: "scripted", max_model_requests: "30", monthly_cost_cap_usd: "12.345" }), {
    ok: true,
    value: { org: ORG, model: "scripted", maxModelRequests: 30, monthlyCostCapUsd: 12.35 },
  });
  assert.equal(parseSettings({ org: ORG, monthly_cost_cap_usd: "0" }).ok, true, "0 is a real cap");
});

test("settings: the database's bounds are enforced first", () => {
  for (const bad of ["0", "201", "2.5", "-1", "ten"]) {
    assert.equal(parseSettings({ org: ORG, max_model_requests: bad }).ok, false, bad);
  }
  assert.equal(parseSettings({ org: ORG, max_model_requests: 200 }).ok, true);
  assert.equal(parseSettings({ org: ORG, monthly_cost_cap_usd: "-5" }).ok, false);
  assert.equal(parseSettings({ org: ORG, monthly_cost_cap_usd: "1e3" }).ok, false);
  assert.equal(parseSettings({ org: ORG, model: "has space" }).ok, false);
  assert.equal(parseSettings({ org: "Default" }).ok, false);
});

test("people and keys: bodies are checked before anything is called", () => {
  const person = { org: ORG, email: " Ana@Example.com ", role: "member", password: "twelve chars" };
  assert.deepEqual(parseAddPerson(person), {
    ok: true,
    value: { org: ORG, email: "ana@example.com", role: "member", password: "twelve chars" },
  });
  assert.equal(parseAddPerson({ ...person, password: "short" }).ok, false);
  assert.equal(parseAddPerson({ ...person, password: "x".repeat(MAX_PASSWORD_BYTES + 1) }).ok, false);
  assert.equal(parseAddPerson({ ...person, role: "owner" }).ok, false);
  assert.equal(parseAddPerson({ ...person, email: "Ana" }).ok, false);
  // No password: an existing account is added with the one it has.
  assert.deepEqual(parseAddPerson({ ...person, password: "" }), {
    ok: true,
    value: { org: ORG, email: "ana@example.com", role: "member", password: null },
  });
  assert.equal(parseAddPerson({ org: ORG, email: "ana@example.com", role: "viewer" }).ok, true);
  assert.equal(parseRemoveMember({ org: ORG, user_id: USER }).ok, true);
  assert.equal(parseRemoveMember({ org: ORG, user_id: "ana@example.com" }).ok, false);

  assert.equal(parseSetMember({ org: ORG, user_id: USER, role: "viewer", status: "suspended" }).ok, true);
  assert.equal(parseSetMember({ org: ORG, user_id: USER, role: "viewer", status: "deleted" }).ok, false);
  assert.equal(parseSetPassword({ org: ORG, user_id: USER, password: "a long enough one" }).ok, true);
  assert.equal(parseSetPassword({ org: ORG, user_id: "me", password: "a long enough one" }).ok, false);

  assert.equal(parseProviderKey({ org: ORG, provider: "anthropic", api_key: "x".repeat(16) }).ok, true);
  assert.equal(parseProviderKey({ org: ORG, provider: "anthropic", api_key: "too-short" }).ok, false);
  assert.equal(parseProviderKey({ org: ORG, provider: "anthropic", api_key: "has a space in the middle" }).ok, false);
  assert.equal(parseProviderKey({ org: ORG, provider: "mistral", api_key: "x".repeat(16) }).ok, false);
  assert.equal(parseProviderKey({ org: ORG, provider: "ollama", api_key: "x".repeat(16) }).ok, false);

  assert.deepEqual(parseOrganizationName({ name: "  Acme  " }), { ok: true, value: { name: "Acme" } });
  assert.equal(parseOrganizationName({ name: " " }).ok, false);
  assert.deepEqual(parseCreateOrganization({ name: "Acme", admin_email: " Ana@Example.com " }), {
    ok: true,
    value: { name: "Acme", adminEmail: "ana@example.com" },
  });
  assert.deepEqual(parseCreateOrganization({ name: "Acme", admin_email: "" }), {
    ok: true,
    value: { name: "Acme", adminEmail: null },
  });
  assert.equal(parseCreateOrganization({ name: "Acme", admin_email: "ana" }).ok, false);
  assert.equal(parseCreateOrganization({ name: "", admin_email: "ana@example.com" }).ok, false);
});

test("renaming an organisation: its id and a trimmed name; the team id hint", () => {
  assert.deepEqual(parseRenameOrganization({ org: ORG, name: "  team-09 " }), {
    ok: true,
    value: { org: ORG, name: "team-09" },
  });
  assert.equal(parseRenameOrganization({ org: "nope", name: "team-09" }).ok, false);
  assert.equal(parseRenameOrganization({ org: ORG, name: "  " }).ok, false);
  assert.equal(looksLikeTeamId("team-09"), true);
  assert.equal(looksLikeTeamId("Space agents"), false);
  assert.equal(looksLikeTeamId("team-09 "), false);
});

test("an Ollama server: URL and credentials are checked before anything is called", () => {
  const server = { org: ORG, provider: "ollama", base_url: " http://localhost:11434 ", auth_scheme: "none" };
  assert.deepEqual(parseProviderEndpoint({ ...server, username: "ignored", secret: "ignored" }), {
    ok: true,
    value: {
      org: ORG,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      authScheme: "none",
      username: null,
      secret: null,
    },
  });
  const basic = parseProviderEndpoint({ ...server, auth_scheme: "basic", username: " eng ", secret: "pw" });
  assert.ok(basic.ok);
  assert.equal(basic.value.username, "eng");
  assert.equal(basic.value.secret, "pw");
  // An empty secret means "keep the stored one", which the database decides.
  const bearer = parseProviderEndpoint({ ...server, base_url: "https://gpu.example.test/ollama", auth_scheme: "bearer", secret: "" });
  assert.ok(bearer.ok);
  assert.equal(bearer.value.secret, null);

  const refused = (fields: Record<string, unknown>) => parseProviderEndpoint({ ...server, ...fields }).ok === false;
  assert.ok(refused({ base_url: "http://admin:pw@localhost:11434" }));
  assert.ok(refused({ base_url: "file:///etc/passwd" }));
  assert.ok(refused({ base_url: "http://localhost:11434/?token=x" }));
  assert.ok(refused({ base_url: "" }));
  assert.ok(refused({ auth_scheme: "digest" }));
  assert.ok(refused({ auth_scheme: "basic", username: "" }));
  assert.ok(refused({ auth_scheme: "basic", username: "a:b", secret: "pw" }));
  assert.ok(refused({ auth_scheme: "bearer", secret: "two\nlines" }));
  assert.ok(refused({ provider: "openai" }));
  // The message about credentials in the URL names the fields to use instead.
  const inUrl = parseProviderEndpoint({ ...server, base_url: "https://u:p@host" });
  assert.ok(!inUrl.ok && /own fields/.test(inUrl.error));
});

test("generated passwords are long enough and avoid look-alike characters", () => {
  const password = generatePassword();
  assert.equal(password.length, 16);
  assert.doesNotMatch(password, /[0O1lI]/);
  assert.notEqual(generatePassword(), password);
});

test("the database's sentences reach the person; faults do not", () => {
  assert.deepEqual(
    describeDbError({ code: "23514", message: "this would leave the organisation without an admin" }, "x"),
    { message: "This would leave the organisation without an admin.", status: 409 },
  );
  assert.equal(describeDbError({ code: "42501", message: "only an admin of this organisation manages its keys" }, "x").status, 403);
  // What a table's own check constraint says (seen against the local database).
  assert.deepEqual(
    describeDbError(
      {
        code: "23514",
        message:
          'new row for relation "organization_settings" violates check constraint "organization_settings_max_model_requests_check"',
      },
      "x",
    ),
    { message: "The database refused that value.", status: 400 },
  );
  assert.deepEqual(describeDbError({ code: "XX000", message: "internal detail" }, "Could not save."), {
    message: "Could not save.",
    status: 500,
  });
});

test("audit lines are readable sentences", () => {
  const nameOf = (id: string) => (id === USER ? "ana@example.com" : shortId(id));
  assert.equal(
    summarizeAuditEvent({ action: "member.set", detail: { user_id: USER, role: "admin", status: "active" } }, nameOf),
    "ana@example.com: admin, active.",
  );
  assert.equal(
    summarizeAuditEvent({ action: "regulations.deleted", detail: { codes: ["UN R10"], requirements_unlinked: 0 } }, nameOf),
    "Deleted the regulation UN R10 from the library.",
  );
  assert.equal(
    summarizeAuditEvent(
      {
        action: "regulations.deleted",
        detail: { codes: ["UN R1", "UN R2", "UN R3", "UN R4", "UN R5", "UN R6", "UN R7"], requirements_unlinked: 3 },
      },
      nameOf,
    ),
    "Deleted 7 regulations UN R1, UN R2, UN R3, UN R4, UN R5 and 2 more from the library; 3 requirements kept their citation without the link.",
  );
  assert.equal(
    summarizeAuditEvent({ action: "member.removed", detail: { user_id: ORG, email: "bo@example.com" } }, nameOf),
    "Removed bo@example.com from the organisation.",
  );
  assert.equal(
    summarizeAuditEvent({ action: "member.set", detail: { user_id: ORG, role: "viewer", status: "suspended" } }, nameOf),
    "user 11111111: viewer, suspended.",
  );
  assert.equal(
    summarizeAuditEvent(
      { action: "provider.connected", detail: { provider: "openrouter", last4: "a1b2", source: "openrouter_oauth" } },
      nameOf,
    ),
    "Connected OpenRouter (key ending a1b2, OpenRouter login).",
  );
  assert.equal(
    summarizeAuditEvent({ action: "provider.rotated", detail: { provider: "anthropic", last4: "zz99", source: "pasted" } }, nameOf),
    "Replaced the key of Anthropic (key ending zz99, pasted).",
  );
  assert.equal(summarizeAuditEvent({ action: "provider.deleted", detail: { provider: "deepseek" } }, nameOf), "Removed the DeepSeek key.");
  assert.equal(
    summarizeAuditEvent(
      {
        action: "provider.rotated",
        detail: { provider: "ollama", base_url: "https://gpu.example.test", auth_scheme: "bearer", last4: "wxyz" },
      },
      nameOf,
    ),
    "Changed the Ollama server https://gpu.example.test (authentication: bearer token, token ending wxyz).",
  );
  assert.equal(
    summarizeAuditEvent(
      {
        action: "provider.connected",
        detail: { provider: "ollama", base_url: "http://localhost:11434", auth_scheme: "none", last4: null },
      },
      nameOf,
    ),
    "Connected the Ollama server http://localhost:11434 (authentication: none).",
  );
  assert.equal(summarizeAuditEvent({ action: "provider.deleted", detail: { provider: "ollama" } }, nameOf), "Disconnected the Ollama server.");
  assert.equal(
    summarizeAuditEvent(
      { action: "settings.updated", detail: { model: null, max_model_requests: 12, monthly_cost_cap_usd: 50 } },
      nameOf,
    ),
    "Settings: model default, max model requests per run 12, monthly cap $50.00.",
  );
  assert.equal(
    summarizeAuditEvent({ action: "organization.created", detail: { name: "Acme" } }, nameOf),
    'Created the organisation "Acme".',
  );
  assert.equal(summarizeAuditEvent({ action: "run.purged", detail: { count: 3 } }, nameOf), 'run.purged {"count":3}');
});

test("money and months", () => {
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatMonth("2026-10-01"), "October 2026");
  assert.equal(formatMonth("2026-01-01"), "January 2026", "UTC, not the local zone");
  assert.equal(capShare(25, 100), "25% of the cap");
  assert.equal(capShare(5, null), null);
  assert.equal(capShare(1, 0), "over the cap");
});

test("OpenRouter: the auth URL carries the S256 challenge and the state; results are fixed codes", () => {
  const url = new URL(openRouterAuthUrl("https://app.example.test", "CHALLENGE", "STATE"));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.equal(url.searchParams.get("callback_url"), "https://app.example.test/api/admin/providers/openrouter/callback");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.deepEqual(openRouterResultMessage("connected"), { ok: true, message: OPENROUTER_RESULTS.connected });
  assert.equal(openRouterResultMessage("denied")?.ok, false);
  assert.equal(openRouterResultMessage("<script>"), null, "anything else in the URL prints nothing");
  assert.equal(openRouterResultMessage("toString"), null);
});

test("the OAuth origin is the host the browser used, not Next.js's normalised one", () => {
  // Seen under `next dev --hostname 127.0.0.1`: nextUrl said localhost, cookies live on 127.0.0.1.
  const nextUrl = new URL("http://localhost:3020/api/admin/providers/openrouter/start");
  assert.equal(requestOrigin(new Headers({ host: "127.0.0.1:3020" }), nextUrl), "http://127.0.0.1:3020");
  assert.equal(
    requestOrigin(new Headers({ host: "internal", "x-forwarded-host": "app.example.test", "x-forwarded-proto": "https" }), nextUrl),
    "https://app.example.test",
  );
  assert.equal(requestOrigin(new Headers({ host: "evil.test/path?x" }), nextUrl), "http://localhost:3020");
  assert.equal(requestOrigin(new Headers(), nextUrl), "http://localhost:3020");
});
