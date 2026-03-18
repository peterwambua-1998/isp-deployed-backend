const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.MYSQLDATABASE,
  process.env.MYSQLUSER,
  process.env.MYSQLPASSWORD,
  {
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT || 3306,
    dialect: 'mysql',
    logging:  false,
    pool: {
      max: 20,
      min: 0,
      acquire: 30000,
      idle: 10000,
      evict: 10000,
    
    },
    define: {
      timestamps: true,
      underscored: true,
    },
  }
);

module.exports = sequelize;
