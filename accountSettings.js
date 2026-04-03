import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { setLanguage } from "./translations.js";


const savedLang = localStorage.getItem("language") || "en";
setLanguage(savedLang);

// ---------------------------LANGUAGE LOGIC PERSISTANCE-------------------------------------
const languageRadios = document.querySelectorAll('input[name="language"]');

// Pre-select saved language
const savedLangRadio = document.querySelector(`input[value="${savedLang}"]`);
if (savedLangRadio) {
  savedLangRadio.checked = true;
}

// Save + apply when changed
languageRadios.forEach(radio => {
  radio.addEventListener("change", (e) => {
    const selectedLang = e.target.value;

    localStorage.setItem("language", selectedLang);
    setLanguage(selectedLang);
  });
});

// -------------------------------NAV BAR LOGIC----------------------------

const routes = {
  "dashboard-btn": "coachAccount.html",
  "calendar-btn": "calendar.html",
  "payment-btn": "payment.html",
  "settings-btn": "accountSettings.html"
};

// Handle navigation clicks
Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);

  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = routes[id];
    });
  }
});

// Handle active state
const currentPage = window.location.pathname;

Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);

  if (btn && currentPage.includes(routes[id])) {
    btn.classList.add("active");
  } else if (btn) {
    btn.classList.remove("active");
  }
});
// -----------------------------------END OF NAV BAR LOGIC---------------------------

