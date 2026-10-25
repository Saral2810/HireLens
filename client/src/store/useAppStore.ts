import { create } from 'zustand';
import { User } from '../types';
import { api } from '../services/api';
import { consumeInviteFragment } from '../lib/inviteSession';

export type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('hr_theme');
    if (saved === 'dark') return 'dark';
  } catch { /* storage blocked */ }
  return 'light';
}

interface AppState {
  /** Light unless the user switched to dark. */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  currentUser: User | null;
  sessionChecked: boolean;
  /** Message when a candidate opened an invite link that no longer works. */
  inviteError: string | null;
  setCurrentUser: (user: User | null) => void;
  initSession: () => Promise<void>;
  refreshUser: () => Promise<void>;
  logout: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    try { localStorage.setItem('hr_theme', theme); } catch { /* private mode: not remembered */ }
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  currentUser: null,
  sessionChecked: false,
  inviteError: null,
  setCurrentUser: (user) => set({ currentUser: user }),

  initSession: async () => {
    // A candidate arriving from an invite link: the link's session replaces any old one.
    const invite = consumeInviteFragment();
    if (invite.kind === 'session') api.setAuthToken(invite.accessToken);
    if (invite.kind === 'error') {
      api.setAuthToken(null);
      set({ currentUser: null, sessionChecked: true, inviteError: invite.message });
      return;
    }

    if (!api.hasToken()) {
      set({ currentUser: null, sessionChecked: true });
      return;
    }
    try {
      const user = await api.getMe();
      set({ currentUser: user, sessionChecked: true });
    } catch {
      api.setAuthToken(null);
      set({ currentUser: null, sessionChecked: true });
    }
  },

  refreshUser: async () => {
    const user = await api.getMe();
    set({ currentUser: user });
  },

  logout: () => {
    api.setAuthToken(null);
    set({ currentUser: null, inviteError: null });
  }
}));

if (typeof window !== 'undefined') {
  window.addEventListener('hr:unauthorized', () => {
    api.setAuthToken(null);
    useAppStore.setState({ currentUser: null });
  });
}
