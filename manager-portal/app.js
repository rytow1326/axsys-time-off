/* Axsys Time Off — Manager Portal
 * Plain JavaScript, no build step. Talks directly to Supabase; every rule
 * (who may see/approve what) is enforced by the database itself.
 */
"use strict";

const cfg = window.AXSYS_CONFIG || {};
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const S = {
  me: null,
  profiles: [],
  types: [],
  entries: [],
  route: "dashboard",
  params: new URLSearchParams(),
  filters: { employee: "", type: "", status: "", from: "", to: "" },
  cal: { employee: "", type: "", pending: true, date: null },
  year: new Date().getFullYear(),
  activityTab: "audit",
  calendar: null,
  channel: null,
};

/* ================= Utilities ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return toISO(d); };
const isWeekday = (s) => { const g = parse(s).getDay(); return g !== 0 && g !== 6; };
const fmtDate = (s) => parse(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtShort = (s) => parse(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDays = (n) => `${Number(n)} day${Number(n) === 1 ? "" : "s"}`;

function rangeLabel(e) {
  if (e.start_date === e.end_date) return fmtShort(e.start_date) + (e.start_half || e.end_half ? " · ½ day" : "");
  const sameYear = e.start_date.slice(0, 4) === e.end_date.slice(0, 4);
  const a = sameYear ? fmtShort(e.start_date) : fmtDate(e.start_date);
  return `${a}${e.start_half ? " (½)" : ""} – ${fmtDate(e.end_date)}${e.end_half ? " (½)" : ""}`;
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
function daysInYear(e, year) {
  const s = e.start_date > `${year}-01-01` ? e.start_date : `${year}-01-01`;
  const t = e.end_date < `${year}-12-31` ? e.end_date : `${year}-12-31`;
  if (s > t) return 0;
  return businessDays(s, t, e.start_half && e.start_date >= `${year}-01-01`, e.end_half && e.end_date <= `${year}-12-31`);
}

const profile = (id) => S.profiles.find((p) => p.id === id);
const nameOf = (id) => profile(id)?.full_name ?? "Unknown";
const typeOf = (code) => S.types.find((t) => t.code === code) ?? { code, label: code, color: "#64748b" };
const typeChip = (code) => { const t = typeOf(code); return `<span class="badge"><span class="type-dot" style="background:${esc(t.color)}"></span>${esc(t.label)}</span>`; };
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6500 : 3500);
}

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const a = crypto.getRandomValues(new Uint32Array(14));
  return [...a].map((x) => chars[x % chars.length]).join("");
}

/* ================= Modal ================= */
function openModal({ title, body, footer = "", wide = false, onMount }) {
  const root = $("#modal-root");
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="width:min(720px,100%)"' : ""}>
      <div class="modal-h"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div>
      <div class="modal-b">${body}</div>
      ${footer ? `<div class="modal-f">${footer}</div>` : ""}
    </div>`;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  $(".x", ov).onclick = close;
  root.append(ov);
  const first = $("input, select, textarea", ov);
  if (first) first.focus();
  onMount?.(ov, close);
  return { el: ov, close };
}

function confirmDialog(title, message, okLabel = "Confirm", danger = false) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="margin:0">${message}</p>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn ${danger ? "danger solid" : "primary"}" data-yes>${esc(okLabel)}</button>`,
      onMount: (el, close) => {
        $("[data-no]", el).onclick = () => { close(); resolve(false); };
        $("[data-yes]", el).onclick = () => { close(); resolve(true); };
      },
    });
  });
}

async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Saving…";
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

/* ================= Auth ================= */
async function init() {
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>Setup needed</h2>
      <p>Edit <code>config.js</code> with your Supabase URL and anon key (see SETUP.md).</p></div>`;
    return;
  }
  $("#login-form").addEventListener("submit", onLogin);
  $("#sign-out").onclick = () => sb.auth.signOut();
  $("#add-absence-btn").onclick = () => openEntryEditor(null);
  window.addEventListener("hashchange", () => { parseRoute(); render(); });

  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") showLogin(); });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(); else showLogin();
}

function showLogin(msg) {
  S.channel && sb.removeChannel(S.channel);
  S.channel = null;
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  const err = $("#login-error");
  err.hidden = !msg;
  err.textContent = msg || "";
}

async function onLogin(e) {
  e.preventDefault();
  const f = e.target;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (error) return showLogin(error.message === "Invalid login credentials" ? "Incorrect email or password." : error.message);
  f.password.value = "";
  await enter();
}

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin();
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !me || me.role !== "manager" || !me.active) {
    await sb.auth.signOut();
    return showLogin("This portal is for managers. Employees should use the Axsys Time Off desktop app.");
  }
  S.me = me;
  $("#me-name").textContent = me.full_name;
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  await loadAll();
  subscribe();
  if (!location.hash) location.hash = "#/dashboard";
  parseRoute();
  render();
}

/* ================= Data ================= */
async function loadAll() {
  const [p, t, e] = await Promise.all([
    sb.from("profiles").select("*").order("full_name"),
    sb.from("absence_types").select("*").order("sort_order"),
    sb.from("time_off").select("*").order("start_date", { ascending: false }).range(0, 9999),
  ]);
  const err = p.error || t.error || e.error;
  if (err) toast(`Couldn't load data: ${err.message}`, "error");
  S.profiles = p.data ?? [];
  S.types = t.data ?? [];
  S.entries = e.data ?? [];
}

