import {
  NewTwitterIcon,
  Github01Icon,
  InstagramIcon,
  YoutubeIcon,
  TiktokIcon,
  Linkedin01Icon,
  TelegramIcon,
  Globe02Icon,
} from '@hugeicons/core-free-icons';

// The social platforms a creator can link. `key` is what we persist in the
// Creator.socialLinks JSON blob; `icon` renders the brand glyph on the public
// profile. `prefix` lets the settings form accept a bare handle and store a
// full URL, while still accepting a pasted URL as-is.
export interface SocialPlatform {
  key: string;
  label: string;
  icon: typeof Globe02Icon;
  placeholder: string;
  prefix?: string;
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  { key: 'twitter', label: 'X / Twitter', icon: NewTwitterIcon, placeholder: 'username', prefix: 'https://x.com/' },
  { key: 'instagram', label: 'Instagram', icon: InstagramIcon, placeholder: 'username', prefix: 'https://instagram.com/' },
  { key: 'youtube', label: 'YouTube', icon: YoutubeIcon, placeholder: '@channel', prefix: 'https://youtube.com/' },
  { key: 'tiktok', label: 'TikTok', icon: TiktokIcon, placeholder: '@username', prefix: 'https://tiktok.com/' },
  { key: 'github', label: 'GitHub', icon: Github01Icon, placeholder: 'username', prefix: 'https://github.com/' },
  { key: 'linkedin', label: 'LinkedIn', icon: Linkedin01Icon, placeholder: 'in/username', prefix: 'https://linkedin.com/' },
  { key: 'telegram', label: 'Telegram', icon: TelegramIcon, placeholder: 'username', prefix: 'https://t.me/' },
  { key: 'website', label: 'Website', icon: Globe02Icon, placeholder: 'https://example.com' },
];

/**
 * Turn a user's raw input into a full URL for storage. A pasted http(s) URL is
 * kept verbatim; a bare handle gets the platform prefix (with any leading @
 * stripped, since prefixes already end in /). Empty input returns ''.
 */
export function normalizeSocialValue(platform: SocialPlatform, raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (platform.key === 'website') return `https://${value}`;
  if (!platform.prefix) return value;
  return platform.prefix + value.replace(/^@/, '');
}

/** Returns true only for absolute HTTP(S) URLs with a valid host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Look up a platform definition by its storage key. */
export function getPlatform(key: string): SocialPlatform | undefined {
  return SOCIAL_PLATFORMS.find((p) => p.key === key);
}
