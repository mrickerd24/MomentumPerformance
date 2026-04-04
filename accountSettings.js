import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { translations, setLanguage } from "./translations.js";

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
const savedLang = localStorage.getItem("language") || "en";
setLanguage(savedLang);

const languageRadios = document.querySelectorAll('input[name="language"]');
const savedLangRadio = document.querySelector(`input[value="${savedLang}"]`);
if (savedLangRadio) savedLangRadio.checked = true;

languageRadios.forEach(radio => {
  radio.addEventListener("change", (e) => {
    const selectedLang = e.target.value;
    localStorage.setItem("language", selectedLang);
    setLanguage(selectedLang);
  });
});

// ---------------- LOAD USER DATA ----------------
let currentUser = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  currentUser = user;

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      const data = userSnap.data();
      document.getElementById("name").value = data.firstName || "";
      document.getElementById("lastName").value = data.lastName || "";
      document.getElementById("emailAddress").value = data.email || "";
      document.getElementById("phoneNumber").value = data.phoneNumber || "";
      document.getElementById("skateCanadaNumber").value = data.skateCanadaNumber || "";
      const parentNameField = document.getElementById("parentName");
      if (parentNameField) parentNameField.value = data.parentName || "";
    }
  } catch (error) {
    console.error("Error loading user data:", error);
  }
});

// ---------------- SAVE CHANGES ----------------
const form = document.getElementById("accountSettings");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!currentUser) return;

  // Clear errors
  ["name", "lastName", "emailAddress", "phoneNumber", "skateCanadaNumber", "password", "passwordConfirmation"].forEach(id => {
    const el = document.getElementById(`${id}-error`);
    if (el) el.innerText = "";
  });

  const nameVal = document.getElementById("name").value.trim();
  const lastNameVal = document.getElementById("lastName").value.trim();
  const emailVal = document.getElementById("emailAddress").value.trim();
  const phoneVal = document.getElementById("phoneNumber").value.trim();
  const skateNumVal = document.getElementById("skateCanadaNumber").value.trim();
  const newPassword = document.getElementById("changepassword").value;
  const confirmPassword = document.getElementById("passwordConfirmation").value;
  const parentNameField = document.getElementById("parentName");
  const parentNameVal = parentNameField ? parentNameField.value.trim() : "";

  let valid = true;

  if (!nameVal) {
    document.getElementById("name-error").innerText = "First name is required";
    valid = false;
  }
  if (!lastNameVal) {
    document.getElementById("lastName-error").innerText = "Last name is required";
    valid = false;
  }
  if (!emailVal || !emailVal.includes("@")) {
    document.getElementById("emailAddress-error").innerText = "Valid email is required";
    valid = false;
  }
  if (!phoneVal) {
    document.getElementById("phoneNumber-error").innerText = "Phone number is required";
    valid = false;
  }
  if (newPassword && newPassword !== confirmPassword) {
    document.getElementById("passwordConfirmation-error").innerText = "Passwords do not match";
    valid = false;
  }
  if (newPassword && newPassword.length < 6) {
    document.getElementById("password-error").innerText = "Password must be at least 6 characters";
    valid = false;
  }

  if (!valid) return;

  try {
    // Update Firestore profile
    const userRef = doc(db, "users", currentUser.uid);
    await updateDoc(userRef, {
      firstName: nameVal,
      lastName: lastNameVal,
      email: emailVal,
      phoneNumber: phoneVal,
      skateCanadaNumber: skateNumVal,
      parentName: parentNameVal
    });

    // Update password if provided
    if (newPassword) {
      await updatePassword(currentUser, newPassword);
      document.getElementById("changepassword").value = "";
      document.getElementById("passwordConfirmation").value = "";
    }

    
    const lang = localStorage.getItem("language") || "en";
    alert(translations[lang].changesSaved);
  } catch (error) {
    console.error("Save error:", error);
    const lang = localStorage.getItem("language") || "en";
    if (error.code === "auth/requires-recent-login") {
      alert(translations[lang].forSecurity);
    } else {
      alert(translations[lang].forSecurity);
    }
  }
});

// ---------------- NAVIGATION ----------------
const routes = {
  "dashboard-btn": "coachAccount.html",
  "calendar-btn": "calendar.html",
  "payment-btn": "payment.html",
  "settings-btn": "accountSettings.html"
};

Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);
  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = routes[id];
    });
  }
});

// Logout
const logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    signOut(auth)
      .then(() => { window.location.href = "index.html"; })
      .catch((error) => { console.error("Logout error:", error); });
  });
}

// Active state
const currentPage = window.location.pathname;
Object.keys(routes).forEach(id => {
  const btn = document.getElementById(id);
  if (btn && currentPage.includes(routes[id])) {
    btn.classList.add("active");
  } else if (btn) {
    btn.classList.remove("active");
  }
});
