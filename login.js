import { translations, setLanguage } from "./translations.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
const db = getFirestore(app);

// ---------------- LANGUAGE ----------------
let currentLang = localStorage.getItem("language") || "fr";
setLanguage(currentLang);

const langToggle = document.getElementById("lang-toggle");
if (langToggle) {
  langToggle.addEventListener("click", () => {
    currentLang = currentLang === "en" ? "fr" : "en";
    localStorage.setItem("language", currentLang);
    setLanguage(currentLang);
  });
}

// ---------------- LOGIN ----------------
const emailInput    = document.getElementById("email");
const passwordInput = document.getElementById("password");
const button        = document.getElementById("login-btn");
const emailError    = document.getElementById("email-error");
const passwordError = document.getElementById("password-error");

button.addEventListener("click", (e) => {
  e.preventDefault();
  emailError.innerText    = "";
  passwordError.innerText = "";

  let valid = true;
  if (!emailInput.value)    { emailError.innerText = "Email required"; valid = false; }
  if (!passwordInput.value) { passwordError.innerText = "Password required"; valid = false; }
  if (!valid) return;

  signInWithEmailAndPassword(auth, emailInput.value, passwordInput.value)
    .then(async (userCredential) => {
      const docSnap = await getDoc(doc(db, "users", userCredential.user.uid));
      if (docSnap.exists()) {
        window.location.href = "dashboard.html";
      } else {
        alert(translations[currentLang].userNotFound);
      }
    })
    .catch((error) => {
      emailError.innerText = error.message;
    });
});


// ---------------- LOGIN FROM DELETED ACCOUNT ----------------
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("message") === "deleted") {
  alert("Your account has been deleted.");
}