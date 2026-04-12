import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_BASH_PATTERNS, createBashTool, filterHeartbeats, HEARTBEAT_RE } from './bash.js';

const isWindows = platform() === 'win32';

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

// Derive types from the tool so tests stay in sync with implementation
const _refTool = createBashTool();
type BashResult = Awaited<ReturnType<typeof _refTool.execute>>;
type BashParams = Parameters<typeof _refTool.execute>[1];

describe('bash tool', () => {
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  describe('foreground execution', () => {
    const tool = createBashTool();
    const exec = (
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashResult['details']>
    ) => tool.execute('test-call', params as BashParams, signal, onUpdate);

    it('runs a simple command', async () => {
      const result = await exec({ command: 'echo hello' });

      expect((result.content[0] as { text: string }).text).toContain('hello');
      expect(result.details).toHaveProperty('exitCode', 0);
    });

    it('captures stderr', async () => {
      const result = await exec({ command: 'echo err >&2' });

      expect((result.content[0] as { text: string }).text).toContain('err');
      expect(result.details).toHaveProperty('stderr');
      expect((result.details as { stderr: string }).stderr).toContain('err');
    });

    it('returns error for failed command', async () => {
      const result = await exec({ command: 'exit 1' });

      expect((result.content[0] as { text: string }).text).toContain('failed');
      expect((result.details as { exitCode: number }).exitCode).not.toBe(0);
    });

    it('uses custom cwd', async () => {
      const dir = trackDir(makeTmpDir());
      const marker = `marker-${randomUUID().slice(0, 8)}`;
      const cmd = isWindows ? `New-Item -Name ${marker} -ItemType File` : `touch ${marker}`;
      await exec({ command: cmd, cwd: dir });

      expect(existsSync(join(dir, marker))).toBe(true);
    });

    it('returns error when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await exec({ command: 'echo hello' }, controller.signal);

      expect((result.content[0] as { text: string }).text).toContain('aborted');
    });

    it('calls onUpdate with streaming output', async () => {
      const onUpdate = vi.fn();
      await exec({ command: 'echo streaming' }, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect((lastCall.content[0] as { text: string }).text).toContain('streaming');
    });
  });

  describe('blocked command patterns', () => {
    const tool = createBashTool();
    const exec = (command: string) => tool.execute('test-call', { command } as BashParams);

    it('blocks rm -rf /', async () => {
      const result = await exec('rm -rf /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf /*', async () => {
      const result = await exec('rm -rf /*');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks sudo rm -rf /', async () => {
      const result = await exec('sudo rm -rf /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf ~', async () => {
      const result = await exec('rm -rf ~');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf ~/', async () => {
      const result = await exec('rm -rf ~/');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf $HOME', async () => {
      const result = await exec('rm -rf $HOME');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf "$HOME"', async () => {
      const result = await exec('rm -rf "$HOME"');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -rf with curly-brace HOME variable', async () => {
      // eslint-disable-next-line -- literal ${HOME} is intentional, not a template placeholder
      const cmd = 'rm -rf $' + '{HOME}';
      const result = await exec(cmd);
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm --recursive /', async () => {
      const result = await exec('rm --recursive /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks rm -Rf /', async () => {
      const result = await exec('rm -Rf /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks --no-preserve-root', async () => {
      const result = await exec('rm -rf --no-preserve-root /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks mkfs', async () => {
      const result = await exec('mkfs.ext4 /dev/sda1');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks dd to raw devices', async () => {
      const result = await exec('dd if=/dev/zero of=/dev/sda bs=1M');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks dd to raw devices with quoted path', async () => {
      const result = await exec('dd if=/dev/zero of="/dev/sda" bs=1M');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks dd to raw devices with spaces around =', async () => {
      const result = await exec('dd if=/dev/zero of = /dev/sda bs=1M');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks sqlite3 ~/.system2/app.db', async () => {
      const result = await exec('sqlite3 ~/.system2/app.db "INSERT INTO task VALUES (1)"');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks sqlite3 $HOME/.system2/app.db', async () => {
      const result = await exec('sqlite3 $HOME/.system2/app.db "SELECT * FROM task"');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks sqlite3 with absolute path to .system2/app.db', async () => {
      const result = await exec('sqlite3 /home/user/.system2/app.db ".tables"');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('blocks sqlite3 with backslash path separators', async () => {
      const result = await exec('sqlite3 C:\\Users\\me\\.system2\\app.db ".tables"');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('allows rm -rf on specific directories', async () => {
      const dir = trackDir(makeTmpDir());
      const result = await exec(`rm -rf ${dir}`);
      expect((result.content[0] as { text: string }).text).not.toContain('blocked');
    });

    it('allows non-recursive rm', async () => {
      const result = await exec('rm /tmp/some-file.txt');
      // Should not be blocked (not recursive), will fail because file doesn't exist
      expect((result.content[0] as { text: string }).text).not.toContain('blocked');
    });

    it('blocks dangerous command after semicolon', async () => {
      const result = await exec('echo hello; rm -rf /');
      expect((result.content[0] as { text: string }).text).toContain('blocked');
    });

    it('exports BLOCKED_BASH_PATTERNS for inspection', () => {
      expect(BLOCKED_BASH_PATTERNS.length).toBeGreaterThan(0);
      for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(reason).toBeTruthy();
      }
    });
  });

  describe('heartbeat protocol', () => {
    const tool = createBashTool();
    const exec = (
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashResult['details']>
    ) => tool.execute('test-call', params as BashParams, signal, onUpdate);

    it('strips heartbeat sentinel lines from stdout', async () => {
      const cmd = 'echo "line1"; echo "::system2:: progress 1"; echo "line2"';
      const result = await exec({ command: cmd, inactivity_timeout_seconds: 30 });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('line1');
      expect(text).toContain('line2');
      expect(text).not.toContain('::system2::');
      expect(text).not.toContain('progress 1');
    });

    it('emits heartbeat onUpdate with heartbeat detail', async () => {
      const onUpdate = vi.fn();
      const cmd = 'echo "::system2:: step 1 of 3"';
      await exec({ command: cmd, inactivity_timeout_seconds: 30 }, undefined, onUpdate);

      const heartbeatCalls = onUpdate.mock.calls.filter((args: unknown[]) => {
        const update = args[0] as { details?: { heartbeat?: boolean } };
        return update.details?.heartbeat === true;
      });
      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
      const update = heartbeatCalls[0][0] as {
        details: { heartbeat: boolean; heartbeatMessage: string };
      };
      expect(update.details.heartbeatMessage).toBe('step 1 of 3');
    });

    it('preserves non-heartbeat output alongside heartbeats', async () => {
      const onUpdate = vi.fn();
      const cmd = 'echo "before"; echo "::system2:: heartbeat"; echo "after"';
      const result = await exec(
        { command: cmd, inactivity_timeout_seconds: 30 },
        undefined,
        onUpdate
      );

      const stdout = (result.details as { stdout: string }).stdout;
      expect(stdout).toContain('before');
      expect(stdout).toContain('after');
      expect(stdout).not.toContain('::system2::');
    });
  });

  describe('filterHeartbeats', () => {
    it('extracts heartbeat messages and filters sentinel lines', () => {
      const input = 'line1\n::system2:: hello world\nline2\n';
      const { filtered, heartbeats } = filterHeartbeats(input);

      expect(filtered).toBe('line1\nline2\n');
      expect(heartbeats).toEqual(['hello world']);
    });

    it('handles multiple heartbeats', () => {
      const input = '::system2:: a\n::system2:: b\n';
      const { filtered, heartbeats } = filterHeartbeats(input);

      expect(filtered).toBe('');
      expect(heartbeats).toEqual(['a', 'b']);
    });

    it('returns text unchanged when no heartbeats', () => {
      const input = 'just normal output\n';
      const { filtered, heartbeats } = filterHeartbeats(input);

      expect(filtered).toBe('just normal output\n');
      expect(heartbeats).toEqual([]);
    });

    it('handles empty heartbeat message', () => {
      const { heartbeats } = filterHeartbeats('::system2::\n');
      expect(heartbeats).toEqual(['']);
    });
  });

  describe('HEARTBEAT_RE', () => {
    it('matches sentinel with message', () => {
      const match = HEARTBEAT_RE.exec('::system2:: processing batch 3');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('processing batch 3');
    });

    it('matches sentinel without message', () => {
      const match = HEARTBEAT_RE.exec('::system2::');
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('');
    });

    it('does not match partial sentinels', () => {
      expect(HEARTBEAT_RE.test('some ::system2:: embedded')).toBe(false);
    });
  });

  describe('dual timeouts', () => {
    const tool = createBashTool();
    const exec = (
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashResult['details']>
    ) => tool.execute('test-call', params as BashParams, signal, onUpdate);

    it('uses legacy 120s behavior when no timeout params given', async () => {
      // A fast command should succeed with default params (no timeout params)
      const result = await exec({ command: 'echo legacy' });
      expect((result.content[0] as { text: string }).text).toContain('legacy');
      expect(result.details).toHaveProperty('exitCode', 0);
    });

    it('uses custom inactivity timeout', async () => {
      // Command that sleeps longer than the inactivity timeout
      const result = await exec({
        command: 'sleep 15',
        inactivity_timeout_seconds: 10,
      });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('inactivity');
      expect((result.details as { exitCode: number }).exitCode).toBe(124);
    }, 20_000);

    it('uses custom total timeout', async () => {
      // Command that emits output (resets inactivity) but exceeds total timeout
      const cmd = 'for i in $(seq 1 20); do echo "tick $i"; sleep 1; done';
      const result = await exec({
        command: cmd,
        inactivity_timeout_seconds: 30,
        total_timeout_seconds: 10,
      });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('total timeout');
      expect((result.details as { exitCode: number }).exitCode).toBe(124);
    }, 20_000);

    it('active output prevents inactivity timeout', async () => {
      // Command outputs every second for 3s with a 10s inactivity timeout
      const cmd = 'for i in 1 2 3; do echo "ping $i"; sleep 1; done';
      const result = await exec({
        command: cmd,
        inactivity_timeout_seconds: 10,
        total_timeout_seconds: 30,
      });

      expect(result.details).toHaveProperty('exitCode', 0);
      expect((result.details as { stdout: string }).stdout).toContain('ping 3');
    }, 15_000);
  });

  describe('background execution', () => {
    it('returns immediately and notifies on completion', async () => {
      const notifyBackground = vi.fn();
      const tool = createBashTool(notifyBackground);

      const result: BashResult = await tool.execute('bg-call', {
        command: 'echo background',
        run_in_background: true,
      } as BashParams);

      expect((result.content[0] as { text: string }).text).toContain('started in background');
      expect((result.details as { background: boolean }).background).toBe(true);

      // Poll until the background process notifies — avoids a fixed sleep that
      // can be too short on slow CI runners (Windows in particular)
      await vi.waitFor(() => expect(notifyBackground).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      const [content] = notifyBackground.mock.calls[0];
      expect(content).toContain('background');
      expect(content).toContain('completed');
    });

    it('falls through to foreground when no notifyBackground callback', async () => {
      const tool = createBashTool(); // no callback
      const result: BashResult = await tool.execute('fg-call', {
        command: 'echo fallthrough',
        run_in_background: true,
      } as BashParams);

      // Should execute synchronously and return output directly
      expect((result.content[0] as { text: string }).text).toContain('fallthrough');
      expect(result.details).toHaveProperty('exitCode', 0);
    });
  });
});
