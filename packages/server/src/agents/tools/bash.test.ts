import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBashTool } from './bash.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-bash-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

describe('bash tool', () => {
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  describe('foreground execution', () => {
    const tool = createBashTool();
    const exec = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: any) =>
      tool.execute('test-call', params as any, signal, onUpdate);

    it('runs a simple command', async () => {
      const result = await exec({ command: 'echo hello' });

      expect(result.content[0].text).toContain('hello');
      expect(result.details).toHaveProperty('exitCode', 0);
    });

    it('captures stderr', async () => {
      const result = await exec({ command: 'echo err >&2' });

      expect(result.content[0].text).toContain('err');
      expect(result.details).toHaveProperty('stderr');
      expect((result.details as any).stderr).toContain('err');
    });

    it('returns error for failed command', async () => {
      const result = await exec({ command: 'exit 1' });

      expect(result.content[0].text).toContain('failed');
      expect((result.details as any).exitCode).not.toBe(0);
    });

    it('uses custom cwd', async () => {
      const dir = trackDir(makeTmpDir());
      const result = await exec({ command: 'pwd', cwd: dir });

      expect(result.content[0].text.trim()).toContain(dir);
    });

    it('returns error when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await exec({ command: 'echo hello' }, controller.signal);

      expect(result.content[0].text).toContain('aborted');
    });

    it('calls onUpdate with streaming output', async () => {
      const onUpdate = vi.fn();
      await exec({ command: 'echo streaming' }, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(lastCall.content[0].text).toContain('streaming');
    });
  });

  describe('background execution', () => {
    it('returns immediately and notifies on completion', async () => {
      const notifyBackground = vi.fn();
      const tool = createBashTool(notifyBackground);

      const result = await tool.execute('bg-call', {
        command: 'echo background',
        run_in_background: true,
      } as any);

      expect(result.content[0].text).toContain('started in background');
      expect((result.details as any).background).toBe(true);

      // Wait for background process to finish
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(notifyBackground).toHaveBeenCalledTimes(1);
      const [content] = notifyBackground.mock.calls[0];
      expect(content).toContain('background');
      expect(content).toContain('completed');
    });

    it('falls through to foreground when no notifyBackground callback', async () => {
      const tool = createBashTool(); // no callback
      const result = await tool.execute('fg-call', {
        command: 'echo fallthrough',
        run_in_background: true,
      } as any);

      // Should execute synchronously and return output directly
      expect(result.content[0].text).toContain('fallthrough');
      expect(result.details).toHaveProperty('exitCode', 0);
    });
  });
});
