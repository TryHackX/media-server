/**
 * AVS Trans Automation (TomyLobo's eeltrans APE, version 1.25; its translator as
 * e_eeltrans_translate.cpp in grandchild/vis_avs — read against the original binary,
 * scratch/avs-reference/apes/eeltrans.md).
 *
 * The APE hooks ns-eel's compile: while its "Activate AVSTrans Support" is on (a process-wide flag,
 * the last loaded config wins), every piece of code AVS compiles is first rewritten from the code of
 * all AVS Trans components (each followed by ";\r\n") and the piece itself:
 * - comments are taken out ("//$avstrans_..." comments are settings: the output mode, "translate
 *   first level", replacements);
 * - "#define" lines become replacements: a C-style macro when the name has brackets
 *   (`#define bezier6(i,p1,...,coord) ...`), otherwise case-insensitive text;
 * - the replacements are applied in the order they were defined;
 * - the statements are rewritten for AVS 2.81's ns-eel in the APE's default mode, "exec": inside a
 *   function's arguments `x = y` becomes `assign(x, y)` and `a; b; c` becomes `exec3(a, b, c)`
 *   (longer sequences nest: exec2(exec3(a, b, c), d)); at the top level only with "translate first
 *   level" (else the statements stay, one after another), and an assignment to megabuf(…) or
 *   megabuf[…] always. Then ";\r\n" ends the text and `[` `]` become `(` `)`.
 * So C-style code with sequences in brackets compiled in AVS 2.81, which cut every piece at `;`.
 *
 * "#include" reads a file next to the APE, which a browser does not have: the line goes, as in AVS
 * when the file is missing. Quirks of the original (a define on the last line registered twice, the
 * bracket error form) are kept, so code compiles here as it did there.
 */

const NEWLINE = "\r\n";
const VAR_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.";
// The original's stand-in for a lone "/" while comments are read (grandchild: "cahghagahS8Jee4").
const PLACEHOLDER = "fgsfoihjoadas";
const CODE_KEYS = ["init", "perFrame", "onBeat", "perPoint", "perPixel"];

/** Output modes (handle_comment: linear 0, assign 1, exec 2, plus 3); the APE always starts in exec. */
const MODE_LINEAR = 0;
const MODE_ASSIGN = 1;
const MODE_EXEC = 2;
const MODE_PLUS = 3;

/** How a replacement applies (plain values: the tests run this file with Node's type stripping). */
const CASE_SENSITIVE = 0;
const CASE_INSENSITIVE = 1;
const C_STYLE = 2;
type Mode = typeof CASE_SENSITIVE | typeof CASE_INSENSITIVE | typeof C_STYLE;

interface Replacement {
    from: string;
    to: string;
    mode: Mode;
}

const isVarChar = (c: string | undefined): boolean => c !== undefined && c !== "" && VAR_CHARS.includes(c);

/** AVS's spec_trim: spaces, CR and LF only. */
function trim(s: string): string {
    return s.replace(/^[ \r\n]+/, "").replace(/[ \r\n]+$/, "");
}

