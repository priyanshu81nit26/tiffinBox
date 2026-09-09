# 🍱 Tiffin Tracker

A tiny status-tracking site for 4 friends + 1 tiffin provider. No signup, no
accounts — just a 4-digit PIN each.

- **Friends** mark each meal (breakfast / lunch / dinner) as **Taken** or **Not
  taken**. If taken, the **amount is required**; **items + quantity are
  optional**.
- **Provider** enters how many tiffins went out for each meal, then fills items
  and quantity for Tiffin 1, Tiffin 2, Tiffin 3…
- **Shared dashboard** — everyone can see everyone's day, plus monthly totals
  per person. Read-only: you can only edit your own entries.
- **Any past date** can be picked and filled in later, so a forgotten day is
  easy to fix.

---

## Files

```
index.html          the whole app shell
css/styles.css      styling (mobile-first, dark)
js/config.js        ← THE ONLY FILE YOU NEED TO EDIT
js/store.js         Firestore reads/writes (+ offline demo fallback)
js/app.js           screens and logic
firebase.json       hosting config
firestore.rules     database security rules
```

No build step, no npm, no framework.

---

## Try it right now (demo mode)

Because the app loads as ES modules, double-clicking `index.html` won't work —
it needs to be served. From this folder:

```bash
python -m http.server 8000
```

then open <http://localhost:8000>. Default PINs:

| Person        | PIN  |
|---------------|------|
| Tiffin Service (provider) | `1000` |
| Priyanshu     | `1111` |
| Friend 2      | `2222` |
| Friend 3      | `3333` |
| Friend 4      | `4444` |

In demo mode data is saved only in that one browser — the dashboard won't
actually be shared. Do the Firebase setup below to make it real.

---

## Setup: make it sync across all 5 phones (~10 minutes)

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** (name it
   anything, e.g. `tiffin-tracker`). Google Analytics: off.
2. In the left menu: **Build → Firestore Database → Create database**.
   Pick **Production mode** and a region near you (`asia-south1` for India).

### 2. Get your config

1. Click the ⚙ gear → **Project settings**.
2. Scroll to **Your apps** → click the **Web** icon `</>`.
3. Nickname it anything, **don't** tick Firebase Hosting yet → **Register app**.
4. Copy the `firebaseConfig` values into `js/config.js`.

It should end up looking like:

```js
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "tiffin-tracker.firebaseapp.com",
  projectId: "tiffin-tracker",
  storageBucket: "tiffin-tracker.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:1234:web:abcd",
};
```

While you're in `config.js`, also change the four `name` fields in
`DEFAULT_USERS` to your friends' real names, and the starting PINs if you want.
Those defaults are written to the database **only on the very first load** —
after that, edit names and PINs inside the app under **Settings**.

### 3. Publish the security rules

In the Firebase console: **Firestore Database → Rules** tab → paste the contents
of `firestore.rules` → **Publish**.

### 4. Put it online

Install the CLI once (needs Node.js):

```bash
npm install -g firebase-tools
firebase login
```

Then from this folder:

```bash
firebase use --add        # pick your project, alias it "default"
firebase deploy
```

You'll get a URL like `https://tiffin-tracker.web.app`. Share it with the four
of you and the provider. On a phone: open it in Chrome → menu → **Add to Home
screen**, and it behaves like an app.

> Prefer not to install anything? Netlify Drop (<https://app.netlify.com/drop>)
> also works — just drag this folder in. Firebase still stores the data; only
> the hosting differs.

---

## Day-to-day use

- Open the URL, punch in your PIN. It remembers you on that phone until you log
  out.
- Everyone should change their PIN once from **Settings → Change PIN**. All five
  PINs must be different, and there's no recovery — write it down.
- Forgot to log Tuesday? Pick Tuesday in the date box and fill it in.
- **Dashboard → Month** is the settle-up view: meals taken and total spent per
  person for the month.

## A note on security

There's no login system, by design — you asked for none. That means the database
rules can't check *who* is writing, only *what shape* the data is. They lock the
project to these two collections, enforce the fields, and block deletes, so a
stranger can't wreck your history. But treat the hosting URL as semi-private,
and don't put anything sensitive in here. For 5 people tracking tiffins, that's
a fine trade.

## Adding a 5th friend later

Add another entry to `DEFAULT_USERS` in `config.js` **and** create the matching
document by hand in Firestore (**users** collection, doc ID `f5`, fields:
`name`, `role: "friend"`, `pin`, `isDefaultPin: true`, `order: 5`) — the seeding
only runs when the collection is completely empty.
