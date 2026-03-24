/**
 * Message History
 *
 * Server-side ring buffer of recent chat messages displayed in the UI.
 * Persists to a JSON file so history survives server restarts.
 * The server is the single source of truth — the UI does not cache messages.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '@dscarabelli/shared';

export class MessageHistory {
  private messages: ChatMessage[] = [];
  private filePath: string;
  private maxMessages: number;

  constructor(filePath: string, maxMessages = 100) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
    this.load();
  }

  /** Get all messages (defensive copy). */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Add a message and persist. */
  push(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
    this.save();
  }

  /** Load history from disk. */
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.messages = parsed.slice(-this.maxMessages);
        }
      }
    } catch {
      // Corrupted file — start fresh
      this.messages = [];
    }
  }

  /** Persist history to disk. */
  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.messages));
  }
}
