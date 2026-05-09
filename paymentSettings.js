import { auth, db, getLang, applyLanguage, authGuard, initNav } from "./app.js";
import { injectNotificationBell } from "./notifications.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage, translations } from "./translations.js";
import { toCents, fromCents } from "./money.js";

// ---------------- DEFAULTS ----------------
// Used when a coach has no paymentSettings doc yet (first visit). Per
// MP-117 acceptance criteria: empty state shows sensible defaults.
//
// Choices (locked in with the team):
//   - cadence: biweekly  (most common for skating coaches)
//   - defaultDueDays: 14 (Net 14 — the project default)
//   - acceptedMethods: ["etransfer"] (Quebec norm)
//   - taxEnabled: false  (most coaches start under the small-supplier threshold)
//   - rates: empty       (no sensible default — coach must set)
const DEFAULTS = {
  cadence: "biweekly",
  defaultDueDays: 14,
  acceptedMethods: ["etransfer"],
  taxEnabled: false,
  hourlyRate: null,
  hourlyPrivateRate: null,
  flatRate: null,
  gstNumber: "",
  qstNumber: "",
  invoiceNotes: "",
  overdueInterestBps: 0,
  currency: "CAD",
};

// The select offers these as canned options + "custom". Anything else
// pre-existing on the doc still loads correctly: it just shows up in
// the custom field.
const STANDARD_DUE_DAYS = [7, 14, 30];

// ---------------- BOOT ----------------
// Nav + language don't need auth — wire them immediately so the nav
// buttons are clickable as soon as the page loads, not after the
// Firebase auth round-trip completes.
applyLanguage();
initNav("paymentSettings.html");

authGuard(["coach", "affiliateCoach"], async (user, userData) => {
  injectNotificationBell(user.uid);
  await loadSettings(user.uid);
  attachHandlers(user.uid);
});

// ---------------- LOAD ----------------
// Read from paymentSettings/{uid}. If absent, render the form with
// DEFAULTS — we don't WRITE the defaults until the coach actually saves,
// so a coach who navigates here and leaves doesn't get a stub doc.
async function loadSettings(uid) {
  let data = { ...DEFAULTS };
  try {
    const snap = await getDoc(doc(db, "paymentSettings", uid));
    if (snap.exists()) {
      // Merge stored values over defaults so that any missing field
      // (e.g. flatRate the coach never set) keeps the default.
      data = { ...DEFAULTS, ...snap.data() };
    }
  } catch (e) {
    console.error("Failed to load paymentSettings:", e);
    showError("loadFailed");
    return;
  }

  // ---- Pricing ----
  // Stored as integer cents → display as dollars in the input. Empty
  // (null) values render as empty strings so the placeholder shows.
  setRateField("hourlyRate", data.hourlyRate);
  setRateField("hourlyPrivateRate", data.hourlyPrivateRate);
  setRateField("flatRate", data.flatRate);

  // ---- Cadence ----
  document.getElementById("cadence").value = data.cadence;

  document.getElementById("defaultDueDays").value = data.defaultDueDays || DEFAULTS.defaultDueDays;
  document.getElementById("overdueInterestPercent").value = formatPercentFromBps(data.overdueInterestBps || 0);

  // ---- Accepted methods ----
  // Tick the boxes for whatever's stored. Stripe/PayPal are disabled in
  // the HTML, so even if (somehow) they're in the array we ignore them
  // for UI purposes — they're filtered out on save too.
  const methods = Array.isArray(data.acceptedMethods) ? data.acceptedMethods : [];
  document.getElementById("method-etransfer").checked = methods.includes("etransfer");
  document.getElementById("method-cash").checked      = methods.includes("cash");
  document.getElementById("method-cheque").checked    = methods.includes("cheque");

  // ---- Tax ----
  document.getElementById("taxEnabled").checked = !!data.taxEnabled;
  document.getElementById("taxDetail").classList.toggle("open", !!data.taxEnabled);
  document.getElementById("gstNumber").value = data.gstNumber || "";
  document.getElementById("qstNumber").value = data.qstNumber || "";

  // ---- Notes ----
  document.getElementById("invoiceNotes").value = data.invoiceNotes || "";
}

