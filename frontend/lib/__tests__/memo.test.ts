import { describe, expect, it } from 'vitest';
import { memoByteLength } from '@/lib/memo';

describe('memoByteLength', () => {
  it('counts ASCII bytes', () => expect(memoByteLength('hello')).toBe(5));
  it('counts emoji as their UTF-8 byte length', () => expect(memoByteLength('😀')).toBe(4));
  it('counts multi-byte scripts as UTF-8 bytes', () => {
    expect(memoByteLength('你好')).toBe(6);
    expect(memoByteLength('ọ̀rọ̀')).toBe(new TextEncoder().encode('ọ̀rọ̀').length);
  });
});
