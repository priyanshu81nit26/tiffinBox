// ============================================================
//  Tiffin Tracker — UI
// ============================================================
import { Store } from "./store.js";
import { CURRENCY, MEALS, MENU_PRICES, REVOKE_MINUTES } from "./config.js";

const SESSION_KEY = "tiffin_session";
const TABS = ["entry", "dash", "settings"]; // left → right order of the swipe carousel
const app = document.getElementById("app");

const priceOf = (name) => {
  const hit = MENU_PRICES.find((p) => p.name.toLowerCase() === String(name || "").trim().toLowerCase());
  return hit ? hit.price : null;
};

// Fixed consumer profile picker — these 4 labels never change even if the
// underlying user's display name is edited later in Settings.
const CONSUMER_PROFILES = [
  { id: "f1", label: "Billu" },
  { id: "f2", label: "DolanDARA" },
  { id: "f3", label: "Gupichand" },
  { id: "f4", label: "cheenuPrasad" },
];

// A safely-early lower bound for the "give me everything" queries behind
// Bills / History — cheap even on Firestore since range queries jump
// straight to the first real match rather than scanning from here.
const EARLIEST_DATE = "2020-01-01";

// ---------------------------------------------------------------- state
const state = {
  users: [],
  entries: {},
  me: null,
  authStage: "role",   // "role" | "who" | "pin" — only used while logged out
  authRole: null,      // "provider" | "friend" — chosen on the role screen
  authUserId: null,    // fixed profile id chosen on the "who" screen (friend flow)
  authLabel: null,     // fixed label for that profile (never the editable name)
  tab: "entry",
  date: todayStr(),
  dashMode: "day",
  draft: null,
  draftDate: null,
  rangeFrom: null,
  rangeTo: null,
  entriesReady: false,
  unsubEntries: null,

  // hamburger menu: Bills / History (lifetime data, independent of the
  // month-scoped `entries` above)
  overlay: null,        // null | "bills" | "history" | "order"
  orderMeal: null,      // which meal slot the order overlay is showing
  orderDate: null,      // which day that slot belongs to (today or tomorrow)
  orderDraft: null,     // in-progress order form state
  rejecting: null,      // supplier is typing a rejection reason: {userId, meal, text}
  historyMeal: null,    // null | "breakfast" | "lunch" | "dinner" | "adhoc"
  historyFrom: null,    // yyyy-mm-dd — reset to null to recompute the default
  historyTo: null,      // yyyy-mm-dd
  allEntries: {},
  allEntriesReady: false,
  unsubAll: null,
};

let mounted = null;     // DOM refs for the logged-in shell, once built
let authRendered = false;
let heightObserver = null; // keeps .tabs-viewport exactly as tall as the active tab
let tickTimer = null;      // 1s ticker for the live cancellation countdown
let clockTimer = null;     // watches for a meal's cutoff passing while the page is open

let slotTimer = null;      // ticks the "cancellable for m:ss" labels on My Meals
let slotCountdowns = [];   // { node, order } pairs the ticker keeps current

