import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";

// ---------------- TILE DEFINITIONS ----------------
const TILE_DEFINITIONS = {
  // Coach tiles
  students:       { labelKey: "students",       color: "#0C66E4", href: "#" },
  addStudent:     { labelKey: "addStudent",      color: "#0C66E4", href: "addConnection.html?mode=skater" },
  viewSchedule:   { labelKey: "viewSchedule",   color: "#1F845A", href: "#" },
  addhours:       { labelKey: "addhours",        color: "#C9372C", href: "#" },
  hoursCoached:   { labelKey: "hoursCoached",   color: "#852dcc", href: "#" },

  // Skater tiles
  coaches:        { labelKey: "coaches",         color: "#0C66E4", href: "#" },
  addCoach:       { labelKey: "addCoach",        color: "#1F845A", href: "addConnection.html?mode=coach" },
  hoursWithCoach: { labelKey: "hoursWithCoach",  color: "#852dcc", href: "#" },

  // Shared
  myRequests:     { labelKey: "pendingRequests", color: "#C9372C", href: "addConnection.html" },

  // Admin tiles
  clubCoaches:    { labelKey: "clubCoaches",     color: "#0C66E4", href: "#" },
  clubStudents:   { labelKey: "clubStudents",    color: "#1F845A", href: "#" },
  clubSchedule:   { labelKey: "clubSchedule",    color: "#C9372C", href: "#" },
  iceHours:       { labelKey: "iceHours",        color: "#852dcc", href: "#" },
};

// ---------------- ROLE SECTIONS ----------------
const ROLE_SECTIONS = {
  coach: {
    labelKey: "coachSection",
    tiles: ["students", "addStudent", "viewSchedule", "addhours", "hoursCoached", "myRequests"]
  },
  skater_parent: {
    labelKey: "skaterSection",
    tiles: ["coaches", "addCoach", "viewSchedule", "hoursWithCoach", "myRequests"]
  },
  admin: {
    labelKey: "adminSection",
    tiles: ["clubCoaches", "clubStudents", "clubSchedule", "iceHours", "addCoach", "addStudent"]
  },
};

// ---------------- RENDER DASHBOARD ----------------
function renderDashboard(userData) {
  const lang = getLang();
  const t = translations[lang];
  const roles = userData.rolesArray;
  const container = document.getElementById("tiles-container");
  container.innerHTML = "";

  roles.forEach(role => {
    const section = ROLE_SECTIONS[role];
    if (!section) return;

    // Section header
    const header = document.createElement("div");
    header.className = "section-header";
    header.textContent = t[section.labelKey] || section.labelKey;
    container.appendChild(header);

    // Render tiles in pairs
    const tileKeys = section.tiles;
    for (let i = 0; i < tileKeys.length; i += 2) {
      const row = document.createElement("div");
      row.className = "row";

      [tileKeys[i], tileKeys[i + 1]].forEach(key => {
        if (!key) return;
        const def = TILE_DEFINITIONS[key];
        if (!def) return;
        const tile = document.createElement("div");
        tile.className = "dashboard-tile";
        tile.style.borderColor = def.color;
        tile.innerHTML = `<p>${t[def.labelKey] || def.labelKey}</p>`;
        tile.addEventListener("click", () => {
          if (def.href !== "#") window.location.href = def.href;
        });
        row.appendChild(tile);
      });

      container.appendChild(row);

      const spacer = document.createElement("div");
      spacer.style.height = "12px";
      container.appendChild(spacer);
    }
  });
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  applyLanguage();

  authGuard([], (user, userData) => {
    const lang = getLang();
    const t = translations[lang];

    // Welcome message
    const title = document.getElementById("welcome-title");
    if (title) {
      const welcomeText = t["WelcomeToDashboard"] || "Welcome to your dashboard";
      title.textContent = `${welcomeText}, ${userData.firstName || ""}`;
    }

    renderDashboard(userData);
    initNav("dashboard.html");
  });
});
