import crypto from 'crypto';
import fs from 'fs';

/**
 * ─── Browser security headers (BUG-32 / BUG-15) ─────────────────────────────
 * The app is reachable on a public address, so every response tells the browser to: run only this
 * site's own scripts (CSP), never show the app inside another site's frame (clickjacking), not guess
 * content types, not send page addresses (which can hold invite tokens) to other sites, and stay on HTTPS.
 * The one outside script is Google's sign-in button (accounts.google.com/gsi), for candidate sign-in.
 */
const GOOGLE_GSI = 'https://accounts.google.com/gsi/';

/** sha256 hashes of the inline <script> blocks in the built index.html (the theme switch), for the CSP. */
function inlineScriptHashes(indexFile) {
  try {
    const html = fs.readFileSync(indexFile, 'utf8');
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  } catch {
    return [];
  }
}

/**
 * @param {{ indexFile: string }} opts the built client's index.html
 */
export function securityHeaders({ indexFile }) {
  const supabase = (() => { try { return new URL(process.env.SUPABASE_URL || '').origin; } catch { return ''; } })();
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${GOOGLE_GSI}client ${inlineScriptHashes(indexFile).join(' ')}`.trim(),
    // React sets style attributes, the fonts come from Google Fonts, the sign-in button styles from Google.
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${GOOGLE_GSI}style`,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    // Mic-check playback (blob:) and HR's 10-minute signed links to recordings in Supabase storage.
    `media-src 'self' blob: data: ${supabase}`.trim(),
    `connect-src 'self' ${GOOGLE_GSI}`,
    // Google's sign-in button is an iframe from Google; nothing else may be framed.
    `frame-src ${GOOGLE_GSI}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');

  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Only the origin, never the path or query (which can hold an invite token). Google's sign-in
      // button needs the origin to check the page is allowed to use the client ID.
      'Referrer-Policy': 'strict-origin',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
      // Google's sign-in popup must be able to report back to this page.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
    });
    // req.secure honours X-Forwarded-Proto from the tunnel/proxy (trust proxy is set in app.js).
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  };
}

/**
 * CORS: only the app's own address (and the Vite dev server) may call the API from a browser.
 * The UI is served from the same origin, so normal use needs no CORS at all.
 */
export function allowedOrigins() {
  const list = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${process.env.PORT || 3000}`]);
  try { if (process.env.PUBLIC_APP_URL) list.add(new URL(process.env.PUBLIC_APP_URL).origin); } catch { /* ignored */ }
  return list;
}
