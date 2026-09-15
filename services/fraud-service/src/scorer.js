'use strict';

/**
 * Deterministic-ish fraud scorer.
 *
 * Returns { score: 0.0–1.0, decision: 'approved'|'review'|'rejected', reasons[] }
 *
 * Rules (each adds to the score):
 *   +0.40  amount > $5 000 (high-value transaction)
 *   +0.20  amount > $1 000
 *   +0.30  velocity: more than 3 payments from same user in last 60 s   (simulated)
 *   +0.25  user_id in a known-bad-actor seed list
 *   +0.10  currency is not USD (unusual for this demo merchant)
 *   −0.10  user account is older than 30 days  (trust bonus — not implemented here,
 *           but the field is documented so you know where to extend it)
 *
 * Thresholds:
 *   score < 0.40  → approved
 *   0.40–0.69     → review  (hold for manual review in a real system)
 *   ≥ 0.70        → rejected
 *
 * NOTE: This is intentionally simple. The interesting part is how payment-service
 * handles each decision — especially the at-most-once guarantees around retries.
 */

const HIGH_RISK_USERS = new Set([
  'ffffffff-ffff-ffff-ffff-ffffffffffff',  // test sentinel for "always reject"
]);

// In-memory velocity tracker (resets on restart — fine for a demo)
// Maps userId → [timestamp, timestamp, ...]
const velocityMap = new Map();
const VELOCITY_WINDOW_MS  = 60_000; // 1 minute
const VELOCITY_THRESHOLD  = 3;      // > 3 payments in window → risky

function recordVelocity(userId) {
  const now  = Date.now();
  const list = (velocityMap.get(userId) || []).filter(t => now - t < VELOCITY_WINDOW_MS);
  list.push(now);
  velocityMap.set(userId, list);
  return list.length;
}

function scorePayment({ userId, amount, currency }) {
  let score   = 0;
  const reasons = [];

  // ── Amount rules ────────────────────────────────────────────────────────────
  if (amount > 5000) {
    score += 0.40;
    reasons.push('HIGH_VALUE_TRANSACTION_5K');
  } else if (amount > 1000) {
    score += 0.20;
    reasons.push('HIGH_VALUE_TRANSACTION_1K');
  }

  // ── Currency ────────────────────────────────────────────────────────────────
  if (currency && currency.toUpperCase() !== 'USD') {
    score += 0.10;
    reasons.push('NON_USD_CURRENCY');
  }

  // ── High-risk user ───────────────────────────────────────────────────────────
  if (HIGH_RISK_USERS.has(userId)) {
    score += 0.50;
    reasons.push('HIGH_RISK_USER_ID');
  }

  // ── Velocity ─────────────────────────────────────────────────────────────────
  const count = recordVelocity(userId);
  if (count > VELOCITY_THRESHOLD) {
    score += 0.30;
    reasons.push(`VELOCITY_${count}_IN_60S`);
  }

  // Clamp to [0, 1]
  score = Math.min(1, Math.round(score * 10000) / 10000);

  let decision;
  if (score >= 0.70)      decision = 'rejected';
  else if (score >= 0.40) decision = 'review';
  else                    decision = 'approved';

  return { score, decision, reasons };
}

module.exports = { scorePayment };
