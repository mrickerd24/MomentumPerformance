import { getAuth, onAuthStateChanged } from "firebase/auth";

const auth = getAuth();

onAuthStateChanged(auth, (user) => {
  if (user) {
    // Get name (fallback if missing)
    const name = user.displayName || "Coach";

    // Target your title element
    const title = document.querySelector('[data-key-placeholder="WelcomeToDashboard"]');

    if (title) {
      title.textContent = `Welcome to your dashboard, ${name}`;
    }
  } else {
    // Optional: redirect if not logged in
    window.location.href = "login.html";
  }
});

// Language toggle (kept from your file)
let currentLang = "en";

document.getElementById("lang-toggle").addEventListener("click", () => {
  currentLang = currentLang === "fr" ? "en" : "fr";
  setLanguage(currentLang);
});

window.toggleMenu = toggleMenu;