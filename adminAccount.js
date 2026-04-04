import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { translations, setLanguage } from "./translations.js";

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

// LANGUAGE
document.addEventListener("DOMContentLoaded", () => {
  const savedLang = localStorage.getItem("language") || "en";
  setLanguage(savedLang);
});

// AUTH CHECK
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      // Sign out before redirecting to avoid ghost auth session
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }

    const data = userSnap.data();

    if (data.role !== "admin") {
      // Sign out before redirecting — wrong role should not stay authenticated here
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }

    const name = data.firstName || "Admin";

    const title = document.querySelector('[data-key="WelcomeToDashboard"]');
    if (title) {
      const lang = localStorage.getItem("language") || "en";
      const welcomeText = translations[lang]["WelcomeToDashboard"] || "Welcome to your dashboard";
      title.textContent = `${welcomeText}, ${name}`;
    }

  } catch (error) {
    console.error("Admin load error:", error);
  }
});

// NAVIGATION
const routes = {
  "dashboard-btn": "adminAccount.html",
  "calendar-btn": "calendar.html",
  "payment-btn": "payment.html",
  "settings-btn": "accountSettingsAdmin.html"
};

Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);
  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = routes[id];
    });
  }
});

// LOGOUT
const logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    signOut(auth)
      .then(() => { window.location.href = "index.html"; })
      .catch((error) => { console.error("Logout error:", error); });
  });
}

// ACTIVE STATE
const currentPage = window.location.pathname;
Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);
  if (btn && currentPage.includes(routes[id])) {
    btn.classList.add("active");
  } else if (btn) {
    btn.classList.remove("active");
  }
});