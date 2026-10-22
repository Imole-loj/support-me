import { describe, expect, it } from 'vitest';
import { isHttpUrl, normalizeSocialValue, SOCIAL_PLATFORMS } from '@/lib/socials';

describe('social URL validation', () => {
  it.each(['https://example.com', 'http://example.com/path'])('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });
  it.each(['javascript:alert(1)', 'data:text/html,hello', 'my site', 'https://'])('rejects %s', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });
  it('adds https to a bare Website domain', () => {
    const website = SOCIAL_PLATFORMS.find(({ key }) => key === 'website')!;
    expect(normalizeSocialValue(website, 'example.com')).toBe('https://example.com');
  });
});
