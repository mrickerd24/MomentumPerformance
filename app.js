import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { translations, setLanguage } from "./translations.js";

// ---------------- FIREBASE ----------------
const firebaseConfig = {
  apiKey: "AIzaSyDN9m9khT74pXITmdDnJsQs4R8JhcpGQLs",
  authDomain: "momentum-performance-staging.firebaseapp.com",
  projectId: "momentum-performance-staging",
  storageBucket: "momentum-performance-staging.firebasestorage.app",
  messagingSenderId: "812122501954",
  appId: "1:812122501954:web:3f629bda850d3ec56c0edb",
  measurementId: "G-S2RKK30F6T"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---------------- LANGUAGE ----------------
export function getLang() {
  return localStorage.getItem("language") || "fr";
}

export function applyLanguage() {
  setLanguage(getLang());
}

export { translations };

// ---------------- AUTH GUARD ----------------
// Calls onReady(user, userData) once auth + Firestore data is loaded.
// Redirects to index.html if not logged in.
// requiredRoles: array of roles the user must have AT LEAST ONE of. Empty = any authenticated user allowed.
export function authGuard(requiredRoles = [], onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }

    try {
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        await signOut(auth);
        window.location.href = "index.html";
        return;
      }

      const userData = userSnap.data();
      // Support both old single role string and new roles array
      const userRoles = Array.isArray(userData.roles)
        ? userData.roles
        : [userData.role].filter(Boolean);

      if (requiredRoles.length > 0) {
        const hasRole = requiredRoles.some(r => userRoles.includes(r));
        if (!hasRole) {
          window.location.href = "index.html";
          return;
        }
      }

      // Attach normalized roles array to userData for convenience
      userData.rolesArray = userRoles;

      onReady(user, userData);
    } catch (error) {
      console.error("Auth guard error:", error);
    }
  });
}

// ---------------- NAVIGATION ----------------
export function initNav(activePage) {
  const routes = {
    "dashboard-btn": "dashboard.html",
    "calendar-btn":  "calendar.html",
    "payment-btn":   "payment.html",
    "settings-btn":  "accountSettings.html"
  };

  Object.keys(routes).forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener("click", () => { window.location.href = routes[id]; });
    btn.classList.toggle("active", routes[id] === activePage);
  });

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      signOut(auth)
        .then(() => { window.location.href = "index.html"; })
        .catch(err => console.error("Logout error:", err));
    });
  }
}
