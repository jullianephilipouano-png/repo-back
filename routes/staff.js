const express = require('express');
const { authorize } = require('../middleware/authMiddleware');
const Research = require('../models/Research');

const router = express.Router();

/* =========================================================
   📋 Fetch all faculty-approved research (for staff)
========================================================= */
router.get('/approved', authorize(['staff', 'admin']), async (req, res) => {
  try {
    const approved = await Research.find({ status: 'approved', source: 'faculty-approved' })
      .sort({ updatedAt: -1 })
      .select('title author adviser updatedAt fileName visibility embargoUntil');
    res.json(approved);
  } catch (err) {
    console.error('❌ Failed to fetch approved list:', err);
    res.status(500).json({ error: 'Failed to fetch approved research' });
  }
});

/* =========================================================
   📤 Staff upload new research (metadata-only here)
   (Use your file upload route in /api/research for PDFs)
========================================================= */
router.post('/upload', authorize(['staff', 'admin']), async (req, res) => {
  try {
    const { title, author, year, abstract, keywords, category, visibility, embargoUntil, college } = req.body;
    if (!title || !author)
      return res.status(400).json({ error: 'Title and author are required' });

    const vis = ['public','campus','private','embargo'].includes(visibility) ? visibility : 'public';

    const newResearch = new Research({
      title,
      author,
      year: year || '',
      abstract: abstract || '',
      keywords: keywords ? String(keywords).split(',').map(k => k.trim()).filter(Boolean) : [],
      category: category || '',
      status: 'approved',
      uploaderRole: 'staff',
      source: 'staff-upload',
      uploadedBy: req.user.id,
      visibility: vis,
      embargoUntil: vis === 'embargo' && embargoUntil ? new Date(embargoUntil) : null,
      college: college || '',
    });

    await newResearch.save();
    res.status(201).json({ message: '✅ Research uploaded successfully', research: newResearch });
  } catch (err) {
    console.error('❌ Upload failed:', err);
    res.status(500).json({ error: 'Failed to upload research' });
  }
});

module.exports = router;
