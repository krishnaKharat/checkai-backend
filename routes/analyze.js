const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const router   = express.Router();
const { checkLimit, trackUsage } = require('../services/usage');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ─────────────────────────────────────────
   SAPLING — Text AI Detection
   Endpoint : POST https://api.sapling.ai/api/v1/aidetect
   Response : { score, sentence_scores, text }
   score    : 0 (human) → 1 (AI)
───────────────────────────────────────── */
async function detectTextWithSapling(text) {
  const res = await fetch('https://api.sapling.ai/api/v1/aidetect', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key:         process.env.SAPLING_API_KEY,
      text,
      sent_scores: true,   // sentence-level scores for signal breakdown
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Text detection service error');
  }

  const data = await res.json();

  // data.score = 0–1 probability of being AI
  const aiScore      = data.score;                          // e.g. 0.87
  const confidence   = Math.round(aiScore * 100);           // 0–100
  const isAI         = aiScore >= 0.5;

  // Verdict label
  let verdict;
  if (aiScore >= 0.75)      verdict = 'AI Generated';
  else if (aiScore >= 0.45) verdict = 'Uncertain — Review Needed';
  else                      verdict = 'Likely Human';

  // Build signals from sentence scores
  const sentenceScores = data.sentence_scores || [];

  // Aggregate signals for the Truth Meter™ breakdown
  const avgSentenceAI = sentenceScores.length
    ? sentenceScores.reduce((a, s) => a + s.score, 0) / sentenceScores.length
    : aiScore;

  // High-scoring sentences = most AI-like
  const highAISentences = sentenceScores.filter(s => s.score > 0.7).length;
  const totalSentences  = sentenceScores.length || 1;

  const signals = [
    {
      name:    'Overall AI Probability',
      value:   aiScore,
      percent: confidence,
    },
    {
      name:    'Sentence-Level Consistency',
      value:   avgSentenceAI,
      percent: Math.round(avgSentenceAI * 100),
    },
    {
      name:    'High-AI Sentence Ratio',
      value:   highAISentences / totalSentences,
      percent: Math.round((highAISentences / totalSentences) * 100),
    },
    {
      name:    'Writing Pattern Analysis',
      value:   isAI ? Math.min(aiScore + 0.05, 1) : Math.max(aiScore - 0.05, 0),
      percent: Math.round(Math.min(Math.max(isAI ? (aiScore + 0.05) : (aiScore - 0.05), 0), 1) * 100),
    },
  ];

  return {
    confidence,
    verdict,
    isAI,
    signals,
    processingMs: 0,   // will be overwritten below
    type: 'txt',
  };
}

/* ─────────────────────────────────────────
   HIVE — Image / Video AI Detection
───────────────────────────────────────── */
async function detectImageWithHive(fileBuffer, mimeType, filename) {
  const fd = new FormData();
  fd.append('media', fileBuffer, { filename: filename || 'file', contentType: mimeType });

  const res = await fetch(
    'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection',
    {
      method:  'POST',
      headers: { Authorization: `Token ${process.env.HIVE_API_KEY}`, ...fd.getHeaders() },
      body:    fd,
      signal:  AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('[Hive error response]', res.status, err);
    throw new Error('Detection service error');
}
  const data   = await res.json();
  const output = data?.status?.[0]?.response?.output?.[0];
  if (!output) throw new Error('Detection service returned no result');

  const classes = output.classes || [];

  // Find AI-generated score
  const aiClass    = classes.find(c => c.class === 'yes' || c.class === 'ai_generated') || classes[0];
  const humanClass = classes.find(c => c.class === 'no'  || c.class === 'human');

  const aiScore  = aiClass?.score    ?? 0;
  const humanSc  = humanClass?.score ?? (1 - aiScore);

  const confidence = Math.round(aiScore * 100);
  const isAI       = aiScore >= 0.5;

  let verdict;
  if (aiScore >= 0.75)      verdict = 'AI Generated';
  else if (aiScore >= 0.45) verdict = 'Uncertain — Review Needed';
  else                      verdict = 'Likely Human';

  // Map Hive classes to signals
  const signals = classes.slice(0, 6).map(c => ({
    name:    formatSignalName(c.class),
    value:   c.score,
    percent: Math.round(c.score * 100),
  }));

  return { confidence, verdict, isAI, signals, type: 'img' };
}

function formatSignalName(cls) {
  const map = {
    yes:                 'AI Generated Probability',
    no:                  'Human Content Probability',
    ai_generated:        'AI Generated Probability',
    human:               'Human Content Probability',
    deepfake:            'Deepfake Detection',
    face_swap:           'Face Swap Detection',
    gan:                 'GAN Fingerprint',
    diffusion:           'Diffusion Model Signature',
    stable_diffusion:    'Stable Diffusion Pattern',
    midjourney:          'Midjourney Pattern',
    dall_e:              'DALL-E Pattern',
  };
  return map[cls] || cls.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

/* ─────────────────────────────────────────
   MAIN ROUTE  POST /api/analyze
───────────────────────────────────────── */
router.post('/', upload.single('file'), async (req, res) => {
  const start = Date.now();

  try {
    // ── Auth (optional — allows anonymous free scans) ──
    let uid   = null;
    let token = req.headers.authorization?.split('Bearer ')[1];

    if (token) {
      try {
        const admin      = require('../middleware/auth');
        const decoded    = await admin.verifyIdToken(token);
        uid = decoded.uid;
      } catch { /* token invalid — treat as anonymous */ }
    }

    // ── Usage limit check ──
    const limitResult = await checkLimit(uid);
    if (limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    const type = req.body.type;   // 'img' | 'txt' | 'vid' | 'doc'
    let result;

    // ── TEXT detection via Sapling ──
    if (type === 'txt') {
      const text = (req.body.text || '').trim();
    if (!text || text.length < 1) {
        return res.status(400).json({ error: 'Please enter some text.' });
      }
      if (text.length > 200000) {
        return res.status(400).json({ error: 'Text too long. Maximum 200,000 characters.' });
      }
      result = await detectTextWithSapling(text);
    }

    // ── IMAGE detection via Hive ──
    else if (type === 'img') {
      if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
      result = await detectImageWithHive(req.file.buffer, req.file.mimetype, req.file.originalname);
    }

    // ── VIDEO — extract frame then use Hive ──
    else if (type === 'vid') {
      if (!req.file) return res.status(400).json({ error: 'No video file provided.' });
      // Frontend extracts frame as JPEG blob and sends it as 'file'
      result = await detectImageWithHive(req.file.buffer, 'image/jpeg', 'frame.jpg');
      result.type = 'vid';
    }

    // ── DOCUMENT — coming soon ──
    else if (type === 'doc') {
      return res.status(400).json({ error: 'Document detection is coming soon.' });
    }

    else {
      return res.status(400).json({ error: 'Invalid detection type.' });
    }

    result.processingMs = Date.now() - start;

    // ── Track usage ──
    await trackUsage(uid);

    return res.json(result);

  } catch (err) {
    console.error('[analyze error]', err.message);
    // Sanitize — never expose service names
    const msg = err.message || '';
    if (msg.includes('sapling') || msg.includes('Sapling')) {
      return res.status(500).json({ error: 'Detection service error. Please try again.' });
    }
    if (msg.includes('hive') || msg.includes('Hive')) {
      return res.status(500).json({ error: 'Detection service error. Please try again.' });
    }
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

module.exports = router;
