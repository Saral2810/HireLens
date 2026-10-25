/**
 * Default HR questions HR can add to a batch with one click. Written the way the agent speaks
 * them (Hinglish, Timbre voice "Poorvi"); HR can edit or remove any of them.
 * answer_type tells the brain what to extract: duration → days, ctc → lakh per annum.
 */
export const DEFAULT_HR_QUESTIONS = Object.freeze([
  { question_text: 'Aapka current notice period kitna hai?', answer_type: 'duration' },
  { question_text: 'Aapki current CTC kitni hai?', answer_type: 'ctc' },
  { question_text: 'Aapki expected CTC kitni hai?', answer_type: 'ctc' },
  { question_text: 'Aap abhi kis city mein based hain, aur kya aap relocate kar sakte hain?', answer_type: 'text' },
  { question_text: 'Agar aapka selection hota hai, toh aap sabse jaldi kab join kar sakte hain?', answer_type: 'text' }
]);
