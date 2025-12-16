// utils/mailer.js
const Brevo = require("@getbrevo/brevo");
const apiInstance = new Brevo.TransactionalEmailsApi();

// Load API key
apiInstance.authentications['apiKey'].apiKey = process.env.BREVO_API_KEY;

/* ========================================
   SEND OTP EMAIL (Verification / Login)
======================================== */
async function sendOtpEmail(to, code, title = "Your Verification Code") {
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2 style="color:#111827;">${title}</h2>
      <p style="font-size:16px;">Use the following code to continue:</p>
      <div style="
        font-size: 38px;
        font-weight: bold;
        letter-spacing: 10px;
        margin: 20px 0;
        color:#2563eb;
      ">
        ${code}
      </div>
      <p style="font-size:14px; color:#6b7280;">
        This code will expire in 5 minutes.
      </p>
      <hr style="margin:20px 0; opacity:0.3;">
      <p style="font-size:12px; color:#9ca3af;">Research Repository • MSU-IIT</p>
      <p style="font-size:12px; color:#ef4444; margin-top:15px;">
        ⚠️ This is an automated message. Please do not reply to this email.
      </p>
    </div>
  `;

  const email = {
    sender: {
      name: "Research Repository (No Reply)",
      email: process.env.EMAIL_FROM.match(/<(.*)>/)?.[1] || "noreply@researchrepo.com"
    },
    to: [{ email: to }],
    replyTo: {
      email: "noreply@researchrepo.com",
      name: "Do Not Reply"
    },
    subject: title,
    htmlContent
  };

  try {
    await apiInstance.sendTransacEmail(email);
    console.log("📧 OTP email sent to", to);
  } catch (err) {
    console.error("❌ OTP email failed:", err.response?.body || err);
    throw err;
  }
}

/* ========================================
   SYSTEM EMAIL (Reset PIN, Notifications)
======================================== */
async function sendSystemEmail({ to, subject, text, html }) {
  const finalHtml = html || `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <p style="font-size:16px;">${text}</p>
      <hr style="margin:20px 0; opacity:0.3;">
      <p style="font-size:12px; color:#9ca3af;">Research Repository • MSU-IIT</p>
      <p style="font-size:12px; color:#ef4444; margin-top:15px;">
        ⚠️ This is an automated message. Please do not reply to this email.
      </p>
    </div>
  `;

  const email = {
    sender: {
      name: "Research Repository (No Reply)",
      email: process.env.EMAIL_FROM.match(/<(.*)>/)?.[1] || "noreply@researchrepo.com"
    },
    to: [{ email: to }],
    replyTo: {
      email: "noreply@researchrepo.com",
      name: "Do Not Reply"
    },
    subject,
    htmlContent: finalHtml
  };

  try {
    await apiInstance.sendTransacEmail(email);
    console.log("📧 System email sent to", to);
  } catch (err) {
    console.error("❌ System email failed:", err.response?.body || err);
    throw err;
  }
}

module.exports = {
  sendOtpEmail,
  sendSystemEmail,
};