// Fake SMTP transport for the QA suite: captures every email instead of sending it.
// The real mailer also refuses to create a real transport while NODE_ENV=test.
import { useTestTransport } from '../../../backend/src/services/mailer.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {{ latencyMs?: number, fail?: (message, n) => Error|null }} [opts]
 * @returns {{ sent: object[], active: number, maxActive: number, attempts: number, linkFor: (email: string) => string|null, uninstall: () => void }}
 */
export function installFakeMail({ latencyMs = 0, fail = null } = {}) {
  const box = { sent: [], active: 0, maxActive: 0, attempts: 0 };
  box.transport = {
    async sendMail(message) {
      box.attempts += 1;
      const n = box.attempts;
      box.active += 1;
      box.maxActive = Math.max(box.maxActive, box.active);
      try {
        if (latencyMs) await sleep(latencyMs);
        const err = fail?.(message, n);
        if (err) throw err;
        box.sent.push({ ...message, link: extractLink(message.text) });
        return { messageId: `<qa-${n}@fake.mail>` };
      } finally {
        box.active -= 1;
      }
    }
  };
  box.linkFor = (email) => [...box.sent].reverse().find(m => m.to === email)?.link || null;
  box.uninstall = () => useTestTransport(null);
  useTestTransport(box.transport);
  return box;
}

/** The /join link in an invite email's text. */
export function extractLink(text) {
  return String(text || '').match(/https?:\/\/\S+\/join\?t=\S+/)?.[0] || null;
}

/** The token part of a /join link. */
export const tokenOf = (link) => decodeURIComponent(new URL(link).searchParams.get('t') || '');
