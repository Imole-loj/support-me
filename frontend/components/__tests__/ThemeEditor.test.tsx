import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeEditor } from '@/components/ThemeEditor';
import { notify } from '@/lib/notify';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/authFetch';
import type { ProfileTheme } from '@/lib/theme';

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn() },
}));

// ThemeEditor gets its token through the auth session (#246), not a prop.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', logout: vi.fn() }),
}));

const savedTheme: ProfileTheme = {
  backgroundColor: '#fff4e6',
  accentColor: '#b42318',
  font: 'serif',
  layout: 'compact',
};

const renderEditor = (initialTheme: ProfileTheme | null = null) =>
  render(<ThemeEditor username="alice" displayName="Alice" initialTheme={initialTheme} />);

const patchBody = () => {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
  return JSON.parse(call![1]!.body as string);
};

describe('ThemeEditor', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('starts from the default design when the creator has no saved theme', () => {
    renderEditor();

    expect(screen.getByLabelText('Background color')).toHaveValue('#fdfcf7');
    expect(screen.getByLabelText('Accent color')).toHaveValue('#7c3aed');
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
  });

  it('previews changes live, before anything is saved', () => {
    renderEditor();
    const preview = screen.getByTestId('theme-preview');

    fireEvent.change(screen.getByLabelText('Background color'), { target: { value: '#fff4e6' } });
    fireEvent.change(screen.getByLabelText('Accent color'), { target: { value: '#b42318' } });
    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'compact' } });

    expect(preview.style.getPropertyValue('--background')).toBe('#fff4e6');
    expect(preview.style.getPropertyValue('--primary')).toBe('#b42318');
    expect(preview).toHaveClass('py-4');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves the draft theme to the creator profile', async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText('Accent color'), { target: { value: '#b42318' } });
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'serif' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Theme saved.'));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/api/creators/alice/theme');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(patchBody()).toEqual({
      theme: { backgroundColor: '#fdfcf7', accentColor: '#b42318', font: 'serif', layout: 'default' },
    });
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('resets to defaults and saves that as null, restoring the default design', async () => {
    renderEditor(savedTheme);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(screen.getByLabelText('Background color')).toHaveValue('#fdfcf7');
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(patchBody()).toEqual({ theme: null });
  });

  it('blocks saving and explains why when a color fails WCAG AA contrast', () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText('Accent color'), { target: { value: '#ffd84d' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/Button text on this accent has .*WCAG AA needs 4.5:1/);
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('reports a failed save and lets the creator retry', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ error: 'Nope' }) } as Response);
    renderEditor();

    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'centered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));

    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not save theme', expect.any(Error)));
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeEnabled();
  });

  it('shows the session-expired toast instead of a generic save error on a 401 (#246)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    renderEditor();

    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'centered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(SESSION_EXPIRED_MESSAGE, undefined, expect.anything())
    );
    // The misleading "Could not save theme" message must not appear — the
    // session-expired toast already explained (and handled) the failure.
    expect(notify.error).not.toHaveBeenCalledWith('Could not save theme', expect.anything());
  });
});
