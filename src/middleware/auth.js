// Route-protection middleware.
// requireAuth: any logged-in staff member (staff or admin).
// requireAdmin: admin access_level only.
const { verifyToken } = require('../utils/auth');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // expected: "Bearer <token>"
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = verifyToken(token);
    req.staff = payload; // { staff_id, email, access_level }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.staff.access_level !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
