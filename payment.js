// payment.js — Payments page for coaches and payers (MP-120, MP-121, MP-126)
//
// Coaches: lists all invoices they issued, with billable-session cards,
// metric cards (outstanding / overdue / revenue), and status filter pills.
//
// Skaters / parents: lists invoices addressed to them (payerUid == me),
// showing only sent/paid statuses, with a payment-submission flow.
//
// Reads:
//   - coaches:  invoices where coachUid == me
//   - payers:   invoices where payerUid == me
//
// As of MP-121 invoices carry denormalized `skaterName` and `payerName`
// strings — we used to fetch user/children docs per row to resolve
// names, but those joins are now unnecessary. The list page is a pure
// single-query read.
//
// Status logic:
//   Firestore stores: draft | sent | paid | void
//   We add a synthetic "overdue" bucket client-side: status == "sent"
//   AND dueAt < now. The original `status` field stays "sent" — the
//   state machine in project knowledge specifies overdue is computed,
//   not stored.
//
// Sort order (per MP-120 design):
//   1. Overdue + Sent (outstanding-first)
//   2. Draft
//   3. Paid
//   4. Void
//   Within each bucket: most recent first, by issuedAt desc, falling
//   back to createdAt for drafts (which have no issuedAt yet).
//
// Filtering / searching is purely client-side over the same in-memory
// list. Invoices are bounded (one coach, finite skaters, monthly
// generation) so a single read + filter is fine.
//
// URL params (added MP-121):
//   ?filter=draft|sent|overdue|paid|void  → pre-select that filter pill.
//   Used by paymentGenerate.js to land the coach on Drafts after a
//   successful generation.

import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, formatFullName, escapeHtml, hasCoachRole } from "./app.js";
import { injectNotificationBell } from "./notifications.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, getDoc, addDoc, setDoc, updateDoc, runTransaction, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  formatMoney, toCents, fromCents, addAmounts, multiplyAmount,
  calculateTaxTotals, includedTaxAmounts, calculateOverdueInterest,
  invoiceAmountDue,
} from "./money.js";

const PLATFORM_GST_RATE = 0.05;
const PLATFORM_QST_RATE = 0.09975;

// ── Module-level state ───────────────────────────────────────────────────────
//
// We keep one in-memory copy of the loaded invoice list and re-render
// from it on filter/search changes. No re-reads from Firestore until
// the user navigates back to the page.

let currentUser    = null;
let currentUserData = null;
let currentRoles   = [];
let allInvoices    = [];
let billableGroups = [];
let paymentConfirmations = [];
let billPaySettings = null;
let activeStatus   = "all";
let payerUninvoicedTotal = 0;
let hiddenInvoiceIds = new Set();
let credits = [];
let hasAffiliateSessions = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

function formatInvoiceNumber(n) {
  return `INV-${String(n).padStart(6, "0")}`;
}

// Bucket order for the sort. Lower = earlier in the list. Overdue and
// sent share bucket 0 because both are "outstanding" — we want the
// coach to see what's owed first regardless of whether the deadline
// has passed yet.
const STATUS_BUCKETS = {
  overdue: 0,
  sent:    0,
  draft:   1,
  paid:    2,
  void:    3,
};

// Convert a Firestore Timestamp | Date | null into a JS Date | null.
// Invoices read off Firestore have Timestamp instances; in tests we
// might get plain Dates; missing fields are null.
function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  return null;
}

// Format a date as "Apr 12" (en) / "12 avr." (fr). We don't use full
// year because the metric card already says "this year" and the row
// is dense enough as is. Locale-aware via Intl.
function formatShortDate(d, lang) {
  if (!d) return "—";
  const opts = { month: "short", day: "numeric" };
  // "fr-CA" gives "12 avr." which is what we want. "en-US" gives
  // "Apr 12". Both are 5–6 characters and read naturally.
  const localeTag = lang === "fr" ? "fr-CA" : "en-US";
  return d.toLocaleDateString(localeTag, opts);
}

function formatLongDate(d, lang) {
  if (!d) return "—";
  return d.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Resolve display status for a single invoice. Overdue is synthetic:
// a "sent" invoice whose dueAt is in the past. Anything else passes
// through unchanged. We compute this at hydrate time, not at render
// time, so sorting and filtering work off the same field.
function deriveStatus(inv, now) {
  const status = typeof inv.status === "string" ? inv.status.trim().toLowerCase() : "";
  if (status === "paid" || inv?.paidAt) return "paid";
  if (status === "sent") {
    const due = asDate(inv.dueAt);
    if (due && due.getTime() < now.getTime()) return "overdue";
    return "sent";
  }
  return status || "draft";
}

function getDisplayStatus(inv) {
  if (hasCoachRole(currentRoles)) return inv.derivedStatus;
  if (inv.derivedStatus === "sent") return "due";
  return inv.derivedStatus;
}

function submittedPaymentAmount(inv) {
  const raw = Math.max(0, Number(inv?.paymentSubmittedAmount) || 0);
  return Math.min(raw, invoiceTotalWithOverdueInterest(inv));
}

function rawPaidOrSubmittedAmount(inv) {
  return Math.max(
    0,
    Number(inv?.paidAmount) || 0,
    Number(inv?.paymentSubmittedAmount) || 0
  );
}

function overdueInterestBps(inv) {
  return Math.max(0, Number(inv?.overdueInterestBps) || 0);
}

function overdueInterestAmount(inv) {
  if (inv?.derivedStatus !== "overdue") return 0;
  return calculateOverdueInterest({
    ...inv,
    paidAmount: rawPaidOrSubmittedAmount(inv),
    overdueInterestBps: overdueInterestBps(inv),
  }, true);
}

function invoiceTotalWithOverdueInterest(inv) {
  return (Number(inv?.total) || 0) + overdueInterestAmount(inv);
}

function remainingPaymentAmount(inv) {
  return invoiceAmountDue({
    ...inv,
    paidAmount: rawPaidOrSubmittedAmount(inv),
  }, overdueInterestAmount(inv));
}

function paymentMethodLabel(method) {
  const key = `paymentMethod_${method}`;
  return t(key) === key ? method : t(key);
}

function normalizePaymentMethod(method) {
  const raw = String(method || "").trim().toLowerCase();
  const compact = raw.replace(/[\s_-]/g, "");
  if (compact === "etransfer" || compact === "interac" || compact === "interacetransfer") return "etransfer";
  if (compact === "cash") return "cash";
  if (compact === "cheque" || compact === "check") return "cheque";
  return "";
}

function normalizePaymentMethods(methods) {
  const out = [];
  (Array.isArray(methods) ? methods : []).forEach(method => {
    const normalized = normalizePaymentMethod(method);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  });
  return out;
}

// ── Data loading ─────────────────────────────────────────────────────────────

// Load every invoice relevant to this user, hydrate derived status, and
// return the list. For coaches: invoices they issued (coachUid == me).
// For payers (skaters/parents): invoices they received (payerUid == me).
async function loadInvoices(userUid, roles) {
  let q;
  if (hasCoachRole(roles)) {
    q = query(collection(db, "invoices"), where("coachUid", "==", userUid));
  } else {
    // For skaters and parents, load invoices they are paying for
    q = query(collection(db, "invoices"), where("payerUid", "==", userUid));
  }
  const snap = await getDocs(q);

  const now = new Date();
  let raw = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      invoiceNumber: data.invoiceNumber || "",
      coachUid:      data.coachUid,
      payerUid:      data.payerUid,
      // MP-121: denormalized name fields. Fallback strings keep the
      // row template safe when an older invoice predates this field.
      skaterName:    data.skaterName || "—",
      payerName:     data.payerName  || null, // null for self-pay
      coachName:     data.coachName  || null, // May need to denormalize
      // skaterRef is "users/<uid>" or "children/<id>" — used only by
      // the detail page (MP-124); the list never needs to follow it.
      skaterRef:     data.skaterRef || null,
      status:        typeof data.status === "string" ? data.status.trim().toLowerCase() : "draft",
      issuedAt:      data.issuedAt || null,
      dueAt:         data.dueAt || null,
      paidAt:        data.paidAt || null,
      partialPaidAt: data.partialPaidAt || null,
      paidAmount:    typeof data.paidAmount === "number" ? data.paidAmount : 0,
      overdueInterestBps: typeof data.overdueInterestBps === "number" ? data.overdueInterestBps : 0,
      createdAt:     data.createdAt || null,
      archivedAt:    data.archivedAt || null,
      proposedIssuedAt: data.proposedIssuedAt || null,
      subtotal:      typeof data.subtotal === "number" ? data.subtotal : 0,
      gstAmount:     typeof data.gstAmount === "number" ? data.gstAmount : 0,
      qstAmount:     typeof data.qstAmount === "number" ? data.qstAmount : 0,
      taxIncluded:   !!data.taxIncluded,
      total:         typeof data.total === "number" ? data.total : 0,
      creditApplied: typeof data.creditApplied === "number" ? data.creditApplied : 0,
      acceptedMethods: Array.isArray(data.acceptedMethods) ? data.acceptedMethods : null,
      // Denormalized session count, written when the invoice is
      // created in MP-121. We fall back to 0 if absent so legacy
      // data doesn't crash the row template.
      itemCount:     typeof data.itemCount === "number" ? data.itemCount : 0,
      currency:      data.currency || "CAD",
    };
  }).filter(inv => !inv.archivedAt);

  if (!hasCoachRole(roles)) {
    raw = raw.filter(inv => {
      const s = typeof inv.status === "string" ? inv.status.trim().toLowerCase() : "";
      return s === "sent" || s === "paid" || inv.paidAt;
    });
  }

  // Hydrate the derived status before any sort/filter touches the
  // list. Stored once here, read everywhere else.
  raw.forEach(inv => { inv.derivedStatus = deriveStatus(inv, now); });

  return raw;
}

