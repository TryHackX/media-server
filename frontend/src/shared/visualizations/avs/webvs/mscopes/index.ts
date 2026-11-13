// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * The components ported from GarAlex/mscopes (BSD-3, LICENSE-mscopes.txt): its modern
 * layer (GPU post effects, trails, particles, a vectorscope, the GPU simulations and
 * the pixel shader) and the built-in effects its own presets are made of. Every name
 * starts with "Mscopes": AVS has APEs called Fluid and Particle System, and webvsc
 * names them so.
 */
import { MscopesBloom, MscopesStreaks } from "./bloom";
import { MscopesParticles, MscopesRing, MscopesScope, MscopesStarfield, MscopesVectorscope } from "./draw";
import { MscopesPixelShader } from "./pixelShader";
import {
    MscopesBlur, MscopesColorMap, MscopesCRT, MscopesDuotone, MscopesFeedbackWarp, MscopesGlitch, MscopesGrain,
    MscopesKaleidoscope, MscopesLens, MscopesNeonEdges, MscopesRadialBlur, MscopesRgbSplit, MscopesShimmer,
    MscopesShockwave, MscopesToneMap, MscopesTrails, MscopesVignette,
} from "./post";
import { MscopesFlowParticles, MscopesFluid, MscopesReactionDiffusion } from "./sims";

export const mscopesComponents = [
    MscopesBloom, MscopesKaleidoscope, MscopesRgbSplit, MscopesToneMap, MscopesVignette, MscopesShockwave,
    MscopesGlitch, MscopesStreaks, MscopesLens, MscopesRadialBlur, MscopesNeonEdges, MscopesDuotone,
    MscopesShimmer, MscopesCRT, MscopesTrails, MscopesParticles, MscopesVectorscope,
    MscopesFlowParticles, MscopesFluid, MscopesReactionDiffusion, MscopesPixelShader,
    MscopesFeedbackWarp, MscopesBlur, MscopesColorMap, MscopesScope, MscopesStarfield, MscopesRing, MscopesGrain,
];
