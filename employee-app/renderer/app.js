/* Axsys Time Off — employee app page logic.
 * The database enforces every rule (employees only see and change their own
 * pending requests); this page is just the friendly front end.
 */
"use strict";

const cfg = window.AXSYS_CONFIG || {};
// Named "shell" because Electron already defines a global called "desktop" (from preload.js).
const shell = window.desktop || { notify() {}, setBadge() {}, version: async () => "dev", onUpdateReady() {}, installUpdate() {} };
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "axsys-timeoff-auth" },
});

const S = { me: null, types: [], entries: [], summary: null, notifs: [], tab: "upcoming", channel: null, year: new Date().getFullYear() };

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return toISO(d); };
const isWeekday = (s) => { const g = parse(s).getDay(); return g !== 0 && g !== 6; };
const fmtShort = (s) => parse(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtDate = (s) => parse(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtTime = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDays = (n) => `${Number(n)} day${Number(n) === 1 ? "" : "s"}`;
const typeOf = (code) => S.types.find((t) => t.code === code) ?? { code, label: code, color: "#64748b" };

function rangeLabel(e) {
  if (e.start_date === e.end_date) return fmtShort(e.start_date) + (e.start_half || e.end_half ? " · half day" : "");
  return `${fmtShort(e.start_date)}${e.start_half ? " (½)" : ""} – ${fmtDate(e.end_date)}${e.end_half ? " (½)" : ""}`;
}

// Mirrors public.business_days() in the database
function businessDays(start, end, sh = false, eh = false) {
  if (!start || !end || end < start) return 0;
  if (start === end) return isWeekday(start) ? (sh || eh ? 0.5 : 1) : 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (isWeekday(d)) n++;
  if (sh && isWeekday(start)) n -= 0.5;
  if (eh && isWeekday(end)) n -= 0.5;
  return Math.max(0, n);
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6500 : 3500);
}

function openModal({ title, body, footer }) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div>
    <div class="modal-b">${body}</div><div class="modal-f">${footer}</div></div>`;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  $(".x", ov).onclick = close;
  $("#modal-root").append(ov);
  $("input, select, textarea", ov)?.focus();
  return { el: ov, close };
}

/* ---------- auth ---------- */
async function init() {
  $("#version").textContent = `v${await shell.version()}`;
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.body.innerHTML = `<div style="padding:40px"><h2>Setup needed</h2><p>This build is missing its server settings (renderer/config.js). Contact your administrator.</p></div>`;
    return;
  }
  $("#login-form").addEventListener("submit", onLogin);
  $("#signup-form").addEventListener("submit", onSignup);
  $("#show-signup").onclick = () => showLogin("", "signup");
  $("#show-login").onclick = () => showLogin("", "login");
  $("#pending-check").onclick = async () => { await enter(); if (!$("#pending-view").hidden) toast("Still waiting for approval."); };
  $("#pending-signout").onclick = () => sb.auth.signOut();
  $("#new-request").onclick = () => openRequestForm(null);
  $("#bell").onclick = openDrawer;
  $("#drawer-close").onclick = () => ($("#drawer").hidden = true);
  $("#user-btn").onclick = (e) => { e.stopPropagation(); $("#user-menu").hidden = !$("#user-menu").hidden; };
  document.addEventListener("click", () => ($("#user-menu").hidden = true));
  $("#menu-signout").onclick = () => sb.auth.signOut();
  $("#menu-account").onclick = accountDialog;
  $$("#tabs button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderList(); }));
  shell.onUpdateReady(() => ($("#update-banner").hidden = false));
  $("#install-update").onclick = () => shell.installUpdate();

  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") showLogin(); });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(); else showLogin();

  // Refresh after the PC wakes up / reconnects
  window.addEventListener("online", () => S.me && refresh());
  setInterval(() => S.me && refresh(), 10 * 60 * 1000);
}

function showLogin(msg, mode = "login") {
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  if (S.pendingChannel) { sb.removeChannel(S.pendingChannel); S.pendingChannel = null; }
  S.me = null;
  $("#app-view").hidden = true;
  $("#pending-view").hidden = true;
  $("#drawer").hidden = true;
  $("#login-view").hidden = false;
  $("#login-form").hidden = mode !== "login";
  $("#signup-form").hidden = mode !== "signup";
  const err = $(mode === "login" ? "#login-error" : "#signup-error");
  err.hidden = !msg;
  err.textContent = msg || "";
  ($(mode === "login" ? "#login-form" : "#signup-form").querySelector("input"))?.focus();
  shell.setBadge(0);
}

const ALLOWED_DOMAIN = "axsysinc.com";

async function onSignup(e) {
  e.preventDefault();
  const f = e.target;
  const err = $("#signup-error");
  const say = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  const first = f.first_name.value.trim(), last = f.last_name.value.trim();
  const email = f.email.value.trim().toLowerCase();
  if (!first || !last) return say("Please enter your first and last name.");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return say("Please enter a valid email address.");
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) return say(`Please use your @${ALLOWED_DOMAIN} work email.`);
  if (f.password.value.length < 10) return say("Your password needs at least 10 characters.");
  if (f.password.value !== f.password2.value) return say("The passwords don't match.");

  const btn = $("button[type=submit]", f);
  btn.disabled = true; btn.textContent = "Creating account…";
  const { data, error } = await sb.auth.signUp({
    email, password: f.password.value,
    options: { data: { first_name: first, last_name: last } },
  });
  btn.disabled = false; btn.textContent = "Create account";
  if (error) {
    if (/already registered|already exists/i.test(error.message)) return say("An account with this email already exists. Sign in instead.");
    if (/database error|only @/i.test(error.message)) return say(`Please use your @${ALLOWED_DOMAIN} work email.`);
    if (/password/i.test(error.message)) return say(error.message);
    return say(`Couldn't create the account: ${error.message}`);
  }
  f.reset();
  if (!data.session) {
    // Email confirmation is switched on in Supabase — tell them to check email
    showLogin("", "login");
    toast("Account created. Check your email to confirm it, then sign in.");
    return;
  }
  await enter();
}

