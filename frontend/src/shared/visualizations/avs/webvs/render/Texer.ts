// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import { avsVisdata } from "../avsDraw";
import each from "lodash-es/each";
import Component, { IContainer } from "../Component";
import CodeInstance from "../expr/CodeInstance";
import compileExpr from "../expr/compileExpr";
import IMain from "../IMain";
import { avsBlend, BlendMode, Source, WebGLVarType } from "../utils";
import Buffer from "../webgl/Buffer";
import RenderingContext from "../webgl/RenderingContext";
import ShaderProgram from "../webgl/ShaderProgram";

export interface ITexerOpts {
    code: {
        init: string,
        onBeat: string,
        perFrame: string,
        perPoint: string,
    };
    imageSrc: string;
    source: string;
    resizing: boolean;
    wrapAround: boolean;
    clone: number;
    colorFiltering: boolean;
}

interface ITexerCodeInstance extends CodeInstance {
    n: number;
    b: number;
    i: number;
    v: number;
    x: number;
    y: number;
    sizex: number;
    sizey: number;
    red: number;
    green: number;
    blue: number;
    init: () => void;
    perFrame: () => void;
    perPoint: () => void;
    onBeat: () => void;
}

// A SuperScope like component that places images at points.
export default class Texer extends Component {
    public static componentName: string = "Texer";
    public static componentTag: string = "render";
    protected static optUpdateHandlers = {
        clone: "updateClone",
        code: "updateCode",
        imageSrc: "updateImage",
        source: "updateSource",
    };
    protected static defaultOptions: ITexerOpts = {
        clone: 1,
        code: {
            init: "",
            onBeat: "",
            perFrame: "",
            perPoint: "",
        },
        colorFiltering: true,
        imageSrc: "avsres_texer_circle_edgeonly_19x19.bmp",
        resizing: false,
        source: "SPECTRUM",
        wrapAround: false,
    };

    protected opts: ITexerOpts;
    private program: ShaderProgram;
    private vertexBuffer: Buffer;
    private texVertexBuffer: Buffer;
    private colorBuffer: Buffer;
    private indexBuffer: Buffer;
    private code: ITexerCodeInstance[];
    private inited: boolean;
    private texture: WebGLTexture;
    private imageWidth: number;
    private imageHeight: number;
    private source: Source;

    constructor(main: IMain, parent: IContainer, opts: any) {
        super(main, parent, opts);
    }

    public handleResize() {
        for (const codeInst of this.code) {
            codeInst.updateDimVars(this.main.getRctx().getGl());
        }
    }

    public init() {
        const rctx = this.main.getRctx();
        const gl = this.main.getRctx().getGl();
        this.program = new ShaderProgram(rctx, {
            bindings: {
                attribs: {
                    colors:      { name: "a_color", size: 3 },
                    texVertices: { name: "a_texVertex" },
                    vertices:    { name: "a_vertex" },
                },
                index: {
                    drawMode: gl.TRIANGLES,
                    valueName: "indices",
                },
                uniforms: {
                    colorFilter: { name: "u_colorFilter", valueType: WebGLVarType._1I },
                    image:       { name: "u_image", valueType: WebGLVarType.TEXTURE2D },
                },
            },
            copyOnSwap: true,
            // Fork: Texer II blends with the line blend mode (Set Render Mode).
            dynamicBlend: true,
            fragmentShader: `
                uniform bool u_colorFilter;
                uniform sampler2D u_image;
                varying vec2 v_texVertex;
                varying vec3 v_color;
                void main() {
                   vec3 outColor = texture2D(u_image, v_texVertex).rgb;
                   if(u_colorFilter) {
                       outColor = outColor*v_color;
                   }
                   setFragColor(vec4(outColor, 1));
                }
            `,
            vertexShader: `
                uniform bool u_colorFilter;
                attribute vec2 a_texVertex;
                attribute vec2 a_vertex;
                attribute vec3 a_color;
                varying vec2 v_texVertex;
                varying vec3 v_color;
                void main() {
                   if(u_colorFilter) {
                       v_color = a_color;
                   }
                   v_texVertex = a_texVertex;
                   setPosition(a_vertex);
                }
            `,
        });
        this.updateCode();
        this.updateClone();
        this.updateImage();
        this.updateSource();
        this.listenTo(this.main, "resize", () => this.handleResize());

        this.vertexBuffer = new Buffer(rctx);
        this.texVertexBuffer = new Buffer(rctx);
        this.colorBuffer = new Buffer(rctx);
        this.indexBuffer = new Buffer(rctx, true);
    }

    public draw() {
        each(this.code, (code) => {
            this._drawScope(code, !this.inited);
        });
        this.inited = true;
    }

    public destroy() {
        const gl = this.main.getRctx().getGl();
        super.destroy();
        this.program.destroy();
        gl.deleteTexture(this.texture);
        this.vertexBuffer.destroy();
        this.texVertexBuffer.destroy();
        this.colorBuffer.destroy();
        this.indexBuffer.destroy();
    }

    private updateCode() {
        const code = compileExpr(
            this.opts.code,
            ["init", "onBeat", "perFrame", "perPoint"],
        ).codeInst as ITexerCodeInstance;
        code.n = 100;
        code.setup(this.main);
        this.inited = false;
        this.code = [code];
    }

    private updateClone() {
        this.code = CodeInstance.clone(this.code, this.opts.clone) as ITexerCodeInstance[];
    }

    private updateImage() {
        const gl = this.main.getRctx().getGl();
        this.main.getRsrcMan().getImage(
            this.opts.imageSrc,
            (image) => {
                this.imageWidth = image.width;
                this.imageHeight = image.height;
                if (!this.texture) {
                    this.texture = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, this.texture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                } else {
                    gl.bindTexture(gl.TEXTURE_2D, this.texture);
                }
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            },
        );
    }

