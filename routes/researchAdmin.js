// routes/researchAdmin.js
const express = require("express");
const router = express.Router();

const Research = require("../models/Research");
const { authorize } = require("../middleware/authMiddleware");
const upload = require("../middleware/upload"); // must export upload.single("file")

/* -------------------- Constants & Helpers -------------------- */

const ALLOWED_VIS = ["public", "campus", "private", "embargo"];
const ALLOWED_STATUS = ["pending", "approved", "rejected"];
const ALLOWED_ROLES = ["student", "faculty", "staff", "admin"];

function toArrayLower(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean);
  }
  return String(input)
    .split(",")
    .map((e) => e.toLowerCase().trim())
    .filter(Boolean);
}

// Strip storage internals
function sanitize(doc) {
  if (!doc) return doc;
  const { filePath, ...safe } = doc;
  return safe;
}

function relFilePathFromMulter(file) {
  if (!file) return "";
  // Prefer a stable /uploads/... path (works with your /uploads/research destination)
  if (file.path && /[\/\\]uploads[\/\\]/i.test(file.path)) {
    // Normalize to /uploads/...
    const normalized = file.path.replace(/\\/g, "/");
    const idx = normalized.toLowerCase().lastIndexOf("/uploads/");
    return idx >= 0 ? normalized.slice(idx) : `/uploads/research/${file.filename}`;
  }
  return `/uploads/research/${file.filename}`;
}

/* =========================================================
   📤 Upload research (staff/admin)
   POST /api/research-admin/upload
   Form-Data:
     - file (PDF)  ✅ via multer
     - title*      - author* - year - abstract - category - college
     - keywords     (comma-separated or array)
     - visibility   ('public' | 'campus' | 'private' | 'embargo')
     - embargoUntil (ISO date, required if visibility='embargo')
     - allowedViewers (comma-separated emails) if visibility='private'
     - categories   (comma-separated or array)   ← NEW
     - genreTags    (comma-separated or array)   ← NEW
     - landingPageUrl (string)                   ← NEW
   Behavior:
     - status = "approved" for staff/admin uploads
========================================================= */
router.post(
  "/upload",
  authorize(["staff", "admin"]),
  upload.single("file"),
  async (req, res) => {
    try {
      const {
        title,
        author,
        coAuthors,
        year,
        abstract,
        keywords,
        category,
        college,
        visibility,
        embargoUntil,
        allowedViewers,

        // NEW
        categories,
        genreTags,
        landingPageUrl,
      } = req.body;

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      if (!title || !author) {
        return res.status(400).json({ error: "Title and author are required" });
      }

      const vis = ALLOWED_VIS.includes(visibility) ? visibility : "public";
      const embargoDate =
        vis === "embargo" && embargoUntil ? new Date(embargoUntil) : null;

      if (vis === "embargo" && !embargoDate) {
        return res
          .status(400)
          .json({ error: "embargoUntil is required for 'embargo' visibility" });
      }

      const viewers = vis === "private" ? toArrayLower(allowedViewers) : [];

      const doc = new Research({
        title,
        author,
        coAuthors: Array.isArray(coAuthors)
  ? coAuthors.map(s => String(s || "").trim()).filter(Boolean)
  : String(coAuthors || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),

        year: year ? String(year).trim() : "",
        abstract: abstract || "",
        category: category || "",
        college: college || "",
        keywords: Array.isArray(keywords)
          ? keywords.map(k => String(k || "").trim()).filter(Boolean)
          : String(keywords || "")
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean),

        // NEW: taxonomy + landing page
        categories: Array.isArray(categories)
          ? categories.map(s => String(s || "").trim()).filter(Boolean)
          : String(categories || "").split(",").map(s => s.trim()).filter(Boolean),
        genreTags: Array.isArray(genreTags)
          ? genreTags.map(s => String(s || "").trim()).filter(Boolean)
          : String(genreTags || "").split(",").map(s => s.trim()).filter(Boolean),
        landingPageUrl: String(landingPageUrl || "").trim(),

        fileName: req.file.originalname || "",
        filePath: relFilePathFromMulter(req.file), // stored on disk
        fileType: req.file.mimetype || "application/pdf",
        uploadedBy: req.user?.id,
        uploaderRole: req.user?.role || "",
        source: "staff-upload",
        status: "approved",
        visibility: vis,
        embargoUntil: embargoDate,
        allowedViewers: viewers,
      });

      await doc.save();
      return res.json({
        message: "Research uploaded successfully",
        research: sanitize(doc.toObject()),
      });
    } catch (err) {
      console.error("❌ Upload failed:", err);
      return res.status(500).json({ error: "Failed to upload research" });
    }
  }
);

