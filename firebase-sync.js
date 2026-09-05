// ShiftMe cloud sync — Firebase Realtime Database + Google sign-in.

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
  getDatabase,
  ref,
  set,
  update,
  get,
  goOffline,
  goOnline,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB50Ak2dnKq1dRpTXjNVR5uO6aY3uzJg2Y",
  authDomain: "shiftme-18f3a.firebaseapp.com",
  databaseURL: "https://shiftme-18f3a-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "shiftme-18f3a",
  storageBucket: "shiftme-18f3a.firebasestorage.app",
  messagingSenderId: "778363710817",
  appId: "1:778363710817:web:56d7d9c9025a170318e920",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const ADMIN_EMAIL = 'vlaskin.vladyslav@gmail.com';

// Фіксуємо сесію в локальному сховищі/IndexedDB для запобігання скиданню авторизації
setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error("Помилка налаштування persistence:", error);
});

// ---------- On-demand сесії до Realtime Database ----------
// SDK за замовчуванням тримає постійний WebSocket відкритим — на
// безкоштовному Spark-плані це б'є в ліміт 100 одночасних з'єднань.
// Замість цього: одразу переводимо в offline, а для кожної окремої
// операції (читання/запис) відкриваємо зʼєднання лише на час цієї
// операції й одразу закриваємо — незалежно від того, вдалась вона чи ні.
goOffline(db);

let sessionChain = Promise.resolve();
// Черга, а не паралельні виклики: якщо два запити (напр. швидкий
// подвійний тап "додати запис") стартанули б одночасно, goOffline()
// одного міг би обірвати ще незавершений запит іншого.
function runOnlineSession(fn) {
  const result = sessionChain.then(async () => {
    goOnline(db);
    try {
      return await fn();
    } finally {
      goOffline(db);
    }
  });
  sessionChain = result.catch(() => {}); // один невдалий сеанс не має зупиняти чергу назавжди
  return result;
}

const SYNC_PENDING_KEY = 'shiftTrackerSyncPending';
function markSyncPending(flag) {
  try {
    if (flag) localStorage.setItem(SYNC_PENDING_KEY, '1');
    else localStorage.removeItem(SYNC_PENDING_KEY);
  } catch (e) { /* сховище недоступне */ }
}
function hasSyncPending() {
  try { return localStorage.getItem(SYNC_PENDING_KEY) === '1'; } catch (e) { return false; }
}

let currentUser = null;
let approved = false;
let profileName = '';
let bootstrapped = false;
let pushTimer = null;
let lastSyncedAt = null;
// 'idle' | 'syncing' | 'synced' | 'sync-error' — результат ОСТАННЬОЇ
// спроби синхронізації, а не "чи є зараз живе з'єднання" (такого більше
// немає). Значення навмисно лишені сумісними з тим, що вже читає UI.
let syncState = 'idle';

// ---------- Event Bus ----------
function emit(status) {
  window.dispatchEvent(new CustomEvent('cloudsync:status', { detail: status }));
}

function currentStatus() {
  if (!currentUser) return { state: 'signed-out' };
  if (!approved) return { state: 'blocked', name: profileName, email: currentUser.email, photo: currentUser.photoURL || null };
  // UI (script.js) досі очікує саме ці рядки — 'connecting'/'connected'/'offline'.
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
    await runOnlineSession(async () => {
      const profileRef = ref(db, 'users/' + user.uid + '/profile');
      const existing = await get(profileRef);
      const prior = existing.exists() ? existing.val() : {};

      // Доступ надається автоматично всім — адмін лише може заблокувати
      // конкретного користувача (prior.blocked === true), а не навпаки
      // підтверджувати кожного вручну.
      approved = isAdmin ? true : (prior.blocked !== true);

      // Ім'я з Google — лише разова початкова підказка. Якщо людина вже
      // задала своє (через updateDisplayName), воно не перезаписується
      // при кожному вході — бо в Google-акаунті часто нік, а не справжнє ім'я.
      profileName = prior.name || user.displayName || '';

      // Бригада/тип зміни: якщо на ЦЬОМУ пристрої людина ще нічого сама не
      // обирала, а в хмарі вже є збережене налаштування (з іншого пристрою) —
      // підхоплюємо його. Якщо ж тут уже щось обрано локально — не чіпаємо,
      // локальний вибір має пріоритет і саме він піде в хмару нижче.
      if (window.AppBridge && !window.AppBridge.hasLocalShiftConfig() && (prior.brigade || prior.shiftType)) {
        window.AppBridge.applyCloudShiftConfig({ brigade: prior.brigade, shiftType: prior.shiftType });
      }

      const profilePayload = {
        name: profileName,
        email: user.email || '',
        firstSeen: prior.firstSeen || Date.now(),
        lastSeen: Date.now(),
      };

      await update(profileRef, profilePayload);
    });
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

// ---------- Bootstrap Sync ----------
async function bootstrapSync() {
  if (bootstrapped || !window.AppBridge) return;
  bootstrapped = true;
  syncState = 'syncing';
  emit(currentStatus());

  try {
    await runOnlineSession(async () => {
      const dataRef = ref(db, 'users/' + currentUser.uid + '/data');
      const cloudSnap = await get(dataRef);

      const local = window.AppBridge.getLocalBundle();
      const localIsEmpty = Object.keys(local.earnings || {}).length === 0;
      // Незавершений попередній запис (з минулої offline-спроби) має
      // пріоритет над підтягуванням хмари — інакше він загубиться.
      const pending = hasSyncPending();

      if (cloudSnap.exists() && localIsEmpty && !pending) {
        window.AppBridge.applyCloudBundle(cloudSnap.val());
      } else {
        await set(dataRef, local);
        markSyncPending(false);
      }
    });
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
    await runOnlineSession(() => set(ref(db, 'users/' + currentUser.uid + '/data'), bundle));
    markSyncPending(false);
    lastSyncedAt = Date.now();
    syncState = 'synced';
  } catch (e) {
    // Немає мережі або збій — запис лишається в localStorage як є
    // (script.js і так пише все в localStorage синхронно, до мережі).
    // Позначаємо, щоб наступний запуск/вхід сам домовив push.
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
// На відміну від pushLocalData() — без 400мс дебаунсу, бо це пряма дія
// людини (натискання кнопки "Синхронізувати зараз") і має відповісти одразу.
function forceSync() {
  clearTimeout(pushTimer);
  doPush();
}

// ---------- Update Display Name ----------
// "name" лишається полем, яке може писати сам користувач (правила це
// дозволяють) — Google-нік лише початкове значення, не остаточне.
function updateDisplayName(name) {
  const trimmed = (name || '').trim();
  if (!currentUser) return Promise.reject(new Error('not signed in'));
  if (!trimmed) return Promise.reject(new Error('empty name'));
  return runOnlineSession(() => update(ref(db, 'users/' + currentUser.uid + '/profile'), { name: trimmed })).then(() => {
    profileName = trimmed;
    emit(currentStatus());
  });
}

// ---------- Update Shift Config (Бригада / Тип зміни) ----------
function updateShiftConfig(cfg) {
  if (!currentUser || !cfg) return Promise.resolve();
  return runOnlineSession(() => update(ref(db, 'users/' + currentUser.uid + '/profile'), {
    brigade: cfg.brigade === 2 ? 2 : 1,
    shiftType: cfg.shiftType === 'night' ? 'night' : 'day',
  })).catch(() => {});
}

// ---------- Export Bridge ----------
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