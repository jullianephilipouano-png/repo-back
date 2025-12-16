// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    /* =============================
       Basic Identity
    ============================= */
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        // ✅ Students, faculty, and staff all use @g.msuiit.edu.ph
        validator: (v) => /@g\.msuiit\.edu\.ph$/i.test(v),
        message: "Only @g.msuiit.edu.ph emails are allowed",
      },
      index: true,
    },

    /* =============================
       Profile Fields
    ============================= */
    phone: { type: String, default: "" },
    affiliation: { type: String, default: "" },

    // Staff-specific (optional)
    staffId: { type: String, default: "" },
    department: { type: String, default: "" },

    /* =============================
       Authentication
    ============================= */
    pinHash: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["student", "staff", "faculty", "admin"],
      default: "student",
      index: true,
    },

    college: { type: String, default: "" },

    /* =============================
       Verification & OTP
    ============================= */
    verified: {
      type: Boolean,
      default: false,
    },

    // First-time email verification
    verificationCode: {
      type: String,
      default: null,
      select: false,
    },

    lastVerifiedAt: {
      type: Date,
      default: null,
    },

    // 🔑 Login OTP (THIS WAS MISSING BEFORE)
    loginOtp: {
      type: String,
      default: null,
      select: false,
    },

    loginOtpExpires: {
      type: Date,
      default: null,
    },

    /* =============================
       PIN Reset
    ============================= */
    resetCode: {
      type: String,
      default: null,
      select: false,
    },

    resetCodeExpires: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,

    // Hide sensitive fields automatically
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.pinHash;
        delete ret.verificationCode;
        delete ret.loginOtp;
        delete ret.resetCode;
        return ret;
      },
    },
  }
);

/* =============================
   Hooks
============================= */
userSchema.pre("save", function (next) {
  if (this.email) {
    this.email = String(this.email).toLowerCase();
  }
  next();
});

module.exports =
  mongoose.models.User || mongoose.model("User", userSchema);
