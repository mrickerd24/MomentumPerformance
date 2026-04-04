import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";
import { updatePassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage } from "./translations.js";

document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  // Language radio buttons
  const savedLang = getLang();
  const savedLangRadio = document.querySelector(`input[value="${savedLang}"]`);
  if (savedLangRadio) savedLangRadio.checked = true;

  document.querySelectorAll('input[name="language"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      localStorage.setItem("language", e.target.value);
      setLanguage(e.target.value);
    });
  });

  authGuard([], (user, userData) => {
    // Populate fields
    document.getElementById("name").value         = userData.firstName   || "";
    document.getElementById("lastName").value     = userData.lastName    || "";
    document.getElementById("emailAddress").value = userData.email       || "";
    document.getElementById("phoneNumber").value  = userData.phoneNumber || "";

    const roles = userData.rolesArray;

    // Show skate Canada number for coaches and skaters
    const skateCanRow = document.getElementById("skateCan-row");
    if (skateCanRow) {
      const show = roles.includes("coach") || roles.includes("skater_parent");
      skateCanRow.style.display = show ? "" : "none";
      if (show) document.getElementById("skateCanadaNumber").value = userData.skateCanadaNumber || "";
    }

    // Show club number for admins
    const clubRow = document.getElementById("clubNum-row");
    if (clubRow) {
      const show = roles.includes("admin");
      clubRow.style.display = show ? "" : "none";
      if (show) document.getElementById("skateCanClubNumber").value = userData.skateCanClubNumber || "";
    }

    // Show parent name for skaters
    const parentRow = document.getElementById("parentName-row");
    if (parentRow) {
      const show = roles.includes("skater_parent");
      parentRow.style.display = show ? "" : "none";
      if (show) document.getElementById("parentName").value = userData.parentName || "";
    }

    // Save
    const form = document.getElementById("accountSettingsForm");
    form.addEventListener("submit", async (e) => {
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
      if (!nameVal)                             { document.getElementById("name-error").innerText = "First name is required"; valid = false; }
      if (!lastNameVal)                         { document.getElementById("lastName-error").innerText = "Last name is required"; valid = false; }
      if (!emailVal || !emailVal.includes("@")) { document.getElementById("emailAddress-error").innerText = "Valid email is required"; valid = false; }
      if (!phoneVal)                            { document.getElementById("phoneNumber-error").innerText = "Phone number is required"; valid = false; }
      if (newPassword && newPassword.length < 6){ document.getElementById("password-error").innerText = "Min 6 characters"; valid = false; }
      if (newPassword && newPassword !== confirmPw) { document.getElementById("passwordConfirmation-error").innerText = "Passwords do not match"; valid = false; }
      if (!valid) return;

      const updateData = { firstName: nameVal, lastName: lastNameVal, email: emailVal, phoneNumber: phoneVal };

      if (roles.includes("coach") || roles.includes("skater_parent")) {
        updateData.skateCanadaNumber = document.getElementById("skateCanadaNumber")?.value.trim() || "";
      }
      if (roles.includes("admin")) {
        updateData.skateCanClubNumber = document.getElementById("skateCanClubNumber")?.value.trim() || "";
      }
      if (roles.includes("skater_parent")) {
        updateData.parentName = document.getElementById("parentName")?.value.trim() || "";
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

    initNav("accountSettings.html");
  });
});
