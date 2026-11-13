// @ts-nocheck — part of this project's webvs fork (MIT); the mscopes ports are BSD-3 (LICENSE-mscopes.txt).
/**
 * mscopes' extra script variables (core/effects/AudioVars.h, docs/PRESETS.md) in every
 * AVS script: kick, snare, hat (1 at a hit of that drum, decaying), onset (how
 * percussive the sound is, 0…1), level (overall loudness, 0…1, automatic gain),
 * bass_att, mid_att, treb_att (slow averages of lows, mids and highs, 0…1).
 *
 * As in mscopes, a preset whose scripts assign one of these names keeps it as its own
 * variable, so presets that happen to use the same names behave as they always did;
 * only a name a script reads and never assigns follows the music. It is read when the
 * script reads it, from the frame's analysis (audio.ts), which then runs once a frame.
 */
import * as Ast from "../expr/Ast";
import { mscopesAudio, MscopesAudioFrame } from "./audio";

export const AUDIO_VARIABLES = ["kick", "snare", "hat", "onset", "level", "bass_att", "mid_att", "treb_att"];

/** AudioVars::set: the value of one variable for a frame (without features, the classic fields). */
export function audioVariable(frame: MscopesAudioFrame, name: string): number {
    if (frame.hasFeatures) {
        switch (name) {
            case "kick": return frame.kick;
            case "snare": return frame.snare;
            case "hat": return frame.hat;
            case "onset": return frame.onset;
            case "level": return frame.level;
            case "bass_att": return frame.bassAtt;
            case "mid_att": return frame.midAtt;
            case "treb_att": return frame.trebleAtt;
        }
        return 0;
    }
    switch (name) {
        case "kick": return frame.beat ? 1 : 0;
        case "level": return (frame.bass + frame.mid + frame.treble) / 3;
        case "bass_att": return frame.bass;
        case "mid_att": return frame.mid;
        case "treb_att": return frame.treble;
    }
    return 0;
}

function collect(node, read: Set<string>, assigned: Set<string>): void {
    if (!node) {
        return;
    }
    if (node instanceof Ast.Program) {
        node.statements.forEach((statement) => collect(statement, read, assigned));
    } else if (node instanceof Ast.Assignment) {
        assigned.add(String(node.lhs.value).toLowerCase());
        collect(node.expr, read, assigned);
    } else if (node instanceof Ast.BinaryExpr) {
        collect(node.leftOperand, read, assigned);
        collect(node.rightOperand, read, assigned);
    } else if (node instanceof Ast.UnaryExpr) {
        collect(node.operand, read, assigned);
    } else if (node instanceof Ast.FuncCall) {
        if (node.funcName === "assign" && node.args[0] instanceof Ast.PrimaryExpr) {
            assigned.add(String(node.args[0].value).toLowerCase());
        }
        node.args.forEach((arg) => collect(arg, read, assigned));
    } else if (node instanceof Ast.PrimaryExpr && node.type === Ast.PrimaryExprType.ID) {
        read.add(String(node.value).toLowerCase());
    }
}

/**
 * Makes the extra variables a compiled script reads (and never assigns, in any of its
 * sections) live on its code instance. Called by compileExpr for every script.
 */
export function bindAudioVariables(codeInst, codeAst: { [name: string]: Ast.Program }): void {
    const read = new Set<string>();
    const assigned = new Set<string>();
    for (const name of Object.keys(codeAst)) {
        collect(codeAst[name], read, assigned);
    }
    for (const name of AUDIO_VARIABLES) {
        if (!read.has(name) || assigned.has(name)) {
            continue;
        }
        Object.defineProperty(codeInst, name, {
            configurable: true,
            enumerable: false,
            get() {
                // The analyser comes with setup(main); before that there is no music.
                const analyser = this.analyser;
                return analyser ? audioVariable(mscopesAudio(analyser).frame(), name) : 0;
            },
            // Writes from the engine (a reset to 0) leave the music's value in place.
            set() {},
        });
    }
}
