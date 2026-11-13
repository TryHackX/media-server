/**
 * Pure helpers of the plug-in host (apeHost.ts); no imports, so the tests run them with plain Node.
 */

/** A plug-in's config bytes, as the converter keeps them (base64). */
export function fromBase64Config(text: unknown): Uint8Array {
    let binary = "";
    try {
        binary = atob(String(text || ""));
    } catch {
        binary = "";
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** MSVC's rand(): state · 214013 + 2531011, bits 16…30 (srand(seed) first; the CRT starts at 1). */
export function msvcRand(seed = 1): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 214013) + 2531011) >>> 0;
        return (state >>> 16) & 0x7fff;
    };
}

/** The file name an SVP Loader names, lower-case: AVS kept it with its folder ("…\\Voronoi.svp"). */
export function svpFileName(library: unknown): string {
    return (String(library ?? "").split(/[\\/]/).pop() ?? "").trim().toLowerCase();
}
