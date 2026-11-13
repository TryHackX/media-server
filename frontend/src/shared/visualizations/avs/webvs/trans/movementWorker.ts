// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Builds Movement tables off the page (see Movement.ts): a 1280×720 table runs
 * the preset's code almost a million times, which would stop the picture for
 * most of a second. Jobs run in order; a cancelled one is skipped.
 */
import { buildMovementTable, scatterPoints, tableTextureData } from "./movementTable";

const scope = self as any;
const cancelled = new Set();

/** What compiled code asks the engine for; the table is built silent and still. */
function workerMain(w: number, h: number) {
    const silence = new Float32Array(576);
    return {
        getAnalyser: () => ({
            getSpectrum: () => silence,
            getWaveform: () => silence,
            isBeat: () => false,
        }),
        getBootTime: () => Date.now(),
        getRctx: () => ({ getGl: () => ({ drawingBufferHeight: h, drawingBufferWidth: w }) }),
        getRegisterBank: () => ({}),
    };
}

scope.onmessage = (event) => {
    const message = event.data || {};
    if (message.cancel) {
        cancelled.add(message.cancel);
        return;
    }
    const { id, effect, w, h, options, points } = message;
    if (cancelled.delete(id)) {
        return;
    }
    try {
        const table = buildMovementTable(effect, w, h, options, workerMain(w, h));
        const data = tableTextureData(table.entries, table.subpixel, w, h);
        const scatter = points ? scatterPoints(data, w, h) : null;
        scope.postMessage({ data, id, points: scatter, subpixel: table.subpixel },
            scatter ? [data.buffer, scatter.buffer] : [data.buffer]);
    } catch (error) {
        scope.postMessage({ error: String(error), id });
    }
};
