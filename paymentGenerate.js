// paymentGenerate.js — Coach "Generate invoices" preview + commit (MP-121)
//
// Three phases:
//   1. Read    — query unbilled completed sessions, hydrate names, group by
//                skater, compute totals (incl. tax if enabled).
//   2. Review  — render one card per group; let the coach toggle each on/off
//                and expand for line items.
//   3. Commit  — for each selected group, run a Firestore transaction that:
//                  a) reads /system/invoices (the global counter) to
//                     allocate the next number
//                  b) re-reads every session to confirm invoiceId is still
//                     null (anti-race: another tab/device might have already
//                     invoiced one of them since we loaded the preview)
//                  c) writes the invoice, the invoice_items, the counter
//                     update (lastIssued + 1), and patches each
//                     session.invoiceId
//                Each draft is its own transaction so a single contention
//                failure doesn't roll back drafts that already succeeded.
//
// Counter contract (matches firestore.rules MP-115):
//   - Path:  /system/invoices
//   - Shape: { lastIssued: <int> } — last number that was issued. The
//            very first invoice ever is INV-000001, written when the
//            doc transitions from {lastIssued:0} to {lastIssued:1}.
//   - Init:  the doc must EXIST with lastIssued=0 before the first
//            transaction so the rule's `update` branch can match. We
//            seed it once with a setDoc({lastIssued:0}) outside any
//            transaction; the rules `create` branch accepts that exact
//            shape and rejects everything else.
//
// Skater identity (matches MP-115's invoice schema validator):
//   skaterUid   — REQUIRED string. For user-skaters: the skater's UID;
//                 for children: the child id. Single carrier so the
//                 rules' `d.skaterUid is string` validation passes.
//   skaterRef   — "users/<uid>" or "children/<id>" — the type
//                 discriminator. Used by code (detail page, list page);
//                 the rules don't currently inspect it.
//   skaterName  — denormalized full name string so list views don't
//                 have to join back to users/children to render rows.
//   payerUid    — the user UID who pays (skater themselves for user-
//                 skaters, parent for children).
//   payerName   — denormalized full name for "via [parent]" rendering.
//                 null for self-pay.
//
// "Unbilled" definition (per Q1): a session is unbilled when
//   coachUid == me  AND  invoiceId == null  AND  end-of-session < now
// "End of session" is `date + duration` because the schedule stores the start
// timestamp and duration separately (see calendar.js saveSession).

import {
  auth, db, getLang, applyLanguage, authGuard, initNav, translations,
  formatFullName, escapeHtml, hasCoachRole,
} from "./app.js";
import { injectNotificationBell } from "./notifications.js";
import {
  collection, query, where, getDocs, doc, getDoc, setDoc, runTransaction,
  serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  toCents, formatMoney, addAmounts, multiplyAmount, calculateTaxTotals,
} from "./money.js";
import {
  isCompletedUnbilledSession,
} from "./invoiceTotals.js";

// ── State ────────────────────────────────────────────────────────────────────

let currentUser    = null;
let currentUserData = null;
let currentRoles   = [];
let paySettings    = null;   // paymentSettings doc for this coach
let groups         = [];     // [{ key, kind, skaterId, skaterName, payerUid,
                              //    sessions, items, subtotalCents, gstCents,
                              //    qstCents, totalCents, selected, expanded }]

// ── Helpers ──────────────────────────────────────────────────────────────────

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

// Read the priceMode/priceAmount off a session. Modern sessions store
// priceAmount in dollars; a few legacy/default paths may already carry cents
// (1500 for $15), so normalize to cents before doing invoice math.
function readSessionPricing(s) {
  const explicit = s.priceMode === "hourly" || s.priceMode === "flat";
  const mode = explicit ? s.priceMode : "hourly";
  const amount = (typeof s.priceAmount === "number" && s.priceAmount > 0)
    ? s.priceAmount
    : 0;
  const amountCents = amount
    ? (Number.isInteger(amount) && amount >= 1000 ? amount : toCents(amount))
    : 0;
  return { mode, amountCents };
}

function isPrivateSession(session) {
  const types = Array.isArray(session.type) ? session.type : [];
  return types.includes("private");
}

