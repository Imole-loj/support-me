'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { connectWallet, disconnectWallet, signMessage } from '@/lib/wallet';
import { API_URL } from '@/lib/api';
import { isTokenExpired } from '@/lib/authFetch';

interface User {
  id: number;
  walletAddress: string | null;
  email?: string | null;
}

interface LoginResult {
  user: User;
  token: string;
  hasProfile: boolean;
  username?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  loginWithWallet: () => Promise<LoginResult>;
  getTwitterRedirectUrl: () => Promise<string>;
  completeTwitterLogin: (code: string, state: string) => Promise<LoginResult>;
  requestMagicLink: (email: string) => Promise<void>;
  verifyMagicLink: (token: string) => Promise<LoginResult>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // Starts true and flips to false at the end of the mount effect below, so
  // it also doubles as the "has the client-only mount effect run yet" flag
  // (needed to avoid an SSR/hydration mismatch) without a separate `mounted`
  // state — the two were never observably different.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // One-time sync FROM an external system (localStorage) on mount, which is
    // exactly what effects are for — not a derived-state anti-pattern. This
    // can't move to a `useState` lazy initializer because `localStorage`
    // isn't available during SSR; reading it outside an effect would cause a
    // hydration mismatch.
    const savedToken = localStorage.getItem('authToken');
    const savedUser = localStorage.getItem('authUser');
    if (savedToken && savedUser) {
      if (isTokenExpired(savedToken)) {
        // The stored JWT already expired (#246): drop it instead of restoring
        // a session whose very first API call would 401, so a reload lands on
        // the signed-out state rather than a page of failing requests.
        localStorage.removeItem('authToken');
        localStorage.removeItem('authUser');
      } else {
        try {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring session state from localStorage on mount, see comment above
          setToken(savedToken);
          setUser(JSON.parse(savedUser));
        } catch {
          // Clear invalid stored data
          localStorage.removeItem('authToken');
          localStorage.removeItem('authUser');
        }
      }
    }
    setLoading(false);
  }, []);

  // Every sign-in method (wallet, Twitter, magic link) ends the same way:
  // the backend returns the same LoginResult shape, so persisting the
  // session is identical regardless of how the user proved their identity.
  const persistSession = (data: LoginResult): LoginResult => {
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('authToken', data.token);
    localStorage.setItem('authUser', JSON.stringify(data.user));
    return data;
  };

  const loginWithWallet = async (): Promise<LoginResult> => {
    const address = await connectWallet();
    if (!address) {
      // connectWallet() resolves null when the user closes the wallet picker
      // without connecting (see lib/wallet.ts) -- categorized as a user
      // cancellation, not a missing-wallet error.
      throw new Error('The wallet connection was cancelled.');
    }

    const challengeRes = await fetch(`${API_URL}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address }),
    });
    if (!challengeRes.ok) {
      const error = await challengeRes.json();
      throw new Error(error.error || 'Failed to start sign-in challenge');
    }
    const { message } = await challengeRes.json();

    const signedMessage = await signMessage(message, address);

    const verifyRes = await fetch(`${API_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address, signedMessage }),
    });
    if (!verifyRes.ok) {
      const error = await verifyRes.json();
      throw new Error(error.error || 'Sign-in verification failed');
    }
    const data: LoginResult = await verifyRes.json();

    return persistSession(data);
  };

  const getTwitterRedirectUrl = async (): Promise<string> => {
    const res = await fetch(`${API_URL}/api/auth/twitter`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to start Twitter sign-in');
    }
    const { redirectUrl } = await res.json();
    return redirectUrl;
  };

  const completeTwitterLogin = async (code: string, state: string): Promise<LoginResult> => {
    const params = new URLSearchParams({ code, state });
    const res = await fetch(`${API_URL}/api/auth/twitter/callback?${params.toString()}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Twitter sign-in failed');
    }
    const data: LoginResult = await res.json();

    return persistSession(data);
  };

  const requestMagicLink = async (email: string): Promise<void> => {
    const res = await fetch(`${API_URL}/api/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to send magic link');
    }
  };

  const verifyMagicLink = async (token: string): Promise<LoginResult> => {
    const res = await fetch(`${API_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'This magic link is invalid or has expired');
    }
    const data: LoginResult = await res.json();

    return persistSession(data);
  };

  // Memoized so consumers built on it (useAuthFetch) keep a stable identity
  // across renders — a fresh closure per render would re-run their effects.
  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    disconnectWallet().catch(() => {});
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        loginWithWallet,
        getTwitterRedirectUrl,
        completeTwitterLogin,
        requestMagicLink,
        verifyMagicLink,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
