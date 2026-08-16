import type { VisualizerPlugin } from "./types";
import { amplitude, frequencyAverage, frequencyValue, seeded, title } from "./utils";

const chromaticCathedral: VisualizerPlugin = {
  id: "chromatic-cathedral",
  label: "Chromatic Cathedral",
  fftSize: 8192,
  smoothing: 0.82,
  render(frame) {
    const { context, width, height, time } = frame;
    context.fillStyle = "rgb(2 5 13 / 48%)";
    context.fillRect(0, 0, width, height);
    const columns = Math.max(28, Math.min(72, Math.floor(width / 16)));
    const floor = height * 0.86;
    const maxHeight = height * 0.64;
    const slot = width / columns;
    for (let index = 0; index < columns; index += 1) {
      const progress = index / Math.max(1, columns - 1);
      const value = frequencyValue(frame, Math.pow(Math.abs(progress - 0.5) * 2, 1.12));
      const columnHeight = 12 + Math.pow(value, 1.55) * maxHeight;
      const hue = (progress * 260 + time * 0.025) % 360;
      const x = index * slot;
      const gradient = context.createLinearGradient(0, floor - columnHeight, 0, floor);
      gradient.addColorStop(0, `hsl(${hue} 100% 82% / 92%)`);
      gradient.addColorStop(0.35, `hsl(${hue} 100% 58% / 72%)`);
      gradient.addColorStop(1, `hsl(${(hue + 50) % 360} 100% 38% / 8%)`);
      context.fillStyle = gradient;
      context.fillRect(x + slot * 0.16, floor - columnHeight, slot * 0.68, columnHeight);
      context.fillStyle = `hsl(${hue} 100% 72% / ${0.12 + value * 0.42})`;
      context.fillRect(x + slot * 0.04, floor + 3, slot * 0.92, columnHeight * 0.22);
    }
    context.strokeStyle = "rgb(120 206 255 / 16%)";
    context.lineWidth = 1;
    for (let line = 0; line < 10; line += 1) {
      const y = floor + Math.pow(line / 9, 1.8) * (height - floor);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    title(frame, "CHROMATIC CATHEDRAL");
  }
};

const quantumRibbon: VisualizerPlugin = {
  id: "quantum-ribbon",
  label: "Quantum Ribbon",
  fftSize: 4096,
  smoothing: 0.88,
  render(frame) {
    const { context, width, height, frequency, waveform, time } = frame;
    const energy = amplitude(frequency);
    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#020b16");
    background.addColorStop(0.5, "#08021b");
    background.addColorStop(1, "#00140f");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    const points = Math.min(240, waveform.length);
    context.globalCompositeOperation = "lighter";
    for (let ribbon = 0; ribbon < 9; ribbon += 1) {
      context.beginPath();
      for (let index = 0; index < points; index += 1) {
        const progress = index / Math.max(1, points - 1);
        const sampleIndex = Math.floor(progress * (waveform.length - 1));
        const wave = ((waveform[sampleIndex] ?? 128) - 128) / 128;
        const frequencyLift = frequencyValue(frame, progress) * height * 0.09;
        const phase = time * 0.0012 + progress * 8 + ribbon * 0.72;
        const x = progress * width;
        const y = height * 0.5 + wave * height * (0.08 + energy * 0.18) + Math.sin(phase) * frequencyLift + (ribbon - 4) * 5;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      const hue = (time * 0.03 + ribbon * 37) % 360;
      context.strokeStyle = `hsl(${hue} 100% 68% / ${0.18 + energy * 0.34})`;
      context.lineWidth = 0.8 + (8 - ribbon) * 0.16;
      context.shadowColor = `hsl(${hue} 100% 62%)`;
      context.shadowBlur = 10 + energy * 22;
      context.stroke();
    }
    context.shadowBlur = 0;
    context.globalCompositeOperation = "source-over";
    title(frame, "QUANTUM RIBBON");
  }
};

const neonMetropolis: VisualizerPlugin = {
  id: "neon-metropolis",
  label: "Neon Metropolis",
  fftSize: 8192,
  smoothing: 0.8,
  render(frame) {
    const { context, width, height, time } = frame;
    const energy = frequencyAverage(frame);
    const horizon = height * 0.58;
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#030016");
    sky.addColorStop(0.55, "#12002b");
    sky.addColorStop(1, "#02040b");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);
    const sunRadius = Math.min(width, height) * (0.095 + energy * 0.018);
    const sun = context.createRadialGradient(width / 2, horizon * 0.56, 0, width / 2, horizon * 0.56, sunRadius * 1.7);
    sun.addColorStop(0, "rgb(255 242 175 / 95%)");
    sun.addColorStop(0.38, "rgb(255 72 190 / 78%)");
    sun.addColorStop(1, "rgb(108 0 255 / 0%)");
    context.fillStyle = sun;
    context.beginPath();
    context.arc(width / 2, horizon * 0.56, sunRadius * 1.7, 0, Math.PI * 2);
    context.fill();
    context.save();
    context.beginPath();
    context.rect(0, horizon, width, height - horizon);
    context.clip();
    context.strokeStyle = `rgb(52 205 255 / ${0.13 + energy * 0.22})`;
    context.lineWidth = 1;
    for (let lane = -11; lane <= 11; lane += 1) {
      context.beginPath();
      context.moveTo(width / 2, horizon);
      context.lineTo(width / 2 + lane * width * 0.12, height);
      context.stroke();
    }
    const travel = (time * 0.00016) % 1;
    for (let line = 0; line < 18; line += 1) {
      const depth = (line / 18 + travel) % 1;
      const y = horizon + Math.pow(depth, 2.15) * (height - horizon);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.restore();
    const buildings = Math.max(38, Math.min(96, Math.floor(width / 12)));
    const slot = width / buildings;
    for (let index = 0; index < buildings; index += 1) {
      const progress = index / Math.max(1, buildings - 1);
      const band = frequencyValue(frame, Math.abs(progress - 0.5) * 2);
      const buildingHeight = height * (0.08 + Math.pow(band, 1.25) * 0.42 + seeded(index, 22) * 0.07);
      const x = index * slot;
      const hue = (188 + progress * 150 + time * 0.018) % 360;
      const gradient = context.createLinearGradient(0, horizon - buildingHeight, 0, horizon);
      gradient.addColorStop(0, `hsl(${hue} 100% 68% / ${0.58 + band * 0.35})`);
      gradient.addColorStop(0.08, `hsl(${hue} 95% 20% / 94%)`);
      gradient.addColorStop(1, "rgb(1 4 12 / 98%)");
      context.fillStyle = gradient;
      context.fillRect(x + 1, horizon - buildingHeight, Math.max(2, slot - 2), buildingHeight);
      if (band > 0.18) {
        context.fillStyle = `hsl(${hue + 45} 100% 76% / ${0.28 + band * 0.52})`;
        const windows = Math.max(1, Math.floor(buildingHeight / 14));
        for (let row = 1; row < windows; row += 2) context.fillRect(x + slot * 0.3, horizon - row * 12, Math.max(1, slot * 0.28), 2);
      }
    }
    context.fillStyle = `rgb(255 58 205 / ${0.08 + energy * 0.18})`;
    context.fillRect(0, horizon, width, Math.max(1, energy * 5));
    title(frame, "NEON METROPOLIS");
  }
};

const milkdropPulse: VisualizerPlugin = {
  id: "milkdrop-pulse",
  label: "MilkDrop Pulse",
  fftSize: 8192,
  smoothing: 0.82,
  render(frame) {
    const { context, width, height, waveform, time } = frame;
    const energy = frequencyAverage(frame);
    const bass = frequencyAverage(frame, 35, 180);
    const centerX = width / 2;
    const centerY = height / 2;
    const base = Math.min(width, height);
    context.fillStyle = "rgb(2 0 14 / 24%)";
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(centerX, centerY);
    context.rotate(time * 0.000045);
    context.globalCompositeOperation = "lighter";
    for (let mirror = 0; mirror < 10; mirror += 1) {
      context.save();
      context.rotate(mirror / 10 * Math.PI * 2);
      if (mirror % 2) context.scale(1, -1);
      context.beginPath();
      const points = 180;
      for (let index = 0; index <= points; index += 1) {
        const progress = index / points;
        const sample = Math.abs(((waveform[Math.floor(progress * (waveform.length - 1))] ?? 128) - 128) / 128);
        const band = frequencyValue(frame, progress);
        const angle = progress * Math.PI * 0.82 - Math.PI * 0.41;
        const radius = base * (0.1 + progress * 0.35 + sample * 0.075 + band * 0.045);
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * (0.42 + bass * 0.14);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      const hue = (time * 0.035 + mirror * 31) % 360;
      context.strokeStyle = `hsl(${hue} 100% 67% / ${0.12 + energy * 0.32})`;
      context.lineWidth = 0.7 + energy * 2.2;
      context.shadowColor = `hsl(${hue} 100% 60%)`;
      context.shadowBlur = 7 + bass * 20;
      context.stroke();
      context.restore();
    }
    for (let ring = 0; ring < 9; ring += 1) {
      const band = frequencyValue(frame, ring / 8);
      const radius = base * (0.035 + ring * 0.031 + band * 0.035);
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.strokeStyle = `hsl(${(time * 0.025 + ring * 43) % 360} 100% 70% / ${0.1 + band * 0.38})`;
      context.lineWidth = 0.7 + band * 2.4;
      context.stroke();
    }
    context.restore();
    title(frame, "MILKDROP PULSE");
  }
};

export const showcaseVisualizers: VisualizerPlugin[] = [chromaticCathedral, quantumRibbon, milkdropPulse, neonMetropolis];
