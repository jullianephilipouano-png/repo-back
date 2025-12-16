// routes/research.js
const express = require("express");
const { authorize, authorizeOrSig } = require("../middleware/authMiddleware");
const Research = require("../models/Research");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");

const router = express.Router();

const SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET || "change-me";
const MSUIIT_DOMAIN = "@g.msuiit.edu.ph";

/* -------------------------------------------
   Robust path resolver for anything in filePath
-------------------------------------------- */
function resolveAbsPathFromDB(storedPath) {
  if (!storedPath) return null;
  const p = String(storedPath).replace(/\\/g, "/");

  if (p.startsWith("/uploads/")) {
    return path.resolve(path.join(__dirname, "..", `.${p}`));
  }
  if (p.startsWith("./")) return path.resolve(path.join(__dirname, "..", p));
  if (p.startsWith("uploads/")) return path.resolve(path.join(__dirname, "..", p));

  if (path.isAbsolute(p)) {
    if (fs.existsSync(p)) return p;
    const baseName = path.basename(p);
    const rebased = path.resolve(path.join(__dirname, "..", "uploads", "research", baseName));
    if (fs.existsSync(rebased)) return rebased;
    return p;
  }

  return path.resolve(path.join(__dirname, "..", "uploads", "research", p));
}

/* small helper to build absolute API base for links */
function publicBase(req) {
  return (process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get("host")}/api`).replace(/\/+$/,'');
}

/* -------------------------------------------
   Helpers: parsing + visibility access control
-------------------------------------------- */
function toArray(csvOrArr) {
  if (!csvOrArr) return [];
  if (Array.isArray(csvOrArr)) {
    return csvOrArr.map(s => String(s).trim()).filter(Boolean);
  }
  return String(csvOrArr)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

// friendlier wrappers
const toKeywords = (v) => toArray(v);
const toCats     = (v) => toArray(v);
const toTags     = (v) => toArray(v);

function sameEmail(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function userDomain(email) {
  const e = String(email || "").toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at) : "";
}

function isOwnerStaffOrAdviser(r, user) {
  const email = String(user?.email || "").toLowerCase();
  const userId = String(user?.id || "");
  const role = String(user?.role || "").toLowerCase();

  const isOwnerEmail =
    [String(r.student || "").toLowerCase(), String(r.author || "").toLowerCase()].includes(email);
  const isUploader = String(r.uploadedBy || "") === userId;
  const isStaff = role === "staff" || role === "admin";
  const isAdviser = !!email && sameEmail(email, r.adviser);

  return isOwnerEmail || isUploader || isStaff || isAdviser;
}

/** Centralized gate for viewing a research file or generating a signed link. */
function canView(r, user) {
  if (isOwnerStaffOrAdviser(r, user)) return true;

  const viewerEmail = String(user?.email || "").toLowerCase();
  const viewerDomain = userDomain(viewerEmail);

  const vis = (r.visibility || "campus").toLowerCase();
  const embargoUntil = r.embargoUntil ? new Date(r.embargoUntil) : null;
  const now = new Date();

  if (vis === "embargo") {
    if (embargoUntil && now < embargoUntil) return false;
    return viewerDomain === MSUIIT_DOMAIN;
  }

  if (vis === "public") {
    return true; // any authenticated user
  }

  if (vis === "campus") {
    return viewerDomain === MSUIIT_DOMAIN;
  }

  if (vis === "private") {
    const allow = Array.isArray(r.allowedViewers) ? r.allowedViewers.map(String) : [];
    return allow.map(e => e.toLowerCase()).includes(viewerEmail);
  }

  // default fallback (treat like campus)
  return viewerDomain === MSUIIT_DOMAIN;
}

/* =========================================================
   LIST approved (role-scoped)
========================================================= */
router.get("/", authorize(), async (req, res) => {
  try {
    const email = String(req.user.email || "").toLowerCase();
    const userId = String(req.user.id || "");
    const role = String(req.user.role || "").toLowerCase();

    let filter;
    if (role === "student") {
      filter = {
        status: "approved",
        $or: [{ student: email }, { author: email }, { uploadedBy: userId }],
      };
    } else if (role === "staff" || role === "admin") {
      filter = {
        status: "approved",
        $or: [{ uploaderRole: { $in: ["staff", "admin"] } }, { uploadedBy: userId }],
      };
    } else {
      filter = {
        status: "approved",
        $or: [{ uploaderRole: { $in: ["staff", "admin"] } }, { uploadedBy: userId }],
      };
    }

    const list = await Research.find(filter)
      .sort({ updatedAt: -1 })
      .select(
        [
          "title",
          "abstract",
          "adviser",
          "author",
          "coAuthors",   
          "student",
          "status",
          "submissionType",
          "fileName",
          "fileType",
          "createdAt",
          "uploadedBy",
          "visibility",
          "embargoUntil",
          "allowedViewers",
          "uploaderRole",
          "year",
          "keywords",
          "category",
          "categories",
          "genreTags"
        ].join(" ")
      )
      .lean();

    res.json(list);
  } catch (err) {
    console.error("❌ Failed to fetch approved research:", err);
    res.status(500).json({ error: "Failed to fetch approved research" });
  }
});

/* =========================================================
   Multer config (PDF only) — RELAXED FILTER
========================================================= */
const uploadDir = path.join(__dirname, "../uploads/research");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const rawName = file.originalname || "document";
    const hasExt = path.extname(rawName);
    const safeBase = rawName.replace(/[^a-z0-9._-]+/gi, "_");
    const finalName = hasExt ? safeBase : `${safeBase}.pdf`;
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${finalName}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // ✅ 50 MB

  fileFilter: (_, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();
    const ext = (path.extname(file.originalname || "").toLowerCase());
    const okMime = mime === "application/pdf" || mime === "application/octet-stream";
    const okExt = ext === ".pdf";
    if (!okMime && !okExt) {
      return cb(new Error("Only PDF files are allowed (.pdf)"));
    }
    cb(null, true);
  },
});

/* =========================================================
   STAFF/ADMIN upload (auto-approved)  ✅ taxonomy normalized
========================================================= */
router.post(
  "/upload",
  authorize(["staff", "admin"]),
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File exceeds 50MB limit." });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {

    try {
      const {
        title,
        author,
         coAuthors, 
        year,
        keywords,
        abstract,
        category,      // legacy single category (string)
        categories,    // new: array or csv
        genreTags,     // new: array or csv
        visibility,
        embargoUntil
      } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      if (!title || !author) {
        return res.status(400).json({ error: "Title and author are required" });
      }

      // Normalize filename/type
      const origName = req.file.originalname || "document.pdf";
      const hasExt = path.extname(origName);
      const normalizedName = hasExt ? origName : `${origName}.pdf`;
      const normalizedType = "application/pdf";

      // ✅ normalize taxonomy
      let cats = toCats(categories);
      if (category && !cats.includes(String(category))) {
        cats.push(String(category));
      }
      let tags = toTags(genreTags);

      const doc = new Research({
        title: String(title).trim(),
        author: String(author).trim(),
         coAuthors: toArray(coAuthors),  
        year: year ? String(year).trim() : undefined,
        abstract: String(abstract || "").trim(),
        keywords: toKeywords(keywords),
        category: category || undefined,   // keep legacy for older UIs
        categories: cats,                  // new array
        genreTags: tags,                   // new array
        status: "approved",
        fileName: normalizedName,
        filePath: `/uploads/research/${req.file.filename}`,
        fileType: normalizedType,
        uploadedBy: req.user.id,
        uploaderRole: req.user.role,
        visibility: ["public", "campus", "private", "embargo"].includes((visibility || "").toLowerCase())
          ? (visibility || "").toLowerCase()
          : "campus",
        embargoUntil: (visibility || "").toLowerCase() === "embargo" && embargoUntil ? new Date(embargoUntil) : null,
        allowedViewers: [],
      });

      await doc.save();
      res.status(201).json({ message: "✅ Uploaded successfully", research: doc });
    } catch (err) {
      console.error("❌ Staff upload error:", err);
      const msg = err?.message?.includes("Only PDF files")
        ? "Only PDF files are allowed (.pdf)."
        : "Failed to upload research";
      res.status(500).json({ error: msg });
    }
  }
);

/* =========================================================
   🎟️ Mint short-lived signed preview URL — honors visibility
========================================================= */
router.get("/file/:id/signed", authorize(), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id).lean();
    if (!r || r.status !== "approved") {
      return res.status(404).json({ error: "Not found" });
    }

    if (!canView(r, req.user)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const sig = jwt.sign(
      { sub: req.user.id, fileId: String(r._id) },
      SIGNED_URL_SECRET,
      { expiresIn: "2m" }
    );

    const url = `${publicBase(req)}/research/file/${r._id}?sig=${encodeURIComponent(sig)}`;
    return res.json({ url, expiresIn: 120 });
  } catch (err) {
    console.error("❌ signed URL error:", err);
    return res.status(500).json({ error: "Failed to create signed URL" });
  }
});

/* =========================================================
   🔒 File streamer — honors visibility (and signed links)
========================================================= */
router.get("/file/:id", authorizeOrSig(), async (req, res) => {
  let fileStream = null;
  
  try {
    // 1. Validate and fetch research document
    const r = await Research.findById(req.params.id).lean();
    if (!r || !r.filePath || r.status !== "approved") {
      console.warn("❌ File request rejected:", { 
        id: req.params.id, 
        exists: !!r, 
        hasPath: !!r?.filePath, 
        status: r?.status 
      });
      return res.status(404).json({ error: "File not found" });
    }

    // 2. Check authorization
    if (req.user?._signedUrl) {
      const claimed = String(req.user?._sig?.fileId || "");
      if (claimed !== String(req.params.id)) {
        console.warn("❌ Invalid signed URL:", {
          claimed,
          requested: req.params.id,
          userEmail: req.user?.email
        });
        return res.status(403).json({ error: "Signed link does not match file" });
      }
    } else {
      if (!canView(r, req.user)) {
        console.warn("❌ Access denied:", {
          fileId: r._id,
          userRole: req.user?.role,
          userEmail: req.user?.email,
          visibility: r.visibility
        });
        return res.status(403).json({ error: "Not authorized to view this file" });
      }
    }

    // 3. Resolve and validate file path
    const abs = resolveAbsPathFromDB(r.filePath);
    console.log("📄 File path resolution:", {
      original: r.filePath,
      resolved: abs,
      exists: abs ? fs.existsSync(abs) : false
    });

    if (!abs || !fs.existsSync(abs)) {
      console.error("❌ File missing on disk:", { 
        id: r._id, 
        resolvedAbs: abs, 
        stored: r.filePath 
      });
      return res.status(404).json({ error: "File not found on disk" });
    }

    // 4. Set proper headers for PDF viewing
    const contentType = r.fileType || "application/pdf";
    const fileName = r.fileName || "document.pdf";
    
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour cache
    
    // 5. Stream file with proper error handling
    fileStream = fs.createReadStream(abs);
    
    fileStream.on('error', (err) => {
      console.error("❌ Stream error:", { 
        error: err.message, 
        fileId: r._id,
        path: abs 
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream file" });
      }
    });

    fileStream.on('open', () => {
      console.log("✅ Started streaming:", { 
        id: r._id,
        type: contentType,
        name: fileName
      });
    });

    // Pipe with error handling
    fileStream.pipe(res).on('error', (err) => {
      console.error("❌ Pipe error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream pipe failed" });
      }
    });

  } catch (err) {
    console.error("❌ File fetch error:", {
      error: err.message,
      stack: err.stack,
      fileId: req.params.id
    });
    
    if (fileStream) {
      fileStream.destroy();
    }
    
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to fetch file" });
    }
  }

  // Cleanup on request abort/close
  req.on('close', () => {
    if (fileStream) {
      fileStream.destroy();
    }
  });
});

/* =========================================================
   Faculty approved list (ONLY unused items)
========================================================= */
router.get("/faculty/approved-list", authorize(["staff", "admin"]), async (req, res) => {
  try {
    const approved = await Research.find({
      status: "approved",
      submissionType: "final",
      source: "faculty-approved",
    })
      .sort({ updatedAt: -1 })
      .select(
        'title author coAuthors adviser updatedAt fileName visibility embargoUntil abstract year keywords categories genreTags submissionType'
      )
      .lean();

    res.json(approved);
  } catch (err) {
    console.error("❌ Failed to fetch approved list:", err);
    res.status(500).json({ error: "Failed to fetch approved research" });
  }
});

/* =========================================================
   STAFF attach from an already-approved faculty file (consume source)
========================================================= */
router.post("/upload-from-approved", authorize(["staff","admin"]), async (req, res) => {
  try {
    const {
      sourceId,
      title,
      author,
      coAuthors,   
      year,
      keywords,
      abstract,
      categories,
      category,
      genreTags
    } = req.body || {};

    if (!sourceId || !title || !author) {
      return res.status(400).json({ error: "sourceId, title, and author are required" });
    }

    // Pull full fields so we can use them as fallbacks
    const src = await Research.findOne({
      _id: sourceId,
      status: "approved",
      source: "faculty-approved",
    })
      .select("+abstract +year +keywords +categories +genreTags +category +filePath +fileName +fileType +coAuthors" )
      .lean();

    if (!src) return res.status(404).json({ error: "Approved source not found" });

    const srcAbs = resolveAbsPathFromDB(src.filePath || "");
    if (!srcAbs || !fs.existsSync(srcAbs)) {
      return res.status(404).json({ error: "Source file missing on disk" });
    }

    const destDir = path.join(__dirname, "../uploads/research");
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const ext = path.extname(srcAbs) || ".pdf";
    const safeTitle = String(title).trim().replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60) || "file";
    const newFileName = `${Date.now()}_${safeTitle}${ext}`;
    const destAbs = path.join(destDir, newFileName);

    // hard link if possible; otherwise copy
    try { fs.linkSync(srcAbs, destAbs); } catch { fs.copyFileSync(srcAbs, destAbs); }

    // ---------- Fallbacks ----------
    const finalAbstract = String((abstract ?? "")).trim() || src.abstract || "";
    const finalYear     = String((year ?? "")).trim() || (src.year ?? "");
    const finalKeywords = toKeywords(keywords).length
      ? toKeywords(keywords)
      : (Array.isArray(src.keywords) ? src.keywords : []);

    // categories (array) + legacy category (string)
    let cats = toCats(categories);
    if (category && !cats.includes(String(category))) cats.push(String(category));
    if (!cats.length && Array.isArray(src.categories)) cats = src.categories;

    let tags = toTags(genreTags);
    if (!tags.length && Array.isArray(src.genreTags)) tags = src.genreTags;

    const legacyCategory = category || src.category || undefined;

    const doc = await Research.create({
      title: String(title).trim(),
      author: String(author).trim(),
      coAuthors: toArray(coAuthors).length
        ? toArray(coAuthors)
        : (Array.isArray(src.coAuthors) ? src.coAuthors : []), 
      year: finalYear || undefined,
      abstract: finalAbstract,
      keywords: finalKeywords,

      // taxonomy
      category: legacyCategory,  // keep legacy field for older UIs
      categories: cats,          // new array
      genreTags: tags,           // new array

      status: "approved",
      fileName: newFileName,
      filePath: `/uploads/research/${newFileName}`,
      fileType: "application/pdf",
      uploadedBy: req.user.id,
      uploaderRole: req.user.role,
      visibility: "campus",
      allowedViewers: [],
      embargoUntil: null,
      source: "faculty-approved",
      submissionType: "final",
    });

    // consume the approved source so it won't show up again
    await Research.updateOne(
      { _id: sourceId, source: "faculty-approved" },
      { $set: { source: "faculty-approved-used" } }
    );

    return res.json({
      _id: doc._id,
      title: doc.title,
      author: doc.author,
      coAuthors: doc.coAuthors, 
      year: doc.year,
      keywords: doc.keywords,
      abstract: doc.abstract,
      categories: doc.categories,
      genreTags: doc.genreTags,
      fileName: doc.fileName,
      fileType: doc.fileType,
      status: doc.status,
      visibility: doc.visibility,
      uploaderRole: doc.uploaderRole,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    console.error("❌ upload-from-approved error:", err);
    res.status(500).json({ error: "Failed to attach approved file" });
  }
});

module.exports = router;
