// routes/faculty.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');

const { authorize } = require('../middleware/authMiddleware');
const Research = require('../models/Research');

/* -------------------------------------------
   Robust path resolver (absolute + /uploads/…)
-------------------------------------------- */
function resolveAbsPathFromDB(storedPath) {
  if (!storedPath) return null;
  const p = String(storedPath).replace(/\\/g, '/');

  if (path.isAbsolute(p)) return p;

  const candidates = [];
  const trimmed = p.replace(/^\/+/, '');
  candidates.push(path.resolve(path.join(__dirname, '..', trimmed)));
  candidates.push(path.resolve(path.join(__dirname, '..', 'uploads', 'research', path.basename(p))));
  candidates.push(path.resolve(path.join(process.cwd(), trimmed)));

  for (const abs of candidates) {
    if (fs.existsSync(abs)) return abs;
  }
  return candidates[0];
}

function safeUnlink(absPath) {
  try { if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch {}
}

/* ================================
   Email (optional, graceful if off)
================================ */
let transporter;
try {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('✅ Faculty email transporter ready');
} catch (e) {
  console.warn('⚠️ Nodemailer not configured for faculty routes.');
}

const notify = async ({ to, subject, html }) => {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@yourapp.com',
      to: Array.isArray(to) ? to.join(',') : to,
      subject,
      html,
    });
  } catch (e) {
    console.error('❌ Email send failed:', e?.message || e);
  }
};

/* ================================
   Multer: /uploads/research
================================ */
const uploadDir = path.join(__dirname, '../uploads/research');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const safeBase = (file.originalname || 'document').replace(/[^a-z0-9._-]+/gi, '_');
    const withExt = path.extname(safeBase) ? safeBase : `${safeBase}${path.extname(file.originalname || '') || '.pdf'}`;
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${withExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const okExt = ['.pdf', '.docx', '.doc'];
    const okMime = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/octet-stream',
    ];
    if (okExt.includes(ext) || okMime.includes((file.mimetype || '').toLowerCase())) return cb(null, true);
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file');
    err.message = 'Only PDF or DOC/DOCX files allowed';
    return cb(err);
  },
});

/* Small helper */
const toKeywords = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
};

/* =========================================================
   GET /api/faculty/preview/:id
========================================================= */
router.get('/preview/:id', authorize(['faculty', 'admin']), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id).lean();
    if (!r || !r.filePath) {
      return res.status(404).json({ error: 'File not found' });
    }

    /* ---------- Authorization ---------- */
    const email = String(req.user.email || '').toLowerCase();
    const isOwner   = email === String(r.author || '').toLowerCase();
    const isAdviser = email === String(r.adviser || '').toLowerCase();
    const isAdmin   = req.user.role === 'admin';

    if (!isOwner && !isAdviser && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to preview this file' });
    }

    /* ---------- Resolve file path ---------- */
    const filePath = resolveAbsPathFromDB(r.filePath);
    if (!filePath || !fs.existsSync(filePath)) {
      console.error('❌ Preview file missing:', {
        id: r._id,
        stored: r.filePath,
        resolved: filePath,
      });
      return res.status(404).json({ error: 'File not found on server' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    /* ---------- RANGE REQUEST (CRITICAL) ---------- */
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416)
          .setHeader('Content-Range', `bytes */${fileSize}`)
          .end();
        return;
      }

      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': r.fileType || 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(
          r.fileName || 'document.pdf'
        )}"`,
      });

      stream.pipe(res);
      return;
    }

    /* ---------- NO RANGE (fallback) ---------- */
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': r.fileType || 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(
        r.fileName || 'document.pdf'
      )}"`,
    });

    fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error('❌ Faculty preview error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to preview file' });
    }
  }
});


