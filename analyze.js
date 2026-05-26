'use strict';
const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { detectText }     = require('../services/saplingService');
const { detectImage, detectVideo } = require('../services/hiveService');
const { detectDocument } = require('../services/copyleaksService');

// Multer: memory storage, 50MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [
      'image/jpeg','image/png','image/webp','image/gif',
      'video/mp4','video/mpeg','video/quicktime','video/webm',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain'
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ── POST /api/analyze/text ────────────────────────────────────────────────────
router.post('/text', async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 50)
      return res.status(400).json({ error: 'Text must be at least 50 characters.' });
    if (text.length > 50000)
      return res.status(400).json({ error: 'Text too long (max 50,000 characters).' });

    const result = await detectText(text);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/analyze/image ───────────────────────────────────────────────────
router.post('/image', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
    const result = await detectImage(req.file.buffer, req.file.mimetype);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/analyze/video ───────────────────────────────────────────────────
router.post('/video', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file provided.' });
    const result = await detectVideo(req.file.buffer, req.file.mimetype);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/analyze/document ────────────────────────────────────────────────
router.post('/document', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No document file provided.' });
    const result = await detectDocument(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
