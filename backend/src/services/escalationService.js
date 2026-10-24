/**
 * Config-driven Escalation Detection Engine.
 * Evaluates transcripts, sentiment, and durations against script configurations.
 */

/**
 * Checks if a call needs to be escalated to a human based on script-defined triggers.
 * @param {string} transcript The text transcript of the lead's utterance.
 * @param {number} duration The duration of the call in seconds.
 * @param {number|string} sentiment The sentiment score (0 to 1) or string label ('positive', 'negative', etc.).
 * @param {object} scriptConfig The active script configuration object.
 * @returns {object} Escalation check result { shouldEscalate: boolean, reason: string|null, detail: string|null }
 */
export function checkEscalation(transcript, duration, sentiment, scriptConfig) {
  if (!scriptConfig || !scriptConfig.escalation_triggers || !Array.isArray(scriptConfig.escalation_triggers)) {
    return { shouldEscalate: false, reason: null, detail: null };
  }

  const normalizedTranscript = (transcript || '').toLowerCase().trim();

  // Normalize sentiment score (0 to 1 scale)
  let sentimentVal = 0.5;
  if (typeof sentiment === 'number') {
    sentimentVal = sentiment;
  } else if (typeof sentiment === 'string') {
    const s = sentiment.toLowerCase();
    if (s === 'negative' || s.includes('angry') || s.includes('frustrated')) {
      sentimentVal = 0.1;
    } else if (s === 'neutral') {
      sentimentVal = 0.5;
    } else if (s === 'positive' || s.includes('happy')) {
      sentimentVal = 1.0;
    }
  }

  for (const trigger of scriptConfig.escalation_triggers) {
    // 1. Explicit Human Request
    if (trigger.type === 'explicit_request') {
      const phrases = trigger.phrases || [];
      for (const phrase of phrases) {
        if (normalizedTranscript.includes(phrase.toLowerCase())) {
          return {
            shouldEscalate: true,
            reason: 'explicit_request',
            detail: `Matched explicit phrase: "${phrase}"`
          };
        }
      }
    }

    // 2. Sentiment Score Below Threshold
    if (trigger.type === 'sentiment_low') {
      const threshold = trigger.threshold !== undefined ? trigger.threshold : 0.3;
      if (sentimentVal < threshold) {
        return {
          shouldEscalate: true,
          reason: 'sentiment_low',
          detail: `Sentiment score ${sentimentVal} is below threshold ${threshold}`
        };
      }
    }

    // 3. High-Intent Phrases
    if (trigger.type === 'high_intent') {
      const phrases = trigger.phrases || [];
      for (const phrase of phrases) {
        if (normalizedTranscript.includes(phrase.toLowerCase())) {
          return {
            shouldEscalate: true,
            reason: 'high_intent',
            detail: `Matched high-intent phrase: "${phrase}"`
          };
        }
      }
    }

    // 4. Max Call Duration Exceeded
    if (trigger.type === 'max_duration') {
      const maxSec = trigger.seconds !== undefined ? trigger.seconds : (scriptConfig.max_duration_seconds || 300);
      if (duration !== undefined && duration >= maxSec) {
        return {
          shouldEscalate: true,
          reason: 'max_duration',
          detail: `Call duration of ${duration}s exceeded max allowed limit of ${maxSec}s`
        };
      }
    }
  }

  // Fallback check on root max_duration_seconds
  if (duration !== undefined && scriptConfig.max_duration_seconds && duration >= scriptConfig.max_duration_seconds) {
    return {
      shouldEscalate: true,
      reason: 'max_duration',
      detail: `Call duration of ${duration}s exceeded script limit of ${scriptConfig.max_duration_seconds}s`
    };
  }

  return { shouldEscalate: false, reason: null, detail: null };
}

export default {
  checkEscalation
};
