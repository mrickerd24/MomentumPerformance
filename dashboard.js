import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, formatFullName, escapeHtml, hasCoachRole } from "./app.js";
import { collection, query, where, getDocs, doc, getDoc, addDoc, deleteDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { injectNotificationBell } from "./notifications.js";
import { formatMoney as formatMoneyCents } from "./money.js";
import { buildDashboardUnbilledSummary } from "./dashboardMoney.js";

let dashboardUserId = null;
let dashboardUserData = null;

// ---------------- TILE DEFINITIONS ----------------
// Note: "Schedule" used to be defined per-role (viewSchedule / childSchedule /
// clubSchedule) and rendered inside each role section. They all pointed at
// the same calendar.html, so a multi-role user (e.g. coach + skater) saw the
// same tile twice. The schedule tile is now a single top-level tile defined
// alongside CONNECTIONS_TILE below — no per-role variant lives here.
//
// "Add hours" was also removed: logging hours happens on the calendar itself
// (a coach taps an ice slot to add a session), so it duplicated Schedule.
//
// Coach tiles split: "hoursCoached" used to cover the whole week, but it
// blurred together hours actually taught and hours still scheduled. It now
// covers only sessions whose end time is at or before "now"; the new
// "upcomingHours" tile covers the remainder of the same week. Both tiles
// use the week-start day from the coach's account settings; they fall back
// to Sunday when no preference is set.
//
// Skater tiles mirror the same completed/upcoming split, but along TWO axes
// instead of one: ice-patch time vs time-with-coach. Sessions with type
// containing "private" or "group" count toward ice time (the skater is on
// the ice patch); ALL sessions (including off-ice) count toward coach time
// (every session in this app has a coachUid, so every session a skater is
// in is a coached session). This means a pure off-ice session contributes
// only to coach time, while an on-ice session contributes to BOTH.
//
// Skater spending tiles mirror the coach earnings tiles from the payer's
// side: "balance owed" covers sessions completed (or in progress) since
// the start of the week, and "spending projection" is that balance plus
// everything still scheduled. Each session's amount is split evenly
// across its participants — a $60 group session with 3 skaters is $20
// per skater. Off-ice sessions count toward spending too, since the
// skater is paying for time-with-coach regardless of where it happens.
const TILE_DEFINITIONS = {
  // Coach tiles
  hoursCoached:       { labelKey: "hoursCoached",       color: "#0097A7", href: "calendar.html?view=week" },
  upcomingHours:      { labelKey: "upcomingHours",      color: "#0097A7", href: "calendar.html?view=week" },
  // Earnings mirror the same completed/upcoming split as the hour tiles
  // above, so the four coach tiles read as a 2x2 grid: hours on the top
  // row, dollars on the bottom row. A different colour family
  // distinguishes earnings from raw hours at a glance.
  billableEarnings:   { labelKey: "billableEarnings",   color: "#1F845A", href: "payment.html" },
  plannedEarnings:    { labelKey: "plannedEarnings",    color: "#1F845A", href: "calendar.html?view=week" },
  // MP-121: "Unbilled" tile lives below the 2x2 hours/earnings grid as
  // a full-width tile. Click-through goes to paymentGenerate.html, the
  // preview screen for invoice generation. Color is purple to match
  // the "Generate" CTA on that page (visually links the entry point
  // and the destination). The `fullWidth: true` flag tells
  // renderDashboard to give this tile its own row spanning the full
  // width — without it, the renderer would pair it with whatever comes
  // next, which is wrong here because the 2x2 grid above has to stay
  // a 2x2.
  unbilledInvoices:   { labelKey: "unbilledInvoices",   color: "#534AB7", href: "paymentGenerate.html", fullWidth: true },
  newInvoice:         { labelKey: "newInvoice",         color: "#534AB7", href: "payment.html?filter=due" },

  // Skater tiles
  iceTimeWeek:        { labelKey: "iceTimeWeek",        color: "#e75384", href: "calendar.html?view=week" },
  coachTimeWeek:      { labelKey: "coachTimeWeek",      color: "#e75384", href: "calendar.html?view=week" },
  iceTimeUpcoming:    { labelKey: "iceTimeUpcoming",    color: "#2343fa", href: "calendar.html?view=week" },
  coachTimeUpcoming:  { labelKey: "coachTimeUpcoming",  color: "#2343fa", href: "calendar.html?view=week" },
  // Skater spending tiles — mirror the coach earnings tiles but from the
  // payer's side. "Balance owed" is what the skater owes for sessions that
  // have already happened (or are in progress) since the start of the
  // week; "Spending projection" is that balance plus everything still
  // scheduled this week. Same green family as the coach earnings tiles
  // so the dollar/cents tiles read consistently across both roles.
  skaterBalance:      { labelKey: "skaterBalance",      color: "#1F845A", href: "payment.html?filter=due" },
  skaterProjection:   { labelKey: "skaterProjection",   color: "#1F845A", href: "calendar.html?view=week" },

  // Parent tiles
  myChildren:     { labelKey: "myChildren",     color: "#1F845A", href: "addConnection.html?mode=children" },
  childHours:     { labelKey: "childHours",       color: "#0097A7", href: "calendar.html?view=week" },

  // Admin tiles
  clubCoaches:    { labelKey: "clubCoaches",     color: "#0C66E4", href: "students.html" },
  clubStudents:   { labelKey: "clubStudents",    color: "#1F845A", href: "students.html" },
  iceHours:       { labelKey: "iceHours",        color: "#0097A7", href: "calendar.html?view=week" },
};

// ---------------- ROLE SECTIONS ----------------
// Admin is intentionally not assignable via signup — set directly in Firestore.
const ROLE_SECTIONS = {
  coach: {
    labelKey: "coachSection",
    // 2x2 grid: hours on the top row (completed | upcoming), earnings on
    // the bottom row (billable | planned). Earnings are computed from the
    // same sessions used by the hour tiles, multiplied by the coach's
    // configured pricing in account settings. The unbilled tile sits
    // below as a full-width row (see TILE_DEFINITIONS.unbilledInvoices
    // — fullWidth: true forces it onto its own row).
    tiles: ["hoursCoached", "upcomingHours", "billableEarnings", "plannedEarnings", "unbilledInvoices"]
  },
  affiliateCoach: {
    labelKey: "coachSection",
    tiles: ["hoursCoached", "upcomingHours", "billableEarnings", "plannedEarnings", "unbilledInvoices"]
  },
  skater: {
    labelKey: "skaterSection",
    // 2x3 layout: completed (row 1) and upcoming (row 2) for ice/coach
    // time, then balance/projection (row 3) for spending. The
    // renderDashboard pairing logic builds rows two-at-a-time, so this
    // list order produces the intended grid. Mirrors the coach section's
    // hours-then-dollars structure.
    tiles: [
      "iceTimeWeek", "coachTimeWeek",
      "iceTimeUpcoming", "coachTimeUpcoming",
      "skaterBalance", "newInvoice", "skaterProjection",
    ]
  },
  parent: {
    labelKey: "parentSection",
    // Mirror the skater dashboard exactly: completed time row, upcoming
    // time row, then money row. Parent values are calculated for the
    // children they represent, but the layout should read the same.
    tiles: [
      "myChildren",
      "iceTimeWeek", "coachTimeWeek",
      "iceTimeUpcoming", "coachTimeUpcoming",
      "skaterBalance", "newInvoice", "skaterProjection",
    ]
  },
  admin: {
    labelKey: "adminSection",
    tiles: ["clubCoaches", "clubStudents", "iceHours"]
  },
};

// Top-level tiles rendered once at the top of the dashboard, outside of any
// role section. Both link to destinations that work the same regardless of
// the viewer's role(s):
//   - "My connections" → addConnection.html handles listing/adding/removing
//     connections for coaches, skaters, and parents alike.
//   - "Schedule" → calendar.html?view=day is the single shared calendar view; pulling
//     it up here avoids showing the same Schedule tile twice for multi-role
//     users (e.g. someone who is both a coach and a skater).
const CONNECTIONS_TILE = { labelKey: "myConnections", color: "#0C66E4", href: "addConnection.html" };
const COACH_MANAGEMENT_TILE = { labelKey: "coachManagement", color: "#0C66E4", href: "#" };
const SCHEDULE_TILE    = { labelKey: "viewSchedule",  color: "#6d30a6", href: "calendar.html?view=day" };

// ---------------- WEEK-RANGE HELPERS ----------------
// Map the lowercase day-name strings stored in users/{uid}.weekStart to
// JS Date.getDay() numbers (0 = Sunday … 6 = Saturday). Anything missing or
// unrecognised falls through to Sunday — the legacy default used by the
// calendar's renderWeek().
const DAY_NAME_TO_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Returns { start, end } Date objects bracketing the user's current week.
// `start` is local-midnight on the configured week-start day; `end` is the
// last millisecond of the 7th day. Both are local-time so they line up with
// however sessions are stored (calendar.js writes session.date as a midday
// Timestamp on the chosen calendar day).
function getCurrentWeekRange(weekStartName) {
  const startDayIdx = DAY_NAME_TO_INDEX[weekStartName] ?? 0; // default Sunday
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // How many days back from today to reach the most recent week-start day.
  // (today.getDay() - startDayIdx + 7) % 7 produces 0..6.
  const daysSinceStart = (today.getDay() - startDayIdx + 7) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceStart);
  // start is already at 00:00 local time because `today` was constructed
  // from y/m/d only.
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  end.setMilliseconds(end.getMilliseconds() - 1); // 23:59:59.999 of day 7
  return { start, end };
}

// Format a minutes count as "Xh YYmin" / "YYmin" / "Xh". Used as the second
// line of the coach hour tiles. Negative input is clamped to 0.
function formatMinutes(totalMin) {
  const m = Math.max(0, Math.round(totalMin));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} min`;
  if (rem === 0) return `${h} h`;
  return `${h}h ${rem} min`;
}

// Combine a session doc's `date` (Timestamp on the calendar day, stored at
// noon by calendar.js's saveSession) with its `iceStart` "HH:MM" string to
// produce a real Date for the session's start. Falls back to the raw
// timestamp if iceStart is missing or malformed.
function sessionStartDate(session) {
  const base = session.date?.toDate ? session.date.toDate() : null;
  if (!base) return null;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const iceStart = session.iceStart || "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(iceStart);
  if (m) {
    start.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  } else {
    // No usable iceStart — keep the raw timestamp so we at least bucket by
    // calendar day correctly.
    return base;
  }
  return start;
}

function formatSessionTimeRange(session, lang) {
  const start = sessionStartDate(session);
  const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
  if (!start || !duration) return "—";
  const end = new Date(start.getTime() + duration * 60 * 1000);
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  const date = start.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const startTime = start.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const endTime = end.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${startTime}-${endTime}`;
}

