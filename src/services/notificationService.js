import { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';
import webpush from 'web-push';
import dayjs from 'dayjs';

const prisma = new PrismaClient();

// Configure Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Configure web push
webpush.setVapidDetails(
  'mailto:noreply@medicinetracker.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export class NotificationService {
  static async checkAndSendNotifications(forceCheck = false) {
    const settings = await this.getNotificationSettings();
    if (!settings) return;

    // Skip time check if forceCheck is true
    if (!forceCheck) {
      const now = dayjs();
      const targetTime = dayjs(settings.notificationTime, 'HH:mm');
      const currentMinute = now.hour() * 60 + now.minute();
      const targetMinute = targetTime.hour() * 60 + targetTime.minute();
      
      // Check if current time is within 1 minute before or after target time
      if (Math.abs(currentMinute - targetMinute) > 1) return;
    }

    console.log('Checking notifications...');
    await this.processMonthlyNotifications(settings);
    await this.processWeeklyNotifications(settings);
    await this.processDailyNotifications(settings);
  }

  static async getNotificationSettings() {
    return prisma.notificationSettings.findFirst();
  }

  static async processMonthlyNotifications(settings) {
    if (!settings.enableMonthlyNotifications) return;

    console.log('Processing monthly notifications...');
    const startOfMonth = dayjs().startOf('month');
    const endOfMonth = dayjs().endOf('month');

    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: startOfMonth.toDate(),
          lte: endOfMonth.toDate()
        },
        notified: false
      }
    });

    console.log(`Found ${expiringMedicines.length} medicines expiring this month`);
    for (const medicine of expiringMedicines) {
      const message = `Medicine ${medicine.name} will expire this month on ${dayjs(medicine.expiryDate).format('MMMM D, YYYY')}`;
      await this.sendNotification(medicine, 'MONTHLY', message, settings);
    }
  }

  static async processWeeklyNotifications(settings) {
    if (!settings.enableWeeklyNotifications) return;

    console.log('Processing weekly notifications...');
    const now = dayjs();
    const oneWeekLater = now.add(7, 'day');
    
    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: now.toDate(),
          lte: oneWeekLater.toDate()
        },
        notified: false
      }
    });

    console.log(`Found ${expiringMedicines.length} medicines expiring within a week`);
    for (const medicine of expiringMedicines) {
      const daysUntilExpiry = dayjs(medicine.expiryDate).diff(now, 'day');
      const message = `Medicine ${medicine.name} will expire in ${daysUntilExpiry} days on ${dayjs(medicine.expiryDate).format('MMMM D, YYYY')}`;
      await this.sendNotification(medicine, 'WEEKLY', message, settings);
    }
  }

  static async processDailyNotifications(settings) {
    if (!settings.enableDailyNotifications) return;

    console.log('Processing daily notifications...');
    const now = dayjs();
    const tomorrow = now.add(1, 'day');
    
    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: now.toDate(),
          lte: tomorrow.toDate()
        },
        notified: false
      }
    });

    console.log(`Found ${expiringMedicines.length} medicines expiring within 24 hours`);
    for (const medicine of expiringMedicines) {
      const message = `URGENT: Medicine ${medicine.name} will expire tomorrow on ${dayjs(medicine.expiryDate).format('MMMM D, YYYY')}`;
      await this.sendNotification(medicine, 'DAILY', message, settings);
    }
  }

  static async sendNotification(medicine, type, message, settings) {
    try {
      console.log(`Sending ${type} notification for ${medicine.name}`);
      
      // Send email notification
      if (settings.enableEmailNotifications && settings.email) {
        console.log('Sending email notification...');
        await this.sendEmailNotification(settings.email, message, medicine);
        await this.logNotification(medicine.id, type, 'EMAIL', 'success', message);
      }

      // Send push notification
      if (settings.enablePushNotifications && settings.endpoint) {
        console.log('Sending push notification...');
        await this.sendPushNotification(settings, message);
        await this.logNotification(medicine.id, type, 'PUSH', 'success', message);
      }

      // Update medicine notification status
      await prisma.medicine.update({
        where: { id: medicine.id },
        data: {
          lastNotificationDate: new Date()
        }
      });

      console.log('Notification sent successfully');
    } catch (error) {
      console.error('Notification error:', error);
      await this.logNotification(medicine.id, type, 'EMAIL', 'failed', error.message);
      throw error;
    }
  }

  static async sendEmailNotification(email, message, medicine) {
    await resend.emails.send({
      from: 'Medicine Tracker <onboarding@resend.dev>',
      to: email,
      subject: 'Medicine Expiry Alert',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
          <h2 style="color: #d9534f;">Medicine Expiry Alert</h2>
          <div style="background-color: white; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <h3 style="color: #333; margin-top: 0;">Medicine Details:</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Name:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${medicine.name}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Expiry Date:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${dayjs(medicine.expiryDate).format('MMMM D, YYYY')}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Quantity:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${medicine.quantity}</td>
              </tr>
              ${medicine.batchNumber ? `
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Batch Number:</strong></td>
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${medicine.batchNumber}</td>
              </tr>
              ` : ''}
            </table>
          </div>
          <p style="font-size: 16px; color: #333; margin-top: 20px;">${message}</p>
          <hr style="border: 1px solid #eee;">
          <p style="color: #666; font-size: 14px;">This is an automated notification from your Medicine Expiry Tracker.</p>
        </div>
      `
    });
  }

  static async sendPushNotification(settings, message) {
    const subscription = {
      endpoint: settings.endpoint,
      keys: {
        p256dh: settings.p256dh,
        auth: settings.auth
      }
    };

    await webpush.sendNotification(subscription, message);
  }

  static async logNotification(medicineId, type, channel, status, message) {
    await prisma.notificationLog.create({
      data: {
        medicineId,
        type,
        channel,
        status,
        message
      }
    });
  }
} 