import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, tokenStore, ApiError } from '../lib/api';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  status: 'loading' | 'anonymous' | 'authenticated';
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  useEffect(() => {
    let active = true;
    if (!tokenStore.get()) {
      setStatus('anonymous');
      return;
    }
    api
      .me()
      .then((r) => {
        if (!active) return;
        setUser(r.user);
        setStatus('authenticated');
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 503)) {
          if (err.status === 401) tokenStore.clear();
          setStatus('anonymous');
        } else {
          setStatus('anonymous');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    tokenStore.set(r.token);
    setUser(r.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const r = await api.register(email, password);
    tokenStore.set(r.token);
    setUser(r.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(() => ({ user, status, login, register, logout }), [user, status, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
