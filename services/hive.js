const fetch = require('node-fetch');
const FormData = require('form-data');

const HIVE_KEY = process.env.HIVE_SECRET_KEY;
const IMAGE_URL = 'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection';

async function detectImage(imageBuffer, mimeType) {
  const fd = new FormData();
  fd.append('media', imageBuffer, { contentType: mimeType, filename: 'image.jpg' });
  const res = await fetch(IMAGE_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + HIVE_KEY, ...fd.getHeaders() },
    body: fd,
  });
  const text = await res.text();
  console.log('[Hive Image] status=' + res.status + ' body=' + text.slice(0, 800));
  if (res.status !== 200) throw new Error('Hive image failed (' + res.status + '): ' + text);
  return parseImageResult(JSON.parse(text));
}

function parseImageResult(json) {
  try {
    var output = json.output || (json.status && json.status[0] && json.status[0].response && json.status[0].response.output);
    if (!output || !output.length) return fallbackResult();
    var classes = output[0].classes || [];
    var aiClass = null;
    var notAiClass = null;
    for (var i = 0; i < classes.length; i++) {
      if (classes[i].class === 'ai_generated') aiClass = classes[i];
      if (classes[i].class === 'not_ai_generated') notAiClass = classes[i];
    }
    var aiScore = aiClass ? aiClass.value : (notAiClass ? 1 - notAiClass.value : 0.5);
    var isAI = aiScore >= 0.5;
    return {
      isAI: isAI,
      confidence: aiScore * 100,
      label: isAI ? 'AI-Generated' : 'Likely Human',
      rawClasses: classes,
    };
  } catch (e) {
    console.error('[Hive] Parse error: ' + e.message);
    return { isAI: false, confidence: 0, label: 'Parse error', rawClasses: [] };
  }
}

async function detectText(text) {
  console.log('[Text] Running pattern analysis...');
  return analyzeTextLocally(text);
}

function analyzeTextLocally(text) {
  var sentences = text.split(/[.!?]+/).filter(function(s) { return s.trim().length > 10; });
  var words = text.toLowerCase().split(/\s+/);
  var totalWords = words.length;

  // Signal 1: AI phrases
  var aiPhrases = [
    'it is important to', 'it is worth noting', 'in conclusion', 'furthermore',
    'moreover', 'in addition', 'it should be noted', 'this is because',
    'as a result', 'in summary', 'to summarize', 'in other words',
    'it is essential', 'plays a crucial role', 'it is crucial',
    'delve into', 'dive into', 'leverage', 'utilize', 'facilitate',
    'it is imperative', 'one must consider', 'a wide range of',
    'in today\'s world', 'in the modern world', 'needless to say',
    'it goes without saying', 'as mentioned earlier', 'as previously stated'
  ];
  var phraseCount = 0;
  var lowerText = text.toLowerCase();
  for (var i = 0; i < aiPhrases.length; i++) {
    if (lowerText.includes(aiPhrases[i])) phraseCount++;
  }
  var phraseScore = Math.min(1, phraseCount / 4);

  // Signal 2: Sentence length uniformity (AI tends to be uniform)
  var sentenceLengths = sentences.map(function(s) { return s.trim().split(/\s+/).length; });
  var avgLen = sentenceLengths.reduce(function(a, b) { return a + b; }, 0) / (sentenceLengths.length || 1);
  var variance = sentenceLengths.reduce(function(acc, l) { return acc + Math.pow(l - avgLen, 2); }, 0) / (sentenceLengths.length || 1);
  var stdDev = Math.sqrt(variance);
  var uniformityScore = Math.max(0, 1 - (stdDev / 8));

  // Signal 3: Passive voice and formal connectors
  var formalWords = ['therefore', 'however', 'nevertheless', 'consequently', 'subsequently',
    'additionally', 'alternatively', 'specifically', 'particularly', 'significantly',
    'essentially', 'fundamentally', 'comprehensively', 'systematically'];
  var formalCount = 0;
  for (var j = 0; j < formalWords.length; j++) {
    var regex = new RegExp('\\b' + formalWords[j] + '\\b', 'gi');
    var matches = text.match(regex);
    if (matches) formalCount += matches.length;
  }
  var formalScore = Math.min(1, formalCount / (totalWords / 50));

  // Signal 4: Punctuation variety (humans use more varied punctuation)
  var hasExclamation = (text.match(/!/g) || []).length;
  var hasDash = (text.match(/—|-{2}/g) || []).length;
  var hasEllipsis = (text.match(/\.\.\./g) || []).length;
  var punctuationVariety = Math.min(1, (hasExclamation + hasDash + hasEllipsis) / 3);
  var punctuationScore = 1 - punctuationVariety;

  // Combine signals
  var aiScore = (phraseScore * 0.40) + (uniformityScore * 0.25) + (formalScore * 0.20) + (punctuationScore * 0.15);
  aiScore = Math.max(0, Math.min(1, aiScore));

  console.log('[Text] phraseScore=' + phraseScore.toFixed(2) + ' uniformity=' + uniformityScore.toFixed(2) + ' formal=' + formalScore.toFixed(2) + ' punct=' + punctuationScore.toFixed(2) + ' final=' + aiScore.toFixed(2));

  return {
    isAI: aiScore >= 0.5,
    confidence: aiScore * 100,
    label: aiScore >= 0.5 ? 'AI-Generated Text' : 'Likely Human-Written',
    rawClasses: [
      { class: 'ai_generated', value: aiScore },
      { class: 'not_ai_generated', value: 1 - aiScore }
    ],
  };
}

function fallbackResult() {
  return { isAI: false, confidence: 0, label: 'Unable to parse result', rawClasses: [] };
}

module.exports = { detectImage, detectText };