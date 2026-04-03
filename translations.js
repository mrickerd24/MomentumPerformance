export const translations = {
  en: {
    login: "Login",
    email: "Email",
    password: "Password",
    createAccount: "Create account",
	WelcomeToDashboard: "Welcome to your dashboard",
	accountType: "Account type",
	coach: "Coach",
	skaterParent: "Skater or parent",
	name: "Name",
	lastName: "Last name",
	parentName: "Parent name (optional)",
	phoneNumber: "Phone number",
	skateCan: "Skate Canada number",
	createpw: "Create a password",
	confirmpw: "Confirm password",
	toLogin: "login",
	dashboard: "Dashboard",
	calendar: "Calendar",
	payment: "Payments and invoice",
	settings: "Settings",
	logout: "Logout",
	addhours: "Add hours",
	viewSchedule: "Schedule",
	students: "My students",
	hoursCoached: "Total hours this week",
	accountSettings: "Account settings",
	langselect: "Preferred language",
	english: "English",
	french: "French",
	saveChanges: "Save changes",
	coaches: "My coaches",
	upcomingClasses: "Upcoming classes",
	hoursTrained: "Total hours this week",
	changepw: "Change password",
	confirmNewpw: "Confirm new password",
	admin: "Administrator",
	skateCanClubNumber: "Skate Canada club number",
	clubCoaches: "Coaches",
	clubStudents: "Students",
	clubSchedule: "Club schedule",
	iceHours: "Total ice hours this week"
  },
  
  
  
  fr: {
    login: "Connexion",
    email: "Courriel",
    password: "Mot de passe",
    createAccount: "Créer un compte",
	WelcomeDashboardt: "Bienvenue sur votre tableau de bord",
	accountType: "Type de compte",
	coach: "Entraîneur",
	skaterParent: "Patineur ou parent",
	name: "Prénom",
	lastName: "Nom de famille",
	parentName: "Nom du parent (optionnel)",
	phoneNumber: "Numéro de téléphone",
	skateCan: "Numéro Patinage Canada",
	createpw: "Créer un mot de passe",
	confirmpw: "Confirmation du mot de passe",
	toLogin: "Se connecter ",
	dashboard: "Tableau de bord",
	calendar: "Calendrier",
	payment: "Paiements et facturation",
	settings: "Paramètres",
	logout: "Déconnexion",
	addhours: "Ajouter des heures",
	viewSchedule: "Horaire",
	students: "Mes élèves",
	hoursCoached: "Heures totales cette semaine",
	accountSettings: "Account settings",
	langselect: "Langue préférée",
	english: "Anglais",
	french: "Français",
	saveChanges: "Sauvegarder les changements",
	coaches: "Mes entraîneurs",
	upcomingClasses: "Prochains cours",
	hoursTrained: "Heures totales cette semaine",	
	changepw: "Nouveau mot de passe",
	confirmNewpw: "Confirmation du nouveau mot de passe",
	admin: "Administrateur",
	skateCanClubNumber: "Numéro de club Patinage Canada",
	clubCoaches: "Entraîneurs",
	clubStudents: "Élèves",
	clubSchedule: "Horaire du club",
	iceHours: "Heures de glace cette semaine"
} 
};

export function setLanguage(lang) {
  document.querySelectorAll("[data-key]").forEach(el => {
    const key = el.getAttribute("data-key");
    if (translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });

  document.querySelectorAll("[data-key-placeholder]").forEach(el => {
    const key = el.getAttribute("data-key-placeholder");
    if (translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });
}
