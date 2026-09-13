import "../app.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const gate = $("#authGate");
const form = $("#authForm");
const message = $("#authMessage");
const GUEST_LEDGER_KEY = "liuxue-spending-guest-ledger-v1";
const GUEST_CATEGORIES_KEY = "liuxue-spending-guest-categories-v1";
const GUEST_RECEIPT_DB = "liuxue-spending-guest-receipts-v1";
const GUEST_RECEIPT_STORE = "images";
let mode = "login";
let promptReason = "";

function emptyGuestLedger() { return { entries: [], assets: [], updatedAt: null }; }
function readGuestLedger() {
  try {
    const value = JSON.parse(localStorage.getItem(GUEST_LEDGER_KEY) || "null");
    return value && Array.isArray(value.entries) && Array.isArray(value.assets) ? value : emptyGuestLedger();
  } catch { return emptyGuestLedger(); }
}
function writeGuestLedger(entries, assets) {
  const value = { entries, assets, updatedAt: new Date().toISOString() };
  localStorage.setItem(GUEST_LEDGER_KEY, JSON.stringify(value));
  return value;
}
function clearGuestLedger() { localStorage.removeItem(GUEST_LEDGER_KEY); }

function openGuestReceiptDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GUEST_RECEIPT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(GUEST_RECEIPT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本机凭证存储。"));
  });
}
async function guestReceiptTransaction(mode, action) {
  const db = await openGuestReceiptDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(GUEST_RECEIPT_STORE, mode);
      const store = transaction.objectStore(GUEST_RECEIPT_STORE);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本机凭证存储失败。"));
    });
  } finally { db.close(); }
}
const guestReceiptStore = {
  put: (id, image) => guestReceiptTransaction("readwrite", (store) => store.put(image, id)),
  get: (id) => guestReceiptTransaction("readonly", (store) => store.get(id)),
  remove: (id) => guestReceiptTransaction("readwrite", (store) => store.delete(id)),
  clear: () => guestReceiptTransaction("readwrite", (store) => store.clear()),
};
window.guestReceiptStore = guestReceiptStore;

window.ledgerApi = {
  async get() {
    if (!window.currentLedgerUser) return readGuestLedger();
    const response = await fetch("/api/ledger", { credentials: "same-origin" });
    if (!response.ok) throw new Error("无法加载云端账本。");
    return response.json();
  },
  async save(entries, assets) {
    if (!window.currentLedgerUser) return { ok: true, ...writeGuestLedger(entries, assets) };
    const response = await fetch("/api/ledger", {
      method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, assets }),
    });
    if (!response.ok) throw new Error("保存失败，请稍后重试。");
    return response.json();
  },
  async getCategories() {
    try { return JSON.parse(localStorage.getItem(GUEST_CATEGORIES_KEY) || "[]"); }
    catch { return []; }
  },
  async saveCategories(categories) {
    localStorage.setItem(GUEST_CATEGORIES_KEY, JSON.stringify(categories));
    return { categories };
  },
};

function setMessage(text = "", type = "") { message.textContent = text; message.className = `auth-message ${type}`; }
function accountLabel(user) { return user.email || user.phone || "已登录"; }
function profileData(user) { return user?.userMetadata || {}; }

function setMode(nextMode) {
  mode = nextMode;
  const signingUp = mode === "signup";
  $(".auth-name-field").hidden = !signingUp;
  $("#authEyebrow").textContent = signingUp ? "START YOUR DIARY" : "WELCOME BACK";
  $("#authTitle").textContent = signingUp ? "创建你的账本" : "登录你的账本";
  $("#authSubtitle").textContent = promptReason || (signingUp ? "使用邮箱或手机号创建账号。" : "使用邮箱或手机号与密码继续。");
  $("#authSubmit").innerHTML = signingUp ? "注册并保存试用账本 <span>→</span>" : "登录并保存试用账本 <span>→</span>";
  $("#forgotPassword").hidden = true;
  $$('[data-auth-mode]').forEach((button) => button.classList.toggle("selected", button.dataset.authMode === mode));
  setMessage();
}

