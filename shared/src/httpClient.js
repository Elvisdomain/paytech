'use strict';
const http  = require('http');
const https = require('https');

/**
 * Minimal HTTP client with retry + exponential back-off.
 * Used by payment-service to call fraud-service and ledger-service synchronously.
 *
 * Retries on:
 *   - Network errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT)
 *   - 5xx responses
 *
 * Does NOT retry on:
 *   - 4xx (client errors are deterministic)
 */
async function request(urlStr, { method = 'GET', body, headers = {}, maxRetries = 3, baseDelayMs = 200 } = {}) {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const allHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...headers,
  };

  const bodyStr = body ? JSON.stringify(body) : undefined;
  if (bodyStr) {
    allHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = lib.request(
          {
            hostname: url.hostname,
            port:     url.port || (isHttps ? 443 : 80),
            path:     url.pathname + url.search,
            method,
            headers:  allHeaders,
          },
          (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
              let parsed;
              try { parsed = JSON.parse(raw); } catch { parsed = raw; }
              resolve({ status: res.statusCode, body: parsed });
            });
          }
        );

        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
        });

        if (bodyStr) req.write(bodyStr);
        req.end();
      });

      // Don't retry 4xx
      if (result.status >= 400 && result.status < 500) return result;
      // Retry 5xx
      if (result.status >= 500 && attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return result;
    } catch (err) {
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);
      if (retryable && attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { request };
