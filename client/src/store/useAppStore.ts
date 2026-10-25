import { create } from 'zustand';
import { User } from '../types';
import { api } from '../services/api';

interface AppState {
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;

  currentUser: User | null;
  sessionChecked: boolean;
  setCurrentUser: (user: User | null) => void;
  initSession: () => Promise<void>;
  logout: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: (localStorage.getItem('hr_theme') as 'dark' | 'light') || 'dark',
  setTheme: (theme) => {
    localStorage.setItem('hr_theme', theme);
    document.documentElement.setAttribute('data-pd-theme', theme);
    set({ theme });
  },

  currentUser: null,
  sessionChecked: false,
  setCurrentUser: (user) => set({ currentUser: user }),

  initSession: async () => {
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

  logout: () => {
    api.setAuthToken(null);
    set({ currentUser: null });
  }
}));

if (typeof window !== 'undefined') {
  window.addEventListener('hr:unauthorized', () => {
    api.setAuthToken(null);
    useAppStore.setState({ currentUser: null });
  });
}
