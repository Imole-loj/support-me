'use client';

import { useState } from 'react';
import { notify } from '@/lib/notify';
import { useAuth } from '@/context/AuthContext';
import { API_URL } from '@/lib/api';
import { fetchWithRetry, isNetworkError } from '@/lib/network';
import { useAuthFetch } from '@/lib/useAuthFetch';
import { isSessionExpiredError } from '@/lib/authFetch';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * Settings → "Your data": GDPR-style export (JSON download) and deletion
 * (typed confirmation in a ConfirmDialog → anonymize) backed by /api/account. Shown even when
 * the signed-in user has no creator profile yet, so the actions are always
 * reachable from /settings.
 */
export function AccountDataSection() {
  const { token, logout } = useAuth();
  const authFetch = useAuthFetch();
  const [exporting, setExporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleExport = async () => {
    if (!token) return;
    setExporting(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/account/export`,
        {},
        // Keep the connection-failure handling (toast + retry); authFetch
        // adds the 401 treatment on top (#246).
        { fetchImpl: fetchWithRetry }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Export failed');
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename =
        filenameMatch?.[1] || `supportme-export-${new Date().toISOString().slice(0, 10)}.json`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      notify.success('Export downloaded', {
        description: 'A JSON file with your profile, donations, subscriptions and withdrawals.',
      });
    } catch (err) {
      // An expired token already signed the user out with its own toast (#246).
      if (isNetworkError(err) || isSessionExpiredError(err)) return;
      notify.error('Could not export your data', err);
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (!token || confirmText !== 'DELETE') return;
    setDeleting(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/account/delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: confirmText }),
        },
        // Keep the connection-failure handling (toast + retry); authFetch
        // adds the 401 treatment on top (#246).
        { fetchImpl: fetchWithRetry }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || 'Deletion failed');
      }

      notify.success('Your account data has been deleted', {
        description:
          'Personal details were anonymized. On-chain records (transaction hashes, addresses) are preserved.',
      });
      setConfirming(false);
      setConfirmText('');
      logout();
    } catch (err) {
      // An expired token already signed the user out with its own toast (#246).
      if (isNetworkError(err) || isSessionExpiredError(err)) return;
      notify.error('Could not delete your account', err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="space-y-4 border-t-2 border-ink pt-6">
      <h2 className="text-lg font-extrabold text-ink">Your data</h2>
      <p className="text-sm text-muted font-medium">
        Export everything SupportMe stores about you, or delete your account. Deletion anonymizes
        your personal details but keeps on-chain records (transaction hashes and addresses) intact.
      </p>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || deleting}
          className="btn-brutal btn-brutal-white"
        >
          {exporting ? 'Preparing export…' : 'Export my data (JSON)'}
        </button>

        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={exporting || deleting}
          className="btn-brutal btn-brutal-danger"
        >
          Delete account…
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Delete your account?"
        description="This permanently anonymizes your profile, email, donation messages and active subscriptions. It cannot be undone."
        confirmLabel="Permanently delete my data"
        confirmDisabled={confirmText !== 'DELETE'}
        busy={deleting}
        busyLabel="Deleting…"
        onConfirm={handleDelete}
        onCancel={() => {
          setConfirming(false);
          setConfirmText('');
        }}
      >
        <div>
          <label htmlFor="delete-confirm" className="block text-sm font-bold text-ink mb-2">
            Type <span className="font-mono">DELETE</span> to confirm
          </label>
          <input
            id="delete-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
            placeholder="DELETE"
            className="input-brutal"
          />
        </div>
      </ConfirmDialog>
    </section>
  );
}
