const fetch = require('node-fetch');

const FACT_CHECK_ENDPOINT = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

const TRUSTED_DOMAINS = {
  'reuters.com': 92,
  'apnews.com': 91,
  'bbc.com': 88,
  'bbc.co.uk': 88,
  'thehindu.com': 84,
  'indianexpress.com': 82,
  'hindustantimes.com': 78,
  'timesofindia.indiatimes.com': 74,
  'ndtv.com': 76,
  'business-standard.com': 80,
  'livemint.com': 78,
  'pib.gov.in': 88,
  'who.int': 92,
  'un.org': 90,
  'gov.in': 84,
  'nic.in': 84
};

const LOW_TRUST_HINTS = [
  'blogspot.', 'wordpress.', 'telegram.', 'whatsapp.', 'truth', 'viral',
  'breakingnow', 'rumor', 'rumour', 'unconfirmed', 'click', 'dailybuzz'
];

const SENSATIONAL_TERMS = [
  'shocking', 'secret', 'exposed', 'you will not believe', 'breaking',
  'miracle', 'banned', 'hidden truth', 'mainstream media', 'urgent',
  'share before deleted', '100% proof', 'guaranteed', 'massive scam',
  'dangerous', 'viral', 'conspiracy'
];

const UNCERTAINTY_TERMS = [
  'allegedly', 'reportedly', 'sources say', 'unconfirmed', 'rumor',
  'rumour', 'may have', 'might have', 'could be', 'claims that'
];

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractDomain(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(sourceUrl) ? sourceUrl : `https://${sourceUrl}`;
    const host = new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, '');
    return host;
  } catch {
    return null;
  }
}

function getPublisherInfo(domain) {
  if (!domain) {
    return {
      domain: null,
      trustScore: 50,
      reliabilityRating: 'Unknown source',
      publisherInfo: 'No publisher URL was provided, so source reputation could not be verified.'
    };
  }

  const exact = TRUSTED_DOMAINS[domain];
  const suffix = Object.keys(TRUSTED_DOMAINS).find(d => domain === d || domain.endsWith(`.${d}`));
  let score = exact || (suffix ? TRUSTED_DOMAINS[suffix] : 58);

  if (LOW_TRUST_HINTS.some(h => domain.includes(h))) score = Math.min(score, 38);
  if (domain.endsWith('.gov') || domain.endsWith('.edu')) score = Math.max(score, 82);

  let reliabilityRating = 'Mixed/unknown reliability';
  if (score >= 85) reliabilityRating = 'High reliability';
  else if (score >= 70) reliabilityRating = 'Generally reliable';
  else if (score >= 50) reliabilityRating = 'Needs corroboration';
  else reliabilityRating = 'Low reliability';

  return {
    domain,
    trustScore: clamp(score),
    reliabilityRating,
    publisherInfo: suffix
      ? `Matched known source profile: ${suffix}.`
      : 'No trusted-source profile matched; credibility is estimated from domain signals.'
  };
}

function extractClaims(text) {
  const clean = normalizeText(text);
  const parts = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 24);

  const candidates = parts.length ? parts : [clean];
  return candidates
    .sort((a, b) => scoreClaimCandidate(b) - scoreClaimCandidate(a))
    .slice(0, 5)
    .map(s => s.slice(0, 280));
}

function scoreClaimCandidate(sentence) {
  let score = Math.min(sentence.length / 20, 10);
  if (/\d/.test(sentence)) score += 2;
  if (/\b(said|announced|claimed|reported|killed|arrested|launched|approved|banned)\b/i.test(sentence)) score += 2;
  if (/\b(who|what|when|where|why|how)\b/i.test(sentence)) score -= 2;
  return score;
}

function ratingToScore(rating) {
  const r = String(rating || '').toLowerCase();
  if (/\b(true|correct|accurate|mostly true)\b/.test(r)) return 90;
  if (/\b(mixture|mixed|partly true|half true|needs context)\b/.test(r)) return 55;
  if (/\b(misleading|missing context|exaggerated|mostly false)\b/.test(r)) return 35;
  if (/\b(false|fake|fabricated|hoax|pants on fire|incorrect)\b/.test(r)) return 12;
  return 50;
}

function scoreToStatus(score) {
  if (score >= 75) return 'Real';
  if (score >= 52) return 'Unverified';
  if (score >= 28) return 'Misleading';
  return 'Fake';
}

function scoreToRisk(score) {
  if (score >= 75) return 'Low';
  if (score >= 52) return 'Medium';
  if (score >= 28) return 'High';
  return 'Critical';
}

