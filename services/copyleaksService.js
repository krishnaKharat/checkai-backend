'use strict';
const fetch = require('node-fetch');

const COPYLEAKS_EMAIL  = process.env.COPYLEAKS_EMAIL;
const COPYLEAKS_KEY    = process.env.COPYLEAKS_API_KEY;
const BASE_AUTH        = 'https://id.copyleaks.com';
const BASE             = 'https://api.copyleaks.com';

let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await fetch(`${BASE_AUTH}/v3/account/login/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: COPYLEAKS_EMAIL, key: COPYLEAKS_KEY })
  });
  if (!res.ok) throw new Error(`Copyleaks auth failed: ${res.status}`);
  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _token;
}

async function detectDocument(buffer, filename, mimetype) {
  const token = await getToken();
  const scanId = `checkai-${Date.now()}`;
  const base64 = buffer.toString('base64');

  const submitRes = await fetch(`${BASE}/v3/writer-detector/${scanId}/check`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      base64: base64,
      filename: filename || 'document.pdf',
      sandbox: false
    })
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Copyleaks submit error: ${submitRes.status} - ${err}`);
  }

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resultRes = await fetch(`${BASE}/v3/writer-detector/${scanId}/result`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (resultRes.status === 404) continue;
    if (!resultRes.ok) throw new Error(`Copyleaks result error: ${resultRes.status}`);
    const result = await resultRes.json();
    return parseCopyleaksResult(result, filename);
  }
  throw new Error('Copyleaks document detection timed out');
}

function parseCopyleaksResult(data, filename) {
  try {
    const summary = data?.summary;
    const aiScore = summary ? Math.round(summary.ai * 100) : 0;
    const humanScore = summary ? Math.round(summary.human * 100) : 100;

    const sections = (data?.results || []).map(r => ({
      text: r.text?.substring(0, 200),
      aiScore: Math.round((r.classifications?.ai || 0) * 100),
      humanScore: Math.round((r.classifications?.human || 0) * 100)
    }));

    return {
      type: 'document',
      filename: filename || 'document',
      aiScore,
      humanScore,
      verdict: aiScore >= 70 ? 'AI Generated' : aiScore >= 40 ? 'Possibly AI' : 'Likely Human',
      sections,
      wordsAnalyzed: data?.scannedDocument?.totalWords || 0,
      raw: data
    };
  } catch {
    return { type: 'document', aiScore: 0, humanScore: 100, verdict: 'Unknown', sections: [], raw: data };
  }
}

module.exports = { detectDocument };