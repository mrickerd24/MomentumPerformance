import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, toTitleCase, formatFullName } from "./app.js";
import { writeNotification, injectNotificationBell } from "./notifications.js";
import {
  collection, query, where, getDocs, orderBy,
  addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function t(key) {
  return (translations[getLang()] || {})[key] || key;
}

function fullName(u) {
  // Names are stored Title Cased going forward. formatFullName() defensively
  // re-title-cases on read so legacy uppercase data from before the
  // migration still renders cleanly. Used both for display ("name at the
  // top of a user card") and for the snapshot stored on connection docs.
  return formatFullName(u);
}

// Simple Promise-based wrapper around the confirm-remove modal. Resolves
// true if the user clicks the destructive button, false if they cancel or
// dismiss by clicking the backdrop. Reused for every delete-y action on
// this page (cancel sent request, decline incoming request, remove accepted
// connection) so the UX is consistent.
function confirmRemove({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    const modal  = document.getElementById("confirmRemoveModal");
    const okBtn  = document.getElementById("confirmRemoveOk");
    const cancel = document.getElementById("confirmRemoveCancel");
    document.getElementById("confirmRemoveTitle").textContent = title || "";
    document.getElementById("confirmRemoveMsg").textContent   = message || "";
    okBtn.textContent     = confirmLabel || t("removeConnection");
    cancel.textContent    = t("cancel");
    modal.classList.add("open");

    // Fresh handlers on every open to keep the state machine simple —
    // cloneNode with deep-true removes any previously-attached listeners.
    const newOk     = okBtn.cloneNode(true);
    const newCancel = cancel.cloneNode(true);
    okBtn.replaceWith(newOk);
    cancel.replaceWith(newCancel);

    const close = (result) => {
      modal.classList.remove("open");
      resolve(result);
    };
    newOk.addEventListener("click", () => close(true));
    newCancel.addEventListener("click", () => close(false));
    // Backdrop click cancels too.
    modal.addEventListener("click", function onBackdrop(e) {
      if (e.target === modal) { modal.removeEventListener("click", onBackdrop); close(false); }
    });
  });
}

function targetRoles(myRoles, urlMode) {
  if (urlMode === "skater") return ["skater", "parent"];
  if (urlMode === "coach")  return ["coach", "affiliateCoach"];
  if (myRoles.includes("coach") || myRoles.includes("affiliateCoach")) return ["skater", "parent"];
  if (myRoles.includes("skater") || myRoles.includes("parent")) return ["coach", "affiliateCoach"];
  return ["coach", "affiliateCoach", "skater", "parent"]; // admin
}

// ── Clubs ─────────────────────────────────────────────────────────────────────

let allClubs = [];

async function loadAllClubs() {
  if (allClubs.length) return;
  const snap = await getDocs(collection(db, "clubs"));
  snap.forEach(d => allClubs.push({ id: d.id, ...d.data() }));
}

