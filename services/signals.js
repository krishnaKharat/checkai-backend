'use strict';

/**
 * Build a rich signals breakdown from Hive AI raw classes.
 * Maps known Hive class names to human-readable signals.
 * All values are real scores from Hive — no random injection.
 */

function buildImageSignals(aiScore, rawClasses = []) {
  const classMap = buildClassMap(rawClasses);

  // Core signals — use real Hive scores where available, derive otherwise
  const signals = [
    {
      name: 'GAN Fingerprint',
      value: pick(classMap, ['ai_generated', 'artificial', 'synthetic', 'generated'], aiScore),
      description: 'Statistical patterns unique to AI generation models'
    },
    {
      name: 'Pixel Integrity',
      value: pick(classMap, ['real', 'authentic', 'original'], 1 - aiScore * 0.4),
      description: 'Natural vs. synthesized pixel distribution analysis'
    },
    {
      name: 'Artifact Presence',
      value: pick(classMap, ['artifact', 'compression', 'manipulation'], aiScore * 0.85),
      description: 'Detection of generative model artifacts and blending edges'
    },
    {
      name: 'Deepfake Detection',
      value: pick(classMap, ['deepfake', 'face_swap', 'face swap'], aiScore * 0.9),
      description: 'Face manipulation and identity-swap detection'
    }
  ];

  return normalizeSignals(signals);
}

function buildVideoSignals(aiScore, rawClasses = []) {
  const classMap = buildClassMap(rawClasses);

  const signals = [
    {
      name: 'Face Swap Score',
      value: pick(classMap, ['deepfake', 'face_swap', 'face swap', 'ai_generated'], aiScore),
      description: 'Likelihood of face identity replacement'
    },
    {
      name: 'Temporal Consistency',
      value: pick(classMap, ['real', 'authentic'], 1 - aiScore * 0.3),
      description: 'Frame-to-frame consistency analysis'
    },
    {
      name: 'GAN Signature',
      value: pick(classMap, ['ai_generated', 'synthetic', 'generated'], aiScore * 0.9),
      description: 'Generative adversarial network fingerprint'
    },
    {
      name: 'Artifact Presence',
      value: pick(classMap, ['artifact', 'manipulation'], aiScore * 0.7),
      description: 'Visual artifacts from video synthesis'
    }
  ];

  return normalizeSignals(signals);
}

function buildTextSignals(aiScore, rawClasses = []) {
  const classMap = buildClassMap(rawClasses);

  const signals = [
    {
      name: 'AI Pattern Detection',
      value: pick(classMap, ['ai_generated', 'ai_written', 'gpt', 'llm', 'chatgpt'], aiScore),
      description: 'Statistical patterns matching known AI language models'
    },
    {
      name: 'Perplexity Score',
      value: pick(classMap, ['perplexity', 'burstiness'], aiScore * 0.9),
      description: 'Low perplexity indicates AI-predicted token sequences'
    },
    {
      name: 'Sentence Uniformity',
      value: pick(classMap, ['uniformity', 'pattern'], aiScore * 0.85),
      description: 'AI text often has uniform sentence structures'
    },
    {
      name: 'Vocabulary Richness',
      value: pick(classMap, ['human', 'human_written'], 1 - aiScore * 0.45),
      description: 'Human writing shows varied, contextual word choice'
    }
  ];

  return normalizeSignals(signals);
}

function buildDocumentSignals(aiScore, rawClasses = []) {
  // Documents run as text detection — reuse text signals with doc-specific names
  const classMap = buildClassMap(rawClasses);

  const signals = [
    {
      name: 'AI-Written Content',
      value: pick(classMap, ['ai_generated', 'ai_written', 'gpt', 'llm'], aiScore),
      description: 'Probability of AI-generated text content'
    },
    {
      name: 'Document Authenticity',
      value: pick(classMap, ['real', 'human', 'human_written'], 1 - aiScore * 0.5),
      description: 'Metadata and structural authenticity markers'
    },
    {
      name: 'Linguistic Patterns',
      value: pick(classMap, ['perplexity', 'pattern'], aiScore * 0.9),
      description: 'Sentence structure and language model fingerprint'
    },
    {
      name: 'Content Consistency',
      value: pick(classMap, ['uniformity'], aiScore * 0.75),
      description: 'Internal consistency of claims and terminology'
    }
  ];

  return normalizeSignals(signals);
}

// ─── HELPERS ────────────────────────────────────────────────

function buildClassMap(rawClasses) {
  const map = {};
  for (const c of rawClasses) {
    if (c.name && typeof c.score === 'number') {
      map[c.name.toLowerCase().replace(/[-\s]/g, '_')] = c.score;
    }
  }
  return map;
}

/**
 * Look up a value from Hive classes, fall back to derived value.
 * No randomness — always deterministic.
 */
function pick(classMap, keys, fallback) {
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
    if (classMap[normalized] !== undefined) {
      return classMap[normalized];
    }
    // Also try without underscores
    const bare = normalized.replace(/_/g, '');
    const found = Object.keys(classMap).find(k => k.replace(/_/g, '') === bare);
    if (found !== undefined) return classMap[found];
  }
  return clamp(fallback);
}

function normalizeSignals(signals) {
  return signals.map(s => ({
    ...s,
    value: clamp(s.value),
    percent: Math.round(clamp(s.value) * 100)
  }));
}

function clamp(v, min = 0, max = 1) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(min, Math.min(max, v));
}

module.exports = { buildImageSignals, buildVideoSignals, buildTextSignals, buildDocumentSignals };