async function loadPaymentConfirmations(userUid, roles) {
  try {
    const snap = await getDocs(
      query(collection(db, "users", userUid, "paymentConfirmations"), where("status", "==", "pending"))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("Payment confirmations unavailable:", err);
    return [];
  }
}

async function loadHiddenInvoiceIds(userUid) {
  try {
    const snap = await getDocs(collection(db, "users", userUid, "hiddenInvoices"));
    return new Set(snap.docs.map(d => d.id));
  } catch (err) {
    console.warn("Hidden invoices unavailable:", err);
    return new Set();
  }
}

async function loadCredits(coachUid) {
  try {
    const snap = await getDocs(
      query(collection(db, "credits"), where("coachUid", "==", coachUid))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("Credits unavailable:", err);
    return [];
  }
}

async function loadPayerCredits(payerUid) {
  try {
    const snap = await getDocs(
      query(collection(db, "credits"), where("payerUid", "==", payerUid))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("Payer credits unavailable:", err);
    return [];
  }
}

function applyPayerPaymentConfirmations() {
  if (hasCoachRole(currentRoles)) return;
  const pendingByInvoice = new Map(paymentConfirmations.map(c => [c.invoiceId, c]));
  allInvoices.forEach(inv => {
    const confirmation = pendingByInvoice.get(inv.id);
    if (!confirmation || inv.status === "paid") return;
    inv.paymentSent = true;
    inv.paymentSubmittedAmount = Math.max(0, Number(confirmation.total) || 0);
    inv.paidAt = confirmation.sentAt || Timestamp.fromDate(new Date());
    if (remainingPaymentAmount(inv) === 0) {
      inv.derivedStatus = "paid";
    }
  });
}

function confirmedPaidAmount(inv) {
  if (Number(inv?.paidAmount) > 0) return Math.min(Number(inv.paidAmount), invoiceTotalWithOverdueInterest(inv));
  return inv?.status === "paid" ? invoiceTotalWithOverdueInterest(inv) : 0;
}

function invoiceReportDate(inv) {
  return asDate(inv.issuedAt) || asDate(inv.proposedIssuedAt) || asDate(inv.createdAt);
}

function taxReportYears() {
  const currentYear = new Date().getFullYear();
  const testReportYear = 2026;
  const lastReportYear = Math.max(currentYear - 1, testReportYear);
  const invoiceYears = allInvoices
    .map(inv => invoiceReportDate(inv))
    .filter(Boolean)
    .map(date => date.getFullYear())
    .filter(year => year <= lastReportYear);
  const firstYear = invoiceYears.length ? Math.min(...invoiceYears) : testReportYear;
  const years = [];
  for (let year = firstYear; year <= lastReportYear; year += 1) years.push(year);
  if (!years.includes(testReportYear)) years.push(testReportYear);
  return years.sort((a, b) => b - a);
}

function taxReportTaxAmounts(inv) {
  const storedGst = Math.max(0, Number(inv?.gstAmount) || 0);
  const storedQst = Math.max(0, Number(inv?.qstAmount) || 0);
  if (storedGst || storedQst) {
    return { gst: storedGst, qst: storedQst, included: !!inv.taxIncluded };
  }

  const taxEnabled = !!(inv?.coachTaxEnabled || (billPaySettings && billPaySettings.taxEnabled));
  if (!inv?.taxIncluded && !taxEnabled) {
    return { gst: 0, qst: 0, included: false };
  }

  const gstRate = Number(inv?.coachGstRate) || (billPaySettings && Number(billPaySettings.gstRate)) || PLATFORM_GST_RATE;
  const qstRate = Number(inv?.coachQstRate) || (billPaySettings && Number(billPaySettings.qstRate)) || PLATFORM_QST_RATE;
  const included = includedTaxAmounts(Number(inv?.total) || 0, gstRate, qstRate);
  return { gst: included.gstCents, qst: included.qstCents, included: true };
}

function taxReportSubtotal(inv) {
  const taxes = taxReportTaxAmounts(inv);
  if (taxes.included) {
    return Math.max(0, (Number(inv?.total) || 0) - taxes.gst - taxes.qst);
  }
  return Number(inv?.subtotal) || 0;
}

function taxReportForYear(year) {
  const issuedInvoices = allInvoices.filter(inv => {
    const date = invoiceReportDate(inv);
    return date && date.getFullYear() === year && inv.status !== "void" && inv.status !== "draft";
  });
  const paidInvoices = allInvoices.filter(inv => {
    const date = asDate(inv.paidAt) || asDate(inv.partialPaidAt);
    return date && date.getFullYear() === year && inv.status !== "void";
  });

  const sum = (list, pick) => addAmounts(...list.map(pick));
  const subtotal = sum(issuedInvoices, taxReportSubtotal);
  const gst = sum(issuedInvoices, inv => taxReportTaxAmounts(inv).gst);
  const qst = sum(issuedInvoices, inv => taxReportTaxAmounts(inv).qst);
  const overdueInterest = sum(issuedInvoices, overdueInterestAmount);
  const invoicedTotal = sum(issuedInvoices, invoiceTotalWithOverdueInterest);
  const paidTotal = sum(paidInvoices, confirmedPaidAmount);

  return {
    issuedInvoices,
    paidInvoices,
    subtotal,
    gst,
    qst,
    overdueInterest,
    invoicedTotal,
    paidTotal,
  };
}

function payerSummaryForYear(year) {
  const receivedInvoices = allInvoices.filter(inv => {
    const date = invoiceReportDate(inv);
    return date && date.getFullYear() === year && inv.status !== "void";
  });
  const paymentInvoices = allInvoices.filter(inv => {
    const date = asDate(inv.paidAt) || asDate(inv.partialPaidAt);
    return date && date.getFullYear() === year && inv.status !== "void";
  });

  const sum = (list, pick) => addAmounts(...list.map(pick));
  const invoiceTotal = sum(receivedInvoices, invoiceTotalWithOverdueInterest);
  const paymentsMade = sum(paymentInvoices, inv => inv.paymentSent ? submittedPaymentAmount(inv) : confirmedPaidAmount(inv));
  const remaining = sum(receivedInvoices, remainingPaymentAmount);
  const gst = sum(receivedInvoices, inv => taxReportTaxAmounts(inv).gst);
  const qst = sum(receivedInvoices, inv => taxReportTaxAmounts(inv).qst);

  return {
    receivedInvoices,
    paymentInvoices,
    invoiceTotal,
    paymentsMade,
    remaining,
    gst,
    qst,
  };
}

function renderPayerYearlySummary(year) {
  const lang = getLang();
  const report = payerSummaryForYear(year);
  const content = document.getElementById("taxReportContent");
  if (!content) return;

  content.innerHTML = `
    <div class="tax-report-grid">
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("yearlySummaryInvoicesReceived"))}</div>
        <div class="tax-report-value">${escapeHtml(String(report.receivedInvoices.length))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("taxReportInvoiceTotal"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.invoiceTotal, lang))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("yearlySummaryAmountDue"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.remaining, lang))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("yearlySummaryPaymentsMade"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.paymentsMade, lang))}</div>
      </div>
    </div>
    <div class="tax-report-section">
      <div class="tax-report-section-title">${escapeHtml(t("yearlySummary"))}</div>
      <div class="tax-report-row"><span>${escapeHtml(t("invGst"))}</span><strong>${escapeHtml(formatMoney(report.gst, lang))}</strong></div>
      <div class="tax-report-row"><span>${escapeHtml(t("invQst"))}</span><strong>${escapeHtml(formatMoney(report.qst, lang))}</strong></div>
      <div class="tax-report-row"><span>${escapeHtml(t("taxReportTaxCollected"))}</span><strong>${escapeHtml(formatMoney(report.gst + report.qst, lang))}</strong></div>
    </div>
  `;
}

function renderTaxReport(year) {
  if (!hasCoachRole(currentRoles)) {
    renderPayerYearlySummary(year);
    return;
  }

  const lang = getLang();
  const report = taxReportForYear(year);
  const content = document.getElementById("taxReportContent");
  if (!content) return;

  content.innerHTML = `
    <div class="tax-report-grid">
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("taxReportInvoicesIssued"))}</div>
        <div class="tax-report-value">${escapeHtml(String(report.issuedInvoices.length))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("taxReportPaymentsReceived"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.paidTotal, lang))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("taxReportInvoiceTotal"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.invoicedTotal, lang))}</div>
      </div>
      <div class="tax-report-card">
        <div class="tax-report-label">${escapeHtml(t("taxReportTaxCollected"))}</div>
        <div class="tax-report-value">${escapeHtml(formatMoney(report.gst + report.qst, lang))}</div>
      </div>
    </div>
    <div class="tax-report-section">
      <div class="tax-report-section-title">${escapeHtml(t("taxReportCanada"))}</div>
      <div class="tax-report-row"><span>${escapeHtml(t("invSubtotal"))}</span><strong>${escapeHtml(formatMoney(report.subtotal, lang))}</strong></div>
      <div class="tax-report-row"><span>${escapeHtml(t("invGst"))}</span><strong>${escapeHtml(formatMoney(report.gst, lang))}</strong></div>
      <div class="tax-report-row"><span>${escapeHtml(t("overdueInterest"))}</span><strong>${escapeHtml(formatMoney(report.overdueInterest, lang))}</strong></div>
    </div>
    <div class="tax-report-section">
      <div class="tax-report-section-title">${escapeHtml(t("taxReportQuebec"))}</div>
      <div class="tax-report-row"><span>${escapeHtml(t("invQst"))}</span><strong>${escapeHtml(formatMoney(report.qst, lang))}</strong></div>
      <div class="tax-report-row"><span>${escapeHtml(t("taxReportGrossRevenue"))}</span><strong>${escapeHtml(formatMoney(report.invoicedTotal, lang))}</strong></div>
    </div>
  `;
}

function openTaxReportModal() {
  const modal = document.getElementById("taxReportModal");
  const select = document.getElementById("taxReportYear");
  if (!modal || !select) return;

  const years = taxReportYears();
  const note = document.getElementById("taxReportNote");
  if (note) {
    note.textContent = t(hasCoachRole(currentRoles) ? "taxReportNote" : "yearlySummaryPayerNote");
  }
  select.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join("");
  select.value = years.includes(2026) ? "2026" : String(years[0]);
  renderTaxReport(Number(select.value));

  modal.style.display = "flex";
  select.onchange = () => renderTaxReport(Number(select.value));
  document.getElementById("taxReportClose").onclick = () => { modal.style.display = "none"; };
  document.getElementById("taxReportDone").onclick = () => { modal.style.display = "none"; };
  document.getElementById("taxReportPrint").onclick = () => {
    document.body.classList.add("printing-tax-report");
    window.print();
    setTimeout(() => document.body.classList.remove("printing-tax-report"), 0);
  };
}

function wireTaxReport() {
  const btn = document.getElementById("tax-report-link");
  if (btn) btn.addEventListener("click", openTaxReportModal);
}

// ── Sorting + filtering ──────────────────────────────────────────────────────

// Compare two invoices for the master sort. Bucket by status group,
// then by date desc within the bucket. Drafts use createdAt (they
// have no issuedAt yet); everything else prefers issuedAt and falls
// back to createdAt as a safety net.
function compareInvoices(a, b) {
  const ba = STATUS_BUCKETS[a.derivedStatus] ?? 99;
  const bb = STATUS_BUCKETS[b.derivedStatus] ?? 99;
  if (ba !== bb) return ba - bb;

  const dateA = asDate(a.issuedAt) || asDate(a.createdAt) || new Date(0);
  const dateB = asDate(b.issuedAt) || asDate(b.createdAt) || new Date(0);
  return dateB.getTime() - dateA.getTime(); // desc
}

// Apply the current filter pill.
function visibleInvoices() {
  let list = allInvoices.slice();

  if (activeStatus !== "all") {
    list = list.filter(inv => getDisplayStatus(inv) === activeStatus);
  }

  list.sort(compareInvoices);
  return list;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMetrics() {
  const lang = getLang();
  const now  = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const isCoach = hasCoachRole(currentRoles);

  let dueTotal    = 0; // sent (incl. overdue), not yet paid
  let billedTotal = 0; // sent, not overdue
  let overdue     = 0; // subset: sent + dueAt < now
  let paidThisYr  = 0; // paid invoices with paidAt in current year

  allInvoices.forEach(inv => {
    if (isCoach && inv.status !== "void") {
      const paid = confirmedPaidAmount(inv);
      const remaining = remainingPaymentAmount(inv);
      if (inv.derivedStatus === "sent" || inv.derivedStatus === "overdue") {
        dueTotal += remaining;
        if (inv.derivedStatus === "sent") billedTotal += remaining;
        if (inv.derivedStatus === "overdue") overdue += remaining;
      }
      const paidAt = asDate(inv.paidAt) || asDate(inv.partialPaidAt);
      if (paid > 0 && paidAt && paidAt.getTime() >= yearStart.getTime()) paidThisYr += paid;
      return;
    }

    if (!isCoach && inv.paymentSent && inv.status !== "paid") {
      const submitted = submittedPaymentAmount(inv);
      const remaining = remainingPaymentAmount(inv);
      dueTotal += remaining;
      const dueAt = asDate(inv.dueAt);
      if (dueAt && dueAt.getTime() < now.getTime()) overdue += remaining;
      const paidAt = asDate(inv.paidAt);
      if (paidAt && paidAt.getTime() >= yearStart.getTime()) paidThisYr += submitted;
      return;
    }

    if (inv.derivedStatus === "sent" || inv.derivedStatus === "overdue") {
      dueTotal += inv.total;
    }
    if (inv.derivedStatus === "sent") {
      billedTotal += inv.total;
    }
    if (inv.derivedStatus === "overdue") {
      overdue += inv.total;
    }
    if (inv.derivedStatus === "paid") {
      const paidAt = asDate(inv.paidAt);
      if (paidAt && paidAt.getTime() >= yearStart.getTime()) {
        paidThisYr += inv.total;
      }
    }
  });

  const billableTotal = addAmounts(...billableGroups.map(g => g.totalCents || 0));

  document.getElementById("metricOutstanding").textContent = formatMoney(isCoach ? billedTotal : dueTotal, lang);
  document.getElementById("metricOverdue").textContent     = formatMoney(overdue, lang);
  document.getElementById("metricPaid").textContent        = formatMoney(paidThisYr, lang);

  const labelEl = document.getElementById("metricPaidLabel");
  if (labelEl) {
    labelEl.textContent = isCoach ? t("payEarned") : `${t("payPaidInPayer")} ${now.getFullYear()}`;
  }

  const dueLabelEl = document.getElementById("metricOutstanding").parentElement.querySelector(".pay-metric-label");
  if (dueLabelEl) {
    dueLabelEl.textContent = t(isCoach ? "payBilled" : "payDueAmount");
  }

  const metricsEl = document.getElementById("payMetrics");
  const uninvoicedCard = document.getElementById("metricUninvoicedCard");
  if (metricsEl && uninvoicedCard) {
    metricsEl.classList.toggle("has-uninvoiced", true);
    uninvoicedCard.style.display = "";
    const uninvoicedLabel = uninvoicedCard.querySelector(".pay-metric-label");
    if (uninvoicedLabel) {
      uninvoicedLabel.textContent = t(isCoach ? "payBillable" : "payUninvoiced");
    }
    document.getElementById("metricUninvoiced").textContent =
      formatMoney(isCoach ? billableTotal : payerUninvoicedTotal, lang);
  }
}

function renderFilterCounts() {
  // Inject a small count badge into each filter pill. Only non-zero
  // counts are shown so empty buckets stay quiet.
  const counts = { all: allInvoices.length, draft: 0, sent: 0, due: 0, overdue: 0, paid: 0, void: 0 };
  allInvoices.forEach(inv => {
    const status = getDisplayStatus(inv);
    if (counts[status] != null) counts[status] += 1;
  });

  document.querySelectorAll(".pay-filter").forEach(btn => {
    const status = btn.dataset.status;
    const baseLabel = t(
      status === "all"     ? "payFilterAll" :
      status === "draft"   ? "payFilterDraft" :
      status === "sent"    ? "payFilterSent" :
      status === "due"     ? "payFilterDue" :
      status === "overdue" ? "payFilterOverdue" :
      status === "paid"    ? "payFilterPaid" :
      "payFilterVoid"
    );
    const n = counts[status] || 0;
    btn.innerHTML = n > 0
      ? `${baseLabel}<span class="pay-filter-count">${n}</span>`
      : baseLabel;
  });
}

function renderRow(inv) {
  const lang = getLang();
  const isCoach = hasCoachRole(currentRoles);

  let mainName, subText;
  if (isCoach) {
    mainName = inv.skaterName || "—";
    // "via [parent]" only when the invoice has a denormalized payerName.
    let viaLine = "";
    if (inv.payerName) {
      viaLine = `${t("payVia")} ${escapeHtml(inv.payerName)} · `;
    }
    // Sessions count
    const sessionsLabel = inv.itemCount === 1 ? t("sessionSingular") : t("sessionPlural");
    const sessionsText = `${inv.itemCount} ${sessionsLabel}`;
    const invNumPart = inv.invoiceNumber ? ` · ${escapeHtml(inv.invoiceNumber)}` : "";
    subText = `${viaLine}${escapeHtml(sessionsText)}${invNumPart}`;
  } else {
    // For payers: show invoice number as main, skater name in sub, coach in sub
    mainName = inv.invoiceNumber || "—";
    subText = inv.skaterName || "—";
    if (inv.payerName && inv.payerName !== inv.skaterName) {
      subText += ` (${t("payVia")} ${escapeHtml(inv.payerName)})`;
    }
    if (inv.coachName) {
      subText += ` · ${escapeHtml(inv.coachName)}`;
    }
    if (inv.creditApplied > 0) {
      subText += ` · ${t("creditApplied")}: −${formatMoney(inv.creditApplied, lang)}`;
    }
  }

  const submitted = submittedPaymentAmount(inv);
  const remaining = remainingPaymentAmount(inv);
  const confirmedPaid = Math.max(0, Number(inv.paidAmount) || 0);
  const showRemaining = remaining > 0 && (submitted > 0 || (isCoach && confirmedPaid > 0));
  const displayStatus = getDisplayStatus(inv);
  const interestAmount = overdueInterestAmount(inv);
  const displayAmount = invoiceTotalWithOverdueInterest(inv);

  // Right-side meta line: due date for sent/due/overdue, paid date for
  // paid, "—" for drafts and void. Overdue gets red text via the
  // .is-overdue modifier so it reads as urgent.
  let metaText = "—";
  let metaClass = "";
  if (displayStatus === "due" || displayStatus === "sent" || displayStatus === "overdue") {
    const due = asDate(inv.dueAt);
    metaText = `${t("payDue")} ${formatShortDate(due, lang)}`;
    if (displayStatus === "overdue") metaClass = "is-overdue";
  } else if (displayStatus === "paid") {
    metaText = formatShortDate(asDate(inv.paidAt), lang);
  }

  // Status pill: label + color class. Overdue is the only status that
  // doesn't match Firestore's stored value (it's derived) so we map
  // explicitly.
  const pillLabel = t(
    displayStatus === "draft"   ? "payStatusDraft" :
    displayStatus === "sent"    ? "payStatusSent" :
    displayStatus === "due"     ? "payStatusDue" :
    displayStatus === "overdue" ? "payStatusOverdue" :
    displayStatus === "paid"    ? "payStatusPaid" :
    "payStatusVoid"
  );
  const pillClass = `pay-pill-${displayStatus === "due" ? "sent" : displayStatus}`;

  return `
    <div class="pay-row" data-id="${escapeHtml(inv.id)}">
      <div class="pay-row-main">
        <div class="pay-row-top">
          <span class="pay-row-name">${escapeHtml(mainName)}</span>
          <span class="pay-pill ${pillClass}">${escapeHtml(pillLabel)}</span>
        </div>
        <div class="pay-row-sub">${escapeHtml(subText)}</div>
      </div>
      <div class="pay-row-right">
        <div class="pay-row-amount${showRemaining ? " pay-row-amount-strikethrough" : ""}">${escapeHtml(formatMoney(displayAmount, lang))}</div>
        ${interestAmount > 0 ? `<div class="pay-row-remaining pay-row-interest">+ ${escapeHtml(formatMoney(interestAmount, lang))} ${escapeHtml(t("overdueInterest"))}</div>` : ""}
        ${showRemaining ? `<div class="pay-row-remaining">${escapeHtml(t("paymentRemaining"))}: ${escapeHtml(formatMoney(remaining, lang))}</div>` : ""}
        <div class="pay-row-meta ${metaClass}">${escapeHtml(metaText)}</div>
      </div>
    </div>
  `;
}

function renderList() {
  const list    = visibleInvoices();
  const listEl  = document.getElementById("payList");
  const emptyEl = document.getElementById("payEmpty");

  if (list.length === 0) {
    listEl.style.display  = "none";
    emptyEl.style.display = "";

    // Different empty-state copy depending on why it's empty:
    //   - allInvoices.length === 0 → no invoices ever
    //   - else → current filter/search returned nothing
    const textEl = document.getElementById("payEmptyText");
    const ctaEl  = document.getElementById("payEmptyCta");
    const isCoach = hasCoachRole(currentRoles);
    if (allInvoices.length === 0) {
      textEl.textContent = t(isCoach ? "payEmptyAll" : "payEmptyAllPayer");
      ctaEl.textContent  = t(isCoach ? "payEmptyCtaAll" : "payEmptyCtaAllPayer");
      ctaEl.style.display = "";
    } else {
      textEl.textContent = t("payEmptyFiltered");
      // Hide the dashboard CTA when the issue is just a filter — the
      // user doesn't need to leave the page, they need to widen
      // their criteria.
      ctaEl.style.display = "none";
    }
    return;
  }

  emptyEl.style.display = "none";
  listEl.style.display  = "";
  listEl.innerHTML = list.map(renderRow).join("");

  // Wire row click → invoice detail page. MP-124 will build the
  // detail page; for now this navigates to a placeholder URL the
  // detail-page ticket will create. We pass the id via querystring
  // so the same URL works for both coach and parent views.
  listEl.querySelectorAll(".pay-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      const inv = allInvoices.find(x => x.id === id);
      if (inv && (!hasCoachRole(currentRoles) || inv.status === "sent" || inv.status === "paid" || inv.status === "void")) {
        openSentInvoiceModal(id);
        return;
      }
      window.location.href = `invoice.html?id=${encodeURIComponent(id)}`;
    });
  });
}

function renderPaymentConfirmations() {
  const section = document.getElementById("paymentConfirmations");
  if (!section) return;
  if (!hasCoachRole(currentRoles) || !paymentConfirmations.length) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }

  const confirmationMeta = (c) => [
    c.invoiceNumber || "-",
    c.skaterName || "-",
    formatMoney(c.total || 0, getLang()),
    c.paymentMethod ? paymentMethodLabel(c.paymentMethod) : "",
  ].filter(Boolean).join(" · ");

  section.innerHTML = paymentConfirmations.map(c => `
    <div class="payment-confirmation" data-id="${escapeHtml(c.id)}" data-invoice-id="${escapeHtml(c.invoiceId)}">
      <div>
        <div class="payment-confirmation-title">${escapeHtml(t("paymentConfirmTitle"))}</div>
        <div class="payment-confirmation-sub">
          ${escapeHtml(c.invoiceNumber || "—")} · ${escapeHtml(c.skaterName || "—")} · ${escapeHtml(formatMoney(c.total || 0, getLang()))}
        </div>
      </div>
      <button type="button" class="payment-confirmation-btn">${escapeHtml(t("paymentConfirmAction"))}</button>
    </div>
  `).join("");

  section.querySelectorAll(".payment-confirmation-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".payment-confirmation");
      const confirmation = paymentConfirmations.find(c => c.id === row.dataset.id);
      if (confirmation) openPaymentConfirmationModal(confirmation);
    });
  });
  section.style.display = "";
}

