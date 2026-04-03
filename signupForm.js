import { translations } from "./translations.js";



let currentLang = "fr";



import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
import { getAuth, createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"

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
	setLanguage(currentLang);
	
document.getElementById("lang-toggle").addEventListener("click", () => {
  currentLang = currentLang === "fr" ? "en" : "fr";

  localStorage.setItem("language", currentLang);
  setLanguage(currentLang);
});
	
	const name = document.getElementById("name");
	const lastName = document.getElementById("lastName");
	const emailAddress = document.getElementById("emailAddress");
	const phoneNumber = document.getElementById("phoneNumber");
	const skateCanadaNumber = document.getElementById("skateCanadaNumber");
	const password = document.getElementById("password");
	const passwordConfirmation = document.getElementById("passwordConfirmation");
	const parentName = document.getElementById("parentName");
  
	const nameError = document.getElementById("name-error");
	const lastNameError = document.getElementById("lastName-error");
	const emailAddressError = document.getElementById("emailAddress-error");
	const phoneNumberError = document.getElementById("phoneNumber-error");
	const skateCanadaNumberError = document.getElementById("skateCanadaNumber-error");
	const passwordError = document.getElementById("password-error");
	const passwordConfirmationError = document.getElementById("passwordConfirmation-error");

	const form = document.getElementById("signupForm");

		if (!form) {
  		console.error("signupForm not found in DOM");
  		return;
		}
		
	name.addEventListener("input", () => {
	nameError.innerText = "";
	});
	
	form.addEventListener("submit", (e) => {
	e.preventDefault();
	
	let valid = true;

	const roleElement = document.querySelector('input[name="role"]:checked');
	
		if (!roleElement) {
  			alert("Please select account type");
  				valid = false;
		}

	const role = roleElement ? roleElement.value : "";		

    

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
   
	if (!role) {
	alert("Please select account type");
	valid = false;
	}
   
	if (!emailAddress.value) {
	emailAddressError.innerText = "Email required";
	valid = false;
	} else if (!emailAddress.value.includes("@")) {
	emailAddressError.innerText = "Invalid email";
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

	
	
	if (!valid) return;

	let createdUser = null;
	  createUserWithEmailAndPassword(auth, emailAddress.value, password.value)
  .then((userCredential) => {
    createdUser = userCredential.user;

    return setDoc(doc(db, "users", createdUser.uid), {
      firstName: name.value,
      lastName: lastName.value,
      email: emailAddress.value,
      phoneNumber: phoneNumber.value,
      skateCanadaNumber: skateCanadaNumber.value,
      role: role,
      parentName: parentName.value
    });
  })


    .then(() => {
      alert("Account creation successful!");


	if (role === "coach") {
 		window.location.href = "coachAccount.html";
	} else if (role === "Skater_parent") {
 		window.location.href = "skaterAccount.html";
	} else if (role === "admin") {
 		window.location.href = "adminAccount.html";
	} else {
		window.location.href = "index.html";
	}})



    .catch(async (error) => {
  console.error(error);

  if (createdUser) {
    try {
      await deleteUser(createdUser);
    } catch (deleteError) {
      console.error("Delete failed", deleteError);
    }
  }

  alert(translations[currentLang].accountCreationError);
});
	});
	
});