// Compute line-total in cents for a single session attended by this skater.
// We charge ONE attendee's share regardless of how many other skaters were
// on the same session — invoices are per-skater, so a 60-minute group
// session at $90 with 3 skaters yields a $30 line on each skater's invoice.
//
// HOURLY: rate × hours, in cents, banker's-rounded.
// FLAT:   total session fee ÷ attendeeCount, banker's-rounded.
//
// We deliberately do NOT apply privateMultiplier here. dashboard.js uses
// the multiplier to inflate a single coach's hourly earnings ("a private
// with 2 kids = 2× the coach's billable time"), but on the invoice side
// each skater is billed for THEIR session — so a private at $80/h with 2
// kids becomes a $80/h line on each kid's separate invoice, not a $160
// line. The multiplier is a coach-side accounting artifact.
function computeLineCents(session) {
  const { mode, amountCents } = readSessionPricing(session);
  if (!amountCents) return 0;
  const duration = (typeof session.duration === "number" && session.duration > 0)
    ? session.duration : 0;
  if (!duration) return 0;
  const attendeeCount = (typeof session.attendeeCount === "number" && session.attendeeCount > 0)
    ? session.attendeeCount : 1;
  const splitBy = isPrivateSession(session) ? 1 : attendeeCount;

  if (mode === "flat") {
    // Flat fee divided across the session's skating attendees. Per-skater
    // share is the rounded result; tiny sub-cent differences across
    // skaters are accepted (no "remainder skater" gets the leftover cent).
    return multiplyAmount(amountCents, 1 / splitBy);
  }
  // Hourly: rate × hours, split across attendees for group sessions.
  const hours = duration / 60;
  return multiplyAmount(amountCents, hours / splitBy);
}

// Build one InvoiceItem-shaped object per session. These match the schema
// in payment_firestore_schema_erd.html (sessionId, sessionDate,
// durationMinutes, priceMode, priceAmount in cents, attendeeCount,
// lineTotal, description). The description is built client-side so the
// detail page (MP-124) doesn't have to format it again.
function buildItem(session, lineCents, childLabel) {
  const { mode, amountCents } = readSessionPricing(session);
  return {
    sessionId:       session.id,
    sessionDate:     session.date || null,
    iceStart:        session.iceStart || null,
    iceEnd:          session.iceEnd   || null,
    subcoachName:    session.subcoachName || null,
    durationMinutes: session.duration || 0,
    priceMode:       mode,
    priceAmount:     amountCents,
    attendeeCount:   session.attendeeCount || 1,
    lineTotal:       lineCents,
    description:     childLabel ? `${childLabel} · ${describeSession(session)}` : describeSession(session),
  };
}

// "Apr 18 · Private 60 min" / "18 avr. · Privé 60 min". Used in the
// preview line items and stored on the InvoiceItem so future renders
// (detail page, PDF export) read it as-is.
function describeSession(session) {
  const lang = getLang();
  const dateStr = session.date && session.date.toDate
    ? session.date.toDate().toLocaleDateString(
        lang === "fr" ? "fr-CA" : "en-US",
        { month: "short", day: "numeric" }
      )
    : "—";
  // Pick the most specific type for the description. A session can carry
  // multiple types (private + group is rare but legal); we prefer
  // private > group > off-ice for the label since that's the order that
  // matters for billing context.
  const types = Array.isArray(session.type) ? session.type : [];
  let typeKey = "sessionTypeOther";
  if (types.includes("private"))      typeKey = "sessionTypePrivate";
  else if (types.includes("group"))   typeKey = "sessionTypeGroup";
  else if (types.includes("off-ice")) typeKey = "sessionTypeOffIce";
  const typeLabel = t(typeKey);
  const minLabel  = t("minutes") || "min";
  return `${dateStr} · ${typeLabel} ${session.duration || 0} ${minLabel}`;
}

// ── Phase 1: read + group ────────────────────────────────────────────────────

// Pull every session belonging to this coach with no invoiceId. We can't
// add `where("date", "<", now)` to the same query as `where("invoiceId",
// "==", null)` without a composite index; instead we filter past-only in
// memory. The total set is bounded by what one coach has booked, so
// in-memory filtering is fine.
async function loadUnbilledSessions(coachUid) {
  const q = query(
    collection(db, "sessions"),
    where("coachUid", "==", coachUid),
    where("invoiceId", "==", null),
  );
  const snap = await getDocs(q);
  const now = new Date();
  const out = [];
  snap.forEach(d => {
    const data = d.data();
    const session = { id: d.id, ...data };
    if (!isCompletedUnbilledSession(session, now)) return;
    out.push(session);
  });
  return out;
}

