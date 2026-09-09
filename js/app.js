// ============================================================
//  Tiffin Tracker — UI
// ============================================================
import { Store } from "./store.js";
import { CURRENCY, MEALS } from "./config.js";

const SESSION_KEY = "tiffin_session";
const TABS = ["entry", "dash", "settings"]; // left → right order of the swipe carousel
const app = document.getElementById("app");

// The handful of orders that make up most days — one tap adds the line,
// no quantity prompt. Shown to both friends (what was in their tiffin)
// and the provider (what went into each tiffin).
const QUICK_ITEMS = ["Full Tiffin", "Half Tiffin", "5 Roti + Sabzi", "4 Roti + Sabzi", "2 Roti + Sabzi"];

// Fixed consumer profile picker — these 4 labels never change even if the
// underlying user's display name is edited later in Settings.
const CONSUMER_PROFILES = [
  { id: "f1", label: "Billu" },
  { id: "f2", label: "DolanDARA" },
  { id: "f3", label: "Gupichand" },
  { id: "f4", label: "cheenuPrasad" },
];

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
};

let mounted = null;     // DOM refs for the logged-in shell, once built
let authRendered = false;
let heightObserver = null; // keeps .tabs-viewport exactly as tall as the active tab

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
function fmtDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  let out = dt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  if (s === todayStr()) out += " · Today";
  return out;
}
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
      state.me = saved; state.tab = "dash";
      mountApp(); ensureRange();
      requestAnimationFrame(() => positionTrack(false));
      return;
    }

    if (!authRendered) { authRendered = true; renderAuth(); }
  });
})();

