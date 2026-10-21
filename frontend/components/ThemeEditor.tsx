'use client';

import { useState } from 'react';
import { notify } from '@/lib/notify';
import { API_URL } from '@/lib/api';
import { useAuthFetch } from '@/lib/useAuthFetch';
import { isSessionExpiredError } from '@/lib/authFetch';
import {
  DEFAULT_THEME,
  THEME_FONTS,
  THEME_LAYOUTS,
  isDefaultTheme,
  sameTheme,
  themeContrastIssues,
  themeStyle,
  type ProfileTheme,
  type ThemeFont,
  type ThemeLayout,
} from '@/lib/theme';

interface ThemeEditorProps {
  username: string;
  displayName: string;
  /** The creator's saved theme; null means the default design. */
  initialTheme: ProfileTheme | null;
}

/**
 * Lets a creator restyle their public profile, with a live preview of the
 * draft. Changes only reach the profile when saved, and saving is blocked
 * while the draft fails WCAG AA contrast.
 */
export function ThemeEditor({ username, displayName, initialTheme }: ThemeEditorProps) {
  const authFetch = useAuthFetch();
  const [saved, setSaved] = useState<ProfileTheme>(initialTheme ?? DEFAULT_THEME);
  const [draft, setDraft] = useState<ProfileTheme>(saved);
  const [saving, setSaving] = useState(false);

  const issues = themeContrastIssues(draft);
  const dirty = !sameTheme(draft, saved);
  const layout = THEME_LAYOUTS[draft.layout];

  const update = <K extends keyof ProfileTheme>(key: K, value: ProfileTheme[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_URL}/api/creators/${encodeURIComponent(username)}/theme`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The default look is stored as null, so it keeps following the
        // visitor's light/dark mode instead of pinning the light palette.
        body: JSON.stringify({ theme: isDefaultTheme(draft) ? null : draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save theme');
      }
      setSaved(draft);
      notify.success('Theme saved.');
    } catch (err) {
      // An expired token already signed the user out with its own toast (#246).
      if (isSessionExpiredError(err)) return;
      notify.error('Could not save theme', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 border-t-2 border-ink pt-6">
      <h2 className="text-lg font-extrabold text-ink">Profile theme</h2>
      <p className="text-sm text-muted font-medium">
        Customize how your public page looks. The preview updates as you go; your page only
        changes when you save the theme.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="themeBackground" className="block text-xs font-bold text-ink mb-1.5">
            Background color
          </label>
          <input
            id="themeBackground"
            type="color"
            value={draft.backgroundColor}
            onChange={(e) => update('backgroundColor', e.target.value)}
            className="input-brutal h-11 p-1 cursor-pointer"
          />
        </div>
        <div>
          <label htmlFor="themeAccent" className="block text-xs font-bold text-ink mb-1.5">
            Accent color
          </label>
          <input
            id="themeAccent"
            type="color"
            value={draft.accentColor}
            onChange={(e) => update('accentColor', e.target.value)}
            className="input-brutal h-11 p-1 cursor-pointer"
          />
        </div>
        <div>
          <label htmlFor="themeFont" className="block text-xs font-bold text-ink mb-1.5">
            Font
          </label>
          <select
            id="themeFont"
            value={draft.font}
            onChange={(e) => update('font', e.target.value as ThemeFont)}
            className="input-brutal"
          >
            {Object.entries(THEME_FONTS).map(([key, font]) => (
              <option key={key} value={key}>
                {font.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="themeLayout" className="block text-xs font-bold text-ink mb-1.5">
            Layout
          </label>
          <select
            id="themeLayout"
            value={draft.layout}
            onChange={(e) => update('layout', e.target.value as ThemeLayout)}
            className="input-brutal"
          >
            {Object.entries(THEME_LAYOUTS).map(([key, option]) => (
              <option key={key} value={key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        role="region"
        aria-label="Theme preview"
        data-testid="theme-preview"
        style={themeStyle(draft)}
        className={`bg-background border-2 border-ink rounded-xl px-4 min-h-64 ${layout.page}`}
      >
        <div className={`max-w-xs mx-auto ${layout.column}`}>
          <div className="card-brutal p-6 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full border-4 border-ink bg-accent-bg flex items-center justify-center">
              <span className="text-xl font-extrabold text-muted">{displayName.charAt(0).toUpperCase()}</span>
            </div>
            <h3 className="text-xl font-extrabold text-ink">{displayName}</h3>
            <p className="text-muted font-bold text-sm">@{username}</p>
          </div>
          <div className="card-brutal p-4">
            <span className="btn-brutal btn-brutal-primary w-full">Support</span>
          </div>
        </div>
      </div>

      {issues.length > 0 && (
        <ul role="alert" className="card-brutal bg-brand-pink p-3 text-sm font-bold text-ink space-y-1">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty || issues.length > 0}
          className="btn-brutal btn-brutal-primary"
        >
          {saving ? 'Saving…' : 'Save theme'}
        </button>
        <button
          type="button"
          onClick={() => setDraft(DEFAULT_THEME)}
          disabled={isDefaultTheme(draft)}
          className="btn-brutal btn-brutal-white"
        >
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
