// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

const isMsuiitG = (email = "") => /@g\.msuiit\.edu\.ph$/i.test(String(email));
const SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET || "change-me";
const JWT_ISSUER = "repo-api"; // keep consistent with your token minting
const CLOCK_TOLERANCE = 10;    // seconds of leeway

function authorize(allowedRoles = []) {
  if (typeof allowedRoles === 'string') allowedRoles = [allowedRoles];

  return (req, res, next) => {
    try {
      const hdr = req.headers.authorization || '';
      // ✅ Accept Bearer header or ?token= query param for GETs
      const token =
        (hdr.startsWith('Bearer ') && hdr.slice(7)) ||
        (req.method === 'GET' ? req.query.token : null);

      if (!token) {
        return res.status(401).json({ error: 'Missing or invalid token' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: JWT_ISSUER,
        clockTolerance: CLOCK_TOLERANCE,
      });

      if (!decoded?.id || !decoded?.email || !decoded?.role) {
        return res.status(400).json({ error: 'Malformed token' });
      }

      const email = String(decoded.email).toLowerCase();
      req.user = {
        ...decoded,
        email,
        affiliation: isMsuiitG(email) ? 'MSU-IIT' : 'external',
        isCampus: isMsuiitG(email),
      };

      if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
      }

      return next();
    } catch (err) {
      console.error('❌ JWT verify error:', err.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}


/**
 * Accepts:
 *  - Bearer (normal auth)
 *  - OR short-lived signed query token `?sig=...` (headerless preview)
 */
function authorizeOrSig() {
  return (req, res, next) => {
    const hdr = req.headers.authorization || '';

    // 1) Bearer path
    if (hdr.startsWith('Bearer ')) {
      const token = hdr.slice(7);
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, {
          issuer: JWT_ISSUER,
          clockTolerance: CLOCK_TOLERANCE,
        });
        if (!decoded?.id || !decoded?.email || !decoded?.role) {
          return res.status(400).json({ error: 'Malformed token' });
        }
        const email = String(decoded.email).toLowerCase();
        req.user = {
          ...decoded,
          email,
          affiliation: isMsuiitG(email) ? 'MSU-IIT' : 'external',
          isCampus: isMsuiitG(email),
        };
        return next();
      } catch (_) {
        /* fall through to ?sig */
      }
    }

    // 2) Signed link path
    const sig = req.query?.sig;
    if (!sig) return res.status(401).json({ error: 'Missing or invalid token' });

    try {
      const payload = jwt.verify(sig, SIGNED_URL_SECRET, {
        clockTolerance: CLOCK_TOLERANCE,
      });
      if (!payload?.fileId || !payload?.sub) {
        return res.status(400).json({ error: 'Malformed signed link' });
      }
      req.user = {
        id: payload.sub,
        email: (payload.email || '').toLowerCase(),
        role: payload.role || '',
        isCampus: !!payload.isCampus,
        _signedUrl: true,
        _sig: payload, // { fileId, sub, exp, ... }
      };
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired signed link' });
    }
  };
}

module.exports = { authorize, authorizeOrSig, isMsuiitG };
