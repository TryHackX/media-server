import type { VisualizerFrame, VisualizerPlugin } from "./types";
import { amplitude, frequencyValue, title } from "./utils";

/**
 * Visualisers in the spirit of the old Winamp plugins — GEISS, MilkDrop and the
 * Butterchurn presets that followed them.
 *
 * They share one trick those plugins were built on: the previous frame is not
 * thrown away but redrawn slightly transformed, so every shape leaves a wake
 * that spirals into the distance. The wake is produced by transforming a copy of
 * the last frame rather than by stroking tails, which is why it stays smooth
 * instead of laying down hard lines.
 */

interface Feedback {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/** Holds the previous frame at layout resolution for the feedback effects. */
function createFeedback(): {
  surface(width: number, height: number): Feedback | null;
  store(frame: VisualizerFrame): void;
  clear(): void;
} {
  let buffer: Feedback | null = null;
  return {
    surface(width, height) {
      if (!buffer) {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return null;
        buffer = { canvas, context };
      }
      if (buffer.canvas.width !== width || buffer.canvas.height !== height) {
        buffer.canvas.width = width;
        buffer.canvas.height = height;
      }
      return buffer;
    },
    store(frame) {
      const surface = this.surface(Math.max(1, frame.width), Math.max(1, frame.height));
      if (!surface) return;
      surface.context.setTransform(1, 0, 0, 1, 0, 0);
      surface.context.globalCompositeOperation = "copy";
      surface.context.drawImage(frame.canvas, 0, 0, surface.canvas.width, surface.canvas.height);
      surface.context.globalCompositeOperation = "source-over";
    },
    clear() {
      buffer = null;
    }
  };
}

function bands(frame: VisualizerFrame): { bass: number; middle: number; high: number; overall: number } {
  const quarter = frame.frequency.length / 4;
  const bass = amplitude(frame.frequency, 0, quarter);
  const middle = amplitude(frame.frequency, quarter, quarter * 3);
  const high = amplitude(frame.frequency, quarter * 3);
  return { bass, middle, high, overall: (bass + middle + high) / 3 };
}

/* ── 1. Warp Tunnel — the MilkDrop feedback loop ──────────────────────────── */

function createWarpTunnel(): VisualizerPlugin {
  const feedback = createFeedback();
  return {
    id: "warp-tunnel",
    label: "Warp Tunnel",
    fftSize: 2048,
    smoothing: 0.78,
    reset: () => feedback.clear(),
    render(frame) {
      const { context, width, height, time, waveform } = frame;
      const { bass, middle, high, overall } = bands(frame);
      const surface = feedback.surface(Math.max(1, width), Math.max(1, height));
      const seconds = time * 0.001;

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#03040a";
      context.fillRect(0, 0, width, height);

      if (surface && surface.canvas.width > 1) {
        // Each frame is redrawn a little larger and a little rotated, so the
        // rings already on screen march outward and become the tunnel walls.
        const zoom = 1.014 + bass * 0.03;
        const spin = (0.0016 + high * 0.006) * Math.sin(seconds * 0.21);
        context.save();
        context.translate(width / 2, height / 2);
        context.rotate(spin);
        context.scale(zoom, zoom);
        // Anything above roughly 0.9 lets the additive ring compound through the
        // loop until the tunnel walls clip to flat white.
        context.globalAlpha = 0.9;
        context.drawImage(surface.canvas, -width / 2, -height / 2, width, height);
        context.restore();
        context.globalAlpha = 1;
      }

      const radius = Math.min(width, height) * (0.17 + bass * 0.1);
      const points = 168;
      const hue = (seconds * 26 + middle * 120) % 360;
      context.globalCompositeOperation = "lighter";
      context.beginPath();
      for (let index = 0; index <= points; index += 1) {
        const angle = index / points * Math.PI * 2;
        const sample = (waveform[Math.floor(index / points * (waveform.length - 1))] ?? 128) / 128 - 1;
        const wobble = Math.sin(angle * 5 + seconds * 1.7) * (0.05 + middle * 0.12);
        const distance = radius * (1 + sample * (0.55 + bass * 0.7) + wobble);
        const x = width / 2 + Math.cos(angle) * distance;
        const y = height / 2 + Math.sin(angle) * distance;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.lineWidth = 1.6 + overall * 2.6;
      context.strokeStyle = `hsla(${hue}, 100%, ${52 + high * 18}%, 0.6)`;
      context.shadowBlur = 10 + overall * 16;
      context.shadowColor = `hsla(${(hue + 40) % 360}, 100%, 58%, 0.6)`;
      context.stroke();
      context.shadowBlur = 0;

      const core = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, radius * 1.4);
      core.addColorStop(0, `hsla(${(hue + 180) % 360}, 100%, 74%, ${0.09 + bass * 0.2})`);
      core.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = core;
      context.beginPath();
      context.arc(width / 2, height / 2, radius * 1.4, 0, Math.PI * 2);
      context.fill();

      context.globalCompositeOperation = "source-over";
      feedback.store(frame);
      title(frame, "Warp Tunnel");
    }
  };
}

/* ── 2. Spectral Kaleidoscope — a mirrored mandala ────────────────────────── */

function createKaleidoscope(): VisualizerPlugin {
  return {
    id: "kaleidoscope",
    label: "Spectral Kaleidoscope",
    fftSize: 4096,
    smoothing: 0.8,
    render(frame) {
      const { context, width, height, time } = frame;
      const { bass, middle, high, overall } = bands(frame);
      const seconds = time * 0.001;
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      const backdrop = context.createRadialGradient(
        width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7
      );
      backdrop.addColorStop(0, `hsl(${(seconds * 12) % 360} 55% ${6 + bass * 7}%)`);
      backdrop.addColorStop(1, "#02030a");
      context.fillStyle = backdrop;
      context.fillRect(0, 0, width, height);

      const wedges = 10;
      const reach = Math.min(width, height) * 0.46;
      context.save();
      context.translate(width / 2, height / 2);
      context.rotate(seconds * 0.16 + bass * 0.6);
      context.globalCompositeOperation = "lighter";
      for (let wedge = 0; wedge < wedges; wedge += 1) {
        context.save();
        context.rotate(wedge / wedges * Math.PI * 2);
        // Every second wedge is mirrored, which is what closes the seams and
        // turns a plain radial spectrum into a kaleidoscope.
        if (wedge % 2 === 1) context.scale(1, -1);
        context.beginPath();
        context.moveTo(0, 0);
        const steps = 46;
        for (let step = 0; step <= steps; step += 1) {
          const progress = step / steps;
          const value = frequencyValue(frame, progress * 0.85 + 0.02);
          const spread = progress * (Math.PI * 2 / wedges);
          const distance = reach * (0.14 + progress * 0.9) * (0.55 + value * 1.05);
          context.lineTo(Math.cos(spread) * distance, Math.sin(spread) * distance);
        }
        const hue = (seconds * 34 + wedge * 360 / wedges + middle * 90) % 360;
        const petal = context.createLinearGradient(0, 0, reach, 0);
        petal.addColorStop(0, `hsla(${hue}, 100%, 68%, ${0.5 + overall * 0.4})`);
        petal.addColorStop(0.6, `hsla(${(hue + 45) % 360}, 100%, 58%, 0.34)`);
        petal.addColorStop(1, `hsla(${(hue + 90) % 360}, 100%, 50%, 0)`);
        context.fillStyle = petal;
        context.fill();
        context.restore();
      }
      context.restore();

      const halo = context.createRadialGradient(
        width / 2, height / 2, 0, width / 2, height / 2, reach * (0.3 + bass * 0.25)
      );
      halo.addColorStop(0, `rgba(255, 255, 255, ${0.14 + high * 0.34})`);
      halo.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
      title(frame, "Spectral Kaleidoscope");
    }
  };
}

export const psychedelicVisualizers: VisualizerPlugin[] = [
  createWarpTunnel(),
  createKaleidoscope()
];
