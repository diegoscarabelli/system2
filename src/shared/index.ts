/**
 * System2 Shared Module
 *
 * Type definitions and runtime utilities shared across all System2 packages
 * (CLI, server, UI). Most exports here are types; agent-models.js is the
 * runtime exception (validation against pi-ai's catalog, used by both the
 * CLI's config-loader and the server's AgentHost).
 */

export * from './agent-models.js';
export * from './types/chat.js';
export * from './types/config.js';
export * from './types/database.js';
export * from './types/messages.js';
