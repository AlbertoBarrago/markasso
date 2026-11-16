import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/i18n', () => ({ t: (key: string) => key }));
const { whatsNewAction, WHATS_NEW_ID } = await import('../src/ui/whats_new');

describe('whatsNewAction', () => {
  it('marks the highlights seen on a first visit, so the welcome card shows', () => {
    expect(whatsNewAction(null, false)).toBe('markSeen');
  });

  it('shows the highlights to someone with a drawing from before the notice existed', () => {
    expect(whatsNewAction(null, true)).toBe('show');
  });

  it('shows newer highlights to a returning visitor', () => {
    expect(whatsNewAction('1.0', false)).toBe('show');
    expect(whatsNewAction('1.0', true)).toBe('show');
  });

  it('skips highlights already seen', () => {
    expect(whatsNewAction(WHATS_NEW_ID, false)).toBe('skip');
    expect(whatsNewAction(WHATS_NEW_ID, true)).toBe('skip');
  });
});
