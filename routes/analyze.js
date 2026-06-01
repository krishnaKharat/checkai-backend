const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const router   = express.Router();
const { checkLimit, trackUsage } = require('../services/usage');
const { analyzeNewsContent } = require('../services/newsDetectionService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function detectTextWithSapling(text) {
  const res = await fetch('https://api.sapling.ai/api/v1/aidetect', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key:         process.env.SAPLING_API_KEY,
      text,
      sent_scores: true,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Sapling error]', res.status, err);
    throw new Error('Text detection service error');
  }

  const data = await res.json();
  const aiScore    = data.score;
  const confidence = Math.round(aiScore * 100);
  const isAI       = aiScore >= 0.5;

  let verdict;
  if (aiScore >= 0.75)      verdict = 'AI Generated';
  else if (aiScore >= 0.45) verdict = 'Uncertain — Review Needed';
  else                      verdict = 'Likely Human';

  const sentenceScores  = data.sentence_scores || [];
  const avgSentenceAI   = sentenceScores.length
    ? sentenceScores.reduce((a, s) => a + s.score, 0) / sentenceScores.length
    : aiScore;
  const highAISentences = sentenceScores.filter(s => s.score > 0.7).length;
  const totalSentences  = sentenceScores.length || 1;

  const signals = [
    { name: 'Overall AI Probability',     value: aiScore,       percent: confidence },
    { name: 'Sentence-Level Consistency', value: avgSentenceAI, percent: Math.round(avgSentenceAI * 100) },
    { name: 'High-AI Sentence Ratio',     value: highAISentences / totalSentences, percent: Math.round((highAISentences / totalSentences) * 100) },
    { name: 'Writing Pattern Analysis',   value: isAI ? Math.min(aiScore + 0.05, 1) : Math.max(aiScore - 0.05, 0), percent: Math.round(Math.min(Math.max(isAI ? (aiScore + 0.05) : (aiScore - 0.05), 0), 1) * 100) },
  ];

  return { confidence, verdict, isAI, signals, processingMs: 0, type: 'txt' };
}

