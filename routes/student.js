// routes/student.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

const { authorize } = require('../middleware/authMiddleware');
const Research = require('../models/Research');

const router = express.Router();

// Helper: normalize keywords
function normalizeKeywords(input) {
  if (Array.isArray(input)) {
    return input.map(String).map(s => s.trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

const FIVE_MIN_MS = 5 * 60 * 1000;

// ✅ FIX 1: Use same directory structure as faculty
const uploadDir = path.join(__dirname, '../uploads/research');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // ✅ 50 MB
  fileFilter: (req, file, cb) => {

    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF or DOCX files allowed'));
  },
});

// ✅ FIX 2: Use same path resolution as faculty
function resolveAbsPathFromDB(storedPath) {
  if (!storedPath) return null;
  const p = String(storedPath).replace(/\\/g, '/');

  if (path.isAbsolute(p)) {
    if (fs.existsSync(p)) return p;
  }

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

const canReadItem = (user, item) => {
  if (item.visibility === 'public') return true;
  if (item.visibility === 'embargo') {
    if (item.embargoUntil && new Date() >= new Date(item.embargoUntil)) return true;
    return false;
  }
  if (item.visibility === 'campus') {
    return user?.affiliation === 'MSU-IIT';
  }
  return (
    user?.role === 'admin' ||
    String(user?.id) === String(item.uploadedBy) ||
    (item.college && user?.college && item.college === user.college) ||
    (Array.isArray(item.allowedViewers) &&
      item.allowedViewers.includes((user?.email || '').toLowerCase()))
  );
};

let transporter;
try {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} catch (e) {
  console.warn('⚠️ Nodemailer transport not configured.');
}

const sendImmediateReceipt = async (sub) => {
  if (!transporter) return;
  await transporter
    .sendMail({
      from: process.env.MAIL_FROM || 'no-reply@yourapp.com',
      to: sub.adviser || process.env.FALLBACK_PROF_EMAIL || sub.author,
      subject: `Submission Received (${(sub.submissionType || 'draft').toUpperCase()}): ${sub.title}`,
      html: `
        <p>A ${sub.submissionType || 'draft'} submission was received and may be revised or deleted by the student within 5 minutes.</p>
        <p><b>Title:</b> ${sub.title}</p>
        <p><b>Author:</b> ${sub.author}</p>
        <p><b>Adviser:</b> ${sub.adviser || 'N/A'}</p>
        <p><b>Status:</b> ${sub.status}</p>
        <p><i>A final email will be sent after the 5-minute window.</i></p>
      `,
    })
    .catch((err) => console.error('❌ Receipt email error:', err));
};

let notifyQueue = null;
let hasRedis = !!process.env.REDIS_HOST;
if (hasRedis) {
  try {
    const { Queue, Worker } = require('bullmq');
    notifyQueue = new Queue('notify', {
      connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379) },
    });

    new Worker(
      'notify',
      async (job) => {
        const { submissionId } = job.data;
        const sub = await Research.findById(submissionId).lean();
        if (!sub) return;

        const elapsedMs = Date.now() - new Date(sub.createdAt).getTime();
        if (elapsedMs < FIVE_MIN_MS) return;

        if (transporter) {
          await transporter.sendMail({
            from: process.env.MAIL_FROM || 'no-reply@yourapp.com',
            to: sub.adviser || process.env.FALLBACK_PROF_EMAIL || sub.author,
            subject: `Finalized Submission (${(sub.submissionType || 'draft').toUpperCase()}): ${sub.title}`,
            html: `
              <p>The submission has been finalized after the 5-minute window.</p>
              <p><b>Title:</b> ${sub.title}</p>
              <p><b>Author:</b> ${sub.author}</p>
              <p><b>Adviser:</b> ${sub.adviser || 'N/A'}</p>
              <p><b>Status:</b> ${sub.status}</p>
              <p><b>Abstract:</b><br/>${(sub.abstract || '').replace(/\n/g, '<br/>')}</p>
            `,
          });
        }
      },
      { connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379) } }
    );
  } catch (e) {
    console.warn('⚠️ BullMQ not available; falling back to in-memory timers.', e?.message || e);
    hasRedis = false;
  }
}

const pendingTimers = new Map();
const queueFinalEmailInMemory = (submissionId, delayMs, sendFn) => {
  if (pendingTimers.has(submissionId)) clearTimeout(pendingTimers.get(submissionId));
  const t = setTimeout(() => {
    pendingTimers.delete(submissionId);
    sendFn().catch((err) => console.error('❌ Final email (fallback) error:', err));
  }, delayMs);
  pendingTimers.set(submissionId, t);
};

