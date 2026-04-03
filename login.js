import { translations } from "./translations.js";



let currentLang = "fr";



import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"

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

function setLanguage(lang) {
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    el.textContent = translations[lang][key] || key;
  });

  document.querySelectorAll("[data-key-placeholder]").forEach(el => {
    const key = el.getAttribute("data-key-placeholder");
    el.placeholder = translations[lang][key] || "";
  });
}

  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const button = document.getElementById("login-btn");

  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");

  button.addEventListener("click", (e) => {
    e.preventDefault();

    let valid = true;

    emailError.innerText = "";
    passwordError.innerText = "";

    if (!email.value) {
      emailError.innerText = "Email required";
      valid = false;
    }

    if (!password.value) {
      passwordError.innerText = "Password required";
      valid = false;
    }

    if (valid) {
	signInWithEmailAndPassword(auth, email.value, password.value)
    .then(async(userCredential) => {
		const user = userCredential.user;

		const docRef = doc(db, "users", user.uid);
		const docSnap = await getDoc(docRef);
		
		if (docSnap.exists()) {
			const userData = docSnap.data();

      // MP-5 ROLE BASED REDIRECT LOGIC-------------------------
		if (userData.role === "coach") {
      window.location.href = "coachAccount.html";
    } else if (userData.role === "Skater_parent") {
      window.location.href = "skaterAccount.html";
    } else if (userData.role === "admin") {
      window.location.href = "adminAccount.html";
    } else {
      window.location.href = "index.html";
    }

		} else {
			alert("User data not found");
		}
		console.log(userCredential.user);
	}
  )

    .catch((error) => {
      emailError.innerText = error.message;
    });
	}
  });

});