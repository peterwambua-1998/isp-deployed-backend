const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { Admin } = require('../models');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { email, password } = req.body;
      const admin = await Admin.findOne({ where: { email } });

      if (!admin || !(await bcrypt.compare(password, admin.password))) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      if (!admin.is_active) {
        return res.status(403).json({ success: false, message: 'Account is deactivated' });
      }

      const token = jwt.sign(
        { id: admin.id, role: admin.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      return res.success({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, 'Login successful');
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const { id, name, email, role } = req.admin;
  return res.success({ id, name, email, role });
});

// POST /api/auth/change-password
router.post(
  '/change-password',
  authenticate,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 6 }).withMessage('Min 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { current_password, new_password } = req.body;
      const admin = await Admin.findByPk(req.admin.id);

      if (!(await bcrypt.compare(current_password, admin.password))) {
        return res.status(400).json({ success: false, message: 'Current password incorrect' });
      }

      admin.password = await bcrypt.hash(new_password, 12);
      await admin.save();

      return res.success(null, 'Password changed successfully');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
