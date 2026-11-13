// @ts-nocheck — part of this project's webvs fork (MIT), not upstream.
/**
 * Trans / Multi Delay (Tom Holden's "Holden05: Multi Delay", in vis_avs 2.81 as r_multidelay.cpp,
 * BSD): six delay buffers shared by every Multi Delay of the preset. An instance in "input" mode
 * writes the frame into its buffer, one in "output" mode shows the frame from that buffer's delay
 * ago; "off" does nothing. Each buffer delays by its own frame count, or (beats) by the frames
 * between the last two beats.
 *
 * As in AVS the state is global: the first instance created sets it up, every load_config that
 * carries the buffer table overwrites it, the first instance to render each frame decides beats
 * and buffer sizes, the last one moves every buffer's positions on (multiDelayRing.ts, tested
 * against a literal port). Frames live on the graphics card; fresh memory is black.
 */
import Component from "../Component";
import { IKeptFrame, keepFrame } from "../avsSupport";
import { fromBase64Config } from "../ape/config";
import {
    loadMultiDelayConfig, MultiDelayState, multiDelayFrameEnd, multiDelayFrameStart, multiDelayShown, multiDelayStore,
    newMultiDelayState,
} from "./multiDelayRing";

interface Shared {
    state: MultiDelayState<IKeptFrame>;
    live: Set<IKeptFrame>;
    black: IKeptFrame | null;
}

const shared = new WeakMap<object, Shared>();

export default class MultiDelay extends Component {
    public static componentName: string = "MultiDelay";
    public static componentTag: string = "trans";
    private shared: Shared;
    // Fields without initializers: the base constructor runs init() before they would apply.
    private mode: number;
    private activeBuffer: number;

    public init() {
        let entry = shared.get(this.main);
        if (!entry || entry.state.instances === 0) {
            if (entry) {
                release(entry);
            }
            entry = { state: newMultiDelayState<IKeptFrame>(), live: new Set(), black: null };
            shared.set(this.main, entry);
        }
        entry.state.instances++;
        this.shared = entry;
        const { mode, activeBuffer } = loadMultiDelayConfig(entry.state, fromBase64Config(this.opts.config));
        this.mode = mode;
        this.activeBuffer = activeBuffer;
    }

    public draw() {
        const entry = this.shared;
        const state = entry.state;
        if (state.renderId === state.instances) {
            state.renderId = 0;
        }
        state.renderId++;
        const gl = this.main.getRctx().getGl();
        if (state.renderId === 1) {
            multiDelayFrameStart(state, `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`, this.main.getAnalyser().isBeat());
        }
        const tsm = this.parent.getTSM();
        const shown = multiDelayShown(state, this.mode, this.activeBuffer);
        if (shown !== undefined) {
            if (shown) {
                this.main.getCopier().run(tsm, { srcTexture: shown.texture() });
            } else {
                if (!entry.black) {
                    entry.black = keepFrame(this.main);
                    entry.black.clear();
                }
                this.main.getCopier().run(tsm, { srcTexture: entry.black.texture() });
            }
        } else if (this.mode !== 0) {
            const kept = keepFrame(this.main);
            kept.store(tsm.getCurrentTexture());
            if (multiDelayStore(state, this.mode, this.activeBuffer, kept)) {
                entry.live.add(kept);
            } else {
                kept.release();
            }
        }
        if (state.renderId === state.instances) {
            multiDelayFrameEnd(state);
            collect(entry);
        }
    }

    public destroy() {
        super.destroy();
        const entry = this.shared;
        if (entry) {
            entry.state.instances--;
            if (entry.state.instances <= 0) {
                release(entry);
                shared.delete(this.main);
            }
        }
    }
}

/** Frames no slot holds any more go back to the pool. */
function collect(entry: Shared) {
    const held = new Set<IKeptFrame>();
    for (const buffer of entry.state.buffers) {
        for (const slot of buffer.slots) {
            if (slot) {
                held.add(slot);
            }
        }
    }
    for (const frame of entry.live) {
        if (!held.has(frame)) {
            frame.release();
            entry.live.delete(frame);
        }
    }
}

function release(entry: Shared) {
    for (const frame of entry.live) {
        frame.release();
    }
    entry.live.clear();
    for (const buffer of entry.state.buffers) {
        buffer.slots = [];
    }
    if (entry.black) {
        entry.black.release();
        entry.black = null;
    }
}
