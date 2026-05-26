// middleware/auth.js
// Firebase Admin SDK — verifies user tokens from frontend
// Fixes "Firebase Admin not configured" warning

const admin = require('firebase-admin');

// Only initialize once
if (!admin.apps.length) {
  try {
    // Firebase Admin needs a service account key
    // Get it from: Firebase Console → Project Settings → Service Accounts → Generate New Private Key
    const serviceAccount = {
      type:                        'service_account',
      project_id:                  process.env.FIREBASE_PROJECT_ID,
      private_key_id:              process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key:                 (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      client_email:                process.env.FIREBASE_CLIENT_EMAIL,
      client_id:                   process.env.FIREBASE_CLIENT_ID,
      auth_uri:                    'https://accounts.google.com/o/oauth2/auth',
      token_uri:                   'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url:        process.env.FIREBASE_CERT_URL
    };

    // Check we have the required fields
    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      throw new Error('Missing required Firebase Admin env vars');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log('✅ Firebase Admin initialized for project:', serviceAccount.project_id);

  } catch (err) {
    console.warn('⚠️  Firebase Admin init failed:', err.message);
    console.warn('   Get service account key from Firebase Console → Project Settings → Service Accounts');
    // App continues — auth middleware will allow all requests (anonymous mode)
  }
}

// ── Middleware: verify Firebase ID token from Authorization header ──
// If token missing or invalid → sets req.uid = null (anonymous)
// Frontend must send: Authorization: Bearer <firebase_id_token>
async function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    req.uid  = null;
    req.user = null;
    return next();
  }

  try {
    if (!admin.apps.length) {
      req.uid  = null;
      req.user = null;
      return next();
    }
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid  = decoded.uid;
    req.user = decoded;
    return next();
  } catch (err) {
    // Invalid token — treat as anonymous, don't block request
    req.uid  = null;
    req.user = null;
    return next();
  }
}

module.exports = { verifyToken, admin };
