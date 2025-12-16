const mongoose = require("mongoose");

const researchSchema = new mongoose.Schema(
  {
    /* 🧾 Basic Info */
    title:    { type: String, required: true, trim: true },
    abstract: { type: String, default: "" },
    author:   { type: String, required: true, trim: true },
    adviser:  { type: String, default: "" },
    student:  { type: String, default: "" },
    coAuthors: {
  type: [String],
  default: [],
  set: arr =>
    (arr || [])
      .map(s => String(s || "").trim())
      .filter(Boolean),
},



    /* ⚙️ Status + Review */
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    facultyComment: { type: String, default: "" },

    /* 🧭 Draft/Final flag (NEW) */
    submissionType: {
      type: String,
      enum: ["draft", "final"],
      default: "draft",
      index: true,
    },

    /* 📁 File Metadata (stored on disk; streamed via protected route) */
    filePath: { type: String, default: "" }, // never exposed via toJSON
    fileName: { type: String, default: "" },
    fileType: { type: String, default: "application/pdf" },

    /* 📊 Additional Metadata */
    year: {
      type: String,
      default: "",
      set: v => (v == null ? "" : String(v).trim()),
      index: true,
    },
    keywords: {
      type: [String],
      default: [],
      set: arr =>
        (arr || [])
          .map(k => String(k || "").trim())
          .filter(Boolean),
    },

    // Legacy single category (keep if you still show it anywhere)
    category: { type: String, default: "" },

    // ✅ New taxonomy fields
    categories: {
      type: [String],
      default: [],
      set: arr =>
        (arr || [])
          .map(s => String(s || "").trim())
          .filter(Boolean),
    },
    genreTags: {
      type: [String],
      default: [],
      set: arr =>
        (arr || [])
          .map(s => String(s || "").trim())
          .filter(Boolean),
    },

    // ✅ Public-landing field (optional)
    landingPageUrl: { type: String, default: "" },

    /* 👥 Upload + Tracking */
    uploadedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    uploaderRole: { type: String, default: "" }, // "student" | "faculty" | "staff" | "admin"
    forwardedBy:  { type: String, default: "" },
    source:       { type: String, default: "" }, // "faculty-approved" | "staff-upload" | "student-upload" | "faculty-upload"

    /* 🏫 Optional college tag */
    college: { type: String, default: "" },

    /* 🔒 Access control */
    visibility: {
      type: String,
      enum: ["public", "campus", "private", "embargo"],
      default: "public",
      index: true,
    },
    embargoUntil:   { type: Date, default: null },
    allowedViewers: { type: [String], default: [] }, // lowercased emails
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // 🚫 never leak storage internals
        delete ret.filePath;
        return ret;
      },
    },
    toObject: {
      transform: (_doc, ret) => {
        delete ret.filePath;
        return ret;
      },
    },
  }
);

/* 🔎 Helpful indexes */
researchSchema.index({ status: 1, visibility: 1, updatedAt: -1 });
researchSchema.index({ submissionType: 1, status: 1, updatedAt: -1 });
researchSchema.index({
  title: "text",
  author: "text",
  keywords: "text",
  category: "text",
  categories: "text",
  genreTags: "text",
});
researchSchema.index({ categories: 1 });
researchSchema.index({ genreTags: 1 });

/* 🧪 Virtuals */
researchSchema.virtual("isFinal").get(function () {
  return this.submissionType === "final";
});

/* 🔧 Normalize arrays / fields */
researchSchema.pre("save", function (next) {
  if (Array.isArray(this.allowedViewers)) {
    this.allowedViewers = this.allowedViewers.map(e => String(e || "").toLowerCase());
  }
  next();
});

/* ✅ Enforce embargo rules at write-time */
researchSchema.pre("validate", function (next) {
  if (this.visibility === "embargo" && !this.embargoUntil) {
    return next(new Error("embargoUntil is required when visibility is 'embargo'"));
  }
  next();
});

/* ✅ Prevent OverwriteModelError */
module.exports =
  mongoose.models.Research || mongoose.model("Research", researchSchema);
