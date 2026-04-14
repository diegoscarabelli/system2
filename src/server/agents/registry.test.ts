import { describe, expect, it } from 'vitest';
import type { AgentHost } from './host.js';
import { AgentRegistry } from './registry.js';

const stub = {} as unknown as AgentHost;

describe('AgentRegistry', () => {
  it('registers and retrieves agents', () => {
    const registry = new AgentRegistry();
    registry.register(1, stub);
    expect(registry.get(1)).toBe(stub);
  });

  it('returns undefined for unregistered agents', () => {
    const registry = new AgentRegistry();
    expect(registry.get(999)).toBeUndefined();
  });

  it('checks if agent is registered', () => {
    const registry = new AgentRegistry();
    registry.register(1, stub);
    expect(registry.has(1)).toBe(true);
    expect(registry.has(2)).toBe(false);
  });

  it('unregisters agents', () => {
    const registry = new AgentRegistry();
    registry.register(1, stub);
    registry.unregister(1);
    expect(registry.has(1)).toBe(false);
    expect(registry.get(1)).toBeUndefined();
  });

  it('lists all registered agent IDs', () => {
    const registry = new AgentRegistry();
    const s1 = {} as unknown as AgentHost;
    const s2 = {} as unknown as AgentHost;
    const s3 = {} as unknown as AgentHost;
    registry.register(1, s1);
    registry.register(5, s2);
    registry.register(3, s3);
    expect(registry.listIds()).toEqual([1, 5, 3]);
  });

  it('overwrites agent on re-register', () => {
    const registry = new AgentRegistry();
    const host1 = {} as unknown as AgentHost;
    const host2 = {} as unknown as AgentHost;
    registry.register(1, host1);
    registry.register(1, host2);
    expect(registry.get(1)).toBe(host2);
    expect(registry.listIds()).toEqual([1]);
  });
});
