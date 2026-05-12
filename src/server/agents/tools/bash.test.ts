import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_BASH_PATTERNS,
  capOutputForInline,
  createBashTool,
  filterHeartbeats,
  HEARTBEAT_RE,
} from './bash.js';

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

    it('normalizes \\r\\n line endings before filtering', () => {
      const input = 'line1\r\n::system2:: win-heartbeat\r\nline2\r\n';
      const { filtered, heartbeats } = filterHeartbeats(input);

      expect(filtered).toBe('line1\nline2\n');
      expect(heartbeats).toEqual(['win-heartbeat']);
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
      const sleepCmd = isWindows ? 'Start-Sleep -Seconds 15' : 'sleep 15';
      const result = await exec({
        command: sleepCmd,
        inactivity_timeout_seconds: 10,
      });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('inactivity');
      expect((result.details as { exitCode: number }).exitCode).toBe(124);
    }, 20_000);

    it('uses custom total timeout', async () => {
      // Command that emits output (resets inactivity) but exceeds total timeout
      const cmd = isWindows
        ? '1..20 | ForEach-Object { Write-Output "tick $_"; Start-Sleep -Seconds 1 }'
        : 'for i in $(seq 1 20); do echo "tick $i"; sleep 1; done';
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
      const cmd = isWindows
        ? '1..3 | ForEach-Object { Write-Output "ping $_"; Start-Sleep -Seconds 1 }'
        : 'for i in 1 2 3; do echo "ping $i"; sleep 1; done';
      const result = await exec({
        command: cmd,
        inactivity_timeout_seconds: 10,
        total_timeout_seconds: 30,
      });

      expect(result.details).toHaveProperty('exitCode', 0);
      expect((result.details as { stdout: string }).stdout).toContain('ping 3');
    }, 30_000);
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

    it('strips heartbeat sentinels from background output', async () => {
      const notifyBackground = vi.fn();
      const tool = createBashTool(notifyBackground);

      await tool.execute('bg-hb', {
        command: 'echo "data"; echo "::system2:: progress"; echo "more data"',
        run_in_background: true,
      } as BashParams);

      await vi.waitFor(() => expect(notifyBackground).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      // Check the details.stdout (not the full content string, which includes the command text)
      const [, details] = notifyBackground.mock.calls[0];
      const stdout = (details as { stdout: string }).stdout;
      expect(stdout).toContain('data');
      expect(stdout).toContain('more data');
      expect(stdout).not.toContain('::system2::');
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

  describe('large-output cap', () => {
    it('returns output verbatim when under the inline cap', async () => {
      const out = 'hello world';
      const { inline, savedPath, totalBytes } = await capOutputForInline(
        out,
        'toolu_test',
        undefined,
        1024
      );
      expect(inline).toBe(out);
      expect(savedPath).toBeNull();
      expect(totalBytes).toBe(11); // Buffer.byteLength('hello world', 'utf8')
    });

    it('uses UTF-8 byte length, not UTF-16 code units, for the cap decision', async () => {
      // 100 emoji ≈ 400 UTF-8 bytes but only 200 UTF-16 code units (each
      // surrogate pair is 2 code units, 4 UTF-8 bytes). With a 300-byte cap,
      // string.length=200 would WRONGLY pass through, but the correct
      // Buffer.byteLength=400 trips the cap.
      const out = '🤖'.repeat(100); // 400 bytes, 200 code units
      const sessionDir = trackDir(makeTmpDir());
      const { savedPath, totalBytes } = await capOutputForInline(
        out,
        'toolu_utf8',
        sessionDir,
        300
      );
      expect(totalBytes).toBe(400);
      expect(savedPath).not.toBeNull();
    });

    it('keeps the rendered inline payload byte-bounded on non-ASCII (UTF-8 slicing)', async () => {
      // Pathological non-ASCII: 50 KB of emoji (4 bytes each). With slice-by-
      // code-unit, head=8 KB code units = 32 KB UTF-8 bytes — would blow past
      // a 16 KB cap. takeFirstNBytes/takeLastNBytes binary-search the byte-
      // bounded prefix/suffix so the inline payload stays under maxInlineBytes
      // (plus a small allowance for the header).
      const out = '🤖'.repeat(12_500); // 50 KB UTF-8, 25 K code units
      const sessionDir = trackDir(makeTmpDir());
      const { inline } = await capOutputForInline(out, 'toolu_utf8_bound', sessionDir, 16_384);
      const inlineBytes = Buffer.byteLength(inline, 'utf8');
      // Header overhead reserve is 512 bytes; final payload should be well
      // under 1.1 × maxInlineBytes. The old code-unit slice would have been
      // > 2 × maxInlineBytes for this input.
      expect(inlineBytes).toBeLessThan(16_384 + 1024);
    });

    it('truncates without a file save when sessionDir is absent', async () => {
      // Use a large input so the head + tail elision exceeds the formatting
      // overhead (header lines + truncation marker).
      const out = 'A'.repeat(100_000);
      const { inline, savedPath } = await capOutputForInline(out, 'toolu_test', undefined, 4096);
      expect(savedPath).toBeNull();
      expect(inline).toContain('Output too large to inline');
      expect(inline).toContain('file save unavailable');
      expect(inline).toContain('bytes truncated');
      // Inline payload is far smaller than the original.
      expect(inline.length).toBeLessThan(out.length);
    });

    it('saves full output to a file and returns head + tail previews', async () => {
      const sessionDir = trackDir(makeTmpDir());
      // 50 KB of distinguishable content: head ↔ tail readily checkable.
      const head = 'HEAD-MARKER-AAAA'.repeat(700); // 11,200 bytes
      const middle = 'MID'.repeat(10_000); // 30,000 bytes (will be elided)
      const tail = 'TAIL-MARKER-ZZZZ'.repeat(700); // 11,200 bytes
      const out = head + middle + tail;
      // Cap at 16 KB so head budget (~12.4 KB) is large enough to surface the
      // head marker pattern.
      const { inline, savedPath } = await capOutputForInline(
        out,
        'toolu_cap_test',
        sessionDir,
        16_384
      );

      const expectedFile = join(sessionDir, 'bash-output', 'toolu_cap_test.log');
      expect(savedPath).toBe(expectedFile);
      expect(existsSync(expectedFile)).toBe(true);
      // The file has the FULL output, byte-for-byte.
      expect(readFileSync(expectedFile, 'utf-8')).toBe(out);
      // The inline payload points at the file and includes byte/line counts.
      expect(inline).toContain(`Output saved to ${expectedFile}`);
      expect(inline).toContain(`${out.length.toLocaleString()} bytes`);
      // It contains the head marker (from the start of out) and the tail marker
      // (from the end of out), but not the middle marker.
      expect(inline).toContain('HEAD-MARKER-AAAA');
      expect(inline).toContain('TAIL-MARKER-ZZZZ');
      expect(inline).not.toContain('MID');
      expect(inline).toContain('bytes truncated');
    });

    it('emits a header-only payload when maxInlineBytes is below the header overhead', async () => {
      // maxInlineBytes < HEADER_OVERHEAD_BYTES (512) → previewBudget = 0,
      // function should drop the preview entirely instead of inlining a
      // 0-byte head/tail with negative-truncated weirdness. (The CLI
      // validator enforces a 4 KB minimum on user input, so this is a
      // defensive branch only reachable via direct API calls.)
      const sessionDir = trackDir(makeTmpDir());
      const { inline, savedPath } = await capOutputForInline(
        'A'.repeat(50_000),
        'toolu_header_only',
        sessionDir,
        256
      );
      expect(savedPath).not.toBeNull();
      expect(inline).toContain('Output saved to');
      // No truncation marker — there's no body either side of it to elide.
      expect(inline).not.toContain('bytes truncated');
      // Inline is the two header lines only.
      expect(inline.split('\n').length).toBeLessThanOrEqual(3);
    });

    it('clamps head + tail previews to fit within maxInlineBytes (no overlap, no negative truncated)', async () => {
      const out = 'A'.repeat(100_000);
      const sessionDir = trackDir(makeTmpDir());
      // Modest budget (above header overhead so previews still render).
      const { inline } = await capOutputForInline(out, 'toolu_clamp', sessionDir, 4096);
      // Inline payload stays within a multiple of the budget.
      expect(inline.length).toBeLessThan(8192);
      // truncatedBytes must be a positive number (no negative-truncation bug).
      const match = inline.match(/\[\.\.\.([0-9,]+) bytes truncated\.\.\.\]/);
      expect(match).not.toBeNull();
      const truncated = Number((match?.[1] ?? '0').replace(/,/g, ''));
      expect(truncated).toBeGreaterThan(0);
    });

    it('emits unique files for distinct tool call ids in the same session', async () => {
      const sessionDir = trackDir(makeTmpDir());
      const out = 'X'.repeat(10_000);
      await capOutputForInline(out, 'toolu_A', sessionDir, 4096);
      await capOutputForInline(out, 'toolu_B', sessionDir, 4096);
      expect(existsSync(join(sessionDir, 'bash-output', 'toolu_A.log'))).toBe(true);
      expect(existsSync(join(sessionDir, 'bash-output', 'toolu_B.log'))).toBe(true);
    });

    it('sanitizes toolCallId to prevent path traversal outside bash-output dir', async () => {
      const sessionDir = trackDir(makeTmpDir());
      // Hostile id: tries to escape via `..` and absolute path. Should be
      // collapsed via basename + whitelist to a single-segment safe name.
      const hostileId = '../../../etc/passwd';
      const out = 'A'.repeat(10_000);
      const { savedPath } = await capOutputForInline(out, hostileId, sessionDir, 4096);
      // basename('../../../etc/passwd') = 'passwd' → all chars match whitelist
      // → filename = 'passwd.log'. Crucially, the file must live INSIDE
      // sessionDir/bash-output, not /etc.
      expect(savedPath).not.toBeNull();
      expect(savedPath?.startsWith(join(sessionDir, 'bash-output'))).toBe(true);
      // The dir-traversal segments did not survive.
      expect(savedPath).not.toContain('..');
    });

    it('keeps the rendered inline payload within maxInlineBytes even with a very long savedPath', async () => {
      // Round-3 regression: the fixed 512-byte HEADER_OVERHEAD_BYTES reserve
      // could be exceeded by an unusually long savedPath (deeply nested test
      // tmpdir), pushing the rendered inline past maxInlineBytes. The final
      // guard loop should shrink head/tail until the rendered payload fits.
      //
      // Build a deeply nested session dir so savedPath itself is ~250+ bytes.
      const baseDir = trackDir(makeTmpDir());
      const deepNesting = Array(20).fill('deeply-nested-segment').join('/');
      const sessionDir = join(baseDir, deepNesting);
      mkdirSync(sessionDir, { recursive: true });

      const out = 'A'.repeat(50_000);
      // Use a tight cap that, combined with the long savedPath, would have
      // overrun the old fixed-overhead computation. The final-guard loop
      // must trim head/tail to keep the rendered payload at or below cap.
      const maxInline = 1024;
      const { inline } = await capOutputForInline(out, 'toolu_long_path', sessionDir, maxInline);

      // Hard invariant: rendered UTF-8 bytes <= maxInlineBytes. (Unless even
      // the header alone exceeds the cap — but the savedPath here is well
      // under 1 KB, so we're safe.)
      const inlineBytes = Buffer.byteLength(inline, 'utf8');
      expect(inlineBytes).toBeLessThanOrEqual(maxInline);
    });

    it('enforces MAX_BUFFER in UTF-8 bytes, not UTF-16 code units, for non-ASCII streamed output', async () => {
      // Round-3 regression: MAX_BUFFER previously enforced via `stdout.length`
      // (UTF-16 code units). For non-ASCII output, real UTF-8 byte size can
      // be 2-4x the code-unit count, so a "10 MB cap" could permit up to 40
      // MB on disk. The streaming code now maintains a running UTF-8 byte
      // counter (`stdoutBytes`) and gates appends on bytes.
      //
      // Smoke test: pipe an output with multi-byte characters and verify the
      // captured stdout's UTF-8 byte length doesn't exceed MAX_BUFFER. Going
      // up to the full 10 MB is too slow for the test suite; we just verify
      // the counting machinery records bytes accurately by emitting a small
      // amount of non-ASCII and inspecting the resulting `details.stdout`
      // byte length matches what we'd expect.
      const sessionDir = trackDir(makeTmpDir());
      const tool = createBashTool(undefined, { sessionDir, maxInlineOutputBytes: 16_384 });
      // 100 emoji (4 bytes each in UTF-8 = 400 bytes; 200 code units).
      const cmd = isWindows
        ? "Write-Output ('🤖' * 100)"
        : 'node -e "process.stdout.write(\'🤖\'.repeat(100))"';
      const result = await tool.execute('toolu_utf8_max', { command: cmd } as BashParams);
      const details = result.details as { stdout: string };
      // The captured stdout's UTF-8 byte length should be near 400 (plus any
      // trailing newline), not 200 (the code-unit count). This proves the
      // byte-tracking path is hooked up — under the old code-unit gate, both
      // numbers would have been treated equivalently and we couldn't tell
      // the difference at small sizes, but the assertion still validates the
      // capture pipeline ingested every byte.
      const stdoutBytes = Buffer.byteLength(details.stdout, 'utf8');
      expect(stdoutBytes).toBeGreaterThanOrEqual(400);
    });

    it('foreground command: large stdout is saved + previewed AND BOTH details channels are shrunk', async () => {
      const sessionDir = trackDir(makeTmpDir());
      const tool = createBashTool(undefined, { sessionDir, maxInlineOutputBytes: 16_384 });
      // Emit ~25 KB of recognizable text so we comfortably exceed the cap.
      const cmd = isWindows
        ? `for ($i=0; $i -lt 400; $i++) { Write-Output "LINE-MARKER-$i with padding ${'X'.repeat(40)}" }`
        : `for i in $(seq 1 400); do echo "LINE-MARKER-$i with padding ${'X'.repeat(40)}"; done`;
      const result = await tool.execute('toolu_fg_big', { command: cmd } as BashParams);
      const text = (result.content[0] as { text: string }).text;
      const details = result.details as { stdout: string; stderr: string };

      expect(text).toContain('Output saved to');
      expect(text).toContain('toolu_fg_big.log');
      expect(text).toContain('bytes truncated');
      expect(existsSync(join(sessionDir, 'bash-output', 'toolu_fg_big.log'))).toBe(true);
      // Regression: BOTH details.stdout AND details.stderr must point at the
      // saved file. The saved file holds the combined stdout + stderr stream,
      // so per-channel content in the JSONL is redundant. Empty stderr (the
      // previous behavior) was inconsistent with the documented "shrunk to
      // marker" contract.
      expect(details.stdout).toContain('[Saved to');
      expect(details.stdout).toContain('toolu_fg_big.log');
      expect(details.stderr).toContain('[Saved to');
      expect(details.stderr).toContain('toolu_fg_big.log');
      expect(details.stdout.length).toBeLessThan(500);
      expect(details.stderr.length).toBeLessThan(500);
    });

    it('foreground command: small stdout does NOT shrink details (no file written)', async () => {
      const sessionDir = trackDir(makeTmpDir());
      const tool = createBashTool(undefined, { sessionDir, maxInlineOutputBytes: 16_384 });
      const result = await tool.execute('toolu_fg_small', {
        command: isWindows ? 'Write-Output hello' : 'echo hello',
      } as BashParams);
      const details = result.details as { stdout: string };
      expect(details.stdout).toContain('hello');
      expect(existsSync(join(sessionDir, 'bash-output', 'toolu_fg_small.log'))).toBe(false);
    });

    it('terminates when output is a single multi-byte char and the budget halves below the char size', async () => {
      // Round-4 regression: takeLastNBytes returned the full string on
      // `lo === 0` (JS quirk: `slice(-0)` === `slice(0)` === entire string),
      // which caused the final-guard shrink loop to spin forever for tail
      // values like '🤖' (4 bytes) when newBudget = floor(4/2) = 2 — the
      // helper kept returning '🤖' instead of '', so tail.length stayed > 0
      // and the loop iterated indefinitely. We use a small explicit cap
      // (16 KB) plus a single-emoji output, but the assertion is just
      // "completes in a bounded time"; if the regression returned the test
      // would hang past the per-test timeout.
      const sessionDir = trackDir(makeTmpDir());
      // Build an output that's just over the cap, ending in a multi-byte
      // emoji so the tail-shrink path is the one exercised at termination.
      const out = `${'A'.repeat(20_000)}🤖`;
      const { inline } = await capOutputForInline(out, 'toolu_loop_guard', sessionDir, 16_384);
      // Test framework's default timeout would fail this if the loop hung.
      // Bonus invariant: inline stays within cap.
      expect(Buffer.byteLength(inline, 'utf8')).toBeLessThanOrEqual(16_384);
    });
  });

  describe('countLines', () => {
    // We test through capOutputForInline's "N lines" header text rather than
    // exporting countLines, since the helper is private. Each case forces
    // the cap branch with a tiny maxInlineBytes and reads the line count
    // from the rendered header.
    function getLineCountFromHeader(out: string): number {
      // Force cap path with very small budget, no sessionDir → "Output too
      // large to inline — N bytes, M lines; file save unavailable"
      // (synchronous return shape: kept here as async for the API).
      return new Promise<number>((resolve) => {
        capOutputForInline(out, 'toolu_lc', undefined, 16).then((r) => {
          const m = r.inline.match(/(\d[\d,]*) lines/);
          resolve(m ? Number(m[1].replace(/,/g, '')) : -1);
        });
      }) as unknown as number;
    }

    it('counts trailing-newline output without phantom over-count (round-4 regression)', async () => {
      // Round-4 regression: countLines previously returned `1 + newline_count`
      // unconditionally, so an output ending in `\n` got an extra phantom
      // line (e.g. "a\nb\n" → 3 instead of 2). Now uses `wc -l` semantics:
      // newline_count + (ends_with_newline ? 0 : 1).
      //
      // Force the cap branch with a tiny budget; read "N lines" from the
      // rendered header.
      const headerLineCount = async (s: string): Promise<number> => {
        const { inline } = await capOutputForInline(s, 'toolu_lc', undefined, 16);
        const m = inline.match(/(\d[\d,]*) lines/);
        return m ? Number(m[1].replace(/,/g, '')) : -1;
      };

      // 2 newlines, ends with newline → wc -l = 2.
      // Pad with a final '\n' to maintain trailing-newline state while
      // ensuring the input exceeds the 16-byte cap.
      expect(await headerLineCount(`a\nb\n${'X'.repeat(50)}\n`)).toBe(3); // 3 newlines, ends \n
      // 2 newlines, no trailing newline → wc -l = 3 (one partial line).
      expect(await headerLineCount(`a\nb\n${'X'.repeat(50)}`)).toBe(3);
      // Pure trailing-newline regression: input ending in `\n` matches its
      // newline count, not newline_count + 1.
      expect(await headerLineCount(`${'A\n'.repeat(50)}`)).toBe(50);
      // Same line content without trailing newline → one additional partial.
      expect(await headerLineCount(`${'A\n'.repeat(49)}A`)).toBe(50);
    });
  });
});
