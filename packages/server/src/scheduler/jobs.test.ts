import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHost } from '../agents/host.js';
import {
  buildAndDeliverMemoryUpdate,
  collectAgentActivity,
  formatMarkdownTable,
  readFrontmatterField,
  readTailChars,
  resolveDailySummaryTimestamp,
  stripSessionEntry,
} from './jobs.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `system2-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];
function trackTmpDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('readFrontmatterField', () => {
  it('reads a field from YAML frontmatter', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\ntitle: Hello World\ndate: 2025-01-01\n---\nBody');
    expect(readFrontmatterField(file, 'title')).toBe('Hello World');
    expect(readFrontmatterField(file, 'date')).toBe('2025-01-01');
  });

  it('returns null for missing field', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\ntitle: Test\n---\n');
    expect(readFrontmatterField(file, 'missing')).toBeNull();
  });

  it('returns null for missing file', () => {
    expect(readFrontmatterField('/nonexistent/file.md', 'title')).toBeNull();
  });

  it('returns null for empty field value', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'test.md');
    writeFileSync(file, '---\nlast_narrator_update_ts:\n---\n');
    expect(readFrontmatterField(file, 'last_narrator_update_ts')).toBeNull();
  });
});

describe('readTailChars', () => {
  it('reads last N characters of a file', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'abcdefghij'); // 10 chars
    expect(readTailChars(file, 5)).toBe('fghij');
  });

  it('returns full content if file has fewer than N chars', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'short');
    expect(readTailChars(file, 100)).toBe('short');
  });

  it('returns empty string for missing file', () => {
    expect(readTailChars('/nonexistent/file.txt', 5)).toBe('');
  });

  it('returns exact content when length equals N', () => {
    const dir = trackTmpDir(makeTmpDir());
    const file = join(dir, 'log.txt');
    writeFileSync(file, 'exact');
    expect(readTailChars(file, 5)).toBe('exact');
  });
});

describe('formatMarkdownTable', () => {
  it('formats rows as a markdown table', () => {
    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    const result = formatMarkdownTable(rows);
    expect(result).toContain('| id | name |');
    expect(result).toContain('|---|---|');
    expect(result).toContain('| 1 | Alice |');
    expect(result).toContain('| 2 | Bob |');
  });

  it('returns "(no data)" for empty array', () => {
    expect(formatMarkdownTable([])).toBe('(no data)');
  });

  it('handles null/undefined values', () => {
    const rows = [{ a: null, b: undefined }];
    const result = formatMarkdownTable(rows);
    expect(result).toContain('|  |  |');
  });
});

describe('resolveDailySummaryTimestamp', () => {
  it('returns null lastRunTs on first run with no files', () => {
    const dir = trackTmpDir(makeTmpDir());
    const result = resolveDailySummaryTimestamp(dir, 30);
    expect(result.lastRunTs).toBeNull();
    expect(result.newRunTs).toBeTruthy();
    expect(result.filePath).toContain('daily_summaries');
  });

  it('picks up timestamp from existing daily summary', () => {
    const dir = trackTmpDir(makeTmpDir());
    const summariesDir = join(dir, 'knowledge', 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(summariesDir, `${today}.md`),
      '---\nlast_narrator_update_ts: 2025-06-01T10:00:00Z\n---\n# Summary'
    );
    const result = resolveDailySummaryTimestamp(dir, 30);
    expect(result.lastRunTs).toBe('2025-06-01T10:00:00Z');
  });
});

