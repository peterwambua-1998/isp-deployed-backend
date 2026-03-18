const logger = require('../config/logger');

// Global error handler
const errorHandler = (err, req, res, next) => {
  // logger.error(err.message, { stack: err.stack, path: req.path });
  console.log(err);

  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors.map((e) => e.message),
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      success: false,
      message: 'Record already exists',
      field: err.errors[0]?.path,
    });
  }

  return res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
  });
};

// 404 handler
const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
};

// Standard success response helper — attach to res
const responseHelper = (req, res, next) => {
  res.success = (data, message = 'Success', statusCode = 200) => {
    return res.status(statusCode).json({ success: true, message, data });
  };
  res.paginated = (data, total, page, limit) => {
    return res.status(200).json({
      success: true,
      data,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  };
  next();
};

module.exports = { errorHandler, notFound, responseHelper };
