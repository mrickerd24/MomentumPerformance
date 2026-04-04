import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";

// ---------------- PERMISSIONS MAP ----------------
const TILE_DEFINITIONS = {
  // Coach tiles
  students:      { labelKey: "students",      color: "#0C66E4", href: "#" },
  addStuent:  { labelKey: "addStuent",       color: "#0C66E4", href: "addConnection.html?mode=skater" },
  viewSchedule:  { labelKey: "viewSchedule",  color: "#1F845A", href: "#" },
  addhours:      { labelKey: "addhours",      color: "#C9372C", href: "#" },
  hoursCoached:  { labelKey: "hoursCoached",  color: "#852dcc", href: "#" },

  // Skater tiles
  coaches:       { labelKey: "coaches",       color: "#0C66E4", href: "#" },
  addCoach:   { labelKey: "addCoach",        color: "#1F845A", href: "addConnection.html?mode=coach"  },
  hoursTrained:  { labelKey: "hoursTrained",  color: "#852dcc", href: "#" },

  // Admin tiles
  clubCoaches:   { labelKey: "clubCoaches",   color: "#0C66E4", href: "#" },
  clubStudents:  { labelKey: "clubStudents",  color: "#1F845A", href: "#" },
  clubSchedule:  { labelKey: "clubSchedule",  color: "#C9372C", href: "#" },
  iceHours:      { labelKey: "iceHours",      color: "#852dcc", href: "#" },

  // Adding connections 
  
  
  myRequests: { labelKey: "pendingRequests", color: "#C9372C", href: "addConnection.html"             },

};

const ROLE_PERMISSIONS = {
  coach:         ["students", "viewSchedule", "addhours", "hoursCoached", "addStuent"],
  skater_parent: ["coaches", "upcomingClasses", "viewSchedule", "hoursTrained", "addCoach"],
  admin:         ["clubCoaches", "clubStudents", "clubSchedule", "iceHours", "addStuent", "addCoach"],




};

// ---------------- RENDER TILES ----------------
function renderDashboard(userData) {
  const lang = getLang();
  const t = translations[lang];
  const roles = userData.rolesArray;
  const container = document.getElementById("tiles-container");
  container.innerHTML = "";

  // Collect all tile keys for this user's roles (deduplicated, order preserved)
  const seen = new Set();
  const tileKeys = [];
  roles.forEach(role => {
    (ROLE_PERMISSIONS[role] || []).forEach(key => {
      if (!seen.has(key)) {
        seen.add(key);
        tileKeys.push(key);
      }
    });
  });

  // If user has multiple roles, show a role badge section
  if (roles.length > 1) {
    const badgeRow = document.createElement("div");
    badgeRow.className = "role-badges";
    roles.forEach(role => {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.textContent = t[role] || role;
      badgeRow.appendChild(badge);
    });
    container.appendChild(badgeRow);
  }

  // Render tiles in pairs (2 per row)
  for (let i = 0; i < tileKeys.length; i += 2) {
    const row = document.createElement("div");
    row.className = "row";

    [tileKeys[i], tileKeys[i + 1]].forEach(key => {
      if (!key) return;
      const def = TILE_DEFINITIONS[key];
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
    // spacer between rows
    const spacer = document.createElement("div");
    spacer.style.height = "12px";
    container.appendChild(spacer);
  }
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
