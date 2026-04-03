import { translations, setLanguage } from "./translations.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA-17uYmpblsb3b-NlB5_RK7ci7ZvUkH4Q",
  authDomain: "momentum-performance.firebaseapp.com",
  projectId: "momentum-performance",
  storageBucket: "momentum-performance.firebasestorage.app",
  messagingSenderId: "571184327943",
  appId: "1:571184327943:web:a5df6568228ca686faa9a2",
  measurementId: "G-4996PSTP69"
};

// Initialize Firebase
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
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const button = document.getElementById("login-btn");

const emailError = document.getElementById("email-error");
const passwordError = document.getElementById("password-error");

button.addEventListener("click", (e) => {
  e.preventDefault();

  let valid = true;

  emailError.innerText = "";
  passwordError.innerText = "";

  if (!emailInput.value) {
    emailError.innerText = "Email required";
    valid = false;
  }

  if (!passwordInput.value) {
    passwordError.innerText = "Password required";
    valid = false;
  }

  if (!valid) return;

  signInWithEmailAndPassword(auth, emailInput.value, passwordInput.value)
    .then(async (userCredential) => {
      const user = userCredential.user;

      const docRef = doc(db, "users", user.uid);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const userData = docSnap.data();

        if (userData.role === "coach") {
          window.location.href = "coachAccount.html";
        } else if (userData.role === "skater_parent") {
          window.location.href = "skaterAccount.html";
        } else if (userData.role === "admin") {
          window.location.href = "adminAccount.html";
        } else {
          window.location.href = "index.html";
        }
      } else {
        alert("User data not found");
      }
    })
    .catch((error) => {
      emailError.innerText = error.message;
    });
});
