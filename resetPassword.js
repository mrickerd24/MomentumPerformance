import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { translations, setLanguage } from "./translations.js";

const firebaseConfig = {
  apiKey: "AIzaSyDN9m9khT74pXITmdDnJsQs4R8JhcpGQLs",
  authDomain: "momentum-performance-staging.firebaseapp.com",
  projectId: "momentum-performance-staging",
  storageBucket: "momentum-performance-staging.firebasestorage.app",
  messagingSenderId: "812122501954",
  appId: "1:812122501954:web:3f629bda850d3ec56c0edb",
  measurementId: "G-S2RKK30F6T"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

document.addEventListener("DOMContentLoaded", () => {
  const lang = localStorage.getItem("language") || "fr";
  setLanguage(lang);

  document.getElementById("reset").addEventListener("click", () => {
    const currentLang = localStorage.getItem("language") || "fr";
    const email = document.getElementById("emailAddress").value.trim();

    if (!email) {
      alert(translations[currentLang].enterEmail);
      return;
    }

    sendPasswordResetEmail(auth, email)
      .then(() => { alert(translations[currentLang].resetLinkSent); })
      .catch((error) => { alert(error.message); });
  });
});
