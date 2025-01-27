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
      const [targetHour, targetMinute] = settings.notificationTime.split(':').map(Number);
      const targetTimeToday = dayjs().hour(targetHour).minute(targetMinute);
      const diffInMinutes = Math.abs(now.diff(targetTimeToday, 'minute'));

      console.log('Time check:', {
        currentTime: now.format('HH:mm'),
        targetTime: settings.notificationTime,
        diffInMinutes: diffInMinutes
      });

      // Only proceed if we're within 1 minute of the target time
      if (diffInMinutes > 1) {
        console.log('Skipping notifications - not within notification window');
        return;
      }
    }

    console.log('Checking notifications...');
    
    // Process notifications in order of urgency: daily -> weekly -> monthly
    if (settings.enableDailyNotifications) {
      await this.processDailyNotifications(settings);
    }
    if (settings.enableWeeklyNotifications) {
      await this.processWeeklyNotifications(settings);
    }
    if (settings.enableMonthlyNotifications) {
      await this.processMonthlyNotifications(settings);
    }
  }

  static async getNotificationSettings() {
    // Force Prisma to fetch fresh data
    await prisma.$disconnect();
    await prisma.$connect();
    
    const settings = await prisma.notificationSettings.findFirst({
      orderBy: {
        updatedAt: 'desc'
      }
    });
    
    console.log('Current notification settings:', {
      email: settings?.email,
      enableEmailNotifications: settings?.enableEmailNotifications,
      enableDailyNotifications: settings?.enableDailyNotifications,
      enableWeeklyNotifications: settings?.enableWeeklyNotifications,
      enableMonthlyNotifications: settings?.enableMonthlyNotifications,
      notificationTime: settings?.notificationTime
    });
    return settings;
  }

  static async processMonthlyNotifications(settings) {
    if (!settings.enableMonthlyNotifications) {
      console.log('Monthly notifications are disabled');
      return;
    }

    // Only send monthly notifications on the 1st of each month
    const now = dayjs();
    if (now.date() !== 1) {
      console.log('Skipping monthly notification - not first day of month');
      return;
    }

    console.log('Processing monthly notifications...');
    const endOfMonth = now.endOf('month');
    
    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: now.toDate(),
          lte: endOfMonth.toDate()
        }
      }
    });

    if (expiringMedicines.length === 0) {
      console.log('No medicines expiring this month');
      return;
    }

    // Send a single consolidated monthly notification
    const medicineList = expiringMedicines
      .map(med => `- ${med.name} (Expires: ${dayjs(med.expiryDate).format('MMMM D, YYYY')})`)
      .join('\n');
    
    const message = `Monthly Medicine Expiry Summary\n\nThe following medicines will expire this month:\n\n${medicineList}`;
    
    // Send a single notification with all medicines
    await this.sendNotification(expiringMedicines[0], 'MONTHLY', message, settings, true);
  }

  static async processWeeklyNotifications(settings) {
    if (!settings.enableWeeklyNotifications) {
      console.log('Weekly notifications are disabled');
      return;
    }

    // Only send weekly notifications on Monday
    const now = dayjs();
    if (now.day() !== 1) {
      console.log('Skipping weekly notification - not Monday');
      return;
    }

    console.log('Processing weekly notifications...');
    const endOfWeek = now.endOf('week');
    
    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: now.toDate(),
          lte: endOfWeek.toDate()
        }
      }
    });

    if (expiringMedicines.length === 0) {
      console.log('No medicines expiring this week');
      return;
    }

    // Send a single consolidated weekly notification
    const medicineList = expiringMedicines
      .map(med => `- ${med.name} (Expires: ${dayjs(med.expiryDate).format('MMMM D, YYYY')})`)
      .join('\n');
    
    const message = `Weekly Medicine Expiry Summary\n\nThe following medicines will expire this week:\n\n${medicineList}`;
    
    // Send a single notification with all medicines
    await this.sendNotification(expiringMedicines[0], 'WEEKLY', message, settings, true);
  }

  static async processDailyNotifications(settings) {
    if (!settings.enableDailyNotifications) {
      console.log('Daily notifications are disabled');
      return;
    }

    console.log('Processing daily notifications...');
    const now = dayjs();
    const endOfWeek = now.endOf('week');
    
    const expiringMedicines = await prisma.medicine.findMany({
      where: {
        expiryDate: {
          gte: now.toDate(),
          lte: endOfWeek.toDate()
        },
        notified: false
      },
      orderBy: {
        expiryDate: 'asc'
      }
    });

    if (expiringMedicines.length === 0) {
      console.log('No medicines expiring this week');
      return;
    }

    console.log(`Found ${expiringMedicines.length} medicines expiring this week`);
    
    // Create a consolidated message for all medicines
    const medicineList = expiringMedicines
      .map(med => {
        const daysUntilExpiry = dayjs(med.expiryDate).diff(now, 'day');
        return `- ${med.name} (Expires in ${daysUntilExpiry} days on ${dayjs(med.expiryDate).format('MMMM D, YYYY')})`;
      })
      .join('\n');
    
    const message = `Daily Medicine Expiry Update\n\nThe following medicines will expire this week:\n\n${medicineList}`;
    
    // Send a single consolidated notification
    await this.sendNotification(expiringMedicines[0], 'DAILY', message, settings, true);

    // Mark all medicines as notified
    await prisma.medicine.updateMany({
      where: {
        id: {
          in: expiringMedicines.map(med => med.id)
        }
      },
      data: {
        notified: true,
        lastNotificationDate: new Date()
      }
    });
  }

  static async sendNotification(medicine, type, message, settings, isConsolidated = false) {
    try {
      // Fetch fresh settings before sending notification
      const currentSettings = await this.getNotificationSettings();
      
      console.log(`Sending ${type} notification for ${isConsolidated ? 'multiple medicines' : medicine.name}`);
      
      // Send email notification
      if (currentSettings.enableEmailNotifications && currentSettings.email) {
        console.log('Sending email notification to:', currentSettings.email);
        await this.sendEmailNotification(currentSettings.email, message, medicine, isConsolidated);
        await this.logNotification(medicine.id, type, 'EMAIL', 'success', message, currentSettings.email);
      }

      // Send push notification
      if (currentSettings.enablePushNotifications && currentSettings.endpoint) {
        console.log('Sending push notification...');
        await this.sendPushNotification(currentSettings, message);
        await this.logNotification(medicine.id, type, 'PUSH', 'success', message);
      }

      // Only update notified status for non-consolidated notifications
      if (!isConsolidated) {
        await prisma.medicine.update({
          where: { id: medicine.id },
          data: {
            notified: true,
            lastNotificationDate: new Date()
          }
        });
      }

      console.log('Notification sent successfully');
    } catch (error) {
      console.error('Notification error:', error);
      const currentSettings = await this.getNotificationSettings();
      await this.logNotification(medicine.id, type, 'EMAIL', 'failed', error.message, currentSettings?.email);
      throw error;
    }
  }

  static async sendEmailNotification(email, message, medicine, isConsolidated = false) {
    try {
      const isTestMode = process.env.RESEND_API_KEY?.startsWith('re_');
      const testEmail = 'sharmaharsh9887@gmail.com';

      let emailContent;
      if (isConsolidated) {
        // For weekly and monthly summaries
        emailContent = `
          <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
            ${isTestMode ? `
            <div style="background-color: #fff3cd; color: #856404; padding: 10px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #ffeeba;">
              <strong>Test Mode Notice:</strong> In test mode, all emails are sent to ${testEmail}. 
              Original recipient would have been: ${email}
            </div>
            ` : ''}
            <h2 style="color: #d9534f;">Medicine Expiry Summary</h2>
            <div style="background-color: white; padding: 15px; border-radius: 5px; margin: 15px 0;">
              <pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${message}</pre>
            </div>
            <hr style="border: 1px solid #eee;">
            <p style="color: #666; font-size: 14px;">This is an automated notification from your Medicine Expiry Tracker.</p>
          </div>
        `;
      } else {
        // For daily notifications
        emailContent = `
          <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
            ${isTestMode ? `
            <div style="background-color: #fff3cd; color: #856404; padding: 10px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #ffeeba;">
              <strong>Test Mode Notice:</strong> In test mode, all emails are sent to ${testEmail}. 
              Original recipient would have been: ${email}
            </div>
            ` : ''}
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
        `;
      }

      await resend.emails.send({
        from: 'Medicine Tracker <onboarding@resend.dev>',
        to: isTestMode ? testEmail : email,
        subject: isConsolidated ? 
          `Medicine Expiry Summary - ${dayjs().format('MMMM D, YYYY')}` : 
          'Medicine Expiry Alert',
        html: emailContent
      });

      if (isTestMode) {
        console.log(`Test mode: Email redirected from ${email} to ${testEmail}`);
      }
    } catch (error) {
      console.error('Email sending error:', error);
      if (error.message.includes('validation_error')) {
        console.log('Resend API is in test mode. Emails can only be sent to verified addresses.');
      }
      throw error;
    }
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

  static async logNotification(medicineId, type, channel, status, message, email = null) {
    await prisma.notificationLog.create({
      data: {
        medicineId,
        type,
        channel,
        status,
        message,
        email
      }
    });
  }
} 