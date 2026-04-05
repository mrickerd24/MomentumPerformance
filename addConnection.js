import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";
import {
  collection, query, where, getDocs,
  addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

function fullName(u) {
  return `${u.firstName || ""} ${u.lastName || ""}`.trim();
}

function targetRoles(myRoles, urlMode) {
  if (urlMode === "skater") return ["skater", "parent"];
  if (urlMode === "coach")  return ["coach"];
  if (myRoles.includes("coach"))                                return ["skater", "parent"];
  if (myRoles.includes("skater") || myRoles.includes("parent")) return ["coach"];
  return ["coach", "skater", "parent"]; // admin
}

// ── Card builder ─────────────────────────────────────────────────────────────

function userCard(userData, actions = []) {
  const card = document.createElement("div");
  card.style.cssText = `
    display:flex; justify-content:space-between; align-items:center;
    padding:12px 14px; margin-bottom:8px;
    background:#fff; border:1px solid #D0D4DB; border-radius:12px;
    box-shadow:0 2px 6px rgba(0,0,0,0.05);
  `;

  const roleLabels = (userData.roles || []).map(r => t(r) || r).join(", ");

  const info = document.createElement("div");
  info.innerHTML = `
    <strong style="font-size:14px">${fullName(userData)}</strong><br>
    <span style="font-size:12px;color:#5E6C84">${userData.email || ""}</span><br>
    <span style="font-size:11px;color:#0C66E4;font-weight:600;">${roleLabels}</span>
  `;

  const btnGroup = document.createElement("div");
  btnGroup.style.cssText = "display:flex;gap:6px;flex-shrink:0;margin-left:10px;";

  actions.forEach(({ label, color, onClick }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `
      background:${color}; color:#fff; border:none; padding:7px 12px;
      border-radius:8px; cursor:pointer; font-size:12px; font-weight:600;
      white-space:nowrap; width:auto;
    `;
    btn.addEventListener("click", onClick);
    btnGroup.appendChild(btn);
  });

  card.appendChild(info);
  card.appendChild(btnGroup);
  return card;
}

function emptyMsg(text) {
  const p = document.createElement("p");
  p.style.cssText = "color:#5E6C84;font-size:13px;";
  p.textContent = text;
  return p;
}

// ── Send request ─────────────────────────────────────────────────────────────

async function sendRequest(myUid, myData, target) {
  await addDoc(collection(db, "connections"), {
    participants: [myUid, target.uid],
    requestedBy:  myUid,
    requestedTo:  target.uid,
    status:       "pending",
    createdAt:    serverTimestamp(),
    names:  { [myUid]: fullName(myData),   [target.uid]: fullName(target)   },
    emails: { [myUid]: myData.email || "", [target.uid]: target.email || "" },
    roles:  { [myUid]: myData.roles || [], [target.uid]: target.roles || [] },
  });
}

// ── Load & render connections ─────────────────────────────────────────────────

async function loadConnections(myUid) {
  const snap = await getDocs(
    query(collection(db, "connections"), where("participants", "array-contains", myUid))
  );

  const pending = [], sent = [], connected = [];

  snap.forEach(d => {
    const data = { id: d.id, ...d.data() };
    if (data.status === "accepted")      connected.push(data);
    else if (data.requestedTo === myUid) pending.push(data);
    else                                 sent.push(data);
  });

  renderSent(sent, myUid);
  renderPending(pending, myUid);
  renderConnected(connected, myUid);
}

function renderSent(sent, myUid) {
  const section = document.getElementById("sent-section");
  const list    = document.getElementById("sent-list");
  list.innerHTML = "";
  if (!sent.length) { section.style.display = "none"; return; }
  section.style.display = "";
  document.getElementById("sent-title").textContent = t("sentRequests");

  sent.forEach(conn => {
    const otherUid  = conn.participants.find(id => id !== myUid);
    const otherData = {
      firstName: conn.names[otherUid],
      email:     conn.emails[otherUid],
      roles:     conn.roles?.[otherUid] || [],
    };
    list.appendChild(userCard(otherData, [{
      label: t("cancel"), color: "#C9372C",
      onClick: async () => {
        await deleteDoc(doc(db, "connections", conn.id));
        await loadConnections(myUid);
      }
    }]));
  });
}

function renderPending(pending, myUid) {
  const section = document.getElementById("pending-section");
  const list    = document.getElementById("pending-list");
  list.innerHTML = "";
  if (!pending.length) { section.style.display = "none"; return; }
  section.style.display = "";
  document.getElementById("pending-title").textContent = t("pendingRequests");

  pending.forEach(conn => {
    const otherUid  = conn.participants.find(id => id !== myUid);
    const otherData = {
      firstName: conn.names[otherUid],
      email:     conn.emails[otherUid],
      roles:     conn.roles?.[otherUid] || [],
    };
    list.appendChild(userCard(otherData, [
      {
        label: t("accept"), color: "#1F845A",
        onClick: async () => {
          await updateDoc(doc(db, "connections", conn.id), { status: "accepted" });
          await loadConnections(myUid);
        }
      },
      {
        label: t("decline"), color: "#C9372C",
        onClick: async () => {
          await deleteDoc(doc(db, "connections", conn.id));
          await loadConnections(myUid);
        }
      }
    ]));
  });
}

function renderConnected(connected, myUid) {
  const section = document.getElementById("connected-section");
  const list    = document.getElementById("connected-list");
  list.innerHTML = "";
  if (!connected.length) { section.style.display = "none"; return; }
  section.style.display = "";
  document.getElementById("connected-title").textContent = t("myConnections");

  connected.forEach(conn => {
    const otherUid  = conn.participants.find(id => id !== myUid);
    const otherData = {
      firstName: conn.names[otherUid],
      email:     conn.emails[otherUid],
      roles:     conn.roles?.[otherUid] || [],
    };
    list.appendChild(userCard(otherData, [{
      label: t("removeConnection"), color: "#5E6C84",
      onClick: async () => {
        await deleteDoc(doc(db, "connections", conn.id));
        await loadConnections(myUid);
      }
    }]));
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  const urlMode = new URLSearchParams(window.location.search).get("mode");

  authGuard([], async (currentUser, userData) => {
    const myRoles       = userData.rolesArray;
    const rolesToSearch = targetRoles(myRoles, urlMode);

    // Set page title
    const titleEl = document.getElementById("page-title");
    if (urlMode === "skater" || (!urlMode && myRoles.includes("coach"))) {
      titleEl.textContent = t("addStudent");
    } else if (urlMode === "coach" || (!urlMode && (myRoles.includes("skater") || myRoles.includes("parent")))) {
      titleEl.textContent = t("addCoach");
    } else {
      titleEl.textContent = t("addConnection");
    }

    document.getElementById("search-label").textContent = t("searchByName");
    document.getElementById("searchBtn").textContent    = t("search");

    await loadConnections(currentUser.uid);

    // Search
    document.getElementById("searchBtn").addEventListener("click", async () => {
      const raw        = document.getElementById("searchInput").value.trim().toLowerCase();
      const resultsDiv = document.getElementById("search-results");
      resultsDiv.innerHTML = "";
      if (!raw) return;

      let candidates = [];

      for (const role of rolesToSearch) {
        const snap = await getDocs(
          query(collection(db, "users"), where("roles", "array-contains", role))
        );
        snap.forEach(d => {
          if (d.id !== currentUser.uid) candidates.push({ uid: d.id, ...d.data() });
        });
      }

      // Deduplicate
      const seen = new Set();
      candidates = candidates.filter(c => !seen.has(c.uid) && seen.add(c.uid));

      // Filter by search string
      const matches = candidates.filter(c =>
        fullName(c).toLowerCase().includes(raw) ||
        (c.email || "").toLowerCase().includes(raw)
      );

      if (!matches.length) {
        resultsDiv.appendChild(emptyMsg(t("noResults")));
        return;
      }

      // Flag already-connected users
      const existingSnap = await getDocs(
        query(collection(db, "connections"), where("participants", "array-contains", currentUser.uid))
      );
      const linkedUids = new Set();
      existingSnap.forEach(d => {
        const other = d.data().participants.find(id => id !== currentUser.uid);
        if (other) linkedUids.add(other);
      });

      matches.forEach(candidate => {
        const alreadyLinked = linkedUids.has(candidate.uid);
        resultsDiv.appendChild(userCard(candidate, alreadyLinked
          ? [{ label: t("connected"), color: "#1F845A", onClick: () => {} }]
          : [{
              label: t("sendRequest"), color: "#0C66E4",
              onClick: async () => {
                await sendRequest(currentUser.uid, userData, candidate);
                resultsDiv.innerHTML = "";
                resultsDiv.appendChild(Object.assign(document.createElement("p"), {
                  textContent: t("requestSent"),
                  style: "color:#1F845A;font-weight:600;"
                }));
                await loadConnections(currentUser.uid);
              }
            }]
        ));
      });
    });

    initNav("addConnection.html");
  });
});
