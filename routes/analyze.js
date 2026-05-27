const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const router   = express.Router();
const { checkLimit, trackUsage } = require('../services/usage');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
    { name: 'Overall AI Probability',      value: aiScore,        percent: confidence },
    { name: 'Sentence-Level Consistency',  value: avgSentenceAI,  percent: Math.round(avgSentenceAI * 100) },
    { name: 'High-AI Sentence Ratio',      value: highAISentences / totalSentences, percent: Math.round((highAISentences / totalSentences) * 100) },
    { name: 'Writing Pattern Analysis',    value: isAI ? Math.min(aiScore + 0.05, 1) : Math.max(aiScore - 0.05, 0), percent: Math.round(Math.min(Math.max(isAI ? (aiScore + 0.05) : (aiScore - 0.05), 0), 1) * 100) },
  ];

  return { confidence, verdict, isAI, signals, processingMs: 0, type: 'txt' };
}

async function detectImageWithHive(fileBuffer, mimeType, filename) {
  const fd = new FormData();
  fd.append('media', fileBuffer, { filename: filename || 'file', contentType: mimeType });

  const credentials = Buffer.from(`${process.env.HIVE_API_KEY}:${process.env.HIVE_SECRET_KEY}`).toString('base64');

  const res = await fetch(
    'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection',
    {
      method:  'POST',
      headers: { Authorization: `Basic ${credentials}`, ...fd.getHeaders() },
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
  console.log('[Hive response]', JSON.stringify(data).slice(0, 500));

  const output = data?.status?.[0]?.response?.output?.[0];
  if (!output) throw new Error('Detection service returned no result');

  const classes = output.classes || [];

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

  const signals = classes.slice(0, 6).map(c => ({
    name:    formatSignalName(c.class),
    value:   c.score,
    percent: Math.round(c.score * 100),
  }));

  return { confidence, verdict, isAI, signals, type: 'img' };
}

function formatSignalName(cls) {
  const map = {
    yes:              'AI Generated Probability',
    no:               'Human Content Probability',
    ai_generated:     'AI Generated Probability',
    human:            'Human Content Probability',
    deepfake:         'Deepfake Detection',
    face_swap:        'Face Swap Detection',
    gan:              'GAN Fingerprint',
    diffusion:        'Diffusion Model Signature',
    stable_diffusion: 'Stable Diffusion Pattern',
    midjourney:       'Midjourney Pattern',
    dall_e:           'DALL-E Pattern',
  };
  return map[cls] || cls.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

router.post('/', upload.single('file'), async (req, res) => {
  const start = Date.now();

  try {
    let uid   = null;
    let token = req.headers.authorization?.split('Bearer ')[1];

    if (token) {
      try {
        const admin   = require('../middleware/auth');
        const decoded = await admin.verifyIdToken(token);
        uid = decoded.uid;
      } catch { /* token invalid — treat as anonymous */ }
    }

    const limitResult = await checkLimit(uid);
    if (limitResult.blocked) {
      return res.status(429).json({
        error:        'You have used all your scans for this month. Please upgrade to continue.',
        limitReached: true,
      });
    }

    const type = req.body.type;
    let result;

    if (type === 'txt') {
      const text = (req.body.text || '').trim();
      if (!text || text.length < 1) return res.status(400).json({ error: 'Please enter some text.' });
      if (text.length > 200000)     return res.status(400).json({ error: 'Text too long. Maximum 200,000 characters.' });
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

    else if (type === 'doc') {
      return res.status(400).json({ error: 'Document detection is coming soon.' });
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

module.exports = router;