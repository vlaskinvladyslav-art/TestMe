// ShiftMe cloud sync — Firestore + Google sign-in.
//
// Це паралельна, тестова версія firebase-sync.js (яка й далі працює з
// Realtime Database і лишається недоторканою). Щоб спробувати цю
// версію, зміни в index.html один рядок:
//   <script type="module" src="firebase-sync.js"></script>
// на:
//   <script type="module" src="firestore-sync.js"></script>
// Щоб повернутись назад — просто зміни рядок назад. Жодних інших
// файлів чіпати не треба: обидва модулі говорять із script.js через
// той самий window.CloudSync/window.AppBridge міст.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signOut as firebaseSignOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB50Ak2dnKq1dRpTXjNVR5uO6aY3uzJg2Y",
  authDomain: "shiftme-18f3a.firebaseapp.com",
  projectId: "shiftme-18f3a",
  storageBucket: "shiftme-18f3a.firebasestorage.app",
  messagingSenderId: "778363710817",
  appId: "1:778363710817:web:56d7d9c9025a170318e920",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ADMIN_EMAIL = 'vlaskin.vladyslav@gmail.com';
const DEFAULT_PROCESS_ID = 'balancing';

setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Помилка налаштування persistence:", error);
});

// На відміну від Realtime Database, у Firestore немає постійного
// WebSocket-з'єднання і немає ліміту "100 одночасних з'єднань" — SDK сам
// керує мережею під капотом. Тому весь попередній ритуал
// goOnline/goOffline навколо кожної операції (runOnlineSession у
// firebase-sync.js) тут просто не потрібен.

const SYNC_PENDING_KEY = 'shiftTrackerSyncPending';
function markSyncPending(flag) {
  try {
    if (flag) localStorage.setItem(SYNC_PENDING_KEY, '1');
    else localStorage.removeItem(SYNC_PENDING_KEY);
  } catch (e) { /* сховище недоступне */ }
}

let currentUser = null;
let approved = false;
let profileName = '';
let bootstrapped = false;
let pushTimer = null;
let lastSyncedAt = null;
let syncState = 'idle';

// Перелік ID документів у users/{uid}/entries, які реально існують у
// Firestore ПРЯМО ЗАРАЗ (наскільки нам відомо в межах цієї сесії).
// Наповнюється повним читанням лише раз — при bootstrapSync (вхід) —
// і далі оновлюється після кожного успішного запису, тому наступні
// звичайні push у межах тієї самої сесії не потребують повторного
// читання всієї колекції лише заради визначення "що видалити".
let knownEntryIds = new Set();

// ---------- Event Bus ----------
function emit(status) {
  window.dispatchEvent(new CustomEvent('cloudsync:status', { detail: status }));
}

function currentStatus() {
  if (!currentUser) return { state: 'signed-out' };
  if (!approved) return { state: 'blocked', name: profileName, email: currentUser.email, photo: currentUser.photoURL || null };
  const uiState = syncState === 'syncing' ? 'connecting' : (syncState === 'sync-error' ? 'offline' : 'connected');
  return { state: uiState, name: profileName, email: currentUser.email, photo: currentUser.photoURL || null, lastSyncedAt };
}

// ---------- Auth ----------
function signIn() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider).catch((error) => {
    console.error("Помилка авторизації Google:", error);
  });
}

async function signOutUser() {
  await firebaseSignOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  bootstrapped = false;
  knownEntryIds = new Set();

  if (!user) {
    approved = false;
    profileName = '';
    lastSyncedAt = null;
    syncState = 'idle';
    emit(currentStatus());
    return;
  }

  const isAdmin = user.email === ADMIN_EMAIL;
  syncState = 'syncing';
  emit(currentStatus());

  try {
    const profileRef = doc(db, 'users', user.uid);
    const existing = await getDoc(profileRef);
    const prior = existing.exists() ? existing.data() : {};

    // Доступ надається автоматично всім — адмін лише може заблокувати
    // конкретного користувача (prior.blocked === true).
    approved = isAdmin ? true : (prior.blocked !== true);

    // Ім'я з Google — лише разова початкова підказка, не перезаписує
    // те, що людина вже задала сама.
    profileName = prior.name || user.displayName || '';

    // Бригада/тип зміни/лінія: якщо на ЦЬОМУ пристрої ще нічого не
    // обирали, а в хмарі вже є — підхоплюємо. Якщо тут уже щось обрано
    // локально — не чіпаємо, локальний вибір іде в хмару окремо
    // (через updateShiftConfig, коли людина реально його змінить).
    if (window.AppBridge && !window.AppBridge.hasLocalShiftConfig() && (prior.brigade || prior.shiftType || prior.line)) {
      window.AppBridge.applyCloudShiftConfig({ brigade: prior.brigade, shiftType: prior.shiftType, line: prior.line });
    }

    await setDoc(profileRef, {
      name: profileName,
      email: user.email || '',
      firstSeen: prior.firstSeen || Date.now(),
      lastSeen: Date.now(),
    }, { merge: true });

    syncState = 'synced';
  } catch (e) {
    approved = isAdmin;
    profileName = user.displayName || '';
    syncState = 'sync-error';
  }

  emit(currentStatus());

  if (approved) {
    await bootstrapSync();
  }
});

