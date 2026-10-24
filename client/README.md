# Gnani.ai — Web dashboard (React + Vite)

- `npm run dev` → http://localhost:5173 (calls the backend on :3000 through the Vite proxy)
- `npm run build` → builds into `dist/`, which the backend serves at http://localhost:3000

Main files:
- `src/services/api.ts` — every call to the backend
- `src/store/useAppStore.ts` — login, tenant and UI state
- `src/pages/` — one file per screen (Dashboard, Campaigns, Leads, Agents, Live Monitor, …)

Note: this React app is a partly wired starter. A few screens (Integrations, some charts) still show
static placeholders. They are marked in the code where real endpoints should be connected.