async function onLogin(e) {
  e.preventDefault();
  const f = e.target;
  const btn = $("button[type=submit]", f);
  btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) {
    const msg = /banned/i.test(error.message) ? "This account has been deactivated. Contact your manager."
      : error.message === "Invalid login credentials" ? "Incorrect email or password." : error.message;
    return showLogin(msg);
  }
  f.password.value = "";
  await enter();
}

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin();
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !me) return showLogin("Your account isn't set up yet. Contact your manager.");
  if (!me.active) { await sb.auth.signOut(); return showLogin("This account has been deactivated."); }
  if (!me.approved) return showPending(me);
  if (S.pendingChannel) { sb.removeChannel(S.pendingChannel); S.pendingChannel = null; }
  $("#pending-view").hidden = true;
  S.me = me;
  $("#user-name").textContent = me.full_name;
  $("#avatar").textContent = me.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  await refresh();
  subscribe();
}

function showPending(me) {
  $("#login-view").hidden = true;
  $("#app-view").hidden = true;
  $("#pending-view").hidden = false;
  $("#pending-title").textContent = `Thanks, ${me.first_name || me.full_name.split(" ")[0]}!`;
  // Switch to the app as soon as a manager approves the account
  if (!S.pendingChannel) {
    S.pendingChannel = sb.channel(`approval-${me.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${me.id}` }, (p) => {
        if (p.new.approved) { shell.notify("You're approved!", "Your Axsys Time Off account is ready to use."); enter(); }
      })
      .subscribe();
  }
}

