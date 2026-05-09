// invoice.js — Coach invoice detail view (MP-124)
//
// Reads:
//   - invoices/{id}          — the invoice doc
//   - invoices/{id}/items    — line items subcollection, ordered by position
//
// Writes (coach only, own invoices):
//   - draft → sent           ("Send invoice" button)
//   - draft → void           ("Void" on draft)
//   - sent  → paid           ("Mark as paid")
//   - sent  → void           ("Void" on sent)
//   - notes field update     (draft and sent, per Firestore rules)
//
// URL: invoice.html?id=<invoiceId>
// Back link always returns to payment.html.

import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, escapeHtml, hasCoachRole } from "./app.js";
import { writeNotification, injectNotificationBell } from "./notifications.js";
import {
  doc, getDoc, collection, getDocs, query, orderBy,
  updateDoc, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { formatMoney, calculateOverdueInterest } from "./money.js";

// ── State ────────────────────────────────────────────────────────────────────

let inv = null; // hydrated invoice object (includes .items array)
let currentRoles = [];
let currentUserUid = null;
// ── Helpers ──────────────────────────────────────────────────────────────────

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  return null;
}

function formatLongDate(d, lang) {
  if (!d) return "—";
  return d.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function getInvoiceDisplayStatus(invoice) {
  if (invoice.status === "sent") {
    const due = asDate(invoice.dueAt);
    if (due && due.getTime() < Date.now()) return "overdue";
    return hasCoachRole(currentRoles) ? "sent" : "due";
  }
  return invoice.status;
}

function overdueInterestBps(invoice) {
  return Math.max(0, Number(invoice?.overdueInterestBps) || 0);
}

function overdueInterestAmount(invoice) {
  return calculateOverdueInterest({
    ...invoice,
    overdueInterestBps: overdueInterestBps(invoice),
  }, getInvoiceDisplayStatus(invoice) === "overdue");
}

function invoiceTotalWithOverdueInterest(invoice) {
  return (Number(invoice?.total) || 0) + overdueInterestAmount(invoice);
}

// Format a JS Date as YYYY-MM-DD for <input type="date">.
function toInputDate(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


function showError(msg) {
  const el = document.getElementById("invErrorBanner");
  el.textContent = msg;
  el.style.display = "";
}

function hideError() {
  document.getElementById("invErrorBanner").style.display = "none";
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadInvoice(id) {
  const invRef = doc(db, "invoices", id);
  const invSnap = await getDoc(invRef);
  if (!invSnap.exists()) return null;

  const data = invSnap.data();

  // Items subcollection ordered by the position field written at creation.
  const itemsSnap = await getDocs(
    query(collection(db, "invoices", id, "items"), orderBy("position"))
  );
  const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { id: invSnap.id, ...data, items };
}

async function hydrateOverdueInterestRate(invoice) {
  if (!invoice || Number(invoice.overdueInterestBps) > 0 || !invoice.coachUid) return invoice;
  try {
    const snap = await getDoc(doc(db, "paymentSettings", invoice.coachUid));
    if (snap.exists()) {
      invoice.overdueInterestBps = Math.max(0, Number(snap.data().overdueInterestBps) || 0);
    }
  } catch (err) {
    console.warn("Could not load overdue interest setting:", err);
  }
  return invoice;
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(invoice) {
  const lang = getLang();

  // Invoice number + status pill
  document.getElementById("invNumber").textContent = invoice.invoiceNumber || "—";

  const pillEl = document.getElementById("invStatusPill");
  const displayStatus = getInvoiceDisplayStatus(invoice);
  const statusKey =
    displayStatus === "draft"  ? "payStatusDraft"  :
    displayStatus === "sent"   ? "payStatusSent"   :
    displayStatus === "due"    ? "payStatusDue"    :
    displayStatus === "overdue" ? "payStatusOverdue" :
    displayStatus === "paid"   ? "payStatusPaid"   :
    "payStatusVoid";
  pillEl.textContent = t(statusKey);
  pillEl.className = `inv-pill inv-pill-${displayStatus === "due" ? "sent" : displayStatus}`;

  // Skater line: "Name" or "Name <span>via Parent</span>"
  let skaterHtml = escapeHtml(invoice.skaterName || "—");
  if (invoice.payerName) {
    skaterHtml += ` <span class="inv-via">${escapeHtml(t("payVia"))} ${escapeHtml(invoice.payerName)}</span>`;
  }
  document.getElementById("invSkaterLine").innerHTML = skaterHtml;

  // Coach line: main coach, or affiliate if subcoachName is set
  const coachEl = document.getElementById("invCoachLine");
  if (coachEl) {
    const coachLabel = invoice.subcoachName || invoice.coachName;
    coachEl.textContent = coachLabel ? `${t("coach") || "Coach"}: ${coachLabel}` : "";
  }

  renderDates(invoice, lang);
  renderItems(invoice.items || [], lang);
  renderTotals(invoice, lang);
  renderNotes(invoice);
  renderActions(invoice);
}

function renderDates(invoice, lang) {
  // Issued: use issuedAt for sent/paid/void; proposedIssuedAt for drafts.
  const issuedDate = asDate(invoice.issuedAt) || asDate(invoice.proposedIssuedAt);
  document.getElementById("invIssuedVal").textContent = formatLongDate(issuedDate, lang);

  if (invoice.status === "draft") {
    // Show editable date input for proposedDueAt.
    document.getElementById("invDueLabel").setAttribute("data-key", "invProposedDue");
    document.getElementById("invDueLabel").textContent = t("invProposedDue");
    document.getElementById("invDueVal").style.display = "none";
    const dueInput = document.getElementById("invDueInput");
    dueInput.value = toInputDate(asDate(invoice.proposedDueAt));
    dueInput.style.display = "";
  } else {
    const dueDate = asDate(invoice.dueAt) || asDate(invoice.proposedDueAt);
    document.getElementById("invDueVal").textContent = formatLongDate(dueDate, lang);
    document.getElementById("invDueVal").style.display = "";
    document.getElementById("invDueInput").style.display = "none";
  }

  if (invoice.status === "paid") {
    const paidRow = document.getElementById("invPaidRow");
    paidRow.style.display = "";
    document.getElementById("invPaidVal").textContent = formatLongDate(asDate(invoice.paidAt), lang);
  }
}

function renderItems(items, lang) {
  const container = document.getElementById("invItems");
  if (items.length === 0) {
    container.innerHTML = `<p style="font-size:13px;color:#5E6C84;margin:0;">—</p>`;
    return;
  }
  container.innerHTML = items.map(item => {
    const dateStr = item.sessionDate?.toDate
      ? item.sessionDate.toDate().toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
          weekday: "short", year: "numeric", month: "short", day: "numeric",
        })
      : null;
    const timeStr = (item.iceStart && item.iceEnd) ? `${item.iceStart} – ${item.iceEnd}` : null;
    const metaLine = [dateStr, timeStr].filter(Boolean).join(" · ");
    const coachMeta = item.subcoachName
      ? `<div style="font-size:11px;color:#5E6C84;margin-top:1px;">${escapeHtml(item.subcoachName)}</div>`
      : "";
    return `
      <div class="inv-item" style="align-items:flex-start;">
        <div class="inv-item-desc">
          <div>${escapeHtml(item.description || "—")}</div>
          ${metaLine ? `<div style="font-size:11px;color:#5E6C84;margin-top:1px;">${escapeHtml(metaLine)}</div>` : ""}
          ${coachMeta}
        </div>
        <span class="inv-item-amount" style="padding-top:1px;">${escapeHtml(formatMoney(item.lineTotal, lang))}</span>
      </div>`;
  }).join("");
}

function renderTotals(invoice, lang) {
  const hasTax = (invoice.gstAmount > 0 || invoice.qstAmount > 0);

  // When taxes are included in session prices, only the grand total is
  // meaningful — subtotal and tax lines would confuse (numbers don't add up).
  const subtotalRow = document.getElementById("invSubtotalRow");
  if (subtotalRow) subtotalRow.style.display = invoice.taxIncluded ? "none" : "";
  document.getElementById("invSubtotal").textContent =
    formatMoney(invoice.subtotal || 0, lang);

  const gstRow = document.getElementById("invGstRow");
  if (!invoice.taxIncluded && invoice.gstAmount > 0) {
    document.getElementById("invGstVal").textContent = formatMoney(invoice.gstAmount, lang);
    gstRow.style.display = "";
  } else {
    gstRow.style.display = "none";
  }

  const qstRow = document.getElementById("invQstRow");
  if (!invoice.taxIncluded && invoice.qstAmount > 0) {
    document.getElementById("invQstVal").textContent = formatMoney(invoice.qstAmount, lang);
    qstRow.style.display = "";
  } else {
    qstRow.style.display = "none";
  }

  const discountRow = document.getElementById("invDiscountRow");
  if (invoice.discountAmount > 0) {
    document.getElementById("invDiscountVal").textContent =
      `−${formatMoney(invoice.discountAmount, lang)}`;
    discountRow.style.display = "";
  } else {
    discountRow.style.display = "none";
  }

  document.getElementById("invTotal").textContent =
    formatMoney(invoice.total || 0, lang);

  const creditApplied = Math.max(0, Number(invoice.creditApplied) || 0);
  const creditRow = document.getElementById("invCreditRow");
  if (creditRow) {
    if (creditApplied > 0) {
      document.getElementById("invCreditVal").textContent = `−${formatMoney(creditApplied, lang)}`;
      creditRow.style.display = "";
    } else {
      creditRow.style.display = "none";
    }
  }

  const interestRow = document.getElementById("invOverdueInterestRow");
  const totalDueRow = document.getElementById("invTotalDueRow");
  const interestAmount = overdueInterestAmount(invoice);
  const showTotalDue = interestAmount > 0 || creditApplied > 0;
  if (interestAmount > 0) {
    const rate = overdueInterestBps(invoice) / 100;
    document.getElementById("invOverdueInterestLabel").textContent =
      `${t("overdueInterest")} (${rate}%)`;
    document.getElementById("invOverdueInterestVal").textContent =
      formatMoney(interestAmount, lang);
    interestRow.style.display = "";
  } else {
    interestRow.style.display = "none";
  }
  if (showTotalDue) {
    document.getElementById("invTotalDue").textContent =
      formatMoney(invoiceTotalWithOverdueInterest(invoice) - creditApplied, lang);
    totalDueRow.style.display = "";
  } else {
    totalDueRow.style.display = "none";
  }
}

function renderNotes(invoice) {
  const textEl  = document.getElementById("invNotesText");
  const inputEl = document.getElementById("invNotesInput");
  const saveBtn = document.getElementById("invSaveNotesBtn");

  const canEdit = invoice.status === "draft" || invoice.status === "sent";

  if (canEdit) {
    inputEl.value = invoice.notes || "";
    inputEl.style.display = "";
    textEl.style.display = "none";
    saveBtn.style.display = "";
    saveBtn.addEventListener("click", handleSaveNotes);
  } else {
    const notes = (invoice.notes || "").trim();
    textEl.textContent = notes || "—";
    textEl.classList.toggle("is-empty", !notes);
    textEl.style.display = "";
    inputEl.style.display = "none";
    saveBtn.style.display = "none";
  }
}

function renderActions(invoice) {
  const actionsEl = document.getElementById("invActions");
  actionsEl.innerHTML = "";
  const canManage = hasCoachRole(currentRoles) && invoice.coachUid === currentUserUid;
  if (!canManage) return;

  if (invoice.status === "draft") {
    actionsEl.innerHTML = `
      <button type="button" class="inv-btn inv-btn-primary" id="invSendBtn"
              data-key="invSend">Send invoice</button>
      <button type="button" class="inv-btn inv-btn-danger" id="invVoidBtn"
              data-key="invVoid">Void</button>
    `;
    document.getElementById("invSendBtn").addEventListener("click", handleSend);
    document.getElementById("invVoidBtn").addEventListener("click", handleVoid);

  } else if (invoice.status === "sent") {
    actionsEl.innerHTML = `
      <button type="button" class="inv-btn inv-btn-secondary" id="invMarkPaidBtn"
              data-key="invMarkPaid">Mark as paid</button>
      <button type="button" class="inv-btn inv-btn-danger" id="invVoidBtn"
              data-key="invVoid">Void</button>
    `;
    document.getElementById("invMarkPaidBtn").addEventListener("click", handleMarkPaid);
    document.getElementById("invVoidBtn").addEventListener("click", handleVoid);
  }
  // paid and void are terminal — no actions rendered.
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleSend() {
  hideError();
  const btn = document.getElementById("invSendBtn");
  btn.disabled = true;
  btn.textContent = t("invSendDoing");

  try {
    const dueInput = document.getElementById("invDueInput");
    let dueAt = null;
    if (dueInput.value) {
      // Parse YYYY-MM-DD at local noon to avoid timezone-shift issues.
      dueAt = Timestamp.fromDate(new Date(`${dueInput.value}T12:00:00`));
    } else if (inv.proposedDueAt) {
      dueAt = inv.proposedDueAt; // keep whatever was proposed at creation
    }

    const notes = document.getElementById("invNotesInput").value.trim();

    await updateDoc(doc(db, "invoices", inv.id), {
      status:   "sent",
      issuedAt: serverTimestamp(),
      dueAt,
      notes,
    });

    writeNotification(inv.payerUid, {
      type:   "invoice_sent",
      params: { fromName: inv.coachName || "", invoiceNumber: inv.invoiceNumber || "" },
      link:   `invoice.html?id=${inv.id}`,
    });

    inv.status = "sent";
    inv.issuedAt = Timestamp.fromDate(new Date());
    inv.dueAt = dueAt || inv.proposedDueAt || null;
    inv.notes = notes;
    render(inv);
  } catch (err) {
    console.error("Send failed:", err);
    btn.disabled = false;
    btn.textContent = t("invSend");
    showError(t("invErrSend"));
  }
}

async function handleVoid() {
  if (!window.confirm(t("invVoidConfirm"))) return;
  hideError();

  try {
    await updateDoc(doc(db, "invoices", inv.id), { status: "void" });
    window.location.href = "payment.html?filter=void";
  } catch (err) {
    console.error("Void failed:", err);
    showError(t("invErrVoid"));
  }
}

async function handleMarkPaid() {
  if (!window.confirm(t("invMarkPaidConfirm"))) return;
  hideError();

  try {
    await updateDoc(doc(db, "invoices", inv.id), {
      status: "paid",
      paidAmount: invoiceTotalWithOverdueInterest(inv),
      paidAt: serverTimestamp(),
    });

    writeNotification(inv.payerUid, {
      type:   "invoice_paid",
      params: { invoiceNumber: inv.invoiceNumber || "" },
      link:   `invoice.html?id=${inv.id}`,
    });

    window.location.href = "payment.html?filter=paid";
  } catch (err) {
    console.error("Mark paid failed:", err);
    showError(t("invErrMarkPaid"));
  }
}

async function handleSaveNotes() {
  hideError();
  const btn = document.getElementById("invSaveNotesBtn");
  btn.disabled = true;

  try {
    const notes = document.getElementById("invNotesInput").value.trim();
    await updateDoc(doc(db, "invoices", inv.id), { notes });
    inv.notes = notes; // keep local copy in sync
    btn.textContent = t("invSaved");
    setTimeout(() => {
      btn.textContent = t("invSaveNotes");
      btn.disabled = false;
    }, 1500);
  } catch (err) {
    console.error("Save notes failed:", err);
    btn.disabled = false;
    showError(t("invErrSaveNotes"));
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

authGuard([], async (user, userData) => {
  currentUserUid = user.uid;
  currentRoles = userData.rolesArray || userData.roles || [];
  applyLanguage();
  initNav("payment.html");
  injectNotificationBell(user.uid);

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  if (!id) {
    document.getElementById("invLoading").style.display = "none";
    document.getElementById("invNotFound").style.display = "";
    return;
  }

  try {
    inv = await loadInvoice(id);
    inv = await hydrateOverdueInterestRate(inv);
  } catch (err) {
    console.error("Load invoice failed:", err);
    document.getElementById("invLoading").style.display = "none";
    document.getElementById("invNotFound").style.display = "";
    return;
  }

  // Guard: invoice must exist and belong to this coach or payer.
  if (!inv || (inv.coachUid !== user.uid && inv.payerUid !== user.uid)) {
    document.getElementById("invLoading").style.display = "none";
    document.getElementById("invNotFound").textContent = t("invForbidden");
    document.getElementById("invNotFound").style.display = "";
    return;
  }

  if (!hasCoachRole(currentRoles) && inv.status !== "sent" && inv.status !== "paid") {
    document.getElementById("invLoading").style.display = "none";
    document.getElementById("invNotFound").textContent = t("invForbidden");
    document.getElementById("invNotFound").style.display = "";
    return;
  }

  document.getElementById("invLoading").style.display = "none";
  document.getElementById("invDetail").style.display = "";
  render(inv);
});
