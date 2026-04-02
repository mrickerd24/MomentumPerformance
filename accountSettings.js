import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { setLanguage } from "./translations.js";


const savedLang = localStorage.getItem("language") || "en";
setLanguage(savedLang);