function ensureRange() {
  const [from, to] = monthBounds(state.date);
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

// ---------------------------------------------------------------- draft
function buildDraft() {
  const e = getEntry(state.date, state.me.id);
  const d = {};
  MEALS.forEach(({ key }) => {
    const m = e && e[key];
    if (state.me.role === "provider") {
      d[key] = m
        ? { count: m.count ?? 0, tiffins: (m.tiffins || []).map((t) => ({ items: cloneItems(t.items) })) }
        : { count: 0, tiffins: [] };
    } else {
      d[key] = m
        ? { status: m.taken ? "taken" : "skipped", amount: m.amount ?? "", items: cloneItems(m.items) }
        : { status: null, amount: "", items: [] };
    }
  });
  state.draft = d; state.draftDate = state.date;
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
    state.me = u; state.tab = "dash"; state.draftDate = null;
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
  app.appendChild(NavBar());

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
  if (state.draftDate === state.date) return; // keep any in-progress typing intact
  buildDraft();
  mounted.mealsInner.replaceChildren(state.me.role === "provider" ? ProviderScreen() : FriendScreen());
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

function NavBar() {
  const tabs = [
    { id: "entry", icon: state.me.role === "provider" ? "🍱" : "🍽", label: state.me.role === "provider" ? "Tiffins" : "Meals" },
    { id: "dash", icon: "📊", label: "Dashboard" },
    { id: "settings", icon: "⚙", label: "Settings" },
  ];
  return h("nav", { class: "nav" },
    tabs.map((t) => h("button", {
      class: state.tab === t.id ? "on" : "", "data-tab": t.id,
      onclick: () => goTo(t.id),
    }, h("span", { class: "ni" }, t.icon), h("span", { class: "lb" }, t.label))));
}

function DateBar() {
  return h("div", { class: "datebar" },
    h("input", { type: "date", value: state.date, max: todayStr(),
      onchange: (e) => changeDate(e.target.value) }),
    h("button", { class: "chip" + (state.date === todayStr() ? " on" : ""),
      onclick: () => changeDate(todayStr()) }, "Today"));
}

// ---------------------------------------------------------------- item editor
function ItemsEditor(list, quickAdds) {
  const box = h("div", { class: "items" });
  const paint = () => {
    box.innerHTML = "";
    list.forEach((it, i) => {
      box.appendChild(h("div", { class: "item-row" },
        h("input", { class: "iname", type: "text", placeholder: "Item name", value: it.name,
          oninput: (e) => (it.name = e.target.value) }),
        h("input", { class: "iqty", type: "number", min: "1", step: "1", placeholder: "Qty", value: it.qty ?? 1,
          oninput: (e) => (it.qty = e.target.value) }),
        h("button", { class: "rm", type: "button", title: "Remove",
          onclick: () => { list.splice(i, 1); paint(); } }, "×")));
    });
    if (!list.length) box.appendChild(h("p", { class: "note" }, "No items added."));
  };
  paint();
  const quickRow = quickAdds ? h("div", { class: "quick-add-wrap" },
    h("div", { class: "qa-label" }, "Quick add"),
    h("div", { class: "quick-add" },
      quickAdds.map((label) => h("button", { class: "qa-chip", type: "button",
        onclick: () => {
          const blank = list.findIndex((it) => !it.name.trim());
          if (blank !== -1) list[blank] = { name: label, qty: 1 };
          else list.push({ name: label, qty: 1 });
          paint();
        } }, label)))
  ) : null;
  return h("div", {}, quickRow, box,
    h("button", { class: "add-item", type: "button",
      onclick: () => { list.push({ name: "", qty: 1 }); paint(); } }, "+ Add item"));
}

// ---------------------------------------------------------------- friend screen
function FriendScreen() {
  if (!state.draft) return loadingBlock();
  const box = h("div", {});
  box.appendChild(h("h1", { class: "page-title" }, "My Meals"));
  box.appendChild(DateBar());
  box.appendChild(h("p", { class: "note" }, fmtDate(state.date)));
  MEALS.forEach((meal) => box.appendChild(FriendMealCard(meal)));
  return box;
}

function FriendMealCard(meal) {
  const d = state.draft[meal.key];
  const card = h("div", { class: "card" });
  const statusEl = h("span", { class: "status" });
  const yes = h("button", { type: "button" }, "Taken");
  const no = h("button", { type: "button" }, "Not taken");

  const amountInput = h("input", { type: "number", min: "0", step: "1", inputmode: "decimal",
    placeholder: "0", value: d.amount, oninput: (e) => (d.amount = e.target.value) });
  const amountField = h("div", { class: "field" },
    h("label", {}, "Amount ", h("span", { class: "req" }, "*")),
    h("div", { class: "amount-wrap" }, h("span", {}, CURRENCY), amountInput));
  const itemsField = h("div", { class: "field" },
    h("label", {}, "Items ", h("span", { class: "opt" }, "(optional)")),
    ItemsEditor(d.items, QUICK_ITEMS));
  const saveBtn = h("button", { class: "btn", type: "button" }, "Save");
  const actions = h("div", { class: "actions" }, saveBtn);

  function paintToggle() {
    yes.className = d.status === "taken" ? "on-y" : "";
    no.className = d.status === "skipped" ? "on-n" : "";
    const show = d.status === "taken";
    amountField.classList.toggle("hide", !show);
    itemsField.classList.toggle("hide", !show);
    actions.classList.toggle("hide", d.status === null);
    statusEl.replaceChildren(
      d.status === "taken" ? h("span", { class: "pill y" }, "Taken")
      : d.status === "skipped" ? h("span", { class: "pill n" }, "Not taken")
      : h("span", { class: "pill q" }, "Not filled"));
  }
  yes.onclick = () => {
    d.status = "taken";
    if (!d.items.length) { d.items.push({ name: "", qty: 1 }); rebuildItems(); }
    paintToggle();
  };
  no.onclick = () => { d.status = "skipped"; paintToggle(); };
  function rebuildItems() { itemsField.replaceChild(ItemsEditor(d.items, QUICK_ITEMS), itemsField.lastChild); }

  saveBtn.onclick = async () => {
    if (d.status === "taken") {
      const amt = Number(d.amount);
      if (!d.amount || isNaN(amt) || amt <= 0) {
        amountInput.classList.add("err"); amountInput.focus();
        toast("Amount is required", true); return;
      }
      amountInput.classList.remove("err");
      const items = d.items.filter((i) => i.name.trim())
        .map((i) => ({ name: i.name.trim(), qty: Math.max(1, Number(i.qty) || 1) }));
      await Store.saveMeal(state.date, state.me.id, "friend", meal.key, { taken: true, amount: amt, items });
    } else {
      await Store.saveMeal(state.date, state.me.id, "friend", meal.key, { taken: false, amount: 0, items: [] });
    }
    saveBtn.textContent = "Saved ✓"; saveBtn.classList.add("saved");
    setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.classList.remove("saved"); }, 1500);
    toast(meal.label + " saved");
  };

  card.appendChild(h("div", { class: "card-head" },
    h("div", { class: "icon" }, meal.icon), h("h2", {}, meal.label), statusEl));
  card.appendChild(h("div", { class: "seg" }, yes, no));
  card.appendChild(amountField);
  card.appendChild(itemsField);
  card.appendChild(actions);
  paintToggle();
  return card;
}

// ---------------------------------------------------------------- provider screen
function ProviderScreen() {
  if (!state.draft) return loadingBlock();
  const box = h("div", {});
  box.appendChild(h("h1", { class: "page-title" }, "Tiffins"));
  box.appendChild(DateBar());
  box.appendChild(h("p", { class: "note" }, fmtDate(state.date)));
  MEALS.forEach((meal) => box.appendChild(ProviderMealCard(meal)));
  return box;
}