/** ASCII tolower, so positions stay those of the original string. */
function lower(s: string): string {
    return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function replaceAll(input: string, from: string, to: string): string {
    if (!from) {
        return input;
    }
    let pos = input.indexOf(from);
    while (pos !== -1) {
        input = input.slice(0, pos) + to + input.slice(pos + from.length);
        pos = input.indexOf(from, pos + to.length);
    }
    return input;
}

function replaceInsensitive(input: string, from: string, to: string): string {
    from = lower(from);
    if (!from) {
        return input;
    }
    let low = lower(input);
    let pos = low.indexOf(from);
    while (pos !== -1) {
        input = input.slice(0, pos) + to + input.slice(pos + from.length);
        low = low.slice(0, pos) + to + low.slice(pos + from.length);
        pos = low.indexOf(from, pos + to.length);
    }
    return input;
}

/** split() with a limit: at most `limit` parts, the last one the rest. */
function splitLimit(input: string, delimiter: string, limit: number): string[] {
    const out: string[] = [];
    let last = 0;
    let pos = input.indexOf(delimiter);
    for (let i = 1; i < limit && pos !== -1; i++) {
        out.push(input.slice(last, pos));
        last = pos + delimiter.length;
        pos = input.indexOf(delimiter, last);
    }
    out.push(input.slice(last));
    return out;
}

/** Index of the bracket closing the first one opened, or -1 (parse_bracket). */
function closingBracket(input: string): number {
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
        if (input[i] === "(") {
            depth++;
        } else if (input[i] === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** Replacement::c_style_replace: every `name(a,b,...)` with the right count of arguments. */
function cStyleReplace(input: string, from: string, to: string): string {
    const open = from.indexOf("(");
    const name = from.slice(0, open);
    const names = from.slice(open + 1, from.length - 1).split(",").map(trim);

    // The body as pieces of text between the parameters ("##" glues tokens together).
    const parts: string[] = [];
    const tokens: number[] = [];
    let lastPart = 0;
    let thisAlpha = false;
    for (let j = 0; j < to.length; j++) {
        const lastAlpha = thisAlpha;
        thisAlpha = isVarChar(to[j]);
        if (!thisAlpha || lastAlpha) {
            continue;
        }
        for (let i = 0; i < names.length; i++) {
            const param = names[i] ?? "";
            const following = j + param.length < to.length ? to[j + param.length] : undefined;
            if (to.substr(j, param.length) !== param || isVarChar(following)) {
                continue;
            }
            let piece = to.slice(lastPart, j);
            const trimmed = trim(piece);
            if (parts.length && trimmed.startsWith("##")) {
                piece = trim(piece.slice(piece.indexOf("##") + 2));
            }
            if (trimmed.length > 2 && trimmed.endsWith("##")) {
                const at = piece.lastIndexOf("##");
                piece = trim(at === -1 ? piece : piece.slice(0, at));
            }
            parts.push(piece);
            tokens.push(i);
            lastPart = j + param.length;
            break;
        }
    }
    let rest = to.slice(lastPart);
    if (parts.length && trim(rest).startsWith("##")) {
        rest = trim(rest.slice(rest.indexOf("##") + 2));
    }

    let out = "";
    let previousLast = "";
    let pos = input.indexOf(name + "(");
    while (pos !== -1) {
        out += input.slice(0, pos);
        let call = input.slice(pos);
        const close = closingBracket(call);
        if (close === -1) {
            // As in AVS: a bracket error ends the search (and repeats the text after the last call).
            return out + call + previousLast;
        }
        const after = call.slice(close + 1);
        call = call.slice(0, close + 1);
        const inner = call.slice(name.length + 1, close);
        const args: string[] = [];
        let lastComma = 0;
        let depth = 0;
        for (let k = 0; k < inner.length; k++) {
            const c = inner[k];
            if (c === "(") {
                depth++;
            } else if (c === ")") {
                depth--;
            } else if (c === "," && depth === 0) {
                args.push(inner.slice(lastComma, k));
                lastComma = k + 1;
            }
        }
        args.push(inner.slice(lastComma));
        if (args.length === names.length) {
            for (let k = 0; k < parts.length; k++) {
                out += parts[k] + (args[tokens[k] ?? 0] ?? "");
            }
            out += rest;
        } else {
            out += call;
        }
        input = after;
        previousLast = after;
        pos = input.indexOf(name + "(");
    }
    return out + input;
}

class Translator {
    private replacements: Replacement[] = [];
    private mode = MODE_EXEC;
    private transFirst: boolean;

    constructor(transFirst: boolean) {
        this.transFirst = transFirst;
    }

    /** translate(): the prefix and the piece, rewritten and ended as the APE handed it to ns-eel. */
    public translate(text: string): string {
        text = this.readSettings(text);
        for (const r of this.replacements) {
            if (r.mode === CASE_SENSITIVE) {
                text = replaceAll(text, r.from, r.to);
            } else if (r.mode === CASE_INSENSITIVE) {
                text = replaceInsensitive(text, r.from, r.to);
            } else {
                text = cStyleReplace(text, r.from, r.to);
            }
        }
        let out = this.transform(text, 0, this.transFirst) + ";" + NEWLINE;
        out = replaceAll(out, "dummyequaldummy", "=");
        out = replaceAll(out, "dummysemicolondummy", ";");
        out = replaceAll(out, "[", "(");
        return replaceAll(out, "]", ")");
    }

    /** transform_code: the statements of `input` in the current mode (`parse` rewrites them). */
    private transform(input: string, indent: number, parse: boolean): string {
        const items = commandSplit(input);
        const out: string[] = [];
        let linearForm = "";
        let assignForm = "";
        for (const raw of items) {
            let item = trim(raw);
            if (item === "") {
                continue;
            }
            linearForm += item + ";" + NEWLINE;
            item = this.command(item, indent);
            const fields = splitLimit(item, "=", 2);
            if (fields.length === 2) {
                const [left = "", right = ""] = fields;
                if (right.includes("=")) {
                    item = "assign(" + left + "," + this.transform(right, indent, true) + ")";
                } else if (parse || left.includes("megabuf[") || left.includes("megabuf(")) {
                    item = "assign(" + left + "," + right + ")";
                }
            }
            assignForm += item + ";" + NEWLINE;
            out.push(item);
        }
        let execForm: string;
        let plusForm: string;
        if (parse) {
            plusForm = out.join("+" + NEWLINE + " ".repeat(indent));
            while (out.length > 1) {
                makeExecs(out);
            }
            execForm = out.length ? out[0] ?? "" : "";
        } else {
            execForm = out.join(";" + NEWLINE);
            plusForm = out.join(";" + NEWLINE);
        }
        switch (this.mode) {
            case MODE_LINEAR: return linearForm;
            case MODE_ASSIGN: return assignForm;
            case MODE_PLUS: return plusForm;
            default: return execForm;
        }
    }

    /** parse_command: a call's arguments each rewritten as code of their own (parse on). */
    private command(input: string, indent: number): string {
        const open = input.indexOf("(");
        if (open === -1) {
            return input;
        }
        const close = closingBracket(input);
        if (close === -1) {
            let broken = replaceAll(input, "=", "dummyequaldummy");
            broken = replaceAll(broken, ";", "dummysemicolondummy");
            broken = replaceAll(broken, "(", "[");
            broken = replaceAll(broken, ")", "]");
            return "BRACKETS[?]->" + broken + "<-BRACKETS";
        }
        const params = input.slice(open + 1, close);
        let out = input.slice(0, open) + "(";
        let lastComma = 0;
        let depth = 0;
        for (let i = 0; i < params.length; i++) {
            const c = params[i];
            if (c === "(") {
                depth++;
            } else if (c === ")") {
                depth--;
            } else if (c === "," && depth === 0) {
                out += this.transform(params.slice(lastComma, i), indent + 1, true) + ",";
                lastComma = i + 1;
            }
        }
        // The original goes on after the closing bracket in mode 2 whatever the mode.
        const mode = this.mode;
        const head = out + this.transform(params.slice(lastComma), indent + 1, true) + ")";
        this.mode = MODE_EXEC;
        const tail = this.command(input.slice(close + 1), indent);
        this.mode = mode;
        return head + tail;
    }

    private preprocessor(line: string): string {
        const parts = splitLimit(line, " ", 3);
        const [command, from = "", to = ""] = parts;
        if (command === "define" && parts.length === 3) {
            this.replacements.push({ from, to, mode: from.includes("(") ? C_STYLE : CASE_INSENSITIVE });
        }
        return "";
    }

    private comment(comment: string): void {
        if (comment[0] !== "$") {
            return;
        }
        const split = comment.indexOf("=");
        if (split === -1) {
            return;
        }
        const left = lower(comment.slice(1, split));
        const right = comment.slice(split + 1);
        if (left === "avstrans_mode") {
            const mode = ["linear", "assign", "exec", "plus"].indexOf(right);
            if (mode !== -1) {
                this.mode = mode;
            }
            return;
        }
        if (left === "avstrans_transfirst") {
            if (right === "0" || right === "no" || right === "off") {
                this.transFirst = false;
            } else if (right === "1" || right === "on" || right === "yes") {
                this.transFirst = true;
            }
            return;
        }
        const arrow = right.indexOf("->");
        // AVS's unsigned arithmetic: without "->" the target is the text after its first character.
        const target = arrow === -1 ? right.slice(1) : right.slice(arrow + 2);
        if (!target) {
            return;
        }
        if (left === "avstrans_replacement") {
            this.replacements.push({ from: arrow === -1 ? right : right.slice(0, arrow), to: target, mode: CASE_INSENSITIVE });
        } else if (left === "avstrans_replacement_casesens" || left === "avstrans_replacement_cstyle") {
            // These two drop the character before "->" (meant to be a space); unsigned again
            // when there is none, or "->" starts the text.
            const from = arrow <= 0 ? right : right.slice(0, arrow - 1);
            this.replacements.push({ from, to: target, mode: left === "avstrans_replacement_cstyle" ? C_STYLE : CASE_SENSITIVE });
        }
    }

    /** read_settings_from_comments: comments out, settings and defines read. */
    private readSettings(input: string): string {
        const next = (s: string): number => {
            const a = s.indexOf("/");
            const b = s.indexOf("#");
            return a === -1 ? b : b === -1 ? a : Math.min(a, b);
        };
        let r = next(input);
        while (r !== -1) {
            if (input[r] === "/") {
                if (input[r + 1] === "*") {
                    const end = input.indexOf("*/", r);
                    input = end === -1 ? input.slice(0, r) : input.slice(0, r) + input.slice(end + 2);
                } else if (input[r + 1] === "/") {
                    const end = input.indexOf(NEWLINE, r);
                    if (end !== -1) {
                        this.comment(input.slice(r + 2, end));
                        input = input.slice(0, r) + input.slice(end + 2);
                    } else {
                        this.comment(input.slice(r + 2));
                        input = input.slice(0, r);
                    }
                } else {
                    input = input.slice(0, r) + PLACEHOLDER + input.slice(r + 1);
                }
            } else {
                const end = input.indexOf(NEWLINE, r);
                if (end !== -1) {
                    input = input.slice(0, r) + this.preprocessor(input.slice(r + 1, end)) + input.slice(end + 2);
                } else {
                    this.preprocessor(input.slice(r + 1));
                    input = input.slice(0, r) + this.preprocessor(input.slice(r + 1));
                }
            }
            r = next(input);
        }
        return replaceAll(input, PLACEHOLDER, "/");
    }
}

/** command_split: the statements at top-level semicolons, or the bracket error form. */
function commandSplit(input: string): string[] {
    input += ";";
    const items: string[] = [];
    let last = 0;
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === "(") {
            depth++;
        } else if (c === ")") {
            depth--;
        } else if (c === ";" && depth === 0) {
            items.push(input.slice(last, i));
            last = i + 1;
        }
    }
    if (depth !== 0) {
        // AVS's bracket error form: it does not compile, there either.
        let broken = replaceAll(input, "=", "dummyequaldummy");
        broken = replaceAll(broken, ";", "dummysemicolondummy");
        broken = replaceAll(broken, "(", "[");
        broken = replaceAll(broken, ")", "]");
        return ["BRACKETS[" + depth + "]->" + broken + "<-BRACKETS"];
    }
    return items;
}

/** make_execs: runs of three into exec3(), a pair left over into exec2() (one pass). */
function makeExecs(items: string[]): void {
    let i = 0;
    for (; i + 2 < items.length; ++i) {
        items[i] = "exec3(" + items[i] + "," + items[i + 1] + "," + items[i + 2] + ")";
        items.splice(i + 1, 2);
    }
    if (items.length - i === 2) {
        items[i] = "exec2(" + items[i] + "," + items[i + 1] + ")";
        items.splice(i + 1, 1);
    }
}

/**
 * One piece of code as AVS compiles it with the AVS Trans prefix in front (each component's code
 * followed by ";\r\n", `avsTransPrefix`) and "translate first level" as configured.
 */
export function translateCode(prefix: string, code: string, transFirst = false): string {
    if (!code || code.startsWith("//$notrans")) {
        return code;
    }
    return new Translator(transFirst).translate(prefix + code);
}

/** The prefix the APE put in front of every piece: each component's global code and ";\r\n". */
export function avsTransPrefix(codes: string[]): string {
    return codes.map((code) => code + ";" + NEWLINE).join("");
}

function components(node: any, out: any[]): any[] {
    if (node && typeof node === "object") {
        if (Array.isArray(node.components)) {
            for (const child of node.components) {
                out.push(child);
                components(child, out);
            }
        }
    }
    return out;
}

/**
 * The preset with its code translated as AVS would, when an AVS Trans Automation in it is
 * enabled; otherwise the preset itself. Changes the given (already copied) preset in place.
 */
export function applyAvsTrans(preset: any): any {
    const all = components(preset, []);
    const trans = all.filter((c) => c && c.type === "AVSTransAutomation");
    // The flags are the APE's globals: the config loaded last (the last component) sets them.
    const last = trans[trans.length - 1];
    if (!last || last.enabled === false) {
        return preset;
    }
    const transFirst = Boolean(last.translateFirstLevel);
    // The code of every instance goes in front, enabled or not.
    const prefix = avsTransPrefix(trans.map((c) => (typeof c.code === "string" ? c.code : "")));
    for (const component of all) {
        if (!component || component.type === "AVSTransAutomation" || component.code === undefined) {
            continue;
        }
        if (typeof component.code === "string") {
            component.code = translateCode(prefix, component.code, transFirst);
        } else if (component.code && typeof component.code === "object") {
            for (const key of CODE_KEYS) {
                if (typeof component.code[key] === "string") {
                    component.code[key] = translateCode(prefix, component.code[key], transFirst);
                }
            }
        }
    }
    return preset;
}
