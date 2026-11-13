// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Plug-ins whose source is published under a licence this repository can carry, ported into the
 * engine's plug-in host (apeHost.ts). A port of the same id in vendor/avs-apes replaces these.
 */
import { addBuiltinApe, ApeEffect } from "./apeHost";

/**
 * Trans: Normalise as grandchild/vis_avs re-implemented it (e_normalise.cpp, BSD): one minimum and
 * maximum over the red, green and blue bytes of the frame, then every channel stretched by a table
 * (c − min) · (255 / (max − min)) in single-precision floats, cut to an integer. A frame that holds
 * both 0 and 255 is left alone; a frame of one value turns black. The original APE (no published
 * source) stretched in 16-bit integers, ((c − min) · ⌊65535 / (max − min)⌋) >> 8, one step higher
 * in about a third of the cases; the owner's vendor port follows it.
 */
addBuiltinApe({
    id: "Trans: Normalise",
    create(config: Uint8Array): ApeEffect {
        const enabled = config.length >= 4
            ? (config[0] | (config[1] << 8) | (config[2] << 16) | (config[3] << 24)) !== 0
            : false;
        const table = new Int32Array(256);
        return {
            render(_ctx, framebuffer) {
                if (!enabled) {
                    return 0;
                }
                let max = 0;
                let min = 255;
                const n = framebuffer.length;
                for (let i = 0; i < n; i++) {
                    const p = framebuffer[i];
                    const r = (p >>> 16) & 255;
                    const g = (p >>> 8) & 255;
                    const b = p & 255;
                    const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
                    const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
                    if (hi > max) {
                        max = hi;
                    }
                    if (lo < min) {
                        min = lo;
                    }
                }
                if (max === 255 && min === 0) {
                    return 0;
                }
                table.fill(0);
                if (max - min) {
                    const diff = Math.fround(255 / Math.fround(max - min));
                    for (let i = min, j = 0; i <= max; i++, j++) {
                        table[i] = Math.trunc(Math.fround(j * diff));
                    }
                }
                for (let i = 0; i < n; i++) {
                    const p = framebuffer[i];
                    framebuffer[i] = (table[(p >>> 16) & 255] << 16) | (table[(p >>> 8) & 255] << 8) | table[p & 255];
                }
                return 0;
            },
        };
    },
});
