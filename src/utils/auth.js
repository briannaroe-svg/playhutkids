// Password hashing and JWT helpers.
// Two distinct token types exist: 'staff' (dashboard login) and 'family'
// (parent portal login). Every token is tagged with `type` explicitly, and
// each auth middleware checks that tag — a family token must never be usable
// against a staff-only route even if it happens to share a field name.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '12h'; // staff re-login roughly once a shift/day
const FAMILY_JWT_EXPIRES_IN = '30d'; // parents check in occasionally, not daily — long-lived is fine

function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

function signToken(staffMember) {
  return jwt.sign(
    {
      type: 'staff',
      staff_id: staffMember.id,
      email: staffMember.email,
      access_level: staffMember.access_level,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function signFamilyToken(family) {
  return jwt.sign(
    {
      type: 'family',
      family_id: family.id,
      email: family.primary_parent_email,
    },
    JWT_SECRET,
    { expiresIn: FAMILY_JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

module.exports = { hashPassword, verifyPassword, signToken, signFamilyToken, verifyToken };