// Fetch the coach's paymentSettings doc. Returns null if the doc doesn't
// exist yet — caller treats that as "no tax, default 14-day net" so invoice
// generation works on a fresh account. Network/permission errors propagate
// to the caller (outer authGuard try/catch) so the page shows "load failed"
// rather than silently generating invoices with wrong rates.
async function loadPaymentSettings(coachUid) {
  const ref = doc(db, "paymentSettings", coachUid);
  const s = await getDoc(ref);
  return s.exists() ? s.data() : null;
}

// Resolve names + payer UIDs for every distinct skater across the unbilled
// sessions. A "skater" on a session can be either:
//   - a user UID in `participants` (excluding the coach + parents)
//   - a child id in `children`
// We dedupe before fetching so two sessions with the same skater = 1 read.
//
// For child rows we ALSO need to look up the parent (children.parentId)
// because the parent is the payer. We dedupe parents the same way.
async function resolveSkatersAndPayers(sessions) {
  const userUids = new Set();
  const childIds = new Set();

  // First pass: figure out each session's skater list. Same rule used by
  // calendar.js / dashboard.js: skaters = participants minus the coach
  // minus parent-of-children entries. Parents are in participants for
  // visibility but never as billable attendees.
  sessions.forEach(s => {
    const parts = Array.isArray(s.participants) ? s.participants : [];
    const kids  = Array.isArray(s.children)     ? s.children     : [];
    parts.forEach(uid => {
      if (uid === s.coachUid) return;
      // Heuristic for "is this a parent rather than a skater?" — we
      // can't tell without reading the user doc. We optimistically
      // include them as user-skaters here; resolveSkaterRecord below
      // will filter by role when loading the user doc.
      userUids.add(uid);
    });
    kids.forEach(cid => childIds.add(cid));
  });

  // Fetch all users + children in parallel. This is O(distinct skaters);
  // generation flows in v1 are bounded (one coach, one billing period).
  const userDocs = {};
  const childDocs = {};
  const parentUidsToFetch = new Set();

  await Promise.all([
    ...Array.from(userUids).map(async uid => {
      try {
        const s = await getDoc(doc(db, "users", uid));
        if (s.exists()) userDocs[uid] = s.data();
      } catch (err) { console.warn("user fetch failed", uid, err); }
    }),
    ...Array.from(childIds).map(async cid => {
      try {
        const s = await getDoc(doc(db, "children", cid));
        if (s.exists()) {
          const d = s.data();
          childDocs[cid] = d;
          if (d.parentId) parentUidsToFetch.add(d.parentId);
        }
      } catch (err) { console.warn("child fetch failed", cid, err); }
    }),
  ]);

  // Now hydrate parent users — they're payers for the child invoices
  // and we need their name for the "via" line on the invoice list.
  const parentDocs = {};
  await Promise.all(Array.from(parentUidsToFetch).map(async uid => {
    if (userDocs[uid]) { parentDocs[uid] = userDocs[uid]; return; } // already fetched
    try {
      const s = await getDoc(doc(db, "users", uid));
      if (s.exists()) parentDocs[uid] = s.data();
    } catch (err) { console.warn("parent fetch failed", uid, err); }
  }));

  return { userDocs, childDocs, parentDocs };
}

