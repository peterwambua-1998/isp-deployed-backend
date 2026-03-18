const logger = require('../config/logger');
const sms = require('./smsService');
const email = require('./emailService');
const { Notification, Admin } = require('../models');


/**
 *  notify options
 * 
 * @param {string} options.event 
 * @param {string} options.recipient_type 
 * @param {string} [options.recipient_id]
 * @param {string} options.title 
 * @param {string} options.message
 * @param {string[]} options.channels  
 * @param {string} [options.ref_type]
 * @param {string} [options.ref_id]
 * @param {object} [options.smsOpts]
 * @param {object} [options.emailOpts]
*/

const notify = async ({
    event,
    recipient_type,
    recipient_id,
    title,
    message,
    channels = ['inapp'],
    ref_type,
    ref_id,
    smsOpts,
    emailOpts
}) => {
    let sms_status = 'skipped';
    let email_status = 'skipped';

    // 1. sms
    if (channels.includes('sms') && smsOpts?.phone) {
        try {
            const result = await smsOpts.templateFn(smsOpts.phone, smsOpts.templateArgs);
            sms_status = result?.success ? 'sent' : 'failed';
        } catch (error) {
            sms_status = 'failed';
            logger.error(`Notification SMS error [${event}] : ${error.message}`)
        }
    }

    // 2. email
    if (channels.includes('email') && emailOpts?.to) {
        try {
            const result = await emailOpts.templateFn(emailOpts.to, emailOpts.templateArgs);
            email_status = result?.success ? 'sent' : 'failed'
        } catch (error) {
            email_status = 'failed';
            logger.error(`Notification email error [${event}] : ${error.message}`);
        }
    }


    // 3. in app 
    if (channels.includes('inapp')) {
        try {
            await Notification.create({
                event,
                recipient_type,
                recipient_id: recipient_id || null,
                title,
                message,
                channels,
                sms_status,
                email_status,
                ref_type: ref_type || null,
                ref_id: ref_id || null,
                read: false
            })
        } catch (error) {
            logger.error(`Notification DB save error [${event}]: ${error.message}`)
        }
    }
}

// Get all admin emails for broadcasting admin alerts
const getAdminEmails = async () => {
    try {
        const admins = await Admin.findAll({
            where: { is_active: true },
            attributes: 'email',
        });
        return admins.map(a => a.email).filter(Boolean);
    } catch (error) {
        return [];
    }
}

// public notification events

/**
 * notify payment received
 * -> Customer gets: SMS + Email
 * -> Admin sees: in-app bell
 */
const nofiyPaymentReceived = async ({ customer, payment, pkg }) => {
    const templateArgs = {
        fullName: customer.full_name,
        amount: payment.amount,
        receipt: payment.mpeas_receipt || 'N/A',
        packageName: pkg.name,
        expiryDate: customer.expiry_date
    };

    const title = `Payment recevied = KES ${payment.amount}`;
    const message = `${customer.full_name} paid KES ${payment.amount} for ${pkg.name}`;


    // customer notification (SMS + Email)
    if (customer.phone || customer.email) {
        await notify({
            event: 'payment_received',
            recipient_type: 'customer',
            recipient_id: customer.id,
            title,
            message: `Your payment of KES ${payment.amount} for ${pkg.name} has been received.`,
            channels: ['inapp', 'sms', 'email'].filter(c => {
                if (c === 'sms') return !!customer.phone;
                if (c === 'email') return !!customer.email;
                return true;
            }),
            ref_type: 'payment',
            ref_id: payment.id,
            smsOpts: customer.phone ? {
                phone: customer.phone,
                templateFn: sms.sendPaymentConfirmed,
                templateArgs,
            } : null,
            emailOpts: customer.email ? {
                to: customer.email,
                templateFn: email.sendPaymentEmail,
                templateArgs,
            } : null
        });
    }

    // admin in-app notification
    await notify({
        event: 'payment_received',
        recipient_type: 'admin',
        title,
        message,
        channels: ['inapp'],
        ref_type: 'payment',
        ref_id: payment.id
    })
};

/**
 * notifyCustomerCreated
 * -> Customer gets: email (welcome)
 */
const notifyCustomerCreated = async ({ customer, pkg }) => {
    const title = `New customer: ${customer.full_name}`;
    const message = `${customer.full_name} joined on ${pkg?.name || 'unknown'} package`;

    // Customer welcome (Email)
    if (customer.email) {
        await notify({
            event: 'customer_created',
            recipient_type: 'customer',
            recipient_id: customer.id,
            title: `Welcome to ${process.env.APP_NAME || 'ISP Billing'}!`,
            message: `Your account has been created. Username: ${customer.username}`,
            channels: ['email'],
            ref_type: 'customer',
            ref_id: customer.id,
            emailOpts: customer.email ? {
                to: customer.email,
                templateFn: email.sendWelcomeEmail,
                templateArgs: {
                    fullName: customer.full_name,
                    packageName: pkg?.name || 'N/A',
                },
            } : null,
        })
    }

    // Admin in-app
    await notify({
        event: 'customer_created',
        recipient_type: 'admin',
        title,
        message,
        channels: ['inapp'],
        ref_type: 'customer',
        ref_id: customer.id,
    });
}


/**
 * notifyRouterOffline
 * → Admin gets: in-app bell + Email (to all active admins)
 * No SMS for admin router alerts — email is more appropriate for infra alerts
 */
const notifyRouterOffline = async ({ router }) => {
    try {

        const title = `Router offline: ${router.name}`;
        const message = `${router.name} (${router.ip_address}) went offline at ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`;

        const emailArgs = {
            routerName: router.name,
            routerIp: router.ip_address,
            detectedAt: new Date(),
        };

        // Get all admin emails for broadcast
        const adminEmails = await getAdminEmails();

        // Send one email per admin (non-blocking, best-effort)
        adminEmails.forEach(adminEmail => {
            email.sendRouterOfflineEmail(adminEmail, emailArgs).catch(() => { });
        });

        // One in-app notification (visible to all admins in the bell)
        await notify({
            event: 'router_offline',
            recipient_type: 'admin',
            title,
            message,
            channels: ['inapp', ...(adminEmails.length > 0 ? ['email'] : [])],
            email_status: adminEmails.length > 0 ? 'sent' : 'skipped',
            ref_type: 'router',
            ref_id: router.id,
        });

    } catch (error) {
        console.log(error);
    }
};

/**
 * notifyRouterOnline
 * → Admin sees: in-app bell only (recovery notice)
 */
const notifyRouterOnline = async ({ router }) => {
    await notify({
        event: 'router_online',
        recipient_type: 'admin',
        title: `Router back online: ${router.name}`,
        message: `${router.name} (${router.ip_address}) is back online.`,
        channels: ['inapp'],
        ref_type: 'router',
        ref_id: router.id,
    });
};

module.exports = {
    notify,
    notifyCustomerCreated,
    notifyRouterOffline,
    notifyRouterOnline,
};