function renderAll() {
  renderMetrics();
  renderFilterCounts();
  renderPaymentConfirmations();
  renderList();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireFilters() {
  document.querySelectorAll(".pay-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      activeStatus = btn.dataset.status;
      document.querySelectorAll(".pay-filter").forEach(b => b.classList.toggle("active", b === btn));
      renderList();
    });
  });
}

// ── Billable sessions ────────────────────────────────────────────────────────

function formatTime(mins) {
  if (!mins) return "0 min";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h ${m}min`;
}

async function loadUnbilledSessions(coachUid) {
  const q = query(
    collection(db, "sessions"),
    where("coachUid", "==", coachUid),
  );
  const snap = await getDocs(q);
  const now = new Date();
  const out = [];
  snap.forEach(d => {
    const data = d.data();
    if (data.invoiceId) return;
    const start = data.date && data.date.toDate ? data.date.toDate() : null;
    if (!start) return;
    const end = new Date(start.getTime() + (data.duration || 0) * 60 * 1000);
    if (end >= now) return;
    out.push({ id: d.id, ...data });
  });
  return out;
}

function getBillingPeriodStart(settings) {
  const now = new Date();
  const cadence = settings?.cadence || "weekly";
  if (cadence === "monthly") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const dow = now.getDay();
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMon);
  monday.setHours(0, 0, 0, 0);
  if (cadence === "biweekly") monday.setDate(monday.getDate() - 7);
  return monday;
}

async function checkHasAffiliateCoaches(coachUid) {
  try {
    const [connSnap, subcoachSnap] = await Promise.all([
      getDocs(query(
        collection(db, "connections"),
        where("participants", "array-contains", coachUid)
      )),
      getDocs(collection(db, "users", coachUid, "subcoaches")),
    ]);
    if (!subcoachSnap.empty) return true;
    return connSnap.docs.some(d => {
      const data = d.data();
      if (data.status !== "accepted") return false;
      const otherUid = (data.participants || []).find(id => id !== coachUid);
      return (data.roles?.[otherUid] || []).includes("affiliateCoach");
    });
  } catch {
    return false;
  }
}

async function loadAffiliatePeriodSessions(coachUid, periodStart) {
  const snap = await getDocs(query(
    collection(db, "sessions"),
    where("coachUid", "==", coachUid)
  ));
  const now = new Date();
  const out = [];
  snap.forEach(d => {
    const data = d.data();
    if (!data.subcoachUid) return;
    const start = data.date?.toDate?.() || null;
    if (!start || start < periodStart) return;
    if (new Date(start.getTime() + (data.duration || 0) * 60000) >= now) return;
    out.push({ id: d.id, ...data });
  });
  return out;
}

function resolveSessionSkaterName(session) {
  const userDocs  = window.__billUserDocs  || {};
  const childDocs = window.__billChildDocs || {};
  const childId = (session.children || [])[0];
  const fullName = (() => {
    if (childId && childDocs[childId]) return formatFullName(childDocs[childId]);
    const uid = (session.participants || []).find(u => u !== session.coachUid);
    if (uid && userDocs[uid]) return formatFullName(userDocs[uid]);
    return null;
  })();
  if (!fullName) return "—";
  return fullName.trim().split(/\s+/)[0];
}

async function resolveAffiliatePeriodDocs(sessions) {
  const userDocs  = window.__billUserDocs  || {};
  const childDocs = window.__billChildDocs || {};
  const missingUids     = new Set();
  const missingChildIds = new Set();
  sessions.forEach(s => {
    (s.participants || []).forEach(uid => {
      if (uid !== s.coachUid && !userDocs[uid]) missingUids.add(uid);
    });
    (s.children || []).forEach(cid => {
      if (!childDocs[cid]) missingChildIds.add(cid);
    });
  });
  await Promise.all([
    ...[...missingUids].map(async uid => {
      try { const snap = await getDoc(doc(db, "users", uid)); if (snap.exists()) userDocs[uid] = snap.data(); } catch {}
    }),
    ...[...missingChildIds].map(async cid => {
      try { const snap = await getDoc(doc(db, "children", cid)); if (snap.exists()) childDocs[cid] = snap.data(); } catch {}
    }),
  ]);
  window.__billUserDocs  = userDocs;
  window.__billChildDocs = childDocs;
}

function openMyCoachesModal() {
  const modal = document.getElementById("myCoachesModal");
  const body  = document.getElementById("myCoachesBody");
  modal.style.display = "flex";
  body.innerHTML = `<div style="text-align:center;padding:24px;color:#5E6C84;">Loading…</div>`;
  const periodStart = getBillingPeriodStart(billPaySettings);
  loadAffiliatePeriodSessions(currentUser.uid, periodStart)
    .then(async sessions => {
      if (!sessions.length) {
        body.innerHTML = `<div style="text-align:center;padding:24px;color:#5E6C84;">No affiliate sessions this period.</div>`;
        return;
      }
      await resolveAffiliatePeriodDocs(sessions);
      renderMyCoachesAffiliateList(sessions, periodStart);
    })
    .catch(err => {
      console.error("loadAffiliatePeriodSessions:", err);
      body.innerHTML = `<div style="color:#AE2A19;padding:16px;">Could not load sessions.</div>`;
    });
}

function renderMyCoachesAffiliateList(sessions, periodStart) {
  const body = document.getElementById("myCoachesBody");
  const lang = getLang();
  const byAffiliate = new Map();
  sessions.forEach(s => {
    const uid = s.subcoachUid;
    if (!byAffiliate.has(uid)) byAffiliate.set(uid, { uid, name: s.subcoachName || uid, sessions: [] });
    byAffiliate.get(uid).sessions.push(s);
  });
  const periodLabel = periodStart.toLocaleDateString(
    lang === "fr" ? "fr-CA" : "en-US", { month: "short", day: "numeric" }
  );
  body.innerHTML = [...byAffiliate.values()].map(a => {
    const count = a.sessions.length;
    const total = a.sessions.reduce((sum, s) => sum + computeLineCents(s), 0);
    return `
      <div class="my-coaches-card" data-uid="${escapeHtml(a.uid)}"
           style="cursor:pointer;padding:14px 16px;border:1px solid #DFE1E6;border-radius:8px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div>
          <div style="font-weight:600;font-size:14px;color:#172B4D;">${escapeHtml(a.name)}</div>
          <div style="font-size:12px;color:#5E6C84;margin-top:2px;">${count} session${count !== 1 ? "s" : ""} · since ${escapeHtml(periodLabel)}</div>
        </div>
        <span style="font-size:14px;font-weight:600;color:#172B4D;white-space:nowrap;">${escapeHtml(formatMoney(total, lang))}</span>
      </div>`;
  }).join("");
  body.onclick = e => {
    const card = e.target.closest(".my-coaches-card");
    if (!card) return;
    body.onclick = null;
    const aff = byAffiliate.get(card.dataset.uid);
    if (aff) renderMyCoachesSessionList(aff.sessions, aff.name, sessions, periodStart);
  };
}

function renderMyCoachesSessionList(sessions, affiliateName, allSessions, periodStart) {
  const body = document.getElementById("myCoachesBody");
  const lang = getLang();
  const rows = sessions.map(s => {
    const skaterName = resolveSessionSkaterName(s);
    const d = s.date?.toDate?.();
    const dayStr = d
      ? d.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { weekday: "short", month: "short", day: "numeric" })
      : "—";
    return `
      <div style="padding:12px 0;border-bottom:1px solid #F4F5F7;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:500;color:#172B4D;">${escapeHtml(skaterName)}</div>
          <div style="font-size:11px;color:#5E6C84;margin-top:2px;">${escapeHtml(dayStr)}</div>
        </div>
        <span style="font-size:13px;font-weight:600;color:#172B4D;white-space:nowrap;">${escapeHtml(formatMoney(computeLineCents(s), lang))}</span>
      </div>`;
  }).join("");
  const total = sessions.reduce((sum, s) => sum + computeLineCents(s), 0);
  body.innerHTML = `
    <button id="myCoachesBack" style="background:none;border:none;cursor:pointer;color:#0052CC;font-size:13px;padding:0 0 14px;display:flex;align-items:center;gap:6px;">
      &#8592; ${escapeHtml(affiliateName)}
    </button>
    <div>${rows || `<div style="color:#5E6C84;font-size:13px;padding:8px 0;">No sessions found.</div>`}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #DFE1E6;padding-top:10px;margin-top:4px;font-weight:600;font-size:14px;color:#172B4D;">
      <span>Total</span>
      <span>${escapeHtml(formatMoney(total, lang))}</span>
    </div>`;
  document.getElementById("myCoachesBack").onclick =
    () => renderMyCoachesAffiliateList(allSessions, periodStart);
}

async function loadBillPaySettings(coachUid) {
  try {
    const s = await getDoc(doc(db, "paymentSettings", coachUid));
    return s.exists() ? s.data() : null;
  } catch (err) {
    console.warn("Could not load paymentSettings:", err);
    return null;
  }
}

async function loadAcceptedPaymentMethods(inv) {
  let settings = null;
  let settingsError = "";
  try {
    const snap = await getDoc(doc(db, "paymentSettings", inv.coachUid));
    settings = snap.exists() ? snap.data() : null;
    if (!snap.exists()) settingsError = "paymentSettings doc does not exist";
  } catch (err) {
    settingsError = err && err.code ? err.code : String(err);
  }
  const fromSettings = normalizePaymentMethods(settings?.acceptedMethods);
  const fromInvoice = normalizePaymentMethods(inv.acceptedMethods);
  return {
    methods: fromSettings.length ? fromSettings : fromInvoice,
    debug: {
      settingsError,
      rawSettingsMethods: settings?.acceptedMethods,
      rawInvoiceMethods: inv.acceptedMethods,
    },
  };
}

async function loadCoachOverdueInterestBps(coachUid) {
  if (!coachUid) return 0;
  try {
    const snap = await getDoc(doc(db, "paymentSettings", coachUid));
    return snap.exists() ? Math.max(0, Number(snap.data().overdueInterestBps) || 0) : 0;
  } catch (err) {
    console.warn("Could not load overdue interest setting:", err);
    return 0;
  }
}

async function loadCoachReportSettings(coachUid) {
  if (!coachUid) return null;
  try {
    const snap = await getDoc(doc(db, "paymentSettings", coachUid));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      overdueInterestBps: Math.max(0, Number(data.overdueInterestBps) || 0),
      taxEnabled: !!data.taxEnabled,
      gstRate: Number(data.gstRate) || PLATFORM_GST_RATE,
      qstRate: Number(data.qstRate) || PLATFORM_QST_RATE,
    };
  } catch (err) {
    console.warn("Could not load coach report settings:", err);
    return null;
  }
}

async function hydrateMissingInvoiceInterestRates(invoices) {
  const coachIds = [...new Set(invoices
    .filter(inv => !inv.overdueInterestBps && inv.coachUid)
    .map(inv => inv.coachUid))];
  if (!coachIds.length) return;
  const pairs = await Promise.all(coachIds.map(async uid => [uid, await loadCoachOverdueInterestBps(uid)]));
  const byCoach = new Map(pairs);
  invoices.forEach(inv => {
    if (!inv.overdueInterestBps) inv.overdueInterestBps = byCoach.get(inv.coachUid) || 0;
  });
}

async function hydrateInvoiceReportSettings(invoices) {
  const coachIds = [...new Set(invoices
    .filter(inv => inv.coachUid)
    .map(inv => inv.coachUid))];
  if (!coachIds.length) return;
  const pairs = await Promise.all(coachIds.map(async uid => [uid, await loadCoachReportSettings(uid)]));
  const byCoach = new Map(pairs);
  invoices.forEach(inv => {
    const settings = byCoach.get(inv.coachUid);
    if (!settings) return;
    if (!inv.overdueInterestBps) inv.overdueInterestBps = settings.overdueInterestBps;
    inv.coachTaxEnabled = settings.taxEnabled;
    inv.coachGstRate = settings.gstRate;
    inv.coachQstRate = settings.qstRate;
  });
}

async function resolveSkatersAndPayers(allSessions) {
  const userUids = new Set(), childIds = new Set();
  allSessions.forEach(s => {
    (s.participants || []).forEach(uid => { if (uid !== s.coachUid) userUids.add(uid); });
    (s.children || []).forEach(cid => childIds.add(cid));
  });
  const userDocs = {}, childDocs = {}, parentUidsToFetch = new Set();
  await Promise.all([
    ...[...userUids].map(async uid => {
      try { const s = await getDoc(doc(db, "users", uid)); if (s.exists()) userDocs[uid] = s.data(); } catch {}
    }),
    ...[...childIds].map(async cid => {
      try {
        const s = await getDoc(doc(db, "children", cid));
        if (s.exists()) { childDocs[cid] = s.data(); if (s.data().parentId) parentUidsToFetch.add(s.data().parentId); }
      } catch {}
    }),
  ]);
  const parentDocs = {};
  await Promise.all([...parentUidsToFetch].map(async uid => {
    if (userDocs[uid]) { parentDocs[uid] = userDocs[uid]; return; }
    try { const s = await getDoc(doc(db, "users", uid)); if (s.exists()) parentDocs[uid] = s.data(); } catch {}
  }));
  return { userDocs, childDocs, parentDocs };
}

function sessionPriceCents(s) {
  const amount = (typeof s.priceAmount === "number" && s.priceAmount > 0) ? s.priceAmount : 0;
  if (amount) {
    // Modern session docs store priceAmount in dollars. Some legacy/default
    // paths can carry cents (1500 for $15), so normalize both shapes.
    return Number.isInteger(amount) && amount >= 1000 ? amount : toCents(amount);
  }

  const fallbackHourly = Number(billPaySettings?.hourlyRate) || 0;
  return fallbackHourly > 0 ? fallbackHourly : 0;
}

function computeLineCents(s) {
  const mode = (s.priceMode === "hourly" || s.priceMode === "flat") ? s.priceMode : "hourly";
  const amountCents = sessionPriceCents(s);
  if (!amountCents) return 0;
  const duration = (typeof s.duration === "number" && s.duration > 0) ? s.duration : 0;
  if (!duration) return 0;
  const attendees = (typeof s.attendeeCount === "number" && s.attendeeCount > 0) ? s.attendeeCount : 1;
  if (mode === "flat") return multiplyAmount(amountCents, 1 / attendees);
  return multiplyAmount(amountCents, duration / 60);
}

function payerSessionPriceCents(s) {
  const amount = (typeof s.priceAmount === "number" && s.priceAmount > 0) ? s.priceAmount : 0;
  if (!amount) return 0;
  return Number.isInteger(amount) && amount >= 1000 ? amount : toCents(amount);
}

function payerStakeForSession(session, viewerUid, viewerChildIdSet) {
  const childMatches = (session.children || []).filter(cid => viewerChildIdSet.has(cid)).length;
  let stake = childMatches;
  if (childMatches === 0 && (session.participants || []).includes(viewerUid) && viewerUid !== session.coachUid) {
    stake += 1;
  }
  return stake;
}

function payerShareCents(session, viewerUid, viewerChildIdSet) {
  const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
  if (!duration) return 0;

  const amountCents = payerSessionPriceCents(session);
  if (!amountCents) return 0;

  const stake = payerStakeForSession(session, viewerUid, viewerChildIdSet);
  if (stake <= 0) return 0;

  const types = Array.isArray(session.type) ? session.type : [];
  const isPrivate = types.includes("private");
  const mode = session.priceMode === "flat" ? "flat" : "hourly";
  const children = Array.isArray(session.children) ? session.children.length : 0;
  const participants = Array.isArray(session.participants) ? session.participants.length : 0;
  let splitBy = 1;

  if (isPrivate) {
    splitBy = 1;
  } else if (typeof session.attendeeCount === "number" && session.attendeeCount > 0) {
    splitBy = session.attendeeCount;
  } else if (children > 0 || participants > 1) {
    splitBy = children + Math.max(0, participants - 1);
    if (splitBy === 0) splitBy = participants || 1;
  } else {
    splitBy = participants || 1;
  }

  const stakeCap = isPrivate
    ? (typeof session.attendeeCount === "number" && session.attendeeCount > 0
        ? session.attendeeCount
        : Math.max(1, children + Math.max(0, participants - 1) || participants || 1))
    : splitBy;
  const cappedStake = Math.min(stake, stakeCap);

  if (mode === "flat") return multiplyAmount(amountCents, cappedStake / splitBy);
  return multiplyAmount(amountCents, (duration / 60) * (cappedStake / splitBy));
}

async function loadPayerUninvoicedTotal(userUid) {
  const childIdSet = new Set();
  try {
    const childrenSnap = await getDocs(
      query(collection(db, "children"), where("parentId", "==", userUid))
    );
    childrenSnap.forEach(d => childIdSet.add(d.id));
  } catch (err) {
    console.warn("children read failed for uninvoiced metric:", err);
  }

  const snap = await getDocs(
    query(collection(db, "sessions"), where("participants", "array-contains", userUid))
  );
  const now = new Date();
  let total = 0;
  snap.forEach(d => {
    const session = { id: d.id, ...d.data() };
    if (session.invoiceId) return;
    const start = session.date && session.date.toDate ? session.date.toDate() : null;
    if (!start) return;
    const duration = (typeof session.duration === "number" && session.duration > 0) ? session.duration : 0;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    if (end >= now) return;
    total += payerShareCents(session, userUid, childIdSet);
  });
  return total;
}

function buildBillableGroups(sessions) {
  const taxEnabled = !!(billPaySettings && billPaySettings.taxEnabled);
  const gstRate = (billPaySettings && Number(billPaySettings.gstRate)) || PLATFORM_GST_RATE;
  const qstRate = (billPaySettings && Number(billPaySettings.qstRate)) || PLATFORM_QST_RATE;
  const buckets = new Map();
  sessions.forEach(s => {
    (s.participants || []).forEach(uid => {
      if (uid === s.coachUid) return;
      const u = (window.__billUserDocs || {})[uid];
      const roles = u && Array.isArray(u.rolesArray) ? u.rolesArray : [];
      const isSkaterUser = u && (roles.includes("skater") || roles.length === 0);
      const isParentOnly = u && roles.includes("parent") && !roles.includes("skater");
      if (!u || isParentOnly || !isSkaterUser) return;
      const key = `u:${uid}`;
      if (!buckets.has(key)) buckets.set(key, { key, skaterId: uid, skaterName: formatFullName(u) || "—", payerName: null, skaterRef: `users/${uid}`, sessions: [] });
      buckets.get(key).payerUid = uid;
      buckets.get(key).sessions.push(s);
    });
    (s.children || []).forEach(cid => {
      const c = (window.__billChildDocs || {})[cid];
      if (!c) return;
      const parent = (window.__billParentDocs || {})[c.parentId];
      const key = `c:${cid}`;
      if (!buckets.has(key)) buckets.set(key, { key, skaterId: cid, skaterName: formatFullName(c) || "—", payerName: parent ? (formatFullName(parent) || null) : null, skaterRef: `children/${cid}`, sessions: [] });
      buckets.get(key).payerUid = c.parentId || null;
      buckets.get(key).sessions.push(s);
    });
  });

  // Merge child groups into parent cards
  const mergedBuckets = new Map();
  const childBucketsByParent = new Map();
  const childKeysToSkip = new Set();

  buckets.forEach(group => {
    if (group.skaterRef && group.skaterRef.startsWith("children/") && group.payerUid) {
      if (!childBucketsByParent.has(group.payerUid)) {
        childBucketsByParent.set(group.payerUid, []);
      }
      childBucketsByParent.get(group.payerUid).push(group);
      childKeysToSkip.add(group.key);
    }
  });

  buckets.forEach(group => {
    if (childKeysToSkip.has(group.key)) return;
    if (group.skaterRef && group.skaterRef.startsWith("users/") && childBucketsByParent.has(group.skaterId)) return;
    mergedBuckets.set(group.key, group);
  });

  childBucketsByParent.forEach((childGroups, parentUid) => {
    const parent = (window.__billParentDocs || {})[parentUid];
    const parentName = parent ? formatFullName(parent) || "—" : "—";
    const childNames = childGroups.map(g => g.skaterName || "—");
    const childFirstNames = childNames.map(n => (n || "").trim().split(/\s+/)[0] || "—");

    mergedBuckets.set(`p:${parentUid}`, {
      key: `p:${parentUid}`,
      skaterId: parentUid,
      skaterName: parentName,
      childFirstNames,
      payerName: null,
      skaterRef: `users/${parentUid}`,
      payerUid: parentUid,
      sessions: childGroups.flatMap(g => g.sessions),
    });
  });

  const out = [];
  mergedBuckets.forEach(b => {
    const lineCentsArr = b.sessions.map(s => computeLineCents(s));
    const subtotalCents = addAmounts(...lineCentsArr);
    const { gstCents, qstCents, totalCents } = calculateTaxTotals(subtotalCents, {
      taxEnabled,
      gstRate,
      qstRate,
    });
    const totalMinutes = b.sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    out.push({ ...b, subtotalCents, gstCents, qstCents, totalCents, totalMinutes });
  });
  out.sort((a, b) => a.skaterName.localeCompare(b.skaterName));
  return out;
}

function renderBillableSection() {
  const section = document.getElementById("billableSection");
  const listEl  = document.getElementById("billableList");
  if (!billableGroups.length) { section.style.display = "none"; return; }

  const lang = getLang();

  listEl.innerHTML = "";
  billableGroups.forEach(g => {
    const card = document.createElement("div");
    card.className = "bill-card";
    const taxNote = (g.gstCents || g.qstCents)
      ? ` <span class="bill-card-tax">${escapeHtml(t("taxIncluded"))}</span>`
      : "";
    const childrenLabel = g.childFirstNames && g.childFirstNames.length
      ? ` (${escapeHtml(g.childFirstNames.join(", "))})`
      : "";
    const displayName = g.skaterName + childrenLabel;
    const payerUid = g.payerUid || g.skaterId;
    const creditDoc = credits.find(c => c.payerUid === payerUid);
    const creditBalance = creditDoc ? Math.max(0, Number(creditDoc.balanceCents) || 0) : 0;

    card.innerHTML = `
      <div class="bill-card-top">
        <div class="bill-card-name">${escapeHtml(displayName)}</div>
        <div class="bill-card-amount">${escapeHtml(formatMoney(g.totalCents, lang))}</div>
      </div>

      <div class="bill-card-sub">
        ${escapeHtml(formatTime(g.totalMinutes))}
        ${g.payerName ? " · via " + escapeHtml(g.payerName) : ""}
        ${taxNote}
      </div>

      ${creditBalance > 0 ? `<span class="pay-pill" style="background:#E3FCEF;color:#085041;margin-bottom:4px;">${escapeHtml(t("credited"))}: ${escapeHtml(formatMoney(creditBalance, lang))}</span>` : ""}
      ${g.invoiceStatus === "sent" || g.invoiceStatus === "paid"
        ? `<span class="pay-pill pay-pill-${g.invoiceStatus}">${escapeHtml(t(g.invoiceStatus === "paid" ? "payStatusPaid" : "payStatusSent"))}</span>`
        : `<button class="bill-card-btn">${escapeHtml(t("payGenerateInvoice"))}</button>`}
    `;
    const btn = card.querySelector(".bill-card-btn");
    if (btn) {
      btn.addEventListener("click", async () => {
        openInvoiceModal(g, currentUser.uid);
      });
    }
    const invoicePill = card.querySelector(".pay-pill-sent, .pay-pill-paid");
    if (invoicePill && g.invoiceId) {
      invoicePill.style.cursor = "pointer";
      invoicePill.addEventListener("click", () => openSentInvoiceModal(g.invoiceId));
    }
    listEl.appendChild(card);
  });
  section.style.display = "";
}

function setInvoiceModalMode(mode) {
  const isDetails = mode === "details";
  const taxBlock = document.querySelector("#invoiceModal .invoice-tax-toggle");
  const saveBtn = document.getElementById("modalSaveDraft");
  const sendBtn = document.getElementById("modalSendInvoice");
  const cancelBtn = document.getElementById("modalCancel");
  const deleteBtn = document.getElementById("modalDeleteInvoice");

  if (taxBlock) {
    taxBlock.style.display = "";
    const cb = taxBlock.querySelector("input[type=checkbox]");
    if (cb) cb.disabled = isDetails;
  }
  if (saveBtn) saveBtn.style.display = isDetails ? "none" : "";
  if (sendBtn) sendBtn.style.display = isDetails ? "none" : "";
  if (deleteBtn) {
    deleteBtn.style.display = "none";
    deleteBtn.disabled = false;
    deleteBtn.textContent = t("archiveInvoice");
    deleteBtn.onclick = null;
  }
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = t("buttonSendInvoice");
    sendBtn.onclick = null;
    sendBtn.className = "btn btn-primary";
  }
  if (cancelBtn) cancelBtn.textContent = isDetails ? t("buttonClose") : t("buttonCancel");
}

function openInvoiceModal(group, coachUid) {
  const lang = getLang();
  const modal = document.getElementById("invoiceModal");
  const detailsEl = document.getElementById("invoiceDetails");
  const taxToggle = document.getElementById("invoiceTaxToggle");
  document.getElementById("modalTitle").textContent = "Invoice Details";
  setInvoiceModalMode("create");
  
  const taxEnabled = !!(billPaySettings && billPaySettings.taxEnabled);
  const gstRate = (billPaySettings && Number(billPaySettings.gstRate)) || PLATFORM_GST_RATE;
  const qstRate = (billPaySettings && Number(billPaySettings.qstRate)) || PLATFORM_QST_RATE;

  taxToggle.checked = false;
  taxToggle.disabled = !taxEnabled;

  const lineCentsArr = group.sessions.map(s => computeLineCents(s));
  const subtotalCents = addAmounts(...lineCentsArr);

  const invoiceGroupForTaxChoice = () => {
    const addTaxLines = taxEnabled && !taxToggle.checked;
    const taxIncluded = taxEnabled && taxToggle.checked;
    const includedTaxes = taxIncluded
      ? includedTaxAmounts(subtotalCents, gstRate, qstRate)
      : { gstCents: 0, qstCents: 0 };
    const gstCents = addTaxLines ? multiplyAmount(subtotalCents, gstRate) : includedTaxes.gstCents;
    const qstCents = addTaxLines ? multiplyAmount(subtotalCents, qstRate) : includedTaxes.qstCents;
    const netSubtotalCents = taxIncluded
      ? Math.max(0, subtotalCents - gstCents - qstCents)
      : subtotalCents;
    return {
      ...group,
      subtotalCents: netSubtotalCents,
      gstCents,
      qstCents,
      taxIncluded,
      totalCents: addTaxLines ? subtotalCents + gstCents + qstCents : subtotalCents,
    };
  };

  const renderInvoicePreview = () => {
    const previewGroup = invoiceGroupForTaxChoice();
    const tr = translations[lang] || {};
    const mainCoachName = formatFullName(currentUserData) || "—";
    const itemsHtml = group.sessions.map(s => {
      const lineCents = computeLineCents(s);
      const dateStr = s.date?.toDate
        ? s.date.toDate().toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
            weekday: "short", month: "short", day: "numeric",
          })
        : "—";
      const types = Array.isArray(s.type) ? s.type : [];
      let typeKey = "sessionTypeOther";
      if (types.includes("private"))      typeKey = "sessionTypePrivate";
      else if (types.includes("group"))   typeKey = "sessionTypeGroup";
      else if (types.includes("off-ice")) typeKey = "sessionTypeOffIce";
      const typeLabel = tr[typeKey] || typeKey;
      const timeStr = (s.iceStart && s.iceEnd) ? `${s.iceStart} – ${s.iceEnd}` : "";
      const coachDisplay = s.subcoachName || mainCoachName;
      const coachRole = s.subcoachName
        ? (tr.affiliateCoach || "Affiliate coach")
        : (tr.coach || "Coach");
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px;">
          <div style="min-width:0;">
            <div style="font-size:13px;color:#172B4D;">${escapeHtml(dateStr)}${timeStr ? ` · ${escapeHtml(timeStr)}` : ""} · ${escapeHtml(typeLabel)}</div>
            <div style="font-size:11px;color:#5E6C84;margin-top:1px;">${escapeHtml(coachRole)}: ${escapeHtml(coachDisplay)}</div>
          </div>
          <span style="font-size:13px;white-space:nowrap;font-weight:500;">${escapeHtml(formatMoney(lineCents, lang))}</span>
        </div>`;
    }).join("");

    detailsEl.innerHTML = `
      <div style="margin-bottom:12px;">
        <strong>${escapeHtml(group.skaterName)}</strong>
        ${group.payerName ? `<div style="font-size:12px;color:#5E6C84;">${escapeHtml(tr.payVia || "via")} ${escapeHtml(group.payerName)}</div>` : ""}
      </div>
      ${itemsHtml}
      ${!previewGroup.taxIncluded ? `<div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #DFE1E6;padding-top:8px;margin-bottom:8px;">
        <span>${escapeHtml(tr.invSubtotal || "Subtotal")}</span>
        <span>${escapeHtml(formatMoney(previewGroup.subtotalCents, lang))}</span>
      </div>` : ""}
      ${!previewGroup.taxIncluded && previewGroup.gstCents > 0 ? `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <span>GST (${Math.round((gstRate * 1000)) / 10}%)</span>
        <span>${escapeHtml(formatMoney(previewGroup.gstCents, lang))}</span>
      </div>` : ""}
      ${!previewGroup.taxIncluded && previewGroup.qstCents > 0 ? `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <span>QST (${Math.round((qstRate * 1000)) / 10}%)</span>
        <span>${escapeHtml(formatMoney(previewGroup.qstCents, lang))}</span>
      </div>` : ""}
      <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #DFE1E6;padding-top:8px;font-weight:600;">
        <span>Total</span>
        <span>${escapeHtml(formatMoney(previewGroup.totalCents, lang))}</span>
      </div>
    `;
  };

  renderInvoicePreview();
  taxToggle.onchange = renderInvoicePreview;
  
  modal.style.display = "flex";
  modal.dataset.groupKey = group.key;
  
  // Attach event handlers
  document.getElementById("modalClose").onclick = () => { modal.style.display = "none"; };
  document.getElementById("modalCancel").onclick = () => { modal.style.display = "none"; };
  document.getElementById("modalSaveDraft").onclick = async () => {
    const created = await createInvoice(invoiceGroupForTaxChoice(), coachUid, "draft");
    if (created) modal.style.display = "none";
  };
  document.getElementById("modalSendInvoice").onclick = async () => {
    const created = await createInvoice(invoiceGroupForTaxChoice(), coachUid, "send");
    if (created) modal.style.display = "none";
  };
}

