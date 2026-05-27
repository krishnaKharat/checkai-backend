'use strict';
const fetch    = require('node-fetch');
const FormData = require('form-data');

const HIVE_API_KEY = process.env.HIVE_API_KEY;

// ── Image Detection ──────────────────────────────────────────────────────────
async function detectImage(buffer, mimetype) {
  const fd = new FormData();
  fd.append('image', buffer, { filename: 'upload.jpg', contentType: mimetype || 'image/jpeg' });

  const res = await fetch('https://api.thehive.ai/api/v2/task/sync', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${HIVE_API_KEY}`,
      ...fd.getHeaders()
    },
    body: fd
  });

  const text = await res.text();
  console.log('[Hive image raw response]', text);

  if (!res.ok) throw new Error(`Hive image API error: ${res.status} - ${text}`);

  const data = JSON.parse(text);
  return parseHiveImageResult(data);
}

// ── Video Detection ──────────────────────────────────────────────────────────
async function detectVideo(buffer, mimetype) {
  const fd = new FormData();
  fd.append('video', buffer, { filename: 'upload.mp4', contentType: mimetype || 'video/mp4' });

  const submitRes = await fetch('https://api.thehive.ai/api/v2/task/async', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${HIVE_API_KEY}`,
      ...fd.getHeaders()
    },
    body: fd
  });

  const submitText = await submitRes.text();
  console.log('[Hive video submit raw]', submitText);

  if (!submitRes.ok) throw new Error(`Hive video submit error: ${submitRes.status} - ${submitText}`);

  const submitData = JSON.parse(submitText);
  const taskId = submitData?.status?.[0]?.task_id;
  if (!taskId) throw new Error('No task ID returned from Hive');

  // Poll for result (max 60s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.thehive.ai/api/v2/task/${taskId}`, {
      headers: { 'Authorization': `Token ${HIVE_API_KEY}` }
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    const state = pollData?.status?.[0]?.status?.code;
    if (state === 'fulfilled') return parseHiveVideoResult(pollData);
    if (state === 'failed') throw new Error('Hive video task failed');
  }
  throw new Error('Hive video detection timed out');
}

// ── Result Parsers ────────────────────────────────────────────────────────────
function parseHiveImageResult(data) {
  try {
    console.log('[Hive parse] full data:', JSON.stringify(data).slice(0, 500));
    const classes = data?.status?.[0]?.response?.output?.[0]?.classes || [];
    console.log('[Hive parse] classes:', JSON.stringify(classes));

    const aiGenerated = classes.find(c =>
      c.class === 'ai_generated' ||
      c.class === 'yes' ||
      c.class === 'ai-generated'
    );
    const score = aiGenerated ? Math.round(aiGenerated.score * 100) : 0;

    return {
      type: 'image',
      aiScore: score,
      humanScore: 100 - score,
      verdict: score >= 70 ? 'AI Generated' : score >= 40 ? 'Possibly AI' : 'Likely Human',
      details: classes.map(c => ({ label: c.class, score: Math.round(c.score * 100) })),
      raw: data
    };
  } catch (e) {
    console.error('[Hive parse error]', e.message);
    return { type: 'image', aiScore: 0, humanScore: 100, verdict: 'Unknown', details: [], raw: data };
  }
}

function parseHiveVideoResult(data) {
  try {
    const frames = data?.status?.[0]?.response?.output || [];
    let totalAI = 0, count = 0;
    frames.forEach(frame => {
      const classes = frame?.classes || [];
      const aiGen = classes.find(c =>
        c.class === 'ai_generated' ||
        c.class === 'yes'
      );
      if (aiGen) { totalAI += aiGen.score; count++; }
    });
    const score = count ? Math.round((totalAI / count) * 100) : 0;
    return {
      type: 'video',
      aiScore: score,
      humanScore: 100 - score,
      verdict: score >= 70 ? 'AI Generated' : score >= 40 ? 'Possibly AI' : 'Likely Human',
      framesAnalyzed: count,
      raw: data
    };
  } catch (e) {
    console.error('[Hive video parse error]', e.message);
    return { type: 'video', aiScore: 0, humanScore: 100, verdict: 'Unknown', framesAnalyzed: 0, raw: data };
  }
}

module.exports = { detectImage, detectVideo };