function patchDatesForSession(session) {
  const base = session.date?.toDate ? session.date.toDate() : null;
  if (!base) return null;
  const sm = /^(\d{1,2}):(\d{2})$/.exec(session.iceStart || "");
  const em = /^(\d{1,2}):(\d{2})$/.exec(session.iceEnd || "");
  if (!sm || !em) return null;
  const start = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    parseInt(sm[1], 10),
    parseInt(sm[2], 10),
    0,
    0
  );
  const end = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    parseInt(em[1], 10),
    parseInt(em[2], 10),
    0,
    0
  );
  if (end <= start) return null;
  return { start, end };
}

function formatPatchTimeRange(patch, lang) {
  if (!patch?.start || !patch?.end) return "—";
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  const date = patch.start.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const startTime = patch.start.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const endTime = patch.end.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${startTime}-${endTime}`;
}

function closeCoachTimeWeekModal() {
  const modal = document.getElementById("coachTimeWeekModal");
  if (modal) modal.classList.remove("open");
}

function dollarsToCents(value) {
  const n = Number(String(value || "").trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function centsToMoney(cents) {
  return "$" + ((Number(cents) || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function loadAffiliateCoachConnections() {
  const snap = await getDocs(query(
    collection(db, "connections"),
    where("participants", "array-contains", dashboardUserId),
    where("status", "==", "accepted")
  ));
  const out = [];
  snap.forEach(d => {
    const data = d.data();
    const otherUid = data.participants.find(id => id !== dashboardUserId);
    const otherRoles = data.roles?.[otherUid] || [];
    if (otherRoles.includes("affiliateCoach")) {
      out.push({
        id: d.id,
        uid: otherUid,
        name: data.names?.[otherUid] || "—",
        availability: data.availability || "",
      });
    }
  });
  // Load subcoaches subcollection to resolve subcoachId for session queries
  let subcoachDocs = [];
  try {
    const scSnap = await getDocs(collection(db, "users", dashboardUserId, "subcoaches"));
    scSnap.forEach(d => subcoachDocs.push({ docId: d.id, ...d.data() }));
  } catch (_) {}

  await Promise.all(out.map(async (c) => {
    try {
      const uSnap = await getDoc(doc(db, "users", c.uid));
      c.availabilitySlots = uSnap.exists() ? (uSnap.data().availabilitySlots || []) : [];
    } catch (_) {
      c.availabilitySlots = [];
    }
    const match = subcoachDocs.find(sc => sc.uid === c.uid);
    c.subcoachDocId = match?.docId || null;
    c.subcoachFirstName = match?.firstName || "";
    c.subcoachLastName = match?.lastName || "";
    c.subcoachRateCents = Number(match?.rateCents) || 0;
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function renderSubCoachList() {
  const list = document.getElementById("subCoachList");
  if (!list || !dashboardUserId) return;
  const t = translations[getLang()] || {};
  const coaches = await loadAffiliateCoachConnections();
  if (!coaches.length) {
    list.innerHTML = `<div style="font-size:13px;color:#5E6C84;">${escapeHtml(t.noSubCoaches || "No affiliate coaches yet.")}</div>`;
    return;
  }
  list.innerHTML = "";
  coaches.forEach(c => {
    const card = document.createElement("div");
    card.className = "subcoach-card";
    card.style.cursor = "pointer";

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";
    info.innerHTML = `
      <div class="subcoach-name">${escapeHtml(c.name)}</div>
      <div class="subcoach-rate">${escapeHtml(t.affiliateCoach || "Affiliate coach")}</div>`;
    info.addEventListener("click", () => openAffiliateDetailModal(c));

    const removeBtn = document.createElement("button");
    removeBtn.className = "subcoach-delete";
    removeBtn.textContent = t.remove || "Remove";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`${t.removeAffiliateConfirm || "Remove"} ${c.name}?`)) return;
      try {
        await deleteDoc(doc(db, "connections", c.id));
        await renderSubCoachList();
      } catch (err) {
        console.error("Failed to remove affiliate:", err);
      }
    });

    const chevron = document.createElement("span");
    chevron.style.cssText = "color:#5E6C84;font-size:18px;line-height:1;margin-left:8px;";
    chevron.textContent = "›";
    chevron.addEventListener("click", () => openAffiliateDetailModal(c));

    card.appendChild(info);
    card.appendChild(removeBtn);
    card.appendChild(chevron);
    list.appendChild(card);
  });
}

function openSubCoachModal() {
  const modal = document.getElementById("subCoachModal");
  if (!modal) return;
  modal.classList.add("open");
  renderSubCoachList();
}

function closeSubCoachModal() {
  const modal = document.getElementById("subCoachModal");
  if (modal) modal.classList.remove("open");
}

// ---- AFFILIATE DETAIL CONTENT HELPERS ----

function resolveSessionAttendees(session) {
  const cache = _affiliateParticipantsCache || { skaters: [], parents: [], children: [] };
  const parentUids = new Set(cache.parents.map(p => p.uid));
  const names = [];
  (session.children || []).forEach(cid => {
    const c = cache.children.find(ch => ch.id === cid);
    const name = c ? c.name : (session.participantNames?.[cid] || null);
    if (name) names.push(name);
  });
  (session.participants || [])
    .filter(uid => uid !== dashboardUserId && !parentUids.has(uid))
    .forEach(uid => {
      const sk = cache.skaters.find(sk => sk.uid === uid);
      const name = sk ? sk.name : (session.participantNames?.[uid] || null);
      if (name && !names.includes(name)) names.push(name);
    });
  return names.length ? names.join(", ") : "—";
}


function renderAffiliateDetailContent(affiliate, sessions) {
  const container = document.getElementById("affiliateDetailContent");
  if (!container) return;
  const t = translations[getLang()] || {};
  const dayOrder = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const dayLabels = {
    monday: t.monday || "Monday", tuesday: t.tuesday || "Tuesday",
    wednesday: t.wednesday || "Wednesday", thursday: t.thursday || "Thursday",
    friday: t.friday || "Friday", saturday: t.saturday || "Saturday",
    sunday: t.sunday || "Sunday",
  };
  const sorted = (affiliate.availabilitySlots || []).slice().sort(
    (a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day)
  );
  container.innerHTML = "";
  if (!sorted.length) {
    container.innerHTML = `<div style="font-size:13px;color:#5E6C84;">${escapeHtml(t.noAvailabilitySet || "No availability set")}</div>`;
    return;
  }
  const claimedIds = new Set();
  sorted.forEach(slot => {
    const card = document.createElement("div");
    card.className = "dash-session-card";
    card.style.marginBottom = "10px";
    const header = document.createElement("div");
    header.className = "dash-session-card-top";
    const daySpan = document.createElement("span");
    daySpan.className = "dash-session-name";
    daySpan.textContent = dayLabels[slot.day] || slot.day;
    const timeSpan = document.createElement("span");
    timeSpan.className = "dash-session-time";
    timeSpan.textContent = `${slot.from} – ${slot.to}`;
    header.appendChild(daySpan);
    header.appendChild(timeSpan);
    card.appendChild(header);
    const daySessions = sessions.filter(s => {
      if (!s.date?.toDate) return false;
      const dayName = s.date.toDate().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
      return dayName === slot.day;
    });
    daySessions.forEach(s => claimedIds.add(s._id));
    if (daySessions.length) {
      daySessions.forEach(s => {
        const name = resolveSessionAttendees(s);
        const dur = s.duration ? `${s.duration} min` : "—";
        const dateStr = s.date.toDate().toLocaleDateString(getLang(), { month: "short", day: "numeric" });
        const row = document.createElement("div");
        row.className = "dash-session-meta";
        row.style.cssText = "display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid #F4F5F7;margin-top:4px;";
        row.innerHTML = `
          <span>${escapeHtml(name)} <span style="color:#8993A4;font-size:11px;">${escapeHtml(dateStr)}</span></span>
          <span style="font-weight:600;color:#172B4D;white-space:nowrap;margin-left:8px;">${escapeHtml(dur)}</span>`;
        card.appendChild(row);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "dash-session-meta";
      empty.style.cssText = "margin-top:4px;border-top:1px solid #F4F5F7;padding-top:4px;";
      empty.textContent = t.noSessionsFound || "No sessions booked";
      card.appendChild(empty);
    }
    container.appendChild(card);
  });
  const orphans = sessions.filter(s => !claimedIds.has(s._id));
  if (orphans.length) {
    const label = document.createElement("div");
    label.style.cssText = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#5E6C84;margin:8px 0 6px;";
    label.textContent = t.otherSessions || "Other sessions";
    container.appendChild(label);
    orphans.forEach(s => {
      const name = resolveSessionAttendees(s);
      const dur = s.duration ? `${s.duration} min` : "—";
      const dateStr = s.date?.toDate
        ? s.date.toDate().toLocaleDateString(getLang(), { weekday: "short", month: "short", day: "numeric" })
        : "—";
      const row = document.createElement("div");
      row.className = "dash-session-meta";
      row.style.cssText = "display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #F4F5F7;";
      row.innerHTML = `
        <span>${escapeHtml(name)} <span style="color:#8993A4;font-size:11px;">${escapeHtml(dateStr)}</span></span>
        <span style="font-weight:600;color:#172B4D;white-space:nowrap;margin-left:8px;">${escapeHtml(dur)}</span>`;
      container.appendChild(row);
    });
  }
}

async function openAffiliateDetailModal(affiliate) {
  const modal = document.getElementById("affiliateDetailModal");
  if (!modal) return;
  document.getElementById("affiliateDetailName").textContent = affiliate.name;
  const container = document.getElementById("affiliateDetailContent");
  if (container) container.innerHTML = `<div style="font-size:13px;color:#5E6C84;">Loading…</div>`;
  await loadAffiliateParticipants();
  modal.style.display = "flex";
  await reloadAffiliateDetailSessions(affiliate);
}

function closeAffiliateDetailModal() {
  const modal = document.getElementById("affiliateDetailModal");
  if (modal) modal.style.display = "none";
}

// ---- AFFILIATE SESSION MODAL ----

let _affiliateParticipantsCache = null;

async function loadAffiliateParticipants() {
  if (_affiliateParticipantsCache) return _affiliateParticipantsCache;
  const snap = await getDocs(query(
    collection(db, "connections"),
    where("participants", "array-contains", dashboardUserId),
    where("status", "==", "accepted")
  ));
  const users = [];
  const parentUids = [];
  snap.forEach(d => {
    const data = d.data();
    const otherUid = data.participants.find(id => id !== dashboardUserId);
    const roles = data.roles?.[otherUid] || [];
    users.push({ uid: otherUid, name: data.names?.[otherUid] || "—", kind: "user", roles });
    if (roles.includes("parent")) parentUids.push(otherUid);
  });
  const children = [];
  if (parentUids.length) {
    const chunks = [];
    for (let i = 0; i < parentUids.length; i += 30) chunks.push(parentUids.slice(i, i + 30));
    for (const chunk of chunks) {
      const childSnap = await getDocs(query(collection(db, "children"), where("parentId", "in", chunk)));
      childSnap.forEach(d => {
        const data = d.data();
        children.push({
          id: d.id,
          name: formatFullName({ firstName: data.firstName, lastName: data.lastName }),
          parentId: data.parentId,
          parentName: users.find(u => u.uid === data.parentId)?.name || "",
          kind: "child",
        });
      });
    }
  }
  _affiliateParticipantsCache = {
    skaters: users.filter(u => u.roles.includes("skater")),
    parents: users.filter(u => u.roles.includes("parent") && !u.roles.includes("skater")),
    children,
  };
  return _affiliateParticipantsCache;
}

async function reloadAffiliateDetailSessions(affiliate) {
  const container = document.getElementById("affiliateDetailContent");
  try {
    const now = new Date();
    const from = new Date(now); from.setFullYear(from.getFullYear() - 1);
    const to   = new Date(now); to.setDate(to.getDate() + 90);
    const snap = await getDocs(query(
      collection(db, "sessions"),
      where("coachUid", "==", dashboardUserId),
      where("date", ">=", Timestamp.fromDate(from)),
      where("date", "<=", Timestamp.fromDate(to))
    ));
    const sessions = [];
    snap.forEach(d => {
      const data = d.data();
      const byUid  = affiliate.uid && data.subcoachUid === affiliate.uid;
      const byName = !data.subcoachUid && affiliate.name && data.subcoachName === affiliate.name;
      if (byUid || byName) sessions.push({ _id: d.id, ...data });
    });
    sessions.sort((a, b) => (a.date?.seconds || 0) - (b.date?.seconds || 0));
    renderAffiliateDetailContent(affiliate, sessions);
  } catch (err) {
    if (container) container.innerHTML = `<div style="font-size:13px;color:#AE2A19;">Error loading sessions</div>`;
    console.error("reloadAffiliateDetailSessions failed:", err);
  }
}

// Splits a coach's sessions for the week into:
//   completed — minutes that have already elapsed (sessions fully in the past
//               plus the elapsed portion of any in-progress session).
//   upcoming  — minutes still to come (sessions fully in the future plus the
//               remaining portion of any in-progress session).
// Splitting an in-progress session matches the user's request that
// "hours coached this week" reflect the actual total up to right now.
// Splits the total session minutes in `sessions` into "completed" (already
// elapsed at `now`) and "upcoming" (still scheduled). In-progress sessions
// have their duration split at `now`.
//
// `multiplierFn(session) → number` lets callers scale each session's
// minutes — used to count private sessions as N×duration on the coach side
// (since the coach delivers N back-to-back privates) and as
// per-viewer-stake×duration on the parent side (a parent with 2 kids in
// one private gets credited 2×duration of coach time). Defaults to 1 so
// existing callers that just want raw minutes are unaffected.
function splitSessionsByNow(sessions, now, multiplierFn = () => 1) {
  let completed = 0;
  let upcoming = 0;
  for (const s of sessions) {
    const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
    if (!duration) continue;
    const start = sessionStartDate(s);
    if (!start) continue;
    const mult = Math.max(0, multiplierFn(s) || 0);
    if (mult === 0) continue;
    const scaled = duration * mult;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    if (end <= now) {
      completed += scaled;
    } else if (start >= now) {
      upcoming += scaled;
    } else {
      // In progress: split at `now`. The split happens on real elapsed
      // wall-clock time, so we compute it on raw duration first then
      // multiply both halves by `mult`.
      const elapsedMin = (now - start) / (60 * 1000);
      completed += elapsedMin * mult;
      upcoming += (duration - elapsedMin) * mult;
    }
  }
  return { completed, upcoming };
}

// Same completed/upcoming split as splitSessionsByNow, but operating on
// distinct ice patches instead of individual session bookings. A skater is
// on the ice for the full duration of any patch they have a session in,
// regardless of how short that session is — booking a 10-min lesson into a
// 1h patch still means the skater is at the rink for the whole hour.
//
// We collapse `sessions` to a unique set keyed by (date YYYY-MM-DD, iceStart,
// iceEnd) so multiple sessions in the same patch (e.g. back-to-back lessons
// with different coaches, group + private overlap) only count the patch
// once. Patch duration is computed from iceStart→iceEnd; sessions with
// missing or malformed times are skipped (we have no way to know how long
// they were on the ice).
function splitPatchesByNow(sessions, now) {
  const seen = new Map(); // key → { start: Date, durationMin: number }
  for (const s of sessions) {
    const base = s.date?.toDate ? s.date.toDate() : null;
    if (!base) continue;
    const iceStart = s.iceStart || "";
    const iceEnd   = s.iceEnd   || "";
    const sm = /^(\d{1,2}):(\d{2})$/.exec(iceStart);
    const em = /^(\d{1,2}):(\d{2})$/.exec(iceEnd);
    const dayKey = `${base.getFullYear()}-${base.getMonth()}-${base.getDate()}`;
    let start;
    let durationMin;
    let key;

    if (sm && em) {
      const startH = parseInt(sm[1], 10), startMin = parseInt(sm[2], 10);
      const endH   = parseInt(em[1], 10), endMin   = parseInt(em[2], 10);
      durationMin = (endH * 60 + endMin) - (startH * 60 + startMin);
      if (durationMin <= 0) continue;
      start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), startH, startMin, 0, 0);
      key = `${dayKey}|${iceStart}|${iceEnd}`;
    } else {
      start = sessionStartDate(s);
      durationMin = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
      if (!start || durationMin <= 0) continue;
      key = `${dayKey}|session|${start.getHours()}:${start.getMinutes()}|${durationMin}`;
    }

    if (seen.has(key)) continue;
    seen.set(key, { start, durationMin });
  }
  let completed = 0;
  let upcoming = 0;
  for (const { start, durationMin } of seen.values()) {
    const end = new Date(start.getTime() + durationMin * 60 * 1000);
    if (end <= now) {
      completed += durationMin;
    } else if (start >= now) {
      upcoming += durationMin;
    } else {
      const elapsedMin = (now - start) / (60 * 1000);
      completed += elapsedMin;
      upcoming += durationMin - elapsedMin;
    }
  }
  return { completed, upcoming };
}

function sessionInDateRange(session, start, end) {
  const date = session.date?.toDate ? session.date.toDate() : null;
  if (!date) return false;
  return date >= start && date <= end;
}

function childStakeForSession(session, childIdSet) {
  return (session.children || []).filter(cid => childIdSet.has(cid)).length;
}

function splitChildPatchesByNow(sessions, now, childIdSet) {
  const seen = new Map();
  for (const s of sessions) {
    const childIds = (s.children || []).filter(cid => childIdSet.has(cid));
    if (!childIds.length) continue;

    const base = s.date?.toDate ? s.date.toDate() : null;
    if (!base) continue;
    const iceStart = s.iceStart || "";
    const iceEnd = s.iceEnd || "";
    const sm = /^(\d{1,2}):(\d{2})$/.exec(iceStart);
    const em = /^(\d{1,2}):(\d{2})$/.exec(iceEnd);
    const dayKey = `${base.getFullYear()}-${base.getMonth()}-${base.getDate()}`;
    let start;
    let durationMin;
    let patchKey;

    if (sm && em) {
      const startH = parseInt(sm[1], 10), startMin = parseInt(sm[2], 10);
      const endH = parseInt(em[1], 10), endMin = parseInt(em[2], 10);
      durationMin = (endH * 60 + endMin) - (startH * 60 + startMin);
      if (durationMin <= 0) continue;
      start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), startH, startMin, 0, 0);
      patchKey = `${dayKey}|${iceStart}|${iceEnd}|${s.rink || ""}`;
    } else {
      start = sessionStartDate(s);
      durationMin = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
      if (!start || durationMin <= 0) continue;
      patchKey = `${dayKey}|session|${start.getHours()}:${start.getMinutes()}|${durationMin}|${s.rink || ""}`;
    }

    childIds.forEach(cid => {
      const key = `${cid}|${patchKey}`;
      if (!seen.has(key)) seen.set(key, { start, durationMin });
    });
  }

  let completed = 0;
  let upcoming = 0;
  for (const { start, durationMin } of seen.values()) {
    const end = new Date(start.getTime() + durationMin * 60 * 1000);
    if (end <= now) {
      completed += durationMin;
    } else if (start >= now) {
      upcoming += durationMin;
    } else {
      const elapsedMin = (now - start) / (60 * 1000);
      completed += elapsedMin;
      upcoming += durationMin - elapsedMin;
    }
  }
  return { completed, upcoming };
}

// Format a dollar amount as "$1,234.56". Negative input is clamped to 0.
// Kept simple — no currency-locale handling — so the tile always reads the
// same regardless of the user's UI language.
function formatMoney(amount) {
  const a = Math.max(0, Number(amount) || 0);
  return "$" + a.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dashboardTilesByKey(key) {
  return Array.from(document.querySelectorAll(`[id="tile-${key}"]`));
}

function writeDashboardTileValue(tile, text) {
  if (!tile) return;
  let valEl = tile.querySelector(".tile-value");
  if (!valEl) {
    valEl = document.createElement("p");
    valEl.className = "tile-value";
    tile.appendChild(valEl);
  }
  valEl.textContent = text;
}

function writeDashboardTileValues(key, text) {
  dashboardTilesByKey(key).forEach(tile => writeDashboardTileValue(tile, text));
}

async function loadViewerWeekSessions(uid, childIdSet, start, end) {
  const sessionsById = new Map();
  const sessionsRef = collection(db, "sessions");
  const addSessionSnap = (snap, assumeInRange = false) => {
    snap.forEach(d => {
      const session = { id: d.id, ...d.data() };
      if (assumeInRange || sessionInDateRange(session, start, end)) {
        sessionsById.set(d.id, session);
      }
    });
  };

  try {
    addSessionSnap(await getDocs(query(
      sessionsRef,
      where("participants", "array-contains", uid),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
    )), true);
  } catch (err) {
    console.warn("participant week session query failed, retrying without date range:", err);
    try {
      addSessionSnap(await getDocs(query(
        sessionsRef,
        where("participants", "array-contains", uid),
      )));
    } catch (fallbackErr) {
      console.warn("participant session query failed:", fallbackErr);
    }
  }

  const childIds = Array.from(childIdSet);
  for (let i = 0; i < childIds.length; i += 10) {
    const chunk = childIds.slice(i, i + 10);
    if (!chunk.length) continue;
    try {
      addSessionSnap(await getDocs(query(
        sessionsRef,
        where("children", "array-contains-any", chunk),
        where("date", ">=", Timestamp.fromDate(start)),
        where("date", "<=", Timestamp.fromDate(end)),
      )), true);
    } catch (err) {
      console.warn("child week session query failed, retrying without date range:", err);
      try {
        addSessionSnap(await getDocs(query(
          sessionsRef,
          where("children", "array-contains-any", chunk),
        )));
      } catch (fallbackErr) {
        console.warn("child session query failed:", fallbackErr);
      }
    }
  }

  return Array.from(sessionsById.values());
}

function formatTaxedMoneyCents(amountCents, paySettings) {
  const text = formatMoneyCents(amountCents, getLang());
  if (!paySettings || !paySettings.taxEnabled) return text;
  const t = translations[getLang()] || {};
  return `${text} ${t.taxIncluded || "Tax included"}`;
}

function formatTaxedMoney(amountCents, paySettings) {
  return formatTaxedMoneyCents(amountCents, paySettings);
}

function bookedMinutes(sessions) {
  return sessions.reduce((sum, s) => {
    const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
    return sum + duration;
  }, 0);
}

function bookedSessionAmount(session, fallbackHourly) {
  return sessionAmount(session, fallbackHourly);
}

function bookedSessionTotal(sessions, fallbackHourly) {
  return sessions.reduce((sum, s) => sum + bookedSessionAmount(s, fallbackHourly), 0);
}

// For PRIVATE sessions, each participant gets the full duration of the
// coach's attention individually — physically the coach delivers N back-to-back
// 20-min privates when 2 kids are booked into a "20-min private", so total
// coach time and total billable both scale by the attendee count. For GROUP
// (and any other type) sessions, the price covers the whole group so the
// multiplier stays at 1. Returns the count to multiply the per-session
// amount/duration by — never below 1, so a private with one skater behaves
// exactly the same as before.
function privateMultiplier(session) {
  const types = Array.isArray(session.type) ? session.type : [];
  if (!types.includes("private")) return 1;
  // attendeeCount is denormalized at write time as the count of skating
  // attendees (skater UIDs + child ids; coach + parents excluded). For
  // legacy sessions that lack it we reconstruct the same way skaterShareAmount
  // does as a fallback.
  if (typeof session.attendeeCount === "number" && session.attendeeCount > 0) {
    return session.attendeeCount;
  }
  const children = Array.isArray(session.children) ? session.children.length : 0;
  const participants = Array.isArray(session.participants) ? session.participants.length : 0;
  const reconstructed = children + Math.max(0, participants - 1);
  return Math.max(1, reconstructed || 1);
}

// Given a session, return its dollar value based on the per-session pricing
// the coach picked at booking time. Each session carries:
//   priceMode   — "hourly" (default) or "flat"
//   priceAmount — hourly rate when hourly, total session fee when flat
// Legacy sessions saved before per-session pricing existed have no
// priceMode/priceAmount; those fall back to "hourly" with the coach's
// current account-settings rate (passed in as `fallbackHourly`) so the
// dashboard stays meaningful for older bookings until they're re-saved.
//
// `prorate` (0..1) scales hourly earnings to a fraction of the session —
// used to charge in-progress sessions only for the elapsed minutes when
// computing billable, and the remaining minutes when computing planned.
// Flat fees are NOT prorated: a flat fee is charged once for the whole
// session regardless of how much has elapsed.
//
// PRIVATE multiplier: a private session with N skaters multiplies both
// hourly and flat amounts by N (each skater is effectively their own
// session). Group/off-ice/untyped sessions stay at ×1.
// Returns the session's value in dollars for the dashboard's local
// formatMoney(). fallbackHourly is the coach's hourly rate in DOLLARS
// (converted from paymentSettings.hourlyRate cents by the caller).
// session.priceAmount is stored in dollars by calendar.js.
function sessionAmount(session, fallbackHourly, prorate = 1) {
  const duration = (typeof session.duration === "number" && session.duration > 0)
    ? session.duration : 0;
  if (!duration) return 0;

  const explicitMode = session.priceMode === "hourly" || session.priceMode === "flat";
  const mode = explicitMode ? session.priceMode : "hourly";
  let amount = (typeof session.priceAmount === "number" && session.priceAmount > 0)
    ? session.priceAmount : 0;
  if (!amount && mode === "hourly") amount = fallbackHourly || 0;
  if (!amount) return 0;
  if (Number.isInteger(amount) && amount >= 1000) amount = amount / 100;

  const mult = privateMultiplier(session);
  if (mode === "flat") return amount * mult;
  const hours = duration / 60;
  return amount * hours * prorate * mult;
}

function isUnbilledSession(session) {
  return !session.invoiceId;
}

async function loadBillableDocs(sessions) {
  const userUids = new Set();
  const childIds = new Set();

  sessions.forEach(s => {
    (s.participants || []).forEach(uid => {
      if (uid !== s.coachUid) userUids.add(uid);
    });
    (s.children || []).forEach(cid => childIds.add(cid));
  });

  const userDocs = {};
  const childDocs = {};
  await Promise.all([
    ...[...userUids].map(async uid => {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) userDocs[uid] = snap.data();
      } catch (_) {}
    }),
    ...[...childIds].map(async cid => {
      try {
        const snap = await getDoc(doc(db, "children", cid));
        if (snap.exists()) childDocs[cid] = snap.data();
      } catch (_) {}
    }),
  ]);

  return { userDocs, childDocs };
}

function billableAttendeeCount(session, dirs) {
  let count = 0;
  (session.participants || []).forEach(uid => {
    if (uid === session.coachUid) return;
    const u = dirs.userDocs[uid];
    const roles = u && Array.isArray(u.rolesArray) ? u.rolesArray : [];
    const isSkaterUser = u && (roles.includes("skater") || roles.length === 0);
    const isParentOnly = u && roles.includes("parent") && !roles.includes("skater");
    if (u && isSkaterUser && !isParentOnly) count += 1;
  });
  (session.children || []).forEach(cid => {
    if (dirs.childDocs[cid]) count += 1;
  });
  return count;
}

function invoiceableSessionAmount(session, fallbackHourly, dirs) {
  const attendees = billableAttendeeCount(session, dirs);
  if (!attendees) return 0;

  const duration = (typeof session.duration === "number" && session.duration > 0)
    ? session.duration : 0;
  if (!duration) return 0;

  const mode = session.priceMode === "flat" ? "flat" : "hourly";
  let amount = (typeof session.priceAmount === "number" && session.priceAmount > 0)
    ? session.priceAmount : 0;
  if (!amount && mode === "hourly") amount = fallbackHourly || 0;
  if (!amount) return 0;
  if (Number.isInteger(amount) && amount >= 1000) amount = amount / 100;

  if (mode === "flat") return amount;
  return amount * (duration / 60) * attendees;
}

function splitInvoiceableByNow(sessions, fallbackHourly, now, dirs) {
  let billable = 0;
  let planned = 0;
  for (const s of sessions) {
    const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
    if (!duration) continue;
    const start = sessionStartDate(s);
    if (!start) continue;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const amount = invoiceableSessionAmount(s, fallbackHourly, dirs);
    if (end <= now) {
      billable += amount;
    } else if (start >= now) {
      planned += amount;
    }
  }
  return { billable, planned: billable + planned };
}

// Splits a coach's sessions into billable (already-elapsed earnings) and
// planned (still-to-come earnings) for the week. Mirrors the structure of
// splitSessionsByNow() so the two tiles stay aligned with the hour tiles.
// In-progress sessions split their hourly earnings proportionally; flat
// fees aren't split (the whole flat fee falls on the billable side once
// the session has started).
function splitEarningsByNow(sessions, fallbackHourly, now) {
  let billable = 0;
  let planned = 0;
  for (const s of sessions) {
    const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
    if (!duration) continue;
    const start = sessionStartDate(s);
    if (!start) continue;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const isFlat = s.priceMode === "flat";
    if (end <= now) {
      billable += sessionAmount(s, fallbackHourly, 1);
    } else if (start >= now) {
      planned += sessionAmount(s, fallbackHourly, 1);
    } else if (isFlat) {
      // In-progress flat-fee session: the coach is owed the whole fee now.
      billable += sessionAmount(s, fallbackHourly, 1);
    } else {
      // In-progress hourly session: split proportionally.
      const elapsedFrac = (now - start) / (duration * 60 * 1000);
      billable += sessionAmount(s, fallbackHourly, elapsedFrac);
      planned  += sessionAmount(s, fallbackHourly, 1 - elapsedFrac);
    }
  }
  return { billable, planned: billable + planned };
}

// Pulls the coach's sessions for the configured week and writes the totals
// into the two coach tiles. Called after renderDashboard so the tile DOM
// already exists. Errors are swallowed (logged) so a failed query just
// leaves the tiles showing the static label rather than breaking the page.
async function updateCoachHourTiles(uid, weekStartName) {
  const coachedTile  = document.getElementById("tile-hoursCoached");
  const upcomingTile = document.getElementById("tile-upcomingHours");
  const billableTile = document.getElementById("tile-billableEarnings");
  const plannedTile  = document.getElementById("tile-plannedEarnings");
  if (!coachedTile && !upcomingTile && !billableTile && !plannedTile) return; // user isn't a coach

  try {
    // Fetch the coach's hourly rate from paymentSettings.
    // paymentSettings.hourlyRate is stored in cents (by paymentSettings.js
    // via toCents()); divide by 100 to get dollars for sessionAmount().
    // Pricing moved from users/{uid}.pricing to paymentSettings/{uid} in
    // MP-117; userData.pricing is no longer populated.
    let fallbackHourly = 0;
    try {
      const psSnap = await getDoc(doc(db, "paymentSettings", uid));
      if (psSnap.exists()) {
        const rateCents = Number(psSnap.data().hourlyRate) || 0;
        fallbackHourly = rateCents / 100;
      }
    } catch (_) { /* no paymentSettings yet — fallback stays 0 */ }

    const { start, end } = getCurrentWeekRange(weekStartName);
    const q = query(
      collection(db, "sessions"),
      where("coachUid", "==", uid),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
    );
    const snap = await getDocs(q);
    const sessions = [];
    snap.forEach(d => sessions.push(d.data()));

    const now = new Date();
    const upcomingSessions = sessions.filter(s => {
      const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
      const start = sessionStartDate(s);
      if (!duration || !start) return false;
      const end = new Date(start.getTime() + duration * 60 * 1000);
      return end > now;
    });
    const completedSessions = sessions.filter(s => {
      const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
      const start = sessionStartDate(s);
      if (!duration || !start) return false;
      const end = new Date(start.getTime() + duration * 60 * 1000);
      return end <= now;
    });
    const totalMinutes = bookedMinutes(sessions);
    const upcoming = bookedMinutes(upcomingSessions);
    const billable = bookedSessionTotal(completedSessions, fallbackHourly);
    const planned = bookedSessionTotal(sessions, fallbackHourly);

    // Append a value <p> below the existing label <p>. Reusing an existing
    // .tile-value if present means a future re-render (e.g. language switch
    // that re-runs renderDashboard) won't accumulate stacked numbers.
    const writeValue = (tile, text) => {
      let valEl = tile.querySelector(".tile-value");
      if (!valEl) {
        valEl = document.createElement("p");
        valEl.className = "tile-value";
        tile.appendChild(valEl);
      }
      valEl.textContent = text;
    };

    if (coachedTile)  writeValue(coachedTile,  formatMinutes(totalMinutes));
    if (upcomingTile) writeValue(upcomingTile, formatMinutes(upcoming));
    if (billableTile) writeValue(billableTile, formatMoney(billable));
    if (plannedTile)  writeValue(plannedTile,  formatMoney(planned));
  } catch (err) {
    console.error("Failed to load coach hour totals:", err);
  }
}

// Pulls the coach's unbilled completed sessions and writes the count +
// total into the "Unbilled" tile (MP-121). Mirrors updateCoachHourTiles
// in shape: query in the background, swallow errors so a failed read
// just leaves the static label visible.
//
// "Unbilled" matches the same rule paymentGenerate.js applies:
//   coachUid == me  AND  invoiceId == null  AND  end-of-session < now
// We intentionally read this from the dashboard (instead of relying on
// a denormalized counter on the user doc) because:
//   1. It's the source of truth — no risk of drift between the tile and
//      the preview screen.
//   2. The query is cheap for a single coach's unbilled set.
//   3. There's no write path that would maintain a denormalized counter
//      cleanly without a Cloud Function (and v1 is intentionally
//      Cloud-Function-free).
//
// `pricing` here is the coach's account-settings pricing block, used as
// a legacy fallback for sessions that predate per-session priceMode/
// priceAmount. Same rule as updateCoachHourTiles.
async function updateUnbilledTile(uid) {
  const tile = document.getElementById("tile-unbilledInvoices");
  if (!tile) return; // user isn't a coach (or tile not rendered yet)

  try {
    // Fetch hourly rate from paymentSettings; divide cents→dollars for
    // sessionAmount() which works in dollars (dashboard's local formatMoney
    // also expects dollars, not cents).
    let paySettings = null;
    try {
      const psSnap = await getDoc(doc(db, "paymentSettings", uid));
      if (psSnap.exists()) {
        paySettings = psSnap.data();
      }
    } catch (_) { /* no paymentSettings yet — fallback stays 0 */ }

    const q = query(
      collection(db, "sessions"),
      where("coachUid", "==", uid),
    );
    const snap = await getDocs(q);

    const sessions = [];
    snap.forEach(d => {
      const s = d.data();
      if (isUnbilledSession(s)) sessions.push(s);
    });
    const billableDirs = await loadBillableDocs(sessions);

    // Reuse the coach-side billing math from splitEarningsByNow so the
    // tile total matches what paymentGenerate.js will show on the next
    // screen. We only count fully-completed sessions (end <= now) —
    // in-progress sessions don't make it into invoice generation either.
    const summary = buildDashboardUnbilledSummary(sessions, billableDirs, {
      paySettings,
      formatFullName,
      describeSession: () => "",
    });

    // Tile shows two lines under the label: count and total.
    // "X sessions · $YYY" mirrors the row-sub line on payment.html so
    // the visual pattern is consistent across the billing surface.
    const lang = getLang();
    const t = translations[lang];
    let valEl = tile.querySelector(".tile-value");
    if (!valEl) {
      valEl = document.createElement("p");
      valEl.className = "tile-value";
      tile.appendChild(valEl);
    }
    if (summary.sessionCount === 0) {
      valEl.textContent = t.unbilledNone || "All caught up";
      // Disable the click-through when there's nothing to bill — sending
      // a coach to an empty preview screen is a dead-end. Restoring the
      // href on next render covers the "they generated, came back" case.
      tile.dataset.href = "#";
      tile.style.cursor = "default";
      tile.style.opacity = "0.7";
    } else {
      const sessionsLabel = summary.sessionCount === 1
        ? (t.sessionSingular || "session")
        : (t.sessionPlural   || "sessions");
      valEl.textContent = `${summary.sessionCount} ${sessionsLabel} · ${formatTaxedMoney(summary.totalCents, paySettings)}`;
      tile.dataset.href = "paymentGenerate.html";
      tile.style.cursor = "pointer";
      tile.style.opacity = "";
    }
  } catch (err) {
    console.error("Failed to load unbilled total:", err);
  }
}

async function updateUnpaidInvoiceTile(uid) {
  const tiles = dashboardTilesByKey("newInvoice");
  if (!tiles.length) return;

  try {
    const q = query(collection(db, "invoices"), where("payerUid", "==", uid));
    const snap = await getDocs(q);

    let count = 0;
    const now = new Date();
    snap.forEach(d => {
      const inv = d.data();
      const displayStatus = payerInvoiceDisplayStatus(inv, now);
      if (displayStatus === "due" || displayStatus === "overdue") {
        count += 1;
      }
    });

    const lang = getLang();
    const t = translations[lang] || {};
    if (count === 0) {
      writeDashboardTileValues("newInvoice", t.noUnpaidInvoices || "No unpaid invoices");
    } else {
      const plural = count === 1
        ? (t.pgInvoiceSingular || "invoice")
        : (t.pgInvoicePlural || "invoices");
      writeDashboardTileValues("newInvoice", `${count} ${plural}`);
    }
  } catch (err) {
    console.error("Failed to load unpaid invoice count:", err);
  }
}

async function updateConnectionsTile(uid) {
  const tile = document.getElementById("tile-myConnections");
  if (!tile) return;

  try {
    const q = query(
      collection(db, "connections"),
      where("participants", "array-contains", uid)
    );
    const snap = await getDocs(q);

    let count = 0;
    snap.forEach(d => {
      const conn = d.data();
      if (conn.status === "pending" && conn.requestedTo === uid) count += 1;
    });

    const t = translations[getLang()] || {};
    const requestLabel = count === 1
      ? (t.pendingRequestSingular || "pending request")
      : (t.pendingRequestPlural || "pending requests");

    let valEl = tile.querySelector(".tile-value");
    if (!valEl) {
      valEl = document.createElement("p");
      valEl.className = "tile-value";
      tile.appendChild(valEl);
    }
    valEl.textContent = `${count} ${requestLabel}`;
  } catch (err) {
    console.error("Failed to load pending connection requests:", err);
  }
}

function payerInvoiceDisplayStatus(inv, now) {
  const rawStatus = inv?.status;
  const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (status !== "sent") return null;

  const dueAt = inv.dueAt;
  let dueDate = null;
  if (dueAt instanceof Timestamp) {
    dueDate = dueAt.toDate();
  } else if (dueAt) {
    const parsed = new Date(dueAt);
    if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
  }
  if (dueDate && dueDate.getTime() < now.getTime()) {
    return "overdue";
  }
  return "due";
}

// Splits a skater's sessions into balance (already owed) and projection
// (full week including upcoming) for the week. Mirrors splitEarningsByNow()
// but from the payer's perspective:
//   - The skater's share of a session is its priceAmount divided by the
//     number of participants on the session (group sessions split evenly).
//   - For "hourly" pricing the share is still per-skater of the hourly
//     total (rate × hours ÷ participants).
//   - In-progress hourly sessions split proportionally; in-progress flat
//     fees fall entirely on the balance side (the whole flat fee is owed
//     once the session has started, same as on the coach side).
//
// Sessions with no priceAmount on them yield $0 — unlike the coach side we
// can't fall back to an "hourly rate" because the skater doesn't own the
// pricing config; the coach who booked the session does. Modern sessions
// always carry priceAmount, so this only affects legacy data.
// Compute the viewer's share of one session's price for spending totals.
//
// `viewerStake` is how many of the session's *attendees* the viewer is
// responsible for paying for. Defaults to 1 (the most common case: a
// skater paying for their own slot). For a parent it's the count of
// their children in `session.children` plus 1 if their own UID is
// itself an attendee (rare — parent who's also a skater on the same
// session). The function multiplies stake into the per-attendee share.
//
// `prorate` is the fraction of the session's hourly time that should
// count (used for in-progress sessions split between balance and
// projection); ignored for flat-fee sessions.
function skaterShareAmount(session, prorate = 1, viewerStake = 1) {
  const duration = (typeof session.duration === "number" && session.duration > 0)
    ? session.duration : 0;
  if (!duration) return 0;

  const explicitMode = session.priceMode === "hourly" || session.priceMode === "flat";
  const mode = explicitMode ? session.priceMode : "hourly";
  const amount = (typeof session.priceAmount === "number" && session.priceAmount > 0)
    ? session.priceAmount
    : 0;
  if (!amount) return 0;
  if (viewerStake <= 0) return 0;

  // Split evenly across all *skating attendees* on the session. The split
  // count is denormalized onto the session as `attendeeCount` at write
  // time (calendar.js saveSession): skater UIDs + booked child ids, with
  // the coach and any parent UIDs explicitly excluded. This means a
  // private session (one skater) bills that skater the full price; a
  // group session of three skaters splits the price three ways.
  //
  // EXCEPTION — PRIVATE sessions: each attendee gets the coach's full
  // attention for the full duration (a "20-min private with 2 kids" is
  // really 2 back-to-back 20-min privates). So each attendee pays the
  // FULL price, not a 1/N share. We force splitBy=1 in that case.
  //
  // Fallbacks for legacy data, in priority order:
  //   1. session.attendeeCount when present (modern sessions).
  //   2. session.children.length + (participants.length - 1) — strips the
  //      coach and treats the rest as skaters. This over-counts when a
  //      pre-children-feature parent UID sits in participants alongside
  //      no children array, but it's the closest reconstruction we can
  //      do without role data on hand.
  //   3. participants.length when no other signal is available.
  //   4. 1 when the session is malformed (avoids divide-by-zero / Infinity).
  const sessTypes = Array.isArray(session.type) ? session.type : [];
  const isPrivate = sessTypes.includes("private");
  let splitBy;
  if (isPrivate) {
    splitBy = 1;
  } else if (typeof session.attendeeCount === "number" && session.attendeeCount > 0) {
    splitBy = session.attendeeCount;
  } else {
    const children = Array.isArray(session.children) ? session.children.length : 0;
    const participants = Array.isArray(session.participants) ? session.participants.length : 0;
    if (children > 0 || participants > 1) {
      splitBy = children + Math.max(0, participants - 1);
      if (splitBy === 0) splitBy = participants || 1;
    } else {
      splitBy = participants || 1;
    }
  }
  // Cap stake at total attendees — paranoia against bad data where the
  // viewer's stake somehow exceeds attendee count (would imply they're
  // paying for more skaters than the session has).
  //
  // For PRIVATE sessions splitBy is forced to 1, so capping at splitBy
  // would also collapse multi-kid stakes back to 1 and silently undo the
  // per-kid pricing. Instead cap private stakes at the real attendee
  // count, which lets a parent with 2 kids charge for both.
  let stakeCap;
  if (isPrivate) {
    if (typeof session.attendeeCount === "number" && session.attendeeCount > 0) {
      stakeCap = session.attendeeCount;
    } else {
      const children = Array.isArray(session.children) ? session.children.length : 0;
      const participants = Array.isArray(session.participants) ? session.participants.length : 0;
      stakeCap = Math.max(1, children + Math.max(0, participants - 1) || participants || 1);
    }
  } else {
    stakeCap = splitBy;
  }
  const stake = Math.min(viewerStake, stakeCap);

  if (mode === "flat") return (amount * stake) / splitBy;
  const hours = duration / 60;
  return (amount * hours * prorate * stake) / splitBy;
}

// Compute the viewer's stake for a single session. A "stake" is how many
// of the session's skating attendees the viewer is paying for:
//   - 1 if the viewer's own UID is in the session's participants AND the
//     viewer is a skater (their own slot).
//   - PLUS the number of children in session.children that belong to the
//     viewer (passed in as a Set of child ids).
// A pure parent-of-one ends up with stake 1 for their kid's session.
// A parent who is also a skater and has two kids in the same group
// session ends up with stake 3 (themselves + two children).
function viewerStakeForSession(session, viewerUid, viewerChildIdSet) {
  let stake = 0;
  // Self-as-attendee: only counts if the viewer is genuinely on the ice,
  // which we approximate by "their UID is in participants AND they are
  // not the coach." A parent whose UID is in participants only because
  // of their child contributes 0 here — their stake comes from the
  // children loop below.
  // We can't tell role from the session alone, so we under-count by
  // default: a parent will have stake 0 here (correct), but a skater
  // who is ALSO a parent on the same session would also count 0 (rare
  // enough to not warrant the extra read).
  // Practical workaround: if there are no children-of-viewer on this
  // session, the viewer must be a skater attendee themselves — count 1.
  const childMatches = (session.children || []).filter(cid => viewerChildIdSet.has(cid)).length;
  stake += childMatches;
  if (childMatches === 0) {
    // No children of the viewer on this session — the viewer's UID being
    // in participants means they're the skater attendee themselves.
    if ((session.participants || []).includes(viewerUid) && viewerUid !== session.coachUid) {
      stake += 1;
    }
  }
  return stake;
}

function splitSpendingByNow(sessions, now, viewerUid, viewerChildIdSet) {
  let balance = 0;
  let projection = 0;
  for (const s of sessions) {
    const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
    if (!duration) continue;
    const start = sessionStartDate(s);
    if (!start) continue;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const stake = viewerStakeForSession(s, viewerUid, viewerChildIdSet);
    if (stake === 0) continue;
    const fullAmount = skaterShareAmount(s, 1, stake);

    // Balance is the amount due for sessions fully in the past this week.
    // Projection is the full current-week total: past + upcoming.
    if (end <= now) balance += fullAmount;
    projection += fullAmount;
  }
  return { balance, projection };
}

// Whether a session counts as time on the ice patch. A session can have
// multiple types (private/group/off-ice) — it's "on ice" as long as at
// least one type indicates the skater is on the ice. A session typed
// purely "off-ice" is excluded from ice time but still counts toward
// time-with-coach.
//
// Be permissive about the shape of `session.type`:
//  - Modern sessions store it as an array: ["private"], ["group", "off-ice"], etc.
//  - Legacy / manually-seeded sessions may store it as a plain string ("private").
//  - Very old sessions may not have a type field at all — those are booked
//    against an ice patch in the calendar, so we treat the missing case as
//    on-ice rather than silently excluding them.
// Only sessions that are *exclusively* off-ice are excluded from ice time.
function isIceSession(session) {
  const raw = session.type;
  const types = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" && raw ? [raw] : []);
  if (types.length === 0) return true; // missing type → assume on-ice
  if (types.includes("private") || types.includes("group")) return true;
  return false;
}

// Pulls the skater's sessions for the configured week and writes totals
// into the six skater tiles:
//   iceTimeWeek       — minutes already spent on the ice this week
//   coachTimeWeek     — minutes already spent with a coach this week
//   iceTimeUpcoming   — minutes still scheduled on the ice this week
//   coachTimeUpcoming — minutes still scheduled with a coach this week
//   skaterBalance     — dollars owed for sessions completed/in-progress
//                       since the start of the week
//   skaterProjection  — balance plus dollars still scheduled this week
//
// "Ice time" reflects the full duration of the ice patches the skater is
// on (one 60-min patch counts as 60 min on the ice even if their session
// inside it is only 10 min — they're still at the rink for the hour).
// "Coach time" reflects actual session minutes, since a coach is only
// engaged for the booked portion of a patch.
//
// Pure off-ice sessions (isIceSession() === false) are excluded from the
// ice-patch totals but still contribute to coach totals AND to spending —
// the skater pays for time-with-coach regardless of where it happens.
//
// Like updateCoachHourTiles, errors are swallowed (logged) so a failed
// query just leaves the tiles labelled but unvalued, rather than
// breaking the page.
async function updateSkaterHourTiles(uid, weekStartName, roles = []) {
  const hasSkaterTiles = [
    "iceTimeWeek",
    "coachTimeWeek",
    "iceTimeUpcoming",
    "coachTimeUpcoming",
    "skaterBalance",
    "skaterProjection",
  ].some(key => dashboardTilesByKey(key).length > 0);
  if (!hasSkaterTiles) {
    return; // user isn't a skater
  }

  writeDashboardTileValues("iceTimeWeek",        formatMinutes(0));
  writeDashboardTileValues("coachTimeWeek",      formatMinutes(0));
  writeDashboardTileValues("iceTimeUpcoming",    formatMinutes(0));
  writeDashboardTileValues("coachTimeUpcoming",  formatMinutes(0));
  writeDashboardTileValues("skaterBalance",      formatMoney(0));
  writeDashboardTileValues("skaterProjection",   formatMoney(0));

  try {
    const { start, end } = getCurrentWeekRange(weekStartName);
    // Skaters' sessions are found by participant array membership — the
    // exact same query shape calendar.js's loadSessions uses for non-
    // coach roles, so any session a skater can see in their calendar
    // is counted here.
    // Load the viewer's children (if any) FIRST so both the spending math
    // and the coach-time multiplier below can use them. A skater-only viewer
    // comes back with an empty Set and falls through to "stake = 1 if I'm
    // in participants" inside viewerStakeForSession. The query is cheap
    // (parents typically have 1–3 children) and only runs once per
    // dashboard render.
    const childIdSet = new Set();
    try {
      const childrenSnap = await getDocs(
        query(collection(db, "children"), where("parentId", "==", uid))
      );
      childrenSnap.forEach(d => childIdSet.add(d.id));
    } catch (e) {
      // Non-fatal: a viewer with no parent role may not have read access
      // depending on rules. Falling through with empty Set is safe.
      console.warn("children read failed (non-fatal):", e);
    }

    const sessions = await loadViewerWeekSessions(uid, childIdSet, start, end);

    const now = new Date();
    const isParentViewer = Array.isArray(roles) && roles.includes("parent");
    // Coach time uses session durations directly — coaches are engaged
    // only for the booked minutes of a patch.
    //
    // PRIVATE multiplier from the viewer's side: a parent with 2 kids in
    // one private gets credited 2 × duration of coach time (each kid had
    // the coach's full attention for the duration). For non-private
    // sessions, or for a skater whose stake is just themselves, the
    // multiplier collapses to 1 — matching previous behavior.
    const viewerCoachTimeMult = (s) => {
      if (isParentViewer) return childStakeForSession(s, childIdSet);
      const types = Array.isArray(s.type) ? s.type : [];
      if (!types.includes("private")) return 1;
      // Stake = how many attendees of this session the viewer represents
      // (themselves if they're a skater attendee + their children on it).
      const stake = viewerStakeForSession(s, uid, childIdSet);
      return Math.max(1, stake);
    };
    const coachSplit = splitSessionsByNow(sessions, now, viewerCoachTimeMult);
    // Ice time uses patch durations, deduped across sessions sharing a
    // patch. Pure off-ice sessions are filtered first so they don't drag
    // an off-ice "patch" into the ice totals. NOT scaled by private —
    // there's still only one patch the kids are on, regardless of how
    // many privates the coach is delivering inside it.
    const iceSessions = sessions.filter(isIceSession);
    const iceSplit = isParentViewer
      ? splitChildPatchesByNow(iceSessions, now, childIdSet)
      : splitPatchesByNow(iceSessions, now);

    // Spending uses per-session amounts split evenly across attendees,
    // weighted by how many of those attendees the viewer pays for.
    // Every session the skater is in counts (off-ice included), since the
    // skater pays for time-with-coach regardless of where it happens.
    const spendSplit = splitSpendingByNow(sessions, now, uid, childIdSet);

    writeDashboardTileValues("iceTimeWeek",        formatMinutes(iceSplit.completed));
    writeDashboardTileValues("coachTimeWeek",      formatMinutes(coachSplit.completed));
    writeDashboardTileValues("iceTimeUpcoming",    formatMinutes(iceSplit.upcoming));
    writeDashboardTileValues("coachTimeUpcoming",  formatMinutes(coachSplit.upcoming));
    writeDashboardTileValues("skaterBalance",      formatMoney(spendSplit.balance));
    writeDashboardTileValues("skaterProjection",   formatMoney(spendSplit.projection));
  } catch (err) {
    console.error("Failed to load skater hour totals:", err);
  }
}

function collectPatchCards(sessions, timing, now, lang) {
  const seen = new Map();
  for (const session of sessions.filter(isIceSession)) {
    const patch = patchDatesForSession(session);
    if (!patch) continue;
    const base = session.date?.toDate ? session.date.toDate() : patch.start;
    const key = [
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      session.iceStart || "",
      session.iceEnd || "",
      session.rink || "",
    ].join("|");
    if (!seen.has(key)) {
      seen.set(key, { ...patch, rink: session.rink || "—" });
    }
  }
  const patches = [...seen.values()]
    .filter(patch => timing === "past" ? patch.end <= now : patch.start >= now)
    .sort((a, b) => timing === "past" ? b.start - a.start : a.start - b.start);

  return patches.map(patch => {
    const minutes = (patch.end - patch.start) / (60 * 1000);
    return `
      <div class="dash-session-card">
        <div class="dash-session-card-top">
          <div class="dash-session-name">${escapeHtml(patch.rink)}</div>
          <div class="dash-session-time">${escapeHtml(formatPatchTimeRange(patch, lang))}</div>
        </div>
        <div class="dash-session-meta">${escapeHtml(formatMinutes(minutes))}</div>
      </div>
    `;
  });
}

function collectSessionCards(sessions, timing, now, lang, t, childIdSet, childDocs, coachDocs, includePrice) {
  const selfName = formatFullName(dashboardUserData) || "—";
  const filtered = sessions
    .filter(session => {
      const start = sessionStartDate(session);
      const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
      if (!start || !duration) return false;
      const end = new Date(start.getTime() + duration * 60 * 1000);
      if (timing === "all") return true;
      return timing === "past" ? end <= now : start >= now;
    })
    .sort((a, b) => timing === "past"
      ? sessionStartDate(b).getTime() - sessionStartDate(a).getTime()
      : sessionStartDate(a).getTime() - sessionStartDate(b).getTime());

  return filtered.map(session => {
    const childNames = (session.children || [])
      .filter(cid => childIdSet.has(cid))
      .map(cid => formatFullName(childDocs.get(cid)) || "—");
    const isSelfSession = childNames.length === 0 && (session.participants || []).includes(dashboardUserId);
    const skaterName = childNames.length ? childNames.join(", ") : (isSelfSession ? selfName : "—");
    const coachName = session.subcoachName || formatFullName(coachDocs.get(session.coachUid)) || "—";
    const rink = session.rink || (Array.isArray(session.type) && session.type.includes("off-ice") ? (t.offIce || "Off-ice") : "—");
    const stake = viewerStakeForSession(session, dashboardUserId, childIdSet);
    const price = includePrice ? skaterShareAmount(session, 1, stake) : null;
    return `
      <div class="dash-session-card">
        <div class="dash-session-card-top">
          <div class="dash-session-name">${escapeHtml(skaterName)}</div>
          <div class="dash-session-time">${escapeHtml(formatSessionTimeRange(session, lang))}</div>
        </div>
        <div class="dash-session-meta">${escapeHtml(rink)}</div>
        <div class="dash-session-meta">${escapeHtml(coachName)}</div>
        ${includePrice ? `<div class="dash-session-meta">${escapeHtml(formatMoney(price))}</div>` : ""}
      </div>
    `;
  });
}

function coachSessionAttendeeNames(session, dirs) {
  const names = [];
  (session.children || []).forEach(cid => {
    const child = dirs.childDocs[cid];
    if (child) names.push(formatFullName(child) || "—");
  });
  (session.participants || []).forEach(uid => {
    if (uid === session.coachUid) return;
    const user = dirs.userDocs[uid];
    if (!user) return;
    const roles = Array.isArray(user.rolesArray) ? user.rolesArray : [];
    const isParentOnly = roles.includes("parent") && !roles.includes("skater");
    if (isParentOnly) return;
    names.push(formatFullName(user) || "—");
  });
  return names.length ? names.join(", ") : "—";
}

function collectCoachSessionCards(sessions, timing, now, lang, t, dirs, timeLabelKey) {
  const filtered = sessions
    .filter(session => {
      const start = sessionStartDate(session);
      const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
      if (!start || !duration) return false;
      const end = new Date(start.getTime() + duration * 60 * 1000);
      if (timing === "all") return true;
      return timing === "past" ? end <= now : start >= now;
    })
    .sort((a, b) => timing === "past"
      ? sessionStartDate(b).getTime() - sessionStartDate(a).getTime()
      : sessionStartDate(a).getTime() - sessionStartDate(b).getTime());

  const timeLabel = t[timeLabelKey] || (timing === "past" ? "coached" : "booked");
  return filtered.map(session => {
    const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
    const rink = session.rink || (Array.isArray(session.type) && session.type.includes("off-ice") ? (t.offIce || "Off-ice") : "—");
    return `
      <div class="dash-session-card">
        <div class="dash-session-card-top">
          <div class="dash-session-name">${escapeHtml(coachSessionAttendeeNames(session, dirs))}</div>
          <div class="dash-session-time">${escapeHtml(formatSessionTimeRange(session, lang))}</div>
        </div>
        <div class="dash-session-meta">${escapeHtml(rink)}</div>
        <div class="dash-session-meta">${escapeHtml(`${formatMinutes(duration)} ${timeLabel}`)}</div>
      </div>
    `;
  });
}

async function openCoachDashboardTileModal(kind) {
  const modal = document.getElementById("coachTimeWeekModal");
  const titleEl = document.getElementById("coachTimeWeekModalTitle");
  const listEl = document.getElementById("coachTimeWeekModalList");
  if (!modal || !titleEl || !listEl || !dashboardUserId || !dashboardUserData) return;

  const lang = getLang();
  const t = translations[lang] || {};
  const titles = {
    coachHoursPast: t.hoursCoachedDetails || t.hoursCoached || "Sessions coached this week",
    coachPatchesUpcoming: t.upcomingHoursDetails || t.upcomingHours || "Upcoming ice patches this week",
    coachPlannedEarnings: t.plannedEarningsDetails || t.plannedEarnings || "Upcoming booked sessions",
  };
  titleEl.textContent = titles[kind] || titles.coachHoursPast;
  listEl.innerHTML = `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.loading || "Loading..."}</p>`;
  modal.classList.add("open");

  try {
    const { start, end } = getCurrentWeekRange(dashboardUserData.weekStart);
    const snap = await getDocs(query(
      collection(db, "sessions"),
      where("coachUid", "==", dashboardUserId),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
    ));
    const sessions = [];
    snap.forEach(d => sessions.push({ id: d.id, ...d.data() }));

    const now = new Date();
    let cards = [];
    if (kind === "coachPatchesUpcoming") {
      cards = collectPatchCards(sessions, "upcoming", now, lang);
    } else {
      const timing = kind === "coachHoursPast" ? "past" : "upcoming";
      const sessionsForDocs = sessions.filter(session => {
        const startDate = sessionStartDate(session);
        const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
        if (!startDate || !duration) return false;
        const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
        return timing === "past" ? endDate <= now : startDate >= now;
      });
      const dirs = await loadBillableDocs(sessionsForDocs);
      cards = collectCoachSessionCards(
        sessionsForDocs,
        timing,
        now,
        lang,
        t,
        dirs,
        kind === "coachHoursPast" ? "timeCoachedLabel" : "timeBookedLabel"
      );
    }

    listEl.innerHTML = cards.length
      ? cards.join("")
      : `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.noSessionsForTile || "No sessions to show."}</p>`;
  } catch (err) {
    console.error("Failed to load coach dashboard tile modal:", err);
    listEl.innerHTML = `<p style="font-size:13px;color:#C9372C;margin:0;">${t.loadFailed || "Could not load data. Please refresh."}</p>`;
  }
}

async function openDashboardTileModal(kind) {
  const modal = document.getElementById("coachTimeWeekModal");
  const titleEl = document.getElementById("coachTimeWeekModalTitle");
  const listEl = document.getElementById("coachTimeWeekModalList");
  if (!modal || !titleEl || !listEl || !dashboardUserId || !dashboardUserData) return;

  const lang = getLang();
  const t = translations[lang] || {};
  const titles = {
    coachPast: t.coachTimeWeekDetails || t.coachTimeWeek || "Past sessions this week",
    icePast: t.iceTimeWeekDetails || t.iceTimeWeek || "Past ice patches this week",
    iceUpcoming: t.iceTimeUpcomingDetails || t.iceTimeUpcoming || "Upcoming ice patches this week",
    coachUpcoming: t.coachTimeUpcomingDetails || t.coachTimeUpcoming || "Upcoming sessions this week",
    balance: t.skaterBalance || "Balance owed this week",
    projection: t.skaterProjectionDetails || t.skaterProjection || "Upcoming session prices",
  };
  titleEl.textContent = titles[kind] || titles.coachPast;
  listEl.innerHTML = `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.loading || "Loading..."}</p>`;
  modal.classList.add("open");

  try {
    const { start, end } = getCurrentWeekRange(dashboardUserData.weekStart);
    const snap = await getDocs(query(
      collection(db, "sessions"),
      where("participants", "array-contains", dashboardUserId),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
    ));
    const sessions = [];
    snap.forEach(d => sessions.push({ id: d.id, ...d.data() }));

    const childDocs = new Map();
    const childIdSet = new Set();
    try {
      const childSnap = await getDocs(query(collection(db, "children"), where("parentId", "==", dashboardUserId)));
      childSnap.forEach(d => {
        childDocs.set(d.id, { id: d.id, ...d.data() });
        childIdSet.add(d.id);
      });
    } catch (err) {
      console.warn("children read failed for dashboard tile modal:", err);
    }

    const ownedSessions = sessions.filter(s => viewerStakeForSession(s, dashboardUserId, childIdSet) > 0);
    const now = new Date();
    let cards = [];

    if (kind === "icePast" || kind === "iceUpcoming") {
      cards = collectPatchCards(ownedSessions, kind === "icePast" ? "past" : "upcoming", now, lang);
    } else {
      const timing = kind === "projection" ? "all" : (kind === "balance" || kind === "coachPast" ? "past" : "upcoming");
      const sessionsForCards = ownedSessions.filter(session => {
        const startDate = sessionStartDate(session);
        const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
        if (!startDate || !duration) return false;
        if (kind === "projection") return true;
        const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
        return timing === "past" ? endDate <= now : startDate >= now;
      });
      const coachIds = [...new Set(sessionsForCards.map(s => s.coachUid).filter(Boolean))];
      const coachDocs = new Map();
      await Promise.all(coachIds.map(async uid => {
        try {
          const coachSnap = await getDoc(doc(db, "users", uid));
          if (coachSnap.exists()) coachDocs.set(uid, coachSnap.data());
        } catch {}
      }));
      cards = collectSessionCards(sessionsForCards, timing, now, lang, t, childIdSet, childDocs, coachDocs, kind === "projection" || kind === "balance");
    }

    listEl.innerHTML = cards.length
      ? cards.join("")
      : `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.noSessionsForTile || t.noPastCoachSessions || "No sessions to show."}</p>`;
  } catch (err) {
    console.error("Failed to load dashboard tile modal:", err);
    listEl.innerHTML = `<p style="font-size:13px;color:#C9372C;margin:0;">${t.loadFailed || "Could not load data. Please refresh."}</p>`;
  }
}

async function openCoachTimeWeekModal() {
  const modal = document.getElementById("coachTimeWeekModal");
  const titleEl = document.getElementById("coachTimeWeekModalTitle");
  const listEl = document.getElementById("coachTimeWeekModalList");
  if (!modal || !listEl || !dashboardUserId || !dashboardUserData) return;

  const lang = getLang();
  const t = translations[lang] || {};
  titleEl.textContent = t.coachTimeWeekDetails || t.coachTimeWeek || "Time with coach this week";
  listEl.innerHTML = `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.loading || "Loading..."}</p>`;
  modal.classList.add("open");

  try {
    const { start, end } = getCurrentWeekRange(dashboardUserData.weekStart);
    const snap = await getDocs(query(
      collection(db, "sessions"),
      where("participants", "array-contains", dashboardUserId),
      where("date", ">=", Timestamp.fromDate(start)),
      where("date", "<=", Timestamp.fromDate(end)),
    ));
    const sessions = [];
    snap.forEach(d => sessions.push({ id: d.id, ...d.data() }));

    const childDocs = new Map();
    const childIdSet = new Set();
    try {
      const childSnap = await getDocs(query(collection(db, "children"), where("parentId", "==", dashboardUserId)));
      childSnap.forEach(d => {
        childDocs.set(d.id, { id: d.id, ...d.data() });
        childIdSet.add(d.id);
      });
    } catch (err) {
      console.warn("children read failed for coach-time modal:", err);
    }

    const now = new Date();
    const pastSessions = sessions
      .filter(s => {
        const startDate = sessionStartDate(s);
        const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
        if (!startDate || !duration) return false;
        const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
        return endDate <= now && viewerStakeForSession(s, dashboardUserId, childIdSet) > 0;
      })
      .sort((a, b) => sessionStartDate(b).getTime() - sessionStartDate(a).getTime());

    const coachIds = [...new Set(pastSessions.map(s => s.coachUid).filter(Boolean))];
    const coachDocs = new Map();
    await Promise.all(coachIds.map(async uid => {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) coachDocs.set(uid, snap.data());
      } catch {}
    }));

    if (!pastSessions.length) {
      listEl.innerHTML = `<p style="font-size:13px;color:#5E6C84;margin:0;">${t.noPastCoachSessions || "No past sessions this week."}</p>`;
      return;
    }

    const selfName = formatFullName(dashboardUserData) || "—";
    listEl.innerHTML = pastSessions.map(session => {
      const childNames = (session.children || [])
        .filter(cid => childIdSet.has(cid))
        .map(cid => formatFullName(childDocs.get(cid)) || "—");
      const isSelfSession = childNames.length === 0 && (session.participants || []).includes(dashboardUserId);
      const skaterName = childNames.length ? childNames.join(", ") : (isSelfSession ? selfName : "—");
      const coachName = session.subcoachName || formatFullName(coachDocs.get(session.coachUid)) || "—";
      const rink = session.rink || (Array.isArray(session.type) && session.type.includes("off-ice") ? (t.offIce || "Off-ice") : "—");
      return `
        <div class="dash-session-card">
          <div class="dash-session-card-top">
            <div class="dash-session-name">${escapeHtml(skaterName)}</div>
            <div class="dash-session-time">${escapeHtml(formatSessionTimeRange(session, lang))}</div>
          </div>
          <div class="dash-session-meta">${escapeHtml(rink)}</div>
          <div class="dash-session-meta">${escapeHtml(coachName)}</div>
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error("Failed to load coach-time sessions:", err);
    listEl.innerHTML = `<p style="font-size:13px;color:#C9372C;margin:0;">${t.loadFailed || "Could not load data. Please refresh."}</p>`;
  }
}

