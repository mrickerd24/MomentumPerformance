import { db, getLang, translations, escapeHtml } from "./app.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, limit,
  updateDoc, doc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

function formatTimeAgo(ts) {
  if (!ts) return "";
  const date = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return t("notifJustNow");
  if (diffMin < 60) return t("notifMinutesAgo").replace("{n}", diffMin);
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("notifHoursAgo").replace("{n}", diffH);
  return t("notifDaysAgo").replace("{n}", Math.floor(diffH / 24));
}

function notifText(notif) {
  const p = notif.params || {};
  const lang = getLang();
  const fr = lang === "fr";

  const TITLES = {
    invoice_sent:        { en: "New invoice",         fr: "Nouvelle facture" },
    invoice_paid:        { en: "Invoice paid",        fr: "Facture payée" },
    connection_request:  { en: "Connection request",  fr: "Demande de connexion" },
    connection_accepted: { en: "Connection accepted", fr: "Connexion acceptée" },
    session_created:     { en: "Session scheduled",   fr: "Séance planifiée" },
    session_updated:     { en: "Session updated",     fr: "Séance modifiée" },
    session_deleted:     { en: "Session cancelled",   fr: "Séance annulée" },
  };

  const titleMap = TITLES[notif.type] || {};
  const title = (fr ? titleMap.fr : titleMap.en) || notif.type;

  let body = "";
  switch (notif.type) {
    case "invoice_sent":
      body = fr
        ? `Nouvelle facture de ${p.fromName || ""}`
        : `New invoice from ${p.fromName || ""}`;
      break;
    case "invoice_paid":
      body = fr
        ? `La facture #${p.invoiceNumber || ""} a été marquée comme payée`
        : `Invoice #${p.invoiceNumber || ""} has been marked as paid`;
      break;
    case "connection_request":
      body = fr
        ? `${p.fromName || ""} veut se connecter avec vous`
        : `${p.fromName || ""} wants to connect with you`;
      break;
    case "connection_accepted":
      body = fr
        ? `${p.fromName || ""} a accepté votre demande de connexion`
        : `${p.fromName || ""} accepted your connection request`;
      break;
    case "session_created":
      body = fr
        ? `Nouvelle séance le ${p.date || ""}`
        : `New session on ${p.date || ""}`;
      break;
    case "session_updated":
      body = fr
        ? `La séance du ${p.date || ""} a été modifiée`
        : `Session on ${p.date || ""} was updated`;
      break;
    case "session_deleted":
      body = fr
        ? `La séance du ${p.date || ""} a été annulée`
        : `Session on ${p.date || ""} was cancelled`;
      break;
    default:
      body = "";
  }
  return { title, body };
}

