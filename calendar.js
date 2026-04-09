import { auth, db, getLang, applyLanguage, authGuard, initNav, translations } from "./app.js";

document.addEventListener("DOMContentLoaded", () => {
    applyLanguage();

    let currentView = "month";
    let currentDate = new Date();
    let lang = getLang();

    // ── Inline styles for toggle buttons & nav ──────────────────────────────
    const style = document.createElement("style");
    style.textContent = `
        #view-toggle {
            display: flex;
            gap: 6px;
            margin-bottom: 12px;
        }
        .view-btn {
            flex: 1;
            padding: 7px 4px;
            font-size: 13px;
            font-weight: 600;
            background: #F4F5F7;
            color: #172B4D;
            border: 1px solid #D0D4DB;
            border-radius: 8px;
            cursor: pointer;
            width: auto;
        }
        .view-btn.active {
            background: #0C66E4;
            color: #fff;
            border-color: #0C66E4;
        }
        .view-btn:hover:not(.active) {
            background: #E9F2FF;
        }
        #period-nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }
        #period-nav button {
            width: auto;
            padding: 6px 14px;
            font-size: 16px;
            background: #F4F5F7;
            color: #172B4D;
            border: 1px solid #D0D4DB;
            border-radius: 8px;
        }
        #period-nav button:hover {
            background: #E9F2FF;
        }
        #period-label {
            font-weight: 600;
            font-size: 15px;
            color: #172B4D;
            text-transform: capitalize;
        }

        /* ── Month grid ── */
        #calendar-grid.month-view {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 3px;
        }
        .cal-day-header {
            text-align: center;
            font-size: 11px;
            font-weight: 700;
            color: #5E6C84;
            padding: 4px 0;
            text-transform: uppercase;
        }
        .cal-day {
            min-height: 52px;
            border-radius: 6px;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding-top: 8px;
            font-size: 14px;
            font-weight: 500;
            color: #172B4D;
            cursor: default;
            border: 1px solid #F0F1F3;
            width: 100%;
        }
        .cal-day.other-month {
            color: #C1C7D0;
        }
        .cal-day.today {
            background: #0C66E4;
            color: #fff;
            font-weight: 700;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            min-height: unset;
            margin: auto;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
        }
        .cal-day-cell {
            display: flex;
            justify-content: stretch;
            align-items: stretch;
            padding: 2px;
        }

        /* ── Week grid ── */
        #calendar-grid.week-view {
            display: grid;
            grid-template-columns: 44px repeat(7, 1fr);
            gap: 1px;
            overflow-y: auto;
            max-height: 420px;
        }
        .week-header {
            text-align: center;
            font-size: 11px;
            font-weight: 700;
            color: #5E6C84;
            padding: 4px 2px;
            text-transform: uppercase;
        }
        .week-header.today-col {
            color: #0C66E4;
        }
        .week-time-label {
            font-size: 10px;
            color: #8993A4;
            text-align: right;
            padding-right: 6px;
            line-height: 40px;
            height: 40px;
        }
        .week-cell {
            height: 40px;
            border-top: 1px solid #F0F1F3;
        }
        .week-cell.today-col {
            background: #E9F2FF22;
        }

        /* ── Day view ── */
        #calendar-grid.day-view {
            display: grid;
            grid-template-columns: 44px 1fr;
            gap: 1px;
            overflow-y: auto;
            max-height: 420px;
        }
        .day-time-label {
            font-size: 10px;
            color: #8993A4;
            text-align: right;
            padding-right: 6px;
            line-height: 40px;
            height: 40px;
        }
        .day-cell {
            height: 40px;
            border-top: 1px solid #F0F1F3;
        }
    `;
    document.head.appendChild(style);

    // ── Helpers ─────────────────────────────────────────────────────────────
    const TODAY = new Date();
    function isToday(d) {
        return d.getFullYear() === TODAY.getFullYear() &&
               d.getMonth()    === TODAY.getMonth()    &&
               d.getDate()     === TODAY.getDate();
    }

    function shortDayNames() {
        // Sun–Sat in current lang
        const names = [];
        const ref = new Date(2023, 0, 1); // Sunday
        for (let i = 0; i < 7; i++) {
            names.push(ref.toLocaleDateString(lang, { weekday: "short" }));
            ref.setDate(ref.getDate() + 1);
        }
        return names;
    }

    function hourLabel(h) {
        if (lang === "fr") return `${String(h).padStart(2,"0")}h`;
        const suffix = h < 12 ? "AM" : "PM";
        const display = h % 12 === 0 ? 12 : h % 12;
        return `${display} ${suffix}`;
    }

    // ── Renderers ────────────────────────────────────────────────────────────
    function renderMonth() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "month-view";
        grid.innerHTML = "";

        const dayNames = shortDayNames();
        dayNames.forEach(name => {
            const h = document.createElement("div");
            h.className = "cal-day-header";
            h.textContent = name;
            grid.appendChild(h);
        });

        const year  = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrev  = new Date(year, month, 0).getDate();

        let cells = [];
        // Prev month padding
        for (let i = firstDay - 1; i >= 0; i--) {
            cells.push({ day: daysInPrev - i, thisMonth: false });
        }
        // This month
        for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, thisMonth: true, date: new Date(year, month, d) });
        }
        // Next month padding to fill last row
        let next = 1;
        while (cells.length % 7 !== 0) {
            cells.push({ day: next++, thisMonth: false });
        }

        cells.forEach(c => {
            const cell = document.createElement("div");
            cell.className = "cal-day-cell";
            const inner = document.createElement("div");
            inner.textContent = c.day;
            if (!c.thisMonth) {
                inner.className = "cal-day other-month";
            } else if (c.date && isToday(c.date)) {
                inner.className = "cal-day today";
            } else {
                inner.className = "cal-day";
            }
            cell.appendChild(inner);
            grid.appendChild(cell);
        });
    }

    function renderWeek() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "week-view";
        grid.innerHTML = "";

        // Week start (Sunday)
        const start = new Date(currentDate);
        start.setDate(currentDate.getDate() - currentDate.getDay());

        // Corner blank
        const corner = document.createElement("div");
        grid.appendChild(corner);

        // Day headers
        for (let i = 0; i < 7; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            const h = document.createElement("div");
            h.className = "week-header" + (isToday(d) ? " today-col" : "");
            h.textContent = d.toLocaleDateString(lang, { weekday: "short" }) + " " + d.getDate();
            grid.appendChild(h);
        }

        // Hour rows (6am–10pm)
        for (let hour = 6; hour <= 22; hour++) {
            const label = document.createElement("div");
            label.className = "week-time-label";
            label.textContent = hourLabel(hour);
            grid.appendChild(label);

            for (let i = 0; i < 7; i++) {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                const cell = document.createElement("div");
                cell.className = "week-cell" + (isToday(d) ? " today-col" : "");
                grid.appendChild(cell);
            }
        }
    }

    function renderDay() {
        const grid = document.getElementById("calendar-grid");
        grid.className = "day-view";
        grid.innerHTML = "";

        for (let hour = 6; hour <= 22; hour++) {
            const label = document.createElement("div");
            label.className = "day-time-label";
            label.textContent = hourLabel(hour);
            grid.appendChild(label);

            const cell = document.createElement("div");
            cell.className = "day-cell";
            grid.appendChild(cell);
        }
    }

    function renderCalendar() {
        const label = document.getElementById("period-label");

        if (currentView === "month") {
            label.textContent = currentDate.toLocaleDateString(lang, { month: "long", year: "numeric" });
            renderMonth();
        } else if (currentView === "week") {
            const start = new Date(currentDate);
            start.setDate(currentDate.getDate() - currentDate.getDay());
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            label.textContent =
                start.toLocaleDateString(lang, { month: "short", day: "numeric" }) +
                " – " +
                end.toLocaleDateString(lang, { month: "short", day: "numeric" });
            renderWeek();
        } else if (currentView === "day") {
            label.textContent = currentDate.toLocaleDateString(lang, { weekday: "long", month: "long", day: "numeric" });
            renderDay();
        }

        // Update active button
        document.querySelectorAll(".view-btn").forEach(btn => {
            btn.classList.toggle("active", btn.id === `btn-${currentView}`);
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    authGuard([], (user, userData) => {

        document.querySelectorAll(".view-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                currentView = btn.id.replace("btn-", "");
                renderCalendar();
            });
        });

        renderCalendar();
        initNav("calendar.html");

        document.getElementById("prev-btn").addEventListener("click", () => {
            if (currentView === "month")      currentDate.setMonth(currentDate.getMonth() - 1);
            else if (currentView === "week")  currentDate.setDate(currentDate.getDate() - 7);
            else if (currentView === "day")   currentDate.setDate(currentDate.getDate() - 1);
            renderCalendar();
        });

        document.getElementById("next-btn").addEventListener("click", () => {
            if (currentView === "month")      currentDate.setMonth(currentDate.getMonth() + 1);
            else if (currentView === "week")  currentDate.setDate(currentDate.getDate() + 7);
            else if (currentView === "day")   currentDate.setDate(currentDate.getDate() + 1);
            renderCalendar();
        });
    });
});
