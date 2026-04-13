import { describe, expect, it } from 'vitest';
import { loadDriver } from './driver-loader.js';

describe('loadDriver()', () => {
  it('throws with install instructions containing the package name', () => {
    expect(() => loadDriver('nonexistent-package-xyz')).toThrow(
      'Database driver "nonexistent-package-xyz" is not installed.'
    );
  });

  it('includes the ~/.system2 prefix path in the error message', () => {
    expect(() => loadDriver('nonexistent-package-xyz')).toThrow(/.system2/);
  });

  it('includes the npm install command in the error message', () => {
    expect(() => loadDriver('nonexistent-package-xyz')).toThrow(
      /npm install --prefix .+\.system2 nonexistent-package-xyz/
    );
  });
});
