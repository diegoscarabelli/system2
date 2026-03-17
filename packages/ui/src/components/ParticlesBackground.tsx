import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { colors } from '../theme/colors';
import { useAccentColors } from '../theme/useAccentColors';
import { MinSpeedUpdater } from './MinSpeedUpdater';

export const ParticlesBackground = memo(function ParticlesBackground() {
  const [engineReady, setEngineReady] = useState(false);
  const { accent } = useAccentColors();

  useEffect(() => {
    let cancelled = false;
    initParticlesEngine(async (engine) => {
      await loadSlim(engine);
      await engine.addParticleUpdater('minSpeed', async () => new MinSpeedUpdater());
    }).then(() => {
      if (!cancelled) setEngineReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // canvas.windowResize() is called by the tsparticles window resize event listener.
  // The default implementation resizes the canvas then calls container.refresh(),
  // which destroys and recreates all particles. Override it to resize-only so
  // particles continue uninterrupted when the container changes dimensions.
  //
  // Also resume animation on tab focus: browsers throttle/freeze rAF in hidden tabs,
  // and tsparticles may not auto-resume when the tab becomes visible again.
  const particlesLoaded = useCallback(async (container?: Container) => {
    if (!container) return;
    container.canvas.windowResize = async () => {
      container.canvas.resize();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) container.play();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    container.canvas.element?.addEventListener('remove', () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }, []);

  const options = useMemo(
    () => ({
      fpsLimit: 60,
      pauseOnOutsideViewport: true,
      particles: {
        number: { value: 120, density: { enable: true } },
        color: { value: [accent, colors.teal] },
        opacity: { value: 0.35 },
        size: { value: { min: 1, max: 3 } },
        links: {
          enable: true,
          color: { value: [accent, colors.teal] },
          opacity: 0.2,
          distance: 150,
          width: 1,
        },
        collisions: {
          enable: true,
          mode: 'bounce' as const,
          maxSpeed: 2,
        },
        move: {
          enable: true,
          speed: 0.8,
          outModes: { default: 'bounce' as const },
        },
      },
      interactivity: {
        events: {
          onHover: { enable: true, mode: 'attract' as const },
        },
        modes: {
          attract: { distance: 200, duration: 0.4, speed: 3, maxSpeed: 2 },
        },
      },
    }),
    [accent]
  );

  if (!engineReady) return null;

  return (
    <Particles
      id="tsparticles"
      style={{ position: 'absolute', inset: 0, zIndex: 0 }}
      options={options}
      particlesLoaded={particlesLoaded}
    />
  );
});
