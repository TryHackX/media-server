import type { VisualizerPlugin } from "./types";
import { clear, frequencyValue, hsla, title } from "./utils";

interface FieldOptions { id: string; label: string; hue: number; tunnel?: boolean; vortex?: boolean }

function field(options: FieldOptions): VisualizerPlugin {
  return {
    id: options.id,
    label: options.label,
    fftSize: 2048,
    smoothing: 0.82,
    render(frame) {
      const { context, width, height, time } = frame;
      clear(frame, `hsl(${options.hue} 52% 10%)`);
      if (options.tunnel) {
        const centerX = width / 2;
        const centerY = height / 2;
        const rings = 18;
        for (let ring = rings; ring >= 0; ring -= 1) {
          const phase = (ring / rings + time / 4200) % 1;
          const radius = phase * Math.max(width, height) * 0.58;
          const value = frequencyValue(frame, ring / rings);
          context.beginPath();
          for (let side = 0; side <= 6; side += 1) {
            const angle = side / 6 * Math.PI * 2 + time / 6000;
            const x = centerX + Math.cos(angle) * radius;
            const y = centerY + Math.sin(angle) * radius;
            if (side === 0) context.moveTo(x, y); else context.lineTo(x, y);
          }
          context.strokeStyle = hsla(options.hue + ring * 14, 0.18 + value * 0.72);
          context.lineWidth = 1 + value * 2;
          context.stroke();
        }
      } else {
        const lines = Math.max(18, Math.min(52, Math.floor(width / 25)));
        for (let line = 0; line < lines; line += 1) {
          const progress = line / Math.max(1, lines - 1);
          const value = frequencyValue(frame, progress);
          context.beginPath();
          for (let step = 0; step <= 48; step += 1) {
            const x = step / 48 * width;
            const baseY = progress * height;
            const wave = Math.sin(step * 0.32 + time / 430 + line * 0.22) * height * (0.012 + value * 0.06);
            const vortex = options.vortex ? Math.sin(progress * Math.PI) * Math.sin(time / 700 + step / 5) * height * 0.08 : 0;
            const y = baseY + wave + vortex;
            if (step === 0) context.moveTo(x, y); else context.lineTo(x, y);
          }
          context.strokeStyle = hsla(options.hue + progress * 130 + time / 120, 0.16 + value * 0.68);
          context.lineWidth = 0.7 + value * 2.1;
          context.stroke();
        }
      }
      title(frame, options.label);
    }
  };
}

export const fieldVisualizers: VisualizerPlugin[] = [
  field({ id: "vortex", label: "Vortex Visualizer", hue: 260, vortex: true }),
  field({ id: "prism-tunnel", label: "Prism Tunnel", hue: 310, tunnel: true })
];
