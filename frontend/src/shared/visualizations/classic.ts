import type { VisualizerPlugin } from "./types";
import { amplitude, frequencyAverage, frequencyValue, title } from "./utils";

const powerAmp: VisualizerPlugin = {
  id: "poweramp",
  label: "PowerAmp",
  fftSize: 16384,
  smoothing: 0.85,
  render(frame) {
    const { context, width, height, waveform, time } = frame;
    context.fillStyle = "rgb(10 15 25)";
    context.fillRect(0, 0, width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.4;
    const innerRadius = maxRadius * 0.3;
    const average = frequencyAverage(frame);
    const rotation = time * 0.0003;
    const rayGradient = context.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, maxRadius);
    rayGradient.addColorStop(0, "rgb(0 122 255 / 72%)");
    rayGradient.addColorStop(1, "rgb(0 200 255 / 25%)");
    context.save();
    context.translate(centerX, centerY);
    context.rotate(rotation);
    context.translate(-centerX, -centerY);
    context.beginPath();
    for (let index = 0; index < 180; index += 1) {
      const angle = index / 180 * Math.PI * 2;
      const value = frequencyValue(frame, index / 179);
      const adjusted = Math.pow(value, 1.5) * (0.8 + average * 0.4);
      const length = adjusted * maxRadius * 0.7;
      if (length < 3) continue;
      context.moveTo(centerX + Math.cos(angle) * innerRadius, centerY + Math.sin(angle) * innerRadius);
      context.lineTo(centerX + Math.cos(angle) * (innerRadius + length), centerY + Math.sin(angle) * (innerRadius + length));
    }
    context.strokeStyle = rayGradient;
    context.lineWidth = Math.max(1.25, Math.min(width, height) / 360);
    context.stroke();
    context.restore();
    const waveformPoints = Math.min(160, waveform.length);
    const waveScale = height * 0.15 * (0.5 + average * 1.5);
    context.beginPath();
    for (let index = 0; index < waveformPoints; index += 1) {
      const sampleIndex = Math.floor(index / Math.max(1, waveformPoints - 1) * (waveform.length - 1));
      const sample = ((waveform[sampleIndex] ?? 128) - 128) / 128;
      const x = index / Math.max(1, waveformPoints - 1) * width;
      const y = centerY + sample * waveScale;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.strokeStyle = "rgb(0 200 255 / 82%)";
    context.lineWidth = 2;
    context.shadowColor = "rgb(0 168 255 / 65%)";
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;
    const pulseRadius = maxRadius * 0.2 * (0.8 + average * 0.5);
    const glowRadius = pulseRadius * 1.65;
    const pulse = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius);
    pulse.addColorStop(0, "rgb(0 168 255)");
    pulse.addColorStop(0.48, "rgb(0 92 185 / 88%)");
    pulse.addColorStop(1, "rgb(0 40 80 / 0%)");
    context.fillStyle = pulse;
    context.beginPath();
    context.arc(centerX, centerY, glowRadius, 0, Math.PI * 2);
    context.fill();
    title(frame, "POWERAMP");
    context.font = "600 10px system-ui, sans-serif";
    context.fillStyle = "rgb(0 200 255 / 82%)";
    context.textAlign = "right";
    context.fillText(`LEVEL: ${Math.round(average * 100)}%`, width - 14, 98);
  }
};

const solarFlare: VisualizerPlugin = {
  id: "solar-flare",
  label: "Solar Flare",
  fftSize: 16384,
  smoothing: 0.85,
  render(frame) {
    const { context, width, height } = frame;
    const centerX = width / 2;
    const centerY = height / 2;
    const base = Math.min(width, height);
    const background = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(width, height) * 0.62);
    background.addColorStop(0, "rgb(255 222 36 / 98%)");
    background.addColorStop(0.26, "rgb(255 153 0 / 88%)");
    background.addColorStop(0.68, "rgb(190 24 8 / 62%)");
    background.addColorStop(1, "rgb(36 0 8)");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = "screen";
    for (let index = 0; index < 40; index += 1) {
      const angle = index / 40 * Math.PI * 2 + frame.time * 0.00008;
      const value = frequencyValue(frame, index / 39);
      const inner = base * (0.11 + value * 0.025);
      const outer = inner + base * (0.08 + value * 0.2);
      context.beginPath();
      context.moveTo(centerX + Math.cos(angle - 0.025) * inner, centerY + Math.sin(angle - 0.025) * inner);
      context.quadraticCurveTo(
        centerX + Math.cos(angle) * outer,
        centerY + Math.sin(angle) * outer,
        centerX + Math.cos(angle + 0.025) * inner,
        centerY + Math.sin(angle + 0.025) * inner
      );
      context.strokeStyle = `rgb(255 204 64 / ${0.13 + value * 0.42})`;
      context.lineWidth = 1.15 + value * 2.4;
      context.stroke();
    }
    context.restore();
    const innerRadius = base * 0.1;
    const maxLength = base * 0.4;
    context.shadowColor = "rgb(255 205 86 / 82%)";
    context.shadowBlur = Math.max(4, base * 0.012);
    for (let index = 0; index < 64; index += 1) {
      const value = frequencyValue(frame, index / 63);
      const angle = index / 64 * Math.PI * 2;
      const length = innerRadius + value * maxLength;
      const x1 = centerX + Math.cos(angle) * innerRadius;
      const y1 = centerY + Math.sin(angle) * innerRadius;
      const x2 = centerX + Math.cos(angle) * length;
      const y2 = centerY + Math.sin(angle) * length;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.strokeStyle = `rgb(255 255 255 / ${0.32 + value * 0.62})`;
      context.lineWidth = 1.2 + value * 1.6;
      context.stroke();
      context.beginPath();
      context.arc(x1, y1, Math.max(1.8, base * 0.0054 * (0.7 + value)), 0, Math.PI * 2);
      context.fillStyle = `rgb(255 255 255 / ${0.26 + value * 0.46})`;
      context.fill();
    }
    context.shadowBlur = 0;
    title(frame, "SOLAR FLARE");
  }
};