function applyProfile(user) {
  const metadata = profileData(user);
  const accountName = metadata.full_name || accountLabel(user).split("@")[0] || "我的";
  const country = metadata.country || "澳大利亚";
  const currency = metadata.display_currency || "AUD";
  const sidebarName = document.querySelector(".user-card b");
  const sidebarDetail = document.querySelector(".user-card span");
  if (sidebarName) sidebarName.textContent = accountName;
  if (sidebarDetail) sidebarDetail.textContent = accountLabel(user);
  $("#profileName").textContent = accountName;
  $("#profileEmail").textContent = accountLabel(user);
  $("#profileAvatar").textContent = accountName.slice(0, 1).toUpperCase();
  $("#homeName").textContent = accountName;
  $("#profilePreference").textContent = `${country} · ${currency}（CNY 成本对照）`;
  $("#editProfile").textContent = "编辑资料";
}

function applyGuestProfile() {
  const sidebarName = document.querySelector(".user-card b");
  const sidebarDetail = document.querySelector(".user-card span");
  if (sidebarName) sidebarName.textContent = "访客试用";
  if (sidebarDetail) sidebarDetail.textContent = "本机暂存，登录后同步";
  $("#profileName").textContent = "访客试用";
  $("#profileEmail").textContent = "账目仅保存在这台设备";
  $("#profileAvatar").textContent = "试";
  $("#homeName").textContent = "你好";
  $("#profilePreference").textContent = "登录后可同步地区、货币与资料";
  $("#editProfile").textContent = "登录并同步";
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求未能完成。");
  return payload;
}

function uniqueEntryId(used, sequence) {
  let id = Date.now() + sequence;
  while (used.has(String(id))) id += 1;
  used.add(String(id));
  return id;
}

async function migrateGuestLedger() {
  const guest = readGuestLedger();
  if (!guest.entries.length && !guest.assets.length) return 0;
  const cloud = await window.ledgerApi.get();
  const cloudEntries = Array.isArray(cloud.entries) ? cloud.entries : [];
  const cloudAssets = Array.isArray(cloud.assets) ? cloud.assets : [];
  const receiptIds = [...new Set([...guest.entries, ...guest.assets].map((item) => item.receiptId).filter((id) => String(id || "").startsWith("guest-receipt-")))];
  const receiptIdMap = new Map();
  for (const id of receiptIds) {
    const image = await guestReceiptStore.get(id);
    if (!image) throw new Error("本机试用小票缺失，请先在当前设备完成登录。");
    const saved = await api("/api/receipt-image", { method: "POST", body: JSON.stringify({ image }) });
    receiptIdMap.set(id, saved.receiptId);
  }
  const usedIds = new Set(cloudEntries.map((entry) => String(entry.id)));
  const entryIdMap = new Map();
  const migratedEntries = guest.entries.map((entry, index) => {
    const id = uniqueEntryId(usedIds, index);
    entryIdMap.set(String(entry.id), id);
    return { ...entry, id, receiptId: receiptIdMap.get(entry.receiptId) || entry.receiptId || null };
  });
  const migratedAssets = guest.assets.map((asset) => ({
    ...asset,
    entryId: entryIdMap.get(String(asset.entryId)) || asset.entryId,
    receiptId: receiptIdMap.get(asset.receiptId) || asset.receiptId || null,
  }));
  await window.ledgerApi.save([...migratedEntries, ...cloudEntries], [...migratedAssets, ...cloudAssets]);
  clearGuestLedger();
  await guestReceiptStore.clear();
  return migratedEntries.length;
}

