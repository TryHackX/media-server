// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
// Fork: the resource URL comes from the build (scripts/avs-presets.mjs), not a webpack define.
import { images as PACK_IMAGES, resources as RESOURCE_PACK_URL } from "virtual:avs-presets";

const builtinResourcePack = {
    fileNames: [
        "avsres_texer_circle_edgeonly_19x19.bmp",
        "avsres_texer_circle_edgeonly_29x29.bmp",
        "avsres_texer_circle_fade_13x13.bmp",
        "avsres_texer_circle_heavyblur_19x19.bmp",
        "avsres_texer_circle_heavyblur_21x21.bmp",
        "avsres_texer_circle_heavyblur_29x29.bmp",
        "avsres_texer_circle_sharp_09x09.bmp",
        "avsres_texer_circle_sharp_19x19.bmp",
        "avsres_texer_circle_slightblur_13x13.bmp",
        "avsres_texer_circle_slightblur_21x21.bmp",
        "avsres_texer_hexagon-h_blur_123x123.bmp",
        "avsres_texer_square_edgeonly_24x24.bmp",
        "avsres_texer_square_edgeonly_28x28.bmp",
        "avsres_texer_square_edgeonly_30x30.bmp",
        "avsres_texer_square_sharp_20x20.bmp",
        "avsres_texer_square_sharp_32x32.bmp",
        "avsres_texer_square_sharp_48x48.bmp",
        "avsres_texer_square_sharp_60x60.bmp",
        "avsres_texer_square_sharp_64x64.bmp",
        "avsres_texer_square_sharp_72x72.bmp",
        "avsres_texer_square_sharp_96x96.bmp",
        "avsres_texer_square_sharp_250x250.bmp",
        // Fork: the bitmaps that came with the preset packs (vendor/avs-presets), served beside.
        ...PACK_IMAGES,
    ],
    name: "Builtin",
    prefix: RESOURCE_PACK_URL,
};
export default builtinResourcePack;
