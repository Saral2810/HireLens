import { Router } from 'express';
import multer from 'multer';
import { speak, transcribe } from '../services/gnaniSpeech.js';
import { decideTurn } from '../services/brain.js';

/**
 * TEMPORARY call-loop spike (roadmap B.3). HR-only test endpoints; replaced by routes/call.js
 * and removed in Phase G.
 */

const router = Router();
// 60 s of 16 kHz mono 16-bit WAV is ~1.9 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const CLOSING_LINE = 'Dhanyavaad! Aapke saare answers record ho gaye hain. Aapka din shubh ho.';

/** POST /api/spike/speak { text } → MP3 audio */
router.post('/speak', async (req, res, next) => {
  try {
    const voice = await speak(String(req.body?.text || ''));
    res.set('Content-Type', voice.contentType);
    res.set('X-Timbre-Ms', String(voice.ms));
    res.send(voice.audio);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/spike/turn (multipart)
 *   audio          WAV clip of the candidate's answer
 *   question       question the agent asked
 *   answer_type    yes_no | duration | ctc | text
 *   attempt        how many times this question has been asked (1 or 2)
 *   next_question  what to say if the answer is accepted (empty = closing line)
 * → transcript, brain decision, what the agent says next (as MP3, base64) and per-step timings
 */
router.post('/turn', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Bad Request', message: 'An audio file is required.' });
    }
    const { question = '', answer_type: answerType = 'text', next_question: nextQuestion = '' } = req.body || {};
    const attempt = Math.max(1, parseInt(req.body?.attempt, 10) || 1);
    const started = Date.now();

    const heard = await transcribe(req.file.buffer, { format: 'wav' });
    const decision = await decideTurn({ question, answerType, transcript: heard.transcript, attempt });
    const sayText = decision.action === 'repeat' ? decision.say : (nextQuestion.trim() || CLOSING_LINE);
    const voice = await speak(sayText);

    res.json({
      transcript: heard.transcript,
      decision: { action: decision.action, extracted: decision.extracted, source: decision.source },
      say_text: sayText,
      audio_base64: voice.audio.toString('base64'),
      audio_type: voice.contentType,
      timings: { stt_ms: heard.ms, brain_ms: decision.ms, tts_ms: voice.ms, total_ms: Date.now() - started }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
