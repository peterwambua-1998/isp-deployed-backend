require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Admin, Package, sequelize } = require('../models');
const { initSettings } = require('../services/settingsService');

const seed = async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });

    // Create default superadmin
    const existing = await Admin.findOne({ where: { email: 'admin@isp.co.ke' } });
    if (!existing) {
      await Admin.create({
        name: 'Super Admin',
        email: 'admin@isp.co.ke',
        password: await bcrypt.hash('Admin@1234', 12),
        role: 'superadmin',
      });
      console.log('✅ Superadmin created — email: admin@isp.co.ke  password: Admin@1234');
    }

    // const existingAdmin2 = await Admin.findOne({ where: { email: 'pwambua25@gmail.com' } });
    // if (!existing) {
    //   await Admin.create({
    //     name: 'Super Admin',
    //     email: 'admin@isp.co.ke',
    //     password: await bcrypt.hash('Admin@1234', 12),
    //     role: 'superadmin',
    //   });
    //   console.log('✅ Superadmin created — email: admin@isp.co.ke  password: Admin@1234');
    // }

    // Create sample packages
    // const packages = [
    //   // Hotspot — minute-based (timed passes)
    //   { name: '1 Hour',    type: 'hotspot', price: 20,   duration_days: 0, duration_minutes: 60,   speed_download: 2048,  speed_upload: 1024  },
    //   { name: '3 Hours',   type: 'hotspot', price: 50,   duration_days: 0, duration_minutes: 180,  speed_download: 2048,  speed_upload: 1024  },
    //   { name: '12 Hours',  type: 'hotspot', price: 80,   duration_days: 0, duration_minutes: 720,  speed_download: 5120,  speed_upload: 2048  },
    //   // Hotspot — day-based
    //   { name: 'Daily 2Mbps',   type: 'hotspot', price: 50,   duration_days: 1,  duration_minutes: 0, speed_download: 2048,  speed_upload: 1024  },
    //   { name: 'Weekly 5Mbps',  type: 'hotspot', price: 200,  duration_days: 7,  duration_minutes: 0, speed_download: 5120,  speed_upload: 2048  },
    //   // PPPoE — day-based monthly plans
    //   { name: 'Monthly 10Mbps', type: 'pppoe', price: 1500, duration_days: 30, duration_minutes: 0, speed_download: 10240, speed_upload: 5120  },
    //   { name: 'Monthly 20Mbps', type: 'pppoe', price: 2500, duration_days: 30, duration_minutes: 0, speed_download: 20480, speed_upload: 10240 },
    // ];

    // for (const pkg of packages) {
    //   await Package.findOrCreate({ where: { name: pkg.name }, defaults: pkg });
    // }
    // console.log('✅ Sample packages created');
    await initSettings()

    console.log('🎉 Seed complete!');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
};

seed();