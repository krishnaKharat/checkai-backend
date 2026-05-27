'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
app.set('trust proxy', 1); // ADD THIS LINE
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://checkai.in', 'https://www.checkai.in', 'http://localhost:3001'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { error: 'Too many requests. Please wait.' }
}));

// Routes
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/user',    require('./routes/user'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      hive:       !!process.env.HIVE_API_KEY,
      sapling:    !!process.env.SAPLING_API_KEY,
      copyleaks:  !!(process.env.COPYLEAKS_EMAIL && process.env.COPYLEAKS_API_KEY),
      firebase:   !!process.env.FIREBASE_PROJECT_ID,
      cashfree:   !!process.env.CASHFREE_APP_ID
    }
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`\n✅ CheckAI backend running on port ${PORT}`);
  console.log(`   Hive AI (image/video): ${process.env.HIVE_API_KEY       ? '✓' : '✗ MISSING'}`);
  console.log(`   Sapling (text):        ${process.env.SAPLING_API_KEY    ? '✓' : '✗ MISSING'}`);
  console.log(`   Copyleaks (docs):      ${process.env.COPYLEAKS_EMAIL    ? '✓' : '✗ MISSING'}`);
  console.log(`   Firebase:              ${process.env.FIREBASE_PROJECT_ID ? '✓' : '✗ MISSING'}`);
  console.log(`   Cashfree:              ${process.env.CASHFREE_APP_ID    ? '✓' : '✗ MISSING'}\n`);
});

module.exports = app;