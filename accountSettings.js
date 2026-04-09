import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";
import { updatePassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc, deleteDoc, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
      border-radius:999px; padding:4px 10px; margin:4px 4px 4px 0;
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
    document.getElementById("name").value         = userData.firstName   || "";
    document.getElementById("lastName").value     = userData.lastName    || "";
    document.getElementById("emailAddress").value = userData.email       || "";
    document.getElementById("phoneNumber").value  = userData.phoneNumber || "";

    const roles = userData.rolesArray;
    const isNonAdmin = roles.includes("coach") || roles.includes("skater") || roles.includes("parent");

    // Show/hide sections based on role
    const skateCanRow = document.getElementById("skateCan-row");
    if (skateCanRow) {
      skateCanRow.style.display = isNonAdmin ? "" : "none";
      if (isNonAdmin) document.getElementById("skateCanadaNumber").value = userData.skateCanadaNumber || "";
    }

    const clubSearchRow = document.getElementById("clubSearch-row");
    if (clubSearchRow) {
      clubSearchRow.style.display = isNonAdmin ? "" : "none";
    }

    const clubNumRow = document.getElementById("clubNum-row");
    if (clubNumRow) {
      const isAdmin = roles.includes("admin");
      clubNumRow.style.display = isAdmin ? "" : "none";
      if (isAdmin) document.getElementById("skateCanClubNumber").value = userData.skateCanClubNumber || "";
    }

    const parentRow = document.getElementById("parentName-row");
    if (parentRow) parentRow.style.display = "none";

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

      const nameVal     = document.getElementById("name").value.trim();
      const lastNameVal = document.getElementById("lastName").value.trim();
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
      if (clubErrEl && isNonAdmin && selectedClubs.length === 0) {
        clubErrEl.innerText = t.selectClub || "Please select at least one club";
        valid = false;
      }
      if (!valid) return;

      const updateData = {
        firstName:   nameVal,
        lastName:    lastNameVal,
        email:       emailVal,
        phoneNumber: phoneVal,
        clubs:       selectedClubs.map(c => c.id),
      };

      if (isNonAdmin) {
        updateData.skateCanadaNumber = document.getElementById("skateCanadaNumber") ? document.getElementById("skateCanadaNumber").value.trim() : "";
      }
      if (roles.includes("admin")) {
        updateData.skateCanClubNumber = document.getElementById("skateCanClubNumber") ? document.getElementById("skateCanClubNumber").value.trim() : "";
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
        await deleteDoc(doc(db, "users", user.uid));
        await deleteUser(user);
        window.location.href = "index.html?message=deleted";
      } catch (error) {
        console.error("Delete error:", error);
        closeModal();
        alert(error.code === "auth/requires-recent-login" ? t.forSecurity : t.changeError);
      }
    });

    initNav("accountSettings.html");
  });
});
