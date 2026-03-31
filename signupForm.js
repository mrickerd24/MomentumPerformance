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

  const name = document.getElementById("name");
  const lastName = document.getElementById("lastName");
  const emailAddress = document.getElementById("emailAddress");
  const phoneNumber = document.getElementById("phoneNumber");
  const skateCanadaNumber = document.getElementById("skateCanadaNumber");
  const password = document.getElementById("password");
  const passwordConfirmation = document.getElementById("passwordConfirmation");
  
  const nameError = document.getElementById("name-error");
  const lastNameError = document.getElementById("lastName-error");
  const emailAddressError = document.getElementById("emailAddress-error");
  const phoneNumberError = document.getElementById("phoneNumber-error");
  const skateCanadaNumberError = document.getElementById("skateCanadaNumber-error");
  const passwordError = document.getElementById("password-error");
  const passwordConfirmationError = document.getElementById("passwordConfirmation-error");

	const form = document.getElementById("signupForm");
	
	form.addEventListener("submit", (e) => {
	e.preventDefault();


    let valid = true;

    nameError.innerText = "";
    lastNameError.innerText = "";
	emailAddressError.innerText = "";
	phoneNumberError.innerText = "";
	skateCanadaNumberError.innerText = "";
	passwordError.innerText = "";
	passwordConfirmationError.innerText = "";
	

    if (!name.value) {
      nameError.innerText = "First name is required";
      valid = false;
    }

    if (!lastName.value) {
      lastNameError.innerText = "last name is required";
      valid = false;
    }
   
	if (!emailAddress.value.includes("@")) {
	emailAddressError.innerText = "Invalid email address";
	valid = false;
	}

    if (!phoneNumber.value) {
      phoneNumberError.innerText = "Phone number is required";
      valid = false;
    }	


    if (!password.value) {
      passwordError.innerText = "Password is required";
      valid = false;
    }		
	
    if (!passwordConfirmation.value) {
      passwordConfirmationError.innerText = "Password confirmation is required";
      valid = false;
    }	
	
	if (password.value !== passwordConfirmation.value) {
	passwordConfirmationError.innerText = "Passwords do not match";
	valid = false;
	}
	
	if (valid) {
	alert("Account created successfully");
	window.location.href = "index.html";
	}
	
   
  });

});