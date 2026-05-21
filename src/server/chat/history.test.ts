import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/index.js';
import { MessageHistory } from './history.js';

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

function makeMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: Date.now() };
}

describe('MessageHistory', () => {
  it('starts empty when file does not exist', () => {
    const dir = trackTmpDir(makeTmpDir());
    const history = new MessageHistory(join(dir, 'history.json'));
    expect(history.getMessages()).toEqual([]);
  });

  it('adds and retrieves messages', () => {
    const dir = trackTmpDir(makeTmpDir());
    const history = new MessageHistory(join(dir, 'history.json'));
    const msg = makeMessage('1', 'hello');
    history.push(msg);
    expect(history.getMessages()).toHaveLength(1);
    expect(history.getMessages()[0].content).toBe('hello');
  });

  it('returns a defensive copy', () => {
    const dir = trackTmpDir(makeTmpDir());
    const history = new MessageHistory(join(dir, 'history.json'));
    history.push(makeMessage('1', 'hello'));
    const msgs = history.getMessages();
    msgs.push(makeMessage('2', 'injected'));
    expect(history.getMessages()).toHaveLength(1);
  });

  it('enforces maxMessages limit', () => {
    const dir = trackTmpDir(makeTmpDir());
    const history = new MessageHistory(join(dir, 'history.json'), 3);
    history.push(makeMessage('1', 'a'));
    history.push(makeMessage('2', 'b'));
    history.push(makeMessage('3', 'c'));
    history.push(makeMessage('4', 'd'));
    const msgs = history.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('b');
    expect(msgs[2].content).toBe('d');
  });

  it('persists to disk and loads on new instance', () => {
    const dir = trackTmpDir(makeTmpDir());
    const filePath = join(dir, 'history.json');
    const h1 = new MessageHistory(filePath);
    h1.push(makeMessage('1', 'persisted'));

    const h2 = new MessageHistory(filePath);
    expect(h2.getMessages()).toHaveLength(1);
    expect(h2.getMessages()[0].content).toBe('persisted');
  });

  it('handles corrupted file gracefully', () => {
    const dir = trackTmpDir(makeTmpDir());
    const filePath = join(dir, 'history.json');
    writeFileSync(filePath, 'not valid json{{{');
    const history = new MessageHistory(filePath);
    expect(history.getMessages()).toEqual([]);
  });

  it('creates parent directories if needed', () => {
    const dir = trackTmpDir(makeTmpDir());
    const filePath = join(dir, 'nested', 'deep', 'history.json');
    const history = new MessageHistory(filePath);
    history.push(makeMessage('1', 'deep'));
    expect(history.getMessages()).toHaveLength(1);
  });

  describe('subscribe (observable)', () => {
    it('notifies listeners on every push', () => {
      const dir = trackTmpDir(makeTmpDir());
      const history = new MessageHistory(join(dir, 'history.json'));
      const received: ChatMessage[] = [];
      history.subscribe((msg) => received.push(msg));

      history.push(makeMessage('1', 'a'));
      history.push(makeMessage('2', 'b'));

      expect(received).toHaveLength(2);
      expect(received[0].id).toBe('1');
      expect(received[1].id).toBe('2');
    });

    it('returns an unsubscribe handle', () => {
      const dir = trackTmpDir(makeTmpDir());
      const history = new MessageHistory(join(dir, 'history.json'));
      const received: ChatMessage[] = [];
      const unsub = history.subscribe((msg) => received.push(msg));

      history.push(makeMessage('1', 'a'));
      unsub();
      history.push(makeMessage('2', 'b'));

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe('1');
    });

    it('supports multiple independent subscribers', () => {
      const dir = trackTmpDir(makeTmpDir());
      const history = new MessageHistory(join(dir, 'history.json'));
      const a: ChatMessage[] = [];
      const b: ChatMessage[] = [];
      history.subscribe((msg) => a.push(msg));
      history.subscribe((msg) => b.push(msg));

      history.push(makeMessage('1', 'x'));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('fires the listener after persistence (file already has the message)', () => {
      // Guarantee: a subscriber observing a push can synchronously trust that
      // chatCache.getMessages() will include the message.
      const dir = trackTmpDir(makeTmpDir());
      const history = new MessageHistory(join(dir, 'history.json'));
      let observedCount = -1;
      history.subscribe(() => {
        observedCount = history.getMessages().length;
      });
      history.push(makeMessage('1', 'x'));
      expect(observedCount).toBe(1);
    });
  });
});
