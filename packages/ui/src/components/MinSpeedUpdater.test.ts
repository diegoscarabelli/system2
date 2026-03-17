import type { Particle } from '@tsparticles/engine';
import { describe, expect, it } from 'vitest';
import { MIN_SPEED, MinSpeedUpdater } from './MinSpeedUpdater';

interface MockVelocity {
  x: number;
  y: number;
  length: number;
}

function mockParticle(vx: number, vy: number) {
  const velocity: MockVelocity = {
    x: vx,
    y: vy,
    get length() {
      return Math.sqrt(this.x ** 2 + this.y ** 2);
    },
    set length(len: number) {
      const angle = Math.atan2(this.y, this.x);
      this.x = Math.cos(angle) * len;
      this.y = Math.sin(angle) * len;
    },
  };
  return { velocity };
}

describe('MinSpeedUpdater', () => {
  const updater = new MinSpeedUpdater();

  it('preserves speed at or above minimum', () => {
    const p = mockParticle(0.8, 0);
    updater.update(p as unknown as Particle);
    expect(p.velocity.length).toBeCloseTo(0.8);
  });

  it('boosts speed below minimum while preserving direction', () => {
    const p = mockParticle(0.1, 0);
    updater.update(p as unknown as Particle);
    expect(p.velocity.length).toBeCloseTo(MIN_SPEED);
    expect(p.velocity.x).toBeGreaterThan(0);
    expect(p.velocity.y).toBeCloseTo(0);
  });

  it('boosts diagonal velocity while preserving direction', () => {
    const p = mockParticle(0.05, 0.05);
    const angleBefore = Math.atan2(p.velocity.y, p.velocity.x);
    updater.update(p as unknown as Particle);
    const angleAfter = Math.atan2(p.velocity.y, p.velocity.x);
    expect(p.velocity.length).toBeCloseTo(MIN_SPEED);
    expect(angleAfter).toBeCloseTo(angleBefore);
  });

  it('assigns random direction when velocity is exactly zero', () => {
    const p = mockParticle(0, 0);
    updater.update(p as unknown as Particle);
    expect(p.velocity.length).toBeCloseTo(MIN_SPEED);
  });

  it('does not cap speed above minimum', () => {
    const p = mockParticle(2, 0);
    updater.update(p as unknown as Particle);
    expect(p.velocity.length).toBeCloseTo(2);
  });

  it('is always enabled', () => {
    const p = mockParticle(0, 0);
    expect(updater.isEnabled(p as unknown as Particle)).toBe(true);
  });
});