// Group unbilled sessions into per-skater buckets and compute totals.
// Returns an array of "groups" — one per future invoice. Children and
// user-skaters mix freely in this list; rendering doesn't care about
// which kind because skaterName + payerUid are denormalized.
function buildGroups(sessions, dirs) {
  const { userDocs, childDocs, parentDocs } = dirs;

  // Map keyed by "u:<uid>" or "c:<id>" so user-skaters and children
  // never collide even if their ids ever happened to match.
  const buckets = new Map();

  sessions.forEach(s => {
    const parts = Array.isArray(s.participants) ? s.participants : [];
    const kids  = Array.isArray(s.children)     ? s.children     : [];

    // User-skaters on this session: participants minus coach minus
    // anyone whose user doc says they're a parent (parents sit in
    // participants for calendar visibility, not as billable skaters).
    parts.forEach(uid => {
      if (uid === s.coachUid) return;
      const u = userDocs[uid];
      const roles = u && Array.isArray(u.rolesArray) ? u.rolesArray : [];
      const isSkaterUser = u && (roles.includes("skater") || roles.length === 0);
      const isParentOnly = u && roles.includes("parent") && !roles.includes("skater");
      if (!u || isParentOnly || !isSkaterUser) return;

      const key = `u:${uid}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key, kind: "user",
          skaterId:   uid,
          skaterName: formatFullName(u) || "—",
          payerUid:   uid,
          payerName:  null,
          skaterRef:  `users/${uid}`,
          sessions: [],
        });
      }
      buckets.get(key).sessions.push(s);
    });

    // Child-skaters: each child id resolves to a children-collection
    // doc whose parentId is the payer.
    kids.forEach(cid => {
      const c = childDocs[cid];
      if (!c) return;
      const parent = parentDocs[c.parentId];
      const key = `c:${cid}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key, kind: "child",
          skaterId:   cid,
          skaterName: formatFullName(c) || "—",
          payerUid:   c.parentId || null,
          payerName:  parent ? (formatFullName(parent) || null) : null,
          skaterRef:  `children/${cid}`,
          sessions: [],
        });
      }
      buckets.get(key).sessions.push(s);
    });
  });

  // Merge child groups billed to the same parent into one draft card.
  // Any child that has a payerUid should be represented only by its
  // parent card, not by an individual child card.
  const mergedBuckets = new Map();
  const childBucketsByParent = new Map();
  const childKeysToSkip = new Set();

  buckets.forEach(group => {
    if (group.kind === "child" && group.payerUid) {
      if (!childBucketsByParent.has(group.payerUid)) {
        childBucketsByParent.set(group.payerUid, []);
      }
      childBucketsByParent.get(group.payerUid).push(group);
      childKeysToSkip.add(group.key);
    }
  });

  buckets.forEach(group => {
    if (childKeysToSkip.has(group.key)) return;
    if (group.kind === "user" && childBucketsByParent.has(group.skaterId)) return;
    mergedBuckets.set(group.key, group);
  });

  childBucketsByParent.forEach((childGroups, parentUid) => {
    const parent = parentDocs[parentUid];
    const childNames = childGroups.map(g => g.skaterName || "—");
    const childFirstNames = childNames.map(n => (n || "").trim().split(/\s+/)[0] || "—");
    const parentName = parent ? formatFullName(parent) || "—" : "—";

    mergedBuckets.set(`p:${parentUid}`, {
      key: `p:${parentUid}`,
      kind: "parent",
      skaterId: parentUid,
      skaterName: parentName,
      childFirstNames,
      payerUid: parentUid,
      payerName: null,
      skaterRef: `users/${parentUid}`,
      sessions: childGroups.flatMap(g => g.sessions),
    });
  });

  const taxEnabled = !!(paySettings && paySettings.taxEnabled);
  const gstRate = (paySettings && Number(paySettings.gstRate)) || 0;
  const qstRate = (paySettings && Number(paySettings.qstRate)) || 0;

  const groupsOut = [];
  mergedBuckets.forEach(b => {
    b.sessions.sort((a, c) => {
      const da = a.date && a.date.toDate ? a.date.toDate().getTime() : 0;
      const dc = c.date && c.date.toDate ? c.date.toDate().getTime() : 0;
      return da - dc;
    });

    const items = [];
    const lineCentsArr = [];
    const childLabelForSession = (session) => {
      if (b.kind !== "parent") return "";
      const ids = Array.isArray(session.children) ? session.children : [];
      const names = ids
        .map(cid => childDocs[cid])
        .filter(Boolean)
        .map(c => (formatFullName(c) || "").trim().split(/\s+/)[0] || "—");
      return names.length ? names.join(", ") : "";
    };

    b.sessions.forEach(s => {
      const cents = computeLineCents(s);
      lineCentsArr.push(cents);
      items.push(buildItem(s, cents, childLabelForSession(s)));
    });

    const subtotalCents = addAmounts(...lineCentsArr);
    const { gstCents, qstCents, totalCents } = calculateTaxTotals(subtotalCents, {
      taxEnabled,
      gstRate,
      qstRate,
    });

    groupsOut.push({
      ...b,
      items,
      subtotalCents,
      gstCents,
      qstCents,
      totalCents,
      selected: true,
      expanded: false,
    });
  });

  groupsOut.sort((a, b) => a.skaterName.localeCompare(b.skaterName));
  return groupsOut;
}

// ── Phase 2: render ──────────────────────────────────────────────────────────

