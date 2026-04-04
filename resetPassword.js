import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { translations, setLanguage } from "./translations.js";

document.getElementById("reset").addEventListener("click", () => {
    const email = document.getElementById("emailAddress").value;

    if(!email) {
        alert(translations[currentLang].enterEmail);
        return;
    }

    sendPasswordResetEmail(Auth, email)
    .then(() => {
        alert(translations[currentLang].resetLinkSent);
    })

    .catch((error) => {
        alert(error.message);
    });
});