import { getAuth, onAuthStateChanged } from "firebase/auth";

const auth = getAuth();

onAuthStateChanged(auth, (user) => {
  if (user) {
    const name = user.displayName || "Coach";

    const title = document.querySelector('[data-key-placeholder="WelcomeToDashboard"]');
    title.textContent = `Welcome to your dashboard, ${name}`;
  }
});

function toggleMenu() {
  const menu = document.getElementById("menu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

document.getElementById("lang-toggle").addEventListener("click", () => {
  currentLang = currentLang === "fr" ? "en" : "fr";
  setLanguage(currentLang);
});