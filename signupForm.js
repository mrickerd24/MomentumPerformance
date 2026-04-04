import { translations, setLanguage } from "./translations.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

// ---------------- FORM ----------------
const form = document.getElementById("signupForm");

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const checkedRoles = Array.from(document.querySelectorAll('input[name="role"]:checked')).map(el => el.value);

  const nameVal     = document.getElementById("name").value.trim();
  const lastNameVal = document.getElementById("lastName").value.trim();
  const emailVal    = document.getElementById("emailAddress").value.trim();
  const phoneVal    = document.getElementById("phoneNumber").value.trim();
  const skateNum    = document.getElementById("skateCanadaNumber").value.trim();
  const password    = document.getElementById("password").value;
  const confirmPw   = document.getElementById("passwordConfirmation").value;

  // Clear errors
  ["name", "lastName", "emailAddress", "phoneNumber", "password", "passwordConfirmation"].forEach(id => {
    const el = document.getElementById(`${id}-error`);
    if (el) el.innerText = "";
  });

  let valid = true;
  if (checkedRoles.length === 0)            { alert(translations[currentLang].selectRole); valid = false; }
  if (!nameVal)                             { document.getElementById("name-error").innerText = translations[currentLang].firstNameRequired; valid = false; }
  if (!lastNameVal)                         { document.getElementById("lastName-error").innerText = translations[currentLang].lastNameRequired; valid = false; }
  if (!emailVal || !emailVal.includes("@")) { document.getElementById("emailAddress-error").innerText = translations[currentLang].invalidEmail; valid = false; }
  if (!phoneVal)                            { document.getElementById("phoneNumber-error").innerText = translations[currentLang].phoneRequired; valid = false; }
  if (!password)                            { document.getElementById("password-error").innerText = translations[currentLang].passwordRequired; valid = false; }
  if (password !== confirmPw)               { document.getElementById("passwordConfirmation-error").innerText = translations[currentLang].passwordMismatch; valid = false; }
  if (!valid) return;

  let createdUser = null;

  createUserWithEmailAndPassword(auth, emailVal, password)
    .then((userCredential) => {
      createdUser = userCredential.user;
      return setDoc(doc(db, "users", createdUser.uid), {
        firstName:         nameVal,
        lastName:          lastNameVal,
        email:             emailVal,
        phoneNumber:       phoneVal,
        skateCanadaNumber: skateNum,
        roles:             checkedRoles,
      });
    })
    .then(() => {
      window.location.href = "dashboard.html";
    })
    .catch(async (error) => {
      console.error(error);
      if (createdUser) {
        try { await deleteUser(createdUser); } catch (e) { console.error("Delete failed", e); }
      }
      alert(translations[currentLang].accountCreationError);
    });
});
