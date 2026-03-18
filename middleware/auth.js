const jwt = require('jsonwebtoken');
const { Admin } = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    console.log('peter');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const admin = await Admin.findByPk(decoded.id);
    if (!admin || !admin.is_active) {
      return res.status(401).json({ success: false, message: 'Invalid or inactive account' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token expired or invalid' });
  }
};

// Role guard — usage: authorize('superadmin') or authorize('superadmin','admin')
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    next();
  };
};

module.exports = { authenticate, authorize };