async function detectImageWithHive(fileBuffer, mimeType, filename) {
  const fd = new FormData();
  fd.append('media', fileBuffer, { filename: filename || 'file', contentType: mimeType });

  const res = await fetch(
    'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection',
    {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${process.env.HIVE_SECRET_KEY}`,
        ...fd.getHeaders()
      },
      body:   fd,
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('[Hive error response]', res.status, err);
    throw new Error('Detection service error');
  }

  const data = await res.json();
  console.log('[Hive response]', JSON.stringify(data).slice(0, 500));

  const output = data?.output?.[0];
  if (!output) throw new Error('Detection service returned no result');

  const classes = output.classes || [];

  const aiClass = classes.find(c => c.class === 'ai_generated');
  const aiScore = aiClass?.value ?? 0;

  const confidence = Math.round(aiScore * 100);
  const isAI       = aiScore >= 0.5;

  let verdict;
  if (aiScore >= 0.75)      verdict = 'AI Generated';
  else if (aiScore >= 0.45) verdict = 'Uncertain — Review Needed';
  else                      verdict = 'Likely Human';

  const signals = classes.slice(0, 6).map(c => ({
    name:    formatSignalName(c.class),
    value:   c.value,
    percent: Math.round(c.value * 100),
  }));

  return { confidence, verdict, isAI, signals, type: 'img' };
}

function formatSignalName(cls) {
  const map = {
    ai_generated:           'AI Generated Probability',
    not_ai_generated:       'Human Content Probability',
    deepfake:               'Deepfake Detection',
    face_swap:              'Face Swap Detection',
    gan:                    'GAN Fingerprint',
    diffusion:              'Diffusion Model Signature',
    stable_diffusion:       'Stable Diffusion Pattern',
    midjourney:             'Midjourney Pattern',
    dall_e:                 'DALL-E Pattern',
    ai_generated_audio:     'AI Generated Audio',
    not_ai_generated_audio: 'Human Audio',
  };
  return map[cls] || cls.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getUID(req) {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return null;
    const { admin } = require('../middleware/auth');
    if (!admin.apps.length) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

// ── POST /api/analyze  (image, video, text) ───────────────────────────────────

router.post('/', upload.single('file'), async (req, res) => {
  const start = Date.now();
  try {
    const uid         = await getUID(req);
    const limitResult = await checkLimit(uid);
    if (limitResult === false || limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    const type = req.body.type;
    let result;

    if (type === 'txt') {
      const text = (req.body.text || '').trim();
      if (!text)             return res.status(400).json({ error: 'Please enter some text.' });
      if (text.length > 200000) return res.status(400).json({ error: 'Text too long. Maximum 200,000 characters.' });
      result = await detectTextWithSapling(text);
    }

    else if (type === 'img') {
      if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
      result = await detectImageWithHive(req.file.buffer, req.file.mimetype, req.file.originalname);
    }

    else if (type === 'vid') {
      if (!req.file) return res.status(400).json({ error: 'No video file provided.' });
      result = await detectImageWithHive(req.file.buffer, 'image/jpeg', 'frame.jpg');
      result.type = 'vid';
    }

    else {
      return res.status(400).json({ error: 'Invalid detection type.' });
    }

    result.processingMs = Date.now() - start;
    await trackUsage(uid);
    return res.json(result);

  } catch (err) {
    console.error('[analyze error]', err.message);
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// ── POST /api/analyze/document ────────────────────────────────────────────────

router.post('/document', upload.single('document'), async (req, res) => {
  const start = Date.now();
  try {
    const uid         = await getUID(req);
    const limitResult = await checkLimit(uid);
    if (limitResult === false || limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    if (!req.file) return res.status(400).json({ error: 'No document file provided.' });

    const { detectDocument } = require('../services/copyleaksService');
    const result = await detectDocument(req.file.buffer, req.file.originalname, req.file.mimetype);

    await trackUsage(uid);
    return res.json({
      aiPercent:    result.aiScore,
      humanPercent: result.humanScore,
      label:        result.verdict,
      processingMs: Date.now() - start,
      sections:     result.sections,
      wordsAnalyzed: result.wordsAnalyzed,
    });

  } catch (err) {
    console.error('[document analyze error]', err.message);
    return res.status(500).json({ error: 'Document analysis failed. Please try again.' });
  }
});

// ── POST /api/analyze/video ───────────────────────────────────────────────────

router.post('/video', upload.single('video'), async (req, res) => {
  const start = Date.now();
  try {
    const uid         = await getUID(req);
    const limitResult = await checkLimit(uid);
    if (limitResult === false || limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    if (!req.file) return res.status(400).json({ error: 'No video file provided.' });

    const result = await detectImageWithHive(req.file.buffer, 'image/jpeg', 'frame.jpg');

    await trackUsage(uid);
    return res.json({
      aiPercent:   result.confidence,
      label:       result.verdict,
      isAI:        result.isAI,
      signals:     result.signals,
      processingMs: Date.now() - start,
    });

  } catch (err) {
    console.error('[video analyze error]', err.message);
    return res.status(500).json({ error: 'Video analysis failed. Please try again.' });
  }
});

// ── POST /api/analyze/audio ───────────────────────────────────────────────────

router.post('/audio', upload.single('audio'), async (req, res) => {
  const start = Date.now();
  try {
    const uid         = await getUID(req);
    const limitResult = await checkLimit(uid);
    if (limitResult === false || limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    if (!req.file) return res.status(400).json({ error: 'No audio file provided.' });

    // Use Hive for audio detection
    const fd = new FormData();
    fd.append('media', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });

    const res2 = await fetch(
      'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection',
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${process.env.HIVE_SECRET_KEY}`, ...fd.getHeaders() },
        body:    fd,
        signal:  AbortSignal.timeout(120000),
      }
    );

    if (!res2.ok) {
      const err = await res2.text();
      console.error('[Hive audio error]', res2.status, err);
      throw new Error('Audio detection service error');
    }

    const data   = await res2.json();
    const output = data?.output?.[0];
    if (!output) throw new Error('No result from audio detection');

    const classes    = output.classes || [];
    const aiClass    = classes.find(c => c.class === 'ai_generated_audio' || c.class === 'ai_generated');
    const aiScore    = aiClass?.value ?? 0;
    const confidence = Math.round(aiScore * 100);
    const isAI       = aiScore >= 0.5;

    let verdict;
    if (aiScore >= 0.75)      verdict = 'AI Generated';
    else if (aiScore >= 0.45) verdict = 'Uncertain — Review Needed';
    else                      verdict = 'Likely Human';

    const signals = classes.slice(0, 6).map(c => ({
      name:    formatSignalName(c.class),
      value:   c.value,
      percent: Math.round(c.value * 100),
    }));

    await trackUsage(uid);
    return res.json({
      aiPercent:   confidence,
      label:       verdict,
      isAI,
      signals,
      processingMs: Date.now() - start,
    });

  } catch (err) {
    console.error('[audio analyze error]', err.message);
    return res.status(500).json({ error: 'Audio analysis failed. Please try again.' });
  }
});


// POST /api/analyze/news
router.post('/news', async (req, res) => {
  const start = Date.now();
  try {
    const uid = await getUID(req);
    const limitResult = await checkLimit(uid);
    if (limitResult === false || limitResult.blocked) {
      return res.status(429).json({
        error: 'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    const text = (req.body.text || '').trim();
    const sourceUrl = (req.body.sourceUrl || '').trim();
    const result = await analyzeNewsContent({ text, sourceUrl });
    result.processingMs = Date.now() - start;

    await trackUsage(uid, {
      type: 'news',
      name: text.slice(0, 140),
      verdict: result.verdict,
      confidence: result.confidence,
      riskLevel: result.riskLevel,
      sourceDomain: result.sourceCredibility?.domain || null
    });

    return res.json(result);
  } catch (err) {
    console.error('[news analyze error]', err.message);
    const status = /too long|please enter/i.test(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || 'News analysis failed. Please try again.' });
  }
});
module.exports = router;
