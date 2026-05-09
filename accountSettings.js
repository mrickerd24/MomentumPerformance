import { auth, db, getLang, applyLanguage, authGuard, initNav, translations, toTitleCase } from "./app.js";
import { injectNotificationBell } from "./notifications.js";
import { updatePassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc, deleteDoc, collection, collectionGroup, getDocs, query, orderBy, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage } from "./translations.js";

// ---------------- CLUBS ----------------
let allClubs = [];
let selectedClubs = [];

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function loadClubs() {
  const snap = await getDocs(query(collection(db, "clubs"), orderBy("name")));
  snap.forEach(d => {
    allClubs.push({ id: d.id, ...d.data() });
  });
}

function renderSelectedClubs() {
  const container = document.getElementById("selected-clubs");
  if (!container) return;
  container.innerHTML = "";

  selectedClubs.forEach(club => {
    const chip = document.createElement("span");
    chip.style.cssText = `
      display:inline-flex; align-items:center; gap:6px;
      background:#E9F2FF; color:#0C66E4; border:1px solid #0C66E4;
      border-radius:12px; padding:4px 10px; margin:4px 4px 4px 0;
      font-size:12px; font-weight:600;
    `;
    chip.innerHTML = club.name + ' <span style="cursor:pointer;font-weight:700;">&#x2715;</span>';
    chip.querySelector("span").addEventListener("click", () => {
      selectedClubs = selectedClubs.filter(s => s.id !== club.id);
      renderSelectedClubs();
      const input = document.getElementById("clubSearch");
      if (input) filterClubs(input.value);
    });
    container.appendChild(chip);
  });
}

