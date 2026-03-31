import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

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

document.addEventListener("DOMContentLoaded", () => {

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
      emailError.innerText = "Courriel requis";
      valid = false;
    }

    if (!password.value) {
      passwordError.innerText = "Mot de passe requis";
      valid = false;
    }

    if (valid) {
	signInWithEmailAndPassword(auth, email.value, password.value)
    .then((userCredential) => {
      alert("Login successful");
      console.log(userCredential.user);
    })
    .catch((error) => {
      emailError.innerText = error.message;
    });
}
  });

});