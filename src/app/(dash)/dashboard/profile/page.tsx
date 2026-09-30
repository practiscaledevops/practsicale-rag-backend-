"use client";

// Your profile — every signed-in member can see their own account and change
// their own password. Not a governed nav item (no permission gate): it is
// reached from the profile card / More menu and is always available to the
// person who is signed in. Changing the password updates only the caller's own
// Supabase auth user (supabaseBrowser().auth.updateUser); a member can never
// change anyone else's password here.

import * as React from "react";
import { KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { supabaseBrowser } from "@/lib/supabase-server";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/permissions";

export default function ProfilePage() {
  const [email, setEmail] = React.useState<string>("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: "success" | "danger"; text: string } | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabaseBrowser().auth.getUser();
      if (alive) setEmail(data.user?.email ?? "");
    })();
    return () => {
      alive = false;
    };
  }, []);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSave = next.length >= MIN_PASSWORD_LENGTH && next === confirm && !saving;

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      const { error } = await supabaseBrowser().auth.updateUser({ password: next });
      if (error) throw new Error(error.message);
      setNext("");
      setConfirm("");
      setNotice({ tone: "success", text: "Password changed. Use it next time you sign in." });
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof Error ? err.message : "Could not change the password." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6 sm:py-6">
      <PageHeader title="Your profile" description="Your account and sign-in details." />

      <div className="space-y-4">
        <SectionCard icon={UserRound} title="Account">
          <dl className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <dt className="text-[13px] text-muted-foreground">Email</dt>
            <dd className="text-[13px] font-medium text-foreground">{email || "…"}</dd>
          </dl>
        </SectionCard>

        <SectionCard icon={KeyRound} title="Change password" description={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          <form className="space-y-4" onSubmit={changePassword}>
            {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

            <Field label="New password" error={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters` : undefined}>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>

            <Field label="Confirm new password" error={mismatch ? "The passwords don't match" : undefined}>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={!canSave} loading={saving}>
                {saving ? "Saving…" : "Change password"}
              </Button>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck size={13} aria-hidden />
                Only changes your own login.
              </span>
            </div>
          </form>
        </SectionCard>
      </div>
    </div>
  );
}