async function openSentInvoiceModal(invoiceId) {
  const lang = getLang();
  const modal = document.getElementById("invoiceModal");
  const detailsEl = document.getElementById("invoiceDetails");

  setInvoiceModalMode("details");
  document.getElementById("modalTitle").textContent = "Invoice Details";
  detailsEl.innerHTML = `<div style="font-size:13px;color:#5E6C84;">${escapeHtml(t("payLoading"))}</div>`;
  modal.style.display = "flex";
  document.getElementById("modalClose").onclick = () => { modal.style.display = "none"; };
  document.getElementById("modalCancel").onclick = () => { modal.style.display = "none"; };

  let inv = null;
  let isFullySubmittedForActions = false;
  try {
    const invSnap = await getDoc(doc(db, "invoices", invoiceId));
    if (!invSnap.exists()) throw new Error("invoice_missing");
    inv = { id: invSnap.id, ...invSnap.data() };
    inv.derivedStatus = deriveStatus(inv, new Date());
    const itemsSnap = await getDocs(
      query(collection(db, "invoices", invoiceId, "items"), orderBy("position"))
    );
    const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const sentDate = asDate(inv.issuedAt) || asDate(inv.proposedIssuedAt);
    const dueDate = asDate(inv.dueAt) || asDate(inv.proposedDueAt);
    const paidDate = asDate(inv.paidAt);
    const localInv = allInvoices.find(x => x.id === invoiceId);
    if (localInv) {
      inv.overdueInterestBps = localInv.overdueInterestBps || inv.overdueInterestBps;
      if (inv.derivedStatus !== "paid") {
        inv.derivedStatus = localInv.derivedStatus || inv.derivedStatus;
      }
      inv.paidAmount = localInv.paidAmount || inv.paidAmount;
      if (localInv.paymentSent) {
        inv.paymentSent = true;
        inv.paymentSubmittedAmount = localInv.paymentSubmittedAmount;
        inv.paidAt = localInv.paidAt || inv.paidAt;
      }
      // Sync fresh Firestore data back into local cache so the row card
      // reflects any status change (e.g. coach marked paid) without reload.
      if (inv.status !== localInv.status || inv.derivedStatus !== localInv.derivedStatus) {
        localInv.status = inv.status;
        localInv.derivedStatus = inv.derivedStatus;
        localInv.paidAmount = inv.paidAmount;
        localInv.paidAt = inv.paidAt;
        renderAll();
      }
    }
    const remainingAmount = remainingPaymentAmount(inv);
    const confirmedPaid = Math.max(0, Number(inv.paidAmount) || 0);
    const isFullySubmitted = !!inv.paymentSent && remainingAmount === 0;
    isFullySubmittedForActions = isFullySubmitted;
    const isPartiallySubmitted = !!inv.paymentSent && remainingAmount > 0;
    const isPartiallyPaid = confirmedPaid > 0 && remainingAmount > 0;
    const hasPartialPaymentInfo = isPartiallyPaid || isPartiallySubmitted;
    const submittedAmount = submittedPaymentAmount(inv);
    const submittedDate = asDate(inv.paidAt);
    const partialDisplayAmount = isPartiallyPaid ? confirmedPaid : submittedAmount;
    const partialDisplayDate = isPartiallyPaid
      ? (asDate(inv.partialPaidAt) || submittedDate)
      : submittedDate;
    const interestAmount = overdueInterestAmount(inv);
    const interestRate = overdueInterestBps(inv) / 100;
    const displayTotal = invoiceTotalWithOverdueInterest(inv);
    const modalStatus = hasCoachRole(currentRoles)
      ? (inv.derivedStatus || inv.status)
      : (inv.status === "paid" || isFullySubmitted ? "paid" : (inv.derivedStatus === "overdue" ? "overdue" : "due"));
    const modalPillClass = modalStatus === "due" ? "sent" : modalStatus;
    const modalPillKey =
      modalStatus === "paid" ? "payStatusPaid" :
      modalStatus === "due"  ? "payStatusDue" :
      modalStatus === "overdue" ? "payStatusOverdue" :
      modalStatus === "void" ? "payStatusVoid" :
      modalStatus === "draft" ? "payStatusDraft" :
      "payStatusSent";
    const skaterFirst = inv.skaterName ? inv.skaterName.trim().split(/\s+/)[0] : "—";
    const itemRows = items.length
      ? items.map(item => {
          const rawCoach = item.subcoachName || inv.coachName || "";
          const coachFirst = rawCoach ? rawCoach.trim().split(/\s+/)[0] : "—";
          const rinkPart = item.rinkName ? escapeHtml(item.rinkName) + " · " : "";
          return `
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:10px;align-items:flex-start;">
            <div style="min-width:0;">
              <div style="font-size:13px;color:#172B4D;">Coach ${escapeHtml(coachFirst)} · Skater ${escapeHtml(skaterFirst)}</div>
              <div style="font-size:11px;color:#5E6C84;margin-top:2px;">${rinkPart}${escapeHtml(item.description || "—")}</div>
            </div>
            <span style="font-size:13px;white-space:nowrap;">${escapeHtml(formatMoney(item.lineTotal || 0, lang))}</span>
          </div>`;
        }).join("")
      : `<div style="font-size:13px;color:#5E6C84;margin-bottom:8px;">—</div>`;

    detailsEl.innerHTML = `
      <div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
          <strong>${escapeHtml(inv.invoiceNumber || "—")}</strong>
          <span class="pay-pill pay-pill-${modalPillClass}">${escapeHtml(t(modalPillKey))}</span>
        </div>
        <div style="font-size:12px;color:#5E6C84;">
          ${escapeHtml(inv.skaterName || "—")}
          ${inv.payerName ? ` · ${escapeHtml(t("payVia"))} ${escapeHtml(inv.payerName)}` : ""}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
        <div>
          <div style="font-size:11px;color:#5E6C84;">${escapeHtml(t("paySentDate"))}</div>
          <div style="font-size:13px;color:#172B4D;">${escapeHtml(formatLongDate(sentDate, lang))}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#5E6C84;">${escapeHtml(t("payDue"))}</div>
          <div style="font-size:13px;color:#172B4D;">${escapeHtml(formatLongDate(dueDate, lang))}</div>
        </div>
        ${paidDate ? `
          <div>
            <div style="font-size:11px;color:#5E6C84;">${escapeHtml(t("payPaidDate"))}</div>
            <div style="font-size:13px;color:#172B4D;">${escapeHtml(formatLongDate(paidDate, lang))}</div>
          </div>
        ` : ""}
      </div>
      ${itemRows}
      <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #DFE1E6;padding-top:8px;margin-bottom:8px;">
        <span>Subtotal</span>
        <span>${escapeHtml(formatMoney(inv.subtotal || 0, lang))}</span>
      </div>
      ${(inv.gstAmount || 0) > 0 ? `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <span>GST${inv.taxIncluded ? " (incl.)" : ""}</span>
        <span>${escapeHtml(formatMoney(inv.gstAmount || 0, lang))}</span>
      </div>` : ""}
      ${(inv.qstAmount || 0) > 0 ? `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <span>QST${inv.taxIncluded ? " (incl.)" : ""}</span>
        <span>${escapeHtml(formatMoney(inv.qstAmount || 0, lang))}</span>
      </div>` : ""}
      <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #DFE1E6;padding-top:8px;font-weight:600;">
        <span>Total</span>
        <span style="${hasPartialPaymentInfo && interestAmount === 0 ? "text-decoration:line-through;color:#5E6C84;font-weight:500;" : ""}">${escapeHtml(formatMoney(inv.total || 0, lang))}</span>
      </div>
      ${interestAmount > 0 ? `
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:8px;padding:8px 10px;border:1px solid #F5A097;background:#FFEBE9;color:#AE2A19;font-weight:700;border-radius:6px;">
          <span>${escapeHtml(t("overdueInterest"))} (${escapeHtml(String(interestRate))}%)</span>
          <span>${escapeHtml(formatMoney(interestAmount, lang))}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #DFE1E6;padding-top:8px;margin-top:8px;font-weight:700;">
          <span>${escapeHtml(t("totalDue"))}</span>
          <span style="${hasPartialPaymentInfo ? "text-decoration:line-through;color:#5E6C84;font-weight:500;" : ""}">${escapeHtml(formatMoney(displayTotal, lang))}</span>
        </div>
      ` : ""}
      ${hasPartialPaymentInfo ? `
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;color:#5E6C84;font-size:13px;">
          <span>${escapeHtml(t("paymentPaid"))}${partialDisplayDate ? ` ${escapeHtml(formatShortDate(partialDisplayDate, lang))}` : ""}</span>
          <span>${escapeHtml(formatMoney(partialDisplayAmount, lang))}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-weight:700;color:#172B4D;">
          <span>${escapeHtml(t("paymentRemaining"))}</span>
          <span>${escapeHtml(formatMoney(remainingAmount, lang))}</span>
        </div>
      ` : ""}
      ${(inv.notes || "").trim() ? `<div style="border-top:1px solid #DFE1E6;margin-top:12px;padding-top:10px;font-size:12px;color:#5E6C84;">${escapeHtml(inv.notes)}</div>` : ""}
    `;
  } catch (err) {
    console.error("Failed to open invoice modal:", err);
    detailsEl.innerHTML = `<div style="font-size:13px;color:#C9372C;">${escapeHtml(t("loadFailed"))}</div>`;
    return;
  }

  const taxToggle = document.getElementById("invoiceTaxToggle");
  if (taxToggle && inv) taxToggle.checked = !!inv.taxIncluded;

  const markPaidBtn = document.getElementById("modalSendInvoice");
  const deleteBtn = document.getElementById("modalDeleteInvoice");
  if (hasCoachRole(currentRoles) && inv.status === "void" && deleteBtn) {
    deleteBtn.style.display = "";
    deleteBtn.onclick = () => archiveVoidInvoiceFromModal(inv.id);
  }
  const actionIsPaid = inv.status === "paid" || (!hasCoachRole(currentRoles) && isFullySubmittedForActions);
  if (actionIsPaid) {
    markPaidBtn.style.display = "";
    markPaidBtn.className = "btn btn-primary";
    markPaidBtn.textContent = t("printInvoice");
    markPaidBtn.onclick = () => window.print();
  } else if (hasCoachRole(currentRoles) && inv.status === "sent") {
    markPaidBtn.style.display = "";
    markPaidBtn.className = "btn btn-success";
    markPaidBtn.textContent = t("invMarkPaid");
    markPaidBtn.onclick = () => markInvoicePaidFromModal(inv.id);
  } else if (!hasCoachRole(currentRoles) && inv.status === "sent") {
    const localInv = allInvoices.find(x => x.id === inv.id);
    markPaidBtn.style.display = "";
    markPaidBtn.className = "btn btn-primary";
    markPaidBtn.textContent = localInv && localInv.paymentSent ? t("paymentSent") : t("paymentSentAction");
    markPaidBtn.onclick = () => openPayerPaymentForm(inv);
  }
}

