// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import Component, { IContainer } from "../Component";
import IMain from "../IMain";
import { avsBlend, BlendMode, WebGLVarType } from "../utils";
import ShaderProgram from "../webgl/ShaderProgram";
import { blendTwoGlsl, bufferBlendName, HIGH_PRECISION } from "../avsSupport";

/** A texture to blend a buffer from while it is being written. */
const SCRATCH = "avsbuf_scratch";

/**
 * Options for BufferSave
 */
export interface IBufferSaveOpts {
    /**
     * Action to be taken see [[BufferSaveAction]]
     */
    action: string;
    /**
     * A unique name for the buffer
     */
    bufferId: string;
    /**
     * BlendMode when restoring
     */
    blendMode: string;
}

/**
 * Actions for BufferSave
 */
enum BufferSaveAction {
    SAVE = 0,
    RESTORE,
    SAVERESTORE,
    RESTORESAVE,
}

/**
 * A component that saves or restores a copy of the current
 * frame buffer
 */
export default class BufferSave extends Component {
    public static componentName: string = "BufferSave";
    public static componentTag: string = "misc";
    protected static optUpdateHandlers = {
        action: "updateAction",
        blendMode: "updateBlendMode",
        bufferId: "updateBuffer",
    };
    protected static defaultOptions: IBufferSaveOpts = {
        action: "SAVE",
        blendMode: "REPLACE",
        bufferId: "buffer1",
    };

    protected opts: IBufferSaveOpts;
    private action: BufferSaveAction;
    private nextAction: BufferSaveAction;
    private blendMode: BlendMode;
    private blendName: string;
    private program: ShaderProgram;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public init() {
        this.updateAction();
        this.updateBlendMode();
        this.updateBuffer();
    }

    public draw() {
        let currentAction;
        if (this.action === BufferSaveAction.SAVERESTORE ||
           this.action === BufferSaveAction.RESTORESAVE) {
            currentAction = this.nextAction;
            // toggle next action
            this.nextAction =
                (this.nextAction === BufferSaveAction.SAVE) ? BufferSaveAction.RESTORE : BufferSaveAction.SAVE;
        } else {
            currentAction = this.action;
        }

        // Fork: r_stack.cpp asks getGlobalBuffer to allocate the buffer unless it only restores:
        // a plain restore of a buffer nothing allocated yet does nothing (it cleared the frame).
        const written = this.main.avsWrittenBuffers;
        if (written) {
            if (this.action === BufferSaveAction.RESTORE && !written.has(this.opts.bufferId)) {
                return;
            }
            written.add(this.opts.bufferId);
        }
        const tempTSM = this.main.getTempTSM();
        // Fork: a buffer restored before any save (or named by a number the
        // converter carried over) used to throw "Unknown texture" every frame.
        try {
            tempTSM.getTexture(this.opts.bufferId);
        } catch (missing) {
            tempTSM.addTexture(this.opts.bufferId);
        }
        // Fork: AVS blends both ways (r_stack.cpp): saving writes
        // blend(buffer, frame) into the buffer, restoring writes
        // blend(frame, buffer) into the frame, in AVS's integer arithmetic.
        const frame = this.parent.getTSM().getCurrentTexture();
        const buffer = tempTSM.getTexture(this.opts.bufferId);
        const gl = this.main.getRctx().getGl();
        const value = Math.max(0, Math.min(255, Number(this.opts.adjustBlend) || 0));
        switch (currentAction) {
            case BufferSaveAction.SAVE:
                if (this.main.avsWrittenBuffers) {
                    this.main.avsWrittenBuffers.add(this.opts.bufferId);
                }
                if (this.blendName === "REPLACE") {
                    tempTSM.setAsRenderTarget(this.opts.bufferId);
                    this.main.getCopier().run(null, { srcTexture: frame });
                    tempTSM.unsetAsRenderTarget();
                } else {
                    // The buffer cannot be read while written: blend from a copy.
                    try {
                        tempTSM.getTexture(SCRATCH);
                    } catch (missing) {
                        tempTSM.addTexture(SCRATCH);
                    }
                    tempTSM.setAsRenderTarget(SCRATCH);
                    this.main.getCopier().run(null, { srcTexture: buffer });
                    tempTSM.unsetAsRenderTarget();
                    tempTSM.setAsRenderTarget(this.opts.bufferId);
                    this.program.run(null, { dest: tempTSM.getTexture(SCRATCH), src: frame, value, height: gl.drawingBufferHeight });
                    tempTSM.unsetAsRenderTarget();
                }
                break;
            case BufferSaveAction.RESTORE:
                if (this.blendName === "REPLACE") {
                    this.main.getCopier().run(this.parent.getTSM(), { srcTexture: buffer });
                } else {
                    this.program.run(this.parent.getTSM(), { dest: frame, src: buffer, value, height: gl.drawingBufferHeight });
                }
                break;
        }
    }

    public destroy() {
        super.destroy();
        if (this.program) {
            this.program.destroy();
            this.program = null;
        }
        // Fork: buffers stay. They are shared by name and reused by the next
        // preset; removing one shifted the index of every texture after it in
        // TextureSetManager while their names kept the old index, so the next
        // preset failed with "Unknown texture" on a buffer it never touched.
    }

    public updateAction() {
        this.action = BufferSaveAction[this.opts.action];
        if (this.action === BufferSaveAction.SAVERESTORE) {
            this.nextAction = BufferSaveAction.SAVE;
        } else if (this.action === BufferSaveAction.RESTORESAVE) {
            this.nextAction = BufferSaveAction.RESTORE;
        }
    }

    public updateBuffer(value?, key?, oldValue?) {
        // buffer names in TextureSetManager have to be string
        // converting to string to maintain backward compatibility
        this.opts.bufferId = this.opts.bufferId + "";
        // Fork: the old buffer stays (see destroy).
        this.main.getTempTSM().addTexture(this.opts.bufferId);
    }

    public updateBlendMode() {
        this.blendMode = (BlendMode[avsBlend(this.opts.blendMode)] ?? BlendMode.REPLACE);
        // Fork: AVS's own blend for both directions (see draw).
        this.blendName = bufferBlendName(this.opts.blendMode);
        if (this.program) {
            this.program.destroy();
        }
        this.program = new ShaderProgram(this.main.getRctx(), {
            bindings: {
                uniforms: {
                    dest: { name: "u_dest", valueType: WebGLVarType.TEXTURE2D },
                    height: { name: "u_height", valueType: WebGLVarType._1F },
                    src: { name: "u_src", valueType: WebGLVarType.TEXTURE2D },
                    value: { name: "u_value", valueType: WebGLVarType._1F },
                },
            },
            fragmentShader: `
                ${HIGH_PRECISION}
                uniform sampler2D u_dest;
                uniform sampler2D u_src;
                uniform float u_value;
                uniform float u_height;
                ${blendTwoGlsl(this.blendName)}
                void main() {
                    setFragColor(vec4(blendTwo(texture2D(u_dest, v_position).rgb, texture2D(u_src, v_position).rgb), 1.0));
                }
            `,
            swapFrame: true,
        });
    }
}
