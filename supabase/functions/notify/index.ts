// Axsys Time Off — email notifications
// Called by the database (pg_net) whenever a request is submitted, modified,
// cancelled, approved or denied. Sends real email through Resend and records
// every attempt in public.email_log.
//
// Secrets (supabase secrets set ...):
//   NOTIFY_SECRET   shared secret, must match private.settings 'notify_secret'
//   RESEND_API_KEY  API key from resend.com
//   EMAIL_FROM      e.g.  Axsys Time Off <timeoff@axsysinc.com>   (verified domain)
//   MANAGER_EMAIL   e.g.  ryant@axsysinc.com   (comma-separate for several)
//   PORTAL_URL      e.g.  https://timeoff.axsysinc.com
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, fallback = "") => Deno.env.get(k) ?? fallback;

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

type Event = "request_submitted" | "request_modified" | "request_cancelled" | "request_reviewed";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const fmtDate = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });

function dateRange(r: { start_date: string; end_date: string; start_half: boolean; end_half: boolean }) {
  if (r.start_date === r.end_date) {
    return fmtDate(r.start_date) + (r.start_half || r.end_half ? " (half day)" : "");
  }
  return `${fmtDate(r.start_date)}${r.start_half ? " (half)" : ""} – ${fmtDate(r.end_date)}${r.end_half ? " (half)" : ""}`;
}

const plural = (n: number) => `${n} day${Number(n) === 1 ? "" : "s"}`;