function ProviderMealCard(meal) {
  const d = state.draft[meal.key];
  const card = h("div", { class: "card" });
  const statusEl = h("span", { class: "status" });
  const tiffinBox = h("div", {});

  const countInput = h("input", { class: "narrow", type: "number", min: "0", max: "20", step: "1",
    inputmode: "numeric", placeholder: "0", value: d.count || "",
    oninput: (e) => setCount(e.target.value) });

  function setCount(v) {
    const n = Math.max(0, Math.min(20, Number(v) || 0));
    d.count = n;
    while (d.tiffins.length < n) d.tiffins.push({ items: [{ name: "", qty: 1 }] });
    if (d.tiffins.length > n) d.tiffins.length = n;
    paintTiffins();
  }
  function paintTiffins() {
    tiffinBox.innerHTML = "";
    d.tiffins.forEach((t, i) =>
      tiffinBox.appendChild(h("div", { class: "tiffin" },
        h("h3", {}, `Tiffin ${i + 1}`), ItemsEditor(t.items, QUICK_ITEMS))));
    statusEl.replaceChildren(d.count
      ? h("span", { class: "pill b" }, `${d.count} tiffin${d.count > 1 ? "s" : ""}`)
      : h("span", { class: "pill q" }, "Not filled"));
  }

  const saveBtn = h("button", { class: "btn", type: "button" }, "Save");
  saveBtn.onclick = async () => {
    const tiffins = d.tiffins.map((t) => ({
      items: t.items.filter((i) => i.name.trim())
        .map((i) => ({ name: i.name.trim(), qty: Math.max(1, Number(i.qty) || 1) })) }));
    await Store.saveMeal(state.date, state.me.id, "provider", meal.key, { count: d.count || 0, tiffins });
    saveBtn.textContent = "Saved ✓"; saveBtn.classList.add("saved");
    setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.classList.remove("saved"); }, 1500);
    toast(meal.label + " saved");
  };

  card.appendChild(h("div", { class: "card-head" },
    h("div", { class: "icon" }, meal.icon), h("h2", {}, meal.label), statusEl));
  card.appendChild(h("div", { class: "field" }, h("label", {}, "How many tiffins?"), countInput));
  card.appendChild(tiffinBox);
  card.appendChild(h("div", { class: "actions" }, saveBtn));
  paintTiffins();
  return card;
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
  box.appendChild(h("p", { class: "note" },
    state.dashMode === "day" ? fmtDate(state.date) : monthLabel(state.date)));
  box.appendChild(state.dashMode === "day" ? DayView() : MonthView());
  return box;
}

function DayView() {
  const box = h("div", {});
  let any = false;

  friends().forEach((u) => {
    const e = getEntry(state.date, u.id);
    const total = MEALS.reduce((s, m) => s + (e && e[m.key]?.taken ? Number(e[m.key].amount || 0) : 0), 0);
    if (e) any = true;
    const blk = h("div", { class: "card person-block" },
      h("div", { class: "ph" }, Avatar(u, "md"), h("strong", {}, u.name),
        h("span", { class: "tot" }, money(total))));
    MEALS.forEach((m) => {
      const v = e && e[m.key];
      const pill = !v ? h("span", { class: "pill q" }, "—")
        : v.taken ? h("span", { class: "pill y" }, "Taken")
        : h("span", { class: "pill n" }, "Not taken");
      const txt = v && v.taken && itemsText(v.items);
      blk.appendChild(h("div", { class: "meal-line" },
        h("div", { class: "ml" }, m.label),
        h("div", { class: "mb" }, pill, txt ? h("div", { class: "sub-items" }, txt) : null),
        h("div", { class: "mr" }, v && v.taken ? money(v.amount) : "")));
    });
    box.appendChild(blk);
  });

  const p = provider();
  if (p) {
    const e = getEntry(state.date, p.id);
    if (e) any = true;
    const tot = MEALS.reduce((s, m) => s + ((e && e[m.key]?.count) || 0), 0);
    const blk = h("div", { class: "card person-block" },
      h("div", { class: "ph" }, Avatar(p, "md"), h("strong", {}, p.name),
        h("span", { class: "tot" }, `${tot} tiffins`)));
    MEALS.forEach((m) => {
      const v = e && e[m.key];
      const mb = h("div", { class: "mb" });
      if (!v || !v.count) mb.appendChild(h("span", { class: "pill q" }, "—"));
      else {
        mb.appendChild(h("span", { class: "pill b" }, `${v.count} tiffin${v.count > 1 ? "s" : ""}`));
        (v.tiffins || []).forEach((t, i) => {
          const txt = itemsText(t.items);
          if (txt) mb.appendChild(h("div", { class: "sub-items" }, `Tiffin ${i + 1}: ${txt}`));
        });
      }
      blk.appendChild(h("div", { class: "meal-line" }, h("div", { class: "ml" }, m.label), mb));
    });
    box.appendChild(blk);
  }

  if (!any) box.appendChild(h("div", { class: "card empty" }, "Nothing logged for this day yet."));
  return box;
}

