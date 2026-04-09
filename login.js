import { auth, db, translations } from "./app.js";
import { setLanguage } from "./translations.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
