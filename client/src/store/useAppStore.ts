import { create } from 'zustand';
import { Campaign, NotificationItem, PageType, Tenant, User } from '../types';
import { api } from '../services/api';

interface AppState {
  // Navigation & Theme
  activePage: PageType;
  theme: 'dark' | 'light';
  setActivePage: (page: PageType) => void;
  setTheme: (theme: 'dark' | 'light') => void;

  // Auth & Tenants
  currentUser: User | null;
  activeTenant: string;
  allowedTenants: string[];
  tenantsList: Tenant[];
  isSuperAdmin: boolean;
  currentTenantRole: 'admin' | 'member' | 'owner';
  isAuthModalOpen: boolean;
  
  // Modals & Panels
  selectedLeadId: string | null;
  leadModalOpen: boolean;
  switchProviderCampaign: Campaign | null;
  createCampaignOpen: boolean;
  notifications: NotificationItem[];

  // Actions
  setActiveTenant: (tenantId: string) => void;
  setCurrentUser: (user: User | null) => void;
  setTenantsList: (tenants: Tenant[]) => void;
  setAuthModalOpen: (open: boolean) => void;
  setSelectedLeadId: (leadId: string | null) => void;
  setSwitchProviderCampaign: (campaign: Campaign | null) => void;
  setCreateCampaignOpen: (open: boolean) => void;
  addNotification: (notification: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void;
  clearNotifications: () => void;
  initSession: () => Promise<void>;
  logout: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activePage: 'home',
  theme: (localStorage.getItem('lx_theme') as 'dark' | 'light') || 'dark',
  setActivePage: (page) => set({ activePage: page }),
  setTheme: (theme) => {
    localStorage.setItem('lx_theme', theme);
    document.documentElement.setAttribute('data-pd-theme', theme);
    set({ theme });
  },

  currentUser: null,
  activeTenant: localStorage.getItem('lx_active_tenant') || 'demo',
  allowedTenants: [],
  tenantsList: [],
  isSuperAdmin: false,
  currentTenantRole: 'admin',
  isAuthModalOpen: false,

  selectedLeadId: null,
  leadModalOpen: false,
  switchProviderCampaign: null,
  createCampaignOpen: false,
  notifications: [],

  setActiveTenant: (tenantId) => {
    api.setTenant(tenantId);
    set({ activeTenant: tenantId });
  },

  setCurrentUser: (user) => set({ 
    currentUser: user, 
    isSuperAdmin: !!user?.isSuperAdmin 
  }),

  setTenantsList: (tenants) => set({ tenantsList: tenants }),
  setAuthModalOpen: (open) => set({ isAuthModalOpen: open }),
  setSelectedLeadId: (leadId) => set({ selectedLeadId: leadId, leadModalOpen: !!leadId }),
  setSwitchProviderCampaign: (campaign) => set({ switchProviderCampaign: campaign }),
  setCreateCampaignOpen: (open) => set({ createCampaignOpen: open }),

  addNotification: (notif) => {
    const newNotif: NotificationItem = {
      ...notif,
      id: `notif_${Date.now()}`,
      timestamp: 'Just now',
      read: false
    };
    set((state) => ({ notifications: [newNotif, ...state.notifications] }));
  },

  clearNotifications: () => set({ notifications: [] }),

  initSession: async () => {
    try {
      const user = await api.getMe();
      if (user) {
        set({
          currentUser: user,
          isSuperAdmin: !!user.isSuperAdmin,
          allowedTenants: user.allowedTenants || []
        });

        // Ensure active tenant is valid
        const state = get();
        if (!user.isSuperAdmin && user.allowedTenants?.length) {
          if (!user.allowedTenants.includes(state.activeTenant)) {
            const nextTenant = user.allowedTenants[0];
            get().setActiveTenant(nextTenant);
          }
        }
      }
    } catch (err: any) {
      console.warn('Session initialization notice:', err);
      if (err?.message?.includes('Unauthorized') || err?.message?.includes('401') || err?.message?.includes('token')) {
        api.setAuthToken(null);
        set({
          currentUser: null,
          isAuthModalOpen: true
        });
      } else {
        // Backend unreachable — ask the user to sign in instead of faking a session
        set({
          currentUser: null,
          isAuthModalOpen: true
        });
      }
    }

    try {
      const tenants = await api.getTenants();
      set({ tenantsList: tenants });
    } catch (e) {
      console.warn('Could not fetch tenants on init', e);
    }
  },

  logout: () => {
    api.setAuthToken(null);
    localStorage.removeItem('lx_mock_token');
    set({
      currentUser: null,
      isAuthModalOpen: true
    });
  }
}));


if (typeof window !== 'undefined') {
  window.addEventListener('lx:unauthorized', () => {
    api.setAuthToken(null);
    useAppStore.setState({
      currentUser: null,
      isAuthModalOpen: true
    });
  });
}