describe('collectAgentActivity', () => {
  it('reports "(no activity)" for agents without session dirs', () => {
    const dir = trackTmpDir(makeTmpDir());
    const agents = [{ id: 1, role: 'guide', project_name: 'test-project' }];
    const result = collectAgentActivity(
      dir,
      agents,
      '2025-01-01T00:00:00Z',
      '2025-12-31T23:59:59Z'
    );
    expect(result).toContain('(no activity)');
    expect(result).toContain('guide_1');
    expect(result).toContain('project: test-project');
  });

  it('collects entries in the time window', () => {
    const dir = trackTmpDir(makeTmpDir());
    const sessionDir = join(dir, 'sessions', 'guide_1');
    mkdirSync(sessionDir, { recursive: true });

    const entries = [
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T09:00:00Z', content: 'before' }),
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T10:30:00Z', content: 'in-window' }),
      JSON.stringify({ type: 'message', timestamp: '2025-06-01T12:00:00Z', content: 'after' }),
      JSON.stringify({
        type: 'session',
        timestamp: '2025-06-01T10:30:00Z',
        content: 'excluded-type',
      }),
    ];
    writeFileSync(join(sessionDir, 'session.jsonl'), entries.join('\n'));

    const agents = [{ id: 1, role: 'guide', project_name: null }];
    const result = collectAgentActivity(
      dir,
      agents,
      '2025-06-01T10:00:00Z',
      '2025-06-01T11:00:00Z'
    );
    expect(result).toContain('in-window');
    expect(result).not.toContain('before');
    expect(result).not.toContain('after');
    expect(result).not.toContain('excluded-type');
  });
});

describe('buildAndDeliverMemoryUpdate', () => {
  function mockNarratorHost(): AgentHost & { calls: Array<{ content: string; details: unknown }> } {
    const calls: Array<{ content: string; details: unknown }> = [];
    return {
      calls,
      deliverMessage(content: string, details: unknown) {
        calls.push({ content, details });
      },
    } as unknown as AgentHost & { calls: Array<{ content: string; details: unknown }> };
  }

  it('skips delivery when no daily summary files exist', () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-10T00:00:00Z\n---\n# Memory'
    );

    const host = mockNarratorHost();
    buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(0);
  });

  it('skips delivery when all summaries are older than last update', () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-12T00:00:00Z\n---\n# Memory'
    );
    writeFileSync(join(summariesDir, '2026-03-10.md'), '---\n---\n# Old summary');

    const host = mockNarratorHost();
    buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(0);
  });

  it('delivers message with summary files since last update', () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, 'memory.md'),
      '---\nlast_narrator_update_ts: 2026-03-10T00:00:00Z\n---\n# Memory'
    );
    writeFileSync(join(summariesDir, '2026-03-10.md'), '---\n---\n# Summary 10');
    writeFileSync(join(summariesDir, '2026-03-11.md'), '---\n---\n# Summary 11');
    writeFileSync(join(summariesDir, '2026-03-09.md'), '---\n---\n# Before');

    const host = mockNarratorHost();
    buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(1);

    const msg = host.calls[0].content;
    expect(msg).toContain('[Scheduled task: memory-update]');
    expect(msg).toContain('2026-03-10.md');
    expect(msg).toContain('2026-03-11.md');
    expect(msg).not.toContain('2026-03-09.md');
    expect(msg).toContain('IMPORTANT');
    expect(msg).toContain('UTC ISO 8601');
  });

  it('includes all summaries when memory.md has no timestamp', () => {
    const dir = trackTmpDir(makeTmpDir());
    const knowledgeDir = join(dir, 'knowledge');
    const summariesDir = join(knowledgeDir, 'daily_summaries');
    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(join(knowledgeDir, 'memory.md'), '---\nlast_narrator_update_ts:\n---\n# Memory');
    writeFileSync(join(summariesDir, '2026-03-10.md'), '---\n---\n# Summary');

    const host = mockNarratorHost();
    buildAndDeliverMemoryUpdate(host, 2, dir);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].content).toContain('2026-03-10.md');
  });
});

