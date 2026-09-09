// ============================================================
//  Storage layer.
//  Uses Firebase Firestore when config.js is filled in,
//  otherwise falls back to this browser's localStorage (demo mode).
//  The rest of the app never needs to know which one is active.
// ============================================================
import { FIREBASE_CONFIG, DEFAULT_USERS } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

export const Store = {
  mode: "local",     // "firebase" | "local"
  configured: false, // is a Firebase config present in config.js?
  error: null,       // human-readable reason we fell back to local
};

let fb = null; // { db, fns... }

// ---------------------------------------------------------------- init
Store.init = async function () {
  Store.configured = !!(FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.apiKey);
  if (!Store.configured) {
    Store.mode = "local";
    localSeed();
    return Store.mode;
  }
  try {
    const [{ initializeApp }, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp(FIREBASE_CONFIG);
    fb = { db: fs.getFirestore(app), fs };
    Store.mode = "firebase";
    await firebaseSeed();
  } catch (e) {
    console.error("[store] Firebase unavailable, falling back to local mode:", e);
    Store.error = explain(e);
    Store.mode = "local";
    localSeed();
  }
  return Store.mode;
};

/** Turn a Firebase error into something actionable. */
function explain(e) {
  const code = e && (e.code || "");
  const msg = (e && e.message) || String(e);
  if (code.includes("permission-denied") || /Missing or insufficient permissions/i.test(msg))
    return "Firestore rejected the request (permission denied). Your security rules are still blocking access — publish the contents of firestore.rules in the Firebase console under Firestore Database → Rules.";
  if (code.includes("unavailable") || /offline|network/i.test(msg))
    return "Couldn't reach Firestore. Check your internet connection, and that the Firestore database has actually been created for this project.";
  if (code.includes("not-found") || /database.*does not exist/i.test(msg))
    return "That project has no Firestore database yet. Create one in the Firebase console (Firestore Database → Create database).";
  if (code.includes("invalid-api-key") || /api-key/i.test(msg))
    return "The Firebase apiKey in js/config.js was rejected. Re-copy the config from Project settings → Your apps.";
  return msg;
}

// ---------------------------------------------------------------- helpers
export const entryId = (date, userId) => `${date}__${userId}`;

function blankEntry(date, userId, role) {
  return {
    date,
    userId,
    role,
    breakfast: null,
    lunch: null,
    dinner: null,
  };
}

// ================================================================
//  FIREBASE ADAPTER
// ================================================================
async function firebaseSeed() {
  const { fs, db } = fb;
  const snap = await fs.getDocs(fs.collection(db, "users"));
  if (!snap.empty) return;
  await Promise.all(
    DEFAULT_USERS.map((u) =>
      fs.setDoc(fs.doc(db, "users", u.id), {
        name: u.name,
        role: u.role,
        pin: u.pin,
        isDefaultPin: true,
        order: DEFAULT_USERS.indexOf(u),
      })
    )
  );
}

// ================================================================
//  LOCAL ADAPTER
// ================================================================
const LS_KEY = "tiffin_local_db_v1";
const localListeners = new Set();

function localRead() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || { users: {}, entries: {} };
  } catch {
    return { users: {}, entries: {} };
  }
}
function localWrite(db) {
  localStorage.setItem(LS_KEY, JSON.stringify(db));
  localListeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  });
}
function localSeed() {
  const db = localRead();
  if (Object.keys(db.users).length) return;
  DEFAULT_USERS.forEach((u, i) => {
    db.users[u.id] = {
      name: u.name,
      role: u.role,
      pin: u.pin,
      isDefaultPin: true,
      order: i,
    };
  });
  localWrite(db);
}
window.addEventListener("storage", (e) => {
  if (e.key === LS_KEY) localListeners.forEach((fn) => fn());
});

// ================================================================
//  PUBLIC API
// ================================================================

/** Live list of all users. cb(users[]) . Returns unsubscribe fn. */
Store.onUsers = function (cb) {
  if (Store.mode === "firebase") {
    const { fs, db } = fb;
    return fs.onSnapshot(fs.collection(db, "users"), (snap) => {
      const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      users.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      cb(users);
    });
  }
  const emit = () => {
    const db = localRead();
    const users = Object.entries(db.users).map(([id, u]) => ({ id, ...u }));
    users.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    cb(users);
  };
  localListeners.add(emit);
  emit();
  return () => localListeners.delete(emit);
};

/** Patch a user document (name / pin / isDefaultPin). */
Store.updateUser = async function (userId, patch) {
  if (Store.mode === "firebase") {
    const { fs, db } = fb;
    await fs.updateDoc(fs.doc(db, "users", userId), patch);
    return;
  }
  const db = localRead();
  db.users[userId] = { ...db.users[userId], ...patch };
  localWrite(db);
};

/**
 * Live entries between two dates (inclusive, YYYY-MM-DD strings).
 * cb(map) where map is { "<date>__<userId>": entry }.
 * Returns unsubscribe fn.
 */
Store.onEntries = function (fromDate, toDate, cb) {
  if (Store.mode === "firebase") {
    const { fs, db } = fb;
    const q = fs.query(
      fs.collection(db, "entries"),
      fs.where("date", ">=", fromDate),
      fs.where("date", "<=", toDate)
    );
    return fs.onSnapshot(
      q,
      (snap) => {
        const map = {};
        snap.docs.forEach((d) => (map[d.id] = { id: d.id, ...d.data() }));
        cb(map);
      },
      (err) => console.error("[store] entries listener:", err)
    );
  }
  const emit = () => {
    const db = localRead();
    const map = {};
    Object.entries(db.entries).forEach(([id, e]) => {
      if (e.date >= fromDate && e.date <= toDate) map[id] = { id, ...e };
    });
    cb(map);
  };
  localListeners.add(emit);
  emit();
  return () => localListeners.delete(emit);
};

/**
 * Save one meal for one person on one date.
 * meal = "breakfast" | "lunch" | "dinner"
 * data = friend  : { taken: bool, amount: number, items: [{name, qty}] }
 *        provider: { count: number, tiffins: [{ items: [{name, qty}] }] }
 * Pass data = null to clear that meal.
 */
Store.saveMeal = async function (date, userId, role, meal, data) {
  const id = entryId(date, userId);
  if (Store.mode === "firebase") {
    const { fs, db } = fb;
    await fs.setDoc(
      fs.doc(db, "entries", id),
      {
        ...blankEntryDefaults(date, userId, role),
        [meal]: data,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    return;
  }
  const db = localRead();
  const prev = db.entries[id] || blankEntry(date, userId, role);
  db.entries[id] = { ...prev, date, userId, role, [meal]: data, updatedAt: Date.now() };
  localWrite(db);
};

function blankEntryDefaults(date, userId, role) {
  return { date, userId, role };
}

/** Wipe demo data (local mode only). */
Store.resetLocal = function () {
  localStorage.removeItem(LS_KEY);
  localSeed();
};
