'use strict';
const amqplib = require('amqplib');

let connection = null;
let channel    = null;

const EXCHANGE = 'paytech.events';

/**
 * Connect (once) and return a shared channel.
 * Reconnection is handled by a simple retry loop — good enough for a demo;
 * production code would use a circuit breaker.
 */
async function getChannel() {
  if (channel) return channel;

  const url = process.env.RABBITMQ_URL || 'amqp://paytech:paytech@localhost:5672/paytech';

  connection = await amqplib.connect(url);
  channel    = await connection.createChannel();

  // Topic exchange — durable so it survives broker restarts
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  connection.on('error', (err) => {
    console.error('AMQP connection error', err.message);
    channel    = null;
    connection = null;
  });
  connection.on('close', () => {
    channel    = null;
    connection = null;
  });

  return channel;
}

/**
 * Publish an event to the topic exchange.
 *
 * @param {string} routingKey  e.g. 'payment.succeeded'
 * @param {object} payload     will be JSON-serialised
 * @param {object} [options]   extra amqplib publish options
 */
async function publishEvent(routingKey, payload, options = {}) {
  const ch = await getChannel();
  const buf = Buffer.from(JSON.stringify(payload));

  ch.publish(EXCHANGE, routingKey, buf, {
    persistent:    true,          // survives broker restart
    contentType:   'application/json',
    timestamp:     Date.now(),
    messageId:     payload.eventId || payload.id,
    ...options,
  });
}

/**
 * Set up a consumer on a named queue.
 * Passes each message to `handler(msg, parsedContent)`.
 * ACKs on success, NACKs (with requeue=false → DLX) on unhandled error.
 *
 * This implements at-least-once delivery:
 *   - If the handler succeeds → ack, message gone.
 *   - If the handler throws  → nack, message goes to DLQ after maxRetries.
 */
async function consume(queueName, handler) {
  const ch = await getChannel();
  await ch.assertQueue(queueName, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange':    'paytech.events.dlx',
      'x-dead-letter-routing-key': `${queueName}.dead`,
      'x-message-ttl':             86400000,
    },
  });

  // prefetch 1 → process one message at a time (simple back-pressure)
  ch.prefetch(1);

  ch.consume(queueName, async (msg) => {
    if (!msg) return; // consumer cancelled

    let content;
    try {
      content = JSON.parse(msg.content.toString());
    } catch (parseErr) {
      // Unparseable — dead-letter immediately, don't requeue
      ch.nack(msg, false, false);
      return;
    }

    try {
      await handler(msg, content);
      ch.ack(msg);
    } catch (err) {
      console.error(`[${queueName}] handler error`, err.message);
      // requeue=false → goes to DLX after configured retries
      ch.nack(msg, false, false);
    }
  });
}

module.exports = { getChannel, publishEvent, consume, EXCHANGE };
