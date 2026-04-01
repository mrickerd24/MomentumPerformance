import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
	
	name.addEventListener("input", () => {
	nameError.innerText = "";
	});
	
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
      nameError.innerText = "Prénom requis";
      valid = false;
    }

    if (!lastName.value) {
      lastNameError.innerText = "Nom de famille requis";
      valid = false;
    }
   
	if (!emailAddress.value) {
	emailAddressError.innerText = "Courriel requis";
	valid = false;
	} else if (!emailAddress.value.includes("@")) {
	emailAddressError.innerText = "Courriel invalide";
	valid = false;
	}

    if (!phoneNumber.value) {
      phoneNumberError.innerText = "Numéro de téléphone requis";
      valid = false;
    }	
	

    if (!password.value) {
      passwordError.innerText = "Mot de passe requis";
      valid = false;
    }		
	
    if (!passwordConfirmation.value) {
      passwordConfirmationError.innerText = "Confirmation de mot de passe requis";
      valid = false;
    }	
	
	if (password.value !== passwordConfirmation.value) {
	passwordConfirmationError.innerText = "Les mots de passe doivent être identiques";
	valid = false;
	}
	
	if (!valid) return;
	  createUserWithEmailAndPassword(auth, emailAddress.value, password.value)
    .then((userCredential) => {
      const user = userCredential.user;

      return setDoc(doc(db, "users", user.uid), {
        firstName: name.value,
        lastName: lastName.value,
        email: emailAddress.value,
        phoneNumber: phoneNumber.value,
        skateCanadaNumber: skateCanadaNumber.value
      });
    })
    .then(() => {
      alert("Compte créé avec succès!");
      window.location.href = "index.html";
    })
    .catch((error) => {
      emailAddressError.innerText = error.message;
    });
});
	
});