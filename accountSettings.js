import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";
import { updatePassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage } from "./translations.js";

document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  // ── Language ────────────────────────────────────────────────────────────────
  const savedLang = getLang();
  const savedLangRadio = document.querySelector(`input[value="${savedLang}"]`);
  if (savedLangRadio) savedLangRadio.checked = true;

  document.querySelectorAll('input[name="language"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      localStorage.setItem("language", e.target.value);
      setLanguage(e.target.value);
    });
  });

  // ── Modal helpers ───────────────────────────────────────────────────────────
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

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────
  authGuard([], (user, userData) => {
    document.getElementById("name").value         = userData.firstName   || "";
    document.getElementById("lastName").value     = userData.lastName    || "";
    document.getElementById("emailAddress").value = userData.email       || "";
    document.getElementById("phoneNumber").value  = userData.phoneNumber || "";

    const roles = userData.rolesArray;

    const skateCanRow = document.getElementById("skateCan-row");
    if (skateCanRow) {
      const show = roles.includes("coach") || roles.includes("skater") || roles.includes("parent");
      skateCanRow.style.display = show ? "" : "none";
      if (show) document.getElementById("skateCanadaNumber").value = userData.skateCanadaNumber || "";
    }

    const clubRow = document.getElementById("clubNum-row");
    if (clubRow) {
      const show = roles.includes("admin");
      clubRow.style.display = show ? "" : "none";
      if (show) document.getElementById("skateCanClubNumber").value = userData.skateCanClubNumber || "";
    }

    const parentRow = document.getElementById("parentName-row");
    if (parentRow) parentRow.style.display = "none";

    // ── Save changes ──────────────────────────────────────────────────────────
    document.getElementById("accountSettingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();

      const lang = getLang();
      const t = translations[lang];

      ["name", "lastName", "emailAddress", "phoneNumber", "password", "passwordConfirmation"].forEach(id => {
        const el = document.getElementById(`${id}-error`);
        if (el) el.innerText = "";
      });

      const nameVal     = document.getElementById("name").value.trim();
      const lastNameVal = document.getElementById("lastName").value.trim();
      const emailVal    = document.getElementById("emailAddress").value.trim();
      const phoneVal    = document.getElementById("phoneNumber").value.trim();
      const newPassword = document.getElementById("changepassword").value;
      const confirmPw   = document.getElementById("passwordConfirmation").value;

      let valid = true;
      if (!nameVal)                                { document.getElementById("name-error").innerText = "First name is required"; valid = false; }
      if (!lastNameVal)                            { document.getElementById("lastName-error").innerText = "Last name is required"; valid = false; }
      if (!emailVal || !emailVal.includes("@"))    { document.getElementById("emailAddress-error").innerText = "Valid email is required"; valid = false; }
      if (!phoneVal)                               { document.getElementById("phoneNumber-error").innerText = "Phone number is required"; valid = false; }
      if (newPassword && newPassword.length < 6)   { document.getElementById("password-error").innerText = "Min 6 characters"; valid = false; }
      if (newPassword && newPassword !== confirmPw) { document.getElementById("passwordConfirmation-error").innerText = "Passwords do not match"; valid = false; }
      if (!valid) return;

      const updateData = { firstName: nameVal, lastName: lastNameVal, email: emailVal, phoneNumber: phoneVal };

      if (roles.includes("coach") || roles.includes("skater") || roles.includes("parent")) {
        updateData.skateCanadaNumber = document.getElementById("skateCanadaNumber")?.value.trim() || "";
      }
      if (roles.includes("admin")) {
        updateData.skateCanClubNumber = document.getElementById("skateCanClubNumber")?.value.trim() || "";
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

    // ── Confirm delete ────────────────────────────────────────────────────────
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