// ---------- Merge (bootstrap) ----------
// Точно та сама логіка, що й у firebase-sync.js (RTDB-версії) —
// об'єднання замість сліпого перезаписування, з округленням до копійок
// у запасному ключі для дуже старих записів без `time`/`order`
// (звідти брались дублі, поки округлення не було). Тут вона працює над
// тим самим у-пам'яті "bundle", просто прочитаним і записаним інакше
// (документи замість одного великого JSON-блоба).

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function entryIdentity(e) {
  if (e.time) return e.time;
  const itemsKey = (e.items || [])
    .map(it => (it.code || '') + ':' + roundMoney(it.rate) + ':' + roundMoney(it.qty))
    .join(',');
  return itemsKey + '|' + roundMoney(e.amount) + '|' + (e.order || '') + '|' + (e.date || '');
}

function mergeEarnings(cloudEarnings, localEarnings) {
  const result = {};
  const dateKeys = new Set([
    ...Object.keys(cloudEarnings || {}),
    ...Object.keys(localEarnings || {}),
  ]);
  dateKeys.forEach(key => {
    const byId = new Map();
    ((cloudEarnings && cloudEarnings[key]) || []).forEach(e => byId.set(entryIdentity(e), e));
    ((localEarnings && localEarnings[key]) || []).forEach(e => {
      const id = entryIdentity(e);
      const existing = byId.get(id);
      if (!existing || (existing.deleted && !e.deleted)) byId.set(id, e);
    });
    const merged = Array.from(byId.values());
    if (merged.length > 0) result[key] = merged;
  });
  return result;
}

function mergeKeyedObject(cloudObj, localObj) {
  return { ...(cloudObj || {}), ...(localObj || {}) };
}

function mergeCustomProducts(cloudList, localList) {
  const byCode = new Map();
  (cloudList || []).forEach(p => byCode.set(p.code, p));
  (localList || []).forEach(p => byCode.set(p.code, p));
  return Array.from(byCode.values());
}

function mergeBundles(cloud, local) {
  return {
    earnings: mergeEarnings(cloud.earnings, local.earnings),
    goals: mergeKeyedObject(cloud.goals, local.goals),
    customProducts: mergeCustomProducts(cloud.customProducts, local.customProducts),
    leaveDays: mergeKeyedObject(cloud.leaveDays, local.leaveDays),
  };
}

// ---------- Firestore <-> bundle ----------

function entryDocId(dateKey, entry) {
  // Стабільний ID, привʼязаний до ЗМІСТУ запису (не до його позиції в
  // масиві) — та сама entryIdentity(), що й у merge вище. Це і є те,
  // що дозволяє повторний запис/видалення того самого запису
  // потрапляти в той самий документ, а не плодити нові.
  const raw = dateKey + '_' + entryIdentity(entry);
  return raw.replace(/\//g, '_').slice(0, 400);
}

function entryToDoc(entry, dateKey) {
  return {
    date: entry.date || dateKey,
    processId: entry.processId || DEFAULT_PROCESS_ID,
    items: entry.items || [],
    amount: entry.amount,
    order: entry.order || null,
    time: entry.time || null,
    deleted: entry.deleted === true,
    deletedAt: entry.deletedAt || null,
  };
}

// Читає ПОВНИЙ стан користувача з Firestore (профіль + усі записи) й
// одразу повертає його у вигляді того самого "bundle", яким оперує
// script.js — плюс перелік ID документів-записів, які реально існують
// (потрібно нижче, щоб коректно прибрати документи остаточно видалених
// записів, а не лишати їх "безсмертними").
async function readCloudBundle(uid) {
  const profileSnap = await getDoc(doc(db, 'users', uid));
  const prior = profileSnap.exists() ? profileSnap.data() : {};

  const entriesSnap = await getDocs(collection(db, 'users', uid, 'entries'));
  const earnings = {};
  const existingIds = new Set();
  entriesSnap.forEach((docSnap) => {
    existingIds.add(docSnap.id);
    const data = docSnap.data();
    const dk = data.date || docSnap.id.split('_')[0];
    if (!earnings[dk]) earnings[dk] = [];
    earnings[dk].push(data);
  });

  return {
    bundle: {
      earnings,
      goals: prior.goals || {},
      customProducts: prior.customProducts || [],
      leaveDays: prior.leaveDays || {},
    },
    existingIds,
    hasAnyData: existingIds.size > 0 || profileSnap.exists(),
  };
}

// Записує bundle назад у Firestore: один set() на кожен запис (за
// стабільним ID), плюс delete() для документів, які раніше існували
// (knownEntryIds), але яких більше немає в об'єднаному наборі — інакше
// остаточно видалені (після 10с purge) записи лишались би в базі
// назавжди й "воскресали" б через merge при наступному вході.
async function writeCloudBundle(uid, bundle) {
  const ops = [];
  const newIds = new Set();

  Object.keys(bundle.earnings || {}).forEach((dateKey) => {
    (bundle.earnings[dateKey] || []).forEach((entry) => {
      const id = entryDocId(dateKey, entry);
      newIds.add(id);
      ops.push({ type: 'set', ref: doc(db, 'users', uid, 'entries', id), data: entryToDoc(entry, dateKey) });
    });
  });

  knownEntryIds.forEach((id) => {
    if (!newIds.has(id)) ops.push({ type: 'delete', ref: doc(db, 'users', uid, 'entries', id) });
  });

  ops.push({
    type: 'set-merge',
    ref: doc(db, 'users', uid),
    data: {
      goals: bundle.goals || {},
      customProducts: bundle.customProducts || [],
      leaveDays: bundle.leaveDays || {},
    },
  });

  const CHUNK = 400; // ліміт Firestore — 500 операцій на batch, лишаємо запас
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = writeBatch(db);
    ops.slice(i, i + CHUNK).forEach((op) => {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else if (op.type === 'set-merge') batch.set(op.ref, op.data, { merge: true });
      else if (op.type === 'delete') batch.delete(op.ref);
    });
    await batch.commit();
  }

  knownEntryIds = newIds;
}

