import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { setLanguage } from "./translations.js";

const auth = getAuth();
const db = getFirestore();

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



// target logout button (bottom nav)
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