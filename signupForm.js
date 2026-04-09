import { auth, db } from "./app.js";
import { translations, setLanguage } from "./translations.js";
import { createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------- CLUBS ----------------
let allClubs = [];
let selectedClubs = [];

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function loadClubs() {
  const snap = await getDocs(query(collection(db, "clubs"), orderBy("name")));
  snap.forEach(d => {
    allClubs.push({ id: d.id, ...d.data() });
  });
}

function renderSelectedClubs() {
  const container = document.getElementById("selected-clubs");
  container.innerHTML = "";

  selectedClubs.forEach(club => {
    const chip = document.createElement("span");
    chip.style.cssText = `
      display:inline-flex; align-items:center; gap:6px;
      background:#E9F2FF; color:#0C66E4; border:1px solid #0C66E4;
      border-radius:999px; padding:4px 10px; margin:4px 4px 4px 0;
      font-size:12px; font-weight:600;
    `;
    chip.innerHTML = `${club.name} <span style="cursor:pointer;font-weight:700;">✕</span>`;
    chip.querySelector("span").addEventListener("click", () => {
      selectedClubs = selectedClubs.filter(s => s.id !== club.id);
      renderSelectedClubs();
      filterClubs(document.getElementById("clubSearch").value);
    });
    container.appendChild(chip);
  });
}

function filterClubs(searchTerm) {
  const raw = normalize(searchTerm.trim());
  const resultsDiv = document.getElementById("club-results");
  resultsDiv.innerHTML = "";
  if (!raw) return;

  const matches = allClubs.filter(c =>
    normalize(c.name).includes(raw) ||
    normalize(c.region).includes(raw)
  );

  if (!matches.length) {
    resultsDiv.innerHTML = '<p style="color:#5E6C84;font-size:13px;">No results found</p>';
    return;
  }

  matches.forEach(club => {
    const alreadySelected = selectedClubs.some(s => s.id === club.id);
    if (alreadySelected) return;

    const card = document.createElement("div");
    card.className = "student-card";
    card.style.cursor = "pointer";
    card.innerHTML = `
      <strong style="font-size:14px">${club.name}</strong><br>
      <span style="font-size:12px;color:#5E6C84">${club.region}</span>
    `;
    card.addEventListener("click", () => {
      selectedClubs.push(club);
      document.getElementById("clubSearch").value = "";
      document.getElementById("club-results").innerHTML = "";
      renderSelectedClubs();
    });
    resultsDiv.appendChild(card);
  });
}

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
  document.getElementById("clubSearch-error").innerText = "";

  let valid = true;
  if (checkedRoles.length === 0)            { alert(translations[currentLang].selectRole); valid = false; }
  if (selectedClubs.length === 0)           { document.getElementById("clubSearch-error").innerText = translations[currentLang].selectClub || "Please select at least one club"; valid = false; }
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
        clubs:             selectedClubs.map(c => c.id),
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

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", async () => {
  await loadClubs();
  document.getElementById("clubSearch").addEventListener("input", (e) => {
    filterClubs(e.target.value);
  });
});
