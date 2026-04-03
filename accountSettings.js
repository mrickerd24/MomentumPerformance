import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage } from "./translations.js";

const firebaseConfig = {
  apiKey: "AIzaSyA-17uYmpblsb3b-NlB5_RK7ci7ZvUkH4Q",
  authDomain: "momentum-performance.firebaseapp.com",
  projectId: "momentum-performance",
  storageBucket: "momentum-performance.firebasestorage.app",
  messagingSenderId: "571184327943",
  appId: "1:571184327943:web:a5df6568228ca686faa9a2",
  measurementId: "G-4996PSTP69"
};


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------------- LANGUAGE LOAD ----------------
const savedLang = localStorage.getItem("language") || "en";
setLanguage(savedLang);

// ---------------- LANGUAGE PERSISTENCE ----------------
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

// ---------------- NAVIGATION ----------------
const routes = {
  "dashboard-btn": "coachAccount.html",
  "calendar-btn": "calendar.html",
  "payment-btn": "payment.html",
  "settings-btn": "accountSettings.html"
};

// Navigation (all except logout)
Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);

  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = routes[id];
    });
  }
});

// Logout (separate)
const logoutBtn = document.getElementById("logout-btn");

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    signOut(auth)
      .then(() => {
        window.location.href = "login.html";
      })
      .catch((error) => {
        console.error("Logout error:", error);
      });
  });
}

// Active state
const currentPage = window.location.pathname;

Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);

  if (btn && currentPage.includes(routes[id])) {
    btn.classList.add("active");
  } else if (btn) {
    btn.classList.remove("active");
  }
});