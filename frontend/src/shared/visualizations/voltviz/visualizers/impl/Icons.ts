// @ts-nocheck — vendored from voltviz 0.35.1 (MIT, see LICENSE-voltviz.txt); kept close to upstream.
// Fork: no React. The icons are lucide's own data (`lucide` 1.59.0, the version of lucide-react
// in voltviz 0.35.1), each element measured by ../../outline.ts as Chrome measures it instead of
// being rendered to markup (react-dom/server) and measured by the browser, which took Chrome two
// seconds for the 40 icons; an icon is parsed when it is first shown, once a page. The overlay
// (the icon's name, Shuffle) is not React here: the adapter draws it as plain DOM (../../overlays.ts)
// through the same api (shuffle, getIconName, subscribe).
import type { IconNode } from 'lucide';
import {
  Heart, Star, Music, Zap, Flame, Crown, Diamond, Skull, Ghost,
  Rocket, Atom, Brain, Bug, Camera, Cloud, Coffee, Compass, Crosshair,
  Flower2, Gamepad2, Globe, Headphones, Hexagon, Key, Leaf, Moon,
  Shield, Snowflake, Sun, Target, TreePine, Umbrella, Wind, Aperture,
  Fingerprint, Anchor, Bell, Bookmark, Eye, Fish
} from 'lucide';
import { outlineOf } from '../../outline';
import { beatStrength, STRONG_BEAT } from '../lib/audio';
import { mountCanvas2D } from '../lib/canvas2d';
import type { VisualizerFactory } from '../runtime/types';

type IconsApi = {
  shuffle(): void;
  getIconName(): string | null;
  subscribe(listener: (name: string | null) => void): () => void;
};

// Fork: exported for the tests (voltviz-icons.test.ts), as are parseIcon and ParsedPath.
export const ICON_POOL: [string, IconNode][] = [
  ['Heart', Heart], ['Star', Star], ['Music', Music], ['Zap', Zap],
  ['Flame', Flame], ['Crown', Crown], ['Diamond', Diamond], ['Skull', Skull],
  ['Ghost', Ghost], ['Rocket', Rocket], ['Atom', Atom], ['Brain', Brain],
  ['Bug', Bug], ['Camera', Camera], ['Cloud', Cloud], ['Coffee', Coffee],
  ['Compass', Compass], ['Crosshair', Crosshair], ['Flower', Flower2],
  ['Gamepad', Gamepad2], ['Globe', Globe], ['Headphones', Headphones],
  ['Hexagon', Hexagon], ['Key', Key], ['Leaf', Leaf], ['Moon', Moon],
  ['Shield', Shield], ['Snowflake', Snowflake], ['Sun', Sun], ['Target', Target],
  ['Tree', TreePine], ['Umbrella', Umbrella], ['Wind', Wind], ['Aperture', Aperture],
  ['Fingerprint', Fingerprint], ['Anchor', Anchor], ['Bell', Bell],
  ['Bookmark', Bookmark], ['Eye', Eye], ['Fish', Fish],
];

export type ParsedPath = { path: number[][]; color: null };

// Fork: upstream's parseSVGString, given lucide's elements (tag and attributes, in the order
// React renders them) instead of React's markup, each measured by outlineOf instead of by a
// clone in a hidden <svg> of the page.
export function parseIcon(node: IconNode): ParsedPath[] {
  const elements = node.map(([tag, attributes]) => outlineOf(tag, attributes));

  const parsedPaths: ParsedPath[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  elements.forEach(clone => {
    try {
      if (clone) {
        const length = clone.getTotalLength();
        if (length === 0) return;

        const numPoints = Math.min(3000, Math.max(300, Math.floor(length)));
        const arcLength = length / numPoints;
        let currentSubPath: number[][] = [];
        let prevPt: { x: number; y: number } | null = null;

        for (let i = 0; i <= numPoints; i++) {
          const pt = clone.getPointAtLength((i / numPoints) * length);

          if (prevPt) {
            const dist = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y);
            if (dist > arcLength * 1.5 + 0.1) {
              if (currentSubPath.length > 0) {
                parsedPaths.push({ path: currentSubPath, color: null });
                currentSubPath = [];
              }
            }
          }

          currentSubPath.push([pt.x, pt.y, 0]);
          prevPt = pt;

          minX = Math.min(minX, pt.x);
          maxX = Math.max(maxX, pt.x);
          minY = Math.min(minY, pt.y);
          maxY = Math.max(maxY, pt.y);
        }
        if (currentSubPath.length > 0) {
          parsedPaths.push({ path: currentSubPath, color: null });
        }
      }
    } catch {
      // Ignore elements that fail
    }
  });

  if (parsedPaths.length > 0) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const scale = Math.max(maxX - minX, maxY - minY) / 2 || 1;

    return parsedPaths.map(item => ({
      path: item.path.map(p => [
        (p[0] - cx) / scale,
        (p[1] - cy) / scale,
        0,
      ]),
      color: null,
    }));
  }

  return [];
}

