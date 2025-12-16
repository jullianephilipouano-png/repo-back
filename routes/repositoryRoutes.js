// routes/repositoryRoutes.js
const express = require("express");
const Research = require("../models/Research");
const { authorize } = require("../middleware/authMiddleware");
const jwt = require("jsonwebtoken");

const router = express.Router();

const SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET || "change-me";

function publicBase(req) {
  return (process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get("host")}/api`).replace(/\/+$/,'');
}

// Build a Mongo filter that returns ONLY records the current user is allowed to see.
function buildAllowedFilter(user, extra = {}) {
  const now = new Date();
  const base = { status: "approved" };

  const ors = [
    { visibility: "public" },
    { visibility: "embargo", embargoUntil: { $ne: null, $lte: now } },
    { visibility: "private", allowedViewers: String(user.email).toLowerCase() },
  ];

  if (user?.isCampus) {
    ors.push({ visibility: "campus" });
  }

  return { ...base, $or: ors, ...extra };
}

function sanitize(r) {
  return {
    _id: r._id,
    title: r.title,
    author: r.author,
     coAuthors: r.coAuthors || [],
    year: r.year,
    abstract: r.abstract,
    keywords: r.keywords,
    category: r.category,
    categories: r.categories || [],
    genreTags: r.genreTags || [],
    landingPageUrl: r.landingPageUrl || null,
    fileName: r.fileName,
    uploaderRole: r.uploaderRole,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    visibility: r.visibility,
    embargoUntil: r.embargoUntil,
  };
}

const toList = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/* =========================================================
   🔒 CAMPUS-ONLY CENTRAL REPOSITORY – VIEW & SEARCH
   GET /api/repository
========================================================= */
router.get("/", authorize(), async (req, res) => {
  try {
    const {
      q = "",
      year,
      category,
      genre,
      role,
      sort = "latest",
      page = "1",
      limit = "20",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const andParts = [];

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), "i");
      andParts.push({
        $or: [
          { title: regex },
          { author: regex },
{ coAuthors: regex },
          { keywords: regex },
          { year: regex },
          { category: regex },
          { categories: regex },
          { genreTags: regex },
        ],
      });
    }

    if (year && String(year).trim()) {
      andParts.push({ year: String(year).trim() });
    }

    if (category && String(category).trim()) {
      const cats = toList(category);
      if (cats.length > 0) {
        andParts.push({
          $or: [{ category: { $in: cats } }, { categories: { $in: cats } }],
        });
      }
    }

    if (genre && String(genre).trim()) {
      const tags = toList(genre);
      if (tags.length > 0) {
        andParts.push({ genreTags: { $in: tags } });
      }
    }

    if (role && ["student", "faculty", "staff", "admin"].includes(String(role))) {
      andParts.push({ uploaderRole: String(role) });
    }

    const filter = buildAllowedFilter(
      req.user,
      andParts.length ? { $and: andParts } : {}
    );

    const sortStage =
      sort === "year" ? { year: -1, updatedAt: -1 } : { updatedAt: -1 };

    const [items, total] = await Promise.all([
      Research.find(filter)
        .sort(sortStage)
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .select(
          "title author  coAuthors year abstract keywords category categories genreTags landingPageUrl " +
            "fileName uploaderRole createdAt updatedAt visibility embargoUntil"
        )
        .lean(),
      Research.countDocuments(filter),
    ]);

    res.json({
      data: items.map(sanitize),
      meta: {
        total,
        page: pageNum,
        limit: lim,
        pages: Math.ceil(total / lim),
        sort,
        query: q || null,
        year: year || null,
        category: category || null,
        genre: genre || null,
        role: role || null,
      },
    });
  } catch (err) {
    console.error("❌ Repository fetch error:", err);
    res.status(500).json({ error: "Failed to load repository" });
  }
});

/* =========================================================
   📊 Facets for filters
   GET /api/repository/facets
========================================================= */
router.get("/facets", authorize(), async (req, res) => {
  try {
    const baseAllowed = buildAllowedFilter(req.user);

    const categoriesAgg = await Research.aggregate([
      { $match: baseAllowed },
      {
        $project: {
          allCats: {
            $setUnion: [
              { $cond: [{ $ne: ["$category", ""] }, ["$category"], []] },
              { $ifNull: ["$categories", []] },
            ],
          },
        },
      },
      { $unwind: "$allCats" },
      { $group: { _id: "$allCats", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]);

    const tagsAgg = await Research.aggregate([
      { $match: baseAllowed },
      { $unwind: "$genreTags" },
      { $group: { _id: "$genreTags", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]);

    res.json({
      categories: categoriesAgg.map((d) => ({ name: d._id, count: d.count })),
      genreTags: tagsAgg.map((d) => ({ name: d._id, count: d.count })),
    });
  } catch (err) {
    console.error("❌ Facets fetch error:", err);
    res.status(500).json({ error: "Failed to load facets" });
  }
});

/* =========================================================
   🔒 GET SINGLE RESEARCH by ID (campus visibility applied)
   GET /api/repository/:id
========================================================= */
router.get("/:id", authorize(), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id)
      .select(
        "title author coAuthors year abstract keywords category categories genreTags landingPageUrl " +
          "fileName uploaderRole createdAt updatedAt visibility embargoUntil allowedViewers"
      )
      .lean();

    if (!r || r.status !== "approved") {
      return res.status(404).json({ error: "Research not found" });
    }

    const now = new Date();
    const allowed =
      r.visibility === "public" ||
      (r.visibility === "embargo" && r.embargoUntil && new Date(r.embargoUntil) <= now) ||
      (r.visibility === "campus" && req.user?.isCampus) ||
      (r.visibility === "private" &&
        Array.isArray(r.allowedViewers) &&
        r.allowedViewers
          .map((e) => String(e).toLowerCase())
          .includes(String(req.user.email).toLowerCase()));

    if (!allowed) return res.status(403).json({ error: "Not authorized to view this item" });

    res.json(sanitize(r));
  } catch (err) {
    console.error("❌ Repository detail fetch error:", err);
    res.status(500).json({ error: "Failed to fetch research" });
  }
});

/* =========================================================
   🎟️ Campus-aware signed preview (visibility-based)
   GET /api/repository/file/:id/signed
   - If the current user is allowed by visibility, mint a short-lived token
   - Token is accepted by /api/research/file/:id streamer
========================================================= */
router.get("/file/:id/signed", authorize(), async (req, res) => {
  try {
    const r = await Research.findById(req.params.id)
      .select("status visibility embargoUntil allowedViewers")
      .lean();

    if (!r || r.status !== "approved") {
      return res.status(404).json({ error: "Not found" });
    }

    const now = new Date();
    const allowed =
      r.visibility === "public" ||
      (r.visibility === "embargo" && r.embargoUntil && new Date(r.embargoUntil) <= now) ||
      (r.visibility === "campus" && req.user?.isCampus) ||
      (r.visibility === "private" &&
        Array.isArray(r.allowedViewers) &&
        r.allowedViewers
          .map((e) => String(e).toLowerCase())
          .includes(String(req.user.email).toLowerCase()));

    if (!allowed) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const sig = jwt.sign(
      { sub: req.user.id, fileId: String(r._id), role: req.user.role, email: req.user.email },
      SIGNED_URL_SECRET,
      { expiresIn: "2m" }
    );

    const url = `${publicBase(req)}/research/file/${r._id}?sig=${encodeURIComponent(sig)}`;
    return res.json({ url, expiresIn: 120 });
  } catch (err) {
    console.error("❌ repository signed URL error:", err);
    return res.status(500).json({ error: "Failed to create signed URL" });
  }
});

module.exports = router;
