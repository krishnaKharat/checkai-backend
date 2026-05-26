// services/usage.js
// Tracks scan usage per user in Firestore
// Falls back gracefully if Firestore not available

function getDB() {
  try {
    const { admin } = require('../middleware/auth');
    if (admin && admin.apps.length) return admin.firestore();
  } catch(e) {}
  return null;
}

// Check if user is allowed to scan
// Returns true = allowed, false = limit reached
async function checkLimit(uid) {
  try {
    const db = getDB();
    if (!db) return true; // no DB = allow all

    if (!uid) {
      // Anonymous — use simple allow (rate limiting handled by IP elsewhere)
      return true;
    }

    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return true; // new user = allow

    const data      = doc.data();
    const plan      = data.plan || 'free';
    const monthly   = data.monthlyScans || 0;
    const limits    = { free: 50, pro: 5000, enterprise: 999999 };
    const limit     = limits[plan] || 50;

    return monthly < limit;

  } catch(err) {
    console.error('checkLimit error:', err.message);
    return true; // on error = allow
  }
}

// Track a scan in Firestore
async function trackUsage(uid, scanRecord) {
  try {
    const db = getDB();
    if (!db) return;

    const now = new Date();

    // Save scan to scans collection
    await db.collection('scans').add({
      ...scanRecord,
      uid:       uid || 'anonymous',
      createdAt: now.toISOString()
    });

    // Update user monthly count
    if (uid) {
      const userRef  = db.collection('users').doc(uid);
      const userDoc  = await userRef.get();
      const lastReset = userDoc.exists ? (userDoc.data().lastReset || '') : '';
      const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;

      if (lastReset !== thisMonth) {
        // New month — reset counter
        await userRef.set({
          monthlyScans: 1,
          totalScans:   (userDoc.exists ? (userDoc.data().totalScans || 0) : 0) + 1,
          lastReset:    thisMonth
        }, { merge: true });
      } else {
        // Same month — increment
        await userRef.set({
          monthlyScans: (userDoc.exists ? (userDoc.data().monthlyScans || 0) : 0) + 1,
          totalScans:   (userDoc.exists ? (userDoc.data().totalScans   || 0) : 0) + 1
        }, { merge: true });
      }
    }

  } catch(err) {
    console.error('trackUsage error:', err.message);
    // Non-fatal — don't crash the scan
  }
}

module.exports = { checkLimit, trackUsage };
