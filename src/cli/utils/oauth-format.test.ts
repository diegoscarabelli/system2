import { describe, expect, it } from 'vitest';
import { formatOAuthAuthMessage } from './oauth-format.js';

describe('formatOAuthAuthMessage', () => {
  it('includes the URL', () => {
    const msg = formatOAuthAuthMessage('https://github.com/login/device');
    expect(msg).toContain('https://github.com/login/device');
  });

  it('omits the instructions line when not provided (callback flow)', () => {
    const msg = formatOAuthAuthMessage('http://localhost:55432/callback');
    expect(msg).toContain('http://localhost:55432/callback');
    expect(msg.split('\n')).toHaveLength(2); // header + url, no third line
  });

  it('appends the instructions line when provided (device flow user code)', () => {
    // pi-ai's GitHub Copilot OAuth surfaces the device-flow user code via
    // onAuth's `instructions` field. Regression guard: don't drop it.
    const msg = formatOAuthAuthMessage('https://github.com/login/device', 'Enter code: ABCD-1234');
    expect(msg).toContain('Enter code: ABCD-1234');
    expect(msg).toContain('https://github.com/login/device');
  });
});
