// Password hashing and JWT helpers for staff dashboard authentication.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '12h'; // staff re-login roughly once a shift/day

function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

function signToken(staffMember) {
  return jwt.sign(
    {
      staff_id: staffMember.id,
      email: staffMember.email,
      access_level: staffMember.access_level,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