/* =========================================================
   👁 Update visibility (staff/admin)
   PUT /api/research-admin/:id/visibility
   Body:
     - visibility   ('public' | 'campus' | 'private' | 'embargo') *
     - embargoUntil (ISO date if 'embargo')
     - allowedViewers (comma-separated or array; only for 'private')
========================================================= */
router.put(
  "/:id/visibility",
  authorize(["admin", "staff"]),
  async (req, res) => {
    try {
      const { visibility, embargoUntil, allowedViewers } = req.body;

      if (!ALLOWED_VIS.includes(visibility)) {
        return res.status(400).json({ error: "Invalid visibility value" });
      }

      const update = { visibility };

      // Embargo rule
      if (visibility === "embargo") {
        if (!embargoUntil) {
          return res.status(400).json({ error: "embargoUntil is required for 'embargo' visibility" });
        }
        const dt = new Date(embargoUntil);
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({ error: "embargoUntil must be a valid date/ISO string" });
        }
        update.embargoUntil = dt;
        update.allowedViewers = []; // irrelevant in embargo
      } else {
        update.embargoUntil = null;
      }

      // Private rule
      if (visibility === "private") {
        const emails = Array.isArray(allowedViewers)
          ? allowedViewers
          : String(allowedViewers || "")
              .split(",")
              .map(s => s.trim())
              .filter(Boolean);

        update.allowedViewers = emails.map(e => String(e).toLowerCase());

        if (update.allowedViewers.length === 0) {
          return res.status(400).json({ error: "Provide at least one allowed viewer email for 'private' visibility" });
        }
      }

      // For non-private and non-embargo: ensure clean state
      if (visibility === "public" || visibility === "campus") {
        update.allowedViewers = [];
      }

      const research = await Research.findByIdAndUpdate(
        req.params.id,
        update,
        { new: true, runValidators: true }
      ).lean();

      if (!research) {
        return res.status(404).json({ error: "Research not found" });
      }

      const { filePath, ...safe } = research;
      res.json({ message: "Visibility updated", research: safe });
    } catch (err) {
      console.error("❌ Visibility update failed:", err);
      res.status(500).json({ error: "Failed to update visibility" });
    }
  }
);

