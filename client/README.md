# HireLens web app (React + Vite)

- `npm run dev` → http://localhost:5173 (calls the backend on :3000 through the Vite proxy)
- `npm run build` → builds into `dist/`, which the backend serves at http://localhost:3000

Main files:
- `src/services/api.ts` — every call to the backend
- `src/store/useAppStore.ts` — sign-in and UI state
- `src/lib/` — browser helpers: Google sign-in, invite sessions, WAV recording, CSV, schedules
- `src/pages/public/` — landing page, sign-in, invite links (`/join`) and the live demo
- `src/pages/hr/` — HR dashboard, campaigns, new campaign, call summary and team
- `src/pages/candidate/` — the candidate's resume upload, consent and screening call