/* =========================================================
   POST /api/faculty/my-research
   - draft → pending (faculty-upload)
   - final → approved (faculty-approved) + email staff
========================================================= */
router.post('/my-research', authorize(['faculty', 'admin']), upload.single('file'), async (req, res) => {
  try {
    const {
      title,
      abstract,
      visibility,
      embargoUntil,
      year,
      keywords,
      category,
      college,
      submissionType, // 'draft' | 'final'
       coAuthors,     
    } = req.body;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const vis = ['public', 'campus', 'private', 'embargo'].includes((visibility || '').toLowerCase())
      ? (visibility || '').toLowerCase()
      : 'private';
    const subType = submissionType === 'final' ? 'final' : 'draft';

    // ✅ Require abstract for FINAL
    if (subType === 'final' && !(String(abstract || '').trim())) {
      return res.status(400).json({ error: 'Abstract is required for FINAL submissions' });
    }

     // ✅ Sanitize coAuthors — remove current user, duplicates, empty
    const parsedCoAuthors = Array.from(
      new Set(
        (Array.isArray(coAuthors)
          ? coAuthors
          : String(coAuthors || '').split(/[;,]/)) // allow comma or semicolon
          .map(a => a.trim().toLowerCase())
          .filter(a => a && a !== String(req.user.email || '').toLowerCase())
      )
    );

    const doc = new Research({
      title: String(title).trim(),
      abstract: String(abstract || '').trim(), // ✅ trimmed
      author: req.user.email,
      coAuthors: parsedCoAuthors,   
      adviser: '',
      student: '',
      year: year || '',
      keywords: toKeywords(keywords),          // ✅ robust
      category: category || '',
      college: college || '',
      uploaderRole: req.user.role,
      uploadedBy: req.user.id,
      source: subType === 'final' ? 'faculty-approved' : 'faculty-upload',
      status: subType === 'final' ? 'approved' : 'pending',
      visibility: vis,
      embargoUntil: vis === 'embargo' && embargoUntil ? new Date(embargoUntil) : null,
      submissionType: subType,
    });

    if (req.file) {
      const ext = (path.extname(req.file.originalname) || '').toLowerCase();
      const safeMime =
        req.file.mimetype && req.file.mimetype !== 'application/octet-stream'
          ? req.file.mimetype
          : (ext === '.pdf'
              ? 'application/pdf'
              : (ext === '.doc'
                  ? 'application/msword'
                  : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));

      doc.filePath = req.file.path; // absolute
      doc.fileName = req.file.originalname || path.basename(req.file.path);
      doc.fileType = safeMime;

      console.log('📄 Faculty upload:', {
        savedAbsPath: doc.filePath,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        normalized: safeMime,
        size: req.file.size,
        submissionType: subType,
      });
    }

    await doc.save();

    if (subType === 'final') {
      const staffList = (process.env.STAFF_PUBLISH_EMAILS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const recipients = [...new Set([req.user.email, ...staffList].filter(Boolean))];

      await notify({
        to: recipients,
        subject: `Final Approved for Publishing: ${doc.title}`,
        html: `
          <p>A faculty final submission has been posted and is ready for publishing.</p>
          <p><b>Title:</b> ${doc.title}</p>
          <p><b>Author:</b> ${doc.author}</p>
          <p><b>Co-Authors:</b> ${parsedCoAuthors.join(', ') || 'None'}</p>
          <p><b>Abstract:</b><br/>${(doc.abstract || '').replace(/\n/g, '<br/>')}</p>
        `,
      });
    }

    return res.status(201).json({
      message: subType === 'final'
        ? 'Faculty final saved and forwarded to staff'
        : 'Faculty draft saved for safekeeping',
      research: doc,
    });
  } catch (err) {
    console.error('❌ Faculty create failed:', err);
    return res.status(500).json({ error: 'Failed to create research' });
  }
});

/* =========================================================
   PUT /api/faculty/my-research/:id  (edit)
   - Block edits if already forwarded to staff (source = faculty-approved)
   - If switching to FINAL, require non-empty abstract
========================================================= */
router.put('/my-research/:id', authorize(['faculty', 'admin']), upload.single('file'), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });

    const isOwner = String(r.author || '').toLowerCase() === String(req.user.email || '').toLowerCase();
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (r.source === 'faculty-approved') {
      return res.status(409).json({ error: 'This item has been forwarded to staff. Please request staff to update.' });
    }

    const { title, abstract, submissionType, coAuthors } = req.body;

    if (typeof title === 'string' && title.trim()) r.title = title.trim();
    if (typeof abstract !== 'undefined') r.abstract = String(abstract || '').trim();

    // ✅ Handle coAuthors update
    if (typeof coAuthors !== 'undefined') {
      r.coAuthors = Array.from(
        new Set(
          (Array.isArray(coAuthors)
            ? coAuthors
            : String(coAuthors || '').split(/[;,]/))
            .map(a => a.trim().toLowerCase())
            .filter(a => a && a !== String(req.user.email || '').toLowerCase())
        )
      );
    }

    // ✅ Handle submissionType update
    if (submissionType === 'draft' || submissionType === 'final') {
      const nextType = submissionType;
      const nextAbstract = typeof abstract !== 'undefined'
        ? String(abstract || '').trim()
        : String(r.abstract || '').trim();

      if (nextType === 'final' && !nextAbstract) {
        return res.status(400).json({ error: 'Abstract is required for FINAL submissions' });
      }
      r.submissionType = nextType;
    }

    // ✅ File replacement
    if (req.file) {
      safeUnlink(resolveAbsPathFromDB(r.filePath));

      const ext = (path.extname(req.file.originalname) || '').toLowerCase();
      const safeMime =
        req.file.mimetype && req.file.mimetype !== 'application/octet-stream'
          ? req.file.mimetype
          : ext === '.pdf'
          ? 'application/pdf'
          : ext === '.doc'
          ? 'application/msword'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      r.filePath = req.file.path;
      r.fileName = req.file.originalname || path.basename(req.file.path);
      r.fileType = safeMime;
    }

    await r.save();
    res.json({ message: 'Updated', research: r });
  } catch (err) {
    console.error('❌ Faculty update failed:', err);
    res.status(500).json({ error: 'Failed to update research' });
  }
});


