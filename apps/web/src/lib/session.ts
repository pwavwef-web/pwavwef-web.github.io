import { create } from 'zustand';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import type { StudioSettings } from '@az-studio/shared';
import { api, ApiError, type BootstrapData } from './api';
import { auth } from './firebase';

export type SessionStatus = 'loading' | 'signed-out' | 'checking' | 'ready' | 'denied' | 'error';

interface SessionState {
  status: SessionStatus;
  user: User | null;
  boot: BootstrapData | null;
  error: string | null;
  refresh: () => Promise<void>;
  setSettings: (s: StudioSettings) => void;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  boot: null,
  error: null,
  refresh: async () => {
    const user = get().user;
    if (!user) return;
    try {
      const boot = await api<BootstrapData, 'bootstrap'>('bootstrap', {});
      set({ boot, status: 'ready', error: null });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'permission-denied') set({ status: 'denied', error: e.message, boot: null });
      else set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
  setSettings: (settings) => {
    const boot = get().boot;
    if (boot) set({ boot: { ...boot, settings } });
  },
  signOut: async () => {
    await signOut(auth);
    set({ status: 'signed-out', user: null, boot: null, error: null });
  },
}));

let started = false;
/** Wires Firebase Auth to the session store; the server decides whether the user is the owner. */
export function startSession() {
  if (started) return;
  started = true;
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      useSession.setState({ status: 'signed-out', user: null, boot: null, error: null });
      return;
    }
    useSession.setState({ status: 'checking', user, error: null });
    await useSession.getState().refresh();
  });
}

export const useBoot = () => useSession((s) => s.boot);
export const useCaps = () => useSession((s) => s.boot?.capabilities ?? null);
export const useUid = () => useSession((s) => s.user?.uid ?? '');