// Helper: cents (stored) → dollar string (displayed). null or 0 → empty
// string so the placeholder shows; we treat 0 as "not set" because the
// rate fields are pricing inputs, not amounts.
function setRateField(id, cents) {
  const el = document.getElementById(id);
  if (cents == null || cents === 0) {
    el.value = "";
  } else {
    // Use fromCents then format with 2 decimals. The coach can edit
    // freely; we re-parse on save.
    const dollars = fromCents(cents);
    el.value = dollars.toFixed(2);
  }
}

// ---------------- HANDLERS ----------------
function attachHandlers(uid) {
  // Toggle the tax detail block when the tax checkbox changes.
  document.getElementById("taxEnabled").addEventListener("change", (e) => {
    document.getElementById("taxDetail").classList.toggle("open", e.target.checked);
    if (!e.target.checked) {
      // Clear errors so they don't stay visible when the section is hidden.
      clearError("gstNumber");
      clearError("qstNumber");
    }
  });

  // Form submit
  document.getElementById("paymentSettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveSettings(uid);
  });
}

// ---------------- SAVE ----------------
async function saveSettings(uid) {
  clearAllErrors();
  hideResult();

  // ---- Gather + validate ----
  const errors = [];

  // Rates: parse the dollar inputs to cents. Empty inputs are stored as
  // null (i.e. "not configured") rather than 0. The form rules consider
  // 0 a valid rate but it's almost never what a coach means; if they
  // want $0, they can type 0.
  const hourlyRate        = parseRateField("hourlyRate", errors);
  const hourlyPrivateRate = parseRateField("hourlyPrivateRate", errors);
  const flatRate          = parseRateField("flatRate", errors);

  // Cadence: select element value is always one of the three options.
  const cadence = document.getElementById("cadence").value;

  const defaultDueDays = parseInt(document.getElementById("defaultDueDays").value, 10) || DEFAULTS.defaultDueDays;
  const overdueInterestBps = parsePercentField("overdueInterestPercent", errors);

  // Accepted methods: at least one must be checked. Stripe/PayPal are
  // disabled in the HTML so they can't slip in here, but we filter
  // defensively anyway.
  const methods = [];
  if (document.getElementById("method-etransfer").checked) methods.push("etransfer");
  if (document.getElementById("method-cash").checked)      methods.push("cash");
  if (document.getElementById("method-cheque").checked)    methods.push("cheque");
  if (methods.length === 0) {
    errors.push({ field: null, key: "psErrNoMethod" });
  }

  // Tax: if enabled, GST and QST numbers should be filled. We don't
  // enforce a strict regex (CRA formats vary slightly over time) — just
  // require non-empty strings. Trim whitespace.
  const taxEnabled = document.getElementById("taxEnabled").checked;
  let gstNumber = document.getElementById("gstNumber").value.trim();
  let qstNumber = document.getElementById("qstNumber").value.trim();
  if (taxEnabled) {
    if (!gstNumber) errors.push({ field: "gstNumber", key: "psErrGstRequired" });
    if (!qstNumber) errors.push({ field: "qstNumber", key: "psErrQstRequired" });
  } else {
    // If tax is off, we still preserve the numbers (coach might toggle
    // back on without re-entering them). Storing them when off is safe
    // — invoice generation only reads them when taxEnabled is true.
  }

  const invoiceNotes = document.getElementById("invoiceNotes").value.trim();

  // Render any errors and bail.
  if (errors.length > 0) {
    renderErrors(errors);
    return;
  }

  // ---- Build the payload ----
  // Note: the security rules validate `cadence in [...]`, `defaultDueDays
  // is int && 0..365`, `acceptedMethods is list`, and that money fields
  // (when present) are integer cents >= 0. The shape below satisfies all
  // of those.
  const payload = {
    cadence,
    defaultDueDays,
    overdueInterestBps,
    acceptedMethods: methods,
    taxEnabled,
    gstNumber,
    qstNumber,
    invoiceNotes,
    currency: "CAD",
    updatedAt: serverTimestamp(),
  };
  // Only include rates that were actually set. Omitting (rather than
  // writing null) keeps the doc clean and lets the security rule's
  // "isMoneyOrAbsent" guard pass without us writing a sentinel value.
  if (hourlyRate        != null) payload.hourlyRate        = hourlyRate;
  if (hourlyPrivateRate != null) payload.hourlyPrivateRate = hourlyPrivateRate;
  if (flatRate          != null) payload.flatRate          = flatRate;

  // ---- Write ----
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  try {
    // setDoc with merge:false because the form is the full source of
    // truth — anything not in the payload should be removed (e.g. a
    // hourlyPrivateRate the coach cleared). The exception is updatedAt
    // and the doc id which are managed by us either way.
    //
    // Actually: we DO want merge:true for forward-compat — if a future
    // ticket adds a field this page doesn't know about, we don't want
    // to clobber it. The trade-off is that clearing a rate field here
    // won't actually delete the stored value. We accept that for v1
    // because clearing is rare; if it becomes a problem, switch to
    // merge:false and explicitly null-out missing fields.
    await setDoc(doc(db, "paymentSettings", auth.currentUser.uid), payload, { merge: true });
    showOk("changesSaved");
  } catch (e) {
    console.error("Save failed:", e);
    // Permission-denied means our rules rejected it — usually a shape
    // bug here. Other errors are network / Firestore issues.
    showError(e.code === "permission-denied" ? "psErrPermission" : "psErrSaveGeneric");
  } finally {
    btn.disabled = false;
  }
}

