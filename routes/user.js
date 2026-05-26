// routes/user.js
const express = require('express');
const router  = express.Router();

// Safe import
let verifyToken;
try {
  verifyToken = require('../middleware/auth').verifyToken;
} catch(e) {
  verifyToken = (req, res, next) => next();
}

// Safe Firestore access
function getDB() {
  try {
    const { admin } = require('../middleware/auth');
    if (admin.apps.length) return admin.firestore();
  } catch(e) {}
  return null;
}

// GET /api/user/profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    if (!req.uid) return res.status(401).json({ error: 'Not logged in' });

    const db = getDB();
    let userData = { uid: req.uid, plan: 'free', scans: 0 };

    if (db) {
      const doc = await db.collection('users').doc(req.uid).get();
      if (doc.exists) userData = { ...userData, ...doc.data() };
    }

    res.json({ success: true, user: userData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/history
router.get('/history', verifyToken, async (req, res) => {
  try {
    if (!req.uid) return res.status(401).json({ error: 'Not logged in' });

    const db = getDB();
    if (!db) return res.json({ success: true, scans: [] });

    const snap = await db.collection('scans')
      .where('uid', '==', req.uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const scans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, scans });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/usage
router.get('/usage', verifyToken, async (req, res) => {
  try {
    if (!req.uid) return res.json({ used: 0, limit: 5, plan: 'anonymous' });

    const db = getDB();
    let used = 0;

    if (db) {
      const doc = await db.collection('users').doc(req.uid).get();
      if (doc.exists) used = doc.data().monthlyScans || 0;
    }

    res.json({ success: true, used, limit: 50, plan: 'free' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