// ---------------- RENDER DASHBOARD ----------------
function renderDashboard(userData) {
  const lang = getLang();
  const t = translations[lang];
  const roles = userData.rolesArray;
  const container = document.getElementById("tiles-container");
  container.innerHTML = "";
  container.style.width = "100%"; // ensure rows fill the box

  // --- Top row: "My connections" and "Schedule", outside of any role section
  // Both are universal: every role uses the same calendar page and has its
  // own connections workflow, so showing them once at the top avoids the
  // duplication that used to happen for multi-role users.
  const hasConnectionsRole = roles.some(r => ["coach", "affiliateCoach", "skater", "parent", "admin"].includes(r));
  if (hasConnectionsRole) {
    const row = document.createElement("div");
    row.className = "row";
    const canManageCoaches = roles.includes("coach") && !!userData.managesCoaches;

    const buildTopTile = (def) => {
      const tile = document.createElement("div");
      tile.className = "dashboard-tile";
      tile.id = `tile-${def.labelKey}`;
      tile.dataset.href = def.href;
      tile.style.borderColor = def.color;
      tile.innerHTML = `<p>${t[def.labelKey] || def.labelKey}</p>`;
      tile.addEventListener("click", (e) => {
        if (def.labelKey === "coachManagement") {
          openSubCoachModal();
          return;
        }
        const href = e.currentTarget.dataset.href;
        if (href && href !== "#") window.location.href = href;
      });
      return tile;
    };

    row.appendChild(buildTopTile(CONNECTIONS_TILE));
    if (canManageCoaches) row.appendChild(buildTopTile(COACH_MANAGEMENT_TILE));
    row.appendChild(buildTopTile(SCHEDULE_TILE));

    container.appendChild(row);

    const spacer = document.createElement("div");
    spacer.style.height = "12px";
    container.appendChild(spacer);
  }

  roles.forEach(role => {
    if (role === "affiliateCoach" && roles.includes("coach")) return;
    const section = ROLE_SECTIONS[role];
    if (!section) return;

    // Section header. Always shown (even for single-role users) so the
    // "Coaching" / "Skating" / "Parent" / "Administrator" label with its
    // bottom border acts as a visual separator between the top-level
    // "My connections" tile and the role-specific tiles below.
    const header = document.createElement("div");
    header.className = "section-header";
    header.textContent = t[section.labelKey] || section.labelKey;
    container.appendChild(header);

    const tileKeys = section.tiles;

    // Build a tile DOM element from a key. Pulled out of the loop below
    // so both the normal pair-per-row branch and the fullWidth single-
    // tile-per-row branch share one place to construct/wire the tile.
    const buildTile = (key) => {
      const def = TILE_DEFINITIONS[key];
      if (!def) return null;
      const tile = document.createElement("div");
      tile.className = "dashboard-tile";
      tile.id = `tile-${key}`;
      tile.dataset.href = def.href;
      tile.style.borderColor = def.color;
      tile.innerHTML = `<p>${t[def.labelKey] || def.labelKey}</p>`;
      tile.addEventListener("click", (e) => {
        const modalKindByTile = {
          hoursCoached: "coachHoursPast",
          upcomingHours: "coachPatchesUpcoming",
          plannedEarnings: "coachPlannedEarnings",
          iceTimeWeek: "icePast",
          coachTimeWeek: "coachPast",
          iceTimeUpcoming: "iceUpcoming",
          coachTimeUpcoming: "coachUpcoming",
          skaterBalance: "balance",
          skaterProjection: "projection",
        };
        if (modalKindByTile[key]) {
          if (key === "hoursCoached" || key === "upcomingHours" || key === "plannedEarnings") {
            openCoachDashboardTileModal(modalKindByTile[key]);
          } else {
            openDashboardTileModal(modalKindByTile[key]);
          }
          return;
        }
        const href = e.currentTarget.dataset.href;
        if (href && href !== "#") window.location.href = href;
      });
      return tile;
    };

    // Walk the section's tile list. fullWidth tiles get their own row;
    // everything else is paired two-at-a-time as before. We advance `i`
    // by 1 for fullWidth tiles and by 2 for normal pairs so a fullWidth
    // tile can appear anywhere in the list (start, middle, end) without
    // breaking the 2-up grid for its neighbors.
    let i = 0;
    while (i < tileKeys.length) {
      const key = tileKeys[i];
      const def = key ? TILE_DEFINITIONS[key] : null;

      const row = document.createElement("div");
      row.className = "row";

      if (def && def.fullWidth) {
        const tile = buildTile(key);
        if (tile) row.appendChild(tile);
        i += 1;
      } else {
        // Normal pair-per-row. If the second slot in the pair is itself
        // a fullWidth tile, leave it for the next iteration so it gets
        // its own row instead of being squeezed alongside a normal one.
        const nextKey = tileKeys[i + 1];
        const nextDef = nextKey ? TILE_DEFINITIONS[nextKey] : null;
        const nextIsFull = !!(nextDef && nextDef.fullWidth);

        [key, nextIsFull ? null : nextKey].forEach(k => {
          if (!k) {
            // Invisible placeholder so a lone tile doesn't stretch
            // full-width by accident.
            const placeholder = document.createElement("div");
            placeholder.style.flex = "1";
            row.appendChild(placeholder);
            return;
          }
          const tile = buildTile(k);
          if (tile) row.appendChild(tile);
        });
        i += nextIsFull ? 1 : 2;
      }

      container.appendChild(row);

      const spacer = document.createElement("div");
      spacer.style.height = "12px";
      container.appendChild(spacer);
    }
  });
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  document.getElementById("coachTimeWeekModalClose")?.addEventListener("click", closeCoachTimeWeekModal);
  document.getElementById("coachTimeWeekModal")?.addEventListener("click", (e) => {
    if (e.target.id === "coachTimeWeekModal") closeCoachTimeWeekModal();
  });
  document.getElementById("subCoachModalClose")?.addEventListener("click", closeSubCoachModal);
  document.getElementById("subCoachModal")?.addEventListener("click", (e) => {
    if (e.target.id === "subCoachModal") closeSubCoachModal();
  });
  document.getElementById("affiliateDetailClose")?.addEventListener("click", closeAffiliateDetailModal);
  document.getElementById("affiliateDetailModal")?.addEventListener("click", (e) => {
    if (e.target.id === "affiliateDetailModal") closeAffiliateDetailModal();
  });

  authGuard([], (user, userData) => {
    dashboardUserId = user.uid;
    dashboardUserData = userData;
    const lang = getLang();
    const t = translations[lang];

    // Welcome message
    const title = document.getElementById("welcome-title");
    if (title) {
      const welcomeText = t["WelcomeToDashboard"] || "Welcome to your dashboard";
      title.textContent = `${welcomeText}, ${userData.firstName || ""}`;
    }

    renderDashboard(userData);
    initNav("dashboard.html");
    injectNotificationBell(user.uid);
    updateConnectionsTile(user.uid);

    // Coaches get the live hour totals queried in the background. Skipped
    // entirely for non-coaches so we don't fire a Firestore query whose
    // result has no tile to populate.
    const roles = userData.rolesArray || [];
    if (hasCoachRole(roles)) {
      updateCoachHourTiles(user.uid, userData.weekStart);
      // MP-121: unbilled tile updates independently of the week-bounded
      // hour tiles because "unbilled" is a lifetime-cumulative bucket,
      // not a this-week one. Fired in parallel; both write to different
      // tiles so there's no ordering concern.
      updateUnbilledTile(user.uid);
    }
    // Skaters get their own four-tile breakdown (ice/coach × completed/
    // upcoming). Same skip-if-not-relevant guard as the coach branch.
    if (roles.includes("skater") || roles.includes("parent")) {
      updateSkaterHourTiles(user.uid, userData.weekStart, roles);
      updateUnpaidInvoiceTile(user.uid);
    }
  });
});
