/**
 * Message History
 *
 * Server-side ring buffer of recent chat messages displayed in the UI.
 * Persists to a JSON file so history survives server restarts.
 * The server is the single source of truth — the UI mirrors this store.
 *
 * Observable: subscribers are notified on every push. WebSocketHandler uses
 * this to broadcast new messages live, so a freshly-pushed system/user/
 * assistant message reaches connected clients without waiting for a reload.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '../../shared/index.js';
import { log } from '../utils/logger.js';

export type MessageHistoryListener = (message: ChatMessage) => void;

export class MessageHistory {
  private messages: ChatMessage[] = [];
  private filePath: string;
  private maxMessages: number;
  private listeners: Set<MessageHistoryListener> = new Set();

  constructor(filePath: string, maxMessages = 100) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
    this.load();
  }

  /** Get all messages (defensive copy). */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Add a message, persist, and notify subscribers. */
  push(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
    this.save();
    // Per-listener try/catch so a throwing subscriber (e.g. a WebSocket send
    // racing a closed socket) cannot break persistence, prevent later
    // subscribers from running, or bubble up into the caller. The message is
    // already in memory + on disk by this point, so we just log and continue.
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        log.error('[MessageHistory] subscriber threw:', err);
      }
    }
  }

  /** Subscribe to push events. Returns an unsubscribe function. */
  subscribe(listener: MessageHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