/* =========================================================
   📝 Unified update (metadata + publishing + taxonomy)
   PUT /api/research-admin/:id
   Body (any subset):
     - metadata: title, author, year, abstract, keywords, category, college, status
     - publishing: visibility, embargoUntil, allowedViewers, landingPageUrl
     - taxonomy: categories, genreTags
========================================================= */
router.put(
  "/:id",
  authorize(["admin", "staff"]),
  async (req, res) => {
    try {
      const {
        // metadata
        title, author, coAuthors,  year, abstract, keywords, category, college, status,

        // publishing/taxonomy
        visibility, embargoUntil, allowedViewers,
        landingPageUrl, categories, genreTags,
      } = req.body;

      const update = {};

      // ----- basic metadata -----
      if (title != null)    update.title = String(title).trim();
      if (author != null)   update.author = String(author).trim();
      if (year != null)     update.year = String(year).trim();
      if (abstract != null) update.abstract = String(abstract);
      if (category != null) update.category = String(category);
      if (college != null)  update.college = String(college);
      if (coAuthors != null) {
  update.coAuthors = Array.isArray(coAuthors)
    ? coAuthors.map(s => String(s || "").trim()).filter(Boolean)
    : String(coAuthors)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}

      if (keywords != null) {
        update.keywords = Array.isArray(keywords)
          ? keywords.map((k) => String(k || "").trim()).filter(Boolean)
          : String(keywords)
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean);
      }
      if (status && ALLOWED_STATUS.includes(status)) {
        update.status = status;
      }

      // ----- taxonomy -----
      if (categories != null) {
        update.categories = Array.isArray(categories)
          ? categories.map(s => String(s || "").trim()).filter(Boolean)
          : String(categories).split(",").map(s => s.trim()).filter(Boolean);
      }
      if (genreTags != null) {
        update.genreTags = Array.isArray(genreTags)
          ? genreTags.map(s => String(s || "").trim()).filter(Boolean)
          : String(genreTags).split(",").map(s => s.trim()).filter(Boolean);
      }
      if (landingPageUrl != null) {
        update.landingPageUrl = String(landingPageUrl || "").trim();
      }

      // ----- visibility block (optional but supported here) -----
      if (visibility != null) {
        if (!ALLOWED_VIS.includes(visibility)) {
          return res.status(400).json({ error: "Invalid visibility value" });
        }
        update.visibility = visibility;

        if (visibility === "embargo") {
          if (!embargoUntil) {
            return res.status(400).json({ error: "embargoUntil is required for 'embargo' visibility" });
          }
          const dt = new Date(embargoUntil);
          if (Number.isNaN(dt.getTime())) {
            return res.status(400).json({ error: "embargoUntil must be a valid date/ISO string" });
          }
          update.embargoUntil = dt;
          update.allowedViewers = []; // ignore allow-list on embargo
        } else {
          update.embargoUntil = null;
        }

        if (visibility === "private") {
          const emails = Array.isArray(allowedViewers)
            ? allowedViewers
            : String(allowedViewers || "")
                .split(",")
                .map(s => s.trim())
                .filter(Boolean);
          update.allowedViewers = emails.map(e => String(e).toLowerCase());
        }

        if (visibility === "public" || visibility === "campus") {
          update.allowedViewers = [];
        }
      }

      const doc = await Research.findByIdAndUpdate(req.params.id, update, {
        new: true, runValidators: true,
      }).lean();

      if (!doc) return res.status(404).json({ error: "Research not found" });
      return res.json({ message: "Updated", research: sanitize(doc) });
    } catch (err) {
      console.error("❌ Update failed:", err);
      return res.status(500).json({ error: "Failed to update research" });
    }
  }
);

/* =========================================================
   🗑️ Delete (staff/admin)
   DELETE /api/research-admin/:id
========================================================= */
router.delete(
  "/:id",
  authorize(["admin", "staff"]),
  async (req, res) => {
    try {
      const doc = await Research.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: "Research not found" });

      await doc.deleteOne();
      // (Optional) unlink physical file here with fs.unlinkSync if desired
      return res.json({ message: "Research deleted successfully" });
    } catch (err) {
      console.error("❌ Delete failed:", err);
      return res.status(500).json({ error: "Failed to delete research" });
    }
  }
);

/* =========================================================
   📚 Admin/staff dashboard list
   GET /api/research-admin
   Query (all optional):
     - search   : text search in title/author/keywords/year/category
     - status   : pending | approved | rejected
     - visibility: public | campus | private | embargo
     - year     : exact year
     - role     : uploaderRole filter (student/faculty/staff/admin)
     - college  : string
     - sort     : latest (default) | year
     - page     : default 1
     - limit    : default 20 (max 100)
========================================================= */
router.get(
  "/",
  authorize(["admin", "staff"]),
  async (req, res) => {
    try {
      const {
        search = "",
        status,
        visibility,
        year,
        role,
        college,
        sort = "latest",
        page = "1",
        limit = "20",
      } = req.query;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      const filter = {};

      // Search
      if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim(), "i");
        filter.$or = [
          { title: regex },
          { author: regex },
          { keywords: regex },
          { year: regex },
          { category: regex },
          { categories: regex }, // NEW
          { genreTags: regex },  // NEW
        ];
      }

      if (status && ALLOWED_STATUS.includes(status)) filter.status = status;
      if (visibility && ALLOWED_VIS.includes(visibility)) filter.visibility = visibility;
      if (year && String(year).trim()) filter.year = String(year).trim();
      if (role && ALLOWED_ROLES.includes(role)) filter.uploaderRole = role;
      if (college && String(college).trim()) filter.college = String(college).trim();

      const sortStage =
        sort === "year" ? { year: -1, updatedAt: -1 } : { updatedAt: -1 };

      const [items, total] = await Promise.all([
        Research.find(filter)
          .sort(sortStage)
          .skip((pageNum - 1) * lim)
          .limit(lim)
         .select(
  "title author coAuthors year abstract keywords category categories genreTags landingPageUrl " +
  "fileName fileType uploaderRole status visibility embargoUntil allowedViewers college createdAt updatedAt"
)

          .lean(),
        Research.countDocuments(filter),
      ]);

      return res.json({
        data: items.map(sanitize),
        meta: {
          total,
          page: pageNum,
          limit: lim,
          pages: Math.ceil(total / lim),
          sort,
          search: search || null,
          status: status || null,
          visibility: visibility || null,
          year: year || null,
          role: role || null,
          college: college || null,
        },
      });
    } catch (err) {
      console.error("❌ Fetch failed:", err);
      return res.status(500).json({ error: "Failed to load research" });
    }
  }
);

