// Round-trip check of the Gnani speech setup: Timbre speaks a sentence as 16 kHz WAV, Prisma
// transcribes it back. Uses a few speech credits.
// Run: node backend/scripts/speechSmokeTest.js ["sentence"] [mixed|en|hi]
import { speak, transcribe, sttModel } from '../src/services/gnaniSpeech.js';
import { sttLanguage, ttsLanguage } from '../src/services/callLanguage.js';

const sentence = process.argv[2] || 'Mera notice period do mahine ka hai, aur expected CTC nau lakh hai.';
const language = process.argv[3] || 'mixed';

console.log(`Speaking: "${sentence}"`);
const spoken = await speak(sentence, { container: 'wav', sampleRate: 16000, language: ttsLanguage(language) });
console.log(`Timbre: ${spoken.audio.length} bytes ${spoken.contentType} in ${spoken.ms} ms`);

const heard = await transcribe(spoken.audio, { format: 'wav', language: sttLanguage(language), previousText: 'Aapka notice period aur expected CTC kitna hai?' });
console.log(`Prisma (${heard.model || sttModel()}, ${sttLanguage(language)}): "${heard.transcript}" in ${heard.ms} ms${heard.detectedLanguage ? `, detected ${heard.detectedLanguage}` : ''}`);