function MonthView() {
  const [from, to] = monthBounds(state.date);
  const box = h("div", {});
  const rows = [];
  let grand = 0;

  friends().forEach((u) => {
    const r = { u, b: 0, l: 0, d: 0, total: 0 };
    Object.values(state.entries).forEach((e) => {
      if (e.userId !== u.id || e.date < from || e.date > to) return;
      MEALS.forEach((m, idx) => {
        const v = e[m.key];
        if (v && v.taken) { r[["b", "l", "d"][idx]] += 1; r.total += Number(v.amount || 0); }
      });
    });
    grand += r.total; rows.push(r);
  });

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, monthLabel(state.date))),
    h("div", { class: "tablewrap" }, h("table", {},
      h("thead", {}, h("tr", {},
        h("th", {}, "Person"), h("th", { class: "num" }, "B"), h("th", { class: "num" }, "L"),
        h("th", { class: "num" }, "D"), h("th", { class: "num" }, "Meals"),
        h("th", { style: "text-align:right" }, "Total"))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { class: "name" }, h("div", { class: "who" }, Avatar(r.u, "sm"), r.u.name)),
        h("td", { class: "num" }, r.b), h("td", { class: "num" }, r.l), h("td", { class: "num" }, r.d),
        h("td", { class: "num" }, r.b + r.l + r.d),
        h("td", { class: "amt", style: "text-align:right" }, money(r.total))))),
      h("tfoot", {}, h("tr", {},
        h("td", { colspan: "4" }, "Group total"),
        h("td", { class: "num" }, rows.reduce((s, r) => s + r.b + r.l + r.d, 0)),
        h("td", { class: "amt", style: "text-align:right" }, money(grand)))))),
    h("p", { class: "note" }, "B = breakfast, L = lunch, D = dinner. Counts are meals marked “taken”.")));

  const p = provider();
  if (p) {
    let tiffins = 0, days = 0;
    Object.values(state.entries).forEach((e) => {
      if (e.userId !== p.id || e.date < from || e.date > to) return;
      const n = MEALS.reduce((s, m) => s + ((e[m.key] && e[m.key].count) || 0), 0);
      if (n) { tiffins += n; days += 1; }
    });
    box.appendChild(h("div", { class: "card person-block" },
      h("div", { class: "ph" }, Avatar(p, "md"), h("strong", {}, p.name),
        h("span", { class: "tot" }, `${tiffins} tiffins`)),
      h("div", { class: "meal-line", style: "border-top:none;padding:4px 0 0" },
        h("div", { class: "mb", style: "color:var(--muted);font-size:13.5px" },
          `Delivered across ${days} day${days === 1 ? "" : "s"} this month`))));
  }
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
      } }, "Save new PIN")),
    h("p", { class: "note" }, "All five PINs must be different. There's no recovery — write it down.")));

  box.appendChild(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "People")),
    h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {},
      state.users.map((u) => h("tr", {},
        h("td", { class: "name" }, h("div", { class: "who" }, Avatar(u, "sm"), u.name)),
        h("td", { style: "color:var(--muted)" }, u.role === "provider" ? "Provider" : "Friend"),
        h("td", { style: "text-align:right" },
          u.id === state.me.id ? h("span", { class: "pill b" }, "you")
            : h("span", { class: "pill q" }, u.isDefaultPin ? "starter PIN" : "PIN set")))))))));

  box.appendChild(h("div", { class: "actions left" },
    h("button", { class: "btn danger", type: "button", onclick: () => {
      localStorage.removeItem(SESSION_KEY);
      if (state.unsubEntries) { state.unsubEntries(); state.unsubEntries = null; }
      state.me = null; state.draft = null; state.draftDate = null;
      state.rangeFrom = null; state.rangeTo = null; state.entriesReady = false;
      state.authStage = "role"; state.authRole = null;
      state.authUserId = null; state.authLabel = null;
      mounted = null;
      renderAuth();
    } }, "Log out")));
  return box;
}
