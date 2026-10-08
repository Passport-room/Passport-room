import { describe, expect, it } from 'vitest';
import { remainingSkipSeconds } from '../client/download-video.js';
describe('Download video skip timing', () => {
  it('prevents skipping before five seconds', () => {
    expect(remainingSkipSeconds(1000, 1000)).toBe(5);
    expect(remainingSkipSeconds(1000, 5999)).toBe(1);
  });
  it('allows skipping at five seconds and later', () => {
    expect(remainingSkipSeconds(1000, 6000)).toBe(0);
    expect(remainingSkipSeconds(1000, 30000)).toBe(0);
  });
});