let refreshTimer;
function subscribe() {
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = sb.channel("portal-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "time_off" }, (payload) => {
      if (payload.eventType === "INSERT" && payload.new.status === "pending") {
        toast(`New request from ${nameOf(payload.new.employee_id)}`);
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => { await loadAll(); render(); }, 350);
    })
    .subscribe((status) => {
      $(".live")?.classList.toggle("off", status !== "SUBSCRIBED");
    });
}

async function invokeAdmin(body) {
  const { data, error } = await sb.functions.invoke("admin-users", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep message */ }
    throw new Error(msg);
  }
  return data;
}

/* ================= Router ================= */
const TITLES = { dashboard: "Dashboard", requests: "Requests & absences", calendar: "Calendar", employees: "Employees", activity: "Activity log" };
function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  S.route = TITLES[path] ? path : "dashboard";
  S.params = new URLSearchParams(query || "");
}

function render() {
  if (!S.me) return;
  $$(".sidebar nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === S.route));
  $("#page-title").textContent = TITLES[S.route];
  const pending = S.entries.filter((e) => e.status === "pending").length;
  const pill = $("#nav-pending");
  pill.hidden = !pending;
  pill.textContent = pending;
  document.title = `${pending ? `(${pending}) ` : ""}Axsys Time Off — Manager Portal`;
  if (S.calendar && S.route !== "calendar") { S.calendar.destroy(); S.calendar = null; }
  ({ dashboard: viewDashboard, requests: viewRequests, calendar: viewCalendar, employees: viewEmployees, activity: viewActivity })[S.route]();
}

/* ================= Dashboard ================= */
function viewDashboard() {
  const today = todayISO();
  const year = new Date().getFullYear();
  const pending = S.entries.filter((e) => e.status === "pending").sort((a, b) => a.start_date.localeCompare(b.start_date));
  const approved = S.entries.filter((e) => e.status === "approved");

  const monday = (() => { const d = parse(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toISO(d); })();
  const friday = addDays(monday, 4);
  const outToday = isWeekday(today) ? approved.filter((e) => e.start_date <= today && e.end_date >= today) : [];
  const outWeek = approved.filter((e) => e.start_date <= friday && e.end_date >= monday).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const in30 = addDays(today, 30);
  const upcoming = approved.filter((e) => e.start_date > friday && e.start_date <= in30).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const ytd = approved.reduce((n, e) => n + daysInYear(e, year), 0);

  const pendingHtml = pending.length
    ? pending.map((e) => `
      <div class="req">
        <div>
          <div class="who">${esc(nameOf(e.employee_id))}</div>
          <div class="meta">${typeChip(e.absence_type)}<span>${esc(rangeLabel(e))}</span><b class="num">${fmtDays(e.days)}</b>
            <span class="muted small">· requested ${esc(fmtTime(e.created_at))}</span></div>
        </div>
        <div class="actions">
          <button class="btn ok small" data-approve="${e.id}">Approve</button>
          <button class="btn danger small" data-deny="${e.id}">Deny</button>
        </div>
        ${e.notes ? `<div class="note">${esc(e.notes)}</div>` : ""}
      </div>`).join("")
    : `<div class="empty">✓ You're all caught up — no requests waiting.</div>`;

  const outRow = (e) => `<li><span><b>${esc(nameOf(e.employee_id))}</b><br><span class="muted small">${esc(typeOf(e.absence_type).label)}</span></span>
      <span class="small" style="text-align:right">${esc(rangeLabel(e))}<br><span class="muted">${fmtDays(e.days)}</span></span></li>`;

  $("#page").innerHTML = `
    <div class="stats">
      <div class="card stat accent"><div class="k">Pending requests</div><div class="v num">${pending.length}</div></div>
      <div class="card stat"><div class="k">Out today</div><div class="v num">${new Set(outToday.map((e) => e.employee_id)).size}</div></div>
      <div class="card stat"><div class="k">Out this week</div><div class="v num">${new Set(outWeek.map((e) => e.employee_id)).size}</div></div>
      <div class="card stat"><div class="k">Days taken in ${year}</div><div class="v num">${ytd}</div></div>
    </div>
    <div class="grid two">
      <section class="card">
        <div class="card-h"><h2>Waiting for your approval</h2><a href="#/requests?status=pending" class="small">View all</a></div>
        ${pendingHtml}
      </section>
      <div class="grid">
        <section class="card"><div class="card-h"><h2>Out today</h2><span class="muted small">${esc(fmtShort(today))}</span></div>
          ${outToday.length ? `<ul class="out-list">${outToday.map(outRow).join("")}</ul>` : `<div class="empty">Everyone's in.</div>`}</section>
        <section class="card"><div class="card-h"><h2>This week</h2></div>
          ${outWeek.length ? `<ul class="out-list">${outWeek.map(outRow).join("")}</ul>` : `<div class="empty">No approved time off this week.</div>`}</section>
        <section class="card"><div class="card-h"><h2>Coming up · next 30 days</h2></div>
          ${upcoming.length ? `<ul class="out-list">${upcoming.map(outRow).join("")}</ul>` : `<div class="empty">Nothing scheduled.</div>`}</section>
      </div>
    </div>`;

  $$("[data-approve]").forEach((b) => (b.onclick = () => reviewDialog(b.dataset.approve, "approved")));
  $$("[data-deny]").forEach((b) => (b.onclick = () => reviewDialog(b.dataset.deny, "denied")));
}

/* ================= Approve / deny ================= */
function reviewDialog(id, suggested) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return toast("That request no longer exists.", "error");
  if (e.status !== "pending") return toast(`This request is already ${e.status}.`);
  const p = profile(e.employee_id);
  const summary = S.entries
    .filter((x) => x.employee_id === e.employee_id && x.status === "approved")
    .reduce((acc, x) => { if (typeOf(x.absence_type).counts_toward_allowance) acc += daysInYear(x, Number(e.start_date.slice(0, 4))); return acc; }, 0);
  const remaining = Number(p?.annual_allowance ?? 0) - summary;
  const counts = typeOf(e.absence_type).counts_toward_allowance;

  openModal({
    title: "Review request",
    body: `
      <div><div style="font-size:17px;font-weight:700">${esc(nameOf(e.employee_id))}</div>
        <div class="meta" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${typeChip(e.absence_type)}<span>${esc(rangeLabel(e))}</span></div></div>
      <div class="daycount">${fmtDays(e.days)} requested${counts ? ` · ${remaining} of ${Number(p?.annual_allowance ?? 0)} allowance days left before this request${remaining - e.days < 0 ? " — <span style='color:var(--bad)'>this would go over</span>" : ""}` : ""}</div>
      ${e.notes ? `<div><label>Employee's note</label><div class="note" style="margin-top:5px;background:var(--blue-50);padding:9px 11px;border-radius:8px;white-space:pre-wrap">${esc(e.notes)}</div></div>` : ""}
      <label>Note to employee (optional)<textarea id="review-note" placeholder="${suggested === "denied" ? "Let them know why…" : "e.g. Enjoy your trip!"}"></textarea></label>`,
    footer: `<button class="btn" data-cancel>Close</button>
      <button class="btn danger ${suggested === "denied" ? "solid" : ""}" data-deny>Deny</button>
      <button class="btn ok" data-approve>Approve</button>`,
    onMount: (el, close) => {
      $("[data-cancel]", el).onclick = close;
      const go = (status, btn) => busy(btn, async () => {
        const { data, error } = await sb.from("time_off")
          .update({ status, review_note: $("#review-note", el).value.trim() || null })
          .eq("id", id).eq("status", "pending").select();
        if (error) return toast(error.message, "error");
        if (!data?.length) { toast("This request was changed by someone else — refreshing."); }
        else toast(`Request ${status}. ${nameOf(e.employee_id)} has been notified.`);
        close();
        await loadAll(); render();
      });
      $("[data-approve]", el).onclick = (ev) => go("approved", ev.currentTarget);
      $("[data-deny]", el).onclick = (ev) => go("denied", ev.currentTarget);
    },
  });
}

/* ================= Requests & absences ================= */
function filteredEntries() {
  const f = S.filters;
  return S.entries.filter((e) =>
    (!f.employee || e.employee_id === f.employee) &&
    (!f.type || e.absence_type === f.type) &&
    (!f.status || e.status === f.status) &&
    (!f.from || e.end_date >= f.from) &&
    (!f.to || e.start_date <= f.to));
}

const employeeOptions = (sel, includeAll = true) =>
  (includeAll ? `<option value="">All employees</option>` : "") +
  S.profiles.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.full_name)}${p.active ? "" : " (inactive)"}</option>`).join("");
const typeOptions = (sel, includeAll = true) =>
  (includeAll ? `<option value="">All types</option>` : "") +
  S.types.map((t) => `<option value="${t.code}" ${t.code === sel ? "selected" : ""}>${esc(t.label)}</option>`).join("");

function viewRequests() {
  // URL params (from email links / dashboard)
  if (S.params.get("status")) S.filters.status = S.params.get("status");
  if (S.params.get("employee")) S.filters.employee = S.params.get("employee");
  const highlight = S.params.get("id");
  if (highlight) { S.filters = { employee: "", type: "", status: "", from: "", to: "" }; }
  const f = S.filters;
  const rows = filteredEntries();
  const total = rows.filter((e) => e.status === "approved").reduce((n, e) => n + Number(e.days), 0);

  $("#page").innerHTML = `
    <section class="card">
      <div class="filters">
        <label>Employee<select id="f-employee">${employeeOptions(f.employee)}</select></label>
        <label>Type<select id="f-type">${typeOptions(f.type)}</select></label>
        <label>Status<select id="f-status">
          ${["", "pending", "approved", "denied", "cancelled"].map((s) => `<option value="${s}" ${s === f.status ? "selected" : ""}>${s ? s[0].toUpperCase() + s.slice(1) : "All statuses"}</option>`).join("")}
        </select></label>
        <label>From<input type="date" id="f-from" value="${esc(f.from)}"></label>
        <label>To<input type="date" id="f-to" value="${esc(f.to)}"></label>
        <button class="btn" id="f-year">This year</button>
        <button class="btn" id="f-clear">Clear</button>
        <span class="spacer"></span>
        <button class="btn" id="export-btn">⤓ Export to Excel</button>
      </div>
      <div class="card-b small muted" style="padding:10px 18px">${rows.length} entr${rows.length === 1 ? "y" : "ies"} · ${total} approved day${total === 1 ? "" : "s"}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th class="r">Days</th><th>Status</th><th>Notes</th><th>Last change</th><th></th></tr></thead>
        <tbody>${rows.map((e) => `
          <tr data-row="${e.id}" class="${e.id === highlight ? "highlight" : ""}">
            <td><b>${esc(nameOf(e.employee_id))}</b><div class="muted small">${e.source === "manager" ? "Entered by manager" : "Employee request"}</div></td>
            <td>${typeChip(e.absence_type)}</td>
            <td class="dates">${esc(rangeLabel(e))}</td>
            <td class="r num"><b>${Number(e.days)}</b></td>
            <td>${statusBadge(e.status)}${e.review_note ? `<div class="muted small" title="${esc(e.review_note)}">“${esc(e.review_note.slice(0, 40))}${e.review_note.length > 40 ? "…" : ""}”</div>` : ""}</td>
            <td class="notes small">${esc(e.notes || "")}</td>
            <td class="small">${esc(nameOf(e.updated_by || e.created_by))}<div class="muted">${esc(fmtTime(e.updated_at || e.created_at))}</div></td>
            <td><div class="btn-row" style="justify-content:flex-end">
              ${e.status === "pending" ? `<button class="btn ok small" data-review="${e.id}">Review</button>` : ""}
              <button class="btn small" data-edit="${e.id}">Edit</button>
              <button class="btn danger small" data-del="${e.id}" aria-label="Delete">✕</button>
            </div></td>
          </tr>`).join("") || `<tr><td colspan="8" class="empty">No entries match these filters.</td></tr>`}
        </tbody></table></div>
    </section>`;

  const bind = (id, key) => ($(id).onchange = (ev) => { S.filters[key] = ev.target.value; S.params = new URLSearchParams(); history.replaceState(null, "", "#/requests"); viewRequests(); });
  bind("#f-employee", "employee"); bind("#f-type", "type"); bind("#f-status", "status"); bind("#f-from", "from"); bind("#f-to", "to");
  $("#f-clear").onclick = () => { S.filters = { employee: "", type: "", status: "", from: "", to: "" }; S.params = new URLSearchParams(); history.replaceState(null, "", "#/requests"); viewRequests(); };
  $("#f-year").onclick = () => { const y = new Date().getFullYear(); S.filters.from = `${y}-01-01`; S.filters.to = `${y}-12-31`; viewRequests(); };
  $("#export-btn").onclick = () => exportExcel(rows);
  $$("[data-review]").forEach((b) => (b.onclick = () => reviewDialog(b.dataset.review)));
  $$("[data-edit]").forEach((b) => (b.onclick = () => openEntryEditor(S.entries.find((e) => e.id === b.dataset.edit))));
  $$("[data-del]").forEach((b) => (b.onclick = () => deleteEntry(b.dataset.del)));

  if (highlight) {
    const row = $(`[data-row="${CSS.escape(highlight)}"]`);
    row?.scrollIntoView({ block: "center" });
    const e = S.entries.find((x) => x.id === highlight);
    if (e?.status === "pending" && !document.querySelector(".overlay")) reviewDialog(e.id);
    if (!e) toast("That request was not found — it may have been deleted.", "error");
    S.params.delete("id");
    history.replaceState(null, "", "#/requests");
  }
}

async function deleteEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const ok = await confirmDialog("Delete entry?",
    `Remove <b>${esc(nameOf(e.employee_id))}</b>'s ${esc(typeOf(e.absence_type).label)} (${esc(rangeLabel(e))})? It will no longer count toward their totals. The deletion is kept in the activity log.`,
    "Delete", true);
  if (!ok) return;
  const { error } = await sb.from("time_off").delete().eq("id", id);
  if (error) return toast(error.message, "error");
  toast("Entry deleted.");
  await loadAll(); render();
}

/* ---------- Add / edit entry ---------- */
async function openEntryEditor(entry) {
  const isNew = !entry;
  const e = entry ?? {
    employee_id: S.filters.employee || "", absence_type: "sick", start_date: todayISO(), end_date: todayISO(),
    start_half: false, end_half: false, notes: "", status: "approved",
  };

  const { el, close } = openModal({
    title: isNew ? "Record an absence" : "Edit entry",
    body: `
      <form id="entry-form" class="form-grid">
        <label class="full">Employee<select name="employee_id" required>
          <option value="" disabled ${e.employee_id ? "" : "selected"}>Choose an employee…</option>${employeeOptions(e.employee_id, false)}</select></label>
        <label>Absence type<select name="absence_type">${typeOptions(e.absence_type, false)}</select></label>
        <label>Status<select name="status">
          ${["approved", "pending", "denied", "cancelled"].map((s) => `<option value="${s}" ${s === e.status ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}
        </select></label>
        <label>Start date<input type="date" name="start_date" value="${esc(e.start_date)}" required></label>
        <label>End date<input type="date" name="end_date" value="${esc(e.end_date)}" required></label>
        <div class="full" id="half-single"><label class="check"><input type="checkbox" name="half_single" ${e.start_half || e.end_half ? "checked" : ""}> Half day</label></div>
        <div class="full" id="half-range" style="display:flex;gap:22px">
          <label class="check"><input type="checkbox" name="start_half" ${e.start_half ? "checked" : ""}> First day is a half day</label>
          <label class="check"><input type="checkbox" name="end_half" ${e.end_half ? "checked" : ""}> Last day is a half day</label>
        </div>
        <div class="full daycount" id="daycount"></div>
        <label class="full">Notes (optional)<textarea name="notes" maxlength="2000">${esc(e.notes || "")}</textarea></label>
        <p class="form-error full" id="entry-error" hidden></p>
      </form>
      ${isNew ? `<p class="muted small" style="margin:0">Manager-entered absences are recorded immediately — no approval step, and no email is sent.</p>` : `<div class="history" id="history">Loading history…</div>`}`,
    footer: `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>${isNew ? "Record absence" : "Save changes"}</button>`,
  });

  const f = $("#entry-form", el);
  const sync = () => {
    if (f.end_date.value && f.start_date.value && f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value;
    const single = f.start_date.value === f.end_date.value;
    $("#half-single", el).hidden = !single;
    $("#half-range", el).style.display = single ? "none" : "flex";
    const [sh, eh] = single ? [f.half_single.checked, false] : [f.start_half.checked, f.end_half.checked];
    const n = businessDays(f.start_date.value, f.end_date.value, sh, eh);
    $("#daycount", el).innerHTML = n ? `${fmtDays(n)} (weekdays only)` : `<span style="color:var(--bad)">No workdays in this range</span>`;
    return { sh, eh, n };
  };
  f.addEventListener("input", sync);
  f.addEventListener("change", sync);
  sync();

  $("[data-cancel]", el).onclick = close;
  $("[data-save]", el).onclick = (ev) => busy(ev.currentTarget, async () => {
    const err = $("#entry-error", el);
    err.hidden = true;
    if (!f.reportValidity()) return;
    const { sh, eh, n } = sync();
    if (!n) { err.textContent = "Pick dates that include at least one weekday."; err.hidden = false; return; }
    const payload = {
      employee_id: f.employee_id.value, absence_type: f.absence_type.value, status: f.status.value,
      start_date: f.start_date.value, end_date: f.end_date.value, start_half: sh, end_half: eh,
      notes: f.notes.value.trim() || null,
    };
    const q = isNew
      ? sb.from("time_off").insert({ ...payload, source: "manager" }).select()
      : sb.from("time_off").update(payload).eq("id", e.id).select();
    const { error } = await q;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    toast(isNew ? `Absence recorded for ${nameOf(payload.employee_id)}.` : "Changes saved.");
    close();
    await loadAll(); render();
  });

  if (!isNew) {
    const { data } = await sb.from("audit_log").select("*").eq("record_id", e.id).order("at");
    const h = $("#history", el);
    if (h) h.innerHTML = `<b>History</b>` + ((data ?? []).map((a) => `<div>${esc(fmtTime(a.at))} — <b>${esc(a.actor_name)}</b> ${esc(describeChange(a))}</div>`).join("") || "<div>No history recorded.</div>");
  }
}

/* ---------- Excel export ---------- */
async function exportExcel(rows) {
  const year = (S.filters.from || `${new Date().getFullYear()}`).slice(0, 4);
  const sheet1 = rows.map((e) => ({
    Employee: nameOf(e.employee_id),
    Type: typeOf(e.absence_type).label,
    "Start date": e.start_date,
    "End date": e.end_date,
    "Half day start": e.start_half ? "Yes" : "",
    "Half day end": e.end_half ? "Yes" : "",
    Days: Number(e.days),
    Status: e.status,
    Source: e.source === "manager" ? "Manager entry" : "Employee request",
    Notes: e.notes || "",
    "Manager note": e.review_note || "",
    "Reviewed by": e.reviewed_by ? nameOf(e.reviewed_by) : "",
    "Reviewed at": e.reviewed_at ? fmtTime(e.reviewed_at) : "",
    "Created by": nameOf(e.created_by),
    "Created at": fmtTime(e.created_at),
    "Last modified by": e.updated_by ? nameOf(e.updated_by) : "",
    "Last modified at": e.updated_by ? fmtTime(e.updated_at) : "",
  }));
  const { data: summary, error } = await sb.rpc("year_summary", { p_year: Number(year) });
  if (error) toast(`Summary sheet skipped: ${error.message}`, "error");

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(sheet1.length ? sheet1 : [{ Employee: "No entries match the current filters" }]);
  ws1["!cols"] = [22, 16, 12, 12, 8, 8, 7, 11, 17, 40, 30, 18, 20, 18, 20, 18, 20].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, "Time off");
  if (summary) {
    const ws2 = XLSX.utils.json_to_sheet(summary.map((s) => ({
      Employee: s.full_name, Email: s.email, Active: s.active ? "Yes" : "No",
      "Annual allowance": Number(s.annual_allowance), "Vacation/PTO": Number(s.pto_days), "Sick": Number(s.sick_days),
      "Personal": Number(s.personal_days), "Other": Number(s.other_days), "Total days off": Number(s.total_days),
      "Allowance used": Number(s.allowance_used), "Remaining": Number(s.remaining), "Pending": Number(s.pending_days),
    })));
    ws2["!cols"] = [22, 28, 7, 10, 12, 7, 9, 7, 13, 13, 10, 9].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws2, `Summary ${year}`);
  }
  XLSX.writeFile(wb, `Axsys-time-off-${todayISO()}.xlsx`);
  toast("Excel file downloaded.");
}

/* ================= Calendar ================= */
function viewCalendar() {
  const c = S.cal;
  $("#page").innerHTML = `
    <section class="card">
      <div class="filters">
        <label>Employee<select id="c-employee">${employeeOptions(c.employee)}</select></label>
        <label>Type<select id="c-type">${typeOptions(c.type)}</select></label>
        <label class="check" style="margin-bottom:9px"><input type="checkbox" id="c-pending" ${c.pending ? "checked" : ""}> Show pending requests</label>
      </div>
      <div id="calendar"></div>
      <div class="legend">${S.types.map((t) => `<span><span class="type-dot" style="background:${esc(t.color)}"></span>${esc(t.label)}</span>`).join("")}
        <span><span class="type-dot" style="background:repeating-linear-gradient(45deg,#94a3b8 0 3px,#e2e8f0 3px 6px)"></span>Pending (striped)</span></div>
    </section>`;

  const events = S.entries
    .filter((e) => (e.status === "approved" || (c.pending && e.status === "pending")) &&
      (!c.employee || e.employee_id === c.employee) && (!c.type || e.absence_type === c.type))
    .map((e) => ({
      id: e.id,
      title: `${nameOf(e.employee_id)} · ${typeOf(e.absence_type).label}${e.start_half || e.end_half ? " (½)" : ""}${e.status === "pending" ? " · pending" : ""}`,
      start: e.start_date,
      end: addDays(e.end_date, 1),
      allDay: true,
      backgroundColor: typeOf(e.absence_type).color,
      borderColor: typeOf(e.absence_type).color,
      classNames: e.status === "pending" ? ["is-pending"] : [],
    }));

  if (S.calendar) { S.cal.date = S.calendar.getDate(); S.calendar.destroy(); }
  S.calendar = new FullCalendar.Calendar($("#calendar"), {
    initialView: "dayGridMonth",
    initialDate: S.cal.date || undefined,
    height: "auto",
    firstDay: 0,
    dayMaxEvents: 4,
    headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,dayGridWeek,listMonth" },
    buttonText: { today: "Today", month: "Month", week: "Week", list: "List" },
    events,
    eventClick: (info) => {
      const e = S.entries.find((x) => x.id === info.event.id);
      if (e?.status === "pending") reviewDialog(e.id); else openEntryEditor(e);
    },
    datesSet: () => { S.cal.date = S.calendar?.getDate(); },
  });
  S.calendar.render();

  $("#c-employee").onchange = (ev) => { c.employee = ev.target.value; viewCalendar(); };
  $("#c-type").onchange = (ev) => { c.type = ev.target.value; viewCalendar(); };
  $("#c-pending").onchange = (ev) => { c.pending = ev.target.checked; viewCalendar(); };
}

/* ================= Employees ================= */
async function viewEmployees() {
  const thisYear = new Date().getFullYear();
  $("#page").innerHTML = `<section class="card"><div class="empty">Loading…</div></section>`;
  const { data, error } = await sb.rpc("year_summary", { p_year: S.year });
  if (S.route !== "employees") return;
  if (error) { $("#page").innerHTML = `<section class="card"><div class="empty">Couldn't load: ${esc(error.message)}</div></section>`; return; }

  $("#page").innerHTML = `
    <section class="card">
      <div class="filters">
        <label>Year<select id="e-year">${[thisYear - 3, thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => `<option ${y === S.year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
        <span class="spacer"></span>
        <button class="btn" id="e-export">⤓ Export ${S.year} to Excel</button>
        <button class="btn primary" id="e-add">+ Add employee</button>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Employee</th><th class="r">Vacation/PTO</th><th class="r">Sick</th><th class="r">Personal</th><th class="r">Other</th>
          <th class="r">Total off</th><th>Allowance</th><th class="r">Pending</th><th></th></tr></thead>
        <tbody>${data.map((s) => {
          const p = profile(s.employee_id) || {};
          const pct = s.annual_allowance > 0 ? Math.min(100, (s.allowance_used / s.annual_allowance) * 100) : 0;
          return `<tr class="${s.active ? "" : "inactive"}">
            <td><b>${esc(s.full_name)}</b>${p.role === "manager" ? ` <span class="badge">Manager</span>` : ""}${s.active ? "" : ` <span class="badge cancelled">Inactive</span>`}
              <div class="muted small">${esc(s.email)}</div></td>
            <td class="r num">${Number(s.pto_days)}</td>
            <td class="r num">${Number(s.sick_days)}</td>
            <td class="r num">${Number(s.personal_days)}</td>
            <td class="r num">${Number(s.other_days)}</td>
            <td class="r num"><b>${Number(s.total_days)}</b></td>
            <td style="min-width:150px"><span class="num"><b>${Number(s.remaining)}</b> left</span> <span class="muted small">of ${Number(s.annual_allowance)}</span>
              <div class="bar ${s.remaining < 0 ? "over" : ""}"><span style="width:${pct}%"></span></div></td>
            <td class="r num">${Number(s.pending_days) || ""}</td>
            <td><div class="btn-row" style="justify-content:flex-end">
              <button class="btn small" data-records="${s.employee_id}">Records</button>
              <button class="btn small" data-edit-emp="${s.employee_id}">Edit</button>
            </div></td></tr>`;
        }).join("") || `<tr><td colspan="9" class="empty">No employees yet. Click “Add employee”.</td></tr>`}
        </tbody></table></div>
      <div class="card-b small muted">Vacation/PTO and Personal days count toward the yearly allowance. Sick and Other days are tracked but don't reduce it. Weekends are never counted.</div>
    </section>`;

  $("#e-year").onchange = (ev) => { S.year = Number(ev.target.value); viewEmployees(); };
  $("#e-add").onclick = addEmployeeDialog;
  $("#e-export").onclick = () => {
    S.filters = { employee: "", type: "", status: "", from: `${S.year}-01-01`, to: `${S.year}-12-31` };
    exportExcel(filteredEntries());
  };
  $$("[data-records]").forEach((b) => (b.onclick = () => {
    S.filters = { employee: b.dataset.records, type: "", status: "", from: `${S.year}-01-01`, to: `${S.year}-12-31` };
    location.hash = "#/requests";
  }));
  $$("[data-edit-emp]").forEach((b) => (b.onclick = () => editEmployeeDialog(profile(b.dataset.editEmp))));
}

function addEmployeeDialog() {
  const pw = genPassword();
  openModal({
    title: "Add employee",
    body: `<form id="emp-form" class="form-grid">
        <label class="full">Full name<input name="full_name" required></label>
        <label class="full">Work email<input name="email" type="email" required placeholder="name@axsysinc.com"></label>
        <label>Yearly allowance (days)<input name="annual_allowance" type="number" min="0" step="0.5" value="10" required></label>
        <label>Role<select name="role"><option value="employee">Employee</option><option value="manager">Manager</option></select></label>
        <label class="full">Temporary password<input name="password" value="${esc(pw)}" minlength="10" required></label>
        <p class="muted small full" style="margin:0">Share the email and temporary password with the employee. They can change the password in the app under “Account”.</p>
        <p class="form-error full" id="emp-error" hidden></p>
      </form>`,
    footer: `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>Create account</button>`,
    onMount: (el, close) => {
      const f = $("#emp-form", el);
      $("[data-cancel]", el).onclick = close;
      $("[data-save]", el).onclick = (ev) => busy(ev.currentTarget, async () => {
        if (!f.reportValidity()) return;
        const err = $("#emp-error", el);
        try {
          await invokeAdmin({
            action: "create", full_name: f.full_name.value.trim(), email: f.email.value.trim(),
            annual_allowance: Number(f.annual_allowance.value), role: f.role.value, password: f.password.value,
          });
          close();
          openModal({
            title: "Account created",
            body: `<p style="margin:0">Send these sign-in details to <b>${esc(f.full_name.value)}</b>:</p>
              <div class="daycount" style="font-family:Consolas,monospace;user-select:all">Email: ${esc(f.email.value.trim())}<br>Temporary password: ${esc(f.password.value)}</div>`,
            footer: `<button class="btn primary" data-ok>Done</button>`,
            onMount: (el2, close2) => ($("[data-ok]", el2).onclick = close2),
          });
          await loadAll(); render();
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      });
    },
  });
}

function editEmployeeDialog(p) {
  if (!p) return;
  const self = p.id === S.me.id;
  openModal({
    title: `Edit ${p.full_name}`,
    body: `<form id="emp-form" class="form-grid">
        <label class="full">Full name<input name="full_name" value="${esc(p.full_name)}" required></label>
        <label>Yearly allowance (days)<input name="annual_allowance" type="number" min="0" step="0.5" value="${Number(p.annual_allowance)}" required></label>
        <label>Role<select name="role"><option value="employee" ${p.role === "employee" ? "selected" : ""}>Employee</option>
          <option value="manager" ${p.role === "manager" ? "selected" : ""}>Manager</option></select></label>
        <p class="form-error full" id="emp-error" hidden></p>
      </form>
      <div class="history">
        <b>Account</b>
        <div class="btn-row">
          <button class="btn small" data-reset>Reset password…</button>
          ${self ? "" : p.active
            ? `<button class="btn danger small" data-deactivate>Deactivate account</button>`
            : `<button class="btn small" data-reactivate>Reactivate account</button>`}
        </div>
        <div class="muted">Deactivated staff can't sign in; their records stay in reports.</div>
      </div>`,
    footer: `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button>`,
    onMount: (el, close) => {
      const f = $("#emp-form", el);
      const err = $("#emp-error", el);
      $("[data-cancel]", el).onclick = close;
      $("[data-save]", el).onclick = (ev) => busy(ev.currentTarget, async () => {
        if (!f.reportValidity()) return;
        const { error } = await sb.from("profiles").update({
          full_name: f.full_name.value.trim(), annual_allowance: Number(f.annual_allowance.value), role: f.role.value,
        }).eq("id", p.id);
        if (error) { err.textContent = error.message; err.hidden = false; return; }
        toast("Employee updated."); close(); await loadAll(); render();
      });
      $("[data-reset]", el).onclick = () => { close(); resetPasswordDialog(p); };
      const setActive = async (active) => {
        const ok = await confirmDialog(active ? "Reactivate account?" : "Deactivate account?",
          active ? `${esc(p.full_name)} will be able to sign in again.` : `${esc(p.full_name)} will no longer be able to sign in. Their time-off history is kept.`,
          active ? "Reactivate" : "Deactivate", !active);
        if (!ok) return;
        try { await invokeAdmin({ action: "set_active", user_id: p.id, active }); toast("Account updated."); close(); await loadAll(); render(); }
        catch (e) { toast(e.message, "error"); }
      };
      $("[data-deactivate]", el) && ($("[data-deactivate]", el).onclick = () => setActive(false));
      $("[data-reactivate]", el) && ($("[data-reactivate]", el).onclick = () => setActive(true));
    },
  });
}

function resetPasswordDialog(p) {
  openModal({
    title: `Reset password · ${p.full_name}`,
    body: `<label>New temporary password<input id="new-pw" value="${esc(genPassword())}" minlength="10"></label>
      <p class="muted small" style="margin:0">Give this to ${esc(p.full_name)}; they can change it in the app under “Account”.</p>`,
    footer: `<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>Set password</button>`,
    onMount: (el, close) => {
      $("[data-cancel]", el).onclick = close;
      $("[data-save]", el).onclick = (ev) => busy(ev.currentTarget, async () => {
        try { await invokeAdmin({ action: "reset_password", user_id: p.id, password: $("#new-pw", el).value }); toast("Password reset."); close(); }
        catch (e) { toast(e.message, "error"); }
      });
    },
  });
}

/* ================= Activity ================= */
const FIELD_LABELS = { start_date: "start", end_date: "end", start_half: "half-day start", end_half: "half-day end", absence_type: "type", notes: "notes", status: "status", employee_id: "employee", review_note: "manager note", full_name: "name", annual_allowance: "allowance", role: "role", active: "active" };

function describeChange(a) {
  const n = a.new_data || {}, o = a.old_data || {};
  const rec = { ...o, ...n };
  if (a.table_name === "time_off") {
    const what = `${nameOf(rec.employee_id)}'s ${typeOf(rec.absence_type).label} (${rec.start_date ? rangeLabel(rec) : "?"})`;
    if (a.action === "INSERT") return n.source === "manager" ? `recorded ${what} as ${n.status}` : `submitted ${what}`;
    if (a.action === "DELETE") return `deleted ${what}`;
    if (o.status !== n.status) return `${n.status === "cancelled" ? "cancelled" : `marked ${n.status}`}: ${what}`;
    const changed = Object.keys(FIELD_LABELS).filter((k) => k in n && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
    return `edited ${what}${changed.length ? ` — ${changed.map((k) => `${FIELD_LABELS[k]}: ${o[k] ?? "—"} → ${n[k] ?? "—"}`).join("; ")}` : ""}`;
  }
  if (a.table_name === "profiles") {
    const changed = ["full_name", "annual_allowance", "role", "active"].filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
    return `updated ${rec.full_name}${changed.length ? ` — ${changed.map((k) => `${FIELD_LABELS[k]}: ${o[k]} → ${n[k]}`).join("; ")}` : ""}`;
  }
  const target = nameOf(a.record_id);
  return ({ CREATE_USER: `created an account for ${n?.full_name || target}`, RESET_PASSWORD: `reset the password for ${target}`,
    DEACTIVATE_USER: `deactivated ${target}`, REACTIVATE_USER: `reactivated ${target}` })[a.action] || a.action;
}

async function viewActivity() {
  const tab = S.activityTab;
  $("#page").innerHTML = `<section class="card">
      <div class="card-h"><div class="tabs">
        <button data-tab="audit" class="${tab === "audit" ? "on" : ""}">Changes</button>
        <button data-tab="email" class="${tab === "email" ? "on" : ""}">Email delivery</button></div>
        <input id="act-search" placeholder="Search…" style="max-width:240px;margin:0"></div>
      <div id="act-body"><div class="empty">Loading…</div></div></section>`;
  $$("[data-tab]").forEach((b) => (b.onclick = () => { S.activityTab = b.dataset.tab; viewActivity(); }));

  let items = [];
  if (tab === "audit") {
    const { data, error } = await sb.from("audit_log").select("*").order("at", { ascending: false }).limit(500);
    if (error) return ($("#act-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`);
    items = (data ?? []).map((a) => ({ html: `<div class="act"><div class="when">${esc(fmtTime(a.at))}</div>
        <div><b>${esc(a.actor_name || "System")}</b> ${esc(describeChange(a))}</div></div>`, text: `${a.actor_name} ${describeChange(a)}` }));
  } else {
    const { data, error } = await sb.from("email_log").select("*").order("created_at", { ascending: false }).limit(300);
    if (error) return ($("#act-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`);
    items = (data ?? []).map((m) => ({ html: `<div class="act"><div class="when">${esc(fmtTime(m.created_at))}</div>
        <div><span class="badge ${m.status === "sent" ? "approved" : "denied"}">${m.status === "sent" ? "Delivered to provider" : "Failed"}</span>
          <b>${esc(m.subject || m.event)}</b><div class="chg">To ${esc(m.recipient)}${m.error ? ` · <span style="color:var(--bad)">${esc(m.error)}</span>` : ""}</div></div></div>`,
      text: `${m.subject} ${m.recipient} ${m.status}` }));
  }
  const draw = (q = "") => {
    const list = items.filter((i) => i.text.toLowerCase().includes(q.toLowerCase()));
    $("#act-body").innerHTML = list.map((i) => i.html).join("") || `<div class="empty">Nothing to show yet.</div>`;
  };
  draw();
  $("#act-search").oninput = (ev) => draw(ev.target.value);
}

init();