async function searchFactChecks(text) {
  const key = process.env.GOOGLE_FACT_CHECK_API_KEY;
  if (!key) return { enabled: false, matches: [] };

  const query = normalizeText(text).slice(0, 480);
  const params = new URLSearchParams({
    key,
    query,
    languageCode: 'en',
    pageSize: '5'
  });

  const res = await fetch(`${FACT_CHECK_ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Google Fact Check error]', res.status, body.slice(0, 300));
    return { enabled: true, error: 'Fact-check search failed', matches: [] };
  }

  const data = await res.json();
  const claims = Array.isArray(data.claims) ? data.claims : [];
  const matches = claims.flatMap(claim => {
    const reviews = Array.isArray(claim.claimReview) ? claim.claimReview : [];
    return reviews.map(review => ({
      claim: claim.text || query,
      claimant: claim.claimant || '',
      claimDate: claim.claimDate || '',
      organization: review.publisher?.name || 'Unknown fact-checker',
      rating: review.textualRating || 'Unrated',
      title: review.title || '',
      url: review.url || '',
      checkedAt: review.reviewDate || claim.claimDate || '',
      score: ratingToScore(review.textualRating)
    }));
  }).slice(0, 5);

  return { enabled: true, matches };
}

function analyzeLanguage(text) {
  const clean = normalizeText(text);
  const lower = clean.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) || [];
  const sentences = clean.split(/[.!?]+/).filter(Boolean);
  const sensationalHits = SENSATIONAL_TERMS.filter(term => lower.includes(term));
  const uncertaintyHits = UNCERTAINTY_TERMS.filter(term => lower.includes(term));
  const allCapsWords = (clean.match(/\b[A-Z]{4,}\b/g) || []).length;
  const exclamations = (clean.match(/!/g) || []).length;
  const urlCount = (clean.match(/https?:\/\//gi) || []).length;
  const numberCount = (clean.match(/\b\d+([.,]\d+)?%?\b/g) || []).length;

  let risk = 18;
  risk += sensationalHits.length * 9;
  risk += uncertaintyHits.length * 5;
  risk += Math.min(allCapsWords * 3, 15);
  risk += Math.min(exclamations * 4, 16);
  if (words.length < 8) risk += 8;
  if (numberCount > 0) risk -= 4;
  if (urlCount > 0) risk -= 3;
  if (sentences.length >= 3) risk -= 4;

  const credibilityScore = clamp(100 - risk);
  const summary = [];
  if (sensationalHits.length) summary.push(`Sensational terms detected: ${sensationalHits.slice(0, 4).join(', ')}.`);
  if (uncertaintyHits.length) summary.push(`Uncertainty language detected: ${uncertaintyHits.slice(0, 4).join(', ')}.`);
  if (allCapsWords || exclamations) summary.push('Formatting suggests emotional emphasis or urgency.');
  if (!summary.length) summary.push('Language is relatively neutral, but external corroboration is still recommended.');

  return {
    credibilityScore,
    misinformationRisk: clamp(risk),
    summary: summary.join(' '),
    indicators: {
      sensationalTerms: sensationalHits,
      uncertaintyTerms: uncertaintyHits,
      allCapsWords,
      exclamations,
      sentenceCount: sentences.length,
      wordCount: words.length,
      numericClaims: numberCount,
      links: urlCount
    }
  };
}

function combineScores(factChecks, aiAnalysis, sourceCredibility) {
  const hasFactChecks = factChecks.length > 0;
  const factScore = hasFactChecks
    ? Math.round(factChecks.reduce((sum, item) => sum + item.score, 0) / factChecks.length)
    : null;

  const trustScore = hasFactChecks
    ? clamp((factScore * 0.58) + (aiAnalysis.credibilityScore * 0.24) + (sourceCredibility.trustScore * 0.18))
    : clamp((aiAnalysis.credibilityScore * 0.68) + (sourceCredibility.trustScore * 0.32));

  const confidence = hasFactChecks ? clamp(78 + Math.min(factChecks.length * 4, 16)) : clamp(52 + Math.abs(trustScore - 50) * 0.45);
  const verificationStatus = hasFactChecks ? 'Fact-check match found' : 'No direct fact-check found';

  return {
    trustScore,
    confidence,
    verificationStatus,
    verdict: scoreToStatus(trustScore),
    riskLevel: scoreToRisk(trustScore),
    factScore
  };
}

async function analyzeNewsContent({ text, sourceUrl }) {
  const clean = normalizeText(text);
  if (clean.length < 8) throw new Error('Please enter a news headline, article, claim, or post.');
  if (clean.length > 20000) throw new Error('News content too long. Maximum 20,000 characters.');

  const domain = extractDomain(sourceUrl);
  const sourceCredibility = getPublisherInfo(domain);
  const keyClaims = extractClaims(clean);
  const factCheckResult = await searchFactChecks(keyClaims[0] || clean);
  const aiAnalysis = analyzeLanguage(clean);
  const combined = combineScores(factCheckResult.matches, aiAnalysis, sourceCredibility);

  const signals = [
    { name: 'Overall trust score', value: combined.trustScore / 100, percent: combined.trustScore },
    { name: 'AI credibility analysis', value: aiAnalysis.credibilityScore / 100, percent: aiAnalysis.credibilityScore },
    { name: 'Source credibility', value: sourceCredibility.trustScore / 100, percent: sourceCredibility.trustScore },
    { name: 'Misinformation risk', value: aiAnalysis.misinformationRisk / 100, percent: aiAnalysis.misinformationRisk },
  ];
  if (combined.factScore !== null) {
    signals.splice(1, 0, { name: 'Fact-check rating score', value: combined.factScore / 100, percent: combined.factScore });
  }

  const detailedExplanation = factCheckResult.matches.length
    ? `Found ${factCheckResult.matches.length} related fact-check result(s). The final score combines published fact-check ratings, language risk signals, and source credibility.`
    : 'No direct Google Fact Check match was found. The final score is based on claim extraction, language risk signals, and source credibility. Treat this as decision support, not a final journalistic ruling.';

  return {
    type: 'news',
    confidence: combined.trustScore,
    verdict: combined.verdict,
    isAI: combined.verdict === 'Fake' || combined.verdict === 'Misleading',
    riskLevel: combined.riskLevel,
    verificationStatus: combined.verificationStatus,
    confidenceLevel: combined.confidence,
    signals,
    keyClaims,
    factChecks: factCheckResult.matches,
    factCheckSearch: {
      enabled: factCheckResult.enabled,
      error: factCheckResult.error || null
    },
    aiAnalysis,
    sourceCredibility,
    detailedExplanation,
    shareText: `CheckAI News Verification: ${combined.verdict} (${combined.trustScore}/100 trust, ${combined.riskLevel} risk)`,
    processingMs: 0
  };
}

module.exports = { analyzeNewsContent };