/* ---------- data ---------- */
async function refresh() {
  const [t, e, s, n] = await Promise.all([
    sb.from("absence_types").select("*").order("sort_order"),
    sb.from("time_off").select("*").eq("employee_id", S.me.id).order("start_date", { ascending: false }),
    sb.rpc("year_summary", { p_year: S.year }),
    sb.from("notifications").select("*").eq("user_id", S.me.id).order("created_at", { ascending: false }).limit(40),
  ]);
  const err = t.error || e.error || s.error || n.error;
  if (err) {
    if (/JWT|session/i.test(err.message)) return sb.auth.signOut();
    toast(`Couldn't refresh: ${err.message}`, "error");
  }
  S.types = t.data ?? S.types;
  S.entries = e.data ?? S.entries;
  S.summary = (s.data ?? []).find((r) => r.employee_id === S.me.id) ?? S.summary;
  S.notifs = n.data ?? S.notifs;
  render();
}

let refreshTimer;
function subscribe() {
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = sb.channel(`me-${S.me.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "time_off", filter: `employee_id=eq.${S.me.id}` }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${S.me.id}` }, (p) => {
      shell.notify(p.new.title, p.new.body);
      toast(p.new.body);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    })
    .subscribe((status) => $(".live")?.classList.toggle("off", status !== "SUBSCRIBED"));
}

/* ---------- render ---------- */
function render() {
  const s = S.summary || { annual_allowance: S.me.annual_allowance, allowance_used: 0, remaining: S.me.annual_allowance, total_days: 0, pto_days: 0, sick_days: 0, personal_days: 0, other_days: 0, pending_days: 0 };
  const allowance = Number(s.annual_allowance), used = Number(s.allowance_used), remaining = Number(s.remaining);
  $("#hero-label").textContent = `Time-off allowance remaining · ${S.year}`;
  $("#remaining").textContent = remaining;
  $("#of-allowance").textContent = `of ${allowance} days`;
  const meter = $(".meter");
  meter.classList.toggle("over", remaining < 0);
  $("#meter-fill").style.width = `${allowance ? Math.min(100, (used / allowance) * 100) : 0}%`;
  $("#hero-sub").innerHTML = `${used} used${Number(s.pending_days) ? ` · <b>${Number(s.pending_days)}</b> pending approval` : ""}
    <div class="muted small">Vacation/PTO and personal days count toward your allowance. Weekends are never counted.</div>`;
  $("#year-label").textContent = `in ${S.year}`;
  $("#t-total").textContent = Number(s.total_days);
  $("#t-pto").textContent = Number(s.pto_days);
  $("#t-sick").textContent = Number(s.sick_days);
  $("#t-other").textContent = Number(s.personal_days) + Number(s.other_days);
  $("#t-pending").textContent = Number(s.pending_days);

  const unread = S.notifs.filter((n) => !n.read_at).length;
  $("#bell-count").hidden = !unread;
  $("#bell-count").textContent = unread;
  shell.setBadge(unread);
  renderList();
  if (!$("#drawer").hidden) renderDrawer();
}

function renderList() {
  const today = todayISO();
  let rows = S.entries;
  if (S.tab === "upcoming") rows = rows.filter((e) => e.end_date >= today && e.status !== "cancelled").sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (S.tab === "past") rows = rows.filter((e) => e.end_date < today);
  $("#list").innerHTML = rows.map((e) => {
    const t = typeOf(e.absence_type);
    const status = e.status[0].toUpperCase() + e.status.slice(1);
    return `<div class="item ${e.status}">
      <span class="stripe" style="background:${esc(t.color)}"></span>
      <div>
        <div class="t">${esc(rangeLabel(e))}</div>
        <div class="m"><span>${esc(t.label)}</span><b>${fmtDays(e.days)}</b><span class="badge ${e.status}">${status}</span>
          ${e.source === "manager" ? `<span class="muted small">Recorded by your manager</span>` : ""}</div>
        ${e.notes ? `<div class="n small">“${esc(e.notes)}”</div>` : ""}
        ${e.review_note ? `<div class="n small"><b>Manager:</b> ${esc(e.review_note)}</div>` : ""}
      </div>
      <div class="r">${e.status === "pending" ? `<button class="btn small" data-edit="${e.id}">Edit</button><button class="btn small danger" data-cancel="${e.id}">Cancel</button>` : ""}</div>
    </div>`;
  }).join("") || `<div class="empty">${S.tab === "upcoming" ? "No upcoming time off. Click “Request time off” to plan some!" : "Nothing here yet."}</div>`;

  $$("[data-edit]").forEach((b) => (b.onclick = () => openRequestForm(S.entries.find((e) => e.id === b.dataset.edit))));
  $$("[data-cancel]").forEach((b) => (b.onclick = () => cancelRequest(S.entries.find((e) => e.id === b.dataset.cancel))));
}

