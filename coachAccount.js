import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { setLanguage } from "./translations.js";

const auth = getAuth();
const db = getFirestore();


// ----------------------------------AUTHENTICATION LOGIC WITH FIREBASE ------------------
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      // Get Firestore document using UID
      const userRef = doc(db, "users", user.uid); // adjust "users" if your collection name is different
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
// -----------------------------------------END OF AUTH----------------------------------------------


// ----------------------------LOGOUT BUTTON----------------------------------------------
const logoutBtn = document.getElementById("logout-btn");

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    signOut(auth)
      .then(() => {
        // redirect after logout
        window.location.href = "login.html";
      })
      .catch((error) => {
        console.error("Logout error:", error);
      });
  });
}

window.toggleMenu = toggleMenu;
// --------------------------------END OF LOGOUT BUTTON------------------------

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