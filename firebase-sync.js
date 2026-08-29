// ShiftMe cloud sync — Firebase Realtime Database + Google sign-in.
//
// This file is a self-contained ES module, loaded separately from the
// classic (non-module) script.js. That split is deliberate: script.js's
// top-level `let`/`const` variables are NOT visible to a module by name,
// so the two sides talk to each other only through two small, explicit
// bridges on `window`:
//
//   window.AppBridge   — set up by script.js, read by this file.
//                        Lets this module read/write the app's local
//                        data (earnings, goals, products, leave days)
//                        without needing to know how they're stored.
//
//   window.CloudSync   — set up by this file, read by script.js.
//                        Lets the UI trigger sign-in/out, force a
//                        reconnect, and react to connection/approval
//                        status changes.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
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

// Обробка повернення після редиректу на мобільних пристроях
getRedirectResult(auth).catch((error) => {
  console.error("Помилка повернення з авторизації:", error);
});

let currentUser = null;
let approved = false;
let bootstrapped = false; // has the one-time local<->cloud seed already run for this session?
let pushTimer = null;

// ---------- Tiny event bus so script.js can react without polling ----------
function emit(status) {
  window.dispatchEvent(new CustomEvent('cloudsync:status', { detail: status }));
}
function currentStatus() {
  if (!currentUser) return { state: 'signed-out' };
  if (!approved) return { state: 'pending', name: currentUser.displayName, email: currentUser.email };
  return { state: connectionState, name: currentUser.displayName, email: currentUser.email };
}
let connectionState = 'connecting'; // 'connected' | 'offline' | 'connecting'

// ---------- Connection indicator (.info/connected is a special RTDB path) ----------
onValue(ref(db, '.info/connected'), (snap) => {
  connectionState = snap.val() === true ? 'connected' : 'offline';
  emit(currentStatus());
});

// Детектор мобільних пристроїв та PWA
const isMobileOrPWA = () => {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || 
         window.matchMedia('(display-mode: standalone)').matches;
};

// ---------- Auth ----------
async function signIn() {
  try {
    const provider = new GoogleAuthProvider();
    if (isMobileOrPWA()) {
      // На смартфонах та в PWA використовуємо редирект
      await signInWithRedirect(auth, provider);
    } else {
      // На ПК використовуємо Popup
      await signInWithPopup(auth, provider);
    }
  } catch (error) {
    console.error("Помилка авторизації Google:", error);
  }
}

async function signOutUser() {
  await firebaseSignOut(auth);
}

onAuthStateChanged(auth, async (user) => {
  // Якщо user ще null, спробуємо примусово зчитати результат редиректу для iOS Safari
  if (!user) {
    try {
      const redirectResult = await getRedirectResult(auth);
      if (redirectResult && redirectResult.user) {
        user = redirectResult.user;
      }
    } catch (err) {
      console.error("Помилка getRedirectResult:", err);
    }
  }

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

// ---------- One-time bootstrap: reconcile local vs cloud on first sync ----------
async function bootstrapSync() {
  if (bootstrapped || !window.AppBridge) return;
  bootstrapped = true;

  const dataRef = ref(db, 'users/' + currentUser.uid + '/data');
  let cloudSnap;
  try {
    cloudSnap = await get(dataRef);
  } catch (e) {
    return; // offline or blocked — local keeps working as-is, will retry on next change
  }

  const local = window.AppBridge.getLocalBundle();
  const localIsEmpty = Object.keys(local.earnings || {}).length === 0;

  if (cloudSnap.exists() && localIsEmpty) {
    window.AppBridge.applyCloudBundle(cloudSnap.val());
  } else {
    await set(dataRef, local);
  }
}

// ---------- Push local -> cloud, called by script.js after every save ----------
function pushLocalData() {
  if (!currentUser || !approved || !window.AppBridge) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    set(ref(db, 'users/' + currentUser.uid + '/data'), window.AppBridge.getLocalBundle()).catch(() => {
      // offline — RTDB queued write
    });
  }, 400);
}

// ---------- Manual "force sync" ----------
function forceSync() {
  goOffline(db);
  setTimeout(() => {
    goOnline(db);
    pushLocalData();
  }, 300);
}

window.CloudSync = {
  signIn,
  signOut: signOutUser,
  forceSync,
  pushLocalData,
  getStatus: currentStatus,
  isReady: () => !!currentUser && approved,
};