function filterClubs(searchTerm) {
  const raw = normalize(searchTerm.trim());
  const resultsDiv = document.getElementById("club-results");
  if (!resultsDiv) return;
  resultsDiv.innerHTML = "";
  if (!raw) return;

  const matches = allClubs.filter(c =>
    normalize(c.name).includes(raw) ||
    normalize(c.region).includes(raw)
  );

  if (!matches.length) {
    resultsDiv.innerHTML = '<p style="color:#5E6C84;font-size:13px;">No results found</p>';
    return;
  }

  matches.forEach(club => {
    const alreadySelected = selectedClubs.some(s => s.id === club.id);
    if (alreadySelected) return;

    const card = document.createElement("div");
    card.className = "student-card";
    card.style.cursor = "pointer";
    card.innerHTML = '<strong style="font-size:14px">' + club.name + '</strong><br><span style="font-size:12px;color:#5E6C84">' + club.region + '</span>';
    card.addEventListener("click", () => {
      selectedClubs.push(club);
      document.getElementById("clubSearch").value = "";
      document.getElementById("club-results").innerHTML = "";
      renderSelectedClubs();
    });
    resultsDiv.appendChild(card);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  applyLanguage();
  await loadClubs();

  const clubSearchInput = document.getElementById("clubSearch");
  if (clubSearchInput) {
    clubSearchInput.addEventListener("input", (e) => {
      filterClubs(e.target.value);
    });
  }

  // Language
  const savedLang = getLang();
  const savedLangRadio = document.querySelector('input[value="' + savedLang + '"]');
  if (savedLangRadio) savedLangRadio.checked = true;

  document.querySelectorAll('input[name="language"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      localStorage.setItem("language", e.target.value);
      setLanguage(e.target.value);
    });
  });

  // Modal helpers
  const modal = document.getElementById("deleteModal");

  function openModal() {
    document.getElementById("deleteConfirmInput").value = "";
    document.getElementById("deleteConfirm-error").innerText = "";
    modal.classList.add("open");
  }

  function closeModal() {
    modal.classList.remove("open");
  }

  document.getElementById("openDeleteModal").addEventListener("click", openModal);
  document.getElementById("cancelDeleteBtn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Auth guard
  authGuard([], (user, userData) => {
    // Wire up the bottom nav FIRST so the buttons are clickable even if any
    // of the form-population code below throws (e.g. a missing element on a
    // role-specific row). Other pages do the same — see dashboard.js, etc.
    initNav("accountSettings.html");
    injectNotificationBell(user.uid);

    document.getElementById("name").value         = userData.firstName   || "";
    document.getElementById("lastName").value     = userData.lastName    || "";
    document.getElementById("emailAddress").value = userData.email       || "";
    document.getElementById("phoneNumber").value  = userData.phoneNumber || "";

    const roles = userData.rolesArray;
    const isCoach = roles.includes("coach") || roles.includes("affiliateCoach");
    const isCoachOrSkater = isCoach || roles.includes("skater");

    // Show/hide sections based on role. Parents don't get a Skate Canada
    // number or a skating club of their own — those belong to their
    // children, edited from the children form on the My children page.
    const skateCanRow = document.getElementById("skateCan-row");
    if (skateCanRow) {
      skateCanRow.style.display = isCoachOrSkater ? "" : "none";
      if (isCoachOrSkater) document.getElementById("skateCanadaNumber").value = userData.skateCanadaNumber || "";
    }

    const clubSearchRow = document.getElementById("clubSearch-row");
    if (clubSearchRow) {
      clubSearchRow.style.display = isCoachOrSkater ? "" : "none";
    }

    const clubNumRow = document.getElementById("clubNum-row");
    if (clubNumRow) {
      const isAdmin = roles.includes("admin");
      clubNumRow.style.display = isAdmin ? "" : "none";
      if (isAdmin) document.getElementById("skateCanClubNumber").value = userData.skateCanClubNumber || "";
    }

    const parentRow = document.getElementById("parentName-row");
    if (parentRow) parentRow.style.display = "none";

    const pricingRow = document.getElementById("pricing-row");
    if (pricingRow) {
      // Pricing block was removed in MP-117 (now lives on paymentSettings.html).
      // The element shouldn't exist anymore, but if a stale HTML loads we
      // still hide it so users don't see an orphan section.
      pricingRow.style.display = "none";
    }

    const weekStartRow = document.getElementById("weekStart-row");
    if (weekStartRow) {
      weekStartRow.style.display = isCoach ? "" : "none";
    }

    // Payment settings link — coach only. Skaters and parents do not
    // see this button in settings.
    const paymentSettingsLinkRow = document.getElementById("paymentSettingsLink-row");
    if (paymentSettingsLinkRow) {
      paymentSettingsLinkRow.style.display = isCoach ? "" : "none";
    }

    // Pricing/tax pre-fill removed in MP-117 — those fields now live on
    // paymentSettings.html and are loaded by paymentSettings.js. The
    // legacy `users.pricing` field will be migrated to
    // `paymentSettings/{uid}` by MP-119.

    // Pre-fill week start day if coach
    if (isCoach && userData.weekStart) {
      const dayEl = document.getElementById(userData.weekStart);
      if (dayEl) dayEl.checked = true;
    }

    // Pre-load user's existing clubs
    const userClubIds = userData.clubs || [];
    selectedClubs = allClubs.filter(c => userClubIds.includes(c.id));
    renderSelectedClubs();

    // Save changes
    document.getElementById("accountSettingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();

      const lang = getLang();
      const t = translations[lang];

      ["name", "lastName", "emailAddress", "phoneNumber", "password", "passwordConfirmation"].forEach(id => {
        const el = document.getElementById(id + "-error");
        if (el) el.innerText = "";
      });
      const clubErrEl = document.getElementById("clubSearch-error");
      if (clubErrEl) clubErrEl.innerText = "";

      const nameVal     = toTitleCase(document.getElementById("name").value);
      const lastNameVal = toTitleCase(document.getElementById("lastName").value);
      const emailVal    = document.getElementById("emailAddress").value.trim();
      const phoneVal    = document.getElementById("phoneNumber").value.trim();
      const newPassword = document.getElementById("changepassword").value;
      const confirmPw   = document.getElementById("passwordConfirmation").value;

      let valid = true;
      if (!nameVal)                                { document.getElementById("name-error").innerText = t.firstNameRequired; valid = false; }
      if (!lastNameVal)                            { document.getElementById("lastName-error").innerText = t.lastNameRequired; valid = false; }
      if (!emailVal || !emailVal.includes("@"))    { document.getElementById("emailAddress-error").innerText = t.invalidEmail; valid = false; }
      if (!phoneVal)                               { document.getElementById("phoneNumber-error").innerText = t.phoneRequired; valid = false; }
      if (newPassword && newPassword.length < 6)   { document.getElementById("password-error").innerText = "Min 6 characters"; valid = false; }
      if (newPassword && newPassword !== confirmPw) { document.getElementById("passwordConfirmation-error").innerText = t.passwordMismatch; valid = false; }
      // Club is required for coaches and skaters (they're personally
      // affiliated with a club). Parents don't have a club of their own —
      // their children's clubs live on the children docs — so skip the
      // requirement for them.
      if (clubErrEl && isCoachOrSkater && selectedClubs.length === 0) {
        clubErrEl.innerText = t.selectClub || "Please select at least one club";
        valid = false;
      }
      if (!valid) return;

      const updateData = {
        firstName:   nameVal,
        lastName:    lastNameVal,
        email:       emailVal,
        phoneNumber: phoneVal,
      };
      // Only coaches and skaters write a clubs array — parents don't
      // pick clubs in this form, so leaving it out of the payload
      // preserves whatever was previously stored (typically empty).
      if (isCoachOrSkater) {
        updateData.clubs = selectedClubs.map(c => c.id);
        updateData.skateCanadaNumber = document.getElementById("skateCanadaNumber") ? document.getElementById("skateCanadaNumber").value.trim() : "";
      }
      if (roles.includes("admin")) {
        updateData.skateCanClubNumber = document.getElementById("skateCanClubNumber") ? document.getElementById("skateCanClubNumber").value.trim() : "";
      }
      if (isCoach) {
        // Pricing/tax moved out of this form in MP-117 — now saved by
        // paymentSettings.js. We still write the coach's weekStart here
        // because that's a calendar preference, not a billing one.
        const selectedDay = document.querySelector('input[name="day"]:checked');
        updateData.weekStart = selectedDay ? selectedDay.value : "";
      }

      try {
        await updateDoc(doc(db, "users", user.uid), updateData);
        if (newPassword) {
          await updatePassword(user, newPassword);
          document.getElementById("changepassword").value = "";
          document.getElementById("passwordConfirmation").value = "";
        }
        alert(t.changesSaved);
      } catch (error) {
        console.error("Save error:", error);
        alert(error.code === "auth/requires-recent-login" ? t.forSecurity : t.changeError);
      }
    });

    // Confirm delete
    const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", async () => {
      const lang = getLang();
      const t = translations[lang];
      const confirmInput = document.getElementById("deleteConfirmInput").value.trim().toLowerCase();
      const errorEl = document.getElementById("deleteConfirm-error");
      errorEl.innerText = "";

      const expectedWord = lang === "fr" ? "supprimer" : "delete";

      if (confirmInput !== expectedWord) {
        errorEl.innerText = t.deleteConfirmError;
        return;
      }

      try {
        const connectionsSnap = await getDocs(
          query(collection(db, "connections"), where("participants", "array-contains", user.uid))
        );
        await Promise.all(connectionsSnap.docs.map(d => deleteDoc(d.ref)));

        // Remove this user from any coach's subcoaches subcollection only
        // when the deleting user can actually be an affiliate coach.
        if (roles.includes("affiliateCoach")) {
          const subcoachSnap = await getDocs(
            query(collectionGroup(db, "subcoaches"), where("uid", "==", user.uid))
          );
          await Promise.all(subcoachSnap.docs.map(d => deleteDoc(d.ref)));
        }

        await deleteDoc(doc(db, "users", user.uid));
        await deleteUser(user);
        window.location.href = "index.html?message=deleted";
      } catch (error) {
        console.error("Delete error:", error);
        closeModal();
        alert(error.code === "auth/requires-recent-login" ? t.forSecurity : t.changeError);
      }
    });
  });
});
