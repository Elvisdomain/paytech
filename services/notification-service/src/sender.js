'use strict';

/**
 * Notification sender.
 *
 * In production this would call SendGrid / SES / Twilio.
 * Here we log to stdout so the demo is runnable without external credentials.
 *
 * The SIMULATE_SEND_FAILURE env var lets you test the failure scenario:
 *   SIMULATE_SEND_FAILURE=0.5  →  50% of sends throw an error
 *
 * This lets you watch:
 *   1. notification_log row gets inserted (event claimed)
 *   2. sendNotification throws
 *   3. error is logged
 *   4. message is still ACKed (claimed but unsent)
 *
 * You can then query notification_log to find sent_at IS NULL rows.
 */
async function sendNotification({ event, eventType, logger }) {
  const failureRate = parseFloat(process.env.SIMULATE_SEND_FAILURE || '0');
  if (failureRate > 0 && Math.random() < failureRate) {
    throw new Error(`Simulated send failure (rate=${failureRate})`);
  }

  const { userId, paymentId, amount, currency, status } = event;

  // In a real system: look up the user's email from user-service or a local cache
  const recipient = `user-${userId}@example.com`;

  const templates = {
    'payment.succeeded': {
      subject: `Payment confirmed — ${currency} ${amount}`,
      body:    `Your payment of ${currency} ${amount} (id: ${paymentId}) was successful.`,
    },
    'payment.failed': {
      subject: `Payment failed — ${currency} ${amount}`,
      body:    `Your payment of ${currency} ${amount} (id: ${paymentId}) could not be processed. Please try again.`,
    },
  };

  const template = templates[eventType] || {
    subject: `Payment update`,
    body:    `Your payment status: ${status}`,
  };

  // Simulate async I/O (SMTP, HTTP call to email provider)
  await new Promise((r) => setTimeout(r, 20));

  logger.info(
    {
      to:        recipient,
      subject:   template.subject,
      paymentId,
      userId,
      eventType,
    },
    '📧 notification sent'
  );
}

module.exports = { sendNotification };