function startTick(fn) {
  stopTick();
  tickTimer = setInterval(fn, 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/** Keeps every visible countdown honest without redrawing the whole panel. */
function runSlotCountdowns() {
  if (slotTimer) { clearInterval(slotTimer); slotTimer = null; }
  if (!slotCountdowns.length) return;
  const paint = () => {
    let live = 0;
    slotCountdowns.forEach(({ node, order }) => {
      const ms = revokeLeftMs(order);
      if (ms > 0) { node.textContent = `Cancellable for ${fmtLeft(ms)}`; live += 1; }
      else node.textContent = "Waiting for the supplier";
    });
    if (!live) { clearInterval(slotTimer); slotTimer = null; }
  };
  paint();
  slotTimer = setInterval(paint, 1000);
}

// ---------------------------------------------------------------- utils
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  kids.flat(9).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  });
  return n;
}
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDayPlain(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}
function fmtDate(s) {
  return fmtDayPlain(s) + (s === todayStr() ? " · Today" : "");
}
function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + n));
}
const tomorrowStr = () => addDays(todayStr(), 1);
/** The two days you can order for: today, and tonight-for-tomorrow. */
const ORDER_DAYS = () => [todayStr(), tomorrowStr()];
function monthBounds(s) {
  const [y, m] = s.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${s.slice(0, 7)}-01`, `${s.slice(0, 7)}-${String(last).padStart(2, "0")}`];
}
function monthLabel(s) {
  const [y, m] = s.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
const money = (n) => CURRENCY + Number(n || 0).toLocaleString("en-IN");
const getEntry = (date, uid) => state.entries[`${date}__${uid}`] || null;
const friends = () => state.users.filter((u) => u.role === "friend");
const provider = () => state.users.find((u) => u.role === "provider");
const itemsText = (items) =>
  (items || []).filter((i) => i.name).map((i) => `${i.name} ×${i.qty || 1}`).join(", ");
const loadingBlock = () => h("div", { class: "empty" }, "Loading…");

// ---------------------------------------------------------------- orders
const mealDef = (key) => MEALS.find((m) => m.key === key);

/** Is this meal still orderable right now? Adhoc (cutoff 24) always is. */
function mealOpen(meal, now = new Date()) {
  return now.getHours() + now.getMinutes() / 60 < meal.cutoff;
}

/** Every field is always written, so Firestore's deep merge can't leave stale keys behind. */
function makeOrder({ items, amount, address, expectedTime, placedAt, status, reason, decidedAt }) {
  const st = status || "placed";
  return {
    taken: st !== "rejected",   // keeps dashboard/bills money math working untouched
    placed: true,
    status: st,
    placedAt: placedAt || Date.now(),
    decidedAt: decidedAt || 0,
    items: (items || []).map((i) => ({ name: String(i.name || "").trim(), qty: Math.max(1, Number(i.qty) || 1) })),
    amount: Number(amount) || 0,
    address: address || "",
    expectedTime: expectedTime || "",
    reason: reason || "",
  };
}

const myOrder = (mealKey, date = todayStr(), uid = state.me && state.me.id) => {
  const e = getEntry(date, uid);
  return (e && e[mealKey]) || null;
};

/**
 * What My Meals should do with one slot on one day.
 * Cutoffs only bite on today — tomorrow's slots are all open, which is the
 * whole point of being able to order tomorrow's breakfast tonight.
 * A rejected order re-opens the slot even past its cutoff, since the supplier
 * turned it down and the customer deserves a fair chance to send a new one.
 */
function slotState(mealKey, date = todayStr()) {
  const meal = mealDef(mealKey);
  const order = myOrder(mealKey, date);
  const future = date > todayStr();
  const live = order && order.status !== "rejected";
  const canOrder = !live && (future || mealOpen(meal) || (order && order.status === "rejected"));
  return { meal, order, canOrder, date, visible: canOrder || !!order };
}

const revokeLeftMs = (order) =>
  order && order.status === "placed" ? order.placedAt + REVOKE_MINUTES * 60000 - Date.now() : 0;

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}
function fmtTimeStr(t) {
  if (!t) return "";
  const [hh, mm] = t.split(":").map(Number);
  const d = new Date(); d.setHours(hh, mm, 0, 0);
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}
function StatusPill(order) {
  if (!order) return h("span", { class: "pill q" }, "Not ordered");
  if (order.status === "accepted") return h("span", { class: "pill y" }, "Accepted");
  if (order.status === "rejected") return h("span", { class: "pill n" }, "Rejected");
  return h("span", { class: "pill b" }, "Waiting");
}

/** Avatar photo. Friends share one illustration, tinted + ringed per person. */
function Avatar(u, size = "md") {
  const isProv = u.role === "provider";
  const idx = isProv ? "p" : Math.min(4, friends().findIndex((f) => f.id === u.id) + 1) || 1;
  return h("div", { class: `av ${size} av-${idx}` },
    h("img", { src: isProv ? "img/provider.png" : "img/friend.png", alt: u.name, loading: "lazy" }));
}

function toast(msg, bad = false) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  app.appendChild(loadingBlock());
  await Store.init();
  Store.onUsers((users) => {
    state.users = users;

    if (state.me) {
      const fresh = users.find((u) => u.id === state.me.id);
      if (fresh) state.me = fresh;
      mountApp(); // reflect any name/PIN changes; keeps current tab position
      return;
    }

    const saved = users.find((x) => x.id === localStorage.getItem(SESSION_KEY));
    if (saved) {
      state.me = saved; state.tab = "entry";
      mountApp(); ensureRange();
      requestAnimationFrame(() => positionTrack(false));
      return;
    }

    if (!authRendered) { authRendered = true; renderAuth(); }
  });
})();

function ensureRange() {
  let [from, to] = monthBounds(state.date);
  // Tomorrow is orderable, so it must be inside the subscribed window even on
  // the last day of a month.
  if (tomorrowStr() > to && todayStr() <= to) to = tomorrowStr();
  if (from === state.rangeFrom && to === state.rangeTo) {
    refreshEntryPanel(); refreshDashPanel();
    return;
  }
  state.rangeFrom = from; state.rangeTo = to; state.entriesReady = false;
  if (state.unsubEntries) state.unsubEntries();
  state.unsubEntries = Store.onEntries(from, to, (map) => {
    state.entries = map; state.entriesReady = true;
    refreshEntryPanel(); refreshDashPanel();
  });
}
function changeDate(newDate) {
  if (!newDate) return;
  state.date = newDate;
  state.draftDate = null;
  ensureRange();
}

const cloneItems = (items) => (items || []).map((i) => ({ name: i.name || "", qty: i.qty ?? 1 }));

// ---------------------------------------------------------------- logged-out flow
function renderAuth() {
  app.innerHTML = "";
  document.body.classList.add("no-nav");
  if (heightObserver) { heightObserver.disconnect(); heightObserver = null; }
  mounted = null;
  const screen = state.authStage === "pin" ? PinScreen()
    : state.authStage === "who" ? WhoScreen()
    : RoleScreen();
  app.appendChild(screen);
}

function RoleScreen() {
  const pick = (role) => {
    state.authRole = role;
    state.authStage = role === "friend" ? "who" : "pin";
    renderAuth();
  };
  return h("div", { class: "login" },
    h("div", { class: "login-card" },
      h("div", { class: "tiffin-badge" }, h("img", { src: "img/tiffin.jpg", alt: "Tiffin" })),
      h("h1", {}, "Tiffin Tracker"),
      h("p", { class: "tag" }, "Who's opening this?"),
      h("div", { class: "role-grid" },
        h("button", { class: "role-opt", type: "button", onclick: () => pick("provider") },
          h("div", { class: "role-av" }, h("img", { src: "img/provider.png", alt: "" })),
          h("strong", {}, "Tiffin Service"), h("span", {}, "Provider")),
        h("button", { class: "role-opt", type: "button", onclick: () => pick("friend") },
          h("div", { class: "role-av" }, h("img", { src: "img/friend.png", alt: "" })),
          h("strong", {}, "Consumer"), h("span", {}, "Friend")))));
}

function WhoScreen() {
  const pick = (profile) => {
    state.authUserId = profile.id;
    state.authLabel = profile.label;
    state.authStage = "pin";
    renderAuth();
  };
  return h("div", { class: "login" },
    h("div", { class: "login-card" },
      h("div", { style: "text-align:left" },
        h("button", { class: "back-link", type: "button",
          onclick: () => { state.authRole = null; state.authStage = "role"; renderAuth(); } }, "← Change profile")),
      h("div", { class: "tiffin-badge" }, h("img", { src: "img/friend.png", alt: "Consumer" })),
      h("h1", {}, "Who's this?"),
      h("p", { class: "tag" }, "Pick your profile"),
      h("div", { class: "who-grid" },
        CONSUMER_PROFILES.map((p, i) => h("button", { class: `who-opt av-${i + 1}`, type: "button", onclick: () => pick(p) },
          h("div", { class: "role-av" }, h("img", { src: "img/friend.png", alt: "" })),
          h("strong", {}, p.label))))));
}

function PinScreen() {
  let pin = "";
  const candidates = () => state.authRole === "friend"
    ? state.users.filter((u) => u.id === state.authUserId)
    : state.users.filter((u) => u.role === state.authRole);
  const dots = h("div", { class: "pin-dots" }, [0, 1, 2, 3].map(() => h("i")));
  const msg = h("p", { class: "msg" });
  const paint = () => dots.querySelectorAll("i").forEach((el, i) => el.classList.toggle("on", i < pin.length));

  function press(v) {
    msg.textContent = "";
    if (v === "del") pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += v;
    paint();
    if (pin.length === 4) setTimeout(submit, 120);
  }
  function submit() {
    const u = candidates().find((x) => String(x.pin) === pin);
    if (!u) {
      msg.textContent = "Wrong PIN";
      dots.classList.add("shake");
      setTimeout(() => dots.classList.remove("shake"), 400);
      pin = ""; paint(); return;
    }
    state.me = u; state.tab = "entry"; state.draftDate = null;
    localStorage.setItem(SESSION_KEY, u.id);
    mountApp(); ensureRange();
    requestAnimationFrame(() => positionTrack(false));
  }

  const pad = h("div", { class: "keypad" },
    ["1","2","3","4","5","6","7","8","9"].map((k) => h("button", { onclick: () => press(k) }, k)),
    h("button", { class: "fn" }),
    h("button", { onclick: () => press("0") }, "0"),
    h("button", { class: "fn", onclick: () => press("del") }, "⌫"));

  const roleAvatarSrc = state.authRole === "provider" ? "img/provider.png" : "img/friend.png";
  const roleLabel = state.authRole === "provider" ? "Tiffin Service" : state.authLabel || "Consumer";
  const backStage = state.authRole === "provider" ? "role" : "who";

  return h("div", { class: "login" },
    h("div", { class: "login-card" },
      h("div", { style: "text-align:left" },
        h("button", { class: "back-link", type: "button",
          onclick: () => { state.authStage = backStage; renderAuth(); } }, "← Change profile")),
      h("div", { class: "tiffin-badge" }, h("img", { src: roleAvatarSrc, alt: roleLabel })),
      h("h1", {}, "Enter your PIN"),
      h("p", { class: "tag" }, roleLabel),
      dots, pad, msg));
}

// ---------------------------------------------------------------- logged-in shell
function mountApp() {
  app.innerHTML = "";
  document.body.classList.remove("no-nav");

  const mealsInner = h("div", { class: "wrap" }, loadingBlock());
  const dashInner = h("div", { class: "wrap" }, loadingBlock());
  const settingsInner = h("div", { class: "wrap" });

  const viewport = h("div", { class: "tabs-viewport" },
    h("div", { class: "tab-panel" }, mealsInner),
    h("div", { class: "tab-panel" }, dashInner),
    h("div", { class: "tab-panel" }, settingsInner));

  app.appendChild(viewport);
  app.appendChild(HamburgerMenu());

  mounted = { viewport, mealsInner, dashInner, settingsInner };

  state.draftDate = null;
  refreshEntryPanel();
  refreshDashPanel();
  settingsInner.replaceChildren(SettingsScreen());

  positionTrack(false);
  attachScrollSync();

  if (heightObserver) heightObserver.disconnect();
  heightObserver = new ResizeObserver(() => syncHeight(true));
  Array.from(viewport.children).forEach((panel) => heightObserver.observe(panel));
  syncHeight(false);

  if (state.overlay) renderOverlay(); // survives a re-mount triggered by a users/entries update
  startClockWatch();
}

/**
 * Meals close on the clock, so the home screen has to notice a cutoff passing
 * even if nobody touches the app. Only redraws when the visible set changes.
 */
function startClockWatch() {
  if (clockTimer) clearInterval(clockTimer);
  const snapshot = () => MEALS.filter((m) => mealOpen(m)).map((m) => m.key).join(",");
  let last = snapshot();
  clockTimer = setInterval(() => {
    const now = snapshot();
    if (now === last) return;
    last = now;
    refreshEntryPanel();
  }, 30000);
}

// Keeps .tabs-viewport exactly as tall as the tab currently in view, instead
// of always matching the tallest of the three (which left a dead gap below
// shorter tabs like Dashboard/Settings). Re-measured on tab switch and
// whenever the active panel's own content changes size.
function syncHeight(animate) {
  if (!mounted) return;
  const idx = Math.max(0, TABS.indexOf(state.tab));
  const panel = mounted.viewport.children[idx];
  if (!panel) return;
  const target = panel.scrollHeight;
  if (!animate) {
    mounted.viewport.style.transition = "none";
    mounted.viewport.style.height = target + "px";
    void mounted.viewport.offsetHeight; // force reflow so the instant height sticks
    mounted.viewport.style.transition = "";
  } else {
    mounted.viewport.style.height = target + "px";
  }
}

function refreshEntryPanel() {
  if (!mounted || !state.entriesReady) return;
  mounted.mealsInner.replaceChildren(state.me.role === "provider" ? ProviderScreen() : FriendScreen());
  // Keep an open order sheet in sync when the supplier decides on it — but never
  // while it's a form the customer is typing into.
  if (state.overlay === "order") {
    const o = myOrder(state.orderMeal, state.orderDate || todayStr());
    if (o && o.status !== "rejected") renderOverlay();
  }
}
function refreshDashPanel() {
  if (!mounted) return;
  mounted.dashInner.replaceChildren(DashScreen());
}

function positionTrack(animate) {
  if (!mounted) return;
  const idx = TABS.indexOf(state.tab);
  const left = idx * mounted.viewport.clientWidth;
  if (animate) mounted.viewport.scrollTo({ left, behavior: "smooth" });
  else mounted.viewport.scrollLeft = left; // instant + immune to the snap-remeasure that scrollTo(auto) can trigger
}
function goTo(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  positionTrack(true);
  syncHeight(true);
  updateNavActive();
}
function updateNavActive() {
  document.querySelectorAll(".nav button").forEach((btn) =>
    btn.classList.toggle("on", btn.dataset.tab === state.tab));
}
function attachScrollSync() {
  const vp = mounted.viewport;
  let raf = null;
  vp.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const idx = Math.round(vp.scrollLeft / vp.clientWidth);
      const tab = TABS[Math.max(0, Math.min(TABS.length - 1, idx))];
      if (tab !== state.tab) { state.tab = tab; updateNavActive(); syncHeight(true); }
    });
  }, { passive: true });
  window.addEventListener("resize", () => { positionTrack(false); syncHeight(false); });
}

function DateBar() {
  return h("div", { class: "datebar" },
    h("input", { type: "date", value: state.date, max: tomorrowStr(),
      onchange: (e) => changeDate(e.target.value) }),
    h("button", { class: "chip" + (state.date === todayStr() ? " on" : ""),
      onclick: () => changeDate(todayStr()) }, "Today"));
}

// ---------------------------------------------------------------- item editor
/**
 * Item lines for an order. The chips carry the fixed menu price, so one tap
 * adds the line *and* moves the amount — no quantity prompt, no maths.
 */
function ItemsEditor(draft, onChange) {
  const list = draft.items;
  const box = h("div", { class: "items" });

  const linePrice = (it) => {
    const p = priceOf(it.name);
    return p === null ? "—" : money(p * Math.max(1, Number(it.qty) || 1));
  };
  const repaintPrices = () => {
    box.querySelectorAll(".item-row").forEach((row, i) => {
      if (list[i]) row.querySelector(".ip").textContent = linePrice(list[i]);
    });
  };
  const paint = () => {
    box.innerHTML = "";
    list.forEach((it, i) => {
      box.appendChild(h("div", { class: "item-row" },
        h("input", { class: "iname", type: "text", placeholder: "Item name", value: it.name,
          oninput: (e) => { it.name = e.target.value; onChange(); repaintPrices(); } }),
        h("input", { class: "iqty", type: "number", min: "1", step: "1", value: it.qty ?? 1,
          oninput: (e) => { it.qty = e.target.value; onChange(); repaintPrices(); } }),
        h("span", { class: "ip" }, linePrice(it)),
        h("button", { class: "rm", type: "button", title: "Remove",
          onclick: () => { list.splice(i, 1); paint(); onChange(); } }, "×")));
    });
    if (!list.length) box.appendChild(h("p", { class: "note" }, "Nothing added yet — tap something above."));
  };
  paint();

  const chips = h("div", { class: "quick-add-wrap" },
    h("div", { class: "qa-label" }, "Menu"),
    h("div", { class: "quick-add" },
      MENU_PRICES.map((m) => h("button", { class: "qa-chip", type: "button",
        onclick: () => {
          const blank = list.findIndex((it) => !String(it.name).trim());
          if (blank !== -1) list[blank] = { name: m.name, qty: 1 };
          else list.push({ name: m.name, qty: 1 });
          paint(); onChange();
        } },
        h("span", { class: "qa-n" }, m.name),
        h("span", { class: "qa-p" }, money(m.price))))));

  return h("div", {}, chips, box,
    h("button", { class: "add-item", type: "button",
      onclick: () => { list.push({ name: "", qty: 1 }); paint(); onChange(); } }, "+ Add custom item"));
}

const computeAmount = (items) => (items || []).reduce((s, it) => {
  const p = priceOf(it.name);
  return s + (p === null ? 0 : p * Math.max(1, Number(it.qty) || 1));
}, 0);

// ---------------------------------------------------------------- my meals (home)
function FriendScreen() {
  const box = h("div", {});
  slotCountdowns = [];
  box.appendChild(h("h1", { class: "page-title" }, "My Meals"));

  ORDER_DAYS().forEach((date, i) => {
    const slots = MEALS.map((m) => slotState(m.key, date)).filter((s) => s.visible);
    if (!slots.length) return;
    box.appendChild(DayHead(date, i === 1));
    slots.forEach((s) => box.appendChild(MealSlotCard(s)));
  });

  runSlotCountdowns();
  return box;
}

function DayHead(date, isNext) {
  return h("div", { class: "day-head" + (isNext ? " next" : "") },
    h("span", { class: "dh-tag" }, isNext ? "Tomorrow" : "Today"),
    h("span", { class: "dh-date" }, fmtDayPlain(date)));
}

function MealSlotCard(s) {
  const { meal, order, canOrder, date } = s;
  const card = h("button", { class: "card meal-slot", type: "button",
    onclick: () => openOrder(meal.key, date) });

  card.appendChild(h("div", { class: "card-head" },
    h("div", { class: "icon" }, meal.icon),
    h("h2", {}, meal.label),
    h("span", { class: "status" }, StatusPill(order))));

  if (order) {
    card.appendChild(h("div", { class: "slot-line" },
      h("div", { class: "sl-items" }, itemsText(order.items) || "—"),
      h("div", { class: "sl-amt" }, money(order.amount))));
    if (order.status === "rejected") {
      if (order.reason) card.appendChild(h("div", { class: "reject-note" }, "Supplier: " + order.reason));
      card.appendChild(h("div", { class: "sub-items" }, "Tap to send a new order →"));
    } else if (order.status === "placed") {
      const left = revokeLeftMs(order);
      const node = h("div", { class: "sub-items" },
        left > 0 ? `Cancellable for ${fmtLeft(left)}` : "Waiting for the supplier");
      card.appendChild(node);
      if (left > 0) slotCountdowns.push({ node, order });
    }
  } else {
    card.appendChild(h("div", { class: "slot-line" },
      h("div", { class: "sl-items muted" }, canOrder ? "Tap to place an order" : "Closed for today"),
      h("div", { class: "sl-amt faint" }, "›")));
  }
  return card;
}

// ---------------------------------------------------------------- order sheet
function openOrder(mealKey, date = todayStr()) {
  const meal = mealDef(mealKey);
  const existing = myOrder(mealKey, date);
  state.orderMeal = mealKey;
  state.orderDate = date;
  if (!existing || existing.status === "rejected") {
    state.orderDraft = {
      items: existing ? cloneItems(existing.items) : [],
      amount: existing ? existing.amount : 0,
      manual: false,
      address: (existing && existing.address) || state.me.address || "",
      expectedTime: (existing && existing.expectedTime) || meal.defaultTime || "",
    };
  } else {
    state.orderDraft = null;
  }
  state.overlay = "order";
  renderOverlay();
}

function OrderScreen() {
  const meal = mealDef(state.orderMeal);
  const date = state.orderDate || todayStr();
  const order = myOrder(state.orderMeal, date);
  const live = order && order.status !== "rejected";
  const title = meal.label + (date === todayStr() ? "" : " · Tomorrow");
  const { wrap, body } = OverlayShell(title, closeOverlay);
  body.appendChild(live ? PlacedOrderView(meal, order) : OrderForm(meal, order, date));
  return wrap;
}

function PlacedOrderView(meal, order) {
  const box = h("div", {});

  const lines = order.items.map((it) => {
    const p = priceOf(it.name);
    return h("div", { class: "meal-line" },
      h("div", { class: "mb" }, `${it.name} ×${it.qty}`),
      h("div", { class: "mr" }, p === null ? "" : money(p * it.qty)));
  });
  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "icon" }, meal.icon), h("h2", {}, meal.label + " order"),
      h("span", { class: "status" }, StatusPill(order))),
    lines,
    h("div", { class: "meal-line total-line" },
      h("div", { class: "mb" }, h("strong", {}, "Total")),
      h("div", { class: "mr" }, money(order.amount)))));

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Delivery")),
    h("div", { class: "kv" }, h("span", {}, "Address"), h("strong", {}, order.address || "—")),
    h("div", { class: "kv" }, h("span", {}, "Expected"), h("strong", {}, fmtTimeStr(order.expectedTime) || "Any time")),
    h("div", { class: "kv" }, h("span", {}, "Placed at"), h("strong", {}, fmtClock(order.placedAt)))));

  if (order.status === "accepted") {
    box.appendChild(h("div", { class: "banner ok" }, "The supplier accepted this order — it's being prepared."));
    return box;
  }

  const holder = h("div", {});
  const paint = () => {
    const ms = revokeLeftMs(order);
    holder.replaceChildren(ms > 0
      ? h("div", {},
          h("p", { class: "note" }, `You can still take this back for ${fmtLeft(ms)}.`),
          h("div", { class: "actions left" },
            h("button", { class: "btn danger", type: "button", onclick: cancelOrder }, "Cancel order")))
      : h("p", { class: "note" },
          `The ${REVOKE_MINUTES}-minute cancellation window has passed — speak to the supplier directly.`));
  };
  paint();
  if (revokeLeftMs(order) > 0) startTick(paint);
  box.appendChild(holder);
  return box;
}

async function cancelOrder() {
  const mealKey = state.orderMeal;
  await Store.saveMeal(state.orderDate || todayStr(), state.me.id, "friend", mealKey, null);
  closeOverlay();
  toast("Order cancelled");
}

function OrderForm(meal, prev, date) {
  const d = state.orderDraft;
  const box = h("div", {});

  if (prev && prev.status === "rejected") {
    box.appendChild(h("div", { class: "banner bad" },
      h("strong", {}, "The supplier turned this one down"),
      prev.reason ? h("div", { class: "why" }, prev.reason) : null,
      h("div", { class: "sub-items" }, "Change what you need and send it again.")));
  }

  const amountInput = h("input", { type: "number", min: "0", step: "1", inputmode: "decimal",
    placeholder: "0", value: d.amount || "",
    oninput: (e) => { d.manual = true; d.amount = e.target.value; e.target.classList.remove("err"); } });
  const sync = () => {
    if (d.manual) return;
    d.amount = computeAmount(d.items);
    amountInput.value = d.amount || "";
  };
  const editor = ItemsEditor(d, sync);
  sync();

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("div", { class: "icon" }, meal.icon), h("h2", {}, "What do you need?")),
    editor));

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Amount")),
    h("div", { class: "amount-wrap" }, h("span", {}, CURRENCY), amountInput),
    h("div", { class: "actions left" },
      h("button", { class: "btn ghost", type: "button",
        onclick: () => { d.manual = false; sync(); } }, "Reset to menu price"))));

  const addrInput = h("input", { type: "text", value: d.address, maxlength: "160",
    placeholder: "Flat / building / landmark",
    oninput: (e) => { d.address = e.target.value; e.target.classList.remove("err"); } });
  const timeInput = h("input", { class: "narrow", type: "time", value: d.expectedTime,
    oninput: (e) => (d.expectedTime = e.target.value) });
  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Delivery details")),
    h("div", { class: "field" }, h("label", {}, "Full address ", h("span", { class: "req" }, "*")), addrInput),
    h("div", { class: "field" }, h("label", {}, "Expected time"), timeInput)));

  const placeBtn = h("button", { class: "btn", type: "button" }, "Place order");
  placeBtn.onclick = async () => {
    const items = d.items.filter((i) => String(i.name).trim())
      .map((i) => ({ name: i.name.trim(), qty: Math.max(1, Number(i.qty) || 1) }));
    if (!items.length) return toast("Add at least one item", true);
    const amt = Number(d.amount);
    if (!amt || isNaN(amt) || amt <= 0) { amountInput.classList.add("err"); return toast("Amount must be more than 0", true); }
    if (!d.address.trim()) { addrInput.classList.add("err"); addrInput.focus(); return toast("Address is required", true); }
    const reorder = prev && prev.status === "rejected";
    if (date === todayStr() && !mealOpen(meal) && !reorder)
      return toast(meal.label + " has closed for today", true);

    await Store.saveMeal(date, state.me.id, "friend", meal.key,
      makeOrder({ items, amount: amt, address: d.address.trim(), expectedTime: d.expectedTime, status: "placed" }));
    if (d.address.trim() !== (state.me.address || "")) {
      try { await Store.updateUser(state.me.id, { address: d.address.trim() }); } catch (e) { console.warn(e); }
    }
    closeOverlay();
    toast("Order placed");
  };
  box.appendChild(h("div", { class: "actions" }, placeBtn));
  return box;
}

// ---------------------------------------------------------------- supplier: incoming orders
function ProviderScreen() {
  const box = h("div", {});
  box.appendChild(h("h1", { class: "page-title" }, "Orders"));

  let any = false;
  ORDER_DAYS().forEach((date, i) => {
    const section = ProviderDay(date);
    if (!section) return;
    any = true;
    box.appendChild(DayHead(date, i === 1));
    section.forEach((el) => box.appendChild(el));
  });

  if (!any) box.appendChild(h("div", { class: "card empty" }, "No orders have come in yet."));
  return box;
}

/** One day's incoming orders, grouped by meal. Returns null when there are none. */
function ProviderDay(date) {
  let total = 0, count = 0, waiting = 0;
  const blocks = [];

  MEALS.forEach((meal) => {
    const rows = friends()
      .map((u) => ({ u, o: myOrder(meal.key, date, u.id) }))
      .filter((r) => r.o);
    if (!rows.length) return;
    const card = h("div", { class: "card" },
      h("div", { class: "card-head" },
        h("div", { class: "icon" }, meal.icon), h("h2", {}, meal.label),
        h("span", { class: "status" },
          h("span", { class: "pill b" }, `${rows.length} order${rows.length > 1 ? "s" : ""}`))));
    rows.forEach(({ u, o }) => {
      count += 1;
      if (o.status !== "rejected") total += Number(o.amount || 0);
      if (o.status === "placed") waiting += 1;
      card.appendChild(OrderRow(u, meal, o, date));
    });
    blocks.push(card);
  });

  if (!blocks.length) return null;

  const summary = h("div", { class: "card person-block" },
    h("div", { class: "ph" }, Avatar(state.me, "md"),
      h("strong", {}, `${count} order${count === 1 ? "" : "s"}`),
      h("span", { class: "tot" }, money(total))),
    waiting ? h("div", { class: "meal-line", style: "border-top:none;padding:4px 0 0" },
      h("div", { class: "mb", style: "color:var(--muted);font-size:13.5px" },
        `${waiting} waiting on you`)) : null);

  return [summary, ...blocks];
}

function OrderRow(u, meal, o, date) {
  const row = h("div", { class: "order-row" });
  row.appendChild(h("div", { class: "or-head" },
    Avatar(u, "sm"), h("strong", {}, u.name), StatusPill(o),
    h("span", { class: "or-amt" }, money(o.amount))));
  row.appendChild(h("div", { class: "sub-items" }, itemsText(o.items) || "—"));
  row.appendChild(h("div", { class: "sub-items" },
    [o.address || "No address",
     o.expectedTime ? "by " + fmtTimeStr(o.expectedTime) : null,
     "placed " + fmtClock(o.placedAt)].filter(Boolean).join(" · ")));
  if (o.status === "rejected" && o.reason)
    row.appendChild(h("div", { class: "reject-note" }, "You said: " + o.reason));

  const isRejecting = state.rejecting && state.rejecting.userId === u.id
    && state.rejecting.meal === meal.key && state.rejecting.date === date;
  if (isRejecting) {
    const input = h("input", { type: "text", placeholder: "e.g. sabzi finished for today",
      value: state.rejecting.text, oninput: (e) => (state.rejecting.text = e.target.value) });
    row.appendChild(h("div", { class: "field" }, h("label", {}, "Reason (they'll see this)"), input));
    row.appendChild(h("div", { class: "actions left" },
      h("button", { class: "btn danger", type: "button",
        onclick: () => decide(u, meal, date, "rejected", input.value) }, "Send rejection"),
      h("button", { class: "btn ghost", type: "button",
        onclick: () => { state.rejecting = null; refreshEntryPanel(); } }, "Back")));
    setTimeout(() => input.focus(), 0);
  } else if (o.status === "placed") {
    row.appendChild(h("div", { class: "actions left" },
      h("button", { class: "btn", type: "button", onclick: () => decide(u, meal, date, "accepted") }, "Accept"),
      h("button", { class: "btn ghost", type: "button",
        onclick: () => { state.rejecting = { userId: u.id, meal: meal.key, date, text: "" }; refreshEntryPanel(); } }, "Reject")));
  } else if (o.status === "accepted") {
    row.appendChild(h("div", { class: "actions left" },
      h("button", { class: "btn ghost", type: "button",
        onclick: () => { state.rejecting = { userId: u.id, meal: meal.key, date, text: "" }; refreshEntryPanel(); } },
        "Reject after all")));
  }
  return row;
}

async function decide(u, meal, date, status, reason) {
  const text = String(reason || "").trim();
  if (status === "rejected" && !text) return toast("Add a short reason first", true);
  const cur = myOrder(meal.key, date, u.id);
  if (!cur) return;
  // Clear first: saving fires the store listeners synchronously in local mode,
  // which would otherwise redraw this row with the reason form still open.
  state.rejecting = null;
  await Store.saveMeal(date, u.id, "friend", meal.key, makeOrder({
    ...cur, status, decidedAt: Date.now(),
    reason: status === "rejected" ? text : "",
  }));
  refreshEntryPanel();
  toast(status === "accepted" ? "Order accepted" : "Rejection sent");
}

// ---------------------------------------------------------------- dashboard
function DashScreen() {
  const box = h("div", {});
  box.appendChild(h("h1", { class: "page-title" }, "Dashboard"));
  box.appendChild(h("div", { class: "datebar" },
    h("button", { class: "chip" + (state.dashMode === "day" ? " on" : ""),
      onclick: () => { state.dashMode = "day"; refreshDashPanel(); } }, "Day"),
    h("button", { class: "chip" + (state.dashMode === "month" ? " on" : ""),
      onclick: () => { state.dashMode = "month"; refreshDashPanel(); } }, "Month")));
  box.appendChild(DateBar());
  box.appendChild(state.dashMode === "day" ? DayView() : MonthView());
  return box;
}

function DayView() {
  const box = h("div", {});
  let any = false, dayTotal = 0, orders = 0, waiting = 0;

  const people = state.me.role === "provider" ? friends() : [state.me];

  people.forEach((u) => {
    const e = getEntry(state.date, u.id);
    const total = MEALS.reduce((s, m) => s + (e && e[m.key] && e[m.key].taken ? Number(e[m.key].amount || 0) : 0), 0);
    if (e) any = true;
    dayTotal += total;

    const blk = h("div", { class: "card person-block" },
      h("div", { class: "ph" }, Avatar(u, "md"), h("strong", {}, u.name),
        h("span", { class: "tot" }, money(total))));

    MEALS.forEach((m) => {
      const v = e && e[m.key];
      if (v) { orders += 1; if (v.status === "placed") waiting += 1; }
      const mb = h("div", { class: "mb" }, StatusPill(v || null));
      if (v) {
        const txt = itemsText(v.items);
        if (txt) mb.appendChild(h("div", { class: "sub-items" }, txt));
        const meta = [v.expectedTime ? "by " + fmtTimeStr(v.expectedTime) : null,
                      v.status === "rejected" && v.reason ? "“" + v.reason + "”" : null].filter(Boolean).join(" · ");
        if (meta) mb.appendChild(h("div", { class: "sub-items" }, meta));
      }
      blk.appendChild(h("div", { class: "meal-line" },
        h("div", { class: "ml" }, m.label), mb,
        h("div", { class: "mr" }, v && v.taken ? money(v.amount) : "")));
    });
    box.appendChild(blk);
  });

  if (!any) return h("div", { class: "card empty" }, "Nothing ordered on this day.");

  const head = h("div", { class: "card person-block" },
    h("div", { class: "ph" }, h("strong", {}, state.me.role === "provider" ? "All orders" : "Your day"),
      h("span", { class: "tot" }, money(dayTotal))),
    h("div", { class: "meal-line", style: "border-top:none;padding:4px 0 0" },
      h("div", { class: "mb", style: "color:var(--muted);font-size:13.5px" },
        `${orders} order${orders === 1 ? "" : "s"}${waiting ? ` · ${waiting} still waiting` : ""}`)));
  box.insertBefore(head, box.firstChild);
  return box;
}

function MonthView() {
  const [from, to] = monthBounds(state.date);
  const box = h("div", {});
  const rows = [];
  let grand = 0;

  const people = state.me.role === "provider" ? friends() : [state.me];

  people.forEach((u) => {
    const r = { u, counts: MEALS.map(() => 0), total: 0, rejected: 0 };
    Object.values(state.entries).forEach((e) => {
      if (e.userId !== u.id || e.date < from || e.date > to) return;
      MEALS.forEach((m, idx) => {
        const v = e[m.key];
        if (!v) return;
        if (v.status === "rejected") { r.rejected += 1; return; }
        r.counts[idx] += 1;
        r.total += Number(v.amount || 0);
      });
    });
    grand += r.total; rows.push(r);
  });

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, monthLabel(state.date))),
    h("div", { class: "tablewrap" }, h("table", {},
      h("thead", {}, h("tr", {},
        h("th", {}, "Person"),
        MEALS.map((m) => h("th", { class: "num", title: m.label }, m.label[0])),
        h("th", { class: "num" }, "Orders"),
        h("th", { style: "text-align:right" }, "Total"))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { class: "name" }, h("div", { class: "who" }, Avatar(r.u, "sm"), r.u.name)),
        r.counts.map((c) => h("td", { class: "num" }, c)),
        h("td", { class: "num" }, r.counts.reduce((s, c) => s + c, 0)),
        h("td", { class: "amt", style: "text-align:right" }, money(r.total))))),
      h("tfoot", {}, h("tr", {},
        h("td", { colspan: String(MEALS.length + 1) }, "Group total"),
        h("td", { class: "num" }, rows.reduce((s, r) => s + r.counts.reduce((a, c) => a + c, 0), 0)),
        h("td", { class: "amt", style: "text-align:right" }, money(grand))))))));

  return box;
}

// ---------------------------------------------------------------- settings
function SettingsScreen() {
  const box = h("div", {});
  box.appendChild(h("h1", { class: "page-title" }, "Settings"));

  box.appendChild(h("div", { class: "card person-block" },
    h("div", { class: "ph" }, Avatar(state.me, "md"), h("strong", {}, state.me.name))));

  const nameInput = h("input", { type: "text", value: state.me.name, maxlength: "24" });
  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Display name")),
    nameInput,
    h("div", { class: "actions" },
      h("button", { class: "btn ghost", type: "button", onclick: async () => {
        const v = nameInput.value.trim();
        if (!v) return toast("Name can't be empty", true);
        await Store.updateUser(state.me.id, { name: v });
        toast("Name updated");
      } }, "Update name"))));

  if (state.me.role !== "provider") {
    const addrInput = h("input", { type: "text", value: state.me.address || "", maxlength: "160",
      placeholder: "Flat / building / landmark" });
    box.appendChild(h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Delivery address")),
      addrInput,
      h("div", { class: "actions left" },
        h("button", { class: "btn ghost", type: "button", onclick: async () => {
          await Store.updateUser(state.me.id, { address: addrInput.value.trim() });
          toast("Address saved");
        } }, "Save address"))));
  }

  const p1 = h("input", { class: "narrow", type: "tel", inputmode: "numeric", maxlength: "4", placeholder: "New PIN" });
  const p2 = h("input", { class: "narrow", type: "tel", inputmode: "numeric", maxlength: "4", placeholder: "Confirm" });
  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Change PIN")),
    h("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, p1, p2),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: async () => {
        const a = p1.value.trim(), b = p2.value.trim();
        if (!/^\d{4}$/.test(a)) return toast("PIN must be 4 digits", true);
        if (a !== b) return toast("PINs don't match", true);
        if (state.users.some((u) => u.id !== state.me.id && String(u.pin) === a))
          return toast("Someone already uses that PIN", true);
        await Store.updateUser(state.me.id, { pin: a, isDefaultPin: false });
        p1.value = ""; p2.value = "";
        toast("PIN changed");
      } }, "Save new PIN"))));

  box.appendChild(h("div", { class: "actions left" },
    h("button", { class: "btn danger", type: "button", onclick: () => {
      localStorage.removeItem(SESSION_KEY);
      if (state.unsubEntries) { state.unsubEntries(); state.unsubEntries = null; }
      if (state.unsubAll) { state.unsubAll(); state.unsubAll = null; }
      state.me = null; state.draft = null; state.draftDate = null;
      state.rangeFrom = null; state.rangeTo = null; state.entriesReady = false;
      state.authStage = "role"; state.authRole = null;
      state.authUserId = null; state.authLabel = null;
      state.overlay = null; state.historyMeal = null;
      state.historyFrom = null; state.historyTo = null;
      state.allEntries = {}; state.allEntriesReady = false;
      mounted = null;
      renderAuth();
    } }, "Log out")));
  return box;
}

// ---------------------------------------------------------------- hamburger menu
function HamburgerMenu() {
  return h("button", { class: "hamburger-btn", type: "button", "aria-label": "Menu",
    onclick: (e) => { e.stopPropagation(); toggleHamMenu(); } }, "☰");
}
function toggleHamMenu() {
  if (closeHamMenu()) return; // was open, just close it
  const jump = (tab) => { closeHamMenu(); closeOverlay(); goTo(tab); };
  const menu = h("div", { class: "ham-menu" },
    h("button", { type: "button", onclick: () => { closeHamMenu(); openOverlay("bills"); } },
      h("span", { class: "hm-ic" }, "🧾"), "Bills"),
    h("button", { type: "button", onclick: () => { closeHamMenu(); openOverlay("history"); } },
      h("span", { class: "hm-ic" }, "📜"), "History"),
    h("div", { class: "hm-sep" }),
    h("button", { type: "button", onclick: () => jump("dash") },
      h("span", { class: "hm-ic" }, "📊"), "Dashboard"),
    h("button", { type: "button", onclick: () => jump("settings") },
      h("span", { class: "hm-ic" }, "⚙"), "Settings"));
  const backdrop = h("button", { class: "ham-backdrop", type: "button", "aria-label": "Close menu",
    onclick: () => closeHamMenu() });
  app.appendChild(backdrop);
  app.appendChild(menu);
}
/** Removes any open hamburger dropdown. Returns true if one was open. */
function closeHamMenu() {
  const found = document.querySelector(".ham-menu, .ham-backdrop");
  document.querySelectorAll(".ham-menu, .ham-backdrop").forEach((el) => el.remove());
  return !!found;
}

// ---------------------------------------------------------------- Bills / History overlay
/** Lifetime, all-users entry feed backing Bills + History. Loaded once, lazily. */
function ensureAllEntries() {
  if (state.unsubAll) return; // already subscribed (ready or loading)
  state.unsubAll = Store.onEntries(EARLIEST_DATE, todayStr(), (map) => {
    state.allEntries = map;
    state.allEntriesReady = true;
    if (state.overlay) renderOverlay();
  });
}
function openOverlay(kind) {
  state.overlay = kind;
  state.historyMeal = null;
  state.historyFrom = null;
  state.historyTo = null;
  ensureAllEntries();
  renderOverlay();
}
function closeOverlay() {
  stopTick();
  state.overlay = null;
  state.historyMeal = null;
  state.orderMeal = null;
  state.orderDate = null;
  state.orderDraft = null;
  const existing = app.querySelector(".overlay-screen");
  if (existing) existing.remove();
}
function renderOverlay() {
  stopTick();
  const existing = app.querySelector(".overlay-screen");
  if (existing) existing.remove();
  if (!state.overlay) return;
  const screen = state.overlay === "bills" ? BillsScreen()
    : state.overlay === "order" ? OrderScreen()
    : HistoryScreen();
  app.appendChild(screen);
}

/** Sum of everything this user marked "taken", across all recorded history. */
function lifetimeTotal(uid) {
  return Object.values(state.allEntries).reduce((sum, e) => {
    if (e.userId !== uid) return sum;
    return sum + MEALS.reduce((s, m) => s + (e[m.key] && e[m.key].taken ? Number(e[m.key].amount || 0) : 0), 0);
  }, 0);
}
function mealBreakdown(uid) {
  const out = {};
  MEALS.forEach((m) => (out[m.key] = { count: 0, amount: 0 }));
  Object.values(state.allEntries).forEach((e) => {
    if (e.userId !== uid) return;
    MEALS.forEach((m) => {
      const v = e[m.key];
      if (v && v.taken) { out[m.key].count += 1; out[m.key].amount += Number(v.amount || 0); }
    });
  });
  return out;
}
function itemsFromTiffins(tiffins) {
  return (tiffins || [])
    .map((t, i) => { const txt = itemsText(t.items); return txt ? `T${i + 1}: ${txt}` : null; })
    .filter(Boolean).join(" · ");
}

function OverlayShell(title, onBack) {
  const wrap = h("div", { class: "overlay-screen" },
    h("div", { class: "overlay-header" },
      h("button", { class: "ov-back", type: "button", onclick: onBack }, "←"),
      h("h1", { class: "page-title" }, title)));
  const body = h("div", { class: "overlay-body" });
  wrap.appendChild(body);
  return { wrap, body };
}

function BillsScreen() {
  const { wrap, body } = OverlayShell("Bills", closeOverlay);
  if (!state.allEntriesReady) { body.appendChild(loadingBlock()); return wrap; }

  if (state.me.role === "provider") {
    let grand = 0;
    const cards = friends().map((u) => {
      const total = lifetimeTotal(u.id);
      grand += total;
      return h("div", { class: "card person-block" },
        h("div", { class: "ph" }, Avatar(u, "md"), h("strong", {}, u.name), h("span", { class: "tot" }, money(total))));
    });
    body.appendChild(h("div", { class: "card bill-total-card" },
      h("div", { class: "bt-label" }, "Total to collect"),
      h("div", { class: "bt-amt" }, money(grand)),
      h("div", { class: "bt-note" }, "Across all friends, all time")));
    cards.forEach((c) => body.appendChild(c));
  } else {
    const total = lifetimeTotal(state.me.id);
    const br = mealBreakdown(state.me.id);
    body.appendChild(h("div", { class: "card bill-total-card" },
      h("div", { class: "bt-label" }, "Your total"),
      h("div", { class: "bt-amt" }, money(total)),
      h("div", { class: "bt-note" }, "All time, everything marked Taken")));
    body.appendChild(h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "By meal")),
      MEALS.map((m) => h("div", { class: "meal-line" },
        h("div", { class: "ml" }, m.label),
        h("div", { class: "mb" }, `${br[m.key].count} time${br[m.key].count === 1 ? "" : "s"}`),
        h("div", { class: "mr" }, money(br[m.key].amount))))));
  }
  return wrap;
}

function HistoryScreen() {
  const back = () => {
    if (state.historyMeal) { state.historyMeal = null; state.historyFrom = null; state.historyTo = null; renderOverlay(); }
    else closeOverlay();
  };
  const title = state.historyMeal ? MEALS.find((m) => m.key === state.historyMeal).label + " history" : "History";
  const { wrap, body } = OverlayShell(title, back);
  if (!state.allEntriesReady) { body.appendChild(loadingBlock()); return wrap; }

  if (!state.historyMeal) {
    body.appendChild(h("div", { class: "history-meal-grid" },
      MEALS.map((m) => h("button", { class: "history-meal-opt", type: "button",
        onclick: () => { state.historyMeal = m.key; state.historyFrom = null; state.historyTo = null; renderOverlay(); } },
        h("span", { class: "hmi" }, m.icon), h("strong", {}, m.label), h("span", { class: "arrow" }, "›")))));
    return wrap;
  }

  body.appendChild(HistoryList(state.historyMeal));
  return wrap;
}

function HistoryList(mealKey) {
  const box = h("div", {});
  // The supplier's history is everyone's orders; a friend sees only their own.
  const forProvider = state.me.role === "provider";
  const rows = Object.values(state.allEntries)
    .filter((e) => e[mealKey] && (forProvider ? e.userId !== state.me.id : e.userId === state.me.id))
    .sort((a, b) => b.date.localeCompare(a.date) || String(a.userId).localeCompare(String(b.userId)));

  const earliest = rows.length ? rows[rows.length - 1].date : todayStr();
  if (!state.historyFrom) state.historyFrom = earliest;
  if (!state.historyTo) state.historyTo = todayStr();

  const fromInput = h("input", { type: "date", value: state.historyFrom, max: state.historyTo,
    onchange: (e) => { state.historyFrom = e.target.value || earliest; renderOverlay(); } });
  const toInput = h("input", { type: "date", value: state.historyTo, min: state.historyFrom, max: todayStr(),
    onchange: (e) => { state.historyTo = e.target.value || todayStr(); renderOverlay(); } });
  box.appendChild(h("div", { class: "range-bar" },
    h("div", { class: "range-field" }, h("label", {}, "From"), fromInput),
    h("div", { class: "range-field" }, h("label", {}, "To"), toInput)));

  const filtered = rows.filter((e) => e.date >= state.historyFrom && e.date <= state.historyTo);
  if (!filtered.length) {
    box.appendChild(h("div", { class: "card empty" }, "No orders in this range."));
    return box;
  }

  const total = filtered.reduce((s, e) => s + (e[mealKey].taken ? Number(e[mealKey].amount || 0) : 0), 0);
  box.appendChild(h("p", { class: "note" },
    `${filtered.length} order${filtered.length === 1 ? "" : "s"} · ${money(total)}`));

  filtered.forEach((e) => {
    const v = e[mealKey];
    const who = forProvider ? state.users.find((u) => u.id === e.userId) : null;
    const row = h("div", { class: "card history-row" },
      h("div", { class: "hr-date" }, fmtDate(e.date)));
    const mb = h("div", { class: "mb" }, StatusPill(v));
    const txt = itemsText(v.items);
    if (txt) mb.appendChild(h("div", { class: "sub-items" }, txt));
    if (v.status === "rejected" && v.reason) mb.appendChild(h("div", { class: "sub-items" }, "\u201C" + v.reason + "\u201D"));
    row.appendChild(h("div", { class: "meal-line", style: "border-top:none;padding-top:0" },
      who ? h("div", { class: "ml" }, who.name) : null, mb,
      h("div", { class: "mr" }, v.taken ? money(v.amount) : "")));
    box.appendChild(row);
  });
  return box;
}
