import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { translations, setLanguage } from "./translations.js";


document.addEventListener("DOMContentLoaded", () => {

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





document.getElementById("reset").addEventListener("click", () => {
    const email = document.getElementById("emailAddress").value;

    if(!email) {
        alert(translations[currentLang].enterEmail);
        return;
    }

    sendPasswordResetEmail(auth, email)
    .then(() => {
        alert(translations[currentLang].resetLinkSent);
    })

    .catch((error) => {
        alert(error.message);

    
    })
    });
});