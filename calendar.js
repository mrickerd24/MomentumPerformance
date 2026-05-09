import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, formatFullName, escapeHtml, hasCoachRole } from "./app.js";
import { writeNotification, injectNotificationBell } from "./notifications.js";
import { collection, query, where, getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, Timestamp, serverTimestamp, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { calendarSessionTotalDisplay } from "./calendarSession.js";

// ---------------- SESSIONS ----------------
let cachedSessions = [];
let cachedIceSlots = [];


async function loadSessions(uid, roles, startDate, endDate) {
  const startTs = Timestamp.fromDate(startDate);
  const endTs   = Timestamp.fromDate(endDate);
  const sessionsRef = collection(db, "sessions");
  const sessionMap = new Map();
  const addSnap = (snap, filterByRange = false) => {
    snap.forEach(d => {
      const session = { id: d.id, ...d.data() };
      if (filterByRange) {
        const date = session.date && typeof session.date.toDate === "function"
          ? session.date.toDate()
          : null;
        if (!date || date < startDate || date > endDate) return;
      }
      sessionMap.set(d.id, session);
    });
  };

  const tasks = [];
  if (roles.includes("coach")) {
    tasks.push(getDocs(query(
      sessionsRef,
      where("coachUid", "==", uid),
      where("date", ">=", startTs),
      where("date", "<=", endTs)
    )).then(addSnap));
  }
  if (roles.includes("affiliateCoach")) {
    tasks.push(getDocs(query(
      sessionsRef,
      where("subcoachUid", "==", uid)
    )).then(snap => addSnap(snap, true)));
  }
  if (!roles.includes("coach") && !roles.includes("affiliateCoach")) {
    tasks.push(getDocs(query(
      sessionsRef,
      where("participants", "array-contains", uid),
      where("date", ">=", startTs),
      where("date", "<=", endTs)
    )).then(addSnap));
  }

  await Promise.all(tasks);
  cachedSessions = Array.from(sessionMap.values());
}

async function loadIceSlots(uid) {
  const snap = await getDocs(query(collection(db, "iceSlots"), where("coachUid", "==", uid)));
  cachedIceSlots = [];
  snap.forEach(d => cachedIceSlots.push({ id: d.id, ...d.data() }));
}

function sessionsForDate(date) {
  return cachedSessions.filter(s => {
    const d = s.date.toDate();
    return d.getFullYear() === date.getFullYear() &&
           d.getMonth()    === date.getMonth()    &&
           d.getDate()     === date.getDate();
  });
}

function iceSlotsForDate(date) {
  const dayOfWeek = date.getDay();
  const result = [];
  cachedIceSlots.forEach(slot => {
    const startDate = slot.startDate?.toDate();
    const endDate   = slot.endDate?.toDate() || null;
    if (!startDate) return;
    const d     = new Date(date); d.setHours(0,0,0,0);
    const start = new Date(startDate); start.setHours(0,0,0,0);
    if (d < start) return;
    if (endDate) { const e = new Date(endDate); e.setHours(23,59,59,999); if (d > e) return; }
    const rec = slot.recurrence || "once";
    if (rec === "once") {
      if (d.getTime() === start.getTime()) result.push(slot);
    } else if (rec === "weekly") {
      if ((slot.days || []).includes(dayOfWeek)) result.push(slot);
    } else if (rec === "biweekly") {
      if ((slot.days || []).includes(dayOfWeek)) {
        const diffMs    = d.getTime() - start.getTime();
        const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
        if (diffWeeks % 2 === 0) result.push(slot);
      }
    } else if (rec === "monthly") {
      if (d.getDate() === start.getDate()) result.push(slot);
    }
  });
  return result;
}

document.addEventListener("DOMContentLoaded", () => {
    applyLanguage();

    const requestedView = new URLSearchParams(window.location.search).get("view");
    let currentView = ["month", "week", "day"].includes(requestedView) ? requestedView : "month";
    let currentDate = new Date();
    let lang = getLang();
    let currentUser = null;
    let currentRoles = [];
    let currentUserFirstName = "";
    // Coach's hourly rate from account settings — used to pre-fill the
    // session pricing input when "Hourly" mode is selected. Defaults to 0
    // if the coach hasn't entered a rate yet, in which case the pre-fill is
    // blank and the coach types it in directly.
    let coachHourlyRate = 0;
    let coachFlatRate = 0;
    let myConnections = [];
    let subCoaches = [];

    // Index (0=Sun … 6=Sat) of the day the user wants their week to start
    // on. Sourced from users/{uid}.weekStart in the auth callback below
    // and used by every view that has a "week" concept (week view, month
    // grid leading blanks, month-day-of-week header row). Defaults to
    // Sunday until userData loads, matching the previous hardcoded
    // behaviour.
    let weekStartIdx = 0;
    const DAY_NAME_TO_INDEX = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6,
    };

    // Days back from `date` to reach the most recent occurrence of the
    // configured week-start day. Result is in [0, 6]. Used everywhere we
    // need the Date for the start of the displayed week.
    function daysSinceWeekStart(date) {
        return (date.getDay() - weekStartIdx + 7) % 7;
    }

    function currentPriceMode() {
        if (selectedSubCoach()) return "hourly";
        return document.querySelector('input[name="priceMode"]:checked')?.value || "hourly";
    }

    function currentPriceAmount() {
        const subCoach = selectedSubCoach();
        if (subCoach) {
            const rate = Number(subCoach.rateCents);
            if (rate > 0) return rate / 100;
        }
        return currentPriceMode() === "flat" ? coachFlatRate : coachHourlyRate;
    }

    async function loadSubCoaches(uid) {
        const snap = await getDocs(query(collection(db, "users", uid, "subcoaches")));
        subCoaches = [];
        const uidToSc = {};
        snap.forEach(d => {
            const data = d.data();
            const sc = { id: d.id, ...data, name: formatFullName(data), availabilitySlots: [] };
            subCoaches.push(sc);
            if (data.uid) uidToSc[data.uid] = sc;
        });

        // Pull correct names from connections (subcoach docs often have blank firstName/lastName)
        try {
            const connSnap = await getDocs(query(
                collection(db, "connections"),
                where("participants", "array-contains", uid),
                where("status", "==", "accepted")
            ));
            connSnap.forEach(d => {
                const data = d.data();
                const otherUid = data.participants.find(id => id !== uid);
                const roles = data.roles?.[otherUid] || [];
                if (roles.includes("affiliateCoach")) {
                    let sc = uidToSc[otherUid];
                    if (!sc) {
                        sc = {
                            id: otherUid,
                            uid: otherUid,
                            name: "",
                            firstName: "",
                            lastName: "",
                            rateCents: 0,
                            availabilitySlots: [],
                        };
                        subCoaches.push(sc);
                        uidToSc[otherUid] = sc;
                    }
                    if (!sc.name) sc.name = data.names?.[otherUid] || "";
                }
            });
        } catch (_) {}

        // Fetch availability + name fallback from each affiliate's user doc
        await Promise.all(subCoaches.map(async sc => {
            if (!sc.uid) return;
            try {
                const uSnap = await getDoc(doc(db, "users", sc.uid));
                if (uSnap.exists()) {
                    const ud = uSnap.data();
                    sc.availabilitySlots = ud.availabilitySlots || [];
                    if (!sc.name) sc.name = formatFullName(ud);
                }
            } catch (_) {}
        }));

        subCoaches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderSubCoachSelect(document.getElementById("sessionSubCoach")?.value || "");
        const subCoachRow = document.getElementById("subCoachRow");
        if (subCoachRow) subCoachRow.style.display = subCoaches.length > 0 ? "" : "none";
    }

    function selectedSubCoach() {
        const id = document.getElementById("sessionSubCoach")?.value || "";
        return id ? subCoaches.find(sc => sc.id === id) || null : null;
    }

    function subCoachAvailable(sc) {
        const dateVal  = document.getElementById("sessionDate")?.value;
        const iceStart = document.getElementById("iceStart")?.value;
        const iceEnd   = document.getElementById("iceEnd")?.value;
        const duration = parseInt(document.getElementById("sessionDuration")?.value, 10);
        if (!dateVal || !iceStart || !iceEnd || !sc.availabilitySlots?.length) return false;
        const date    = new Date(dateVal + "T12:00:00");
        const dayName = date.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
        const toMins  = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
        const patchStart = toMins(iceStart);
        const patchEnd   = toMins(iceEnd);
        const sessionMinutes = Number.isFinite(duration) && duration > 0 ? duration : 15;
        const requiredMinutes = Math.max(sessionMinutes, 15);
        return sc.availabilitySlots.some(slot => {
            if (slot.day !== dayName) return false;
            const overlapStart = Math.max(toMins(slot.from), patchStart);
            const overlapEnd = Math.min(toMins(slot.to), patchEnd);
            return overlapEnd - overlapStart >= requiredMinutes;
        });
    }

    function renderSubCoachSelect(selectedId = "") {
        const select = document.getElementById("sessionSubCoach");
        if (!select) return;
        const t = translations[getLang()] || {};
        const hasPatch = !!(document.getElementById("iceStart")?.value);
        const editingSession = !!(document.getElementById("editSessionId")?.value);
        select.innerHTML = "";

        const mainOption = document.createElement("option");
        mainOption.value = "";
        mainOption.textContent = t.mainCoach || "Main coach";
        select.appendChild(mainOption);

        subCoaches.forEach(sc => {
            const hasSlots = !!(sc.availabilitySlots?.length);
            if (!hasSlots && !(editingSession && sc.id === selectedId)) return;
            const avail = hasPatch ? subCoachAvailable(sc) : true;
            if (hasPatch && !avail && !(editingSession && sc.id === selectedId)) return;

            const option = document.createElement("option");
            option.value = sc.id;
            const baseName = sc.name || `${sc.firstName || ""} ${sc.lastName || ""}`.trim();
            if (hasPatch) {
                option.textContent = `${baseName} — ${avail ? (t.available || "Available") : (t.notAvailable || "Not available")}`;
            } else {
                option.textContent = baseName;
            }
            select.appendChild(option);
        });
        select.value = Array.from(select.options).some(option => option.value === selectedId) ? selectedId : "";
    }

    function updateSubCoachPricingState() {
        const subCoach = selectedSubCoach();
        const pricingBlock = document.getElementById("pricingBlock");
        if (pricingBlock) pricingBlock.style.display = subCoach ? "none" : "";
        if (subCoach) {
            document.getElementById("priceModeHourly").checked = true;
            document.getElementById("priceModeFlat").checked = false;
        }
        updatePriceModeLabels();
        updatePricingPreview();
    }

    function formatRateLabel(amount) {
        return "$" + (Number(amount) || 0).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function updatePriceModeLabels() {
        const t = translations[getLang()];
        const mode = currentPriceMode();
        const hourlyLabel = document.querySelector('#priceModeHourly + span');
        const flatLabel = document.querySelector('#priceModeFlat + span');
        if (hourlyLabel) {
            const base = t.priceModeHourly || "Hourly";
            hourlyLabel.textContent = mode === "hourly" ? `${base} (${formatRateLabel(coachHourlyRate)})` : base;
        }
        if (flatLabel) {
            const base = t.priceModeFlat || "Flat";
            flatLabel.textContent = mode === "flat" ? `${base} (${formatRateLabel(coachFlatRate)})` : base;
        }
    }

    // Resolve a session's participants + children into a list of display
    // names suitable for "Skating with: …" labels. Two flags control who
    // gets filtered out: excludeViewer drops the current user (always
    // wanted in viewer-context lists), and excludeCoach drops the coach
    // (wanted when the coach is shown separately, e.g. the view-session
    // modal has its own "Coach: …" row). Falls back to the raw id if a
    // lookup misses, which only happens for legacy data or unreachable
    // connections.
    function sessionAttendeeNames(session, { excludeViewer = true, excludeCoach = true, collapseParentWithChild = true } = {}) {
        const out = [];
        const childParentIdsOnSession = new Set(
            (session.children || [])
                .map(cid => {
                    const childConn = myConnections.find(c => c.kind === "child" && c.id === cid);
                    return childConn && childConn.parentId;
                })
                .filter(Boolean)
        );

        (session.participants || []).forEach(uid => {
            if (excludeCoach && uid === session.coachUid) return;
            if (excludeViewer && uid === currentUser.uid) return;
            const conn = myConnections.find(c => c.kind === "user" && c.uid === uid);
            // Skip a parent UID only when that same session already lists one
            // of their children. Parent+skater accounts can be booked directly
            // as the skater on a separate session, and their name must remain
            // visible in that case.
            if (collapseParentWithChild && childParentIdsOnSession.has(uid)) return;
            out.push(conn ? (conn.name || "—") : (session.participantNames?.[uid] || uid));
        });
        (session.children || []).forEach(cid => {
            const childConn = myConnections.find(c => c.kind === "child" && c.id === cid);
            out.push(childConn ? (childConn.name || "—") : (session.participantNames?.[cid] || cid));
        });
        return out;
    }

    function isGroupSession(session) {
        return Array.isArray(session.type) && session.type.includes("group");
    }

    const SESSION_COLORS = ["#6d30a6", "#1F845A", "#0097A7"];

    const TODAY = new Date();
    function isToday(d) {
        return d.getFullYear() === TODAY.getFullYear() &&
               d.getMonth()    === TODAY.getMonth()    &&
               d.getDate()     === TODAY.getDate();
    }

    function shortDayNames() {
        const names = [];
        // Jan 1 2023 is a Sunday — pick the day matching weekStartIdx as
        // the starting point so the array begins on the user's chosen
        // first day of the week.
        const ref = new Date(2023, 0, 1 + weekStartIdx);
        for (let i = 0; i < 7; i++) {
            names.push(ref.toLocaleDateString(lang, { weekday: "short" }));
            ref.setDate(ref.getDate() + 1);
        }
        return names;
    }

    function hourLabel(h) {
        if (lang === "fr") return `${String(h).padStart(2,"0")}h`;
        const suffix = h < 12 ? "AM" : "PM";
        const display = h % 12 === 0 ? 12 : h % 12;
        return `${display} ${suffix}`;
    }

    function toDateInputValue(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    function timeToMinutes(t) {
        if (!t) return null;
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
    }

    function getDateRange() {
        if (currentView === "month") {
            const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
            const end   = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
            end.setHours(23, 59, 59, 999);
            return { start, end };
        } else if (currentView === "week") {
            const start = new Date(currentDate);
            start.setDate(currentDate.getDate() - daysSinceWeekStart(currentDate));
            start.setHours(0, 0, 0, 0);
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            end.setHours(23, 59, 59, 999);
            return { start, end };
        } else {
            const start = new Date(currentDate); start.setHours(0, 0, 0, 0);
            const end   = new Date(currentDate); end.setHours(23, 59, 59, 999);
            return { start, end };
        }
    }

    async function loadConnections(uid) {
        const snap = await getDocs(
            query(collection(db, "connections"), where("participants", "array-contains", uid), where("status", "==", "accepted"))
        );
        myConnections = [];
        // Collect parent UIDs as we walk the connections so we can fetch
        // their children in one batched pass below. We still push the
        // parent themselves into myConnections so name resolution works
        // for sessions where the parent IS in participants — but parents
        // are NOT shown in the participant picker (handled in
        // renderParticipantCheckboxes).
        const parentUids = [];
        snap.forEach(d => {
            const data = d.data();
            const otherUid = data.participants.find(id => id !== uid);
            const otherRoles = data.roles?.[otherUid] || [];
            // Load every accepted connection regardless of role — we just need the
            // UID→name mapping for rendering session labels. Filtering by role
            // here previously excluded coaches from skaters' view, which is why
            // skaters saw raw UIDs instead of coach names.
            myConnections.push({
                kind: "user",
                uid: otherUid,
                name: data.names?.[otherUid] || "",
                roles: otherRoles,
            });
            if (otherRoles.includes("parent")) parentUids.push(otherUid);
        });

        // If the viewer themselves is a parent, also pull THEIR OWN children.
        // The connections-driven loop above only finds children of OTHER
        // connected parents (i.e. how a coach sees a parent's kids). A parent
        // viewer has no "connected parents" of their own, so without this
        // their kids never make it into myConnections — leaving session.children
        // entries unresolved and rendered as raw doc IDs.
        if (currentRoles.includes("parent") && !parentUids.includes(uid)) {
            parentUids.push(uid);
        }

        // Pull every child belonging to any connected parent. These become
        // selectable "participants" in the coach's session modal and
        // resolvable name entries when sessions reference them via the
        // session.children array. Stored on myConnections with kind:"child"
        // so callers can distinguish a real user UID from a child id.
        // Firestore "in" queries cap at 30 values, so we chunk parent UIDs.
        if (parentUids.length) {
            const chunks = [];
            for (let i = 0; i < parentUids.length; i += 30) {
                chunks.push(parentUids.slice(i, i + 30));
            }
            for (const chunk of chunks) {
                const childSnap = await getDocs(
                    query(collection(db, "children"), where("parentId", "in", chunk))
                );
                childSnap.forEach(d => {
                    const data = d.data();
                    const childName = formatFullName({
                        firstName: data.firstName,
                        lastName:  data.lastName,
                    });
                    myConnections.push({
                        kind:     "child",
                        id:       d.id,            // child doc id (NOT a uid)
                        parentId: data.parentId,
                        name:     childName,
                        roles:    ["skater"],      // children are skaters by definition
                        clubName: data.clubName || "",
                    });
                });
            }
        }
    }

    async function hydrateSessionNameLookups() {
        // Include participants/children whose connection entry exists but has
        // no name (e.g. connection created before name migration, or lookup
        // returned empty). Fetching the user doc gives us the current name.
        const knownUserUids = new Set(myConnections.filter(c => c.kind === "user" && c.name).map(c => c.uid));
        const knownChildIds = new Set(myConnections.filter(c => c.kind === "child" && c.name).map(c => c.id));
        const userUids = new Set();
        const childIds = new Set();

        cachedSessions.forEach(session => {
            (session.participants || []).forEach(uid => {
                if (uid && uid !== currentUser.uid && !knownUserUids.has(uid)) userUids.add(uid);
            });
            (session.children || []).forEach(cid => {
                if (cid && !knownChildIds.has(cid)) childIds.add(cid);
            });
        });

        await Promise.all([
            ...Array.from(userUids).map(async uid => {
                try {
                    const snap = await getDoc(doc(db, "users", uid));
                    if (!snap.exists()) return;
                    const data = snap.data();
                    const name  = formatFullName(data) || "";
                    const roles = Array.isArray(data.rolesArray) ? data.rolesArray : (data.roles || []);
                    const existing = myConnections.find(c => c.kind === "user" && c.uid === uid);
                    if (existing) {
                        existing.name  = name;
                        existing.roles = roles;
                    } else {
                        myConnections.push({ kind: "user", uid, name, roles });
                    }
                } catch (err) {
                    console.warn("Could not hydrate participant name", uid, err);
                }
            }),
            ...Array.from(childIds).map(async cid => {
                try {
                    const snap = await getDoc(doc(db, "children", cid));
                    if (!snap.exists()) return;
                    const data = snap.data();
                    const name = formatFullName(data) || "";
                    const existing = myConnections.find(c => c.kind === "child" && c.id === cid);
                    if (existing) {
                        existing.name     = name;
                        existing.parentId = data.parentId || null;
                    } else {
                        myConnections.push({ kind: "child", id: cid, parentId: data.parentId || null, name, roles: ["skater"], clubName: data.clubName || "" });
                    }
                } catch (err) {
                    console.warn("Could not hydrate child name", cid, err);
                }
            }),
        ]);
    }

    // ── SESSION MODAL ─────────────────────────────────────────────────────────
    const modal = document.getElementById("addSessionModal");
    let currentViewedSession = null;

    function openModal(prefill = {}) {
        document.getElementById("editSessionId").value   = "";
        document.getElementById("sessionDate").value     = prefill.date     || toDateInputValue(currentDate);
        document.getElementById("iceStart").value        = prefill.iceStart || "";
        document.getElementById("iceEnd").value          = prefill.iceEnd   || "";
        document.getElementById("sessionDuration").value = "";
        document.getElementById("sessionNotes").value    = "";
        document.getElementById("typePrivate").checked   = false;
        document.getElementById("typeGroup").checked     = false;
        document.getElementById("typeOffIce").checked    = false;
        renderSubCoachSelect("");
        // Default new sessions to hourly; the amount comes from payment
        // settings and is shown on the selected label.
        document.getElementById("priceModeHourly").checked = true;
        document.getElementById("priceModeFlat").checked   = false;
        updateSubCoachPricingState();
        document.getElementById("deleteSessionBtn-row").style.display = "none";
        const t = translations[getLang()];
        modal.querySelector("h3").textContent = t.addSession || "Add session";
        document.getElementById("saveSessionBtn").textContent = t.saveSession || "Save session";
        renderParticipantCheckboxes([]);
        // Render the patch picker for the selected date. If prefill provided a
        // specific patch (iceStart/iceEnd), that card will come up preselected.
        renderPatchPicker({
            preselectStart: prefill.iceStart || "",
            preselectEnd:   prefill.iceEnd   || "",
        });
        renderSubCoachSelect(document.getElementById("sessionSubCoach")?.value || "");
        updateSubCoachPricingState();
        updatePricingPreview();
        modal.classList.add("open");
    }

    function openEditModal(session) {
        const t = translations[getLang()];
        document.getElementById("editSessionId").value   = session.id;
        document.getElementById("sessionDate").value     = toDateInputValue(session.date.toDate());
        document.getElementById("iceStart").value        = session.iceStart  || "";
        document.getElementById("iceEnd").value          = session.iceEnd    || "";
        document.getElementById("sessionDuration").value = session.duration  || "";
        document.getElementById("sessionNotes").value    = session.notes     || "";
        // Private and Group are now a radio group (mutually exclusive).
        // Set them explicitly: private wins if a legacy session somehow has
        // both, otherwise group, otherwise neither. Off-ice is independent.
        const sessTypes = session.type || [];
        const hasPrivate = sessTypes.includes("private");
        const hasGroup   = sessTypes.includes("group");
        document.getElementById("typePrivate").checked = hasPrivate;
        document.getElementById("typeGroup").checked   = !hasPrivate && hasGroup;
        document.getElementById("typeOffIce").checked  = sessTypes.includes("off-ice");
        // Pricing — legacy sessions saved before this field existed default
        // to "hourly" with the coach's current rate, matching how the
        // dashboard interprets them. Sessions saved after the change carry
        // their own priceMode/priceAmount.
        const mode = session.priceMode === "flat" ? "flat" : "hourly";
        document.getElementById("priceModeHourly").checked = mode === "hourly";
        document.getElementById("priceModeFlat").checked   = mode === "flat";
        renderSubCoachSelect(session.subcoachId || "");
        updateSubCoachPricingState();
        document.getElementById("deleteSessionBtn-row").style.display = hasCoachRole(currentRoles) ? "" : "none";
        modal.querySelector("h3").textContent = t.editSession || "Edit session";
        document.getElementById("saveSessionBtn").textContent = t.updateSession || "Update session";
        const existingParticipants = (session.participants || []).filter(uid => uid !== session.coachUid);
        const existingChildren     = Array.isArray(session.children) ? session.children : [];
        renderParticipantCheckboxes(existingParticipants, existingChildren);
        renderParticipantNotes(session);
        renderPatchPicker({
            preselectStart: session.iceStart || "",
            preselectEnd:   session.iceEnd   || "",
        });
        renderSubCoachSelect(session.subcoachId || "");
        updateSubCoachPricingState();
        updatePricingPreview();
        modal.classList.add("open");
    }

    // Render the list of notes that participants (skaters/parents) have left
    // for this session. Only shown in the coach's edit modal; hidden when
    // there are no notes. Names come from myConnections; fall back to UID.
    function renderParticipantNotes(session) {
        const section = document.getElementById("participantNotesSection");
        const list    = document.getElementById("participantNotesList");
        list.innerHTML = "";
        const notesMap = session.participantNotes || {};
        const entries  = Object.entries(notesMap).filter(([_, text]) => text && text.trim());
        if (entries.length === 0) {
            section.style.display = "none";
            return;
        }
        entries.forEach(([uid, text]) => {
            const conn = myConnections.find(c => c.uid === uid);
            const name = conn ? (conn.name || uid) : uid;
            const item = document.createElement("div");
            item.className = "participant-note-item";
            const nameEl = document.createElement("div");
            nameEl.className = "participant-note-name";
            nameEl.textContent = name;
            const textEl = document.createElement("div");
            textEl.className = "participant-note-text";
            textEl.textContent = text;
            item.appendChild(nameEl);
            item.appendChild(textEl);
            list.appendChild(item);
        });
        section.style.display = "";
    }

    // Read-only session view for skaters/parents, with one editable field:
    // the viewer's personal "My note" that saves to participantNotes[uid].
    // Intentionally does NOT reuse the edit modal — different information
    // architecture (labelled rows vs form inputs) and different intent.
    function openViewModal(session) {
        const t = translations[getLang()];
        const viewModal = document.getElementById("viewSessionModal");
        currentViewedSession = session;

        document.getElementById("viewSessionId").value = session.id;

        // Date — localized
        const dateObj = session.date.toDate();
        document.getElementById("vsDate").textContent = dateObj.toLocaleDateString(getLang(), {
            weekday: "long", year: "numeric", month: "long", day: "numeric"
        });

        // Time — from iceStart/iceEnd if present, otherwise blank
        const timeStr = (session.iceStart && session.iceEnd)
            ? `${session.iceStart} – ${session.iceEnd}`
            : "—";
        document.getElementById("vsTime").textContent = timeStr;

        // Rink — prefer the denormalized value stored on the session itself
        // (saveSession writes it there at create/edit time). Only fall back to
        // looking through cached ice slots for legacy sessions saved before
        // the rink field was denormalized. The fallback uses iceSlotsForDate()
        // to respect recurrence, and comes up empty for skaters (they don't
        // own patches, so their cachedIceSlots is filtered out) — which is
        // why we denormalize in the first place.
        let rink = session.rink || "";
        if (!rink) {
            const matchingSlot = iceSlotsForDate(dateObj).find(slot =>
                (slot.startTime || "") === (session.iceStart || "") &&
                (slot.endTime   || "") === (session.iceEnd   || "")
            );
            rink = (matchingSlot && matchingSlot.rink) || "";
        }
        document.getElementById("vsRink").textContent = rink || "—";

        // Duration
        document.getElementById("vsDuration").textContent = session.duration
            ? `${session.duration} ${t.minutes || "min"}`
            : "—";

        // Type(s)
        const types = (session.type || []).map(tp => {
            if (tp === "private") return t.private   || "Private";
            if (tp === "group")   return t.group     || "Group";
            if (tp === "off-ice") return t.offIce    || "Off-ice";
            return tp;
        }).join(", ");
        document.getElementById("vsType").textContent = types || "—";

        // Participants
        const participantNames = sessionAttendeeNames(session, {
            excludeViewer: false,
            excludeCoach: true,
            collapseParentWithChild: !isGroupSession(session),
        });
        document.getElementById("vsParticipants").textContent = participantNames.join(", ") || "—";

        // Coach name
        const coachConn = myConnections.find(c => c.uid === session.coachUid);
        document.getElementById("vsCoach").textContent = session.subcoachName || (coachConn ? coachConn.name || "—" : "—");

        // Coach notes — hide row entirely if empty
        const coachNotesRow = document.getElementById("vsCoachNotesRow");
        if (session.notes && session.notes.trim()) {
            coachNotesRow.style.display = "";
            document.getElementById("vsCoachNotes").textContent = session.notes;
        } else {
            coachNotesRow.style.display = "none";
        }

        // Participant notes — render all notes (including own) as read-only
        // labeled blocks above the edit textarea, using the same style as
        // the coach-view participant notes list.
        const viewNotesSection = document.getElementById("vsParticipantNotesSection");
        const viewNotesList    = document.getElementById("vsParticipantNotesList");
        viewNotesList.innerHTML = "";
        const notesMap    = session.participantNotes || {};
        const noteEntries = Object.entries(notesMap).filter(([, text]) => text && text.trim());
        if (noteEntries.length > 0) {
            noteEntries.forEach(([noteUid, text]) => {
                let firstName;
                if (noteUid === currentUser.uid) {
                    firstName = currentUserFirstName || (t.me || "Me");
                } else {
                    const conn     = myConnections.find(c => c.uid === noteUid);
                    const fullName = conn ? (conn.name || "") : "";
                    firstName      = fullName ? fullName.split(" ")[0] : noteUid.slice(0, 8);
                }
                const item   = document.createElement("div");
                item.className = "participant-note-item";
                const nameEl = document.createElement("div");
                nameEl.className   = "participant-note-name";
                nameEl.textContent = firstName;
                const textEl = document.createElement("div");
                textEl.className   = "participant-note-text";
                textEl.textContent = text;
                item.appendChild(nameEl);
                item.appendChild(textEl);
                viewNotesList.appendChild(item);
            });
            viewNotesSection.style.display = "";
        } else {
            viewNotesSection.style.display = "none";
        }

        // My note — prefill textarea with whatever this user has saved before
        const myNote = (session.participantNotes || {})[currentUser.uid] || "";
        document.getElementById("vsMyNote").value = myNote;

        const canManageSession = currentRoles.includes("coach") && session.coachUid === currentUser.uid;
        document.getElementById("editViewSessionBtn").style.display = canManageSession ? "" : "none";
        document.getElementById("deleteViewSessionBtn").style.display = canManageSession ? "" : "none";

        viewModal.classList.add("open");
    }

    function closeViewModal() {
        document.getElementById("viewSessionModal").classList.remove("open");
        currentViewedSession = null;
    }

    // Save the current user's personal note for this session.
    // Uses runTransaction so the write waits for server confirmation —
    // updateDoc with persistentMultipleTabManager resolves from the local
    // IndexedDB cache before the server validates, silently swallowing any
    // rules rejection. runTransaction always round-trips to the server.
    async function saveMyNote() {
        const sessionId = document.getElementById("viewSessionId").value;
        if (!sessionId) return;
        const noteText = document.getElementById("vsMyNote").value.trim();
        const sessionRef = doc(db, "sessions", sessionId);
        try {
            await runTransaction(db, async (tx) => {
                const snap = await tx.get(sessionRef);
                if (!snap.exists()) throw new Error("Session not found");
                const existing = snap.data().participantNotes || {};
                tx.update(sessionRef, {
                    participantNotes: { ...existing, [currentUser.uid]: noteText }
                });
            });
            // Keep the in-memory cache in sync so reopening the modal shows
            // the saved note without a full page reload.
            const cached = cachedSessions.find(s => s.id === sessionId);
            if (cached) {
                if (!cached.participantNotes) cached.participantNotes = {};
                cached.participantNotes[currentUser.uid] = noteText;
            }
            closeViewModal();
        } catch (err) {
            alert("Could not save note: " + err.message);
        }
    }

    // Build the list of available ice patches for the date currently chosen in
    // the session modal. If there are patches, render them as selectable cards
    // and preselect whichever one matches preselectStart/preselectEnd (used
    // when editing or when a patch was tapped from day view). If there are
    // none, render an empty state with a button that opens the Add-patch
    // modal prefilled with that date.
    function renderPatchPicker({ preselectStart = "", preselectEnd = "" } = {}) {
        const listEl = document.getElementById("sessionPatchList");
        if (!listEl) return;
        const t = translations[getLang()];
        listEl.innerHTML = "";

        const dateVal = document.getElementById("sessionDate").value;
        if (!dateVal) {
            const hint = document.createElement("div");
            hint.className = "session-patch-empty";
            hint.textContent = t.selectDateFirst || "Please select a date to see available patches.";
            listEl.appendChild(hint);
            document.getElementById("iceStart").value = "";
            document.getElementById("iceEnd").value   = "";
            return;
        }

        const date = new Date(dateVal + "T12:00:00");
        const patches = iceSlotsForDate(date);

        if (patches.length === 0) {
            const empty = document.createElement("div");
            empty.className = "session-patch-empty";

            const msg = document.createElement("div");
            msg.textContent = t.noPatchesForDate || "No ice patches for this date.";
            empty.appendChild(msg);

            // Only coaches can add a patch — skaters wouldn't see the top-level
            // "Add ice slot" button either, so we mirror that gating here.
            if (hasCoachRole(currentRoles)) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = t.addPatchShort || "+ Add patch";
                btn.className = "btn-outlined-blue";
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    // Close the session modal and open the ice-slot modal
                    // prefilled with the date the user had picked. After the
                    // user saves the patch, saveIceSlot() already reloads
                    // patches and re-renders the calendar.
                    closeModal();
                    openIceSlotModal();
                    document.getElementById("slotStartDate").value = dateVal;
                });
                empty.appendChild(btn);
            }

            listEl.appendChild(empty);
            document.getElementById("iceStart").value = "";
            document.getElementById("iceEnd").value   = "";
            return;
        }

        // Render one card per patch. Tapping a card selects it and stores the
        // times in the hidden iceStart/iceEnd inputs so saveSession() can pick
        // them up without any further wiring.
        let selectedCard = null;
        patches.forEach(slot => {
            const card = document.createElement("div");
            card.className = "session-patch-card";
            card.dataset.start = slot.startTime || "";
            card.dataset.end   = slot.endTime   || "";

            const main = document.createElement("div");
            main.className = "session-patch-card-main";

            const time = document.createElement("div");
            time.className = "session-patch-card-time";
            time.textContent = (slot.startTime || "") + (slot.endTime ? " – " + slot.endTime : "");
            main.appendChild(time);

            if (slot.rink) {
                const rink = document.createElement("div");
                rink.className = "session-patch-card-rink";
                rink.textContent = slot.rink;
                main.appendChild(rink);
            }

            card.appendChild(main);

            card.addEventListener("click", () => {
                if (selectedCard) selectedCard.classList.remove("selected");
                card.classList.add("selected");
                selectedCard = card;
                document.getElementById("iceStart").value = card.dataset.start;
                document.getElementById("iceEnd").value   = card.dataset.end;
                renderSubCoachSelect(document.getElementById("sessionSubCoach")?.value || "");
                updateSubCoachPricingState();
            });

            // Preselect the card that matches the prefill (editing an existing
            // session, or coming from a tap on the "+ Add session" button
            // inside a specific patch in day view).
            if (preselectStart && (slot.startTime || "") === preselectStart &&
                (slot.endTime || "") === preselectEnd) {
                card.classList.add("selected");
                selectedCard = card;
                document.getElementById("iceStart").value = preselectStart;
                document.getElementById("iceEnd").value   = preselectEnd;
            }

            listEl.appendChild(card);
        });

        // If nothing was preselected, clear the hidden inputs so the user is
        // forced to pick a patch before saving.
        if (!selectedCard) {
            document.getElementById("iceStart").value = "";
            document.getElementById("iceEnd").value   = "";
        }
    }

    function renderParticipantCheckboxes(selectedUids = [], selectedChildIds = []) {
        const container = document.getElementById("session-participants");
        container.innerHTML = "";

        // Eligible participants for a coach booking a session:
        //   - Connected SKATERS (real user accounts).
        //   - CHILDREN of connected parents (loaded into myConnections by
        //     loadConnections with kind:"child"). The parent themselves is
        //     intentionally excluded — sessions are about who's on the ice,
        //     and the child is the skater. The parent still sees the session
        //     in their own calendar because their UID is added to the
        //     session's participants array at save time (so the
        //     array-contains query in loadSessions matches them).
        //
        // A skater label shows the skater's name. A child label shows the
        // child's name plus a small parenthetical so coaches with multiple
        // families can disambiguate two kids with the same first name.
        const skaters = myConnections.filter(c =>
            c.kind === "user" && (c.roles || []).includes("skater")
        );
        const children = myConnections.filter(c => c.kind === "child");

        if (skaters.length === 0 && children.length === 0) {
            container.innerHTML = '<p style="font-size:13px;color:#5E6C84;">No connected skaters</p>';
            return;
        }

        // Parent UID → parent name lookup, so we can label child rows with
        // "Emma (Marie Tremblay)" without an extra Firestore read.
        const parentNameByUid = {};
        myConnections
            .filter(c => c.kind === "user" && (c.roles || []).includes("parent"))
            .forEach(p => { parentNameByUid[p.uid] = p.name; });

        // Render skaters first, then children. Stable within each group.
        skaters.forEach(p => {
            const item = document.createElement("div");
            item.className = "participant-item";
            const checked = selectedUids.includes(p.uid) ? "checked" : "";
            item.innerHTML = `<input type="checkbox" id="p-${p.uid}" value="${p.uid}" data-kind="user" ${checked}/><label for="p-${p.uid}">${p.name}</label>`;
            container.appendChild(item);
        });

        children.forEach(c => {
            const item = document.createElement("div");
            item.className = "participant-item";
            const checked = selectedChildIds.includes(c.id) ? "checked" : "";
            const parentLabel = parentNameByUid[c.parentId] ? ` <span style="color:#5E6C84;font-size:11px;">(${parentNameByUid[c.parentId]})</span>` : "";
            // Prefix the DOM id with "c-" so it can never collide with a
            // user UID in the same form. The data-kind attribute is what
            // saveSession reads to split children out from real UIDs.
            item.innerHTML = `<input type="checkbox" id="c-${c.id}" value="${c.id}" data-kind="child" data-parent-uid="${c.parentId}" ${checked}/><label for="c-${c.id}">${c.name}${parentLabel}</label>`;
            container.appendChild(item);
        });
    }

    function closeModal() { modal.classList.remove("open"); }

    // Live total preview shown under the pricing mode selector. Mirrors the
    // dashboard's billing math (sessionAmount × privateMultiplier) so what
    // the coach sees in the preview matches what they'll be paid in their
    // earnings tiles. Hidden until amount + duration + at least one
    // attendee are all known — there's no point showing "$0.00" while the
    // coach is still filling out the form.
    function updatePricingPreview() {
        const previewEl = document.getElementById("pricingPreview");
        const valueEl   = document.getElementById("pricingPreviewValue");
        if (!previewEl || !valueEl) return;

        const hide = () => { previewEl.style.display = "none"; };
        const show = (txt) => {
            previewEl.style.display = "flex";
            valueEl.textContent = txt;
        };

        const amount = currentPriceAmount();
        const duration = parseInt(document.getElementById("sessionDuration").value);
        if (!amount || amount <= 0)     return hide();
        if (!duration || duration <= 0) return hide();

        // Count selected attendees (skater UIDs + child ids). Coach + parents
        // are not attendees for billing purposes — same rule as saveSession's
        // attendeeCount denormalization.
        const checked = document.querySelectorAll("#session-participants input:checked");
        if (checked.length === 0) return hide();

        const priceMode = currentPriceMode();
        const isPrivate = !!document.getElementById("typePrivate")?.checked;
        // Shared helper keeps the preview aligned with calendar lifecycle tests.
        const formatted = calendarSessionTotalDisplay({
            priceMode,
            priceAmount: amount,
            duration,
            attendeeCount: checked.length,
            isPrivate,
        }, "en");
        show(formatted);
    }

    async function saveSession() {
        const sessionId = document.getElementById("editSessionId").value;
        const dateVal   = document.getElementById("sessionDate").value;
        const iceStart  = document.getElementById("iceStart").value;
        const iceEnd    = document.getElementById("iceEnd").value;
        const duration  = parseInt(document.getElementById("sessionDuration").value);
        const notes     = document.getElementById("sessionNotes").value.trim();
        const types = [];
        if (document.getElementById("typePrivate").checked) types.push("private");
        if (document.getElementById("typeGroup").checked)   types.push("group");
        if (document.getElementById("typeOffIce").checked)  types.push("off-ice");
        // Pricing — priceMode is "hourly" or "flat"; priceAmount is the
        // hourly rate when hourly, the total session fee when flat. Both
        // are stored on the session so the dashboard earnings tiles can
        // compute totals without re-reading the coach's settings.
        const subCoach = selectedSubCoach();
        const priceMode   = currentPriceMode();
        const priceAmount = currentPriceAmount();

        // Split the form selection into two buckets:
        //   - selectedUserUids: real user UIDs (skaters). These go straight
        //     into session.participants.
        //   - selectedChildEntries: child id + parent UID pairs. The child
        //     id goes into session.children; the parent UID is added to
        //     session.participants so the parent's calendar (which queries
        //     sessions via array-contains on participants) shows the
        //     session and the parent can edit it.
        // The data-kind attribute is set in renderParticipantCheckboxes —
        // it's how we tell child checkboxes apart from skater ones.
        const selectedUserUids = [];
        const selectedChildEntries = [];
        document.querySelectorAll("#session-participants input:checked").forEach(el => {
            const kind = el.dataset.kind || "user";
            if (kind === "child") {
                selectedChildEntries.push({ id: el.value, parentUid: el.dataset.parentUid });
            } else {
                selectedUserUids.push(el.value);
            }
        });
        // Deduplicate parent UIDs — if a coach picks two children of the
        // same parent, that parent should appear in participants only
        // once. The Set also prevents an explicit skater + their (rare)
        // self-as-parent edge case from doubling up.
        const parentUidsFromChildren = Array.from(new Set(
            selectedChildEntries.map(e => e.parentUid).filter(Boolean)
        ));
        const childIds = selectedChildEntries.map(e => e.id);
        const totalSelected = selectedUserUids.length + childIds.length;
        if (!dateVal)                          { alert("Please select a date"); return; }
        if (!iceStart)                         { alert((translations[getLang()].mustSelectPatch) || "Please select an ice patch."); return; }
        if (types.length === 0)                { alert("Please select at least one session type"); return; }
        if (!duration || duration < 1)         { alert("Please enter a valid duration"); return; }
        if (totalSelected === 0)               { alert("Please select at least one participant"); return; }

        // Denormalize the rink name onto the session. Skaters don't own ice
        // patches (loadIceSlots queries by ownerUid), so without this they'd
        // have no way to look up which rink a coach-created session is at —
        // openViewModal's iceSlotsForDate() call comes back empty for them.
        // The coach saving the session DOES have cachedIceSlots loaded, so we
        // resolve it here once and store it on the doc.
        const dateObj = new Date(dateVal + "T12:00:00");
        const matchingSlot = iceSlotsForDate(dateObj).find(sl =>
            (sl.startTime || "") === iceStart &&
            (sl.endTime   || "") === iceEnd
        );
        const rink = (matchingSlot && matchingSlot.rink) || "";

        // Build participants from the coach + every selected skater UID +
        // every parent of a selected child. Deduplicated via Set so a
        // coach who is also a skater (or a parent who is also a coach
        // somehow) doesn't appear twice.
        const participantsSet = new Set([currentUser.uid, ...selectedUserUids, ...parentUidsFromChildren]);

        // Denormalize the count of *skating* attendees onto the session.
        // This is what dashboards split price by (group sessions split
        // evenly across the skaters, NOT across coach + parents). It's
        // simply skater UIDs + child ids — parents and the coach never
        // count as attendees even though they sit in `participants` for
        // permission/visibility purposes.
        const attendeeCount = selectedUserUids.length + childIds.length;

        const sessionData = {
            participants: Array.from(participantsSet),
            children:     childIds,
            attendeeCount,
            date: Timestamp.fromDate(dateObj),
            iceStart, iceEnd, duration, type: types, notes, rink,
            priceMode, priceAmount,
            subcoachId: subCoach ? subCoach.id : null,
            subcoachName: subCoach ? subCoach.name : null,
            subcoachUid: subCoach ? (subCoach.uid || null) : null,
            subcoachFirstName: subCoach ? (subCoach.firstName || "") : null,
            subcoachLastName: subCoach ? (subCoach.lastName || "") : null,
            subcoachRateCents: subCoach ? (Number(subCoach.rateCents) || 0) : null,
        };
        // Participants who should receive notifications (everyone except the coach).
        const notifRecipients = Array.from(participantsSet).filter(u => u !== currentUser.uid);
        const notifDateStr = new Date(dateVal + "T12:00:00").toLocaleDateString(
            getLang() === "fr" ? "fr-CA" : "en-US", { month: "short", day: "numeric" }
        );

        if (sessionId) {
            await updateDoc(doc(db, "sessions", sessionId), sessionData);
            notifRecipients.forEach(recipientUid => {
                writeNotification(recipientUid, {
                    type:   "session_updated",
                    params: { date: notifDateStr },
                    link:   "calendar.html",
                });
            });
        } else {
            // invoiceId: null must be explicit so Firestore's
            // where("invoiceId", "==", null) query matches this session.
            const isPrivate = types.includes("private");
            if (isPrivate && attendeeCount > 1) {
                const batch = writeBatch(db);
                const sessionsRef = collection(db, "sessions");

                selectedUserUids.forEach(uid => {
                    batch.set(doc(sessionsRef), {
                        ...sessionData,
                        participants: Array.from(new Set([currentUser.uid, uid])),
                        children: [],
                        attendeeCount: 1,
                        coachUid: currentUser.uid,
                        createdAt: serverTimestamp(),
                        invoiceId: null,
                    });
                });

                selectedChildEntries.forEach(child => {
                    batch.set(doc(sessionsRef), {
                        ...sessionData,
                        participants: Array.from(new Set([currentUser.uid, child.parentUid].filter(Boolean))),
                        children: [child.id],
                        attendeeCount: 1,
                        coachUid: currentUser.uid,
                        createdAt: serverTimestamp(),
                        invoiceId: null,
                    });
                });

                await batch.commit();
            } else {
                await addDoc(collection(db, "sessions"), { ...sessionData, coachUid: currentUser.uid, createdAt: serverTimestamp(), invoiceId: null });
            }
            notifRecipients.forEach(recipientUid => {
                writeNotification(recipientUid, {
                    type:   "session_created",
                    params: { date: notifDateStr },
                    link:   "calendar.html",
                });
            });
        }
        closeModal();
        await renderAndLoad();
    }

    async function deleteSession() {
        const sessionId = document.getElementById("editSessionId").value;
        if (!sessionId) return;
        await deleteSessionById(sessionId);
        closeModal();
        await renderAndLoad();
    }

    async function deleteSessionById(sessionId, sessionObj = null) {
        const session = sessionObj || cachedSessions.find(s => s.id === sessionId);
        await deleteDoc(doc(db, "sessions", sessionId));
        if (session) {
            const sessionDate = typeof session.date?.toDate === "function"
                ? session.date.toDate()
                : new Date();
            const notifDateStr = sessionDate.toLocaleDateString(
                getLang() === "fr" ? "fr-CA" : "en-US", { month: "short", day: "numeric" }
            );
            (session.participants || [])
                .filter(u => u !== currentUser.uid)
                .forEach(recipientUid => {
                    writeNotification(recipientUid, {
                        type:   "session_deleted",
                        params: { date: notifDateStr },
                        link:   "calendar.html",
                    });
                });
        }
    }

    // ── ICE SLOT MODAL ────────────────────────────────────────────────────────
    const iceModal = document.getElementById("addIceSlotModal");

    const RINKS = [
        { name: "Aréna Ahuntsic",                      arrondissement: "Ahuntsic-Cartierville" },
        { name: "Aréna André-Laperrière",               arrondissement: "Outremont" },
        { name: "Aréna Bill-Durnan",                    arrondissement: "Côte-des-Neiges–Notre-Dame-de-Grâce" },
        { name: "Aréna Camillien-Houde",                arrondissement: "Ville-Marie" },
        { name: "Aréna Chaumont",                       arrondissement: "Anjou" },
        { name: "Aréna Chénier",                        arrondissement: "Anjou" },
        { name: "Aréna Clément-Jetté",                  arrondissement: "Mercier–Hochelaga-Maisonneuve" },
        { name: "Aréna de Saint-Michel",                arrondissement: "Villeray–Saint-Michel–Parc-Extension" },
        { name: "Aréna Doug-Harvey",                    arrondissement: "Côte-des-Neiges–Notre-Dame-de-Grâce" },
        { name: "Aréna du complexe St-Jean-Vianney",    arrondissement: "Rivière-des-Prairies–Pointe-aux-Trembles" },
        { name: "Aréna Étienne-Desmarteau",             arrondissement: "Rosemont–La Petite-Patrie" },
        { name: "Aréna Fleury",                         arrondissement: "Montréal-Nord" },
        { name: "Aréna Francis-Bouillon",               arrondissement: "Mercier–Hochelaga-Maisonneuve" },
        { name: "Aréna Garon",                          arrondissement: "Montréal-Nord" },
        { name: "Aréna Georges-Mantha",                 arrondissement: "Le Sud-Ouest" },
        { name: "Aréna Howie-Morenz",                   arrondissement: "Villeray–Saint-Michel–Parc-Extension" },
        { name: "Aréna Jacques-Lemaire",                arrondissement: "LaSalle" },
        { name: "Aréna Marcelin-Wilson",                arrondissement: "Ahuntsic-Cartierville" },
        { name: "Aréna Martin-Brodeur",                 arrondissement: "Saint-Léonard" },
        { name: "Aréna Martin-Lapointe",                arrondissement: "Lachine" },
        { name: "Aréna Maurice-Richard",                arrondissement: "Mercier–Hochelaga-Maisonneuve" },
        { name: "Aréna Michel-Normandin",               arrondissement: "Ahuntsic-Cartierville" },
        { name: "Aréna Mont-Royal",                     arrondissement: "Le Plateau-Mont-Royal" },
        { name: "Aréna Père-Marquette",                 arrondissement: "Rosemont–La Petite-Patrie" },
        { name: "Aréna Pierre « Pete » Morin",          arrondissement: "Lachine" },
        { name: "Aréna Raymond-Bourque",                arrondissement: "Saint-Laurent" },
        { name: "Aréna René-Masson",                    arrondissement: "Rivière-des-Prairies–Pointe-aux-Trembles" },
        { name: "Aréna Roberto-Luongo",                 arrondissement: "Saint-Léonard" },
        { name: "Aréna Rodrigue-Gilbert",               arrondissement: "Rivière-des-Prairies–Pointe-aux-Trembles" },
        { name: "Aréna Rolland",                        arrondissement: "Montréal-Nord" },
        { name: "Aréna Saint-Charles",                  arrondissement: "Le Sud-Ouest" },
        { name: "Aréna Saint-Donat",                    arrondissement: "Mercier–Hochelaga-Maisonneuve" },
        { name: "Aréna Saint-Louis",                    arrondissement: "Le Plateau-Mont-Royal" },
        { name: "Aréna Sylvio-Mantha",                  arrondissement: "Le Sud-Ouest" },
    ];

    function normalizeRink(str) {
        return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    }

    function filterRinks(searchTerm) {
        const raw = normalizeRink(searchTerm.trim());
        const resultsDiv = document.getElementById("slotRink-results");
        if (!resultsDiv) return;
        resultsDiv.innerHTML = "";
        if (!raw) return;

        const matches = RINKS.filter(r =>
            normalizeRink(r.name).includes(raw) ||
            normalizeRink(r.arrondissement).includes(raw)
        );

        matches.forEach(rink => {
            const card = document.createElement("div");
            card.className = "student-card";
            card.style.cursor = "pointer";
            card.innerHTML =
                '<strong style="font-size:14px">' + rink.name + '</strong><br>' +
                '<span style="font-size:12px;color:#5E6C84">' + rink.arrondissement + '</span>';
            card.addEventListener("click", () => {
                document.getElementById("slotRink").value = rink.name;
                document.getElementById("slotRinkSearch").value = rink.name;
                resultsDiv.innerHTML = "";
            });
            resultsDiv.appendChild(card);
        });
    }

    function toggleSlotDaysRow() {
        const rec = document.getElementById("slotRecurrence").value;
        const row = document.getElementById("slotDays-row");
        row.style.display = (rec === "weekly" || rec === "biweekly") ? "" : "none";
    }

    function openIceSlotModal() {
        document.getElementById("editIceSlotId").value        = "";
        document.getElementById("slotRink").value             = "";
        document.getElementById("slotRinkSearch").value       = "";
        document.getElementById("slotRink-results").innerHTML = "";
        document.getElementById("slotStart").value       = "";
        document.getElementById("slotEnd").value         = "";
        document.getElementById("slotStartDate").value   = toDateInputValue(currentDate);
        document.getElementById("slotEndDate").value     = "";
        document.getElementById("slotRecurrence").value  = "once";
        document.querySelectorAll('input[name="slotDay"]').forEach(cb => cb.checked = false);
        document.getElementById("deleteIceSlotBtn-row").style.display = "none";
        const t = translations[getLang()];
        iceModal.querySelector("h3").textContent = t.addIceSlot || "Add ice slot";
        document.getElementById("saveIceSlotBtn").textContent = t.saveIceSlot || "Save ice slot";
        toggleSlotDaysRow();
        iceModal.classList.add("open");
    }

    function openEditIceSlotModal(slot) {
        const t = translations[getLang()];
        document.getElementById("editIceSlotId").value        = slot.id;
        document.getElementById("slotRink").value             = slot.rink || "";
        document.getElementById("slotRinkSearch").value       = slot.rink || "";
        document.getElementById("slotRink-results").innerHTML = "";
        document.getElementById("slotStart").value       = slot.startTime  || "";
        document.getElementById("slotEnd").value         = slot.endTime    || "";
        document.getElementById("slotStartDate").value   = slot.startDate ? toDateInputValue(slot.startDate.toDate()) : "";
        document.getElementById("slotEndDate").value     = slot.endDate   ? toDateInputValue(slot.endDate.toDate())   : "";
        document.getElementById("slotRecurrence").value  = slot.recurrence || "once";
        document.querySelectorAll('input[name="slotDay"]').forEach(cb => {
            cb.checked = (slot.days || []).includes(parseInt(cb.value));
        });
        document.getElementById("deleteIceSlotBtn-row").style.display = "";
        iceModal.querySelector("h3").textContent = t.editIceSlot || "Edit ice slot";
        document.getElementById("saveIceSlotBtn").textContent = t.saveIceSlot || "Save ice slot";
        toggleSlotDaysRow();
        iceModal.classList.add("open");
    }

    function closeIceModal() { iceModal.classList.remove("open"); }

    // ── SESSIONS-IN-PATCH MODAL ──────────────────────────────────────────────
    // Opened when the user taps an ice patch in day view. Lists every session
    // that belongs to that patch with a clickable row per session; coaches can
    // tap a row to edit that session, or tap "Edit patch" to edit the patch
    // itself.
    const sessionsInSlotModal = document.getElementById("sessionsInSlotModal");
    let currentSlotForListModal = null;

    function openSessionsInSlotModal(slot) {
        currentSlotForListModal = slot;
        const t = translations[getLang()];
        const isCoach = hasCoachRole(currentRoles);

        // Title: "Sessions · <rink> <start>–<end>" when we have the info
        const titleEl = document.getElementById("sessionsInSlotTitle");
        const baseTitle = t.sessionsInPatch || "Sessions in this patch";
        const timeRange = slot.startTime && slot.endTime
            ? ` · ${slot.startTime}–${slot.endTime}`
            : "";
        const rinkPart = slot.rink ? ` · ${slot.rink}` : "";
        titleEl.textContent = baseTitle + rinkPart + timeRange;

        // Collect sessions that match this patch's time window
        const sessions = sessionsForDate(currentDate).filter(s =>
            (s.iceStart || "") === (slot.startTime || "") &&
            (s.iceEnd   || "") === (slot.endTime   || "")
        );

        const listEl = document.getElementById("sessionsInSlotList");
        listEl.innerHTML = "";

        if (sessions.length === 0) {
            const empty = document.createElement("div");
            empty.className = "sis-empty";
            empty.textContent = t.noSessionsInPatch || "No sessions in this patch yet.";
            listEl.appendChild(empty);
        } else {
            sessions.forEach((s, idx) => {
                const color = SESSION_COLORS[idx % SESSION_COLORS.length];
                // Show only the booked skater/child names. Coach and parent
                // UIDs are stored for visibility, not as attendee labels.
                const names = sessionAttendeeNames(s, {
                    excludeViewer: true,
                    excludeCoach: true,
                    collapseParentWithChild: !isGroupSession(s),
                }).join(", ");

                const item = document.createElement("div");
                item.className = "sis-session-item";

                const bar = document.createElement("div");
                bar.className = "sis-session-bar";
                bar.style.background = color;

                const body = document.createElement("div");
                body.className = "sis-session-body";
                const types = (s.type || []).map(tp => {
                    if (tp === "private") return t.private || "Private";
                    if (tp === "group")   return t.group   || "Group";
                    if (tp === "off-ice") return t.offIce  || "Off-ice";
                    return tp;
                }).join(", ");
                const minLabel = t.minutes || "min";
                body.innerHTML = `
                    <div class="sis-session-name">${names || "—"}</div>
                    <div class="sis-session-meta">${s.duration} ${minLabel}${types ? " · " + types : ""}</div>
                `;

                item.appendChild(bar);
                item.appendChild(body);

                item.addEventListener("click", (e) => {
                    e.stopPropagation();
                    closeSessionsInSlotModal();
                    if (isCoach) {
                        openEditModal(s);
                    } else {
                        openViewModal(s);
                    }
                });

                listEl.appendChild(item);
            });
        }

        // Only coaches can edit the patch itself
        const editPatchBtn = document.getElementById("editPatchFromListBtn");
        editPatchBtn.style.display = isCoach ? "" : "none";

        sessionsInSlotModal.classList.add("open");
    }

    function closeSessionsInSlotModal() {
        sessionsInSlotModal.classList.remove("open");
        currentSlotForListModal = null;
    }

    async function saveIceSlot() {
        const slotId     = document.getElementById("editIceSlotId").value;
        const rink       = document.getElementById("slotRink").value.trim();
        const startTime  = document.getElementById("slotStart").value;
        const endTime    = document.getElementById("slotEnd").value;
        const startDateV = document.getElementById("slotStartDate").value;
        const endDateV   = document.getElementById("slotEndDate").value;
        const recurrence = document.getElementById("slotRecurrence").value;
        const days       = Array.from(document.querySelectorAll('input[name="slotDay"]:checked')).map(cb => parseInt(cb.value));
        if (!startTime || !startDateV) { alert("Please fill in start time and start date"); return; }
        if ((recurrence === "weekly" || recurrence === "biweekly") && days.length === 0) {
            alert("Please select at least one day"); return;
        }
        const slotData = {
            coachUid: currentUser.uid, rink, startTime, endTime, recurrence,
            days:      (recurrence === "weekly" || recurrence === "biweekly") ? days : [],
            startDate: Timestamp.fromDate(new Date(startDateV + "T12:00:00")),
            endDate:   endDateV ? Timestamp.fromDate(new Date(endDateV + "T23:59:59")) : null,
        };
        if (slotId) {
            await updateDoc(doc(db, "iceSlots", slotId), slotData);
        } else {
            await addDoc(collection(db, "iceSlots"), { ...slotData, createdAt: serverTimestamp() });
        }
        closeIceModal();
        await loadIceSlots(currentUser.uid);
        renderCalendar();
    }

    async function deleteIceSlot() {
        const slotId = document.getElementById("editIceSlotId").value;
        if (!slotId) return;
        await deleteDoc(doc(db, "iceSlots", slotId));
        closeIceModal();
        await loadIceSlots(currentUser.uid);
        renderCalendar();
    }

    // ── RENDERERS ─────────────────────────────────────────────────────────────
    function renderMonth() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "month-view";
        grid.innerHTML = "";

        const year  = currentDate.getFullYear();
        const month = currentDate.getMonth();
        // Leading blank count = days since the user's chosen week-start
        // for the 1st of the month. With a Sunday-start preference and a
        // Wednesday-1st, this is 3; with a Monday-start preference, 2.
        const firstDay    = daysSinceWeekStart(new Date(year, month, 1));
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrev  = new Date(year, month, 0).getDate();

        // ── Top summary card ── totals across the whole month.
        // "is-today" border when today falls inside the displayed month.
        const monthStart = new Date(year, month, 1);
        const monthEnd   = new Date(year, month, daysInMonth);
        const today = new Date();
        const isCurrentMonth =
            today.getFullYear() === year && today.getMonth() === month;
        const headerText = currentDate.toLocaleDateString(lang, {
            month: "long", year: "numeric"
        });
        grid.appendChild(buildPeriodSummaryCard(
            monthStart, monthEnd, headerText, isCurrentMonth, "in-month-view"
        ));

        shortDayNames().forEach(name => {
            const h = document.createElement("div");
            h.className = "cal-day-header";
            h.textContent = name;
            grid.appendChild(h);
        });

        let cells = [];
        for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, thisMonth: false });
        for (let d = 1; d <= daysInMonth; d++)   cells.push({ day: d, thisMonth: true, date: new Date(year, month, d) });
        let next = 1;
        while (cells.length % 7 !== 0) cells.push({ day: next++, thisMonth: false });

        cells.forEach(c => {
            const cell = document.createElement(c.date ? "button" : "div");
            cell.className = "cal-day-cell";
            if (c.date) {
                cell.type = "button";
                // Store date as ISO string so the delegated handler on #calendar-grid
                // can look it up on tap/click — more reliable on mobile than per-cell
                // listeners that get torn down on every re-render.
                cell.dataset.date = c.date.toISOString();
            }

            const inner = document.createElement("span");
            inner.textContent = c.day;
            if (!c.thisMonth)                   inner.className = "cal-day other-month";
            else if (c.date && isToday(c.date)) inner.className = "cal-day today";
            else                                inner.className = "cal-day";

            if (c.date && c.thisMonth) {
                if (isToday(c.date)) {
                    cell.classList.add("is-today");
                }
                if (iceSlotsForDate(c.date).length > 0) {
                    cell.classList.add("has-ice");
                }
                if (sessionsForDate(c.date).length > 0) {
                    const dot = document.createElement("span");
                    dot.className = "session-dot";
                    inner.appendChild(dot);
                }
            }

            cell.appendChild(inner);
            grid.appendChild(cell);
        });
    }

    function renderWeek() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "week-view";
        grid.innerHTML = "";

        const t = translations[getLang()];
        const isCoach = hasCoachRole(currentRoles);

        // Start on the user's chosen first day of the week (configured
        // in account settings, defaults to Sunday).
        const start = new Date(currentDate);
        start.setDate(currentDate.getDate() - daysSinceWeekStart(currentDate));
        const weekEnd = new Date(start);
        weekEnd.setDate(start.getDate() + 6);

        // ── Top summary card ── totals across the whole week.
        // "is-today" border when today falls inside the displayed week.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isCurrentWeek = today >= start && today <= weekEnd;
        const headerText =
            start.toLocaleDateString(lang, { month: "short", day: "numeric" }) +
            " – " +
            weekEnd.toLocaleDateString(lang, { month: "short", day: "numeric" });
        grid.appendChild(buildPeriodSummaryCard(
            start, weekEnd, headerText, isCurrentWeek, "in-week-view"
        ));

        for (let i = 0; i < 7; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);

            const card = document.createElement("button");
            card.type = "button";
            card.className = "week-day-card" + (isToday(d) ? " today" : "");
            card.dataset.date = d.toISOString();

            // ── Header: weekday + date number ──
            const header = document.createElement("div");
            header.className = "week-day-card-header";

            const weekday = document.createElement("div");
            weekday.className = "week-day-card-weekday";
            weekday.textContent = d.toLocaleDateString(lang, { weekday: "long" });

            const dateLine = document.createElement("div");
            dateLine.className = "week-day-card-date";
            dateLine.textContent = d.toLocaleDateString(lang, { month: "short", day: "numeric" });

            header.appendChild(weekday);
            header.appendChild(dateLine);
            card.appendChild(header);

            // ── Body: summary stats ──
            const body = document.createElement("div");
            body.className = "week-day-card-body";

            const daySessions = sessionsForDate(d);
            const daySlots    = iceSlotsForDate(d);

            if (daySessions.length === 0 && daySlots.length === 0) {
                const empty = document.createElement("div");
                empty.className = "week-day-card-empty";
                empty.textContent = t.noActivityThisDay || "Nothing scheduled";
                body.appendChild(empty);
            } else {
                // Coaches see: patches · sessions · booked/free time.
                // Skaters don't own patches, so the "patches" stat and free-time
                // math aren't meaningful for them — they see a simpler summary:
                // sessions · total booked time.
                if (isCoach) {
                    // Aggregate across all patches for this day
                    const totalPatchMin = daySlots.reduce((sum, sl) => {
                        const s = timeToMinutes(sl.startTime);
                        const e = timeToMinutes(sl.endTime);
                        return sum + ((s !== null && e && e > s) ? (e - s) : 0);
                    }, 0);
                    const totalBooked = daySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
                    const free = Math.max(0, totalPatchMin - totalBooked);

                    body.appendChild(buildStat(
                        daySlots.length,
                        daySlots.length === 1
                            ? (t.patchSingular || "patch")
                            : (t.patchPlural   || "patches")
                    ));
                    body.appendChild(buildStat(
                        daySessions.length,
                        daySessions.length === 1
                            ? (t.sessionSingular || "session")
                            : (t.sessionPlural   || "sessions")
                    ));
                    if (totalPatchMin > 0) {
                        body.appendChild(buildStat(
                            totalBooked,
                            t.minBooked || "min booked"
                        ));
                        body.appendChild(buildStat(
                            free,
                            t.minFree || "min free"
                        ));
                    }
                } else {
                    const totalBooked = daySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
                    body.appendChild(buildStat(
                        daySessions.length,
                        daySessions.length === 1
                            ? (t.sessionSingular || "session")
                            : (t.sessionPlural   || "sessions")
                    ));
                    if (totalBooked > 0) {
                        body.appendChild(buildStat(
                            totalBooked,
                            t.minutes || "min"
                        ));
                    }
                }
            }

            card.appendChild(body);
            grid.appendChild(card);
        }
    }

    // Small helper for the week-view day cards: renders a "<number> <label>"
    // stat pill. Extracted so each stat in renderWeek stays a one-liner.
    function buildStat(value, label) {
        const el = document.createElement("div");
        el.className = "week-day-card-stat";
        const num = document.createElement("span");
        num.className = "week-day-card-stat-num";
        num.textContent = value;
        const lbl = document.createElement("span");
        lbl.className = "week-day-card-stat-label";
        lbl.textContent = label;
        el.appendChild(num);
        el.appendChild(lbl);
        return el;
    }

    // Day-view ice patch color palette. Each patch on a given day cycles
    // through these by its sorted index. The CSS class names below
    // (.patch-color-blue, etc.) carry all the actual color values; the
    // palette here just lists the cycle order.
    const PATCH_COLORS = ["blue", "green", "amber", "coral", "teal"];

    // Build a colored pill (numeric value + small label). Used for the
    // top day-summary card and inside each ice-patch card. The .patch-pill
    // class plus the patch-color-* class on the parent (or an explicit
    // colorClass param) drives the color theme.
