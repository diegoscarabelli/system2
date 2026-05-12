/**
 * Integration tests for the `read` tool.
 *
 * System2 uses pi-ai's `createReadTool` (from `@mariozechner/pi-coding-agent`)
 * rather than rolling its own. These tests exercise the integration surface
 * that system2 depends on:
 *   1. The exported factory accepts `(cwd, options?)` and returns a tool
 *      that slots into our tools array (matches `AgentTool` shape).
 *   2. `path`, `offset`, `limit` parameters behave as documented.
 *   3. Pi-ai's truncation rules (DEFAULT_MAX_LINES = 2,000 / DEFAULT_MAX_BYTES
 *      = 50 KB) emit a continuation hint that the bash-output recovery
 *      pattern in `bash.ts` depends on.
 *   4. Path resolution: absolute, `~/`, and bare-relative-to-homedir all
 *      work — mirroring the legacy system2 `resolvePath` semantics.
 *   5. End-to-end with the bash output cap: an agent that runs bash with
 *      > 16 KB output (small cap for test speed) can read slices of the
 *      saved file via offset/limit and get the right content.
 *   6. Errors (nonexistent file, out-of-bounds offset) surface through the
 *      tool runtime so the agent sees them.
 *
 * The pi-ai version is maintained upstream; we don't unit-test internals
 * here. If pi-ai's defaults or behavior change between versions, these
 * integration tests will catch the breakage at the wire.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadTool } from '@mariozechner/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createBashTool } from './bash.js';

const isWindows = platform() === 'win32';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-read-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

// Derive types from the tool so tests stay in sync with pi-ai's actual shape.
const _refTool = createReadTool(homedir());
type ReadParams = Parameters<typeof _refTool.execute>[1];

function execRead(
  tool: ReturnType<typeof createReadTool>,
  params: Record<string, unknown>
): Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: { truncation?: Record<string, unknown> };
}> {
  return tool.execute('test-call', params as ReadParams) as Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: { truncation?: Record<string, unknown> };
  }>;
}

describe('read tool (pi-ai integration)', () => {
  const tool = createReadTool(homedir(), { autoResizeImages: true });

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('smoke: reads a small text file at an absolute path', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello world');

    const result = await execRead(tool, { path: file });

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('hello world');
  });

  it('reads from `~/` path (homedir expansion)', async () => {
    // Create a file under homedir so the ~/ form has something to resolve to.
    // Cleaned up in afterEach via the tmpDirs tracker — but we have to track
    // a tmp dir whose name we control here. Use the homedir directly and
    // remove our specific file in a finally.
    const filename = `system2-read-test-${randomUUID().slice(0, 8)}.txt`;
    const homePath = join(homedir(), filename);
    writeFileSync(homePath, 'content under home');
    try {
      const result = await execRead(tool, { path: `~/${filename}` });
      expect(result.content[0].text).toContain('content under home');
    } finally {
      rmSync(homePath, { force: true });
    }
  });

  it('reads from a bare-relative path (resolves against homedir cwd)', async () => {
    // Bare-relative paths resolve against the cwd passed to createReadTool
    // (which we pinned to homedir()). This mirrors the legacy system2
    // resolvePath behavior where bare names resolved against $HOME.
    const filename = `system2-read-rel-${randomUUID().slice(0, 8)}.txt`;
    const homePath = join(homedir(), filename);
    writeFileSync(homePath, 'relative resolves under home');
    try {
      const result = await execRead(tool, { path: filename });
      expect(result.content[0].text).toContain('relative resolves under home');
    } finally {
      rmSync(homePath, { force: true });
    }
  });

  it('slices with offset + limit (1-indexed line numbers, inclusive of limit lines)', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'lines.txt');
    // 1000 lines: 'line-001', 'line-002', ..., 'line-1000'.
    const content = Array.from(
      { length: 1000 },
      (_, i) => `line-${String(i + 1).padStart(4, '0')}`
    ).join('\n');
    writeFileSync(file, content);

    // Read lines 100-150 inclusive (51 lines).
    const result = await execRead(tool, { path: file, offset: 100, limit: 51 });
    const text = result.content[0].text ?? '';

    expect(text).toContain('line-0100');
    expect(text).toContain('line-0150');
    // Boundary checks: line 99 (before offset) and line 151 (after limit)
    // must NOT appear in the slice.
    expect(text).not.toContain('line-0099');
    expect(text).not.toContain('line-0151');
  });

  it('truncates at DEFAULT_MAX_LINES (2000) and emits a continuation hint', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'huge.txt');
    // 3000 lines, short content per line so DEFAULT_MAX_BYTES (50 KB) does
    // not trip first — we want the line-count truncation path.
    const content = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n');
    writeFileSync(file, content);

    const result = await execRead(tool, { path: file });
    const text = result.content[0].text ?? '';

    // Pi-ai's continuation hint shape is `[Showing lines 1-2000 of 3000.
    // Use offset=2001 to continue.]`. Assert the agent-facing markers.
    expect(text).toMatch(/Showing lines 1-2000 of 3000/);
    expect(text).toMatch(/offset=2001 to continue/);
    expect(result.details?.truncation).toBeDefined();
  });

  it('truncates at DEFAULT_MAX_BYTES (50 KB) when a few lines are very wide', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'wide.txt');
    // 50 lines of ~2 KB each = ~100 KB; trips the byte cap before the line cap.
    const wideLine = 'X'.repeat(2_000);
    const content = Array.from({ length: 50 }, () => wideLine).join('\n');
    writeFileSync(file, content);

    const result = await execRead(tool, { path: file });
    const text = result.content[0].text ?? '';

    // Byte-truncation path uses a different hint variant (size limit, not
    // line limit).
    expect(text).toMatch(/Use offset=\d+ to continue/);
    expect(result.details?.truncation).toBeDefined();
  });

  it('rejects out-of-bounds offset with pi-ai error message', async () => {
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'three-lines.txt');
    writeFileSync(file, 'a\nb\nc');

    // Pi-ai throws on out-of-bounds offset; the tool runtime turns this into
    // a rejection rather than an error-content response. We assert the
    // promise rejects with the expected message.
    await expect(execRead(tool, { path: file, offset: 999 })).rejects.toThrow(
      /Offset 999 is beyond end of file/
    );
  });

  it('integration: bash output saved to file is readable via offset/limit', async () => {
    // The headline integration: the bash output-cap-to-file pattern in
    // bash.ts saves > 128 KB outputs (or > the configured cap) to a file
    // under sessionDir/bash-output/. The agent then uses `read` with
    // offset/limit on that file to inspect specific portions. This test
    // exercises the full round-trip end-to-end.
    const sessionDir = trackDir(makeTmpDir());
    const bash = createBashTool(undefined, { sessionDir, maxInlineOutputBytes: 16_384 });

    // Emit 400 lines of distinguishable content (each ~50 bytes) — ~20 KB,
    // comfortably over the 16 KB cap.
    const cmd = isWindows
      ? `for ($i=1; $i -le 400; $i++) { Write-Output "BASH-LINE-$i with padding ${'Y'.repeat(40)}" }`
      : `for i in $(seq 1 400); do echo "BASH-LINE-$i with padding ${'Y'.repeat(40)}"; done`;
    const bashResult = await bash.execute('toolu_integration', { command: cmd } as Parameters<
      typeof bash.execute
    >[1]);

    // Extract the saved-file path from the bash response. The header line
    // matches `[Output saved to <path> — N bytes, M lines]`. Use a
    // non-greedy match up to the ` — ` delimiter so paths containing spaces
    // (common in macOS/Windows user-profile directories) survive intact.
    const bashText = (bashResult.content[0] as { text: string }).text;
    const m = bashText.match(/Output saved to (.+?) — /);
    expect(m).not.toBeNull();
    const savedPath = m?.[1] ?? '';
    expect(existsSync(savedPath)).toBe(true);

    // Now read a specific slice of the saved file via the read tool.
    const readResult = await execRead(tool, { path: savedPath, offset: 100, limit: 5 });
    const readText = readResult.content[0].text ?? '';

    expect(readText).toContain('BASH-LINE-100');
    expect(readText).toContain('BASH-LINE-104');
    // Line outside the requested slice must NOT appear.
    expect(readText).not.toContain('BASH-LINE-99');
    expect(readText).not.toContain('BASH-LINE-105');
  });

  it('rejects on nonexistent file (pi-ai throws — tool runtime turns it into an error)', async () => {
    // Use OS-appropriate tmpdir() rather than a hardcoded /tmp path so the
    // test works on Windows runners too (where /tmp doesn't exist).
    const ghostPath = join(tmpdir(), `system2-read-ghost-${randomUUID()}.txt`);
    // Pi-ai's read throws on access failure; assert the promise rejects.
    // Behavioral change from legacy system2 read (which returned a content
    // response with "File not found: <path>" text) — documented in CHANGELOG.
    await expect(execRead(tool, { path: ghostPath })).rejects.toThrow();
  });

  it('emits the long-single-line bash fallback when a line exceeds DEFAULT_MAX_BYTES (50 KB)', async () => {
    // Pi-ai's read returns a one-line response telling the agent to use bash
    // with `sed` when a single line is too wide to fit in the byte budget.
    // This is the recovery escape hatch the docs describe; lock the marker
    // in so a pi-ai upstream change can't silently break agents that depend
    // on the fallback.
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'one-fat-line.txt');
    // 60 KB single line (no newlines) — exceeds 50 KB DEFAULT_MAX_BYTES on
    // the very first line.
    writeFileSync(file, 'X'.repeat(60_000));

    const result = await execRead(tool, { path: file });
    const text = result.content[0].text ?? '';

    // Pi-ai's message uses formatSize (e.g. "58.6KB"), not raw byte counts.
    // Format: `[Line N is X KB, exceeds 50.0KB limit. Use bash: sed -n 'Np' file | head -c BYTES]`
    expect(text).toMatch(/Line 1 is [\d.]+[KMG]?B, exceeds [\d.]+[KMG]?B limit/);
    expect(text).toMatch(/Use bash: sed -n '1p'/);
    expect(text).toContain(file);
    expect(text).toMatch(/head -c \d+\]?$/);
    // The truncation details should also flag this specific path.
    expect(result.details?.truncation).toBeDefined();
    const truncation = result.details?.truncation as Record<string, unknown>;
    expect(truncation.firstLineExceedsLimit).toBe(true);
  });

  it('reads an image file and returns an image content block (without auto-resize)', async () => {
    // 1×1 transparent PNG (canonical well-known 67-byte payload). Validates
    // pi-ai's image-detection path is reachable through our wiring and that
    // the response carries an `image` content block alongside the text note.
    //
    // Disable autoResizeImages for this test: pi-ai's resizeImage helper is
    // tuned for inline-image size limits and refuses to return a result when
    // it can't shrink the image below that limit (returns null). For a
    // 67-byte PNG the resize logic fails — pi-ai then falls back to a
    // text-only "[Image omitted: could not be resized below the inline image
    // size limit.]" response. Disabling autoResize forces the always-emit
    // path, which is the integration we want to lock in: pi-ai correctly
    // detects the MIME, base64-encodes, and emits an `image` content block.
    // (Production keeps autoResize=true; the resize logic works for real
    // images, just not pathologically tiny test fixtures.)
    const noResizeTool = createReadTool(homedir(), { autoResizeImages: false });
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'pixel.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeIVWwwAAAAASUVORK5CYII=',
      'base64'
    );
    writeFileSync(file, png);

    const result = await execRead(noResizeTool, { path: file });

    // Pi-ai returns [text note, image]. Image block has `data` (base64) +
    // `mimeType` (image/png). The text note describes the file as an image.
    const types = result.content.map((b) => b.type);
    expect(types).toContain('text');
    expect(types).toContain('image');
    const imageBlock = result.content.find((b) => b.type === 'image');
    expect(imageBlock?.mimeType).toMatch(/^image\/png$/);
    expect(typeof imageBlock?.data).toBe('string');
    expect((imageBlock?.data ?? '').length).toBeGreaterThan(0);
  });

  it('asserts the truncation details schema (locks in pi-ai field names)', async () => {
    // Loose `toBeDefined()` doesn't catch upstream field renames. Lock the
    // documented schema so a pi-ai bump that renames `outputLines` or drops
    // `firstLineExceedsLimit` surfaces here as a test failure rather than a
    // silent regression in any consumer that reads `details.truncation`.
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'three-thousand.txt');
    const content = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n');
    writeFileSync(file, content);

    const result = await execRead(tool, { path: file });
    const t = result.details?.truncation as Record<string, unknown>;
    expect(t).toBeDefined();
    // Documented keys from pi-ai's createReadToolDefinition source.
    expect(t).toHaveProperty('truncated');
    expect(t).toHaveProperty('truncatedBy');
    expect(t).toHaveProperty('outputLines');
    expect(t).toHaveProperty('totalLines');
    // `maxLines` / `maxBytes` may be optional (only the active limit's value
    // is necessarily present), so we assert at least one is set.
    expect(t.maxLines !== undefined || t.maxBytes !== undefined).toBe(true);
    // For the line-cap path we expect `truncatedBy === 'lines'`.
    expect(t.truncatedBy).toBe('lines');
    expect(t.truncated).toBe(true);
  });

  it('rejects with "Operation aborted" when the session signal aborts before execute', async () => {
    // Pi-ai's createReadTool observes AbortSignal — agent sessions that get
    // cancelled mid-read should fail cleanly. Easiest deterministic case:
    // abort the signal BEFORE calling execute. The pre-execute guard inside
    // pi-ai returns a rejection before any fs work happens.
    const dir = trackDir(makeTmpDir());
    const file = join(dir, 'tiny.txt');
    writeFileSync(file, 'hello');

    const controller = new AbortController();
    controller.abort();

    // tool.execute(toolCallId, params, signal?, onUpdate?, ctx?) — pass the
    // aborted signal as the third arg.
    await expect(
      tool.execute('test-abort', { path: file } as ReadParams, controller.signal)
    ).rejects.toThrow(/Operation aborted/);
  });

  // Defensive: confirm the tool registers with the expected name + parameters.
  // If pi-ai ever renames `read` to something else upstream, agent prompts
  // (which mention the literal name `read`) would silently break.
  it('exposes the tool with name="read" and the documented parameter set', () => {
    expect(tool.name).toBe('read');
    // The parameters schema should accept `path` (required), `offset`, `limit`.
    // We don't enumerate the schema internals (typebox shape varies) — just
    // assert the tool definition has a parameters field.
    expect(tool.parameters).toBeDefined();
  });
});
