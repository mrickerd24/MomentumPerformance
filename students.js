import { db, getLang, authGuard, initNav, translations } from "./app.js";
import {
  collection, query, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- HELPER -----------------
function fullName(u) {
  return `${u.firstName || ""} ${u.lastName || ""}`.trim();
}

// ---------- RENDER -----------------
function renderStudents(students) {
  const t = translations[getLang()];
  const list = document.getElementById("students-list");
  list.innerHTML = "";

  if (students.length === 0) {
    list.innerHTML = `<p style='color:#5E6C84;font-size:13px;'>${t.noStudentsFound}</p>`;
    return;
  }

  students.forEach(student => {
    const card = document.createElement("div");
    card.className = "student-card";
    card.innerHTML = `
      <strong style="font-size:14px">${student.name}</strong><br>
      <span style="font-size:12px;color:#5E6C84">${student.email}</span><br>
      <span style="font-size:11px;color:#0C66E4;font-weight:600;">${student.roles.join(", ")}</span>
    `;
    list.appendChild(card);
  });
}

// ---------- LOAD -----------------
async function loadStudents(myUid) {
  const snap = await getDocs(
    query(
      collection(db, "connections"),
      where("participants", "array-contains", myUid),
      where("status", "==", "accepted")
    )
  );

  const students = [];

  snap.forEach(d => {
    const data = d.data();
    const otherUid = data.participants.find(id => id !== myUid);
    const otherRoles = data.roles?.[otherUid] || [];
    const isStudent = otherRoles.includes("skater") || otherRoles.includes("parent");

    if (isStudent) {
      students.push({
        name:  data.names[otherUid],
        email: data.emails[otherUid],
        roles: otherRoles,
      });
    }
  });

  renderStudents(students);

  // ---------- SEARCH FILTER -----------------
  document.getElementById("searchInput").addEventListener("input", (e) => {
    const raw = e.target.value.trim().toLowerCase();
    const filtered = students.filter(s =>
      s.name.toLowerCase().includes(raw) ||
      s.email.toLowerCase().includes(raw)
    );
    renderStudents(filtered);
  });
}

// ---------- INIT -----------------
document.addEventListener("DOMContentLoaded", () => {
  authGuard([], (user, userData) => {
    const t = translations[getLang()];
    document.getElementById("page-title").textContent = t.students;
    document.getElementById("search-label").textContent = t.searchByName;
    initNav("students.html");
    loadStudents(user.uid);
  });
});