describe('stripSessionEntry', () => {
  it('passes through unknown entry types unchanged', () => {
    const entry = { type: 'session', version: 3, id: 'abc' };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  it('passes through message with user role unchanged', () => {
    const entry = {
      type: 'message',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  it('passes through message with missing message field unchanged', () => {
    const entry = { type: 'message', timestamp: '2026-01-01T00:00:00Z' };
    expect(stripSessionEntry(entry)).toEqual(entry);
  });

  describe('custom_message', () => {
    it('drops details', () => {
      const entry = {
        type: 'custom_message',
        content: 'hello',
        details: { sender: 1, receiver: 2, timestamp: 0 },
      };
      const result = stripSessionEntry(entry);
      expect(result).not.toHaveProperty('details');
      expect(result.content).toBe('hello');
    });

    it('does not crash when details is absent', () => {
      const entry = { type: 'custom_message', content: 'hello' };
      expect(stripSessionEntry(entry)).toEqual({ type: 'custom_message', content: 'hello' });
    });
  });

  describe('assistant message', () => {
    it('drops usage, api, provider, model', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          api: 'google-generative-ai',
          provider: 'google',
          model: 'gemini-2.0-flash',
          usage: { input: 1000, output: 50, totalTokens: 1050 },
          content: [],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message).not.toHaveProperty('api');
      expect(result.message).not.toHaveProperty('provider');
      expect(result.message).not.toHaveProperty('model');
      expect(result.message).not.toHaveProperty('usage');
    });

    it('drops thoughtSignature and id from toolCall blocks', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-123',
              name: 'bash',
              thoughtSignature: 'a'.repeat(500),
              arguments: { command: 'echo hi' },
            },
          ],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block).not.toHaveProperty('thoughtSignature');
      expect(block).not.toHaveProperty('id');
      expect(block.name).toBe('bash');
    });

    it('truncates long string argument values to 100 chars', () => {
      const longCmd = 'x'.repeat(300);
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: longCmd } }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(typeof args.command).toBe('string');
      expect((args.command as string).length).toBe(100);
    });

    it('does not truncate argument values already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'echo hi' } }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(args.command).toBe('echo hi');
    });

    it('passes non-string argument values through unchanged', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'read_system2_db', arguments: { limit: 10, dry: true } },
          ],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      const args = block.arguments as Record<string, unknown>;
      expect(args.limit).toBe(10);
      expect(args.dry).toBe(true);
    });

    it('does not add arguments key when absent on toolCall', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block).not.toHaveProperty('arguments');
    });

    it('preserves thinking blocks unchanged', () => {
      const thinking = 'deep thought '.repeat(20);
      const entry = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking, thinkingSignature: 'sig' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.thinking).toBe(thinking);
      expect(block.thinkingSignature).toBe('sig');
    });

    it('preserves text blocks unchanged', () => {
      const entry = {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.text).toBe('Done.');
    });

    it('does not crash when content is not an array', () => {
      const entry = {
        type: 'message',
        message: { role: 'assistant', content: null },
      };
      expect(() => stripSessionEntry(entry)).not.toThrow();
    });
  });

  describe('toolResult message', () => {
    it('drops details', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          details: { exitCode: 0, stdout: 'hello' },
          content: [{ type: 'text', text: 'hello' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message).not.toHaveProperty('details');
      expect(result.message.toolName).toBe('bash');
    });

    it('truncates long text content to 100 chars', () => {
      const longText = 'a'.repeat(300);
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: longText }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(typeof block.text).toBe('string');
      expect((block.text as string).length).toBe(100);
    });

    it('does not truncate text content already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'short result' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.text).toBe('short result');
    });

    it('passes through non-text content blocks unchanged', () => {
      const entry = {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'image', data: 'base64...' }],
        },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      const block = (result.message.content as Record<string, unknown>[])[0];
      expect(block.type).toBe('image');
      expect(block.data).toBe('base64...');
    });

    it('does not crash with empty content array', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: [] },
      };
      expect(() => stripSessionEntry(entry)).not.toThrow();
    });

    it('truncates string-form content to 100 chars', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: 'x'.repeat(300) },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(typeof result.message.content).toBe('string');
      expect((result.message.content as string).length).toBe(100);
    });

    it('does not truncate string-form content already under 100 chars', () => {
      const entry = {
        type: 'message',
        message: { role: 'toolResult', toolName: 'bash', content: 'short' },
      };
      const result = stripSessionEntry(entry) as Record<string, Record<string, unknown>>;
      expect(result.message.content).toBe('short');
    });
  });
});
