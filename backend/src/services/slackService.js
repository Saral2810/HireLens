import dotenv from 'dotenv';
import { logExternalCall, generateRequestId } from './observability/externalCallLogger.js';

dotenv.config();

// Optional: set SLACK_WEBHOOK_URL in .env to get notifications. If unset, messages are just logged.

const recentSlackNotifications = new Map();

function getMessageDedupKey(message) {
  if (typeof message !== 'string') return null;
  // Specific key for campaign completions to prevent duplicate completion messages with slight timestamp differences
  const campaignMatch = message.match(/\[Campaign Completed\]\s*\*?([^\s\n*•]+)/);
  if (campaignMatch) {
    return `campaign_completed:${campaignMatch[1].trim()}`;
  }
  // General normalization: strip dynamic times and timestamps
  return message
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|AM|PM)?\s*IST\b/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sends a notification to Slack or prints to stdout in offline mock mode.
 * @param {string} message The message body.
 */
export async function sendSlackNotification(message) {
  if (!message || typeof message !== 'string') return;

  const dedupKey = getMessageDedupKey(message);
  const now = Date.now();
  if (dedupKey) {
    // Clean old entries older than 10 minutes
    for (const [k, ts] of recentSlackNotifications.entries()) {
      if (now - ts > 10 * 60 * 1000) recentSlackNotifications.delete(k);
    }

    const windowMs = dedupKey.startsWith('campaign_completed:') ? 5 * 60 * 1000 : 15 * 1000;
    const lastSent = recentSlackNotifications.get(dedupKey);
    if (lastSent && (now - lastSent) < windowMs) {
      console.warn(`[SlackService] Dropped duplicate Slack notification (${Math.round((now - lastSent) / 1000)}s since last): ${dedupKey}`);
      return;
    }
    recentSlackNotifications.set(dedupKey, now);
  }

  if (process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test'))) {
    console.log(`[Slack Notification Test/Mock] Channel #notifications: ${message}`);
    return;
  }

  const envUrl = process.env.SLACK_WEBHOOK_URL;
  const webhookUrl = envUrl || '';

  if (webhookUrl && webhookUrl !== 'https://hooks.slack.com/services/mock/webhook/url') {
    const requestId = generateRequestId();
    const startTime = Date.now();
    let response = null;
    let fetchErr = null;
    let respBody = null;

    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
      });
      if (response) {
        try {
          const clone = response.clone();
          respBody = await clone.text();
        } catch {}
      }
      if (!response.ok) {
        console.error(`Slack webhook error: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      fetchErr = error;
      console.error('Failed to dispatch Slack webhook notification:', error);
    } finally {
      await logExternalCall({
        service: 'slack',
        endpoint: webhookUrl,
        method: 'POST',
        request_id: requestId,
        payload: {
          headers: { 'Content-Type': 'application/json' },
          body: { text: message }
        },
        response_status: response ? response.status : null,
        response_body: respBody,
        duration_ms: Date.now() - startTime,
        error: fetchErr ? fetchErr.message : null
      }).catch(() => {});
    }
  } else {
    console.log(`[Slack Notification Mock] Channel #notifications: ${message}`);
  }
}

export default {
  sendSlackNotification
};