/* =========================================================
   DELETE /api/faculty/my-research/:id
========================================================= */
router.delete('/my-research/:id', authorize(['faculty', 'admin']), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });

    const isOwner = String(r.author || '').toLowerCase() === String(req.user.email || '').toLowerCase();
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (r.source === 'faculty-approved') {
      return res.status(409).json({ error: 'This item has been forwarded to staff. Please request staff to remove it.' });
    }

    safeUnlink(resolveAbsPathFromDB(r.filePath));
    await r.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('❌ Faculty delete failed:', err);
    res.status(500).json({ error: 'Failed to delete research' });
  }
});

/* =========================================================
   GET /api/faculty/my-research
========================================================= */
router.get('/my-research', authorize(['faculty', 'admin']), async (req, res) => {
  try {
    const research = await Research.find({
      author: req.user.email,
      source: { $in: ['faculty-upload', 'faculty-approved'] },
    })
      .sort({ createdAt: -1 })
      .select(
        'title abstract status visibility embargoUntil year keywords category college fileName fileType createdAt updatedAt uploaderRole submissionType source'
      );
    res.json(research);
  } catch (err) {
    console.error('❌ Fetch research failed:', err);
    res.status(500).json({ error: 'Failed to fetch research' });
  }
});

/* =========================================================
   GET /api/faculty/student-submissions
   → Show all submissions where the logged-in faculty is the adviser
   → Include coAuthors for transparency in multi-member works
========================================================= */
router.get('/student-submissions', authorize(['faculty', 'admin']), async (req, res) => {
  try {
    const subs = await Research.find({ adviser: req.user.email })
      .sort({ createdAt: -1 })
      .select(
        'title abstract author coAuthors student status year keywords category fileName fileType createdAt updatedAt visibility embargoUntil submissionType'
      )
      .lean();

    res.json(subs);
  } catch (err) {
    console.error('❌ Fetch student submissions failed:', err);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});


/* =========================================================
   PUT /api/faculty/review/:id
========================================================= */
router.put('/review/:id', authorize(['faculty', 'admin']), async (req, res) => {
  try {
    const { decision, comment } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }

    const research = await Research.findById(req.params.id);
    if (!research) return res.status(404).json({ error: 'Submission not found' });

    research.status = decision;
    research.facultyComment = comment || '';
    await research.save();

    if (decision === 'approved') {
      if (research.submissionType === 'draft') {
        await notify({
          to: research.student || research.author,
          subject: `Draft Approved: ${research.title}`,
          html: `
            <p>Your draft has been approved by faculty.</p>
            <p><b>Title:</b> ${research.title}</p>
            <p><b>Status:</b> APPROVED</p>
            <p><i>Note: Draft approvals are not forwarded for publishing.</i></p>
          `,
        });
      } else {
        const staffList = (process.env.STAFF_PUBLISH_EMAILS || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

        const recipients = [...new Set([
          research.student || research.author,
          research.adviser,
          ...staffList,
        ].filter(Boolean))];

        await notify({
          to: recipients,
          subject: `Final Approved for Publishing: ${research.title}`,
          html: `
            <p>A final submission has been approved and is ready for publishing.</p>
            <p><b>Title:</b> ${research.title}</p>
            <p><b>Author:</b> ${research.author}</p>
            <p><b>Adviser:</b> ${research.adviser || 'N/A'}</p>
            <p><b>Abstract:</b><br/>${(research.abstract || '').replace(/\n/g, '<br/>')}</p>
          `,
        });

        research.source = 'faculty-approved';
        await research.save();
      }
    } else {
      await notify({
        to: research.student || research.author,
        subject: `Submission Rejected: ${research.title}`,
        html: `
          <p>Your submission has been rejected.</p>
          <p><b>Title:</b> ${research.title}</p>
          <p><b>Feedback:</b><br/>${(research.facultyComment || 'No comment').replace(/\n/g, '<br/>')}</p>
        `,
      });
    }

    res.json({ message: `✅ Research ${decision} successfully`, research });
  } catch (err) {
    console.error('❌ Review failed:', err);
    res.status(500).json({ error: 'Failed to review submission' });
  }
});

/* =========================================================
   GET /api/faculty/approved-list
========================================================= */
router.get('/approved-list', authorize(['staff', 'admin']), async (req, res) => {
  try {
    const approved = await Research.find({
      status: 'approved',
      submissionType: 'final',
      source: 'faculty-approved',
    })
      .sort({ updatedAt: -1 })
      .select([
        'title',
        'author',
         'coAuthors',
        'adviser',
        'updatedAt',
        'fileName',
        'visibility',
        'embargoUntil',
        'submissionType',
        '+abstract',
        '+year',
        '+keywords',
        '+categories',
        '+genreTags',
      ].join(' '))
      .lean();

    res.json(approved);
  } catch (err) {
    console.error('❌ Fetch approved list failed:', err);
    res.status(500).json({ error: 'Failed to fetch approved research' });
  }
});

/* =========================================================
   Multer error handler
========================================================= */
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max 20 MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Only PDF or DOC/DOCX files allowed' });
    }
    return res.status(400).json({ error: err.message || 'File upload error' });
  }
  if (err && err.message && /Only PDF|DOCX/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

/* =========================================================
   GET /api/faculty/approved/:id  (detail for staff/admin)
========================================================= */
router.get('/approved/:id', authorize(['staff','admin']), async (req, res) => {
  try {
    const r = await Research.findOne({
      _id: req.params.id,
      status: 'approved',
      submissionType: 'final',
      source: 'faculty-approved',
    })
      .select(
        'title author adviser updatedAt fileName fileType visibility embargoUntil submissionType abstract year keywords categories genreTags category filePath'
      )
      .lean();

    if (!r) return res.status(404).json({ error: 'Approved item not found' });
    return res.json(r);
  } catch (err) {
    console.error('❌ Fetch approved detail failed:', err);
    return res.status(500).json({ error: 'Failed to fetch approved detail' });
  }
});

module.exports = router;
