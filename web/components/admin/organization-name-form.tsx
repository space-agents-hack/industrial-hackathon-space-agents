"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { looksLikeTeamId } from "@/lib/admin";
import { sendJson } from "@/lib/send-json";

// The organisation's name, which every submission its runs write carries as `team_id` (#35). Said
// next to the field, because a rename that looks cosmetic changes what the platform scores.
export function OrganizationNameForm({ org, name }: { org: string; name: string }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const trimmed = value.trim();

  async function save() {
    setSaving(true);
    setMessage(null);
    const result = await sendJson("/api/admin/organizations", "PATCH", { org, name: trimmed });
    setSaving(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setMessage({ ok: true, text: "Renamed. Runs from now on write this name as team_id." });
    router.refresh();
  }

  return (
    <form
      className="grid max-w-2xl gap-2 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr_auto] sm:items-center">
        <Label htmlFor="organization-name">Organisation name</Label>
        <Input
          id="organization-name"
          value={value}
          maxLength={200}
          onChange={(event) => {
            setValue(event.target.value);
            setMessage(null);
          }}
        />
        <Button type="submit" size="sm" disabled={saving || trimmed === "" || trimmed === name}>
          {saving ? "Saving…" : "Rename"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Every submission a run writes uses this name as <code>team_id</code>. For the hackathon it must be the
        team&apos;s platform id, such as <code>team-09</code>. A run that already finished keeps the name it wrote.
      </p>
      {!looksLikeTeamId(trimmed) && trimmed !== "" ? (
        <p className="text-xs text-attention">This does not look like a platform team id (team-07).</p>
      ) : null}
      {message ? (
        <p role="status" className={`text-sm ${message.ok ? "text-muted-foreground" : "text-danger"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
