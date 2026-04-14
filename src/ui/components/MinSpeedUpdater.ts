import type { IParticleUpdater, Particle } from '@tsparticles/engine';

export const MIN_SPEED = 0.5;

export class MinSpeedUpdater implements IParticleUpdater {
  init(_particle: Particle) {}

  isEnabled(_particle: Particle) {
    return true;
  }

  update(particle: Particle) {
    const speed = particle.velocity.length;
    if (speed === 0) {
      const angle = Math.random() * Math.PI * 2;
      particle.velocity.x = Math.cos(angle) * MIN_SPEED;
      particle.velocity.y = Math.sin(angle) * MIN_SPEED;
    } else if (speed < MIN_SPEED) {
      particle.velocity.length = MIN_SPEED;
    }
  }
}
