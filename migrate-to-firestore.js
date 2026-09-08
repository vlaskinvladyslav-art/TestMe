// ---------------------------------------------------------------------
// ShiftMe: одноразова (і безпечно повторювана) міграція RTDB → Firestore
// ---------------------------------------------------------------------
// Що робить: читає /users з Realtime Database і копіює те саме в
// Firestore за новою схемою (users/{uid} + users/{uid}/entries/{id}).
//
// Що НЕ робить: нічого не видаляє і не змінює в RTDB. Це лише читання
// звідти й запис у Firestore. Сам застосунок після цього скрипта й далі
// читає/пише в RTDB як і раніше — переключення на Firestore буде
// окремим кроком, уже після того, як ти особисто звіриш результат.
//
// Можна запускати повторно скільки завгодно разів — кожен запис у
// Firestore отримує детермінований ID (dateKey + порядковий номер), тому
// повторний запуск ПЕРЕЗАПИШЕ ті самі документи, а не задублює їх.
//
// ---------------------------------------------------------------------
// Як запустити:
//   1) На своєму комп'ютері: npm install firebase-admin
//   2) Firebase Console → Project settings (шестерня зліва вгорі) →
//      Service accounts → Generate new private key.
//      Збережений файл покласти поруч із цим скриптом і назвати
//      serviceAccountKey.json
//      ВАЖЛИВО: додай "serviceAccountKey.json" у .gitignore — це
//      секретний ключ з повним доступом до бази, його не можна
//      комітити в GitHub, навіть у приватний репозиторій.
//   3) Спочатку суха перевірка (нічого не пише, тільки рахує й показує):
//        node migrate-to-firestore.js --dry-run
//   4) Якщо цифри виглядають правильно — сама міграція:
//        node migrate-to-firestore.js
// ---------------------------------------------------------------------

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_PROCESS_ID = 'balancing';

admin.initializeApp({
  credential: admin.cert(serviceAccount),
  databaseURL: 'https://shiftme-18f3a-default-rtdb.europe-west1.firebasedatabase.app',
});

const rtdb = admin.database();
const firestore = admin.firestore();

function buildEntryDoc(entry, dateKey) {
  // Підтримує і старий формат (code/qty/rate напряму на записі), і новий
  // (items[]) — на випадок, якщо хтось мігрує з бекапу до оновлення 0.9.0.
  const items = entry.items || (entry.code
    ? [{ code: entry.code, rate: entry.rate, qty: entry.qty }]
    : []);
  return {
    date: entry.date || dateKey,
    processId: entry.processId || DEFAULT_PROCESS_ID,
    items,
    amount: entry.amount,
    order: entry.order || null,
    time: entry.time || null,
    deleted: entry.deleted === true,
    deletedAt: entry.deletedAt || null,
  };
}

async function migrateUser(uid, userNode) {
  const profile = userNode.profile || {};
  const data = userNode.data || {};
  const earnings = data.earnings || {};
  const goals = data.goals || {};
  const customProducts = data.customProducts || [];
  const leaveDays = data.leaveDays || {};

  const profileDoc = {
    name: profile.name || '',
    email: profile.email || '',
    blocked: profile.blocked === true,
    brigade: profile.brigade === 2 ? 2 : 1,
    shiftType: profile.shiftType === 'night' ? 'night' : 'day',
    firstSeen: profile.firstSeen || null,
    lastSeen: profile.lastSeen || null,
    goals,
    customProducts,
    leaveDays,
  };

  const writes = [];
  Object.keys(earnings).forEach((dateKey) => {
    (earnings[dateKey] || []).forEach((entry, index) => {
      writes.push({
        id: dateKey + '_' + index,
        data: buildEntryDoc(entry, dateKey),
      });
    });
  });

  if (DRY_RUN) {
    return { entries: writes.length, profile: profileDoc };
  }

  await firestore.collection('users').doc(uid).set(profileDoc, { merge: true });

  const CHUNK = 400; // ліміт Firestore — 500 операцій на batch, лишаємо запас
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = firestore.batch();
    writes.slice(i, i + CHUNK).forEach((w) => {
      const ref = firestore.collection('users').doc(uid).collection('entries').doc(w.id);
      batch.set(ref, w.data);
    });
    await batch.commit();
  }

  return { entries: writes.length, profile: profileDoc };
}

async function main() {
  console.log(DRY_RUN ? '=== СУХА ПЕРЕВІРКА (нічого не пишеться) ===' : '=== МІГРАЦІЯ ===');

  const snapshot = await rtdb.ref('users').once('value');
  const allUsers = snapshot.val() || {};
  const uids = Object.keys(allUsers);
  console.log('Знайдено користувачів у RTDB:', uids.length);

  let totalEntries = 0;
  for (const uid of uids) {
    const result = await migrateUser(uid, allUsers[uid]);
    totalEntries += result.entries;
    console.log(
      '✓', uid,
      '— ім\'я:', JSON.stringify(result.profile.name || '(немає)'),
      '· записів:', result.entries
    );
  }

  console.log('---');
  console.log('Всього записів:', totalEntries, 'у', uids.length, 'користувачів.');
  console.log(DRY_RUN
    ? 'Це була суха перевірка — у Firestore нічого не змінилось.'
    : 'Готово. RTDB не змінювалась — лише читання звідти.');
}

main().catch((err) => {
  console.error('Помилка міграції:', err);
  process.exit(1);
});