function layout(title: string, intro: string, rows: [string, string][], button?: { href: string; label: string }) {
  const rowHtml = rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;color:#5b6b82;width:150px;vertical-align:top">${esc(k)}</td>
      <td style="padding:8px 0;color:#0f1f3d;font-weight:600">${v}</td></tr>`).join("");
  const btn = button
    ? `<p style="margin:28px 0 8px"><a href="${esc(button.href)}" style="background:#1d5fbf;color:#fff;text-decoration:none;
        padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#0b2447;padding:20px 28px">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:2px">AXSYS</span>
      <span style="color:#9fc3f5;font-size:13px;margin-left:8px">Dental Solutions · Time Off</span>
    </td></tr>
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f1f3d">${esc(title)}</h1>
      <p style="margin:0 0 18px;color:#334155;line-height:1.5">${intro}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;font-size:14px">${rowHtml}</table>
      ${btn}
    </td></tr>
    <tr><td style="padding:16px 28px;background:#f8fafc;color:#94a3b8;font-size:12px">
      Axsys Dental Solutions · 29627 West Tech Drive, Wixom, MI 48393 · This is an automated message.
    </td></tr>
  </table></td></tr></table></body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string, replyTo?: string) {
  const payload: Record<string, unknown> = { from: env("EMAIL_FROM"), to, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: body.id as string };
    lastErr = `${res.status}: ${body.message ?? JSON.stringify(body)}`;
    if (res.status !== 429 && res.status < 500) break; // don't retry bad requests
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return { ok: false, error: lastErr };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env("NOTIFY_SECRET") || req.headers.get("x-notify-secret") !== env("NOTIFY_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { event, time_off_id, previous, profile_id } = (await req.json()) as {
    event: Event | "user_signed_up"; time_off_id: string; previous?: Record<string, unknown>; profile_id?: string;
  };
  const portalBase = env("PORTAL_URL").replace(/\/$/, "");
  const managerList = env("MANAGER_EMAIL").split(",").map((s) => s.trim()).filter(Boolean);

  // Someone created their own account and is waiting for approval
  if (event === "user_signed_up") {
    const { data: p } = await supabase.from("profiles").select("full_name, email, approved, created_at").eq("id", profile_id).single();
    if (!p || p.approved || !managerList.length) return new Response("Nothing to send", { status: 200 });
    const subject = `New account waiting for approval: ${p.full_name}`;
    const html = layout("New employee account", `<b>${esc(p.full_name)}</b> created an account in the Time Off app. Approve it and set their yearly days so they can start requesting time off.`,
      [["Name", esc(p.full_name)], ["Email", esc(p.email)]], { href: `${portalBase}/#/employees`, label: "Review in Manager Portal" });
    const result = await sendEmail(managerList, subject, html, p.email);
    await supabase.from("email_log").insert(managerList.map((recipient) => ({
      event, time_off_id: null, recipient, subject, status: result.ok ? "sent" : "failed",
      provider_id: result.ok ? result.id : null, error: result.ok ? null : result.error,
    })));
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 502, headers: { "Content-Type": "application/json" } });
  }

  const { data: r, error } = await supabase
    .from("time_off")
    .select(`*, employee:profiles!time_off_employee_id_fkey(full_name,email),
             reviewer:profiles!time_off_reviewed_by_fkey(full_name),
             type:absence_types(label)`)
    .eq("id", time_off_id)
    .single();
  if (error || !r) return new Response(`Not found: ${error?.message}`, { status: 404 });

  const portal = env("PORTAL_URL").replace(/\/$/, "");
  const reviewLink = { href: `${portal}/#/requests?id=${r.id}`, label: "Review in Manager Portal" };
  const managers = env("MANAGER_EMAIL").split(",").map((s) => s.trim()).filter(Boolean);
  const name = r.employee?.full_name ?? "An employee";
  const typeLabel = r.type?.label ?? r.absence_type;
  const details: [string, string][] = [
    ["Employee", esc(name)],
    ["Absence type", esc(typeLabel)],
    ["Dates", esc(dateRange(r))],
    ["Workdays", esc(plural(r.days))],
    ["Notes", r.notes ? esc(r.notes).replace(/\n/g, "<br>") : "<span style='color:#94a3b8'>None</span>"],
  ];

  let to: string[] = [];
  let subject = "";
  let html = "";
  let replyTo: string | undefined;

  switch (event) {
    case "request_submitted":
      to = managers; replyTo = r.employee?.email;
      subject = `Time-off request: ${name} — ${dateRange(r)} (${plural(r.days)})`;
      html = layout("New time-off request", `<b>${esc(name)}</b> submitted a request that needs your approval.`,
        details, reviewLink);
      break;

    case "request_modified": {
      to = managers; replyTo = r.employee?.email;
      subject = `Updated request: ${name} — ${dateRange(r)}`;
      const prev = previous as { start_date: string; end_date: string; days: number } | undefined;
      const rows: [string, string][] = prev
        ? [...details, ["Previously", esc(`${dateRange({ ...prev, start_half: false, end_half: false })} (${plural(prev.days)})`)]]
        : details;
      html = layout("Time-off request changed", `<b>${esc(name)}</b> changed a pending request.`, rows, reviewLink);
      break;
    }

    case "request_cancelled":
      to = managers;
      subject = `Request cancelled: ${name} — ${dateRange(r)}`;
      html = layout("Time-off request cancelled", `<b>${esc(name)}</b> cancelled a pending request. No action is needed.`,
        details, { href: `${portal}/#/dashboard`, label: "Open Manager Portal" });
      break;

    case "request_reviewed": {
      if (!r.employee?.email) break;
      to = [r.employee.email];
      const approved = r.status === "approved";
      subject = `Your time off was ${approved ? "approved" : "denied"} — ${dateRange(r)}`;
      const rows: [string, string][] = [
        ...details.slice(1),
        ["Decision", `<span style="color:${approved ? "#15803d" : "#b91c1c"}">${approved ? "Approved" : "Denied"}</span>`],
        ["Reviewed by", esc(r.reviewer?.full_name ?? "Manager")],
      ];
      if (r.review_note) rows.push(["Manager note", esc(r.review_note)]);
      html = layout(approved ? "Time off approved" : "Time off denied",
        `Hi ${esc(name.split(" ")[0])}, your request has been <b>${approved ? "approved" : "denied"}</b>.`, rows);
      break;
    }
    default:
      return new Response("Unknown event", { status: 400 });
  }

  if (!to.length) return new Response("No recipients", { status: 200 });

  const result = await sendEmail(to, subject, html, replyTo);
  await supabase.from("email_log").insert(to.map((recipient) => ({
    event, time_off_id, recipient, subject,
    status: result.ok ? "sent" : "failed",
    provider_id: result.ok ? result.id : null,
    error: result.ok ? null : result.error,
  })));

  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
});