const queueFinalEmail = async (submissionId, whenMs = FIVE_MIN_MS) => {
  if (hasRedis && notifyQueue) {
    await notifyQueue.add('send-prof-email', { submissionId }, { delay: whenMs, jobId: `notify-${submissionId}` });
  } else {
    queueFinalEmailInMemory(submissionId, whenMs, async () => {
      const sub = await Research.findById(submissionId).lean();
      if (!sub) return;
      const elapsedMs = Date.now() - new Date(sub.createdAt).getTime();
      if (elapsedMs < FIVE_MIN_MS) return;
      if (transporter) {
        await transporter.sendMail({
          from: process.env.MAIL_FROM || 'no-reply@yourapp.com',
          to: sub.adviser || process.env.FALLBACK_PROF_EMAIL || sub.author,
          subject: `Finalized Submission (${(sub.submissionType || 'draft').toUpperCase()}): ${sub.title}`,
          html: `
            <p>The submission has been finalized after the 5-minute window.</p>
            <p><b>Title:</b> ${sub.title}</p>
            <p><b>Author:</b> ${sub.author}</p>
            <p><b>Adviser:</b> ${sub.adviser || 'N/A'}</p>
            <p><b>Status:</b> ${sub.status}</p>
            <p><b>Abstract:</b><br/>${(sub.abstract || '').replace(/\n/g, '<br/>')}</p>
          `,
        });
      }
    });
  }
};

const cancelFinalEmail = async (submissionId) => {
  if (hasRedis && notifyQueue) {
    try {
      await notifyQueue.remove(`notify-${submissionId}`);
    } catch {}
  } else {
    if (pendingTimers.has(submissionId)) {
      clearTimeout(pendingTimers.get(submissionId));
      pendingTimers.delete(submissionId);
    }
  }
};

/* =========================================================
   ✅ FINAL FIXED: GET /api/student/file/:id
   (stream-safe, header-correct, popup-friendly)
========================================================= */
router.get(
  '/file/:id',
  authorize(['faculty', 'student', 'admin', 'staff']),
  async (req, res) => {
    try {
      const research = await Research.findById(req.params.id).lean();
      if (!research) {
        return res.status(404).json({ error: 'Research not found' });
      }
      if (!research.filePath) {
        return res.status(404).json({ error: 'File not found (no filePath on record)' });
      }

      /* ---------- Permission checks ---------- */
      const email = String(req.user.email || '').toLowerCase();
      const role = req.user.role;
      const isStudent = email === String(research.student || '').toLowerCase();
      const isAuthor = email === String(research.author || '').toLowerCase();
      const isAdviser = email === String(research.adviser || '').toLowerCase();
      const isAdmin = role === 'admin';
      const isFaculty = role === 'faculty';
      const isApproved = research.status === 'approved';
      const isMSUIIT =
        email.endsWith('@g.msuiit.edu.ph') || email.endsWith('@msuiit.edu.ph');

      const canAccess =
        isStudent ||
        isAuthor ||
        isAdviser ||
        isAdmin ||
        (isFaculty && isApproved) ||
        (isApproved &&
          (research.visibility === 'public' ||
            (research.visibility === 'campus' && isMSUIIT)));

      if (!canAccess) {
        console.warn('❌ Access denied:', { user: email, researchId: research._id });
        return res.status(403).json({ error: 'Not authorized to view this file' });
      }

      /* ---------- Resolve file path ---------- */
      const absPath = resolveAbsPathFromDB(research.filePath);
      if (!absPath || !fs.existsSync(absPath)) {
        console.error('❌ File missing on disk:', {
          id: research._id,
          storedPath: research.filePath,
          resolvedPath: absPath,
        });
        return res.status(404).json({ error: 'File not found on server' });
      }

      const stats = fs.statSync(absPath);
      if (stats.size === 0) {
        console.error('❌ File is empty (0 bytes)');
        return res.status(500).json({ error: 'File is empty' });
      }

      console.log('✅ Serving file:', {
        id: research._id,
        size: `${(stats.size / 1024).toFixed(2)} KB`,
        type: research.fileType || 'application/pdf',
        path: absPath,
      });

      /* ---------- Stream safely ---------- */
      res.setHeader('Content-Type', research.fileType || 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(
          research.fileName || 'document.pdf'
        )}"`
      );

      // Important: flush headers before piping
      res.flushHeaders();

      const stream = fs.createReadStream(absPath);
      stream.on('error', (err) => {
        console.error('❌ Stream error:', err);
        if (!res.headersSent) res.status(500).end('Stream error');
      });
      stream.pipe(res);
    } catch (err) {
      console.error('❌ File retrieval error:', err);
      if (!res.headersSent)
        res.status(500).json({ error: 'Error retrieving file' });
    }
  }
);



