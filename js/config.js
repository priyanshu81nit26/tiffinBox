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
  apiKey: "AIzaSyAp3zYsDyIhhcTQQlD-Vt5VlWKXHZg9Dwg",
  authDomain: "district-966f3.firebaseapp.com",
  projectId: "district-966f3",
  storageBucket: "district-966f3.firebasestorage.app",
  messagingSenderId: "156168593291",
  appId: "1:156168593291:web:d3086fdbe29e44b9c0d98e",
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

// `cutoff` is the hour (24h clock) after which that meal can no longer be
// ordered for today — breakfast closes at 11:00, lunch at 16:00, dinner at
// 22:00. Adhoc uses 24, i.e. open all day. Everything reopens next morning.
export const MEALS = [
  { key: "breakfast", label: "Breakfast", icon: "☀", cutoff: 11, defaultTime: "08:30" },
  { key: "lunch", label: "Lunch", icon: "◑", cutoff: 16, defaultTime: "13:00" },
  { key: "dinner", label: "Dinner", icon: "☽", cutoff: 22, defaultTime: "20:30" },
  { key: "adhoc", label: "Adhoc", icon: "⚡", cutoff: 24, defaultTime: "" },
];

// ---- 4. MENU + PRICES -----------------------------------------------------
// One tap adds the line AND its price. Anything not on this list can still be
// typed in by hand — the amount just stays editable.
export const MENU_PRICES = [
  { name: "Full Tiffin", price: 90 },
  { name: "Half Tiffin", price: 50 },
  { name: "5 Roti + Sabzi", price: 58 },
  { name: "4 Roti + Sabzi", price: 50 },
  { name: "2 Roti + Sabzi", price: 30 },
];

// How long after placing an order the customer can still take it back.
export const REVOKE_MINUTES = 15;
