import { db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";
import { injectNotificationBell } from "./notifications.js";
import {
  collection, query, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- MODE CONFIG -----------------
// Each mode drives:
//   - the page title (titleKey)
//   - the empty-state message (emptyKey)
//   - which roles the *other* party in a connection must have to be shown
const MODE_CONFIG = {
  students: {
    titleKey: "students",
    emptyKey: "noStudentsFound",
    targetRoles: ["skater", "parent"],
  },
  coaches: {
    titleKey: "coaches",
    emptyKey: "noCoachesFound",
    targetRoles: ["coach", "affiliateCoach"],
  },
  children: {
    titleKey: "myChildren",
    emptyKey: "noChildrenFound",
    targetRoles: ["skater"],
  },
};

// Infer the mode from the viewer's roles when no ?mode= is provided.
// Coach-only viewers see students; skater/parent viewers see coaches.
function resolveMode(urlMode, myRoles) {
  if (urlMode && MODE_CONFIG[urlMode]) return urlMode;
  if (myRoles.includes("coach") || myRoles.includes("affiliateCoach")) return "students";
  if (myRoles.includes("parent")) return "children";
  // skater (or fallback) sees coaches
  return "coaches";
}

// ---------- RENDER -----------------
function renderList(items, emptyKey) {
  const t = translations[getLang()];
  const list = document.getElementById("connections-list");
  list.innerHTML = "";

  if (items.length === 0) {
    list.innerHTML = `<p style='color:#5E6C84;font-size:13px;'>${t[emptyKey] || ""}</p>`;
    return;
  }

  items.forEach(item => {
    const clubLabels = (item.clubNames || []).join(", ");
    const roleLabels = (item.roles || []).map(r => t[r] || r).join(", ");
    const card = document.createElement("div");
    card.className = "student-card";
    card.innerHTML = `
      <strong style="font-size:14px">${item.name}</strong><br>
      <span style="font-size:12px;color:#5E6C84">${item.email}</span><br>
      <span style="font-size:11px;color:#0C66E4;font-weight:600;">${roleLabels}</span>
      ${clubLabels ? `<br><span style="font-size:11px;color:#5E6C84;"> ⛸  ${clubLabels}</span>` : ""}
    `;
    list.appendChild(card);
  });
}

// ---------- LOAD -----------------
async function loadConnections(myUid, mode) {
  const config = MODE_CONFIG[mode];
  const targetRoles = config.targetRoles;

  const snap = await getDocs(
    query(
      collection(db, "connections"),
      where("participants", "array-contains", myUid),
      where("status", "==", "accepted")
    )
  );

  const items = [];

  snap.forEach(d => {
    const data = d.data();
    const otherUid = data.participants.find(id => id !== myUid);
    const otherRoles = data.roles?.[otherUid] || [];
    // Keep this connection only if the other party matches at least one of
    // the target roles for the current mode (e.g. "coaches" mode → coach only).
    const matches = otherRoles.some(r => targetRoles.includes(r));
    if (!matches) return;

    items.push({
      name:      data.names[otherUid],
      email:     data.emails[otherUid],
      roles:     otherRoles,
      clubNames: data.clubNames?.[otherUid] || [],
    });
  });

  renderList(items, config.emptyKey);

  // ---------- SEARCH FILTER -----------------
  document.getElementById("searchInput").addEventListener("input", (e) => {
    const raw = e.target.value.trim().toLowerCase();
    const filtered = items.filter(s =>
      s.name.toLowerCase().includes(raw) ||
      (s.email || "").toLowerCase().includes(raw)
    );
    renderList(filtered, config.emptyKey);
  });
}

// ---------- INIT -----------------
document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();
  authGuard([], (user, userData) => {
    const t = translations[getLang()];
    const urlMode = new URLSearchParams(window.location.search).get("mode");
    const myRoles = userData.rolesArray || [];
    const mode = resolveMode(urlMode, myRoles);
    const config = MODE_CONFIG[mode];

    document.getElementById("page-title").textContent = t[config.titleKey] || "";
    document.getElementById("search-label").textContent = t.searchByName;
    initNav("connections.html");
    injectNotificationBell(user.uid);
    loadConnections(user.uid, mode);
  });
});
