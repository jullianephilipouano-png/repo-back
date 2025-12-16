// routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { authorize } = require('../middleware/authMiddleware');
const { sendOtpEmail } = require("../utils/mailer");


/* =============================
   Helpers
============================= */
function getAffiliation(email = '') {
  // ✅ everyone with @g.msuiit.edu.ph is considered MSU-IIT
  return /@g\.msuiit\.edu\.ph$/i.test(String(email).toLowerCase().trim())
    ? 'MSU-IIT'
    : 'external';
}


function signAuthToken(user) {
  const affiliation = getAffiliation(user.email);
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      affiliation,           // now aligns with the single rule above
      college: user.college || '',
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d', issuer: 'repo-api' }
  );
}





/* =============================
   👤 Register
============================= */
router.post('/register', async (req, res) => {
  try {
    let { firstName, lastName, email, role, college } = req.body;

    let rawPin =
      req.body.pin ??
      req.body.password ??
      req.body.pinCode ??
      req.body.code ??
      '';

    rawPin = String(rawPin).trim();
    email = String(email || '').toLowerCase().trim();

    if (!firstName || !lastName || !email || !rawPin)
      return res.status(400).json({ error: 'All fields required' });

    if (!/^\d{6}$/.test(rawPin))
      return res.status(400).json({ error: 'PIN must be 6 digits' });

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(409).json({ error: 'Email already registered' });

    const pinHash = await bcrypt.hash(rawPin, 10);

    const user = new User({
      firstName,
      lastName,
      email,
      pinHash,
      role: role || 'student',
      college: college || '',
      verified: false,
    });

    await user.save();

    return res.status(201).json({
      message: 'Registered successfully. Verify your email on first login.',
    });
  } catch (err) {
    console.error('❌ Registration error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/* =============================
   🔐 Login + Send OTP
============================= */
/* =============================
   🔐 Login (Admin bypass + 7-day OTP rule)
============================= */
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const rawPin = String(
      req.body.pin ?? req.body.password ?? req.body.pinCode ?? ''
    ).trim();

    if (!email || !rawPin)
      return res.status(400).json({ error: 'Email and PIN required' });

    if (!/^\d{6}$/.test(rawPin))
      return res.status(400).json({ error: 'PIN must be 6 digits' });

    const user = await User.findOne({ email }).select(
      '+pinHash email role firstName lastName verified lastVerifiedAt college loginOtp loginOtpExpires verificationCode'
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    const isMatch = await bcrypt.compare(rawPin, user.pinHash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid PIN' });

    /* =====================================================
       ✅ ADMIN → PIN ONLY (NO OTP EVER)
    ===================================================== */
    if (user.role === 'admin') {
      const token = signAuthToken(user);

      return res.json({
        message: 'Admin login successful',
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          college: user.college,
          token,
        },
      });
    }

    /* =====================================================
       ⏱️ OTP RULE (FIRST TIME OR AFTER 7 DAYS)
    ===================================================== */
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    const needsOtp =
      !user.verified ||
      !user.lastVerifiedAt ||
      now - user.lastVerifiedAt.getTime() > SEVEN_DAYS;

    /* =====================================================
       ✅ NO OTP NEEDED → DIRECT LOGIN
    ===================================================== */
    if (!needsOtp) {
      const token = signAuthToken(user);

      return res.json({
        message: 'Login successful',
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          college: user.college,
          token,
        },
      });
    }

    /* =====================================================
       🔐 OTP REQUIRED
    ===================================================== */
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    if (!user.verified) {
      user.verificationCode = otp;
    } else {
      user.loginOtp = otp;
      user.loginOtpExpires = new Date(Date.now() + 5 * 60 * 1000);
    }

    await user.save();

    await sendOtpEmail(
      user.email,
      otp,
      user.verified
        ? 'Your Login Verification Code'
        : 'Verify Your Research Repository Account'
    );

    return res.json({ needsVerification: true, email: user.email });

  } catch (err) {
    console.error('❌ Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



/* =============================
   ✉️ Send PIN Reset Code
============================= */
router.post('/send-pin-reset-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();

    if (!email)
      return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email }).select(
      'email resetCode resetCodeExpires firstName'
    );

    if (!user) return res.status(404).json({ error: 'No account found' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    user.resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000);

    await user.save();

    await sendOtpEmail(
  email,
  code,
  "Research Repository – Reset PIN Code"
);


    return res.json({ message: 'Reset code sent' });

  } catch (err) {
    console.error('❌ Reset code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔁 validate-reset-code
============================= */
router.post('/validate-reset-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    if (!email || !/^\d{6}$/.test(code))
      return res.status(400).json({ error: 'Valid email and code required' });

    const user = await User.findOne({ email }).select(
      'resetCode resetCodeExpires'
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.resetCode !== code)
      return res.status(400).json({ error: 'Invalid code' });

    if (user.resetCodeExpires.getTime() < Date.now())
      return res.status(400).json({ error: 'Code expired' });

    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ validate-reset-code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔁 reset-pin (final step)
============================= */
router.post('/reset-pin', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const newPin = String(req.body.newPin || '').trim();

    if (!email || !/^\d{6}$/.test(code) || !/^\d{6}$/.test(newPin))
      return res.status(400).json({ error: 'Invalid input' });

    const user = await User.findOne({ email }).select(
      '+pinHash resetCode resetCodeExpires role firstName lastName college verified'
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.resetCode !== code)
      return res.status(400).json({ error: 'Invalid reset code' });

    if (user.resetCodeExpires.getTime() < Date.now())
      return res.status(400).json({ error: 'Code expired' });

    user.pinHash = await bcrypt.hash(newPin, 10);
    user.resetCode = null;
    user.resetCodeExpires = null;

    await user.save();

    const token = signAuthToken(user);

    return res.json({
      message: "PIN updated",
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        token,
      },
    });

  } catch (err) {
    console.error('❌ reset-pin error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/* =============================
   📧 verify-code (FIXED)
============================= */
router.post('/verify-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email + code required' });
    }

    const user = await User.findOne({ email }).select(
      'email verified verificationCode loginOtp loginOtpExpires firstName lastName role college lastVerifiedAt'
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    /* =========================
       FIRST-TIME VERIFICATION
    ========================= */
    if (!user.verified) {
      if (!user.verificationCode || user.verificationCode !== code) {
        return res.status(400).json({ error: 'Invalid verification code' });
      }

      user.verified = true;
      user.verificationCode = null;

      // ✅ IMPORTANT: clear login OTP state
      user.loginOtp = null;
      user.loginOtpExpires = null;

      user.lastVerifiedAt = new Date();
    }

    /* =========================
       LOGIN OTP (7-DAY RULE)
    ========================= */
    else {
      if (!user.loginOtp) {
        return res.status(400).json({
          error: 'No active login code. Please login again.',
        });
      }

      if (user.loginOtp !== code) {
        return res.status(400).json({ error: 'Invalid login code' });
      }

      if (!user.loginOtpExpires || user.loginOtpExpires.getTime() < Date.now()) {
        return res.status(400).json({ error: 'Code expired' });
      }

      user.loginOtp = null;
      user.loginOtpExpires = null;
      user.lastVerifiedAt = new Date();
    }

    await user.save();

    const token = signAuthToken(user);

    return res.json({
      message: 'Verification successful',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        college: user.college,
        token,
      },
    });

  } catch (err) {
    console.error('❌ verify-code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});






/* =============================
   🔁 Resend Verification Code
============================= */
router.post('/resend-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!email)
      return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email }).select('email verified');

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.verified)
      return res.status(409).json({ error: 'Already verified' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await User.updateOne(
      { email },
      { $set: { verificationCode: code } }
    );

    await sendSystemEmail({
      to: email,
      subject: "Verify Your Research Repository Account",
      text: `Your verification code is: ${code}`,
    });

    return res.json({ message: 'Verification code resent' });

  } catch (err) {
    console.error('❌ resend-code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔁 GET PROFILE (Protected)
============================= */
router.get('/me', authorize(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      '-pinHash -verificationCode'
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName} ${user.lastName}`,
      email: user.email,
      role: user.role,
      verified: user.verified,
      phone: user.phone || "",
      affiliation: getAffiliation(user.email),
      college: user.college || '',
      createdAt: user.createdAt,
    });

  } catch (err) {
    console.error('❌ /me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});




router.put("/update", authorize(), async (req, res) => {
  try {
    const { firstName, lastName, phone, affiliation, college } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: "First and last name required" });
    }

    const updates = {
      firstName,
      lastName,
      phone: phone || "",
      affiliation: affiliation || "",
      college: college || "",
    };

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true }
    ).select("-pinHash -verificationCode");

    res.json({ message: "Profile updated", user });

  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});
// =============================
// 🔐 Change Password (Change PIN)
// =============================
router.put("/change-password", authorize(), async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;

    if (!oldPin || !newPin) {
      return res.status(400).json({ error: "Old PIN and new PIN required" });
    }

    if (!/^\d{6}$/.test(oldPin) || !/^\d{6}$/.test(newPin)) {
      return res.status(400).json({ error: "PIN must be 6 digits" });
    }

    const user = await User.findById(req.user.id).select("+pinHash");
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if old PIN is correct
    const match = await bcrypt.compare(oldPin, user.pinHash);
    if (!match) return res.status(401).json({ error: "Incorrect old PIN" });

    // Update PIN
    user.pinHash = await bcrypt.hash(newPin, 10);
    await user.save();

    return res.json({ message: "PIN updated successfully" });

  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});




module.exports = router;
