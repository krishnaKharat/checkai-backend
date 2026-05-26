'use strict';
const fetch    = require('node-fetch');
const FormData = require('form-data');

const HIVE_API_KEY = process.env.HIVE_API_KEY;

// ── Image Detection ──────────────────────────────────────────────────────────
async function detectImage(buffer, mimetype) {
  const fd = new FormData();
  fd.append('image', buffer, { filename: 'upload.jpg', contentType: mimetype || 'image/jpeg' });

  const res = await fetch('https://api.thehive.ai/api/v3/task/sync', {
    method: 'POST',
    headers: { 'Authorization': `Token ${HIVE_API_KEY}`, ...fd.getHeaders() },
    body: fd
  });

  if (!res.ok) throw new Error(`Hive image API error: ${res.status}`);
  const data = await res.json();

  return parseHiveImageResult(data);
}

// ── Video Detection ──────────────────────────────────────────────────────────
async function detectVideo(buffer, mimetype) {
  const fd = new FormData();
  fd.append('video', buffer, { filename: 'upload.mp4', contentType: mimetype || 'video/mp4' });

  // Submit async job
  const submitRes = await fetch('https://api.thehive.ai/api/v3/task/async', {
    method: 'POST',
    headers: { 'Authorization': `Token ${HIVE_API_KEY}`, ...fd.getHeaders() },
    body: fd
  });

  if (!submitRes.ok) throw new Error(`Hive video submit error: ${submitRes.status}`);
  const submitData = await submitRes.json();
  const taskId = submitData?.status?.[0]?.task_id;
  if (!taskId) throw new Error('No task ID returned from Hive');

  // Poll for result (max 60s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`https://api.thehive.ai/api/v3/task/${taskId}`, {
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
    const classes = data?.status?.[0]?.response?.output?.[0]?.classes || [];
    const aiGenerated = classes.find(c => c.class === 'ai_generated');
    const score = aiGenerated ? Math.round(aiGenerated.score * 100) : 0;
    return {
      type: 'image',
      aiScore: score,
      humanScore: 100 - score,
      verdict: score >= 70 ? 'AI Generated' : score >= 40 ? 'Possibly AI' : 'Likely Human',
      details: classes.map(c => ({ label: c.class, score: Math.round(c.score * 100) })),
      raw: data
    };
  } catch {
    return { type: 'image', aiScore: 0, humanScore: 100, verdict: 'Unknown', details: [], raw: data };
  }
}

function parseHiveVideoResult(data) {
  try {
    const frames = data?.status?.[0]?.response?.output || [];
    let totalAI = 0, count = 0;
    frames.forEach(frame => {
      const classes = frame?.classes || [];
      const aiGen = classes.find(c => c.class === 'ai_generated');
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
  } catch {
    return { type: 'video', aiScore: 0, humanScore: 100, verdict: 'Unknown', framesAnalyzed: 0, raw: data };
  }
}

module.exports = { detectImage, detectVideo };
