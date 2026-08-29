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
  onValue,
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

let currentUser = null;
let approved = false;
let bootstrapped = false;
let pushTimer = null;

// ---------- Event Bus ----------
function emit(status) {
  window.dispatchEvent(new CustomEvent('cloudsync:status', { detail: status }));
}

function currentStatus() {
  if (!currentUser) return { state: 'signed-out' };
  if (!approved) return { state: 'pending', name: currentUser.displayName, email: currentUser.email };
  return { state: connectionState, name: currentUser.displayName, email: currentUser.email };
}
let connectionState = 'connecting';

// ---------- Connection Indicator ----------
onValue(ref(db, '.info/connected'), (snap) => {
  connectionState = snap.val() === true ? 'connected' : 'offline';
  emit(currentStatus());
});

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
    emit(currentStatus());
    return;
  }

  const isAdmin = user.email === ADMIN_EMAIL;

  try {
    const profileRef = ref(db, 'users/' + user.uid + '/profile');
    const existing = await get(profileRef);
    const prior = existing.exists() ? existing.val() : {};

    approved = isAdmin ? true : (prior.approved === true);

    const profilePayload = {
      name: user.displayName || '',
      email: user.email || '',
      firstSeen: prior.firstSeen || Date.now(),
      lastSeen: Date.now(),
    };

    if (isAdmin) {
      profilePayload.approved = true;
    }

    await update(profileRef, profilePayload);
  } catch (e) {
    approved = isAdmin;
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

  const dataRef = ref(db, 'users/' + currentUser.uid + '/data');
  let cloudSnap;
  try {
    cloudSnap = await get(dataRef);
  } catch (e) {
    return;
  }

  const local = window.AppBridge.getLocalBundle();
  const localIsEmpty = Object.keys(local.earnings || {}).length === 0;

  if (cloudSnap.exists() && localIsEmpty) {
    window.AppBridge.applyCloudBundle(cloudSnap.val());
  } else {
    await set(dataRef, local);
  }
}

// ---------- Push Data ----------
function pushLocalData() {
  if (!currentUser || !approved || !window.AppBridge) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    set(ref(db, 'users/' + currentUser.uid + '/data'), window.AppBridge.getLocalBundle()).catch(() => {});
  }, 400);
}

// ---------- Force Sync ----------
function forceSync() {
  goOffline(db);
  setTimeout(() => {
    goOnline(db);
    pushLocalData();
  }, 300);
}

// ---------- Export Bridge ----------
window.CloudSync = {
  signIn,
  signOut: signOutUser,
  forceSync,
  pushLocalData,
  getStatus: currentStatus,
  isReady: () => !!currentUser && approved,
};