async function openPayerPaymentForm(inv) {
  const detailsEl = document.getElementById("invoiceDetails");
  const btn = document.getElementById("modalSendInvoice");
  const existingForm = document.getElementById("paymentSubmitForm");
  if (existingForm) {
    existingForm.scrollIntoView({ block: "nearest" });
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = t("payLoading");

  const methodResult = await loadAcceptedPaymentMethods(inv);
  const methods = methodResult.methods;
  if (!methods.length) {
    btn.disabled = false;
    btn.textContent = originalText;
    const debug = methodResult.debug || {};
    alert([
      t("paymentNoMethods"),
      `coachUid: ${inv.coachUid || "missing"}`,
      `settings read: ${debug.settingsError || "ok"}`,
      `settings acceptedMethods: ${JSON.stringify(debug.rawSettingsMethods || null)}`,
      `invoice acceptedMethods: ${JSON.stringify(debug.rawInvoiceMethods || null)}`,
    ].join("\n"));
    return;
  }
  const selected = methods[0];
  const amountValue = fromCents(remainingPaymentAmount(inv) || invoiceTotalWithOverdueInterest(inv)).toFixed(2);

  detailsEl.insertAdjacentHTML("beforeend", `
    <div class="payment-submit-form" id="paymentSubmitForm">
      <div class="payment-submit-title">${escapeHtml(t("paymentDetailsTitle"))}</div>
      <div class="payment-method-options" id="paymentMethodOptions">
        ${methods.map(method => `
          <label>
            <input type="radio" name="paymentMethod" value="${escapeHtml(method)}" ${method === selected ? "checked" : ""} />
            <span>${escapeHtml(paymentMethodLabel(method))}</span>
          </label>
        `).join("")}
      </div>
      <div class="payment-submit-field" id="paymentSecretWrap" style="${selected === "etransfer" ? "" : "display:none;"}">
        <label for="paymentSecret">${escapeHtml(t("paymentSecret"))}</label>
        <input type="text" id="paymentSecret" autocomplete="off" />
      </div>
      <div class="payment-submit-field">
        <label for="paymentAmount">${escapeHtml(t("paymentAmount"))}</label>
        <input type="text" inputmode="decimal" id="paymentAmount" value="${escapeHtml(amountValue)}" />
      </div>
    </div>
  `);

  document.getElementById("paymentMethodOptions").addEventListener("change", () => {
    const method = document.querySelector('input[name="paymentMethod"]:checked')?.value || "";
    document.getElementById("paymentSecretWrap").style.display = method === "etransfer" ? "" : "none";
  });

  btn.disabled = false;
  btn.textContent = t("buttonComplete");
  btn.onclick = async () => {
    const method = document.querySelector('input[name="paymentMethod"]:checked')?.value || "";
    const amountCents = toCents(document.getElementById("paymentAmount").value);
    if (!method || amountCents <= 0) {
      alert(t("paymentDetailsRequired"));
      return;
    }
    const secret = method === "etransfer" ? document.getElementById("paymentSecret").value.trim() : "";
    const sent = await sendPaymentConfirmation(inv.id, { method, secret, amountCents });
    if (!sent) {
      btn.disabled = false;
      btn.textContent = t("buttonComplete");
    }
  };
  if (originalText === t("paymentSent")) btn.textContent = t("buttonComplete");
}

async function markInvoicePaidFromModal(invoiceId) {
  if (!window.confirm(t("invMarkPaidConfirm"))) return;
  const btn = document.getElementById("modalSendInvoice");
  const modal = document.getElementById("invoiceModal");
  const paidAt = new Date();

  btn.disabled = true;
  btn.textContent = t("invMarkPaid");

  try {
    const inv = allInvoices.find(x => x.id === invoiceId);
    const paidAmount = inv ? invoiceTotalWithOverdueInterest(inv) : 0;
    await updateDoc(doc(db, "invoices", invoiceId), {
      status: "paid",
      paidAmount,
      paidAt: serverTimestamp(),
    });

    if (inv) {
      inv.status = "paid";
      inv.derivedStatus = "paid";
      inv.paidAmount = paidAmount;
      inv.paidAt = Timestamp.fromDate(paidAt);
    }

    const billableGroup = billableGroups.find(g => g.invoiceId === invoiceId);
    if (billableGroup) billableGroup.invoiceStatus = "paid";

    modal.style.display = "none";
    renderBillableSection();
    renderAll();
  } catch (err) {
    console.error("Mark paid failed:", err);
    btn.disabled = false;
    btn.textContent = t("invMarkPaid");
  }
}

async function archiveVoidInvoiceFromModal(invoiceId) {
  const inv = allInvoices.find(x => x.id === invoiceId);
  if (!inv || inv.status !== "void" || inv.coachUid !== currentUser.uid) return;
  if (!window.confirm(t("confirmArchiveInvoice") || "Archive this void invoice and hide it from payments?")) return;

  const btn = document.getElementById("modalDeleteInvoice");
  const modal = document.getElementById("invoiceModal");
  const originalText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("archiveInvoice") || "Archive";
  }

  try {
    const invoiceRef = doc(db, "invoices", invoiceId);
    try {
      await updateDoc(invoiceRef, {
        archivedAt: serverTimestamp(),
        archivedBy: currentUser.uid,
      });
    } catch (archiveErr) {
      if (archiveErr && archiveErr.code === "permission-denied") {
        // Deployed invoice rules can block both archive and delete. Store a
        // coach-local hide marker instead; payment.html filters these out.
        await setDoc(doc(db, "users", currentUser.uid, "hiddenInvoices", invoiceId), {
          invoiceId,
          hiddenAt: serverTimestamp(),
          hiddenBy: currentUser.uid,
          reason: "void_invoice_archive",
        });
        hiddenInvoiceIds.add(invoiceId);
      } else {
        throw archiveErr;
      }
    }

    allInvoices = allInvoices.filter(x => x.id !== invoiceId);
    modal.style.display = "none";
    renderAll();
  } catch (err) {
    console.error("Archive void invoice failed:", err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    alert(t("archiveInvoiceFailed") || "Could not archive invoice. Please try again.");
  }
}

function openPaymentConfirmationModal(confirmation) {
  const lang = getLang();
  const modal = document.getElementById("invoiceModal");
  const detailsEl = document.getElementById("invoiceDetails");
  const confirmBtn = document.getElementById("modalSendInvoice");
  const cancelBtn = document.getElementById("modalCancel");
  const deleteBtn = document.getElementById("modalDeleteInvoice");
  const saveBtn = document.getElementById("modalSaveDraft");
  const submittedAt = asDate(confirmation.sentAt);
  const amountValue = fromCents(confirmation.total || 0).toFixed(2);
  const inv = allInvoices.find(x => x.id === confirmation.invoiceId);
  const invoiceTotal = Number(confirmation.invoiceTotal) || 0;
  const confirmedPaid = Math.max(0, Number(inv?.paidAmount) || 0);
  const balanceDue = Math.max(0, invoiceTotal - confirmedPaid);

  setInvoiceModalMode("details");
  document.getElementById("modalTitle").textContent = t("paymentConfirmTitle");
  if (deleteBtn) deleteBtn.style.display = "none";
  if (saveBtn) saveBtn.style.display = "none";
  confirmBtn.style.display = "";
  confirmBtn.className = "btn btn-success";
  confirmBtn.textContent = t("paymentConfirmAction");
  confirmBtn.disabled = false;
  cancelBtn.textContent = t("buttonCancel");
  detailsEl.innerHTML = `
    <div style="margin-bottom:14px;">
      <strong>${escapeHtml(confirmation.invoiceNumber || "-")}</strong>
      <div style="font-size:12px;color:#5E6C84;margin-top:4px;">${escapeHtml(confirmation.skaterName || "-")}</div>
    </div>
    ${invoiceTotal > 0 ? `
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <span>${escapeHtml(t("totalDue"))}</span>
        <span>${escapeHtml(formatMoney(invoiceTotal, lang))}</span>
      </div>
    ` : ""}
    ${confirmedPaid > 0 ? `
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;color:#5E6C84;">
        <span>${escapeHtml(t("paymentPaid"))}</span>
        <span>-${escapeHtml(formatMoney(confirmedPaid, lang))}</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:12px;font-weight:600;border-bottom:1px solid #DFE1E6;padding-bottom:8px;">
        <span>${escapeHtml(t("paymentRemaining"))}</span>
        <span>${escapeHtml(formatMoney(balanceDue, lang))}</span>
      </div>
    ` : `${invoiceTotal > 0 ? `<div style="margin-bottom:12px;border-bottom:1px solid #DFE1E6;"></div>` : ""}`}
    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <span>${escapeHtml(t("paymentMethod"))}</span>
      <span>${escapeHtml(paymentMethodLabel(confirmation.paymentMethod || ""))}</span>
    </div>
    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <span>${escapeHtml(t("paymentPaid"))}</span>
      <span>${escapeHtml(submittedAt ? formatLongDate(submittedAt, lang) : "-")}</span>
    </div>
    ${confirmation.paymentMethod === "etransfer" && confirmation.eTransferSecret ? `
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:12px;">
        <span>${escapeHtml(t("paymentSecret"))}</span>
        <span>${escapeHtml(confirmation.eTransferSecret)}</span>
      </div>
    ` : ""}
    <div class="payment-submit-field">
      <label for="confirmPaymentAmount">${escapeHtml(t("paymentAmount"))}</label>
      <input type="text" inputmode="decimal" id="confirmPaymentAmount" value="${escapeHtml(amountValue)}" />
    </div>
  `;
  modal.style.display = "flex";
  document.getElementById("modalClose").onclick = () => { modal.style.display = "none"; };
  cancelBtn.onclick = () => { modal.style.display = "none"; };
  confirmBtn.onclick = () => {
    const amountCents = toCents(document.getElementById("confirmPaymentAmount").value);
    if (amountCents <= 0) {
      alert(t("paymentDetailsRequired"));
      return;
    }
    confirmPayerPayment(confirmation.id, confirmation.invoiceId, amountCents);
  };
}

async function confirmPayerPayment(confirmationId, invoiceId, amountCents = null) {
  const paidAt = new Date();
  const inv = allInvoices.find(x => x.id === invoiceId);
  const previousPaid = confirmedPaidAmount(inv);
  const confirmedAmount = Math.max(0, Number(amountCents) || 0);
  const totalDue = invoiceTotalWithOverdueInterest(inv);
  const totalPaid = Math.min(totalDue, previousPaid + confirmedAmount);
  const isFullyPaid = totalPaid >= totalDue;
  try {
    await updateDoc(doc(db, "invoices", invoiceId), {
      status: isFullyPaid ? "paid" : "sent",
      paidAmount: totalPaid,
      partialPaidAt: serverTimestamp(),
      ...(isFullyPaid ? { paidAt: serverTimestamp() } : {}),
    });
    await updateDoc(doc(db, "users", currentUser.uid, "paymentConfirmations", confirmationId), {
      status: "confirmed",
      confirmedAt: serverTimestamp(),
      confirmedBy: currentUser.uid,
    });

    const overpayment = confirmedAmount - (totalDue - previousPaid);
    if (overpayment > 0 && inv && inv.coachUid && inv.payerUid) {
      const creditId = `${inv.coachUid}_${inv.payerUid}`;
      const creditRef = doc(db, "credits", creditId);
      const creditSnap = await getDoc(creditRef);
      const existingBalance = creditSnap.exists()
        ? Math.max(0, Number(creditSnap.data().balanceCents) || 0)
        : 0;
      const newBalance = existingBalance + overpayment;
      await setDoc(creditRef, {
        coachUid: inv.coachUid,
        payerUid: inv.payerUid,
        balanceCents: newBalance,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      const existing = credits.find(c => c.id === creditId);
      if (existing) existing.balanceCents = newBalance;
      else credits.push({ id: creditId, coachUid: inv.coachUid, payerUid: inv.payerUid, balanceCents: newBalance });
    }

    if (inv) {
      inv.paidAmount = totalPaid;
      inv.partialPaidAt = Timestamp.fromDate(paidAt);
      if (isFullyPaid) {
        inv.status = "paid";
        inv.derivedStatus = "paid";
        inv.paidAt = Timestamp.fromDate(paidAt);
      }
    }
    paymentConfirmations = paymentConfirmations.filter(c => c.id !== confirmationId);
    document.getElementById("invoiceModal").style.display = "none";
    renderAll();
  } catch (err) {
    console.error("Confirm payment failed:", err);
  }
}

async function sendPaymentConfirmation(invoiceId, paymentDetails = {}) {
  const inv = allInvoices.find(x => x.id === invoiceId);
  if (!inv) return false;
  const existing = paymentConfirmations.find(c => c.invoiceId === invoiceId && c.status === "pending");
  const sentAt = new Date();
  const amountCents = Number(paymentDetails.amountCents) > 0
    ? Number(paymentDetails.amountCents)
    : remainingPaymentAmount(inv);

  try {
    let confirmation = existing;
    if (!confirmation) {
      const payload = {
        invoiceId,
        invoiceNumber: inv.invoiceNumber || "",
        coachUid: inv.coachUid,
        payerUid: currentUser.uid,
        skaterName: inv.skaterName || "",
        payerName: inv.payerName || formatFullName(currentUserData) || "",
        total: amountCents,
        invoiceTotal: invoiceTotalWithOverdueInterest(inv),
        paymentMethod: paymentDetails.method || "",
        eTransferSecret: paymentDetails.secret || "",
        status: "pending",
        sentAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, "users", inv.coachUid, "paymentConfirmations"), payload);
      await addDoc(collection(db, "users", currentUser.uid, "paymentConfirmations"), payload);
      confirmation = {
        id: ref.id,
        invoiceId,
        status: "pending",
        sentAt: Timestamp.fromDate(sentAt),
        total: amountCents,
        paymentMethod: paymentDetails.method || "",
      };
      paymentConfirmations.push(confirmation);
    }

    inv.paymentSent = true;
    inv.paymentSubmittedAmount = amountCents;
    inv.paidAt = confirmation.sentAt || Timestamp.fromDate(sentAt);
    if (remainingPaymentAmount(inv) === 0) {
      inv.derivedStatus = "paid";
    }
    renderAll();
    document.getElementById("invoiceModal").style.display = "none";
    return true;
  } catch (err) {
    console.error("Payment confirmation failed:", err);
    return false;
  }
}

function describeSession(s) {
  const lang = getLang();
  const dateStr = s.date && s.date.toDate
    ? s.date.toDate().toLocaleDateString(
        lang === "fr" ? "fr-CA" : "en-US",
        { month: "short", day: "numeric" }
      )
    : "—";
  const types = Array.isArray(s.type) ? s.type : [];
  let typeKey = "sessionTypeOther";
  if (types.includes("private"))      typeKey = "sessionTypePrivate";
  else if (types.includes("group"))   typeKey = "sessionTypeGroup";
  else if (types.includes("off-ice")) typeKey = "sessionTypeOffIce";
  const typeLabel = (translations[lang] || {})[typeKey] || typeKey;
  const minLabel = (translations[lang] || {})["minutes"] || "min";
  return `${dateStr} · ${typeLabel} ${s.duration || 0} ${minLabel}`;
}

async function createInvoice(group, coachUid, action) {
  if (window.__creatingInvoice) return;
  window.__creatingInvoice = true;
  const btn = action === "draft" 
    ? document.getElementById("modalSaveDraft") 
    : document.getElementById("modalSendInvoice");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = action === "draft" ? "Saving…" : "Sending…";
  
try {
  const counterReady = await ensureCounterSeeded();
  if (!counterReady) throw new Error("counter_seed_failed");
  const createdInvoiceId = await commitOneDraft(group, coachUid, action === "send");

  if (action === "send") {
    const sentGroup = billableGroups.find(x => x.key === group.key);
    if (sentGroup) {
      sentGroup.invoiceStatus = "sent";
      sentGroup.invoiceId = createdInvoiceId;
    }
  } else {
    billableGroups = billableGroups.filter(x => x.key !== group.key);
  }
  allInvoices = await loadInvoices(coachUid, currentRoles);
  renderBillableSection();
  renderAll();
  return true;

} catch (err) {
  console.error(err);
  const fallback = action === "draft"
    ? "Could not save draft. Please try again."
    : "Could not send invoice. Please try again.";
  const key = action === "draft" ? "invoiceDraftFailed" : "invoiceSendFailed";
  const msg = t(key);
  alert(msg === key ? fallback : msg);
  return false;

} finally {
  window.__creatingInvoice = false;
  btn.disabled = false;
  btn.textContent = originalText;
}
}

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

async function commitOneDraft(group, coachUid, shouldSend = false) {
  const invoiceRef = doc(collection(db, "invoices"));
  const counterRef = doc(db, "system", "invoices");
  const defaultDays = (billPaySettings && Number(billPaySettings.defaultDueDays)) || 14;
  const now = new Date();
  const due = new Date(now.getTime() + defaultDays * 24 * 60 * 60 * 1000);
  const mode = group.sessions[0] && group.sessions[0].priceMode === "flat" ? "flat" : "hourly";
  const itemsData = group.sessions.map((s, idx) => ({
    sessionId: s.id,
    description: describeSession(s),
    rinkName: s.rink || "",
    subcoachName: s.subcoachName || null,
    sessionDate: s.date || null,
    durationMinutes: s.duration || 0,
    priceMode: mode,
    priceAmount: sessionPriceCents(s),
    attendeeCount: s.attendeeCount || 1,
    lineTotal: computeLineCents(s),
    position: idx,
  }));

  const payerUidForCredit = group.payerUid || group.skaterId;
  const creditId = `${coachUid}_${payerUidForCredit}`;
  const creditRef = doc(db, "credits", creditId);
  let appliedCredit = 0;

  await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef);
    if (!counterSnap.exists()) throw new Error("counter_missing");
    const lastIssued = Number(counterSnap.data().lastIssued || 0);
    const nextNum = lastIssued + 1;

    const creditSnap = await tx.get(creditRef);
    const availableCredit = creditSnap.exists()
      ? Math.max(0, Number(creditSnap.data().balanceCents) || 0)
      : 0;
    appliedCredit = Math.min(availableCredit, group.totalCents);

    const sessionRefs = group.sessions.map(s => doc(db, "sessions", s.id));
    const sessionSnaps = await Promise.all(sessionRefs.map(r => tx.get(r)));
    sessionSnaps.forEach((snap, i) => {
      if (!snap.exists() || snap.data().invoiceId) throw new Error(`session_conflict:${group.sessions[i].id}`);
    });

    tx.set(invoiceRef, {
      invoiceNumber: formatInvoiceNumber(nextNum),
      coachUid,
      payerUid: payerUidForCredit,
      skaterUid: group.skaterId,
      skaterName: group.skaterName,
      skaterRef: group.skaterRef,
      payerName: group.payerName || null,
      coachName: currentUserData ? (formatFullName(currentUserData) || null) : null,
      status: "draft",
      issuedAt: null,
      dueAt: null,
      paidAt: null,
      overdueInterestBps: Math.max(0, Number(billPaySettings?.overdueInterestBps) || 0),
      createdAt: serverTimestamp(),
      proposedIssuedAt: Timestamp.fromDate(now),
      proposedDueAt: Timestamp.fromDate(due),
      subtotal: group.subtotalCents,
      gstAmount: group.gstCents,
      qstAmount: group.qstCents,
      taxIncluded: !!group.taxIncluded,
      discountAmount: 0,
      creditApplied: appliedCredit,
      total: group.totalCents,
      currency: "CAD",
      itemCount: group.sessions.length,
      acceptedMethods: Array.isArray(billPaySettings?.acceptedMethods) ? billPaySettings.acceptedMethods : ["etransfer"],
      notes: (billPaySettings && billPaySettings.invoiceNotes) || "",
    });

    if (appliedCredit > 0) {
      tx.set(creditRef, {
        coachUid,
        payerUid: payerUidForCredit,
        balanceCents: availableCredit - appliedCredit,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    sessionRefs.forEach(ref => tx.update(ref, { invoiceId: invoiceRef.id }));
    tx.update(counterRef, { lastIssued: nextNum });
  });

  if (appliedCredit > 0) {
    const existing = credits.find(c => c.id === creditId);
    if (existing) existing.balanceCents = Math.max(0, existing.balanceCents - appliedCredit);
  }

  await Promise.all(itemsData.map(it => {
    return setDoc(doc(collection(db, "invoices", invoiceRef.id, "items")), {
      ...it,
      invoiceId: invoiceRef.id,
    });
  }));

  if (shouldSend) {
    await updateDoc(invoiceRef, {
      status: "sent",
      issuedAt: Timestamp.fromDate(now),
      dueAt: Timestamp.fromDate(due),
    });
  }

  return invoiceRef.id;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

// Parse ?filter=<status> off the URL and apply it as the initial active
// filter pill, replacing the default "all". Used by paymentGenerate.js
// to land the coach on Drafts after a successful generation. Unknown
// values fall back to "all" silently.
function applyFilterFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    let f = (params.get("filter") || "").toLowerCase();
    if (!hasCoachRole(currentRoles) && f === "sent") f = "due";
    const known = hasCoachRole(currentRoles)
      ? ["all", "draft", "sent", "overdue", "paid", "void"]
      : ["all", "due", "overdue", "paid"];
    if (!known.includes(f)) return;
    activeStatus = f;
    document.querySelectorAll(".pay-filter").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.status === f);
    });
  } catch (_) {
    // No-op — bad URL just leaves the default "all" filter active.
  }
}