function buildPatchPill(value, label, colorClass) {
    const el = document.createElement("span");
    el.className = "patch-pill" + (colorClass ? " " + colorClass : "");

    const num = document.createElement("span");
    num.className = "patch-pill-num";
    num.textContent = value;

    const lbl = document.createElement("span");
    lbl.className = "patch-pill-label";
    lbl.textContent = label;

    el.appendChild(num);
    el.appendChild(lbl);

    return el;
}

    // Build a summary card for an arbitrary date range (used by week and
    // month views). Matches the day-view summary card layout: header on
    // the left (label like "This week" / month name), neutral pill row on
    // the right with totals across the range.
    //
    //   rangeStart, rangeEnd : inclusive Date range
    //   headerText           : string shown in the card header
    //   isCurrentPeriod      : if true, applies the purple "today" border
    //   extraClass           : optional class for view-specific layout
    //                          (e.g. "in-month-view") so CSS can place the
    //                          card correctly in non-2-column grids.
    function buildPeriodSummaryCard(rangeStart, rangeEnd, headerText, isCurrentPeriod, extraClass) {
        const t = translations[getLang()];
        const isCoach = hasCoachRole(currentRoles);

        // Aggregate across every day in the range.
        let totalPatches = 0;
        let totalSessions = 0;
        let totalIceMin = 0;
        let totalBookedMin = 0;

        const cursor = new Date(rangeStart);
        cursor.setHours(0, 0, 0, 0);
        const end = new Date(rangeEnd);
        end.setHours(0, 0, 0, 0);

        while (cursor <= end) {
            const slots = iceSlotsForDate(cursor);
            const sessions = sessionsForDate(cursor);
            totalPatches  += slots.length;
            totalSessions += sessions.length;
            totalIceMin += slots.reduce((sum, sl) => {
                const sm = timeToMinutes(sl.startTime);
                const em = timeToMinutes(sl.endTime);
                return sum + ((sm !== null && em && em > sm) ? (em - sm) : 0);
            }, 0);
            totalBookedMin += sessions.reduce((s, x) => s + (x.duration || 0), 0);
            cursor.setDate(cursor.getDate() + 1);
        }

        const summary = document.createElement("div");
        summary.className = "day-summary-card";
        if (extraClass) summary.classList.add(extraClass);
        if (isCurrentPeriod) summary.classList.add("is-today");

        // Empty state: no patches and no sessions across the entire range.
        if (totalPatches === 0 && totalSessions === 0) {
            summary.classList.add("empty");
            summary.textContent = `${headerText}: ${t.noActivityThisDay || "Nothing scheduled"}`;
            return summary;
        }

        const header = document.createElement("div");
        header.className = "day-summary-header";
        const title = document.createElement("div");
        title.className = "day-summary-weekday";
        title.textContent = headerText;
        header.appendChild(title);
        summary.appendChild(header);

        const body = document.createElement("div");
        body.className = "day-summary-body";

        const minLabel = t.minutes || "min";

        // Coaches: patches + ice time. Skaters don't own patches.
        if (isCoach && totalPatches > 0) {
            body.appendChild(buildPatchPill(
                totalPatches,
                totalPatches === 1
                    ? (t.patchSingular || "patch")
                    : (t.patchPlural   || "patches")
            ));
            if (totalIceMin > 0) {
                body.appendChild(buildPatchPill(
                    totalIceMin,
                    `${minLabel} ${t.iceTime || "ice time"}`
                ));
            }
        }

        // Sessions count — shown for both coaches and skaters since it's
        // meaningful in both cases (and especially needed for skaters who
        // don't have the patch pill).
        if (totalSessions > 0) {
            body.appendChild(buildPatchPill(
                totalSessions,
                totalSessions === 1
                    ? (t.sessionSingular || "session")
                    : (t.sessionPlural   || "sessions")
            ));
        }

        // Total minutes booked (skater = time on ice, coach = time billed).
        if (totalBookedMin > 0) {
            body.appendChild(buildPatchPill(
                totalBookedMin,
                `${minLabel} ${t.booked || "booked"}`
            ));
        }

        summary.appendChild(body);
        return summary;
    }

    function renderDay() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "day-view";
        grid.innerHTML = "";

        const daySessions = sessionsForDate(currentDate);
        // Sort patches by start time so the color cycle is deterministic
        // (patch at 7am always gets the first color regardless of save order).
        const daySlots    = iceSlotsForDate(currentDate)
            .slice()
            .sort((a, b) => (timeToMinutes(a.startTime) || 0) - (timeToMinutes(b.startTime) || 0));
        const isCoach     = hasCoachRole(currentRoles);
        const t           = translations[getLang()];
        const bookedLabel = t.minBooked || "min booked";
        const freeLabel   = t.minFree   || "min free";
        const overLabel   = t.minOver   || "min over";

        // Pre-compute color class per slot key so summary pills and the
        // grid cards share the exact same color assignment.
        const colorBySlotKey = {};
        daySlots.forEach((slot, i) => {
            const key = `${slot.startTime || ""}|${slot.endTime || ""}`;
            colorBySlotKey[key] = "patch-color-" + PATCH_COLORS[i % PATCH_COLORS.length];
        });

        // ── Top summary card ──
        // Header (weekday + date) on the left, one colored mini-pill per
        // patch on the right ("<sessions> <rink name>"). When there are no
        // patches, fall back to a neutral message.
        const summary = document.createElement("div");
        summary.id = "day-summary-card";
        summary.className = "day-summary-card";
        if (isToday(currentDate)) summary.classList.add("is-today");

        if (daySessions.length === 0 && daySlots.length === 0) {
            summary.classList.add("empty");
            summary.textContent = `${t.todayLabel || "Today"}: ${t.noActivityThisDay || "Nothing scheduled"}`;
        } else {
            // Weekday on the left. The full date is already in the page
            // header ("Monday, April 28") so we don't repeat it here.
            const header = document.createElement("div");
            header.className = "day-summary-header";
            const weekday = document.createElement("div");
            weekday.className = "day-summary-weekday";
            weekday.textContent = isToday(currentDate)
                ? (t.todayLabel || "Today")
                : currentDate.toLocaleDateString(lang, { weekday: "long" });
            header.appendChild(weekday);
            summary.appendChild(header);

            // Pill row on the right.
            const body = document.createElement("div");
            body.className = "day-summary-body";

            // Day-level totals (neutral gray pills) come first: patches,
            // total ice time across all patches, total minutes booked.
            // Patches and ice time only make sense for coaches (skaters
            // don't own patches and might see incomplete patch data).
            const totalIceMin = daySlots.reduce((sum, sl) => {
                const sm = timeToMinutes(sl.startTime);
                const em = timeToMinutes(sl.endTime);
                return sum + ((sm !== null && em && em > sm) ? (em - sm) : 0);
            }, 0);
            const totalBookedMin = daySessions.reduce(
                (sum, s) => sum + (s.duration || 0), 0
            );
            const minLabel = t.minutes || "min";

            if (isCoach && daySlots.length > 0) {
                body.appendChild(buildPatchPill(
                    daySlots.length,
                    daySlots.length === 1
                        ? (t.patchSingular || "patch")
                        : (t.patchPlural   || "patches")
                ));
                if (totalIceMin > 0) {
                    body.appendChild(buildPatchPill(
                        totalIceMin,
                        `${minLabel} ${t.iceTime || "ice time"}`
                    ));
                }
            }
            if (totalBookedMin > 0) {
                body.appendChild(buildPatchPill(
                    totalBookedMin,
                    `${minLabel} ${t.booked || "booked"}`
                ));
            }

            if (daySlots.length === 0) {
                // No patches but sessions exist (skater view fallback).
                // Add a single neutral pill for total session count so the
                // card isn't visually empty.
                body.appendChild(buildPatchPill(
                    daySessions.length,
                    daySessions.length === 1
                        ? (t.sessionSingular || "session")
                        : (t.sessionPlural   || "sessions")
                ));
            } else {
                // One neutral pill per patch. The patch CARDS in the grid
                // below keep their per-patch colors; the summary stays
                // calm and lets the cards do the visual work.
                daySlots.forEach(slot => {
                    const slotSessions = daySessions.filter(s =>
                        (s.iceStart || "") === (slot.startTime || "") &&
                        (s.iceEnd   || "") === (slot.endTime   || "")
                    );
                    const label = slot.rink || (t.patchSingular || "patch");
                    body.appendChild(buildPatchPill(slotSessions.length, label));
                });
            }
            summary.appendChild(body);
        }
        grid.appendChild(summary);

        // ── Stacked list of cards (no hour grid) ──
        // We replaced the absolute-positioned hour grid with a simple flex
        // column so cards size naturally to their content. Each item in the
        // list is either a PATCH (with its sessions inside) or an ORPHAN
        // session (a session whose iceStart/iceEnd doesn't match any of the
        // viewer's patches — common for skaters/parents who don't own
        // patches at all, and for off-ice sessions in the coach view).
        // Items are sorted by start time and "past" items (whose end time
        // has already passed today) are visually dimmed.
        grid.classList.add("day-list");
        const stack = document.createElement("div");
        stack.className = "day-list-stack";
        grid.appendChild(stack);

        // For dimming: only meaningful when viewing today. On other days
        // there's no concept of "past" relative to wall-clock time.
        const showDim = isToday(currentDate);
        const nowMin  = showDim
            ? (new Date().getHours() * 60 + new Date().getMinutes())
            : null;

        // ── Build skater/parent render entries (fan parent → per-child) ──
        // Coaches see one entry per session (collapsible list inside each
        // patch card); skaters/parents get one entry per OWN-CHILD on each
        // session, mirroring the previous behavior.
        const isParentViewer = currentRoles.includes("parent");
        const withLabel      = (t.withCoach || "with");

        const renderEntries = [];
        daySessions.forEach(s => {
            if (!isCoach && isParentViewer && !isGroupSession(s)) {
                const ownChildIds = (s.children || []).filter(cid => {
                    const childConn = myConnections.find(c => c.kind === "child" && c.id === cid);
                    return childConn && childConn.parentId === currentUser.uid;
                });
                if (ownChildIds.length > 0) {
                    ownChildIds.forEach(cid => renderEntries.push({ s, childId: cid }));
                    return;
                }
            }
            renderEntries.push({ s, childId: null });
        });

        // Bucket entries by patch (matching iceStart+iceEnd to a daySlot)
        // vs orphans (no matching patch). Skater/parent viewers have no
        // patches of their own, so every entry becomes an orphan and is
        // rendered as a standalone card.
        const slotKeys = new Set(daySlots.map(sl =>
            `${sl.startTime || ""}|${sl.endTime || ""}`
        ));
        const entriesByPatchKey = {};
        const orphanEntries     = [];
        renderEntries.forEach(entry => {
            const key = `${entry.s.iceStart || ""}|${entry.s.iceEnd || ""}`;
            if (slotKeys.has(key)) {
                if (!entriesByPatchKey[key]) entriesByPatchKey[key] = [];
                entriesByPatchKey[key].push(entry);
            } else {
                orphanEntries.push(entry);
            }
        });

        // Group orphans by exact (iceStart, iceEnd) so two same-time cards
        // can render side-by-side just like before.
        const orphanGroups = {};
        const orphanGroupOrder = [];
        orphanEntries.forEach(entry => {
            const tk = `${entry.s.iceStart || ""}|${entry.s.iceEnd || ""}`;
            if (!orphanGroups[tk]) {
                orphanGroups[tk] = {
                    startMin: timeToMinutes(entry.s.iceStart),
                    endMin:   timeToMinutes(entry.s.iceEnd),
                    entries:  [],
                };
                orphanGroupOrder.push(tk);
            }
            orphanGroups[tk].entries.push(entry);
        });

        // ── Build a unified list of items, then sort by start time ──
        // Each item knows its own startMin/endMin so dimming and ordering
        // can both look at the same numbers.
        const items = [];
        daySlots.forEach(slot => {
            const startMin = timeToMinutes(slot.startTime);
            const endMin   = timeToMinutes(slot.endTime);
            if (startMin === null) return;
            const key      = `${slot.startTime || ""}|${slot.endTime || ""}`;
            items.push({
                kind: "patch",
                startMin,
                endMin: (endMin && endMin > startMin) ? endMin : (startMin + 60),
                slot,
                key,
            });
        });
        orphanGroupOrder.forEach(tk => {
            const g = orphanGroups[tk];
            if (g.startMin === null) return;
            items.push({
                kind: "orphan",
                startMin: g.startMin,
                endMin:   (g.endMin && g.endMin > g.startMin) ? g.endMin : (g.startMin + 60),
                entries:  g.entries,
            });
        });
        items.sort((a, b) => a.startMin - b.startMin);

        // Empty state: handled by the summary card above; no need to add
        // anything else here.
        if (items.length === 0) return;

        // Coach color index runs across patch session lists; orphan color
        // index runs across orphan cards. They were independent in the old
        // implementation and we keep that.
        let orphanColorIdx = 0;

        items.forEach(item => {
            const isPast = (nowMin !== null) && (item.endMin <= nowMin);

            if (item.kind === "patch") {
                const slot       = item.slot;
                const startMin   = item.startMin;
                const endMin     = item.endMin;
                const durationMin = endMin - startMin;
                const colorClass = colorBySlotKey[item.key];
                const slotSessions = (entriesByPatchKey[item.key] || [])
                    // Skater/parent entries list (each entry = {s, childId}).
                    // For coaches, entriesByPatchKey is empty (no fan-out),
                    // so we re-derive sessions for the patch directly.
                    .map(e => e.s);
                const coachSessions = isCoach
                    ? daySessions.filter(s =>
                        (s.iceStart || "") === (slot.startTime || "") &&
                        (s.iceEnd   || "") === (slot.endTime   || "")
                      )
                    : [];
                const booked = (isCoach ? coachSessions : slotSessions)
                    .reduce((sum, s) => sum + (s.duration || 0), 0);
                const remaining = durationMin - booked;
                const isOver    = remaining < 0;

                const slotEl = document.createElement("div");
                slotEl.className = "ice-slot day-list-item " + colorClass;
                if (isPast) slotEl.classList.add("is-past");

                // Header row: time range + rink (left), pill stats (right).
                const headerRow = document.createElement("div");
                headerRow.className = "ice-slot-header";

                const headerInfo = document.createElement("div");
                headerInfo.className = "ice-slot-header-info";
                const timeEl = document.createElement("div");
                timeEl.className = "ice-slot-time";
                timeEl.textContent = (slot.startTime || "") +
                    (slot.endTime ? " – " + slot.endTime : "");
                headerInfo.appendChild(timeEl);
                if (slot.rink) {
                    const rinkEl = document.createElement("div");
                    rinkEl.className = "ice-slot-rink";
                    rinkEl.textContent = slot.rink;
                    headerInfo.appendChild(rinkEl);
                }
                headerRow.appendChild(headerInfo);

                if (isCoach) {
                    const pills = document.createElement("div");
                    pills.className = "ice-slot-pills";
                    pills.appendChild(buildPatchPill(
                        coachSessions.length,
                        coachSessions.length === 1
                            ? (t.sessionSingular || "session")
                            : (t.sessionPlural   || "sessions")
                    ));
                    pills.appendChild(buildPatchPill(booked, bookedLabel));
                    if (isOver) {
                        const overPill = buildPatchPill(-remaining, overLabel);
                        overPill.classList.add("over");
                        pills.appendChild(overPill);
                    } else {
                        pills.appendChild(buildPatchPill(remaining, freeLabel));
                    }
                    headerRow.appendChild(pills);
                }

                slotEl.appendChild(headerRow);

                // Coach-only collapsible session list (kept from old view).
                if (isCoach && coachSessions.length > 0) {
                    const toggle = document.createElement("div");
                    toggle.className = "ice-slot-toggle";
                    const closedText = `▾ ${t.show || "Show"} ${coachSessions.length} ${
                        coachSessions.length === 1
                            ? (t.sessionSingular || "session")
                            : (t.sessionPlural   || "sessions")
                    }`;
                    const openText = `▴ ${t.hide || "Hide"}`;
                    toggle.textContent = closedText;

                    const list = document.createElement("div");
                    list.className = "ice-slot-session-list";
                    list.style.display = "none";

                    coachSessions.forEach(s => {
                        const row = document.createElement("div");
                        row.className = "ice-slot-session-row";
                        row.style.cursor = "pointer";

                        const bar = document.createElement("div");
                        bar.className = "ice-slot-session-bar";

                        const text = document.createElement("div");
                        text.className = "ice-slot-session-text";
                        const names = sessionAttendeeNames(s, {
                            excludeViewer: false,
                            excludeCoach: true,
                            collapseParentWithChild: !isGroupSession(s),
                        }).join(", ");
                        if (s.subcoachName || s.subcoachUid) {
                            const affiliateName = s.subcoachName || "Affiliate";
                            text.innerHTML = `<strong>${escapeHtml(affiliateName)}</strong>${names ? " · " + escapeHtml(names) : ""}`;
                        } else {
                            text.textContent = names || "—";
                        }

                        const dur = document.createElement("div");
                        dur.className = "ice-slot-session-dur";
                        dur.textContent = (s.duration ? `${s.duration} ${t.minutes || "min"}` : "");

                        const chev = document.createElement("div");
                        chev.className = "ice-slot-session-chev";
                        chev.textContent = "›";

                        row.appendChild(bar);
                        row.appendChild(text);
                        row.appendChild(dur);
                        row.appendChild(chev);

                        row.addEventListener("click", (e) => {
                            e.stopPropagation();
                            openViewModal(s);
                        });

                        list.appendChild(row);
                    });

                    toggle.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const isOpen = list.style.display !== "none";
                        list.style.display = isOpen ? "none" : "";
                        toggle.textContent = isOpen ? closedText : openText;
                    });

                    slotEl.appendChild(toggle);
                    slotEl.appendChild(list);
                }

                // Skater/parent entries that fall on this patch render as
                // session cards stacked below the header. Two entries at
                // the same exact time go side-by-side; 3+ stack vertically.
                const patchEntries = entriesByPatchKey[item.key] || [];
                if (!isCoach && patchEntries.length > 0) {
                    // Group by (iceStart, iceEnd) — entries on the same
                    // patch already share the time, but a session may have
                    // a sub-range different from the patch range. Keep
                    // grouping logic so multi-kid same-time pairs sit side
                    // by side.
                    const groupsByTime = {};
                    const groupOrder  = [];
                    patchEntries.forEach(entry => {
                        const tk = `${entry.s.iceStart || ""}|${entry.s.iceEnd || ""}`;
                        if (!groupsByTime[tk]) {
                            groupsByTime[tk] = [];
                            groupOrder.push(tk);
                        }
                        groupsByTime[tk].push(entry);
                    });

                    let cardColorIdx = 0;
                    groupOrder.forEach(tk => {
                        const group = groupsByTime[tk];
                        const groupEl = document.createElement("div");
                        groupEl.className = "session-block-group day-list-group";
                        groupEl.style.display = "flex";
                        groupEl.style.gap = "4px";
                        groupEl.style.flexDirection = (group.length === 2) ? "row" : "column";

                        group.forEach(entry => {
                            const block = buildSessionBlock(entry, cardColorIdx++, withLabel);
                            if (group.length === 2) {
                                block.style.flex = "1 1 0";
                                block.style.minWidth = "0";
                            }
                            groupEl.appendChild(block);
                        });

                        slotEl.appendChild(groupEl);
                    });
                }

                // Click anywhere on the patch background opens its sessions
                // list modal (fallback for skaters and tapping outside any
                // specific row).
                slotEl.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openSessionsInSlotModal(slot);
                });

                stack.appendChild(slotEl);
            } else {
                // Orphan group — standalone session card(s).
                const groupEl = document.createElement("div");
                groupEl.className = "session-block-group day-list-item day-list-orphan";
                if (isPast) groupEl.classList.add("is-past");
                groupEl.style.display = "flex";
                groupEl.style.gap = "4px";
                groupEl.style.flexDirection = (item.entries.length === 2) ? "row" : "column";

                item.entries.forEach(entry => {
                    const block = buildSessionBlock(entry, orphanColorIdx++, withLabel);
                    if (item.entries.length === 2) {
                        block.style.flex = "1 1 0";
                        block.style.minWidth = "0";
                    }
                    groupEl.appendChild(block);
                });

                stack.appendChild(groupEl);
            }
        });
    }

    // Build a single skater/parent session card. Pulled out of renderDay so
    // both the slot-stack and orphan-fallback paths share the same DOM
    // shape. `entry.childId` is null for skater cards (combined attendee
    // names) and a child doc id for parent cards (per-kid card with the
    // coach's name on the secondary line).
    function buildSessionBlock(entry, idx, withLabel) {
        const { s, childId } = entry;
        const color = SESSION_COLORS[idx % SESSION_COLORS.length];
        const coachConn = myConnections.find(c => c.kind === "user" && c.uid === s.coachUid);
        const coachName = s.subcoachName || (coachConn && coachConn.name) || "";
        const attendeeNames = sessionAttendeeNames(s, {
            excludeViewer: false,
            excludeCoach: true,
            collapseParentWithChild: !isGroupSession(s),
        }).join(", ");
        const timeText = [s.iceStart, s.iceEnd].filter(Boolean).join(" - ");

        let primaryName;
        if (isGroupSession(s)) {
            primaryName = [attendeeNames, coachName].filter(Boolean).join(", ") || "—";
        } else if (childId) {
            const childConn = myConnections.find(c => c.kind === "child" && c.id === childId);
            const childName = childConn ? (childConn.name || "—") : childId;
            primaryName = childName;
        } else {
            primaryName = attendeeNames || coachName;
        }

        // Translate the type tags (private/group/off-ice) using the same
        // mapping as the view-session modal. Falls back to the raw token
        // for any future type that hasn't been added to translations yet.
        const tt = translations[getLang()];
        const types = (s.type || []).map(tp => {
            if (tp === "private") return tt.private || "Private";
            if (tp === "group")   return tt.group   || "Group";
            if (tp === "off-ice") return tt.offIce  || "Off-ice";
            return tp;
        }).join(", ");
        const metaParts = [];
        if (coachName) metaParts.push(`${withLabel} ${coachName}`);
        if (s.rink)          metaParts.push(s.rink);
        if (s.duration)      metaParts.push(`${s.duration} ${tt.minutes || "min"}`);
        if (types)           metaParts.push(types);

        const block = document.createElement("div");
        block.className = "session-block";
        block.style.cursor = "pointer";
        // Don't fix a height — let content drive size. The CSS min-height
        // prevents collapse; removing the inline height/whitespace caps
        // ensures long names and coach lines aren't clipped.
        block.style.whiteSpace = "normal";

        const blockContent = document.createElement("div");
        blockContent.className = "session-block-content";
        const headerEl = document.createElement("div");
        headerEl.className = "session-block-header";
        const nameEl = document.createElement("div");
        nameEl.className = "session-block-name";
        nameEl.style.whiteSpace = "normal";
        nameEl.style.overflow   = "visible";
        nameEl.style.textOverflow = "clip";
        nameEl.textContent = primaryName || "—";
        headerEl.appendChild(nameEl);
        if (timeText) {
            const timeEl = document.createElement("div");
            timeEl.className = "session-block-card-time";
            timeEl.textContent = `(${timeText})`;
            headerEl.appendChild(timeEl);
        }
        const metaEl = document.createElement("div");
        metaEl.className = "session-block-meta";
        metaEl.style.whiteSpace = "normal";
        metaEl.style.overflow   = "visible";
        metaEl.style.textOverflow = "clip";
        metaEl.textContent = metaParts.join(" · ");
        blockContent.appendChild(headerEl);
        blockContent.appendChild(metaEl);

        block.appendChild(blockContent);

        block.addEventListener("click", (e) => {
            e.stopPropagation();
            openViewModal(s);
        });

        return block;
    }

    function renderCalendar() {
        const label = document.getElementById("period-label");
        if (currentView === "month") {
            label.textContent = currentDate.toLocaleDateString(lang, { month: "long", year: "numeric" });
            renderMonth();
        } else if (currentView === "week") {
            const start = new Date(currentDate);
            start.setDate(currentDate.getDate() - daysSinceWeekStart(currentDate));
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            label.textContent =
                start.toLocaleDateString(lang, { month: "short", day: "numeric" }) +
                " – " +
                end.toLocaleDateString(lang, { month: "short", day: "numeric" });
            renderWeek();
        } else if (currentView === "day") {
            label.textContent = currentDate.toLocaleDateString(lang, { weekday: "long", month: "long", day: "numeric" });
            renderDay();
        }
        document.querySelectorAll(".view-btn").forEach(btn => {
            btn.classList.toggle("active", btn.id === `btn-${currentView}`);
        });
    }

    async function renderAndLoad() {
        // Render immediately with whatever's in the cached arrays so view switches
        // (especially the month-day tap on mobile) feel instant. Then fetch fresh
        // data and re-render if anything changed.
        renderCalendar();

        if (!currentUser) return;
        const { start, end } = getDateRange();
        try {
            await loadSessions(currentUser.uid, currentRoles, start, end);
            await hydrateSessionNameLookups();
            renderCalendar();
            // Opportunistically backfill the denormalized rink on existing
            // sessions that predate the rink field. Only the coach has write
            // permission on their own sessions and read access to the ice
            // slots, so this is a coach-only pass. Fire-and-forget: if it
            // fails, the user still sees the calendar; skaters just keep
            // seeing "—" for those specific legacy sessions until the next
            // time the coach's client loads them successfully.
            if (hasCoachRole(currentRoles)) {
                backfillSessionRinks().catch(err =>
                    console.warn("rink backfill skipped:", err)
                );
            }
        } catch (err) {
            // Query failure (missing index, offline, permissions, etc.) — keep
            // the optimistic render; don't freeze the UI.
            console.error("loadSessions failed:", err);
        }
    }

    // One-shot backfill for the rink field on pre-existing session docs.
    // For each session without a rink but with matching ice slot (by date +
    // iceStart/iceEnd), write the rink back and update the in-memory cache so
    // the current render reflects it without another network roundtrip.
    async function backfillSessionRinks() {
        const toFix = cachedSessions.filter(s =>
            !s.rink && s.iceStart && s.date && typeof s.date.toDate === "function"
        );
        if (toFix.length === 0) return;

        for (const s of toFix) {
            const sessionDate = s.date.toDate();
            const slot = iceSlotsForDate(sessionDate).find(sl =>
                (sl.startTime || "") === (s.iceStart || "") &&
                (sl.endTime   || "") === (s.iceEnd   || "")
            );
            if (!slot || !slot.rink) continue;
            try {
                await updateDoc(doc(db, "sessions", s.id), { rink: slot.rink });
                s.rink = slot.rink;  // keep the cache in sync
            } catch (_) {
                // Non-fatal — try the next one.
            }
        }
    }

    // ── Delegated day-selection handler ──
    // Attach once to #calendar-grid so taps work reliably across re-renders on mobile.
    // Per-cell listeners on dynamically re-created buttons were unreliable on iOS.
    (function wireDayDelegation() {
        const grid = document.getElementById("calendar-grid");
        if (!grid) return;

        const selectFromTarget = (target) => {
            const el = target && target.closest ? target.closest("[data-date]") : null;
            if (!el || !grid.contains(el)) return false;
            const iso = el.dataset.date;
            if (!iso) return false;
            currentDate = new Date(iso);
            currentView = "day";
            renderAndLoad();
            return true;
        };

        let lastHandledAt = 0;

        grid.addEventListener("pointerup", (e) => {
            if (selectFromTarget(e.target)) lastHandledAt = Date.now();
        });

        grid.addEventListener("touchend", (e) => {
            if (selectFromTarget(e.target)) {
                lastHandledAt = Date.now();
                e.preventDefault();
            }
        }, { passive: false });

        grid.addEventListener("click", (e) => {
            // Skip synthetic click if pointer/touch just handled this tap
            if (Date.now() - lastHandledAt < 500) return;
            selectFromTarget(e.target);
        });
    })();

    // Render a static month placeholder immediately so the calendar is visible before auth resolves
    (function showLoadingPlaceholder() {
        const grid = document.getElementById("calendar-grid");
        if (!grid) return;
        grid.className = "month-view";
        grid.innerHTML = "";
        shortDayNames().forEach(name => {
            const h = document.createElement("div");
            h.className = "cal-day-header";
            h.textContent = name;
            grid.appendChild(h);
        });
        const year  = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDay    = daysSinceWeekStart(new Date(year, month, 1));
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrev  = new Date(year, month, 0).getDate();
        let cells = [];
        for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, thisMonth: false });
        for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, thisMonth: true, date: new Date(year, month, d) });
        let next = 1;
        while (cells.length % 7 !== 0) cells.push({ day: next++, thisMonth: false });
        cells.forEach(c => {
            const cell = document.createElement(c.date ? "button" : "div");
            cell.className = "cal-day-cell";
            if (c.date) cell.type = "button";
            const inner = document.createElement("span");
            inner.textContent = c.day;
            if (!c.thisMonth)                   inner.className = "cal-day other-month";
            else if (c.date && isToday(c.date)) inner.className = "cal-day today";
            else                                inner.className = "cal-day";
            cell.appendChild(inner);
            grid.appendChild(cell);
        });
        const label = document.getElementById("period-label");
        if (label) label.textContent = currentDate.toLocaleDateString(lang, { month: "long", year: "numeric" });
        document.querySelectorAll(".view-btn").forEach(btn => {
            btn.classList.toggle("active", btn.id === "btn-month");
        });
    })();

    // ── View toggle ──
    document.querySelectorAll(".view-btn").forEach(btn => {
        const switchView = async () => {
            currentView = btn.id.replace("btn-", "");
            await renderAndLoad();
        };
        let tStartX, tStartY;
        btn.addEventListener("touchstart", (e) => {
            tStartX = e.touches[0].clientX;
            tStartY = e.touches[0].clientY;
        }, { passive: true });
        btn.addEventListener("touchend", (e) => {
            const dx = Math.abs(e.changedTouches[0].clientX - tStartX);
            const dy = Math.abs(e.changedTouches[0].clientY - tStartY);
            if (dx < 10 && dy < 10) {
                e.preventDefault();
                switchView();
            }
        }, { passive: false });
        btn.addEventListener("click", switchView);
    });

    // ── AVAILABILITY (affiliate coaches) ─────────────────────────────────────
    let availabilitySlots = [];
    let editingAvailabilityId = null;

    const AVAIL_DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

    async function loadAvailabilitySlots(uid) {
        const snap = await getDoc(doc(db, "users", uid));
        availabilitySlots = snap.exists() ? (snap.data().availabilitySlots || []) : [];
    }

    function renderAvailabilitySlots() {
        const container = document.getElementById("availabilitySlotsList");
        if (!container) return;
        const t = translations[getLang()] || {};
        const dayLabels = {
            monday: t.monday || "Monday", tuesday: t.tuesday || "Tuesday",
            wednesday: t.wednesday || "Wednesday", thursday: t.thursday || "Thursday",
            friday: t.friday || "Friday", saturday: t.saturday || "Saturday",
            sunday: t.sunday || "Sunday",
        };
        const sorted = [...availabilitySlots].sort(
            (a, b) => AVAIL_DAY_ORDER.indexOf(a.day) - AVAIL_DAY_ORDER.indexOf(b.day)
        );
        if (!sorted.length) {
            container.innerHTML = `<div style="font-size:13px;color:#5E6C84;">${escapeHtml(t.noAvailabilitySet || "No availability set")}</div>`;
            return;
        }
        container.innerHTML = sorted.map(slot => `
            <div class="availability-slot-card" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #DFE1E6;border-radius:6px;margin-bottom:6px;">
                <div>
                    <span style="font-weight:600;font-size:13px;">${escapeHtml(dayLabels[slot.day] || slot.day)}</span>
                    <span style="font-size:13px;color:#5E6C84;margin-left:8px;">${escapeHtml(slot.from)} – ${escapeHtml(slot.to)}</span>
                </div>
                <button type="button" class="avail-edit-btn subcoach-delete" data-avail-id="${escapeHtml(slot.id)}" data-key="edit">${escapeHtml(t.edit || "Edit")}</button>
            </div>
        `).join("");
        container.querySelectorAll(".avail-edit-btn").forEach(btn => {
            btn.addEventListener("click", () => openAvailabilityModal(btn.dataset.availId));
        });
    }

    function openAvailabilityModal(slotId = null) {
        const modal = document.getElementById("availabilityModal");
        const t = translations[getLang()] || {};
        editingAvailabilityId = slotId;
        const deleteBtn = document.getElementById("deleteAvailabilityBtn");
        const title = document.getElementById("availabilityModalTitle");
        if (slotId) {
            const slot = availabilitySlots.find(s => s.id === slotId);
            if (slot) {
                document.getElementById("availDay").value = slot.day;
                document.getElementById("availFrom").value = slot.from;
                document.getElementById("availTo").value = slot.to;
            }
            if (deleteBtn) deleteBtn.style.display = "";
            if (title) title.textContent = t.editAvailability || "Edit availability";
        } else {
            document.getElementById("availDay").value = "monday";
            document.getElementById("availFrom").value = "";
            document.getElementById("availTo").value = "";
            if (deleteBtn) deleteBtn.style.display = "none";
            if (title) title.textContent = t.addAvailability || "Add availability";
        }
        modal.style.display = "flex";
    }

    function closeAvailabilityModal() {
        document.getElementById("availabilityModal").style.display = "none";
        editingAvailabilityId = null;
    }

    async function saveAvailabilitySlot() {
        const day = document.getElementById("availDay").value;
        const from = document.getElementById("availFrom").value;
        const to = document.getElementById("availTo").value;
        if (!day || !from || !to) return;
        let updated;
        if (editingAvailabilityId) {
            updated = availabilitySlots.map(s =>
                s.id === editingAvailabilityId ? { id: s.id, day, from, to } : s
            );
        } else {
            updated = [...availabilitySlots, { id: crypto.randomUUID(), day, from, to }];
        }
        await updateDoc(doc(db, "users", currentUser.uid), { availabilitySlots: updated });
        availabilitySlots = updated;
        closeAvailabilityModal();
        renderAvailabilitySlots();
    }

    async function deleteAvailabilitySlot() {
        if (!editingAvailabilityId) return;
        const updated = availabilitySlots.filter(s => s.id !== editingAvailabilityId);
        await updateDoc(doc(db, "users", currentUser.uid), { availabilitySlots: updated });
        availabilitySlots = updated;
        closeAvailabilityModal();
        renderAvailabilitySlots();
    }

    // ── INIT ─────────────────────────────────────────────────────────────────
    authGuard([], async (user, userData) => {
        currentUser           = user;
        currentRoles          = userData.rolesArray;
        currentUserFirstName  = userData.firstName || "";
        // Read the coach's configured hourly rate from payment settings.
        // Older user docs may still have a legacy pricing block; keep it as
        // a fallback only when the payment settings doc is missing.
        coachHourlyRate = 0;
        coachFlatRate = 0;
        try {
            const psSnap = await getDoc(doc(db, "paymentSettings", user.uid));
            if (psSnap.exists()) {
                const rateCents = Number(psSnap.data().hourlyRate) || 0;
                const flatCents = Number(psSnap.data().flatRate) || 0;
                coachHourlyRate = rateCents / 100;
                coachFlatRate = flatCents / 100;
            }
        } catch (_) { /* fallback below */ }
        if (!coachHourlyRate) {
            coachHourlyRate = parseFloat(
                userData.pricing?.hourly ?? userData.pricing?.hourlyPrivate ?? 0
            ) || 0;
        }

        // weekStart is stored as a lowercase day name ("sunday", "monday",
        // …). Falls back to Sunday if missing or unrecognised — same
        // default as the dashboard's getCurrentWeekRange.
        weekStartIdx = DAY_NAME_TO_INDEX[userData.weekStart] ?? 0;

        // Init nav immediately so buttons are clickable before async loads finish
        initNav("calendar.html");
        injectNotificationBell(user.uid);

        const isCoach = hasCoachRole(currentRoles);

        // Wire up the add-session button synchronously so it's interactive
        // while the data loads in parallel below.
        const addSessionBtn = document.getElementById("openAddSessionModal");
        if (addSessionBtn) {
            if (isCoach) {
                addSessionBtn.style.display = "";
            } else {
                addSessionBtn.style.display = "none";
                const hr = addSessionBtn.previousElementSibling;
                if (hr) hr.style.display = "none";
            }
            addSessionBtn.addEventListener("click", () => openModal());
        }

        const addIceSlotBtn = document.getElementById("openAddIceSlotModal");
        if (addIceSlotBtn) {
            addIceSlotBtn.addEventListener("click", openIceSlotModal);
        }

        // Availability button — affiliate coaches only
        const isAffiliateCoach = currentRoles.includes("affiliateCoach");
        const availBtn = document.getElementById("openAvailabilityModal");
        if (isAffiliateCoach && availBtn) {
            availBtn.style.display = "";
            const availHr = document.getElementById("availabilityHr");
            const availSection = document.getElementById("availabilitySlotsSection");
            if (availHr) availHr.style.display = "";
            if (availSection) availSection.style.display = "";
            availBtn.addEventListener("click", () => openAvailabilityModal());
            document.getElementById("cancelAvailabilityBtn").addEventListener("click", closeAvailabilityModal);
            document.getElementById("saveAvailabilityBtn").addEventListener("click", saveAvailabilitySlot);
            document.getElementById("deleteAvailabilityBtn").addEventListener("click", deleteAvailabilitySlot);
            document.getElementById("availabilityModal").addEventListener("click", (e) => {
                if (e.target === document.getElementById("availabilityModal")) closeAvailabilityModal();
            });
        }

        document.getElementById("cancelSessionBtn").addEventListener("click", closeModal);
        // Switching between Hourly and Flat modes updates the selected
        // label and pulls the amount from payment settings.
        document.getElementById("priceModeHourly").addEventListener("change", () => {
            updatePriceModeLabels();
            updatePricingPreview();
        });
        document.getElementById("priceModeFlat").addEventListener("change", () => {
            updatePriceModeLabels();
            updatePricingPreview();
        });
        document.getElementById("sessionSubCoach").addEventListener("change", updateSubCoachPricingState);
        // Live pricing preview — recalculate whenever any input that feeds
        // the formula changes. Participants is delegated since checkboxes
        // are re-rendered on every modal open.
        document.getElementById("sessionDuration").addEventListener("input", () => {
            renderSubCoachSelect(document.getElementById("sessionSubCoach")?.value || "");
            updateSubCoachPricingState();
        });
        document.getElementById("typePrivate").addEventListener("change", updatePricingPreview);
        document.getElementById("typeGroup").addEventListener("change", updatePricingPreview);
        document.getElementById("session-participants").addEventListener("change", updatePricingPreview);
        modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
        document.getElementById("saveSessionBtn").addEventListener("click", saveSession);
        document.getElementById("deleteSessionBtn").addEventListener("click", deleteSession);

        // View-session modal (skater read-only view with editable "my note")
        const viewModal = document.getElementById("viewSessionModal");
        document.getElementById("closeViewSessionBtn").addEventListener("click", closeViewModal);
        document.getElementById("saveMyNoteBtn").addEventListener("click", saveMyNote);
        document.getElementById("editViewSessionBtn").addEventListener("click", () => {
            if (!currentViewedSession) return;
            const session = currentViewedSession;
            closeViewModal();
            openEditModal(session);
        });
        document.getElementById("deleteViewSessionBtn").addEventListener("click", async () => {
            if (!currentViewedSession || currentViewedSession.coachUid !== currentUser.uid) return;
            const sessionId = currentViewedSession.id;
            await deleteSessionById(sessionId, currentViewedSession);
            closeViewModal();
            await renderAndLoad();
        });
        viewModal.addEventListener("click", (e) => { if (e.target === viewModal) closeViewModal(); });

        // Whenever the date in the session modal changes, rebuild the patch
        // picker for the newly chosen date.
        document.getElementById("sessionDate").addEventListener("change", () => {
            renderPatchPicker();
            renderSubCoachSelect(document.getElementById("sessionSubCoach")?.value || "");
            updateSubCoachPricingState();
        });

        document.getElementById("cancelIceSlotBtn").addEventListener("click", closeIceModal);
        iceModal.addEventListener("click", (e) => { if (e.target === iceModal) closeIceModal(); });
        document.getElementById("saveIceSlotBtn").addEventListener("click", saveIceSlot);
        document.getElementById("deleteIceSlotBtn").addEventListener("click", deleteIceSlot);
        document.getElementById("slotRecurrence").addEventListener("change", toggleSlotDaysRow);
        document.getElementById("slotRinkSearch").addEventListener("input", (e) => {
            document.getElementById("slotRink").value = "";
            filterRinks(e.target.value);
        });

        // Sessions-in-patch modal wiring
        document.getElementById("closeSessionsInSlotBtn").addEventListener("click", closeSessionsInSlotModal);
        sessionsInSlotModal.addEventListener("click", (e) => {
            if (e.target === sessionsInSlotModal) closeSessionsInSlotModal();
        });
        document.getElementById("editPatchFromListBtn").addEventListener("click", () => {
            const slot = currentSlotForListModal;
            closeSessionsInSlotModal();
            if (slot) openEditIceSlotModal(slot);
        });

        // Fire all independent Firestore queries in parallel instead of awaiting
        // them sequentially. Before: authGuard → loadIceSlots → loadConnections →
        //   loadSessions (4 serial roundtrips). After: everything after authGuard
        // runs concurrently.
        const { start, end } = getDateRange();
        const tasks = [
            loadIceSlots(user.uid),
            loadSessions(user.uid, currentRoles, start, end),
            loadConnections(user.uid), // all roles need this so UIDs resolve to names
        ];
        if (isCoach) tasks.push(loadSubCoaches(user.uid));
        if (isAffiliateCoach) tasks.push(loadAvailabilitySlots(user.uid));

        try {
            await Promise.all(tasks);
            // loadConnections resets myConnections to [] then rebuilds it from
            // accepted connections. The current user is never in their own
            // connections list, so add a self-entry now so name lookups for
            // the viewer's own UID (e.g. vsCoach, group session participant)
            // resolve to their display name instead of "—".
            myConnections.push({
                kind:  "user",
                uid:   user.uid,
                name:  formatFullName(userData) || "",
                roles: currentRoles,
            });
            await hydrateSessionNameLookups();
        } catch (err) {
            console.error("Calendar initial load failed:", err);
        }
        renderCalendar();
        if (isAffiliateCoach) renderAvailabilitySlots();

        // If opened from coach management with ?subcoach=ID, pre-select that
        // affiliate and open the session modal immediately.
        const preSubcoach = new URLSearchParams(window.location.search).get("subcoach");
        if (isCoach && preSubcoach) {
            openModal();
            renderSubCoachSelect(preSubcoach);
        }
        // Readiness signal for E2E tests: by this point authGuard has
        // resolved, weekStartIdx reflects userData.weekStart, and the
        // calendar has re-rendered with the correct user data. Tests
        // wait on `body[data-calendar-ready]` before clicking view-toggle
        // buttons, otherwise they race the initial IIFE render which uses
        // the default weekStartIdx=0 (Sunday).
        document.body.dataset.calendarReady = "true";
    });

    // ── Nav buttons — register immediately so mobile taps before auth don't get lost ──
    document.getElementById("prev-btn").addEventListener("click", async () => {
        if (currentView === "month")     currentDate.setMonth(currentDate.getMonth() - 1);
        else if (currentView === "week") currentDate.setDate(currentDate.getDate() - 7);
        else if (currentView === "day")  currentDate.setDate(currentDate.getDate() - 1);
        await renderAndLoad();
    });

    document.getElementById("next-btn").addEventListener("click", async () => {
        if (currentView === "month")     currentDate.setMonth(currentDate.getMonth() + 1);
        else if (currentView === "week") currentDate.setDate(currentDate.getDate() + 7);
        else if (currentView === "day")  currentDate.setDate(currentDate.getDate() + 1);
        await renderAndLoad();
    });
});
