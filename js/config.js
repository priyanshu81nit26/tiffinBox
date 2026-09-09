// ============================================================
//  EDIT THIS FILE — everything you need to configure is here.
// ============================================================

// ---- 1. FIREBASE ----------------------------------------------------------
// Paste your Firebase web-app config below.
// Until you do, the app runs in DEMO MODE (data stays only in this browser).
//
// How to get it:  console.firebase.google.com  ->  Add project  ->
//   Build > Firestore Database > Create database (Production mode)  ->
//   Project settings (gear) > Your apps > Web (</>) > register app  ->
//   copy the firebaseConfig object here.
//
export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// ---- 2. PEOPLE + STARTING PINS -------------------------------------------
// These are written to the database ONCE, the first time the app loads.
// After that, edit names/PINs from inside the app (Settings), not here.
// PINs must be 4 digits and all different.
export const DEFAULT_USERS = [
  { id: "provider", name: "Tiffin Service", role: "provider", pin: "1000" },
  { id: "f1", name: "Priyanshu", role: "friend", pin: "1111" },
  { id: "f2", name: "Friend 2", role: "friend", pin: "2222" },
  { id: "f3", name: "Friend 3", role: "friend", pin: "3333" },
  { id: "f4", name: "Friend 4", role: "friend", pin: "4444" },
];

// ---- 3. MISC --------------------------------------------------------------
export const CURRENCY = "₹"; // rupee symbol
export const MEALS = [
  { key: "breakfast", label: "Breakfast", icon: "☀" },
  { key: "lunch", label: "Lunch", icon: "◑" },
  { key: "dinner", label: "Dinner", icon: "☽" },
];