interface FlowParticle {
  x: number; y: number; vx: number; vy: number;
  originX: number; originY: number; targetX: number; targetY: number;
  migrationSpeed: number; migrationTimer: number; migrating: boolean;
  angle: number; distance: number; orbitalSpeed: number; baseSize: number;
}

/** Blackness laid over each frame. Lower means longer wakes; 0.1 is the original. */
const TRAIL_FADE = 0.1;

function createFlowField(): VisualizerPlugin {
  let particles: FlowParticle[] = [];
  let fieldWidth = 0;
  let fieldHeight = 0;
  const rebuild = (width: number, height: number): void => {
    fieldWidth = width;
    fieldHeight = height;
    const count = 700;
    const scale = Math.min(width, height) / 500;
    particles = Array.from({ length: count }, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      return {
        x, y, vx: 0, vy: 0, originX: x, originY: y, targetX: x, targetY: y,
        migrationSpeed: Math.random() * 0.01 + 0.002,
        migrationTimer: 200 + Math.random() * 1000,
        migrating: false,
        angle: Math.random() * Math.PI * 2,
        distance: Math.random() * 20 * scale,
        orbitalSpeed: (Math.random() * 0.02 + 0.01) * (Math.random() > 0.5 ? 1 : -1),
        baseSize: Math.random() * 0.5 + 0.5
      };
    });
  };
  return {
    id: "flow-field",
    label: "Audio Flow Field",
    fftSize: 2048,
    smoothing: 0.9,
    reset: () => { particles = []; fieldWidth = 0; fieldHeight = 0; },
    render(frame) {
      const { context, width, height, time } = frame;
      if (!particles.length || Math.abs(width - fieldWidth) > 2 || Math.abs(height - fieldHeight) > 2) rebuild(width, height);
      const scale = Math.min(width, height) / 500;
      const quarter = frame.frequency.length / 4;
      const low = amplitude(frame.frequency, 0, quarter);
      const middle = amplitude(frame.frequency, quarter, quarter * 3);
      const high = amplitude(frame.frequency, quarter * 3);
      const overall = (low + middle + high) / 3;
      const sizeVariation = middle * 2 + high;
      context.globalAlpha = 1;
      context.filter = "none";
      context.shadowBlur = 0;
      // The original effect: each frame is veiled rather than wiped, so every
      // particle drags a soft wake behind it. Veiling never quite reaches black
      // in eight bits, which leaves a faint film on the backdrop — that is the
      // known cost of this look and the one the owner prefers.
      context.globalCompositeOperation = "source-over";
      context.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
      context.fillRect(0, 0, width, height);
      const maxDistance = 50 * scale * (1 + low);
      const maxMigrations = 150;
      let migrating = particles.reduce((count, particle) => count + Number(particle.migrating), 0);
      for (const particle of particles) {
        particle.migrationTimer -= 1;
        if (particle.migrationTimer <= 0 && !particle.migrating && migrating < maxMigrations) {
          particle.targetX = Math.random() * width;
          particle.targetY = Math.random() * height;
          particle.migrating = true;
          migrating += 1;
          particle.migrationTimer = 100 + Math.random() * 1000 * (1 - Math.max(low, middle, high) * 0.3);
        } else if (particle.migrating && Math.abs(particle.originX - particle.targetX) < 2 && Math.abs(particle.originY - particle.targetY) < 2) {
          particle.migrating = false;
          migrating -= 1;
        }
        if (particle.migrating) {
          const speed = particle.migrationSpeed * 0.4 * (1 + Math.max(low, middle) * 0.5);
          const maxShift = 1.2 * scale * (1 + overall * 0.5);
          let shiftX = (particle.targetX - particle.originX) * speed;
          let shiftY = (particle.targetY - particle.originY) * speed;
          const shift = Math.hypot(shiftX, shiftY);
          if (shift > maxShift) { shiftX *= maxShift / shift; shiftY *= maxShift / shift; }
          particle.originX += shiftX;
          particle.originY += shiftY;
        }
        const distortion = middle * 0.2 * Math.sin(time * 0.002 + particle.angle * 3);
        particle.angle += particle.orbitalSpeed * (1 + low * 0.05) + distortion;
        const orbitDistortion = high * 10 * Math.sin(time * 0.005 + particle.angle * 2) * scale;
        const targetDistance = maxDistance * (low * 0.5 + middle * 0.5) + orbitDistortion;
        particle.distance += (targetDistance - particle.distance) * 0.1;
        const idealX = particle.originX + Math.cos(particle.angle) * particle.distance;
        const idealY = particle.originY + Math.sin(particle.angle) * particle.distance;
        let forceX = (idealX - particle.x) * 0.08;
        let forceY = (idealY - particle.y) * 0.08;
        const force = Math.hypot(forceX, forceY);
        const maxForce = scale;
        if (force > maxForce) { forceX *= maxForce / force; forceY *= maxForce / force; }
        particle.vx = (particle.vx + forceX) * 0.9;
        particle.vy = (particle.vy + forceY) * 0.9;
        const speed = Math.hypot(particle.vx, particle.vy);
        const maxSpeed = 3 * scale;
        if (speed > maxSpeed) { particle.vx *= maxSpeed / speed; particle.vy *= maxSpeed / speed; }
        particle.x += particle.vx;
        particle.y += particle.vy;
        const safeDistance = Math.min(width, height) * 0.35;
        const fromOrigin = Math.hypot(particle.x - particle.originX, particle.y - particle.originY);
        if (particle.x < -50 || particle.x > width + 50 || particle.y < -50 || particle.y > height + 50 || fromOrigin > safeDistance) {
          const returnFactor = 0.05 * Math.min(fromOrigin / Math.max(1, safeDistance), 3);
          particle.vx += Math.max(-1.5 * scale, Math.min(1.5 * scale, (particle.originX - particle.x) * returnFactor));
          particle.vy += Math.max(-1.5 * scale, Math.min(1.5 * scale, (particle.originY - particle.y) * returnFactor));
          particle.vx *= 0.85;
          particle.vy *= 0.85;
          if (fromOrigin > safeDistance * 3 || particle.x < -width * 0.5 || particle.x > width * 1.5 || particle.y < -height * 0.5 || particle.y > height * 1.5) {
            particle.x = particle.originX + (Math.random() * 2 - 1) * 5 * scale;
            particle.y = particle.originY + (Math.random() * 2 - 1) * 5 * scale;
            particle.vx = (Math.random() * 2 - 1) * 0.5 * scale;
            particle.vy = (Math.random() * 2 - 1) * 0.5 * scale;
            particle.distance = Math.random() * 5 * scale;
          }
        }
        const musicSize = sizeVariation * (0.8 + Math.sin(time * 0.003 + particle.angle * 2) * 0.2);
        const radius = (particle.baseSize + musicSize) * 3 * scale;
        const hue = (Math.atan2(particle.y - height / 2, particle.x - width / 2) * 180 / Math.PI + time * 0.02 + 360) % 360;
        // Capped well below 100%: at full lightness every hue collapses to white,
        // which is what washed the colour out of the loud passages. Staying in the
        // mid sixties keeps the hue saturated while still brightening with treble.
        const lightness = 52 + high * 14;
        const glow = `hsla(${hue}, 100%, ${lightness + 6}%,`;

        if (radius > 1.2) {
          context.beginPath();
          context.arc(particle.x, particle.y, radius * 2.15, 0, Math.PI * 2);
          context.fillStyle = `${glow} 0.13)`;
          context.fill();
          context.beginPath();
          context.arc(particle.x, particle.y, radius * 1.48, 0, Math.PI * 2);
          context.fillStyle = `${glow} 0.24)`;
          context.fill();
        }
        context.beginPath();
        context.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
        context.fillStyle = `hsla(${hue}, 100%, ${lightness}%, ${Math.min(1, 0.78 + musicSize * 0.3)})`;
        context.fill();
      }
      context.globalCompositeOperation = "source-over";
      title(frame, "AUDIO FLOW FIELD");
    }
  };
}

export const classicVisualizers: VisualizerPlugin[] = [powerAmp, solarFlare, createFlowField()];
