import type { VisualizerPlugin } from "./types";
import { clear, frequencyAverage, frequencyValue, hsla, title } from "./utils";

interface RadialOptions { id: string; label: string; hue: number; rings?: number; orbit?: boolean; warp?: boolean }

function radial(options: RadialOptions): VisualizerPlugin {
  return {
    id: options.id,
    label: options.label,
    fftSize: 4096,
    smoothing: 0.87,
    render(frame) {
      const { context, width, height, waveform, time } = frame;
      clear(frame, `hsl(${options.hue} 62% 12%)`);
      const centerX = width / 2;
      const centerY = height / 2;
      const base = Math.min(width, height) * (options.orbit ? 0.12 : 0.21);
      const volume = frequencyAverage(frame);
      const ringCount = options.rings ?? (options.orbit ? 3 : 1);
      context.save();
      context.shadowColor = hsla(options.hue + time / 110, 0.75, 64);
      context.shadowBlur = options.orbit ? 12 + volume * 18 : options.warp ? 8 + volume * 14 : 0;
      for (let ring = 0; ring < ringCount; ring += 1) {
        const radius = base * (1 + ring * (options.orbit ? 0.85 : 0.22));
        const points = options.warp ? 180 : 128;
        context.beginPath();
        for (let index = 0; index <= points; index += 1) {
          const progress = index / points;
          const value = options.warp
            ? Math.abs((waveform[Math.floor(progress * (waveform.length - 1))] ?? 128) - 128) / 128
            : frequencyValue(frame, progress);
          const angle = progress * Math.PI * 2 + (options.orbit ? time / (2100 + ring * 420) : 0);
          const pulse = radius + value * base * (0.28 + ring * 0.08) + (options.warp ? Math.sin(angle * 8 + time / 260) * base * 0.08 : 0);
          const x = centerX + Math.cos(angle) * pulse;
          const y = centerY + Math.sin(angle) * pulse;
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath();
        context.lineWidth = options.orbit ? 1.2 + volume * 2 : 2 + volume * 3;
        context.strokeStyle = hsla(options.hue + ring * 94 + time / 90, 0.6 + volume * 0.35, 64);
        context.stroke();
      }
      context.restore();
      if (options.orbit) {
        context.save();
        context.globalCompositeOperation = "lighter";
        for (let satellite = 0; satellite < 18; satellite += 1) {
          const band = frequencyValue(frame, satellite / 17);
          const ring = satellite % ringCount;
          const orbitRadius = base * (1 + ring * 0.85);
          const angle = time / (1250 + ring * 390) + satellite / 18 * Math.PI * 2;
          const radius = Math.max(1.5, base * (0.025 + band * 0.085));
          const x = centerX + Math.cos(angle) * orbitRadius;
          const y = centerY + Math.sin(angle) * orbitRadius;
          const glow = context.createRadialGradient(x, y, 0, x, y, radius * 3.2);
          glow.addColorStop(0, hsla(options.hue + satellite * 19, 0.9, 82));
          glow.addColorStop(1, hsla(options.hue + satellite * 19, 0, 55));
          context.fillStyle = glow;
          context.beginPath();
          context.arc(x, y, radius * 3.2, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }
      const glow = base * (0.16 + volume * 0.38);
      const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, glow * 2.4);
      gradient.addColorStop(0, hsla(options.hue + 34, 0.9, 88));
      gradient.addColorStop(1, hsla(options.hue, 0, 55));
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(centerX, centerY, glow * 2.4, 0, Math.PI * 2);
      context.fill();
      title(frame, options.label);
    }
  };
}

const orbitAnalyzer: VisualizerPlugin = {
  id: "orbit-analyzer",
  label: "Orbit Analyzer",
  fftSize: 2048,
  smoothing: 0.85,
  render(frame) {
    const { context, width, height, time } = frame;
    const centerX = width / 2;
    const centerY = height / 2;
    const size = Math.min(width, height);
    const background = context.createRadialGradient(centerX, centerY * 0.72, 0, centerX, centerY, Math.max(width, height) * 0.72);
    background.addColorStop(0, "#102d55");
    background.addColorStop(0.48, "#06172f");
    background.addColorStop(1, "#01050d");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    for (let star = 0; star < Math.min(130, Math.floor(width / 10)); star += 1) {
      const x = (Math.sin(star * 127.1) * 43758.5453 % 1 + 1) % 1 * width;
      const y = (Math.sin(star * 311.7) * 24634.6345 % 1 + 1) % 1 * height;
      const alpha = 0.18 + ((star * 37) % 61) / 100;
      context.fillStyle = `rgb(190 225 255 / ${alpha})`;
      context.fillRect(x, y, star % 9 === 0 ? 1.5 : 0.8, star % 9 === 0 ? 1.5 : 0.8);
    }
    const bands = [
      { label: "BASS", min: 35, max: 250, hue: 192, radius: 0.14, points: 10 },
      { label: "MID", min: 250, max: 2000, hue: 218, radius: 0.27, points: 18 },
      { label: "TREBLE", min: 2000, max: 16000, hue: 274, radius: 0.4, points: 22 }
    ];
    const overall = frequencyAverage(frame, 35, 16000);
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
      const band = bands[bandIndex]!;
      const baseRadius = size * band.radius;
      context.beginPath();
      context.ellipse(centerX, centerY, baseRadius, baseRadius * 0.74, -0.16 + bandIndex * 0.14, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${band.hue}, 88%, 70%, 0.28)`;
      context.lineWidth = 1;
      context.stroke();
      const rotation = time / (1700 + bandIndex * 470) * (bandIndex % 2 === 0 ? 1 : -1);
      for (let point = 0; point < band.points; point += 1) {
        const progress = point / Math.max(1, band.points - 1);
        const value = frequencyValue(frame, progress, band.min, band.max);
        const angle = point / band.points * Math.PI * 2 + rotation;
        const pulse = baseRadius * (1 + value * 0.18) + Math.sin(time / 210 + point) * value * size * 0.009;
        const tilt = -0.16 + bandIndex * 0.14;
        const localX = Math.cos(angle) * pulse;
        const localY = Math.sin(angle) * pulse * 0.74;
        const x = centerX + localX * Math.cos(tilt) - localY * Math.sin(tilt);
        const y = centerY + localX * Math.sin(tilt) + localY * Math.cos(tilt);
        if (value > 0.08) {
          context.beginPath();
          context.moveTo(centerX, centerY);
          context.lineTo(x, y);
          context.strokeStyle = `hsla(${band.hue + value * 24}, 95%, 70%, ${0.04 + value * 0.26})`;
          context.stroke();
        }
        const radius = Math.max(1.4, size * (0.002 + value * 0.009));
        context.shadowColor = `hsl(${band.hue} 100% 70%)`;
        context.shadowBlur = 3 + value * 9;
        context.fillStyle = `hsl(${band.hue + value * 24} 96% ${58 + value * 25}%)`;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
      }
      context.font = "600 9px system-ui, sans-serif";
      context.textAlign = "center";
      context.fillStyle = `hsla(${band.hue}, 90%, 78%, 0.74)`;
      context.fillText(band.label, centerX, centerY + baseRadius * 0.76 + 13);
    }
    const centerRadius = size * (0.025 + overall * 0.055);
    const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, centerRadius * 3);
    core.addColorStop(0, "rgb(232 250 255 / 96%)");
    core.addColorStop(0.3, "rgb(74 190 255 / 75%)");
    core.addColorStop(1, "rgb(20 90 255 / 0%)");
    context.fillStyle = core;
    context.beginPath();
    context.arc(centerX, centerY, centerRadius * 3, 0, Math.PI * 2);
    context.fill();
    title(frame, "Orbit Analyzer");
  }
};

export const radialVisualizers: VisualizerPlugin[] = [
  orbitAnalyzer,
  radial({ id: "ring-warp", label: "Ring Warp", hue: 226, rings: 4, warp: true })
];
