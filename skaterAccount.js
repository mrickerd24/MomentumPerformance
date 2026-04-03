import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { setLanguage } from "./translations.js";

// ---------------- AUTH ----------------

const firebaseConfig = {
  apiKey: "AIzaSyA-17uYmpblsb3b-NlB5_RK7ci7ZvUkH4Q",
  authDomain: "momentum-performance.firebaseapp.com",
  projectId: "momentum-performance",
  storageBucket: "momentum-performance.firebasestorage.app",
  messagingSenderId: "571184327943",
  appId: "1:571184327943:web:a5df6568228ca686faa9a2",
  measurementId: "G-4996PSTP69"
};

const auth = getAuth();
const db = getFirestore();

// ---------------- LANGUAGE LOAD ----------------
const savedLang = localStorage.getItem("language") || "en";
setLanguage(savedLang);

// ---------------- AUTHENTICATION ----------------
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);

      let name = "Coach";

      if (userSnap.exists()) {
        const data = userSnap.data();
        name = data.firstName || "Coach";
      }

      const title = document.querySelector('[data-key-placeholder="WelcomeToDashboard"]');

      if (title) {
        title.textContent = `Welcome to your dashboard, ${name}`;
      }

    } catch (error) {
      console.error("Error fetching user:", error);
    }

  } else {
    window.location.href = "login.html";
  }
});

// ---------------- NAVIGATION ----------------
const routes = {
  "dashboard-btn": "skaterAccount.html",
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

// ---------------- ACTIVE STATE ----------------
const currentPage = window.location.pathname;

Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);

  if (btn && currentPage.includes(routes[id])) {
    btn.classList.add("active");
  } else if (btn) {
    btn.classList.remove("active");
  }
});