// Axsys Time Off — manager-only account administration
// Actions: create | reset_password | set_active | reject_signup
// The caller must be signed in as an active manager. Uses the service role
// (server side only) to manage logins in Supabase Auth.

import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MIN_PASSWORD = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Who is calling?
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  const { data: me } = await admin.from("profiles").select("role, active").eq("id", user.id).single();
  if (!me || me.role !== "manager" || !me.active) return json({ error: "Managers only" }, 403);

  const body = await req.json().catch(() => ({}));

  try {
    switch (body.action) {
      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const first_name = String(body.first_name ?? "").trim();
        const last_name = String(body.last_name ?? "").trim();
        const full_name = `${first_name} ${last_name}`.trim();
        const password = String(body.password ?? "");
        if (!email.includes("@") || !first_name || !last_name) return json({ error: "First name, last name and a valid email are required" }, 400);
        if (password.length < MIN_PASSWORD) return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);

        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { first_name, last_name, full_name },
          app_metadata: { created_by_manager: true },
        });
        if (error) return json({ error: /database error/i.test(error.message) ? "That email can't be used — accounts must use the company email domain." : error.message }, 400);

        const { error: pErr } = await admin.from("profiles").update({
          full_name, first_name, last_name, approved: true,
          role: body.role === "manager" ? "manager" : "employee",
          annual_allowance: Number(body.annual_allowance ?? 10),
        }).eq("id", data.user.id);
        if (pErr) return json({ error: pErr.message }, 400);
        await audit(user.id, data.user.id, "CREATE_USER", { email, full_name, role: body.role });
        return json({ id: data.user.id });
      }

      case "reset_password": {
        const password = String(body.password ?? "");
        if (password.length < MIN_PASSWORD) return json({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);
        const { error } = await admin.auth.admin.updateUserById(body.user_id, { password });
        if (error) return json({ error: error.message }, 400);
        await audit(user.id, body.user_id, "RESET_PASSWORD", null);
        return json({ ok: true });
      }

      case "set_active": {
        const active = Boolean(body.active);
        if (body.user_id === user.id && !active) return json({ error: "You can't deactivate your own account" }, 400);
        const { error: pErr } = await admin.from("profiles").update({ active }).eq("id", body.user_id);
        if (pErr) return json({ error: pErr.message }, 400);
        // Blocks sign-in for deactivated staff (records are kept for reporting)
        const { error } = await admin.auth.admin.updateUserById(body.user_id, { ban_duration: active ? "none" : "876000h" });
        if (error) return json({ error: error.message }, 400);
        await audit(user.id, body.user_id, active ? "REACTIVATE_USER" : "DEACTIVATE_USER", null);
        return json({ ok: true });
      }

      case "reject_signup": {
        // Removes an account that signed itself up and hasn't been approved.
        const { data: p } = await admin.from("profiles").select("approved, email").eq("id", body.user_id).single();
        if (!p) return json({ error: "Account not found" }, 404);
        if (p.approved) return json({ error: "Only accounts waiting for approval can be rejected. Deactivate approved accounts instead." }, 400);
        const { error } = await admin.auth.admin.deleteUser(body.user_id);
        if (error) return json({ error: error.message }, 400);
        await audit(user.id, body.user_id, "REJECT_SIGNUP", { email: p.email });
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function audit(actorId: string, recordId: string, action: string, data: unknown) {
  const { data: p } = await admin.from("profiles").select("full_name").eq("id", actorId).single();
  await admin.from("audit_log").insert({
    table_name: "auth.users", record_id: recordId, action, actor_id: actorId,
    actor_name: p?.full_name ?? "Manager", new_data: data,
  });
}
