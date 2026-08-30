// Route-protection middleware.
// requireAuth: any logged-in staff member (staff or admin) — explicitly
// rejects a family (parent portal) token, even though the payload shapes
// differ, so a family token can never accidentally satisfy a staff route.
// requireAdmin: admin access_level only.
// requireFamilyAuth: a logged-in parent — explicitly rejects a staff token,
// the same way, in the other direction.
const { verifyToken } = require('../utils/auth');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // expected: "Bearer <token>"
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = verifyToken(token);
    if (payload.type === 'family') {
      return res.status(401).json({ error: 'Invalid token for this route' });
    }
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

function requireFamilyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = verifyToken(token);
    if (payload.type !== 'family') {
      return res.status(401).json({ error: 'Invalid token for this route' });
    }
    req.family = payload; // { family_id, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth, requireAdmin, requireFamilyAuth };