/* =========================================================
   PUT /api/student/revise/:id
========================================================= */
router.put('/revise/:id', authorize(['student']), upload.single('file'), async (req, res) => {
  try {
    const research = await Research.findOne({ _id: req.params.id, student: req.user.email });
    if (!research) return res.status(404).json({ error: 'Research not found or not owned by this student' });

    const elapsedMs = Date.now() - new Date(research.createdAt).getTime();
    if (elapsedMs > FIVE_MIN_MS) {
      return res.status(403).json({ error: 'You can only revise within 5 minutes after upload.' });
    }

    const { title, abstract, adviser, submissionType, keywords, authors } = req.body;

    if (typeof title === 'string' && title.trim()) research.title = title;
    if (typeof abstract !== 'undefined') research.abstract = abstract;
    if (typeof adviser !== 'undefined') research.adviser = adviser;

    if (submissionType === 'draft' || submissionType === 'final') {
      research.submissionType = submissionType;
    }

    if (typeof keywords !== 'undefined') {
      research.keywords = normalizeKeywords(keywords);
    }

    if (typeof authors !== 'undefined') {
      research.coAuthors = Array.from(
        new Set(
          String(authors || '')
            .split(',')
            .map(a => a.trim())
            .filter(a => a && a !== req.user.email)
        )
      );
    }

    if (req.file && req.file.path) {
      if (research.filePath && fs.existsSync(research.filePath)) {
        try { fs.unlinkSync(research.filePath); } catch {}
      }
      research.filePath = req.file.path;
      research.fileName = req.file.originalname;
      research.fileType = req.file.mimetype;
    }

    research.status = 'pending';
    await research.save();

    await cancelFinalEmail(String(research._id));
    const remaining = Math.max(0, FIVE_MIN_MS - elapsedMs);
    await queueFinalEmail(String(research._id), remaining);

    res.json({ message: 'Revision uploaded successfully', research });
  } catch (err) {
    console.error('❌ Revision failed:', err);
    res.status(500).json({ error: 'Server error revising draft' });
  }
});

