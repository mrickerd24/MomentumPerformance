import { getAuth, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";

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

// Language toggle (kept from your file)
let currentLang = "en";

document.getElementById("lang-toggle").addEventListener("click", () => {
  currentLang = currentLang === "fr" ? "en" : "fr";
  setLanguage(currentLang);
});

window.toggleMenu = toggleMenu;