function resolveClubNames(clubIds = []) {
  return clubIds.map(id => allClubs.find(c => c.id === id)?.name || "").filter(Boolean);
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
  const clubLabels = (userData.clubNames || []).join(", ");

  const info = document.createElement("div");
  info.innerHTML = `
    <strong style="font-size:14px">${fullName(userData)}</strong><br>
    <span style="font-size:12px;color:#5E6C84">${userData.email || ""}</span><br>
    <span style="font-size:11px;color:#0C66E4;font-weight:600;">${roleLabels}</span>
    ${clubLabels ? `<br><span style="font-size:11px;color:#5E6C84;">${clubLabels}</span>` : ""}
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
    names:     { [myUid]: fullName(myData),                        [target.uid]: fullName(target)                       },
    emails:    { [myUid]: myData.email || "",                      [target.uid]: target.email || ""                     },
    roles:     { [myUid]: myData.roles || [],                      [target.uid]: target.roles || []                     },
    clubNames: { [myUid]: resolveClubNames(myData.clubs || []),    [target.uid]: resolveClubNames(target.clubs || [])   },
  });

  writeNotification(target.uid, {
    type:   "connection_request",
    params: { fromName: fullName(myData) },
    link:   "addConnection.html",
  });
}

// ── Load & render connections ─────────────────────────────────────────────────

async function loadConnections(myUid, myRoles = []) {
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
  renderConnected(connected, myUid, myRoles);
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
      roles:     conn.roles?.[otherUid]     || [],
      clubNames: conn.clubNames?.[otherUid] || [],
    };
    list.appendChild(userCard(otherData, [{
      label: t("cancel"), color: "#C9372C",
      onClick: async () => {
        const ok = await confirmRemove({
          title:        t("cancel"),
          message:      t("confirmCancelRequest") || "Cancel this request?",
          confirmLabel: t("cancel"),
        });
        if (!ok) return;
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
      roles:     conn.roles?.[otherUid]     || [],
      clubNames: conn.clubNames?.[otherUid] || [],
    };
    list.appendChild(userCard(otherData, [
      {
        label: t("accept"), color: "#1F845A",
        onClick: async () => {
          await updateDoc(doc(db, "connections", conn.id), { status: "accepted" });
          writeNotification(conn.requestedBy, {
            type:   "connection_accepted",
            params: { fromName: conn.names?.[myUid] || "" },
            link:   "addConnection.html",
          });
          await loadConnections(myUid);
        }
      },
      {
        label: t("decline"), color: "#C9372C",
        onClick: async () => {
          const ok = await confirmRemove({
            title:        t("decline"),
            message:      t("confirmDeclineRequest") || "Decline this request?",
            confirmLabel: t("decline"),
          });
          if (!ok) return;
          await deleteDoc(doc(db, "connections", conn.id));
          await loadConnections(myUid);
        }
      }
    ]));
  });
}

function renderConnected(connected, myUid, myRoles) {
  const section       = document.getElementById("connected-section");
  const studentsSub   = document.getElementById("connected-students-sub");
  const studentsList  = document.getElementById("connected-students-list");
  const studentsTitle = document.getElementById("connected-students-title");
  const coachesSub    = document.getElementById("connected-coaches-sub");
  const coachesList   = document.getElementById("connected-coaches-list");
  const coachesTitle  = document.getElementById("connected-coaches-title");
  const divider       = document.getElementById("connected-sub-divider");

  studentsList.innerHTML = "";
  coachesList.innerHTML  = "";

  if (!connected.length) { section.style.display = "none"; return; }
  section.style.display = "";
  document.getElementById("connected-title").textContent = t("myConnections");

  const viewerIsCoach        = myRoles.includes("coach") || myRoles.includes("affiliateCoach");
  const viewerIsSkaterParent = myRoles.includes("skater") || myRoles.includes("parent");

  // Partition the connection list by the OTHER party's role. A coach viewer
  // sees connections where the other party is a skater/parent as "My
  // students"; a skater/parent viewer sees coaches as "My coaches". A user
  // with both roles (e.g. a coach who also skates) sees both lists with a
  // horizontal separator between them, mirroring the dashboard layout.
  const students = [];  // connections whose "other" party is a skater/parent
  const coaches  = [];  // connections whose "other" party is a coach

  connected.forEach(conn => {
    const otherUid   = conn.participants.find(id => id !== myUid);
    const otherRoles = conn.roles?.[otherUid] || [];
    const otherData  = {
      firstName: conn.names[otherUid],
      email:     conn.emails[otherUid],
      roles:     otherRoles,
      clubNames: conn.clubNames?.[otherUid] || [],
    };
    const entry = { conn, otherUid, otherData, otherRoles };

    if (otherRoles.includes("coach") || otherRoles.includes("affiliateCoach")) coaches.push(entry);
    else if (otherRoles.includes("skater") || otherRoles.includes("parent"))  students.push(entry);
    // Other role combos (e.g. admin-only) are intentionally skipped here.
  });

  // Helper that builds the Remove button with confirm-modal + deletion.
  const removeAction = (entry) => ({
    label: t("removeConnection"), color: "#5E6C84",
    onClick: async () => {
      const ok = await confirmRemove({
        title:        t("removeConnection"),
        message:      (t("confirmRemoveConnection") || "Remove this connection?")
                       + (entry.otherData.firstName ? ` (${entry.otherData.firstName})` : ""),
        confirmLabel: t("removeConnection"),
      });
      if (!ok) return;
      await deleteDoc(doc(db, "connections", entry.conn.id));
      await loadConnections(myUid, myRoles);
      document.getElementById("searchBtn").click();
    }
  });

  // Render "My students" sub-section — shown only for coach viewers with at
  // least one connected student.
  if (viewerIsCoach && students.length > 0) {
    studentsSub.style.display = "";
    studentsTitle.textContent = t("myStudents") || t("students") || "My students";
    students.forEach(entry => {
      studentsList.appendChild(userCard(entry.otherData, [removeAction(entry)]));
    });
  } else {
    studentsSub.style.display = "none";
  }

  // Render "My coaches" sub-section — shown only for skater/parent viewers
  // with at least one connected coach.
  if (viewerIsSkaterParent && coaches.length > 0) {
    coachesSub.style.display = "";
    coachesTitle.textContent = t("myCoaches") || t("coaches") || "My coaches";
    coaches.forEach(entry => {
      coachesList.appendChild(userCard(entry.otherData, [removeAction(entry)]));
    });
  } else {
    coachesSub.style.display = "none";
  }

  // Divider between sub-sections, only when BOTH are populated. Same visual
  // treatment as the coach/skater divider on the dashboard.
  divider.style.display = (studentsSub.style.display === "" && coachesSub.style.display === "")
      ? ""
      : "none";
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runSearch(currentUser, userData, rolesToSearch) {
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

  // Fetch current live connection state (fresh query — not cached)
  const existingSnap = await getDocs(
    query(collection(db, "connections"), where("participants", "array-contains", currentUser.uid))
  );
  const acceptedUids = new Set();
  const pendingUids  = new Set();
  existingSnap.forEach(d => {
    const data  = d.data();
    const other = data.participants.find(id => id !== currentUser.uid);
    if (!other) return;
    if (data.status === "accepted") acceptedUids.add(other);
    else                            pendingUids.add(other);
  });

  matches.forEach(candidate => {
    // Resolve club names for search result cards
    candidate.clubNames = resolveClubNames(candidate.clubs || []);

    let actions;
    if (acceptedUids.has(candidate.uid)) {
      actions = [{ label: t("connected"), color: "#1F845A", onClick: () => {} }];
    } else if (pendingUids.has(candidate.uid)) {
      actions = [{ label: t("requestSent"), color: "#5E6C84", onClick: () => {} }];
    } else {
      actions = [{
        label: t("sendRequest"), color: "#0C66E4",
        onClick: async () => {
          await sendRequest(currentUser.uid, userData, candidate);
          await loadConnections(currentUser.uid, userData.rolesArray || []);
          await runSearch(currentUser, userData, rolesToSearch);
        }
      }];
    }
    resultsDiv.appendChild(userCard(candidate, actions));
  });
}

// ── Children (parents only) ──────────────────────────────────────────────────
// Children are stored in a top-level "children" collection with a parentId
// field — same shape as the rest of the app's top-level docs (users,
// connections, sessions, clubs). Each card on the parent's "My children"
// list maps to one document. The 6-color cycling is purely a render-time
// concern: the index in the list mod 6 picks the .child-card-cN class, so
// no color value needs to be persisted.

// In-memory cache of the parent's children, kept in sync with Firestore by
// loadChildren() after every save/delete. Used by the edit modal to look
// up an existing child by id without re-querying.
let myChildren = [];

// The child currently being edited, or null when the modal is in Add mode.
// Reset whenever the modal closes so the next open starts clean.
let editingChildId = null;

// Club selected inside the child form. Single-select (unlike the multi-club
// signup form) — a child belongs to exactly one club.
let childSelectedClub = null;

// Open the child form modal in Add or Edit mode. `child` is the existing
// child object when editing, or null/undefined when adding. The modal's
// inputs, title, and Delete button visibility are wired here so callers
// don't need to know about DOM ids.
function openChildForm(child) {
  editingChildId        = child?.id || null;
  childSelectedClub     = null;

  document.getElementById("childFormTitle").textContent          = child ? t("editChild") : t("addChild");
  document.getElementById("childFirstNameLabel").textContent     = t("childFirstName");
  document.getElementById("childLastNameLabel").textContent      = t("childLastName");
  document.getElementById("childSkateCanLabel").textContent      = t("childSkateCanadaNumber");
  document.getElementById("childClubLabel").textContent          = t("childSkatingClub");
  document.getElementById("childFormCancel").textContent         = t("cancel");
  document.getElementById("childFormSave").textContent           = t("save");
  document.getElementById("childFormDelete").textContent         = t("delete");
  document.getElementById("childClubSearch").placeholder         = t("selectClubPlaceholder");

  document.getElementById("childFirstName").value           = child?.firstName || "";
  document.getElementById("childLastName").value            = child?.lastName  || "";
  document.getElementById("childSkateCanadaNumber").value   = child?.skateCanadaNumber || "";
  document.getElementById("childClubSearch").value          = "";
  document.getElementById("childClubResults").innerHTML     = "";

  // Clear inline error messages from any previous open.
  ["childFirstName-error", "childLastName-error", "childSkateCanadaNumber-error", "childClub-error"]
    .forEach(id => { document.getElementById(id).innerText = ""; });

  // Pre-select the existing club when editing so the parent sees what's
  // currently set without having to re-search for it.
  if (child?.clubId) {
    const club = allClubs.find(c => c.id === child.clubId);
    if (club) childSelectedClub = club;
  }
  renderChildSelectedClub();

  // Delete button only makes sense in Edit mode — hidden when adding a
  // brand-new child since there's nothing to delete yet.
  document.getElementById("childFormDelete").style.display = child ? "" : "none";

  document.getElementById("childFormModal").classList.add("open");
}

function closeChildForm() {
  document.getElementById("childFormModal").classList.remove("open");
  editingChildId    = null;
  childSelectedClub = null;
}

function renderChildSelectedClub() {
  const container = document.getElementById("childSelectedClub");
  container.innerHTML = "";
  if (!childSelectedClub) return;
  // Same chip styling as the signup form's club chips so the "selected"
  // affordance is consistent across the app.
  const chip = document.createElement("span");
  chip.style.cssText = `
    display:inline-flex; align-items:center; gap:6px;
    background:#E9F2FF; color:#0C66E4; border:1px solid #0C66E4;
    border-radius:12px; padding:4px 10px; margin:4px 4px 4px 0;
    font-size:12px; font-weight:600;
  `;
  chip.innerHTML = `${childSelectedClub.name} <span style="cursor:pointer; font-weight:700;">✕</span>`;
  chip.querySelector("span").addEventListener("click", () => {
    childSelectedClub = null;
    renderChildSelectedClub();
  });
  container.appendChild(chip);
}

function filterChildClubs(searchTerm) {
  const raw        = searchTerm.trim().toLowerCase()
                       .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const resultsDiv = document.getElementById("childClubResults");
  resultsDiv.innerHTML = "";
  if (!raw) return;

  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const matches = allClubs.filter(c =>
    norm(c.name || "").includes(raw) ||
    norm(c.region || "").includes(raw)
  );

  if (!matches.length) {
    resultsDiv.innerHTML = `<p style="color:#5E6C84;font-size:13px;">${t("noResults")}</p>`;
    return;
  }

  matches.slice(0, 20).forEach(club => {
    if (childSelectedClub?.id === club.id) return;
    const card = document.createElement("div");
    card.className = "student-card";
    card.style.cursor = "pointer";
    card.innerHTML = `
      <strong style="font-size:14px">${club.name}</strong><br>
      <span style="font-size:12px;color:#5E6C84">${club.region || ""}</span>
    `;
    card.addEventListener("click", () => {
      childSelectedClub = club;
      document.getElementById("childClubSearch").value = "";
      document.getElementById("childClubResults").innerHTML = "";
      renderChildSelectedClub();
    });
    resultsDiv.appendChild(card);
  });
}

// Validate the child form inputs. Returns true when everything is filled in;
// inline error spans are populated for any missing field. All four fields
// are required by product spec — if that loosens later, only this function
// needs to change.
function validateChildForm() {
  const firstName    = document.getElementById("childFirstName").value.trim();
  const lastName     = document.getElementById("childLastName").value.trim();
  const skateCanada  = document.getElementById("childSkateCanadaNumber").value.trim();

  ["childFirstName-error", "childLastName-error", "childSkateCanadaNumber-error", "childClub-error"]
    .forEach(id => { document.getElementById(id).innerText = ""; });

  let valid = true;
  if (!firstName) {
    document.getElementById("childFirstName-error").innerText = t("childFirstNameRequired");
    valid = false;
  }
  if (!lastName) {
    document.getElementById("childLastName-error").innerText = t("childLastNameRequired");
    valid = false;
  }
  if (!skateCanada) {
    document.getElementById("childSkateCanadaNumber-error").innerText = t("childSkateCanadaRequired");
    valid = false;
  }
  if (!childSelectedClub) {
    document.getElementById("childClub-error").innerText = t("childClubRequired");
    valid = false;
  }
  return valid;
}

async function saveChildFromForm(parentUid) {
  if (!validateChildForm()) return;

  // Names are stored Title Cased — see toTitleCase()/formatFullName() in
  // app.js. Same convention used for user signup, account settings, and
  // for connection participants via fullName().
  const payload = {
    parentId:          parentUid,
    firstName:         toTitleCase(document.getElementById("childFirstName").value),
    lastName:          toTitleCase(document.getElementById("childLastName").value),
    skateCanadaNumber: document.getElementById("childSkateCanadaNumber").value.trim(),
    clubId:            childSelectedClub.id,
    clubName:          childSelectedClub.name || "",
  };

  if (editingChildId) {
    // Edit: don't overwrite parentId/createdAt; just patch the fields the
    // parent can change in the form.
    await updateDoc(doc(db, "children", editingChildId), {
      firstName:         payload.firstName,
      lastName:          payload.lastName,
      skateCanadaNumber: payload.skateCanadaNumber,
      clubId:            payload.clubId,
      clubName:          payload.clubName,
      updatedAt:         serverTimestamp(),
    });
  } else {
    // Add: include parentId + createdAt so the doc sorts correctly on
    // subsequent loads.
    await addDoc(collection(db, "children"), {
      ...payload,
      createdAt: serverTimestamp(),
    });
  }

  closeChildForm();
  await loadChildren(parentUid);
}

async function deleteChildFromForm(parentUid) {
  if (!editingChildId) return;
  // Reuse the existing confirm-remove modal so the destructive-action UX
  // stays consistent with cancel-request / decline-request / remove-
  // connection. The modal closes on its own — we just await its result.
  const ok = await confirmRemove({
    title:        t("delete"),
    message:      t("confirmDeleteChild") || "Delete this child?",
    confirmLabel: t("delete"),
  });
  if (!ok) return;
  await deleteDoc(doc(db, "children", editingChildId));
  closeChildForm();
  await loadChildren(parentUid);
}

async function loadChildren(parentUid) {
  // Parents-only: fetch all children docs whose parentId matches the
  // current viewer. Sorted by createdAt so the order is stable across
  // reloads — newest at the bottom, like an audit log.
  const snap = await getDocs(
    query(collection(db, "children"), where("parentId", "==", parentUid))
  );
  myChildren = [];
  snap.forEach(d => myChildren.push({ id: d.id, ...d.data() }));
  // Sort client-side; createdAt may be a server timestamp or absent for
  // legacy docs. Falls back to id (auto-id is roughly time-ordered).
  myChildren.sort((a, b) => {
    const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    if (ta !== tb) return ta - tb;
    return (a.id || "").localeCompare(b.id || "");
  });
  renderChildren();
}

function renderChildren() {
  const list = document.getElementById("children-list");
  list.innerHTML = "";

  if (!myChildren.length) {
    const p = document.createElement("p");
    p.style.cssText = "color:#5E6C84; font-size:13px; margin:8px 0 0;";
    p.textContent = t("noChildrenFound");
    list.appendChild(p);
    return;
  }

  // Each card cycles through 6 color variants by index. Tap opens the
  // edit modal for that child — the modal contains the Delete button.
  myChildren.forEach((child, idx) => {
    const colorClass = `child-card-c${idx % 6}`;
    const card = document.createElement("div");
    card.className = `child-card ${colorClass}`;

    const info = document.createElement("div");
    info.className = "child-card-info";
    const fullChildName = `${child.firstName || ""} ${child.lastName || ""}`.trim();
    info.innerHTML = `
      <div class="child-card-name">${fullChildName}</div>
      <div class="child-card-meta">${t("childSkateCanadaNumber")}: ${child.skateCanadaNumber || ""}</div>
      ${child.clubName ? `<div class="child-card-club">⛸ ${child.clubName}</div>` : ""}
    `;

    const chevron = document.createElement("span");
    chevron.className = "child-card-chevron";
    chevron.textContent = "›";

    card.appendChild(info);
    card.appendChild(chevron);
    card.addEventListener("click", () => openChildForm(child));
    list.appendChild(card);
  });
}

// Initialize the children section. Called from the page-load handler when
// the viewer is a parent. Wires up the "Add child" button, the modal's
// Save/Cancel/Delete buttons, and the club search inside the modal — then
// kicks off the initial load.
function initChildrenSection(parentUid) {
  const section = document.getElementById("children-section");
  section.style.display = "";
  document.getElementById("children-title").textContent = t("myChildren");
  document.getElementById("addChildBtn").textContent    = t("addChild");

  document.getElementById("addChildBtn")
    .addEventListener("click", () => openChildForm(null));

  document.getElementById("childFormCancel")
    .addEventListener("click", closeChildForm);

  document.getElementById("childFormSave")
    .addEventListener("click", () => saveChildFromForm(parentUid));

  document.getElementById("childFormDelete")
    .addEventListener("click", () => deleteChildFromForm(parentUid));

  // Backdrop click cancels — same UX pattern as the confirmRemove modal.
  document.getElementById("childFormModal").addEventListener("click", (e) => {
    if (e.target.id === "childFormModal") closeChildForm();
  });

  document.getElementById("childClubSearch").addEventListener("input", (e) => {
    filterChildClubs(e.target.value);
  });

  loadChildren(parentUid);
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  // The unified My Connections page no longer branches on ?mode= for the
  // page title or the remove/list behavior — it's always "My connections".
  // The URL param is still consumed as a convenience: a dashboard tile that
  // links here with ?mode=skater preselects "Add student" mode so the user
  // lands directly in that search flow. With the dashboard simplified to a
  // single tile per user, ?mode= is effectively optional.
  const urlMode = new URLSearchParams(window.location.search).get("mode");

  authGuard([], async (currentUser, userData) => {
    const myRoles = userData.rolesArray || [];

    injectNotificationBell(currentUser.uid);
    await loadAllClubs();

    // ---- Children-only mode (parent dashboard "My children" tile) ----
    // When the dashboard's "My children" tile links here with ?mode=children,
    // we render a stripped-down view: only the children section is shown.
    // The connections UI (search, action buttons, sent/pending/connected
    // lists) is hidden entirely. This keeps the children-management flow
    // separate from the connections flow even though they share a page.
    if (urlMode === "children" && myRoles.includes("parent")) {
      document.getElementById("page-title").textContent = t("myChildren");

      // Hide every connections-related element on the page. The label,
      // input and button live as siblings under the form-box with <br>
      // separators between them, so we wrap them in a flag-class hide
      // by toggling display directly on each.
      document.getElementById("action-buttons").style.display = "none";
      document.getElementById("search-label").style.display   = "none";
      document.getElementById("searchInput").style.display    = "none";
      document.getElementById("searchBtn").style.display      = "none";
      // Strip the stray <br> tags that surrounded the now-hidden label/
      // input/button so the children section sits directly under the
      // page title with no blank vertical gap.
      document.querySelectorAll(".form-box > br").forEach(br => br.remove());
      // Drop the leading <hr> inside the children section — it's a
      // divider meant to separate children from the connections list
      // above it, which doesn't exist in children-only mode.
      const childrenSection = document.getElementById("children-section");
      const leadingHr = childrenSection.querySelector("hr");
      if (leadingHr) leadingHr.remove();
      // Hide the inner "My children" heading. The page title at the top
      // of the form-box already says "My children", so showing the same
      // text again right above the Add-child button is redundant.
      document.getElementById("children-title").style.display = "none";
      // Sent / pending / connected sections are display:none by default and
      // only revealed when their respective render functions find data.
      // Skip loadConnections entirely so they stay hidden.

      initChildrenSection(currentUser.uid);
      initNav("addConnection.html");
      return;
    }

    // Page title is always "My connections" now.
    document.getElementById("page-title").textContent   = t("myConnections");
    document.getElementById("search-label").textContent = t("searchByName");
    document.getElementById("searchBtn").textContent    = t("search");

    // Search targets all roles. The previous role-toggle action buttons
    // ("Add coach" / "Add student") were removed — typing a name and
    // clicking Search is enough, and surfacing all matching users keeps
    // the flow simpler for both single-role and multi-role viewers.
    const rolesToSearch = ["coach", "affiliateCoach", "skater", "parent"];

    // Hide the (now unused) action-buttons container so its margin-bottom
    // doesn't leave a blank gap above the search label.
    document.getElementById("action-buttons").style.display = "none";

    await loadConnections(currentUser.uid, myRoles);

    // Children section is intentionally NOT shown on the regular "My
    // connections" page. Parents reach the children-management UI via the
    // dedicated "My children" dashboard tile, which loads this page with
    // ?mode=children and is handled by the early-return branch above.

    document.getElementById("searchBtn").addEventListener("click", () => {
      runSearch(currentUser, userData, rolesToSearch);
    });

    initNav("addConnection.html");
  });
});