function renderSummary() {
  const lang = getLang();
  const selected = groups.filter(g => g.selected);
  const sessionCount = selected.reduce((n, g) => n + g.sessions.length, 0);
  const totalCents   = selected.reduce((n, g) => n + g.totalCents, 0);

  const invoicesLabel = selected.length === 1
    ? t("pgInvoiceSingular") : t("pgInvoicePlural");
  const sessionsLabel = sessionCount === 1
    ? t("sessionSingular") : t("sessionPlural");

  const summary = `${selected.length} ${invoicesLabel} · ${sessionCount} ${sessionsLabel} · ${formatMoney(totalCents, lang)} ${t("pgTotal")}`;
  document.getElementById("pgSummary").textContent = summary;

  // Update the primary CTA label + disabled state. "Create N drafts"
  // (with the actual N) makes the commit moment unambiguous.
  const btn = document.getElementById("pgCreateBtn");
  btn.disabled = selected.length === 0;
  if (selected.length === 0) {
    btn.textContent = t("pgCreateBtnZero");
  } else if (selected.length === 1) {
    btn.textContent = t("pgCreateBtnOne");
  } else {
    btn.textContent = `${t("pgCreateBtnN")} ${selected.length} ${t("pgCreateBtnNDraftsSuffix")}`;
  }
}

function renderList() {
  const lang = getLang();
  const listEl = document.getElementById("pgList");

  if (groups.length === 0) {
    listEl.style.display = "none";
    document.getElementById("pgBulk").style.display = "none";
    document.getElementById("pgActions").style.display = "none";
    document.getElementById("pgEmpty").style.display = "";
    return;
  }

  document.getElementById("pgEmpty").style.display = "none";
  document.getElementById("pgBulk").style.display = "";
  document.getElementById("pgActions").style.display = "";
  listEl.style.display = "";

  listEl.innerHTML = groups.map(renderCard).join("");

  // Re-wire interactions every render — each card is rebuilt from
  // scratch when the user toggles select/expand, so handlers don't
  // accumulate. This is fine at v1 scale (handful of cards).
  groups.forEach(g => {
    const cardEl = listEl.querySelector(`[data-key="${g.key}"]`);
    if (!cardEl) return;
    cardEl.querySelector(".pg-card-checkbox").addEventListener("change", e => {
      g.selected = e.target.checked;
      renderAll();
    });
    const toggle = cardEl.querySelector(".pg-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        g.expanded = !g.expanded;
        renderAll();
      });
    }
  });
}

function renderCard(g) {
  const lang = getLang();
  const sessionsLabel = g.sessions.length === 1
    ? t("sessionSingular") : t("sessionPlural");
  const subParts = [];
  if (g.payerName) subParts.push(`${t("payVia")} ${escapeHtml(g.payerName)}`);
  if (g.kind === "parent" && Array.isArray(g.childFirstNames) && g.childFirstNames.length) {
    subParts.push(escapeHtml(g.childFirstNames.join(", ")));
  }
  subParts.push(`${g.sessions.length} ${sessionsLabel}`);
  const subLine = subParts.join(" · ");

  const linesHtml = g.expanded ? renderLines(g) : "";
  const toggleLabel = g.expanded ? t("pgHideLines") : t("pgShowLines");
  const caret = g.expanded ? "▴" : "▾";

  return `
    <div class="pg-card ${g.selected ? "" : "is-deselected"}" data-key="${escapeHtml(g.key)}">
      <div class="pg-card-row">
        <input type="checkbox" class="pg-card-checkbox" ${g.selected ? "checked" : ""} />
        <div class="pg-card-main">
          <div class="pg-card-top">
            <div class="pg-card-name">${escapeHtml(g.skaterName)}</div>
            <div class="pg-card-amount">${escapeHtml(formatMoney(g.totalCents, lang))}</div>
          </div>
          <div class="pg-card-sub">${subLine}</div>
          <button type="button" class="pg-toggle">${caret} ${escapeHtml(toggleLabel)}</button>
          <div class="pg-lines ${g.expanded ? "is-expanded" : ""}">${linesHtml}</div>
        </div>
      </div>
    </div>
  `;
}