function formatPercentFromBps(bps) {
  const value = Number(bps) / 100;
  return value ? String(Number(value.toFixed(2))) : "";
}

function parsePercentField(id, errors) {
  const raw = document.getElementById(id).value.trim().replace("%", "");
  if (raw === "") return 0;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    errors.push({ field: id, key: "psErrInterestInvalid" });
    return 0;
  }
  return Math.round(value * 100);
}

// Parse a rate input field. Returns:
//   - null        : empty input (rate not configured)
//   - integer >=0 : valid cents
// Pushes an error onto `errors` if the input is non-empty but unparseable
// or negative.
function parseRateField(id, errors) {
  const raw = document.getElementById(id).value.trim();
  if (raw === "") return null;
  const cents = toCents(raw);
  if (!Number.isFinite(cents)) {
    errors.push({ field: id, key: "psErrRateInvalid" });
    return null;
  }
  if (cents < 0) {
    errors.push({ field: id, key: "psErrRateNegative" });
    return null;
  }
  // toCents("abc") returns 0 — distinguish that from an actual "0" entry.
  // If raw isn't empty, isn't "0"/"0.00", and toCents returned 0, it's
  // garbage input.
  const looksLikeZero = /^[0]+([.,][0]+)?$/.test(raw);
  if (cents === 0 && !looksLikeZero) {
    errors.push({ field: id, key: "psErrRateInvalid" });
    return null;
  }
  return cents;
}

// ---------------- ERROR RENDERING ----------------
function renderErrors(errors) {
  const lang = getLang();
  const t = translations[lang] || translations.en;
  for (const err of errors) {
    if (err.field) {
      const el = document.getElementById(err.field + "-error");
      if (el) el.textContent = t[err.key] || err.key;
    }
  }
  // Form-level errors (no specific field) go in the result banner.
  const formLevel = errors.filter(e => !e.field);
  if (formLevel.length > 0) {
    showError(formLevel[0].key);
  }
}

function clearAllErrors() {
  document.querySelectorAll(".field-error").forEach(el => { el.textContent = ""; });
}

function clearError(field) {
  const el = document.getElementById(field + "-error");
  if (el) el.textContent = "";
}

function showOk(key) {
  const lang = getLang();
  const t = translations[lang] || translations.en;
  const el = document.getElementById("ps-result");
  el.className = "ok";
  el.textContent = t[key] || key;
  el.style.display = "block";
}

function showError(key) {
  const lang = getLang();
  const t = translations[lang] || translations.en;
  const el = document.getElementById("ps-result");
  el.className = "err";
  el.textContent = t[key] || key;
  el.style.display = "block";
}

function hideResult() {
  document.getElementById("ps-result").style.display = "none";
}
