/**
 * ─── Rate limits (BUG-04) ───────────────────────────────────────────────────
 * Small in-memory, fixed-window limits per key (IP address, signed-in user, email or token).
 * They stop password guessing, email-code spam and anyone spending Gnani/LLM credits in a loop.
 * State lives in this process; with several server processes, put the limits in Redis or the proxy.
 */

const registry = new Set();

/**
 * @param {{
 *   windowMs: number, max: number,
 *   key: (req) => string|null|undefined,   // null/undefined = not limited
 *   message?: string,
 *   countOnlySuccess?: boolean              // count a request only if it ends with a 2xx (e.g. not a "busy, wait" 429)
 * }} opts
 */
export function rateLimit({ windowMs, max, key, message, countOnlySuccess = false }) {
  const hits = new Map(); // key → { count, resetAt }
  registry.add(hits);

  return (req, res, next) => {
    // The load simulation compresses time, which would make every per-minute limit 10x stricter.
    // It may switch limits off, but only under NODE_ENV=test (never in a real deployment).
    if (process.env.NODE_ENV === 'test' && process.env.QA_RATE_LIMITS === 'off') return next();
    const k = key(req);
    if (k === null || k === undefined || k === '') return next();
    const now = Date.now();
    if (hits.size > 50000) for (const [hk, h] of hits) if (now >= h.resetAt) hits.delete(hk);
    let h = hits.get(k);
    if (!h || now >= h.resetAt) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(k, h);
    }
    if (h.count >= max) {
      const retry = Math.max(1, Math.ceil((h.resetAt - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: 'Too Many Requests', code: 'rate_limited', retry_after_seconds: retry,
        message: message || `Too many requests. Please try again in ${retry < 120 ? `${retry} seconds` : `${Math.ceil(retry / 60)} minutes`}.`
      });
    }
    if (countOnlySuccess) {
      const entry = h;
      res.on('finish', () => { if (res.statusCode < 400) entry.count += 1; });
    } else {
      h.count += 1;
    }
    next();
  };
}

/** Tests: forget every counter. */
export function resetRateLimits() {
  for (const hits of registry) hits.clear();
}

export const byIp = (req) => `ip:${req.ip}`;
export const byUser = (req) => (req.user?.id ? `user:${req.user.id}` : null);
export const byBodyEmail = (req) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `email:${email}` : null;
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// The limits, in one place. Generous for real people, tight for loops and scripts.
export const limits = {
  // Whole API per IP: a backstop against floods (100 candidates behind one office NAT stay well under it).
  api: rateLimit({ windowMs: MIN, max: 1200, key: byIp }),
  loginIp: rateLimit({ windowMs: 15 * MIN, max: 20, key: byIp, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }),
  loginEmail: rateLimit({ windowMs: 15 * MIN, max: 8, key: byBodyEmail, message: 'Too many sign-in attempts for this account. Please wait 15 minutes and try again.' }),
  codeIp: rateLimit({ windowMs: 15 * MIN, max: 10, key: byIp }),
  codeEmail: rateLimit({ windowMs: HOUR, max: 3, key: byBodyEmail, message: 'A code was already sent to this email several times. Check your inbox (and Spam), or try again in an hour.' }),
  verifyIp: rateLimit({ windowMs: 15 * MIN, max: 20, key: byIp }),
  googleIp: rateLimit({ windowMs: 15 * MIN, max: 30, key: byIp, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }),
  joinIp: rateLimit({ windowMs: 15 * MIN, max: 300, key: byIp }),
  // HR sign-up through the sign-up link: checking the code, and creating a workspace.
  signupCheckIp: rateLimit({ windowMs: 15 * MIN, max: 20, key: byIp, message: 'Too many attempts. Please wait 15 minutes and try again.' }),
  // Also used to sign in, when sign-up is open; creating workspaces is capped separately (MAX_DEMO_WORKSPACES).
  signupIp: rateLimit({ windowMs: HOUR, max: 20, key: byIp, message: 'Too many sign-ins from this network. Please try again in an hour.' }),
  joinToken: rateLimit({ windowMs: 15 * MIN, max: 20, key: (req) => (typeof req.body?.token === 'string' ? `token:${req.body.token.slice(-43)}` : null) }),
  // Candidate actions that spend LLM / Gnani credits.
  resume: rateLimit({ windowMs: HOUR, max: 6, key: byUser, message: 'You have uploaded your resume many times. Please try again in an hour, or contact HR.' }),
  callStart: rateLimit({ windowMs: HOUR, max: 30, key: byUser, countOnlySuccess: true }),
  callTurn: rateLimit({ windowMs: MIN, max: 30, key: byUser }),
  recording: rateLimit({ windowMs: HOUR, max: 10, key: byUser }),
  // HR actions that send email or create accounts.
  sendInvite: rateLimit({ windowMs: 10 * MIN, max: 60, key: byUser }),
  teamCreate: rateLimit({ windowMs: HOUR, max: 20, key: byUser })
};