/* ---------- request form ---------- */
function openRequestForm(entry) {
  const isNew = !entry;
  const requestable = S.types.filter((t) => t.employee_requestable);
  const nextWorkday = (() => { let d = addDays(todayISO(), 1); while (!isWeekday(d)) d = addDays(d, 1); return d; })();
  const e = entry ?? { absence_type: requestable[0]?.code, start_date: nextWorkday, end_date: nextWorkday, start_half: false, end_half: false, notes: "" };

  const { el, close } = openModal({
    title: isNew ? "Request time off" : "Edit request",
    body: `<form id="req-form" class="form-grid">
        <label class="full">Type<select name="absence_type">${requestable.map((t) => `<option value="${t.code}" ${t.code === e.absence_type ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
        <label>First day off<input type="date" name="start_date" value="${esc(e.start_date)}" required></label>
        <label>Last day off<input type="date" name="end_date" value="${esc(e.end_date)}" required></label>
        <div class="full" id="half-single"><label class="check"><input type="checkbox" name="half_single" ${e.start_half || e.end_half ? "checked" : ""}> Half day only</label></div>
        <div class="full" id="half-range" style="display:flex;gap:22px">
          <label class="check"><input type="checkbox" name="start_half" ${e.start_half ? "checked" : ""}> First day is a half day</label>
          <label class="check"><input type="checkbox" name="end_half" ${e.end_half ? "checked" : ""}> Last day is a half day</label>
        </div>
        <div class="full calc" id="calc"></div>
        <label class="full">Note for your manager (optional)<textarea name="notes" maxlength="2000" placeholder="e.g. Family vacation — coverage arranged with Sam">${esc(e.notes || "")}</textarea></label>
        <p class="form-error full" id="req-error" hidden></p>
      </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-submit>${isNew ? "Submit request" : "Save changes"}</button>`,
  });

  const f = $("#req-form", el);
  const sync = () => {
    if (f.start_date.value && f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value;
    const single = f.start_date.value === f.end_date.value;
    $("#half-single", el).hidden = !single;
    $("#half-range", el).style.display = single ? "none" : "flex";
    const [sh, eh] = single ? [f.half_single.checked, false] : [f.start_half.checked, f.end_half.checked];
    const n = businessDays(f.start_date.value, f.end_date.value, sh, eh);
    const counts = typeOf(f.absence_type.value).counts_toward_allowance;
    const remaining = Number(S.summary?.remaining ?? S.me.annual_allowance);
    const calc = $("#calc", el);
    if (!n) { calc.className = "full calc warn"; calc.innerHTML = "These dates are on a weekend — pick at least one workday."; }
    else {
      const after = remaining - n;
      calc.className = `full calc ${counts && after < 0 ? "warn" : ""}`;
      calc.innerHTML = `This request: <b>${fmtDays(n)}</b> (weekends not counted)` +
        (counts ? `<br>If approved you'll have <b>${after}</b> allowance day${after === 1 ? "" : "s"} left${after < 0 ? " — this is more than you have available; your manager will decide." : "."}` : "");
    }
    return { sh, eh, n };
  };
  f.addEventListener("input", sync);
  f.addEventListener("change", sync);
  sync();

  $("[data-close]", el).onclick = close;
  $("[data-submit]", el).onclick = async (ev) => {
    const btn = ev.currentTarget;
    const err = $("#req-error", el);
    err.hidden = true;
    if (!f.reportValidity()) return;
    const { sh, eh, n } = sync();
    if (!n) { err.textContent = "Please choose dates that include at least one workday."; err.hidden = false; return; }
    if (isNew && f.start_date.value < todayISO()) {
      if (!confirm("These dates are in the past. Submit anyway?")) return;
    }
    btn.disabled = true; btn.textContent = "Sending…";
    const payload = {
      absence_type: f.absence_type.value, start_date: f.start_date.value, end_date: f.end_date.value,
      start_half: sh, end_half: eh, notes: f.notes.value.trim() || null,
    };
    const { error } = isNew
      ? await sb.from("time_off").insert({ ...payload, employee_id: S.me.id })
      : await sb.from("time_off").update(payload).eq("id", entry.id);
    btn.disabled = false; btn.textContent = isNew ? "Submit request" : "Save changes";
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    close();
    toast(isNew ? "Request sent to your manager for approval." : "Request updated — your manager has been notified.");
    refresh();
  };
}

function cancelRequest(e) {
  if (!e) return;
  const { el, close } = openModal({
    title: "Cancel this request?",
    body: `<p style="margin:0">${esc(typeOf(e.absence_type).label)} · ${esc(rangeLabel(e))} (${fmtDays(e.days)}). Your manager will be notified.</p>`,
    footer: `<button class="btn" data-no>Keep it</button><button class="btn danger" data-yes>Cancel request</button>`,
  });
  $("[data-no]", el).onclick = close;
  $("[data-yes]", el).onclick = async () => {
    const { error } = await sb.from("time_off").update({ status: "cancelled" }).eq("id", e.id);
    close();
    if (error) return toast(error.message, "error");
    toast("Request cancelled.");
    refresh();
  };
}

/* ---------- notifications ---------- */
function openDrawer() {
  $("#drawer").hidden = false;
  renderDrawer();
  const unread = S.notifs.filter((n) => !n.read_at).map((n) => n.id);
  if (unread.length) {
    sb.from("notifications").update({ read_at: new Date().toISOString() }).in("id", unread).then(() => {
      S.notifs.forEach((n) => { if (unread.includes(n.id)) n.read_at = n.read_at || "now"; });
      $("#bell-count").hidden = true;
      shell.setBadge(0);
    });
  }
}
function renderDrawer() {
  $("#drawer-list").innerHTML = S.notifs.map((n) => `<div class="notif ${n.read_at ? "" : "unread"}">
      <div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div><div class="muted small">${esc(fmtTime(n.created_at))}</div></div>`).join("")
    || `<div class="empty">No notifications yet.</div>`;
}

/* ---------- account ---------- */
function accountDialog() {
  const { el, close } = openModal({
    title: "Account & password",
    body: `<div><b>${esc(S.me.full_name)}</b><div class="muted">${esc(S.me.email)}</div></div>
      <form id="pw-form" class="form-grid">
        <label class="full">New password<input type="password" name="pw1" minlength="10" required autocomplete="new-password"></label>
        <label class="full">Confirm new password<input type="password" name="pw2" minlength="10" required autocomplete="new-password"></label>
        <p class="muted small full" style="margin:0">At least 10 characters.</p>
        <p class="form-error full" id="pw-error" hidden></p>
      </form>`,
    footer: `<button class="btn" data-close>Close</button><button class="btn primary" data-save>Change password</button>`,
  });
  const f = $("#pw-form", el);
  $("[data-close]", el).onclick = close;
  $("[data-save]", el).onclick = async () => {
    const err = $("#pw-error", el);
    err.hidden = true;
    if (!f.reportValidity()) return;
    if (f.pw1.value !== f.pw2.value) { err.textContent = "Passwords don't match."; err.hidden = false; return; }
    const { error } = await sb.auth.updateUser({ password: f.pw1.value });
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    close();
    toast("Password changed.");
  };
}

init();
