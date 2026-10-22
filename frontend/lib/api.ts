export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Convenience wrapper around fetch that prepends API_URL for relative paths
 * and includes credentials (httpOnly session cookies) for cross-origin API requests (#366).
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' && input.startsWith('/') ? `${API_URL}${input}` : input;
  return fetch(url, {
    ...init,
    credentials: init.credentials ?? 'include',
  });
}
