'use client';

import { useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { authFetch, type AuthFetchOptions } from '@/lib/authFetch';

type AuthFetchCaller = (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: AuthFetchOptions
) => Promise<Response>;

/**
 * `authFetch` pre-bound to the current session (#246): attaches the signed-in
 * token and, on a 401, runs `AuthContext`'s `logout` and shows the
 * "Your session expired" toast before throwing a `SessionExpiredError`.
 *
 * Prefer this over raw `fetch` for any request that carries an
 * `Authorization` header, so an expired or revoked token always ends in one
 * clean signed-out state instead of a shell full of failing requests.
 */
export function useAuthFetch(): AuthFetchCaller {
  const { token, logout } = useAuth();
  return useCallback<AuthFetchCaller>(
    (input, init = {}, options = {}) =>
      authFetch(input, init, { token, onUnauthorized: logout, ...options }),
    [token, logout]
  );
}