authGuard([], async (user, userData) => {
  currentUser  = user;
  currentUserData = userData;
  // Field name on the user doc is `rolesArray` (matches dashboard.js
  // and accountSettings.js). The legacy `roles` shape doesn't exist
  // in this codebase — keeping the fallback only as defense in depth
  // for stub/test fixtures.
  currentRoles = userData.rolesArray || userData.roles || [];

  applyLanguage();
  initNav("payment.html");
  injectNotificationBell(user.uid);

  // Set page title based on role
  const titleKey = hasCoachRole(currentRoles) ? "paymentsTitle" : "invoicesTitle";
  document.getElementById("page-title").textContent = t(titleKey);
  document.getElementById("page-title").setAttribute("data-key", titleKey);

  wireFilters();
  wireTaxReport();
  if (!hasCoachRole(currentRoles)) {
    const draftBtn = document.querySelector(".pay-filter-draft");
    const voidBtn = document.querySelector(".pay-filter-void");
    const sentBtn = document.querySelector(".pay-filter-sent");
    if (draftBtn) draftBtn.style.display = "none";
    if (voidBtn) voidBtn.style.display = "none";
    if (sentBtn) {
      sentBtn.dataset.status = "due";
      sentBtn.setAttribute("data-key", "payFilterDue");
      sentBtn.textContent = t("payFilterDue");
    }
  }

  // Apply ?filter=... AFTER wireFilters so the .active class toggles
  // are predictable; wireFilters only attaches click listeners, so
  // the initial visual state still comes from the HTML attribute and
  // gets overwritten here when a URL filter is present.
  applyFilterFromUrl();

  try {
    const [invoiceList, confirmations, hiddenIds] = await Promise.all([
      loadInvoices(user.uid, currentRoles),
      loadPaymentConfirmations(user.uid, currentRoles),
      loadHiddenInvoiceIds(user.uid),
    ]);
    hiddenInvoiceIds = hiddenIds;
    allInvoices = invoiceList.filter(inv => !hiddenInvoiceIds.has(inv.id));
    await hydrateMissingInvoiceInterestRates(allInvoices);
    if (!hasCoachRole(currentRoles)) {
      await hydrateInvoiceReportSettings(allInvoices);
    }
    paymentConfirmations = confirmations;
    applyPayerPaymentConfirmations();
    if (!hasCoachRole(currentRoles)) {
      const [uninvoicedTotal, payerCredits] = await Promise.all([
        loadPayerUninvoicedTotal(user.uid),
        loadPayerCredits(user.uid),
      ]);
      payerUninvoicedTotal = uninvoicedTotal;
      const totalCredit = payerCredits.reduce((sum, c) => sum + Math.max(0, Number(c.balanceCents) || 0), 0);
      if (totalCredit > 0) {
        const noticeEl = document.getElementById("payerCreditNotice");
        if (noticeEl) {
          noticeEl.textContent = `${t("creditBalance")}: ${formatMoney(totalCredit, getLang())}`;
          noticeEl.style.display = "";
        }
      }
    }

    // Only load billable sessions for coaches
    if (hasCoachRole(currentRoles)) {
      const [sessions, settings, hasAffiliates] = await Promise.all([
        loadUnbilledSessions(user.uid),
        loadBillPaySettings(user.uid),
        checkHasAffiliateCoaches(user.uid),
      ]);
      billPaySettings = settings;
      hasAffiliateSessions = hasAffiliates;
      const fallbackInterestBps = Math.max(0, Number(settings?.overdueInterestBps) || 0);
      allInvoices.forEach(inv => {
        if (!inv.overdueInterestBps) inv.overdueInterestBps = fallbackInterestBps;
      });
      if (sessions.length > 0) {
        const dirs = await resolveSkatersAndPayers(sessions);
        window.__billUserDocs   = dirs.userDocs;
        window.__billChildDocs  = dirs.childDocs;
        window.__billParentDocs = dirs.parentDocs;
        billableGroups = buildBillableGroups(sessions);
      }
      if (hasAffiliates) {
        try {
          const periodStart = getBillingPeriodStart(settings);
          const affiliateSessions = await loadAffiliatePeriodSessions(user.uid, periodStart);
          const affiliateTotal = affiliateSessions.reduce((sum, s) => sum + computeLineCents(s), 0);
          const affiliateCard = document.getElementById("metricAffiliateCard");
          const affiliateEl   = document.getElementById("metricAffiliate");
          if (affiliateCard && affiliateEl) {
            affiliateEl.textContent = formatMoney(affiliateTotal, getLang());
            affiliateCard.style.display = "";
          }
        } catch (e) {
          console.error("Failed to load affiliate metric:", e);
        }
      }
    }
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("payLoading").textContent = t("loadFailed");
    return;
  }

  document.getElementById("payLoading").style.display = "none";
  if (hasCoachRole(currentRoles)) {
    renderBillableSection();
    document.getElementById("payment-settings-link").style.display = "";
    if (hasAffiliateSessions) {
      document.getElementById("my-coaches-btn").style.display = "";
      document.getElementById("my-coaches-btn").onclick = openMyCoachesModal;
      document.getElementById("myCoachesClose").onclick = () => {
        document.getElementById("myCoachesModal").style.display = "none";
      };
    }
  }
  document.getElementById("tax-report-link").style.display = "";
  renderAll();
});
