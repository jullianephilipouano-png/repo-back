// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure <project>/uploads/research exists
const uploadDir = path.join(__dirname, "..", "uploads", "research");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || ".pdf").toLowerCase() || ".pdf";
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (_req, file, cb) => {
  const mime = (file.mimetype || "").toLowerCase();
  const ok =
    mime === "application/pdf" ||
    mime === "application/octet-stream"; // mobile / edge cases

  if (!ok) {
    return cb(new Error("Only PDF files are allowed"));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // ✅ unified 50MB
});

module.exports = upload;