// Write a notification document to a recipient's subcollection.
// Fire-and-forget: errors are logged but never surfaced to the user.
export async function writeNotification(recipientUid, { type, params = {}, link = null }) {
  if (!recipientUid) return;
  try {
    await addDoc(collection(db, "notifications", recipientUid, "items"), {
      type,
      params,
      link: link || null,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("writeNotification failed:", err);
  }
}

let _unsubscribe = null;

// Inject the bell icon and notification panel into the page.
// Call once after auth resolves, passing the signed-in user's UID.
export function injectNotificationBell(uid) {
  if (document.getElementById("notif-bell-wrap")) return; // already injected

  const style = document.createElement("style");
  style.textContent = `
    #notif-bell-wrap{position:fixed;top:10px;right:10px;z-index:1100;}
    #notif-bell-btn{
      background:#fff;border:1px solid #DFE1E6;border-radius:50%;
      width:40px;height:40px;cursor:pointer;display:flex;
      align-items:center;justify-content:center;position:relative;
      box-shadow:0 2px 6px rgba(9,30,66,0.12);padding:0;
    }
    #notif-bell-btn:hover{background:#F4F5F7;}
    #notif-badge{
      position:absolute;top:-4px;right:-4px;
      background:#C9372C;color:#fff;border-radius:10px;
      font-size:10px;font-weight:700;min-width:16px;height:16px;
      display:none;align-items:center;justify-content:center;
      padding:0 4px;line-height:1;font-family:inherit;
    }
    #notif-panel{
      display:none;position:absolute;top:48px;right:0;
      width:300px;max-height:420px;background:#fff;
      border:1px solid #DFE1E6;border-radius:8px;overflow:hidden;
      box-shadow:0 4px 20px rgba(9,30,66,0.15);flex-direction:column;
    }
    #notif-panel.open{display:flex;}
    #notif-panel-header{
      padding:12px 14px;border-bottom:1px solid #DFE1E6;
      display:flex;justify-content:space-between;align-items:center;
      flex-shrink:0;
    }
    #notif-panel-title{font-size:13px;font-weight:700;color:#172B4D;}
    #notif-mark-all{
      font-size:11px;color:#0C66E4;background:none;border:none;
      cursor:pointer;padding:0;font-weight:600;font-family:inherit;
    }
    #notif-mark-all:hover{text-decoration:underline;}
    #notif-list{overflow-y:auto;flex:1;}
    .notif-item{
      display:flex;gap:10px;padding:11px 14px;
      border-bottom:1px solid #F4F5F7;cursor:pointer;align-items:flex-start;
    }
    .notif-item:hover{background:#F8F9FF;}
    .notif-item.unread{background:#EEF3FF;}
    .notif-item.unread:hover{background:#E5EDFF;}
    .notif-dot{
      width:8px;height:8px;border-radius:50%;background:#0C66E4;
      flex-shrink:0;margin-top:5px;
    }
    .notif-dot.read{background:transparent;}
    .notif-body-wrap{flex:1;min-width:0;}
    .notif-title{font-size:13px;font-weight:600;color:#172B4D;margin-bottom:2px;}
    .notif-body{font-size:12px;color:#5E6C84;line-height:1.35;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .notif-time{font-size:11px;color:#8993A4;}
    #notif-empty{padding:24px 14px;text-align:center;font-size:13px;color:#8993A4;}
  `;
  document.head.appendChild(style);

  const wrap = document.createElement("div");
  wrap.id = "notif-bell-wrap";
  wrap.innerHTML = `
    <button id="notif-bell-btn" aria-label="Notifications">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#172B4D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span id="notif-badge"></span>
    </button>
    <div id="notif-panel">
      <div id="notif-panel-header">
        <span id="notif-panel-title"></span>
        <button id="notif-mark-all"></button>
      </div>
      <div id="notif-list"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const btn        = document.getElementById("notif-bell-btn");
  const panel      = document.getElementById("notif-panel");
  const badge      = document.getElementById("notif-badge");
  const list       = document.getElementById("notif-list");
  const markAllBtn = document.getElementById("notif-mark-all");

  let notifDocs = [];

  function updateLabels() {
    document.getElementById("notif-panel-title").textContent = t("notifBellLabel");
    markAllBtn.textContent = t("notifMarkAllRead");
  }

  function render() {
    updateLabels();

    const unreadCount = notifDocs.filter(n => !n.read).length;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }

    if (!notifDocs.length) {
      list.innerHTML = `<div id="notif-empty">${escapeHtml(t("notifEmpty"))}</div>`;
      return;
    }

    list.innerHTML = notifDocs.map(n => {
      const { title, body } = notifText(n);
      return `
        <div class="notif-item${n.read ? "" : " unread"}" data-id="${escapeHtml(n.id)}" data-link="${escapeHtml(n.link || "")}">
          <div class="notif-dot${n.read ? " read" : ""}"></div>
          <div class="notif-body-wrap">
            <div class="notif-title">${escapeHtml(title)}</div>
            <div class="notif-body">${escapeHtml(body)}</div>
            <div class="notif-time">${escapeHtml(formatTimeAgo(n.createdAt))}</div>
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".notif-item").forEach(el => {
      el.addEventListener("click", async () => {
        const id   = el.dataset.id;
        const link = el.dataset.link;
        const notif = notifDocs.find(n => n.id === id);
        if (notif && !notif.read) {
          try {
            await updateDoc(doc(db, "notifications", uid, "items", id), { read: true });
          } catch (err) {
            console.error("mark read failed:", err);
          }
        }
        if (link) window.location.href = link;
        else panel.classList.remove("open");
      });
    });
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) render(); // refresh time labels on open
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) panel.classList.remove("open");
  });

  markAllBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const unread = notifDocs.filter(n => !n.read);
    if (!unread.length) return;
    try {
      const batch = writeBatch(db);
      unread.forEach(n => {
        batch.update(doc(db, "notifications", uid, "items", n.id), { read: true });
      });
      await batch.commit();
    } catch (err) {
      console.error("mark all read failed:", err);
    }
  });

  if (_unsubscribe) _unsubscribe();
  _unsubscribe = onSnapshot(
    query(collection(db, "notifications", uid, "items"), orderBy("createdAt", "desc"), limit(20)),
    (snap) => {
      notifDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    },
    (err) => console.error("notifications listener error:", err)
  );
}
