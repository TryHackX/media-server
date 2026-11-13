// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import clone from "lodash-es/clone";
import extend from "lodash-es/extend";
import isArray from "lodash-es/isArray";
import pickBy from "lodash-es/pickBy";
import Model from "./Model";

/**
 * Defines a resource pack. Resource Packs
 * can be added to resource manager.
 */
export interface IPack {
    /**
     * Name of the Resource Pack
     */
    name: string;
    /**
     * URL prefix for the Resource Pack. Full URL to
     * a file in this pack is obtained by appending the filename
     * to this prefix
     */
    prefix: string;
    /**
     * Names of the files.
     */
    fileNames: string[];
}

/**
 * ResourceManager manages async loading and caching of resources.
 *
 * ResourceManager Basically, it maintains a map of fileNames to URI for
 * the resource. When a request for resource fileName is received, the uri is looked up
 * and the file is either async loaded or served from cache. This also manages
 * a ready state with callbacks that tells when one or more resources are being loaded and
 * when all resources are ready.
 */
export default class ResourceManager extends Model {
    public ready: boolean = true;
    private packs: IPack[];
    private uris: {[key: string]: string} = {};
    private images: {[key: string]: HTMLImageElement} = {};
    private waitImages: {[key: string]: HTMLImageElement} = {};
    private waitCount: number = 0;

    constructor(packs: IPack | IPack[]) {
        super();
        if (packs) {
            if (!isArray(packs)) {
                packs = [packs];
            }
            this.packs = packs;
        } else {
            this.packs = [];
        }
        this.clear();
    }

    /**
     * Register a filename and a URI in the resource manager.
     *
     * @param fileName name of the file or map of filename: uri.
     * @param uri uri when string fileName is specified
     */
    public registerUri(fileName: string | any, uri?: string) {
        if (typeof fileName === "string" && typeof uri === "string") {
            this.uris[fileName] = uri;
        } else {
            const inputUris = fileName;
            extend(this.uris, inputUris);
        }
    }

    /**
     * Returns the attributes for this ResourceManager
     *
     * @param key the name of the attribute. Only `"uris"` is acceptable.
     */
    public get(key: string) {
        if (key === "uris") {
            return this.uris;
        }
    }

    /**
     * Returns JSON representation of the resource manager
     */
    public toJSON() {
        return {
            uris: clone(this.uris),
        };
    }

    /**
     * Clears state, uri mappings and caches. Browser caches still apply.
     *
     * @param keys the keys which should be cleared. Default clears everything.
     */
    public clear(keys: string[] = null) {
        for (const fileName in this.waitImages) {
            if (!this.waitImages.hasOwnProperty(fileName)) {
                continue;
            }
            const image = this.waitImages[fileName];
            image.onload = null;
            image.onerror = null;
        }
        this.waitImages = {};
        if (keys) {
            const pickPredicate = (val, key) => keys.indexOf(key) === -1;
            this.uris = pickBy(this.uris, pickPredicate);
            this.images = pickBy(this.images, pickPredicate);
        } else {
            this.uris = {};
            this.images = {};
        }
        this.waitCount = 0;
        this.ready = true;
    }

    /**
     * Loads an Image resource.
     *
     * @param fileName fileName of the image to be returned
     * @param success handler that'll be called on success
     * @param error handler that'll be called on error
     */
    /** Fork: whether a bitmap of this name is known (getImage stands a sprite in otherwise). */
    public hasImage(fileName: string): boolean {
        return Boolean(this._getUri(fileName));
    }

    public getImage(fileName: string, success: (image: HTMLImageElement) => void, error?: () => void): void {
        let image = this.images[fileName];
        if (image) { // check in cache
            if (success) {
                success(image);
            }
            return;
        }

        // load file
        let uri = this._getUri(fileName);
        if (!uri) {
            // Fork: pack bitmaps are not shipped with the presets; a built-in sprite stands in.
            uri = this._getUri("avsres_texer_circle_heavyblur_21x21.bmp");
        }
        if (!uri) {
            throw new Error("Unknown image file " + fileName);
        }
        image = new Image();
        if (uri.indexOf("data:") !== 0) {
            // add cross origin attribute for
            // remote images
            image.crossOrigin = "anonymous";
        }
        image.onload = () => {
            // Fork: the image stays cached for later presets, its handlers must not: they hold the
            // component that asked (Texer II …), and with it that whole preset, for the page's life.
            image.onload = null;
            image.onerror = null;
            delete this.waitImages[fileName];
            this.images[fileName] = image;
            if (success) {
                success(image);
            }
            this._loadEnd();
        };
        // Fork: a bitmap that fails to load (404, network) is left out and the
        // frame goes on without it. Without an error callback the loader waited
        // for it for ever, and the whole visualizer stood still on a black frame.
        image.onerror = () => {
            image.onload = null;
            image.onerror = null;
            delete this.waitImages[fileName];
            if (!error || error()) {
                this._loadEnd();
            }
        };
        this._loadStart();
        image.src = uri;
        this.waitImages[fileName] = image;
    }

    protected setAttribute(key: string, value: any, options: any) {
        if (key === "uris") {
            this.uris = value;
            return true;
        }
        return false;
    }

    private _getUri(fileName: string): string {
        const uri = this.uris[fileName];
        if (uri) {
            return uri;
        }
        for (let i = this.packs.length - 1; i >= 0; i--) {
            const pack = this.packs[i];
            if (pack.fileNames.indexOf(fileName) !== -1) {
                return pack.prefix + encodeURIComponent(fileName);
            }
        }
        // Fork: AVS opened its bitmaps on Windows, where file names ignore case
        // ("raz_sonic_01.BMP" finds Raz_sonic_01.bmp).
        const wanted = String(fileName || "").toLowerCase();
        for (let i = this.packs.length - 1; i >= 0; i--) {
            const pack = this.packs[i];
            const match = pack.fileNames.find((name) => name.toLowerCase() === wanted);
            if (match) {
                return pack.prefix + encodeURIComponent(match);
            }
        }
    }

    private _loadStart() {
        this.waitCount++;
        if (this.waitCount === 1) {
            this.ready = false;
            this.emit("wait");
        }
    }

    private _loadEnd() {
        this.waitCount--;
        if (this.waitCount === 0) {
            this.ready = true;
            this.emit("ready");
        }
    }
}