async function showApp(user) {
  window.currentLedgerUser = user;
  const migratedCount = await migrateGuestLedger();
  gate.hidden = true;
  gate.classList.remove("prompt");
  document.body.classList.add("authenticated");
  document.body.classList.remove("guest-mode");
  applyProfile(user);
  window.dispatchEvent(new CustomEvent("ledger-auth-ready", { detail: { user } }));
  if (migratedCount) setTimeout(() => window.showLedgerToast?.(`已将试用期间的 ${migratedCount} 条账目和原始小票同步到此账号。`), 250);
}

function showGuestApp() {
  gate.hidden = true;
  gate.classList.remove("prompt");
  document.body.classList.add("authenticated", "guest-mode");
  window.currentLedgerUser = null;
  applyGuestProfile();
  window.dispatchEvent(new CustomEvent("ledger-auth-ready", { detail: { user: null } }));
}

function showAuth(reason = "") {
  promptReason = reason;
  gate.hidden = false;
  gate.classList.add("prompt");
  document.body.classList.add("authenticated", "guest-mode");
  $("#authContinueGuest").hidden = false;
  setMode("login");
}
window.requestLedgerLogin = (reason = "登录后即可将本机试用账目安全同步到你的账号。") => {
  if (sessionStorage.getItem("liuxue-spending-login-prompted")) return;
  sessionStorage.setItem("liuxue-spending-login-prompted", "1");
  showAuth(reason);
};

async function initialize() {
  try { const { user } = await api("/api/auth/me"); if (user) await showApp(user); else showGuestApp(); }
  catch { showGuestApp(); }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const identifier = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const submit = $("#authSubmit");
  submit.disabled = true;
  setMessage(mode === "signup" ? "正在创建账号并同步试用账本…" : "正在登录并同步试用账本…");
  try {
    const path = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const payload = await api(path, { method: "POST", body: JSON.stringify({ identifier, password, full_name: $("#authName").value.trim() }) });
    await showApp(payload.user);
  } catch (error) { setMessage(error.message || "登录失败，请检查账号和密码。", "error"); }
  finally { submit.disabled = false; }
});

$("#authContinueGuest").addEventListener("click", showGuestApp);

function openProfileEditor() {
  const user = window.currentLedgerUser;
  if (!user) { showAuth("登录后即可编辑资料，并把本机试用账目同步到你的账号。"); return; }
  const metadata = profileData(user);
  $("#profileFormName").value = metadata.full_name || accountLabel(user).split("@")[0] || "";
  $("#profileFormEmail").value = accountLabel(user);
  $("#profileFormCountry").value = metadata.country || "澳大利亚";
  $("#profileFormCurrency").value = metadata.display_currency || "AUD";
  $("#profileFormMessage").textContent = "";
  $("#modalBackdrop").hidden = false; $("#profileModal").hidden = false;
}

$("#editProfile").addEventListener("click", openProfileEditor);
$("#editPreferences").addEventListener("click", openProfileEditor);
$("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const submit = $("#profileSubmit"); const profileMessage = $("#profileFormMessage");
  submit.disabled = true; profileMessage.textContent = "正在保存…";
  try {
    const payload = await api("/api/auth/profile", { method: "PUT", body: JSON.stringify({ full_name: $("#profileFormName").value.trim(), country: $("#profileFormCountry").value, display_currency: $("#profileFormCurrency").value }) });
    window.currentLedgerUser = payload.user; applyProfile(payload.user);
    $("#profileModal").hidden = true; $("#modalBackdrop").hidden = true;
  } catch (error) { profileMessage.textContent = error.message || "资料保存失败，请稍后重试。"; }
  finally { submit.disabled = false; }
});

$$('[data-auth-mode]').forEach((button) => button.addEventListener("click", () => setMode(button.dataset.authMode)));
window.signOutLedger = async () => { await api("/api/auth/logout", { method: "POST" }); showGuestApp(); };
$("#logoutButton").addEventListener("click", async () => { try { await window.signOutLedger(); window.showLedgerToast?.("你已退出登录，现在可继续本机试用。"); } catch { window.showLedgerToast?.("退出失败，请稍后重试。"); } });
initialize();
