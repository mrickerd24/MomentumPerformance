import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
// Initialize Firestore with:
//  - persistentLocalCache: caches data in IndexedDB so repeat visits render instantly
//    from cache while revalidating in the background.
//  - persistentMultipleTabManager: lets the cache work across multiple open tabs.
//  - experimentalAutoDetectLongPolling: fixes iOS Safari "Fetch API cannot load ...
//    due to access control checks" by falling back from WebChannel to long polling
//    when ITP / strict-CORS environments block the streaming channel.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true,
});

// ---------------- LANGUAGE ----------------
export function getLang() {
  return localStorage.getItem("language") || "fr";
}

export function applyLanguage() {
  setLanguage(getLang());
}

export { translations };

// ---------------- NAME FORMATTING ----------------
// Names are stored Title Cased. Normalization happens at WRITE time (signup,
// account settings, child form) so that downstream display code can trust
// the stored value and just print it. Display sites should still call
// toTitleCase() defensively when rendering legacy data created before the
// migration — it's idempotent.
//
// Handles the common edge cases that a naive .toLowerCase() + capitalize-
// first-letter loop trips over:
//   - Apostrophes:   "o'connor"  -> "O'Connor"     (capitalize after ')
//   - Hyphens:       "marie-eve" -> "Marie-Eve"     (capitalize after -)
//   - Mc / Mac:      "mcdonald"  -> "McDonald"      (capitalize letter after Mc)
//   - Accents:       "élise"     -> "Élise"         (Unicode locale-aware)
//   - Multi-word:    "van der berg" -> "Van Der Berg"
//   - Whitespace is collapsed and trimmed.
export function toTitleCase(input) {
  if (typeof input !== "string") return "";
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  // Locale-lower first so accented uppercase ("É") becomes "é" before we
  // re-capitalize. Then split on word-boundary characters that should
  // each trigger a capital on the *next* letter: spaces, hyphens, and
  // apostrophes (both straight and curly).
  const lowered = collapsed.toLocaleLowerCase("fr-CA");

  // Walk character-by-character so we can capitalize the first letter
  // following any of the boundary characters.
  const boundaries = new Set([" ", "-", "'", "\u2019"]); // ' and ’
  let out = "";
  let capitalizeNext = true;
  for (const ch of lowered) {
    if (boundaries.has(ch)) {
      out += ch;
      capitalizeNext = true;
    } else if (capitalizeNext) {
      out += ch.toLocaleUpperCase("fr-CA");
      capitalizeNext = false;
    } else {
      out += ch;
    }
  }

  // "Mc" / "Mac" prefix fix-up: if a word starts with Mc or Mac followed
  // by a lowercase letter, capitalize that letter too. Applied per-word
  // so it doesn't catch things like "Maclen" (which IS just one word).
  out = out.replace(/\b(Mc)([a-z\u00E0-\u017F])/g, (_, p, c) => p + c.toLocaleUpperCase("fr-CA"));
  out = out.replace(/\b(Mac)([a-z\u00E0-\u017F])/g, (_, p, c) => p + c.toLocaleUpperCase("fr-CA"));

  return out;
}

// Convenience for "First Last" rendering. Trims and joins; if either part
// is missing, gracefully omits the empty side rather than leaving a stray
// space. Re-runs toTitleCase defensively in case the stored value is
// legacy uppercase (pre-migration). Idempotent on already-title-cased
// input, so it's safe to apply at every render site.
export function formatFullName(u) {
  if (!u) return "";
  const first = toTitleCase(u.firstName || "");
  const last  = toTitleCase(u.lastName  || "");
  return [first, last].filter(s => /\p{L}/u.test(s)).join(" ");
}

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

// ---------------- SHARED UTILITIES ----------------
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function hasCoachRole(roles = []) {
  return roles.includes("coach") || roles.includes("affiliateCoach");
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
