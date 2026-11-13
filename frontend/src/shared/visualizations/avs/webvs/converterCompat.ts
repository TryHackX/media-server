// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Options as webvsc writes them, read the way this webvs expects.
 *
 * webvsc follows a newer webvs schema than the 3.0.0 vendored here, so a few
 * options arrive under other names and were silently ignored: scopes read the
 * waveform when the preset asked for the spectrum, colour maps blended with
 * the default mode, channel shifts never shifted. Translated once, where every
 * component is created.
 */
/**
 * AVS has eight global buffers. Buffer Save and effect lists count them 0…7,
 * Dynamic Movement and Bump 1…8 with 0 for the frame itself; AVS clamps any
 * other number into range, and presets carry numbers like 40 or 254 that only
 * work that way. One name per buffer for all of them.
 */
export function avsBufferName(index): string {
    return `avsbuf${Math.max(0, Math.min(7, Math.floor(Number(index) || 0)))}`;
}

function bufferNumber(value): number {
    return value === "Current" || value === undefined ? 0 : Number(value) || 0;
}

export function fromConverter(opts) {
    if (!opts || typeof opts !== "object") {
        return opts;
    }
    const translated = { ...opts };
    switch (opts.type) {
        case "SuperScope":
            if (opts.audioSource !== undefined && opts.source === undefined) {
                translated.source = opts.audioSource;
            }
            if (opts.audioChannel !== undefined && opts.channel === undefined) {
                translated.channel = opts.audioChannel;
            }
            break;
        case "ColorMap":
            if (opts.blendMode !== undefined && opts.output === undefined) {
                translated.output = opts.blendMode;
            }
            // webvsc names two keys and the cycle modes differently; unknown
            // names fell back to the red channel and to a single map.
            translated.key = {
                CHANNEL_SUM_HALF: "(R+G+B)/2",
                CHANNEL_AVERAGE: "(R+G+B)/3",
            }[String(opts.key || "").toUpperCase()] || opts.key;
            if (opts.mapCycleMode !== undefined) {
                translated.mapCycleMode = String(opts.mapCycleMode).toUpperCase().replace(/_/g, "");
            }
            break;
        case "ChannelShift":
            if (opts.mode !== undefined && opts.channel === undefined) {
                translated.channel = opts.mode;
            }
            break;
        case "ClearScreen":
            // "Only first frame" — clearing every frame wiped all feedback.
            if (opts.onlyFirst) {
                translated.beatCount = -1;
            }
            break;
        case "BufferSave":
            translated.bufferId = avsBufferName(bufferNumber(opts.bufferId));
            break;
        case "DynamicMovement":
            if (bufferNumber(opts.buffer) > 0) {
                translated.sourceBuffer = avsBufferName(bufferNumber(opts.buffer) - 1);
            }
            break;
        case "Bump":
            if (bufferNumber(opts.depthBuffer) > 0) {
                translated.depthSource = avsBufferName(bufferNumber(opts.depthBuffer) - 1);
            }
            break;
        case "EffectList":
            // webvsc's tables stop before AVS's last mode, "Minimum" (input 13,
            // output 12): such a list came without the option at all.
            if (opts.input === undefined) {
                translated.input = "MINIMUM";
            }
            if (opts.output === undefined) {
                translated.output = "MINIMUM";
            }
            break;
        case "ColorClip":
            // AVS's "near" distance is 0…64 in 0…255 steps (twice that is the
            // radius); webvs compares against half its level in 0…1.
            if (opts.level !== undefined) {
                translated.level = (Number(opts.level) || 0) * 4 / 255;
            }
            // "Off" was read as webvs's first mode and clipped every dark pixel.
            if (String(opts.mode || "").toUpperCase() === "OFF") {
                translated.enabled = false;
            }
            break;
    }
    return translated;
}
