'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { API_URL } from '@/lib/api';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';

export default function CreateUsernamePage() {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { token, user } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username) {
      setError('Username is required');
      return;
    }

    if (username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      setError('Username can only contain letters, numbers, underscores, and hyphens');
      return;
    }

    if (username.length > 30) {
      setError('Username must be 30 characters or fewer');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/creators/${username}/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            walletAddress: user?.walletAddress ?? null,
            displayName: displayName || username,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create username');
      }

      router.push('/app');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="card-brutal p-8">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-extrabold text-ink tracking-tight">Create Your Profile</h1>
              <p className="text-muted text-sm mt-2 font-medium">Choose a unique username</p>
            </div>

            {error && (
              <div role="alert" className="card-brutal bg-brand-pink p-4 mb-6 text-sm text-ink font-bold">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="username" className="block text-sm font-bold text-ink mb-1">
                  Username
                </label>
                <div className="flex items-center">
                  <span className="text-muted px-4 py-3 bg-accent-bg border-2 border-r-0 border-ink rounded-l-xl text-sm font-bold">
                    {SITE_URL.replace(/\/$/, '')}/
                  </span>
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                    placeholder="yourname"
                    maxLength={30}
                    aria-invalid={error ? true : undefined}
                    aria-describedby="username-hint"
                    className="input-brutal flex-1 rounded-l-none border-l-0"
                  />
                </div>
                <p id="username-hint" className="text-xs text-muted mt-2 font-medium">
                  Letters, numbers, underscores, and hyphens only (3–30 characters)
                </p>
              </div>

              <div>
                <label htmlFor="display-name" className="block text-sm font-bold text-ink mb-1">
                  Display Name (Optional)
                </label>
                <input
                  id="display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your Name"
                  className="input-brutal"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-brutal btn-brutal-primary w-full mt-6"
              >
                {loading ? 'Creating profile...' : 'Create Profile'}
              </button>
            </form>

            <p className="text-center text-muted text-xs mt-6 font-medium">
              Pick carefully — your username becomes your public profile URL
            </p>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