/* =========================================================
   DELETE /api/student/delete/:id
========================================================= */
router.delete('/delete/:id', authorize(['student']), async (req, res) => {
  try {
    const research = await Research.findById(req.params.id);
    if (!research) return res.status(404).json({ error: 'Research not found' });
    if (research.student !== req.user.email) {
      return res.status(403).json({ error: 'Not authorized to delete this draft' });
    }

    const elapsed = Date.now() - new Date(research.createdAt).getTime();
    if (elapsed > FIVE_MIN_MS) {
      return res.status(403).json({ error: 'You can only delete drafts within 5 minutes of upload.' });
    }

    await cancelFinalEmail(String(research._id));

    if (research.filePath && fs.existsSync(research.filePath)) {
      try { fs.unlinkSync(research.filePath); } catch {}
    }
    await research.deleteOne();

    res.json({ message: 'Research deleted successfully' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================================================
   GET /api/student/file/download/:id
========================================================= */
router.get('/file/download/:id', authorize(['student']), async (req, res) => {
  try {
    const research = await Research.findById(req.params.id).lean();
    if (!research || !research.filePath) return res.status(404).json({ error: 'File not found' });
    if (!canReadItem(req.user, research)) return res.status(403).json({ error: 'Forbidden' });

    const absPath = resolveAbsPathFromDB(research.filePath);
    if (!absPath || !fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(absPath, research.fileName || 'file');
  } catch (err) {
    console.error('❌ File download error:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

/* =========================================================
   ✅ FIXED: POST /api/student/upload
========================================================= */
router.post(
  '/upload',
  authorize(['student']),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
     if (err && err.code === 'LIMIT_FILE_SIZE') {
  return res.status(400).json({ error: 'File exceeds 50MB limit.' });
}

      if (err && err.message?.includes('Unexpected field')) {
        console.warn('⚠️ Multer ignored field, likely base64 upload.');
        return next();
      }
      if (err) {
        console.error('❌ Upload error:', err);
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const {
        title,
        abstract,
        adviser,
        file,
        visibility,
        embargoUntil,
        college,
        year,
        keywords,
        category,
        submissionType,
        authors,
      } = req.body;

      if (!title || !abstract) {
        return res.status(400).json({ error: 'Title and abstract are required.' });
      }

      const vis = ['public', 'campus', 'private', 'embargo'].includes(visibility) 
        ? visibility 
        : 'private';
      const emb = vis === 'embargo' && embargoUntil ? new Date(embargoUntil) : null;
      const subType = submissionType === 'final' ? 'final' : 'draft';

      const coAuthors = Array.from(
        new Set(
          String(authors || '')
            .split(',')
            .map(a => a.trim())
            .filter(a => a && a !== req.user.email)
        )
      );

      const parsedKeywords = keywords 
        ? String(keywords).split(',').map(k => k.trim()).filter(Boolean)
        : [];

      // FormData upload
      if (req.file && req.file.path) {
        console.log('📤 FormData upload:', {
          path: req.file.path,
          size: `${(req.file.size / 1024).toFixed(2)} KB`,
          exists: fs.existsSync(req.file.path)
        });

        const newResearch = await Research.create({
          title,
          abstract,
          adviser: adviser || '',
          author: req.user.email,
          student: req.user.email,
          coAuthors,
          filePath: req.file.path, // Already absolute
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          status: 'pending',
          submissionType: subType,
          visibility: vis,
          embargoUntil: emb,
          college: college || '',
          year: year || '',
          keywords: parsedKeywords,
          category: category || '',
          uploaderRole: req.user.role,
          uploadedBy: req.user.id,
          source: 'student-upload',
        });

        await sendImmediateReceipt(newResearch);
        await queueFinalEmail(String(newResearch._id), FIVE_MIN_MS);

        return res.status(201).json({ 
          message: 'Research uploaded successfully', 
          research: newResearch 
        });
      }

      // Base64 upload
      if (file && typeof file === 'string' && file.startsWith('data:')) {
        const matches = file.match(/^data:(.+);base64,(.+)$/);
        if (!matches) {
          return res.status(400).json({ error: 'Invalid base64 format' });
        }

        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        // ✅ Enforce same size limit for base64 uploads (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;
if (buffer.length > MAX_FILE_SIZE) {
  return res.status(400).json({ error: 'File exceeds 50MB limit.' });
}


        const ext = mimeType === 'application/pdf' 
          ? '.pdf'
          : mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? '.docx'
          : '';

        if (!ext) {
          return res.status(400).json({ error: 'Unsupported file type' });
        }

        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const fullPath = path.join(uploadDir, uniqueName); // Uses uploads/research

        fs.writeFileSync(fullPath, buffer);

        console.log('📤 Base64 upload:', {
          path: fullPath,
          size: `${(buffer.length / 1024).toFixed(2)} KB`,
          exists: fs.existsSync(fullPath)
        });

        const newResearch = await Research.create({
          title,
          abstract,
          adviser: adviser || '',
          author: req.user.email,
          student: req.user.email,
          coAuthors,
          filePath: fullPath, // Absolute path
          fileName: uniqueName,
          fileType: mimeType,
          status: 'pending',
          submissionType: subType,
          visibility: vis,
          embargoUntil: emb,
          college: college || '',
          year: year || '',
          keywords: parsedKeywords,
          category: category || '',
          uploaderRole: req.user.role,
          uploadedBy: req.user.id,
          source: 'student-upload',
        });

        await sendImmediateReceipt(newResearch);
        await queueFinalEmail(String(newResearch._id), FIVE_MIN_MS);

        return res.status(201).json({ 
          message: 'Research uploaded successfully', 
          research: newResearch 
        });
      }

      return res.status(400).json({ error: 'No valid file uploaded.' });

    } catch (err) {
      console.error('❌ Upload failed:', err);
      res.status(500).json({ error: 'Server error uploading draft' });
    }
  }
);

/* =========================================================
   GET /api/student/my-research
========================================================= */
router.get('/my-research', authorize(['student']), async (req, res) => {
  try {
    const myResearch = await Research.find({ student: req.user.email })
      .sort({ createdAt: -1 })
      .select(
        'title abstract adviser author coAuthors student status submissionType facultyComment fileName fileType createdAt visibility embargoUntil year keywords category college'
      );
    res.json(myResearch);
  } catch (err) {
    console.error('❌ Fetch my research failed:', err);
    res.status(500).json({ error: 'Failed to fetch student research' });
  }
});

/* =========================================================
   GET /api/student/research (proxy to main research route)
========================================================= */
router.get('/research', authorize(['faculty', 'student', 'admin']), async (req, res) => {
  try {
    const axios = require('axios');
    const base = `${req.protocol}://${req.get('host')}/api/research`;
    const r = await axios.get(base, {
      headers: { authorization: req.headers.authorization || '' }
    });
    return res.json(r.data);
  } catch (e) {
    console.error('❌ Proxy /student/research failed:', e?.message || e);
    return res.status(500).json({ error: 'Failed to load approved works' });
  }
});

module.exports = router;