// Fork: every icon of the pool is drawn (the tests check that each one parses into paths), and
// each is parsed the first time it is shown, then kept for the page.
const ICON_NAMES = ICON_POOL.map(([name]) => name);
const ICON_NODES = new Map(ICON_POOL);
const allIconData = new Map<string, ParsedPath[]>();

function iconData(name: string): ParsedPath[] {
  let paths = allIconData.get(name);
  if (!paths) {
    paths = parseIcon(ICON_NODES.get(name)!);
    allIconData.set(name, paths);
  }
  return paths;
}

const Icons: VisualizerFactory = ({ container }) => {
  const c = mountCanvas2D(container);
  const canvas = c.canvas;
  const ctx = c.ctx;

  let activeCopies = new Map<number, { dir: number; freqBin: number }>();
  let currentPaths: ParsedPath[] = [];
  let lastSwitchTime = 0;
  let currentIconName: string | null = null;
  const listeners = new Set<(name: string | null) => void>();

  const setCurrentIconName = (name: string | null) => {
    currentIconName = name;
    listeners.forEach(l => l(name));
  };

  // Fork: not all parsed here (iconData parses one when it is first shown).
  {
    const names = ICON_NAMES;
    if (names.length > 0) {
      const initial = names[Math.floor(Math.random() * names.length)];
      currentPaths = iconData(initial);
      currentIconName = initial;
    }
  }

  const shuffleIcon = () => {
    const names = ICON_NAMES;
    if (names.length === 0) return;
    let next = names[Math.floor(Math.random() * names.length)];
    if (names.length > 1) {
      while (next === currentIconName) {
        next = names[Math.floor(Math.random() * names.length)];
      }
    }
    currentPaths = iconData(next);
    activeCopies.clear();
    setCurrentIconName(next);
    lastSwitchTime = performance.now();
  };

  const particles: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; maxLife: number; color: string }[] = [];

  let time = 0;

  return {
    resize: (w, h, dpr) => c.resize(w, h, dpr),
    frame({ audio, settings }) {
      if (currentPaths.length === 0) return;
      const w = canvas.width;
      const h = canvas.height;
      const currentSettings = settings;
      let svgPaths = currentPaths;
      time += 0.01 * currentSettings.speed;

      const dataArray = audio.spectrum({ fftSize: 512, smoothing: 0.8 });

      const bass = dataArray.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      const treble = dataArray.slice(50, 150).reduce((a, b) => a + b, 0) / 100;

      // Beat-driven: a strong heard beat (accents, without a confident tempo, never reach STRONG_BEAT)
      const isBeat = beatStrength(audio) >= STRONG_BEAT;

      // Switch icon on strong beat (min 4s interval)
      if (isBeat && performance.now() - lastSwitchTime > 4000) {
        const names = ICON_NAMES;
        if (names.length > 1) {
          const next = names[Math.floor(Math.random() * names.length)];
          currentPaths = iconData(next) || currentPaths;
          svgPaths = currentPaths;
          activeCopies.clear();
          lastSwitchTime = performance.now();
          setCurrentIconName(next);
        }
      }

      if (isBeat || activeCopies.size === 0) {
        const closedIndices: number[] = [];
        svgPaths.forEach((item, idx) => {
          const path = item.path;
          if (path.length > 2) {
            const first = path[0];
            const last = path[path.length - 1];
            if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05) {
              closedIndices.push(idx);
            }
          }
        });

        closedIndices.sort(() => Math.random() - 0.5);
        const numToPick = Math.max(1, Math.floor(closedIndices.length * 0.75));

        const newActive = new Map<number, { dir: number; freqBin: number }>();
        closedIndices.slice(0, numToPick).forEach(idx => {
          newActive.set(idx, {
            dir: Math.random() > 0.5 ? 1 : -1,
            freqBin: Math.floor(Math.random() * 100),
          });
        });
        activeCopies = newActive;
      }

      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const baseRadius = Math.min(w, h) * 0.3 * currentSettings.scale;
      const radius = baseRadius * (1 + (bass / 255) * 0.3 * currentSettings.sensitivity);

      const rotX = time * 0.5;
      const rotY = time * 0.7;

      const rotate = (x: number, y: number, z: number): [number, number, number] => {
        const y1 = y * Math.cos(rotX) - z * Math.sin(rotX);
        const z1 = y * Math.sin(rotX) + z * Math.cos(rotX);
        const x2 = x * Math.cos(rotY) + z1 * Math.sin(rotY);
        const z2 = -x * Math.sin(rotY) + z1 * Math.cos(rotY);
        return [x2, y1, z2];
      };

      // Spawn particles from active subpaths
      if (treble * currentSettings.sensitivity > 80 && Math.random() > 0.3) {
        const activeIndices = Array.from(activeCopies.keys());
        if (activeIndices.length > 0) {
          for (let i = 0; i < 8; i++) {
            const randomPathIdx = activeIndices[Math.floor(Math.random() * activeIndices.length)];
            const randomPathItem = svgPaths[randomPathIdx];
            if (!randomPathItem) continue;

            const randomPath = randomPathItem.path;
            const activeData = activeCopies.get(randomPathIdx);

            if (randomPath && randomPath.length > 0 && activeData) {
              const v = randomPath[Math.floor(Math.random() * randomPath.length)];
              const speed = 2 + Math.random() * 8 * currentSettings.speed * (treble / 255);

              const freqVal = dataArray[activeData.freqBin] / 255;
              const individualZOffset = freqVal * 200 * currentSettings.sensitivity * activeData.dir;

              const vx = (Math.random() - 0.5) * speed * 2;
              const vy = (Math.random() - 0.5) * speed * 2;
              const vz = (Math.random() - 0.5) * speed * 2;

              const particleColor = Math.random() > 0.5
                ? `hsla(${180 + currentSettings.hueShift}, 100%, 60%, 1)`
                : `hsla(${300 + currentSettings.hueShift}, 100%, 60%, 1)`;

              particles.push({
                x: v[0] * radius,
                y: v[1] * radius,
                z: v[2] * radius + individualZOffset,
                vx, vy, vz,
                life: 1,
                maxLife: 0.5 + Math.random() * 1,
                color: particleColor,
              });
            }
          }
        }
      }

      // Draw particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.z += p.vz;
        p.life -= 0.02 * currentSettings.speed;

        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        const [rx, ry, rz] = rotate(p.x, p.y, p.z);
        const scale = 500 / (500 + rz);
        const px = cx + rx * scale;
        const py = cy + ry * scale;

        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - p.vx * scale * 2, py - p.vy * scale * 2);
        ctx.strokeStyle = p.color.replace('1)', `${p.life / p.maxLife})`);
        ctx.lineWidth = 2 * scale * currentSettings.scale;
        ctx.stroke();
      }

      // Prepare SVG paths for drawing
      const drawItems: { type: 'original' | 'copy'; pathIdx: number; path: number[][]; z: number; isClosed: boolean; zOffset?: number }[] = [];

      svgPaths.forEach((item, pathIdx) => {
        const path = item.path;
        if (path.length === 0) return;

        const first = path[0];
        const last = path[path.length - 1];
        const isClosed = path.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05;

        let sumZOrig = 0;
        for (let i = 0; i < path.length; i++) {
          const [, , rz] = rotate(path[i][0] * radius, path[i][1] * radius, path[i][2] * radius);
          sumZOrig += rz;
        }
        drawItems.push({ type: 'original', pathIdx, path, z: sumZOrig / path.length, isClosed });

        const activeData = activeCopies.get(pathIdx);
        if (isClosed && activeData) {
          const freqVal = dataArray[activeData.freqBin] / 255;
          const individualZOffset = freqVal * 200 * currentSettings.sensitivity * activeData.dir;

          let sumZCopy = 0;
          for (let i = 0; i < path.length; i++) {
            const [, , rz] = rotate(path[i][0] * radius, path[i][1] * radius, path[i][2] * radius + individualZOffset);
            sumZCopy += rz;
          }
          drawItems.push({ type: 'copy', pathIdx, path, z: sumZCopy / path.length, isClosed, zOffset: individualZOffset });
        }
      });

      // Sort items back-to-front
      drawItems.sort((a, b) => b.z - a.z);

      // Draw items
      drawItems.forEach(item => {
        ctx.beginPath();

        for (let i = 0; i < item.path.length; i++) {
          const v = item.path[i];
          const [rx, ry, rz] = rotate(v[0] * radius, v[1] * radius, v[2] * radius + (item.zOffset || 0));
          const scale = 500 / (500 + rz);
          const screenX = cx + rx * scale;
          const screenY = cy + ry * scale;

          if (i === 0) {
            ctx.moveTo(screenX, screenY);
          } else {
            ctx.lineTo(screenX, screenY);
          }
        }

        if (item.isClosed) {
          ctx.closePath();
        }

        const hue = item.pathIdx % 2 === 0 ? 180 : 300;
        const finalHue = (hue + currentSettings.hueShift) % 360;

        if (item.type === 'copy') {
          ctx.fillStyle = `hsla(${finalHue}, 100%, 60%, 0.15)`;
          ctx.fill();
          ctx.strokeStyle = `hsla(${finalHue}, 100%, 60%, 0.4)`;
          ctx.lineWidth = 1 * currentSettings.scale;
          ctx.shadowBlur = 0;
          ctx.stroke();
        } else {
          const pulse = bass / 255;
          ctx.strokeStyle = `hsla(${finalHue}, 100%, 60%, 0.8)`;
          ctx.lineWidth = (2 + pulse * 4) * currentSettings.scale;
          ctx.shadowBlur = (10 + pulse * 60 * currentSettings.sensitivity) * currentSettings.scale;
          ctx.shadowColor = `hsla(${finalHue}, 100%, ${50 + pulse * 30}%, ${0.6 + pulse * 0.4})`;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      });

      ctx.shadowBlur = 0;
    },
    dispose() {
      listeners.clear();
      particles.length = 0;
      canvas.remove();
    },
    api: {
      shuffle: shuffleIcon,
      getIconName: () => currentIconName,
      subscribe: (listener: (name: string | null) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
};

export default Icons;