/* =========================================================
   🔍 Get single (for Publishing screen initial hydrate)
   GET /api/research-admin/:id
========================================================= */
router.get("/:id", authorize(["admin", "staff"]), async (req, res) => {
  try {
    const doc = await Research.findById(req.params.id)
      .select(
  "title author coAuthors year abstract keywords category categories genreTags landingPageUrl " +
  "fileName fileType uploaderRole status visibility embargoUntil allowedViewers college createdAt updatedAt"
)

      .lean();

    if (!doc) return res.status(404).json({ error: "Research not found" });
    const { filePath, ...safe } = doc;
    return res.json({ data: safe });
  } catch (err) {
    console.error("❌ Fetch item failed:", err);
    return res.status(500).json({ error: "Failed to fetch item" });
  }
});


router.post("/import/:id", authorize(["staff", "admin"]), async (req, res) => {
  try {
    const src = await Research.findById(req.params.id).lean();
    if (!src || src.status !== "approved" || src.source !== "faculty-approved") {
      return res.status(404).json({ error: "Source not importable" });
    }

    // Resolve absolute path from src.filePath
    let abs;
    const p = src.filePath;
    if (path.isAbsolute(p)) abs = p;
    else if (String(p || "").startsWith("/uploads/"))
      abs = path.resolve(path.join(__dirname, "..", `.${p}`));
    else abs = path.resolve(path.join(__dirname, "..", p));

    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: "Source file missing on disk" });
    }

    // Copy to /uploads/research
    const uploadsDir = path.resolve(path.join(__dirname, "..", "uploads", "research"));
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const ext = path.extname(src.fileName || "document.pdf") || ".pdf";
    const newName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const newRel = `/uploads/research/${newName}`;
    fs.copyFileSync(abs, path.join(uploadsDir, newName));

    const vis = ["public","campus","private","embargo"].includes(req.body.visibility)
      ? req.body.visibility
      : "campus";

    const doc = await Research.create({
      title: src.title,
      author: src.author,
      coAuthors: src.coAuthors || [],

      year: src.year,
      abstract: src.abstract || "",
      keywords: src.keywords || [],
      category: src.category || "",
      categories: src.categories || [],
      genreTags: src.genreTags || [],
      landingPageUrl: "",

      fileName: src.fileName || "document.pdf",
      filePath: newRel,
      fileType: src.fileType || "application/pdf",

      uploadedBy: req.user.id,
      uploaderRole: "staff",
      source: "staff-upload",
      status: "approved",

      visibility: vis,
      embargoUntil:
        vis === "embargo" && req.body.embargoUntil ? new Date(req.body.embargoUntil) : null,
      allowedViewers: Array.isArray(req.body.allowedViewers)
        ? req.body.allowedViewers.map(e => String(e).toLowerCase())
        : [],
      college: src.college || "",
    });

    res.status(201).json({ message: "Imported", research: sanitize(doc.toObject()) });
  } catch (err) {
    console.error("❌ Import failed:", err);
    res.status(500).json({ error: "Failed to import research" });
  }
});


module.exports = router;