function renderLines(g) {
  const lang = getLang();
  const out = [];
  g.items.forEach(it => {
    out.push(`
      <div class="pg-line">
        <div class="pg-line-desc">${escapeHtml(it.description)}</div>
        <div class="pg-line-amount">${escapeHtml(formatMoney(it.lineTotal, lang))}</div>
      </div>
    `);
  });
  // Subtotal row.
  out.push(`
    <div class="pg-line pg-line-subtotal">
      <div class="pg-line-desc">${escapeHtml(t("pgSubtotal"))}</div>
      <div class="pg-line-amount">${escapeHtml(formatMoney(g.subtotalCents, lang))}</div>
    </div>
  `);
  // Tax rows: only render when there's actual tax to show. A coach
  // who hasn't enabled tax shouldn't see a "GST: $0.00" row.
  if (g.gstCents > 0) {
    const pct = Math.round(((paySettings.gstRate || 0) * 1000)) / 10;
    out.push(`
      <div class="pg-line pg-line-tax">
        <div class="pg-line-desc">${escapeHtml(t("pgGst"))} (${pct}%)</div>
        <div class="pg-line-amount">${escapeHtml(formatMoney(g.gstCents, lang))}</div>
      </div>
    `);
  }
  if (g.qstCents > 0) {
    const pct = Math.round(((paySettings.qstRate || 0) * 1000)) / 10;
    out.push(`
      <div class="pg-line pg-line-tax">
        <div class="pg-line-desc">${escapeHtml(t("pgQst"))} (${pct}%)</div>
        <div class="pg-line-amount">${escapeHtml(formatMoney(g.qstCents, lang))}</div>
      </div>
    `);
  }
  // Total row terminates the panel.
  out.push(`
    <div class="pg-line pg-line-total">
      <div class="pg-line-desc">${escapeHtml(t("pgTotal"))}</div>
      <div class="pg-line-amount">${escapeHtml(formatMoney(g.totalCents, lang))}</div>
    </div>
  `);
  return out.join("");
}

function renderAll() {
  renderSummary();
  renderList();
}

// ── Phase 3: commit ──────────────────────────────────────────────────────────

// Issue date is "now" for every draft. Due date is now + defaultDueDays
// from settings (fallback 14, the most common net-15 minus a buffer day).
function computeIssuedDue() {
  const now = new Date();
  const defaultDays = (paySettings && Number(paySettings.defaultDueDays)) || 14;
  const due = new Date(now.getTime() + defaultDays * 24 * 60 * 60 * 1000);
  return {
    issuedAt: Timestamp.fromDate(now),
    dueAt:    Timestamp.fromDate(due),
  };
}

// Format an integer N as "INV-000042". The schema notes a forever-
// incrementing sequence, no per-year reset (per ticket recap "global
// forever-incrementing").
function formatInvoiceNumber(n) {
  return `INV-${String(n).padStart(6, "0")}`;
}

