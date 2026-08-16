import type { VisualizerPlugin } from "./types";
import { clear, frequencyAverage, frequencyValue, hsla, seeded, title } from "./utils";

interface SpectrumOptions {
  id: string;
  label: string;
  hue: number;
  mirror?: boolean;
  snow?: number;
  particles?: boolean;
  glitch?: boolean;
}

interface Particle {
  x: number; y: number; z: number; speed: number; zSpeed: number; size: number; drift: number;
  snowflake: boolean; rotation: number; rotationSpeed: number; alpha: number;
}

function spectrum(options: SpectrumOptions): VisualizerPlugin {
  let particles: Particle[] = [];
  const ensureParticles = (count: number, width: number, height: number): void => {
    if (particles.length === count) return;
    particles = Array.from({ length: count }, (_, index) => ({
      x: seeded(index, 2) * width,
      y: seeded(index, 3) * height,
      z: 0.34 + seeded(index, 9) * 2.7,
      speed: 78 + seeded(index, 4) * 166,
      zSpeed: 0.2 + seeded(index, 12) * 0.39,
      size: seeded(index, 7) > 0.965 ? 13 + seeded(index, 5) * 13 : 0.8 + seeded(index, 5) * 2.45,
      drift: (seeded(index, 6) * 2 - 1) * 0.4,
      snowflake: seeded(index, 7) > 0.965,
      rotation: seeded(index, 8) * Math.PI * 2,
      rotationSpeed: (seeded(index, 10) - 0.5) * 0.9,
      alpha: 0.18 + seeded(index, 11) * 0.68
    }));
  };
  const updateSnow = (particle: Particle, frame: Parameters<VisualizerPlugin["render"]>[0], bass: number): void => {
    const elapsed = Math.min(0.04, frame.delta / 1000);
    if (particle.snowflake) particle.z -= elapsed * particle.zSpeed * (0.92 + bass * 0.12);
    const perspective = 1 / Math.max(0.08, particle.z);
    particle.y += particle.speed * elapsed * (particle.snowflake ? Math.min(3.1, perspective) : 1) * (0.94 + bass * 0.12);
    particle.x += Math.sin(particle.rotation) * particle.drift * (particle.snowflake ? perspective : 1);
    particle.rotation += particle.rotationSpeed * elapsed;
    if (particle.z <= 0.04 || particle.y > frame.height + 260 || particle.x < -260 || particle.x > frame.width + 260) {
      particle.z = particle.snowflake ? 1.5 + Math.random() * 2.5 : 0.55 + Math.random() * 2.4;
      particle.x = Math.random() * frame.width;
      particle.y = -20 - Math.random() * frame.height * 0.22;
    }
  };
  const drawSnow = (particle: Particle, frame: Parameters<VisualizerPlugin["render"]>[0], foreground: boolean): void => {
    const { context } = frame;
    const scale = 1 / Math.max(0.08, particle.z);
    if ((scale >= 0.92) !== foreground) return;
    const size = particle.snowflake ? particle.size * scale : particle.size * Math.max(0.45, scale);
    let alpha = Math.min(0.96, particle.alpha * (0.45 + scale * 0.58));
    if (particle.z < 0.36) alpha *= Math.max(0, particle.z / 0.36);
    if (alpha <= 0.01) return;
    const x = particle.x;
    const y = particle.y;
    context.save();
    context.translate(x, y);
    context.rotate(particle.rotation);
    context.globalAlpha = alpha;
    context.strokeStyle = "#e8f7ff";
    context.fillStyle = "#e8f7ff";
    context.lineWidth = Math.max(0.65, size * 0.12);
    context.shadowColor = "rgb(174 224 255 / 70%)";
    context.shadowBlur = foreground ? Math.min(22, size * 0.28) : Math.min(5, size * 0.16);
    if (particle.snowflake && size > 3) {
      context.font = `900 ${size * 1.7}px "Font Awesome 7 Free", "Font Awesome 6 Free"`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("\uf2dc", 0, 0);
    } else {
      context.beginPath();
      context.arc(0, 0, Math.max(0.68, size * 0.25), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  };
  return {
    id: options.id,
    label: options.label,
    fftSize: options.particles ? 4096 : 2048,
    smoothing: 0.84,
    reset: () => { particles = []; },
    render(frame) {
      clear(frame, `hsl(${options.hue} 58% 14%)`);
      const { context, width, height, time } = frame;
      const count = Math.max(36, Math.min(128, Math.floor(width / 11)));
      const gap = Math.max(1.5, width / count * 0.14);
      const barWidth = width / count - gap;
      const bass = frequencyAverage(frame, 35, 180);
      if (options.snow) {
        ensureParticles(options.snow, width, height);
        for (const particle of particles) updateSnow(particle, frame, bass);
        [...particles].sort((a, b) => b.z - a.z).forEach((particle) => drawSnow(particle, frame, false));
      }
      for (let index = 0; index < count; index += 1) {
        const progress = index / Math.max(1, count - 1);
        const sourceProgress = options.mirror ? Math.abs(progress - 0.5) * 2 : progress;
        const value = frequencyValue(frame, sourceProgress);
        const barHeight = Math.max(2, value * height * (options.mirror ? 0.72 : 0.84));
        const x = index * (barWidth + gap) + gap / 2;
        const hue = options.hue + progress * 82 + (options.glitch ? Math.sin(time / 90 + index) * 24 : 0);
        context.fillStyle = hsla(hue, 0.5 + value * 0.5, 55 + value * 18);
        if (options.glitch && value > 0.62 && (index + Math.floor(time / 70)) % 7 === 0) {
          context.fillRect(x + Math.sin(time / 18 + index) * 9, height - barHeight, barWidth, barHeight);
        } else if (options.particles) {
          const dots = Math.max(1, Math.round(barHeight / 13));
          for (let dot = 0; dot < dots; dot += 1) {
            const radius = Math.max(1.2, barWidth * 0.34);
            context.beginPath();
            context.arc(x + barWidth / 2, height - dot * 13 - radius, radius, 0, Math.PI * 2);
            context.fill();
          }
        } else {
          context.fillRect(x, height - barHeight, barWidth, barHeight);
        }
      }
      if (options.snow) {
        [...particles].sort((a, b) => b.z - a.z).forEach((particle) => drawSnow(particle, frame, true));
      }
      title(frame, options.label);
    }
  };
}

export const spectrumVisualizers: VisualizerPlugin[] = [
  spectrum({ id: "snow-spectrum", label: "Snow Spectrum", hue: 202, mirror: true, snow: 430 }),
  spectrum({ id: "particle-spectrum", label: "Particle Spectrum", hue: 276, particles: true }),
  spectrum({ id: "glitch-spectrum", label: "Glitch Spectrum", hue: 326, glitch: true })
];