// ---------- Bootstrap Sync ----------
async function bootstrapSync() {
  if (bootstrapped || !window.AppBridge) return;
  bootstrapped = true;
  syncState = 'syncing';
  emit(currentStatus());

  try {
    const uid = currentUser.uid;
    const { bundle: cloudBundle, existingIds, hasAnyData } = await readCloudBundle(uid);
    knownEntryIds = existingIds;
    const local = window.AppBridge.getLocalBundle();

    let merged;
    if (!hasAnyData) {
      // Хмара порожня — нічого зливати, просто перший запис.
      merged = local;
    } else {
      merged = mergeBundles(cloudBundle, local);
      window.AppBridge.applyCloudBundle(merged);
    }

    await writeCloudBundle(uid, merged);
    markSyncPending(false);
    lastSyncedAt = Date.now();
    syncState = 'synced';
  } catch (e) {
    syncState = 'sync-error';
  }
  emit(currentStatus());
}

// ---------- Push Data ----------
async function doPush() {
  if (!currentUser || !approved || !window.AppBridge) return;
  const bundle = window.AppBridge.getLocalBundle();
  syncState = 'syncing';
  emit(currentStatus());
  try {
    await writeCloudBundle(currentUser.uid, bundle);
    markSyncPending(false);
    lastSyncedAt = Date.now();
    syncState = 'synced';
  } catch (e) {
    markSyncPending(true);
    syncState = 'sync-error';
  }
  emit(currentStatus());
}

function pushLocalData() {
  if (!currentUser || !approved || !window.AppBridge) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, 400);
}

// ---------- Force Sync ----------
function forceSync() {
  clearTimeout(pushTimer);
  doPush();
}

// ---------- Update Display Name ----------
function updateDisplayName(name) {
  const trimmed = (name || '').trim();
  if (!currentUser) return Promise.reject(new Error('not signed in'));
  if (!trimmed) return Promise.reject(new Error('empty name'));
  return setDoc(doc(db, 'users', currentUser.uid), { name: trimmed }, { merge: true }).then(() => {
    profileName = trimmed;
    emit(currentStatus());
  });
}

// ---------- Update Shift Config (Бригада / Тип зміни / Лінія) ----------
function updateShiftConfig(cfg) {
  if (!currentUser || !cfg) return Promise.resolve();
  return setDoc(doc(db, 'users', currentUser.uid), {
    brigade: cfg.brigade === 2 ? 2 : 1,
    shiftType: cfg.shiftType === 'night' ? 'night' : 'day',
    line: (cfg.line === 'stator' || cfg.line === 'rotor') ? cfg.line : null,
  }, { merge: true }).catch(() => {});
}

// ---------- Export Bridge ----------
// Той самий інтерфейс, що й firebase-sync.js — script.js не бачить
// різниці, звідки саме приходять дані.
window.CloudSync = {
  signIn,
  signOut: signOutUser,
  forceSync,
  pushLocalData,
  updateDisplayName,
  updateShiftConfig,
  getStatus: currentStatus,
  isReady: () => !!currentUser && approved,
};