// Run one transaction per draft. Each transaction:
//   READS:
//     - /system/invoices  (the global counter — read lastIssued)
//     - every session in the draft  (to confirm invoiceId is still null
//       — anti-race: another tab/device might have already invoiced one
//       of them since we loaded the preview)
//   WRITES:
//     - new invoice doc (with denormalized skaterName + payerUid)
//     - one invoice_items doc per line
//     - patches each session.invoiceId
//     - bumps /system/invoices.lastIssued by exactly 1
//
// If any session has a non-null invoiceId at transaction time, the whole
// draft is rejected with an error the caller surfaces inline. Other
// drafts (separate transactions) still go through.
async function commitOneDraft(group, coachUid) {
  const invoiceRef = doc(collection(db, "invoices"));
  // MP-115 contract: counter lives at /system/invoices, NOT
  // /counters/invoices. The match in firestore.rules is
  // `match /system/{counterId}` so the doc id is "invoices".
  const counterRef = doc(db, "system", "invoices");

  await runTransaction(db, async (tx) => {
    // -- READS --
    const counterSnap = await tx.get(counterRef);
    // The counter MUST exist before this transaction runs — we seed it
    // with lastIssued:0 outside the transaction (see ensureCounter).
    // If it's missing here, the seed step failed; bail with a clear
    // error rather than silently flipping into a "create" branch the
    // rules will reject on increment.
    if (!counterSnap.exists()) {
      throw new Error("counter_missing");
    }
    const lastIssued = Number(counterSnap.data().lastIssued) || 0;
    const nextNum = lastIssued + 1;

    // Re-read every session and verify it's still unbilled. We can't
    // batch these into a query inside a transaction (Firestore
    // transactions only support direct doc reads), so it's N reads
    // — bounded by the number of sessions in this one draft.
    const sessionRefs = group.sessions.map(s => doc(db, "sessions", s.id));
    const sessionSnaps = await Promise.all(sessionRefs.map(r => tx.get(r)));
    sessionSnaps.forEach((snap, i) => {
      if (!snap.exists()) {
        throw new Error(`session_missing:${group.sessions[i].id}`);
      }
      const data = snap.data();
      if (data.invoiceId) {
        throw new Error(`already_invoiced:${group.sessions[i].id}`);
      }
      // Defense in depth: verify the session still belongs to this
      // coach (a malicious client couldn't reach this code anyway —
      // rules block it — but tx-level checks document the contract).
      if (data.coachUid !== coachUid) {
        throw new Error(`not_my_session:${group.sessions[i].id}`);
      }
    });

    // -- WRITES --
    const invoiceNumber = formatInvoiceNumber(nextNum);
    const { issuedAt, dueAt } = computeIssuedDue();

    const invoiceDoc = {
      invoiceNumber,
      coachUid,
      payerUid:    group.payerUid,
      // skaterUid is the single string carrier MP-115's validator
      // expects. For user-skaters this is the skater's UID; for
      // children it's the child id. Code that needs to know "is this
      // a user or a child?" reads skaterRef instead.
      skaterUid:   group.skaterId,
      skaterName:  group.skaterName,        // denormalized
      skaterRef:   group.skaterRef,         // "users/..." | "children/..."
      payerName:   group.payerName || null, // denormalized for "via" rendering
      coachName:   formatFullName(currentUserData) || "—", // denormalized
      status:      "draft",
      issuedAt:    null,                    // set when status -> sent (MP-122)
      dueAt:       null,                    // set when status -> sent
      paidAt:      null,
      createdAt:   serverTimestamp(),
      // Pre-compute issued/due now so a future "send" only flips status
      // and timestamps. Stored as separate "proposed" fields so a draft
      // edit could change them later if MP-122 wants that.
      proposedIssuedAt: issuedAt,
      proposedDueAt:    dueAt,
      subtotal:    group.subtotalCents,
      gstAmount:   group.gstCents,
      qstAmount:   group.qstCents,
      discountAmount: 0,
      total:       group.totalCents,
      currency:    "CAD",
      itemCount:   group.items.length, // denormalized for payment.html row
      acceptedMethods: Array.isArray(paySettings?.acceptedMethods) ? paySettings.acceptedMethods : ["etransfer"],
      notes:       (paySettings && paySettings.invoiceNotes) || "",
    };
    tx.set(invoiceRef, invoiceDoc);

    // Patch each session: link it to this invoice. Sessions remain
    // mutable for other fields (notes, etc.) but invoiceId will be
    // enforced as immutable-once-set in the security rules.
    sessionRefs.forEach(ref => {
      tx.update(ref, { invoiceId: invoiceRef.id });
    });

    // Bump the counter. Per MP-115 the rules require:
    //   - existing doc (resource != null)
    //   - request.resource.data.lastIssued == resource.data.lastIssued + 1
    // tx.update is used (not set/merge) so we send only the changed
    // field; the rule then sees the post-update doc and verifies the
    // exact +1 transition.
    tx.update(counterRef, { lastIssued: nextNum });
  });

  await Promise.all(group.items.map((it, idx) => {
    const itemRef = doc(collection(db, "invoices", invoiceRef.id, "items"));
    return setDoc(itemRef, {
      ...it,
      invoiceId: invoiceRef.id,
      position:  idx,
    });
  }));

  return invoiceRef.id;
}

// Make sure /system/invoices exists with lastIssued:0 before any
// transaction runs. This MUST be done outside a transaction because:
//   1. The MP-115 rule for `create` accepts only the literal value
//      lastIssued == 0, with no preconditions on resource (since it's
//      a create). Doing the create in the same tx as an update would
//      conflict with the rule's update branch (which requires
//      resource.data.lastIssued + 1).
//   2. setDoc with a check-and-skip via getDoc keeps it idempotent —
//      subsequent calls do nothing once the doc exists.
// Returns true if the counter is in a usable state, false if init
// failed (e.g. permission denied — bubble up to the user).
async function ensureCounterSeeded() {
  const counterRef = doc(db, "system", "invoices");
  try {
    const snap = await getDoc(counterRef);
    if (snap.exists()) return true;
  } catch (err) {
    // Read failed — could be a permissions issue. Surface to caller.
    console.error("Could not read counter:", err);
    return false;
  }
  try {
    // First-ever seed. The rule's `create` branch accepts only this
    // exact shape, so any drift here surfaces as a permission denied.
    await setDoc(counterRef, { lastIssued: 0 });
    return true;
  } catch (err) {
    console.error("Could not seed counter:", err);
    return false;
  }
}

