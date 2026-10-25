// Round-trip check of the Gnani speech setup: Timbre speaks a sentence as 16 kHz WAV, Prisma
// transcribes it back. Uses a few speech credits. Run: node backend/scripts/speechSmokeTest.js
import { speak, transcribe } from '../src/services/gnaniSpeech.js';

const sentence = process.argv[2] || 'Mera notice period do mahine ka hai, aur expected CTC nau lakh hai.';

console.log(`Speaking: "${sentence}"`);
const spoken = await speak(sentence, { container: 'wav', sampleRate: 16000 });
console.log(`Timbre: ${spoken.audio.length} bytes ${spoken.contentType} in ${spoken.ms} ms`);

const heard = await transcribe(spoken.audio, { format: 'wav' });
console.log(`Prisma: "${heard.transcript}" in ${heard.ms} ms`);
