'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { API_URL } from '@/lib/api';
import { useAuthFetch } from '@/lib/useAuthFetch';
import type { ProfileTheme } from '@/lib/theme';

interface Creator {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  walletAddress: string;
  avatarUrl: string | null;
  donationGoal: number | null;
  acceptsXlm: boolean;
  socialLinks: Record<string, string> | null;
  acceptsUsdc: boolean;
  acceptsUsdt: boolean;
  presetAmounts?: number[] | null;
  bio?: string | null;
  theme?: ProfileTheme | null;
}

interface CreatorContextType {
  creator: Creator | null;
  loading: boolean;
  invalidate: () => void;
}

const CreatorContext = createContext<CreatorContextType | undefined>(undefined);

export function CreatorProvider({ children }: { children: ReactNode }) {
  const { user, token } = useAuth();
  const authFetch = useAuthFetch();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    let active = true;
    const fetchCreator = async () => {
      if (!user || !token) {
        // Signed out (including signed out by a 401, #246): drop any stale
        // profile so no page keeps rendering signed-in data for a session
        // that no longer exists.
        if (active) {
          setCreator(null);
          setLoading(false);
        }
        return;
      }
      try {
        // authFetch signs the user out and throws SessionExpiredError on a
        // 401 (#246), so the catch below never masks an expired token.
        const res = await authFetch(`${API_URL}/api/creators/me`);
        if (res.status === 404) {
          if (active) setCreator(null);
          return;
        }
        if (!res.ok) throw new Error('Failed to load your profile');
        if (active) setCreator(await res.json());
      } catch {
        // Keep previous creator data on network errors
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchCreator();
    return () => { active = false; };
  }, [user, token, fetchKey, authFetch]);

  const invalidate = useCallback(() => setFetchKey((k) => k + 1), []);

  return (
    <CreatorContext.Provider value={{ creator, loading, invalidate }}>
      {children}
    </CreatorContext.Provider>
  );
}

export function useCreator() {
  const context = useContext(CreatorContext);
  if (!context) {
    throw new Error('useCreator must be used within CreatorProvider');
  }
  return context;
}