// Run commits sequentially so the global counter increments cleanly.
// (Parallel transactions would also work via Firestore's retry logic,
// but sequential is simpler to reason about and the absolute count of
// drafts in one click is small.)
async function commitAllSelected() {
  const selected = groups.filter(g => g.selected);
  if (selected.length === 0) return { created: [], failed: [] };
  const created = [];
  const failed = [];
  for (const g of selected) {
    try {
      const id = await commitOneDraft(g, currentUser.uid);
      created.push({ group: g, invoiceId: id });
    } catch (err) {
      console.error("Draft commit failed for", g.key, err);
      failed.push({ group: g, error: err });
    }
  }
  return { created, failed };
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireBulkActions() {
  document.getElementById("pgSelectAll").addEventListener("click", () => {
    groups.forEach(g => g.selected = true);
    renderAll();
  });
  document.getElementById("pgDeselectAll").addEventListener("click", () => {
    groups.forEach(g => g.selected = false);
    renderAll();
  });
}

function wireActionButtons() {
  document.getElementById("pgCancelBtn").addEventListener("click", () => {
    window.location.href = "dashboard.html";
  });
  document.getElementById("pgCreateBtn").addEventListener("click", async () => {
    const overlay = document.getElementById("pgOverlay");
    const errorEl = document.getElementById("pgError");
    errorEl.style.display = "none";
    overlay.classList.add("is-visible");

    // Seed /system/invoices if missing. Idempotent — does nothing on
    // subsequent generations. If this fails (rules misconfigured,
    // offline, etc.) we abort before touching any invoice writes so
    // the coach doesn't end up with half a generation.
    const counterReady = await ensureCounterSeeded();
    if (!counterReady) {
      overlay.classList.remove("is-visible");
      errorEl.textContent = t("pgTotalFail");
      errorEl.style.display = "";
      return;
    }

    const { created, failed } = await commitAllSelected();

    overlay.classList.remove("is-visible");

    if (failed.length === 0 && created.length > 0) {
      // All good — redirect to the payment list with the draft filter
      // active so the coach lands looking at exactly what they just
      // created (per Q7).
      window.location.href = "payment.html?filter=draft";
      return;
    }

    if (created.length > 0 && failed.length > 0) {
      // Partial success: drafts were created, but some failed (likely
      // race-conditioned by another tab). Show what failed, and
      // remove the successful ones from the on-screen groups so the
      // coach can retry the rest if they want.
      const succeededKeys = new Set(created.map(c => c.group.key));
      groups = groups.filter(g => !succeededKeys.has(g.key));
      const names = failed.map(f => f.group.skaterName).join(", ");
      errorEl.textContent = `${t("pgPartialFail")} ${names}`;
      errorEl.style.display = "";
      renderAll();
      return;
    }

    // Total failure: nothing got created. Most common cause is rules
    // rejecting the write (misconfigured paymentSettings) or a
    // network blip. Surface a generic message — the console has the
    // raw error for debugging.
    errorEl.textContent = t("pgTotalFail");
    errorEl.style.display = "";
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

authGuard([], async (user, userData) => {
  currentUser     = user;
  currentUserData = userData;
  currentRoles    = userData.rolesArray || userData.roles || [];

  applyLanguage();
  initNav("payment.html");
  injectNotificationBell(user.uid);

  // Coach-only screen. Same defensive UI fallback as payment.html.
  if (!hasCoachRole(currentRoles)) {
    document.getElementById("pgLoading").style.display = "none";
    document.getElementById("pgForbidden").style.display = "";
    return;
  }

  wireBulkActions();
  wireActionButtons();

  try {
    const [sessions, settings] = await Promise.all([
      loadUnbilledSessions(user.uid),
      loadPaymentSettings(user.uid),
    ]);
    paySettings = settings;
    if (sessions.length === 0) {
      groups = [];
    } else {
      const dirs = await resolveSkatersAndPayers(sessions);
      groups = buildGroups(sessions, dirs);
    }
  } catch (err) {
    console.error("Failed to load unbilled sessions:", err);
    document.getElementById("pgLoading").textContent = t("loadFailed");
    return;
  }

  document.getElementById("pgLoading").style.display = "none";
  renderAll();
});