    private updateSource() {
        this.source = Source[this.opts.source];
    }

    private _drawScope(code: ITexerCodeInstance, runInit: boolean) {
        const gl = this.main.getRctx().getGl();
        // Fork: AVS (e_texer2.cpp) resets these once a frame, before any code,
        // not at every point: sizes and colours set in the frame code hold.
        code.i = 0;
        code.x = 0;
        code.y = 0;
        code.v = 0;
        code.sizex = 1;
        code.sizey = 1;
        code.red = 1;
        code.green = 1;
        code.blue = 1;
        if (runInit) {
            code.n = 0;
            code.init();
        }

        const beat = this.main.getAnalyser().isBeat();
        code.b = beat ? 1 : 0;
        code.perFrame();
        if (beat) {
            code.onBeat();
        }

        // Fork: n rounded, 0…16383 (the index buffer is 16-bit); v is the
        // waveform at j·575/n, as in AVS: (left + right signed bytes) / 256 (e_texer2.cpp).
        const nPoints = Math.max(0, Math.min(16383, Math.round(Number(code.n) || 0)));
        const { wave } = avsVisdata(this.main);

        const vertexData = [];
        const texVertexData = [];
        const vertexIndices = [];
        const colorData = this.opts.colorFiltering ? [] : null;
        let index = 0;
        const addRect = (cornx, corny, sizex, sizey, red, green, blue, flipX = false, flipY = false) => {
            if (cornx < -1 - sizex || cornx > 1 ||
               corny < -1 - sizey || corny > 1) {
                return;
            }
            // screen coordinates
            vertexData.push(
                cornx,       corny,
                cornx + sizex, corny,
                cornx + sizex, corny + sizey,
                cornx,       corny + sizey,
            );

            // texture coordinates (negative sizes mirror or flip the sprite in AVS)
            const u0 = flipX ? 1 : 0;
            const u1 = flipX ? 0 : 1;
            const v0 = flipY ? 1 : 0;
            const v1 = flipY ? 0 : 1;
            texVertexData.push(
                u0, v0,
                u1, v0,
                u1, v1,
                u0, v1,
            );

            if (colorData) {
                // color data
                colorData.push(
                    red, green, blue,
                    red, green, blue,
                    red, green, blue,
                    red, green, blue,
                );
            }

            // indices
            vertexIndices.push(
                index + 0, index + 1, index + 2,
                index + 0, index + 2, index + 3,
            );
            index += 4;
        };

        // Fork: sprites are pixels of AVS's window, scaled to this one.
        const avsScale = this.main.avsScale || 1;
        const imageSizex = (this.imageWidth * avsScale / gl.drawingBufferWidth) * 2;
        const imageSizey = (this.imageHeight * avsScale / gl.drawingBufferHeight) * 2;

        const step = nPoints > 1 ? 1 / (nPoints - 1) : 0;
        for (let i = 0; i < nPoints; i++) {
            code.i = i * step;
            const at = Math.floor((i * 575) / nPoints);
            code.v = ((wave[0][at] || 0) + (wave[1][at] || 0)) / 256.0;
            code.skip = 0;
            code.perPoint();
            if (Number(code.skip) !== 0) {
                continue;
            }
            const scaleX = Math.abs(Number(code.sizex) || 0);
            const scaleY = Math.abs(Number(code.sizey) || 0);
            if (scaleX <= 0.01 || scaleY <= 0.01) {
                continue;
            }

            let sizex = imageSizex;
            let sizey = imageSizey;
            if (this.opts.resizing) {
                sizex *= scaleX;
                sizey *= scaleY;
            }
            const cornx = code.x - sizex / 2;
            const corny = (-code.y) - sizey / 2;
            const flipX = code.sizex < 0;
            const flipY = code.sizey < 0;
            const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
            const red = clamp01(code.red);
            const green = clamp01(code.green);
            const blue = clamp01(code.blue);

            addRect(cornx, corny, sizex, sizey, red, green, blue, flipX, flipY);
            if (this.opts.wrapAround) {
                // wrapped around x value is 1-(-1-cornx) or -1-(1-cornx)
                // depending on the edge
                // ie. 2+cornx or -2+cornx
                const xwrap = (cornx < -1) ? 2 : ((cornx > (1 - sizex)) ? -2 : 0);
                const ywrap = (corny < -1) ? 2 : ((corny > (1 - sizey)) ? -2 : 0);
                if (xwrap) {
                    addRect(xwrap + cornx, corny, sizex, sizey, red, green, blue, flipX, flipY);
                }
                if (ywrap) {
                    addRect(cornx, ywrap + corny, sizex, sizey, red, green, blue, flipX, flipY);
                }
                if (xwrap && ywrap) {
                    addRect(xwrap + cornx, ywrap + corny, sizex, sizey, red, green, blue, flipX, flipY);
                }
            }
        }

        this.vertexBuffer.setData(vertexData);
        this.texVertexBuffer.setData(texVertexData);
        this.indexBuffer.setData(new Uint16Array(vertexIndices));
        if (colorData) {
            this.colorBuffer.setData(colorData);
        }
        const lineBlend = this.main.avsRenderMode ? this.main.avsRenderMode.blend : "REPLACE";
        this.program.run(
            this.parent.getTSM(),
            {
                colorFilter: colorData ? 1 : 0,
                colors: colorData ? this.colorBuffer : null,
                image: this.texture,
                indices: this.indexBuffer,
                texVertices: this.texVertexBuffer,
                vertices: this.vertexBuffer,
            },
            BlendMode[avsBlend(lineBlend)] ?? BlendMode.REPLACE,
        );
    }
}
