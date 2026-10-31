import React from 'react';
import { CallLanguage } from '../../types';

export const CALL_LANGUAGE_LABELS: Record<CallLanguage, string> = {
  mixed: 'English + Hindi',
  en: 'English',
  hi: 'Hindi'
};
export const ALL_CALL_LANGUAGES: CallLanguage[] = ['mixed', 'en', 'hi'];

/** Which languages candidates of a campaign may pick for their call (at least one). */
export const CallLanguagesField: React.FC<{ value: CallLanguage[]; onChange: (v: CallLanguage[]) => void }> = ({ value, onChange }) => {
  const toggle = (lang: CallLanguage) => {
    const next = value.includes(lang) ? value.filter(l => l !== lang) : [...value, lang];
    if (next.length) onChange(ALL_CALL_LANGUAGES.filter(l => next.includes(l)));
  };
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
      <legend className="field-label">Call languages</legend>
      <div className="row-wrap" style={{ gap: 14 }}>
        {ALL_CALL_LANGUAGES.map(lang => (
          <label key={lang} className="row small" style={{ gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(lang)} onChange={() => toggle(lang)} disabled={value.length === 1 && value.includes(lang)} />
            {CALL_LANGUAGE_LABELS[lang]}
          </label>
        ))}
      </div>
      <span className="field-hint">Candidates choose one of these before their call. English + Hindi understands both, and mixed answers too.</span>
    </fieldset>
  );
};
