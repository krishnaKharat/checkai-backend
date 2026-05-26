'use strict';
const fetch = require('node-fetch');

const SAPLING_KEY = process.env.SAPLING_API_KEY;

async function detectText(text) {
  const res = await fetch('https://api.sapling.ai/api/v1/aidetect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: SAPLING_KEY, text })
  });
  if (!res.ok) throw new Error(`Sapling API error: ${res.status}`);
  const data = await res.json();

  const aiScore   = Math.round((data.score || 0) * 100);
  const humanScore = 100 - aiScore;

  return {
    type: 'text',
    aiScore,
    humanScore,
    verdict: aiScore >= 70 ? 'AI Generated' : aiScore >= 40 ? 'Possibly AI' : 'Likely Human',
    sentences: (data.sentence_scores || []).map(([sentence, score]) => ({
      text: sentence,
      aiScore: Math.round(score * 100)
    })),
    raw: data
  };
}

module.exports = { detectText };
