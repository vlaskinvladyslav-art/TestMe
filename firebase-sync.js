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
//
// Access model: anyone who signs in with Google can write their own
// /users/{uid}/profile node (so the admin can see *everyone* who has
// ever tried to open the app, by name/email, in the Firebase console).
// But nobody can read or write their /users/{uid}/data node — their
// actual earnings — until the admin manually sets
// /users/{uid}/profile/approved to true for that account in the
// console. There's no in-app admin panel yet; approving/blocking people
// is done directly in the Firebase console's Realtime Database view.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
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

// ---------- Auth ----------
async function signIn() {
  await signInWithRedirect(auth, new GoogleAuthProvider());
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

  // Always allowed to write our own profile, regardless of approval —
  // this is how the admin finds out someone new is trying to get in.
  // Critically, 'approved' is never part of this write, not even to
  // echo its current value: the security rules lock that one field to
  // admin-only writes, and a field-level rule rejects the *entire*
  // update if it touches a path the writer isn't allowed to touch —
  // even when the value doesn't actually change. update() here only
  // touches the fields a regular user is permitted to write.
  try {
    const profileRef = ref(db, 'users/' + user.uid + '/profile');
    const existing = await get(profileRef);
    const prior = existing.exists() ? existing.val() : {};
    approved = prior.approved === true;
    await update(profileRef, {
      name: user.displayName || '',
      email: user.email || '',
      firstSeen: prior.firstSeen || Date.now(),
      lastSeen: Date.now(),
    });
  } catch (e) {
    approved = false;
  }

  emit(currentStatus());

  if (approved) await bootstrapSync();
});

// Completes the Google sign-in after the redirect bounces back here.
getRedirectResult(auth).catch(() => { /* no pending redirect, or it failed silently */ });

// ---------- One-time bootstrap: reconcile local vs cloud on first sync ----------
// Rule, kept deliberately simple: local history is never silently
// discarded. If the cloud already has data for this account, pull it
// down ONLY when the local device is empty (the exact "I reinstalled
// the app" recovery scenario). Otherwise, whatever is already on this
// device is treated as authoritative and gets pushed up as-is — so the
// month of history already on everyone's phones is preserved, not
// replaced by an empty cloud record.
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
// Debounced slightly so rapid-fire local changes (e.g. typing) don't
// spam the database with a write per keystroke.
function pushLocalData() {
  if (!currentUser || !approved || !window.AppBridge) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    set(ref(db, 'users/' + currentUser.uid + '/data'), window.AppBridge.getLocalBundle()).catch(() => {
      // offline — RTDB already queues this write internally and will
      // resend it automatically once the connection returns.
    });
  }, 400);
}

// ---------- Manual "force sync" ----------
// Nudges the SDK to drop and re-establish its connection, then re-sends
// whatever is currently in local storage so nothing sits unsynced.
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
