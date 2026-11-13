// @ts-nocheck — vendored from webvs 3.0.0 (MIT, see LICENSE-webvs.txt); kept close to upstream.
import difference from "lodash-es/difference";
import each from "lodash-es/each";
import flatten from "lodash-es/flatten";
import flow from "lodash-es/flow";
import intersection from "lodash-es/intersection";
import isArray from "lodash-es/isArray";
import isEqual from "lodash-es/isEqual";
import isNumber from "lodash-es/isNumber";
import keys from "lodash-es/keys";
import map from "lodash-es/map";
import { default as pr } from "lodash-es/partialRight";
import pick from "lodash-es/pick";
import takeRight from "lodash-es/takeRight";
import union from "lodash-es/union";
import uniq from "lodash-es/uniq";
import values from "lodash-es/values";
import {glslFloatRepr, noop} from "../utils";
import * as Ast from "./Ast";
import CodeInstance from "./CodeInstance";
// Fork: the pegjs grammar is replaced by eel-wasm's parser, and per-frame code is
// compiled to closures instead of `new Function` (see ../../eel.ts).
import { compileProgram, EXTRA_FUNCTIONS, parse } from "../../eel";
// Fork: the same sections as WebAssembly once they first run, where it can mirror them exactly.
import { attachWasm } from "../../eel-wasm-backend";
import { bindAudioVariables } from "../mscopes/audioVars";

export interface ICompileResult {
    codeInst: CodeInstance;
    glslCode: string;
}

export default function compileExpr(
    codeSrc: {[name: string]: string | string[]},
    jsFuncs: string[] = [],
    glslFuncs: string[] = [],
    nonUniforms: string[] = [],
): ICompileResult {
    const codeStrings: {[name: string]: string} = {};
    for (const name in codeSrc) {
        // Fork: webvsc keeps bookkeeping such as `_hidden` beside the code sections.
        if (!codeSrc.hasOwnProperty(name) || name.startsWith("_")) {
            continue;
        }
        let codeString = codeSrc[name];
        if (isArray(codeString)) {
            codeString = codeString.join("\n");
        }
        // Fork: webvsc keeps flags such as `enabled: true` among the code sections.
        if (typeof codeString === "boolean") {
            continue;
        }
        // Fork: webvsc leaves some empty sections as null or numbers.
        if (typeof codeString !== "string") {
            codeString = codeString == null ? "" : String(codeString);
        }
        // Fork: white space as AVS has it. String.trim also takes a no-break space, which is the
        // byte 0xA0 to ns-eel: a section that begins with such a note (Tuggummi's " scope code ;")
        // lost it and failed on "scope code" (ns-eel-syntax.ts).
        codeString = codeString.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
        if (codeString.length === 0) {
            continue;
        }
        codeStrings[name] = codeString;
    }

    // 1) Parse the code
    // Fork: the dialect Main.loadPreset found for the preset (eel2-parser.ts presetEelDialect).
    const dialect = (codeSrc as {_dialect?: unknown})._dialect === "eel2" ? "eel2" : "ns-eel";
    // Fork: a preset's code (Main.loadPreset or Movement marked its dialect) compiles as in AVS,
    // a whole section or nothing; this project's own scripts (mscopes) keep what reads.
    const strict = typeof (codeSrc as {_dialect?: unknown})._dialect === "string";
    const codeAst = parseCode(codeStrings, dialect, strict);
    // 2) Process the AST
    const tables = processAst(codeAst, jsFuncs, glslFuncs, nonUniforms);
    // 3) Generate code
    const codeInst = generateJs(codeAst, tables, jsFuncs);
    // Fork: mscopes' extra audio variables (kick, level, …) for scripts that read them unassigned.
    bindAudioVariables(codeInst, codeAst);
    // Fork: the sections AVS compiled to code at all. NSEEL_code_compile gave no handle for an
    // empty section or a failed one, and effects such as Dynamic Shift test the handle.
    (codeInst as any).compiled = Object.fromEntries(jsFuncs.map((name) => {
        const ast = codeAst[name] as any;
        return [name, Boolean(ast && ast.statements && ast.statements.length > 0)];
    }));
    attachWasm(codeInst, codeAst, jsFuncs);
    const glslCode = generateGlsl(codeAst, tables, glslFuncs);

    return {codeInst, glslCode};
}

interface ICodeAst {[name: string]: Ast.Program; }

function parseCode(codeSrc: {[name: string]: string}, dialect: "ns-eel" | "eel2", strict: boolean): ICodeAst {
    const codeAst: ICodeAst = {}; // abstract syntax tree
    for (const name in codeSrc) {
        if (!codeSrc.hasOwnProperty(name)) {
            continue;
        }
        try {
            // Fork: EEL2's functions are callable from every section of the effect.
            const siblings = Object.keys(codeSrc).filter((other) => other !== name).map((other) => codeSrc[other]);
            const program = parse(codeSrc[name], { dialect, siblings, strict }) as Ast.Program;
            // Fork: a statement that does not compile — an unknown function (a preset's typo like
            // log13) or a wrong count of arguments — does not lose the preset. In a preset's code
            // the section is then no code, as AVS's compiler returned none for it
            // (NSEEL_code_compile); elsewhere only that statement is left out.
            if (strict && program.statements.some((statement) => statementProblem(statement))) {
                program.statements = [];
            } else {
                program.statements = program.statements.filter((statement) => !statementProblem(statement));
            }
            codeAst[name] = program;
        } catch (e) {
            throw new Error("Error parsing " + name + " (" + e.line + ":" + e.column + ")" + " : " + e);
        }
    }
    return codeAst;
}

function isStaticExprList(exprs: Ast.Expression[]): exprs is Ast.PrimaryExpr[] {
    return exprs.every((expr) => {
        return expr instanceof Ast.PrimaryExpr;
    });
}

interface ISymbolTables {
    register: {[name: string]: string[]};
    preCompute: {[uniformName: string]: string[]};
    jsVars: string[];
    glslVars: string[];
    nonUniforms: string[];
    uniforms: string[];
    glslUsedFuncs: string[];
    glslRegisters: string[];
}

function processAst(
    codeAst: ICodeAst,
    jsFuncs: string[],
    glslFuncs: string[],
    extraNonUniforms: string[],
): ISymbolTables {
    const funcCall: {[name: string]: string[]} = {};
    const variable: {[name: string]: string[]} = {};
    const register: {[name: string]: string[]} = {};
    const preCompute: {[uniformName: string]: string[]} = {};

    let preComputeCounter = 0;

    const processNode = (ast, name) => {
        if (ast instanceof Ast.Program) {
            for (const statement of ast.statements) {
                processNode(statement, name);
            }
        } else if (ast instanceof Ast.BinaryExpr) {
            processNode(ast.leftOperand, name);
            processNode(ast.rightOperand, name);
        } else if (ast instanceof Ast.UnaryExpr) {
            processNode(ast.operand, name);
        } else if (ast instanceof Ast.FuncCall) {
            checkFunc(ast);

            // if its a precomputable function to be generated in glsl
            // then build a table entry
            if (glslFuncs.indexOf(name) >= 0 && glslPreComputeFuncs.indexOf(ast.funcName) >= 0) {
                const args = ast.args;
                if (!isStaticExprList(args)) {
                    throw new Error(
                        `Non Pre-Computable arguments for ${ast.funcName} in shader code, use variables or constants`,
                    );
                }
                const entry = [ast.funcName].concat(map(args, (arg) => arg.value));
                let uniformName;
                for (const key in preCompute) {
                    if (isEqual(preCompute[key], entry)) {
                        uniformName = key;
                        break;
                    }
                }
                if (!uniformName) {
                    uniformName = "__PC_" +  ast.funcName + "_" + preComputeCounter++;
                    preCompute[uniformName] = entry;
                }

                ast.preComputeUniformName = uniformName;
            }

            funcCall[name].push(ast.funcName);
            for (const arg of ast.args) {
               processNode(arg, name);
            }
        } else if (ast instanceof Ast.Assignment) {
            processNode(ast.lhs, name);
            processNode(ast.expr, name);
        } else if (ast instanceof Ast.PrimaryExpr && ast.type === "ID") {
            variable[name].push(ast.value);
        } else if (ast instanceof Ast.PrimaryExpr && ast.type === "REG") {
            register[name].push(ast.value);
        }
    };

    for (const name in codeAst) {
        if (!codeAst.hasOwnProperty(name)) {
            continue;
        }
        funcCall[name] = [];
        variable[name] = [];
        register[name] = [];

        processNode(codeAst[name], name);

        funcCall[name] = uniq(funcCall[name]);
        variable[name] = uniq(variable[name]);
        register[name] = uniq(register[name]);
    }

    const jsVars: string[] = flow([pr(pick, jsFuncs), values, flatten, uniq])(variable);
    const glslVars: string[] = flow([pr(pick, glslFuncs), values, flatten, uniq])(variable);
    const nonUniforms: string[] = flow([pr(difference, jsVars), pr(union, extraNonUniforms), uniq])(glslVars);
    const uniforms: string[]  = intersection(glslVars, jsVars);
    const glslUsedFuncs: string[] = flow([pr(pick, glslFuncs), values, flatten, uniq])(funcCall);
    const glslRegisters: string[] = flow([pr(pick, glslFuncs), values, flatten, uniq])(register);

    return {
        glslRegisters, glslUsedFuncs, glslVars, jsVars, nonUniforms, preCompute, register, uniforms,
    };
}

function generateJs(codeAst: ICodeAst, tables: ISymbolTables, jsFuncs: string[]): CodeInstance {
    const generateNode = (ast) => {
        if (ast instanceof Ast.BinaryExpr) {
            return "(" + generateNode(ast.leftOperand) + ast.operator + generateNode(ast.rightOperand) + ")";
        }
        if (ast instanceof Ast.UnaryExpr) {
            return "(" + ast.operator + generateNode(ast.operand) + ")";
        }
        if (ast instanceof Ast.FuncCall) {
            switch (ast.funcName) {
                case "above":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        ">",
                        generateNode(ast.args[1]),
                        "?1:0)",
                    ].join("");
                case "below":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "<",
                        generateNode(ast.args[1]),
                        "?1:0)",
                    ].join("");
                case "equal":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "==",
                        generateNode(ast.args[1]),
                        "?1:0)",
                    ].join("");
                case "if":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "!==0?",
                        generateNode(ast.args[1]),
                        ":",
                        generateNode(ast.args[2]),
                        ")",
                    ].join("");
                case "select":
                    const code = ["((function() {"];
                    code.push("switch(" + generateNode(ast.args[0]) + ") {");
                    each(takeRight(ast.args, ast.args.length - 1), (arg, i) => {
                        code.push("case " + i + ": return " + generateNode(arg) + ";");
                    });
                    code.push("default : throw new Error('Unknown selector value in select');");
                    code.push("}}).call(this))");
                    return code.join("");
                case "sqr":
                    return "(Math.pow((" + generateNode(ast.args[0]) + "),2))";
                case "band":
                    return "(((" + generateNode(ast.args[0]) + ")&&(" + generateNode(ast.args[1]) + "))?1:0)";
                case "bor":
                    return "(((" + generateNode(ast.args[0]) + ")||(" + generateNode(ast.args[1]) + "))?1:0)";
                case "bnot":
                    return "((!(" + generateNode(ast.args[0]) + "))?1:0)";
                case "invsqrt":
                    return "(1/Math.sqrt(" + generateNode(ast.args[0]) + "))";
                case "atan2":
                    return "(Math.atan((" + generateNode(ast.args[0]) + ")/(" + generateNode(ast.args[1]) + ")))";
                default:
                    let prefix;
                    const args = map(ast.args, (arg) => generateNode(arg)).join(",");
                    if (jsMathFuncs.indexOf(ast.funcName) >= 0) {
                        prefix = "Math.";
                    } else {
                        prefix = "this.";
                    }
                    return "(" + prefix + ast.funcName + "(" + args + "))";
            }
        }
        if (ast instanceof Ast.Assignment) {
            return generateNode(ast.lhs) + "=" + generateNode(ast.expr);
        }
        if (ast instanceof Ast.Program) {
            const stmts = map(ast.statements, (stmt) => generateNode(stmt));
            return stmts.join(";\n");
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "VALUE") {
            return ast.value.toString();
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "CONST") {
            return translateConstants(ast.value).toString();
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "ID") {
            return "this." + ast.value;
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "REG") {
            return "this.registerBank[\"" + ast.value + "\"]";
        }
    };

    const registerUsages = flow([values, flatten, uniq])(tables.register);
    const hasRandom = tables.glslUsedFuncs.indexOf("rand") >= 0;
    const codeInst = new CodeInstance(
        registerUsages,
        tables.glslRegisters,
        hasRandom,
        tables.uniforms,
        tables.preCompute,
    );

    // clear all variables
    for (const jsVar of tables.jsVars) {
        codeInst[jsVar] = 0;
    }

    // generate code
    for (const name of jsFuncs) {
        const ast = codeAst[name];
        if (ast) {
            codeInst[name] = compileProgram(ast);
        } else {
            codeInst[name] = noop;
        }
    }

    return codeInst;
}

function generateGlsl(codeAst: ICodeAst, tables: ISymbolTables, glslFuncs: string[]): string {
    const generateNode = (ast) => {
        if (ast instanceof Ast.BinaryExpr) {
            // Fork: GLSL ES has no float %, & or |; AVS means them on integers.
            if (ast.operator === "%") {
                return "mod(floor(" + generateNode(ast.leftOperand) + "),floor(" + generateNode(ast.rightOperand) + "))";
            }
            if (ast.operator === "&" || ast.operator === "|") {
                return "(" + generateNode(ast.leftOperand) + (ast.operator === "&" ? "*" : "+") + generateNode(ast.rightOperand) + ")";
            }
            return "(" + generateNode(ast.leftOperand) + ast.operator + generateNode(ast.rightOperand) + ")";
        }
        if (ast instanceof Ast.UnaryExpr) {
            return "(" + ast.operator + generateNode(ast.operand) + ")";
        }
        if (ast instanceof Ast.FuncCall) {
            if (ast.preComputeUniformName) {
                return "(" + ast.preComputeUniformName + ")";
            }
            switch (ast.funcName) {
                case "above":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        ">",
                        generateNode(ast.args[1]),
                        "?1.0:0.0)",
                    ].join("");
                case "below":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "<",
                        generateNode(ast.args[1]),
                        "?1.0:0.0)",
                    ].join("");
                case "equal":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "==",
                        generateNode(ast.args[1]),
                        "?1.0:0.0)",
                    ].join("");
                case "if":
                    return [
                        "(",
                        generateNode(ast.args[0]),
                        "!=0.0?",
                        generateNode(ast.args[1]),
                        ":",
                        generateNode(ast.args[2]),
                        ")",
                    ].join("");
                case "select": {
                    const selectExpr = generateNode(ast.args[0]);
                    const generateSelect = (args, i) => {
                        if (args.length === 1) {
                            return generateNode(args[0]);
                        } else {
                            return [
                                "((" + selectExpr + " === " + i + ")?",
                                "(" + generateNode(args[0]) + "):",
                                "(" + generateSelect(takeRight(args, args.length - 1), i + 1) + "))",
                            ].join("");
                        }
                    };
                    return generateSelect(takeRight(ast.args, ast.args.length - 1), 0);
                }
                case "sqr":
                    return "(pow((" + generateNode(ast.args[0]) + "), 2))";
                case "band":
                    return "((" + generateNode(ast.args[0]) + ")!=0.0&&(" + generateNode(ast.args[1]) + ")!=0.0?1.0:0.0)";
                case "bor":
                    return "((" + generateNode(ast.args[0]) + ")!=0.0||(" + generateNode(ast.args[1]) + ")!=0.0?1.0:0.0)";
                case "bnot":
                    return "((" + generateNode(ast.args[0]) + ")==0.0?1.0:0.0)";
                case "invsqrt":
                    return "(1/sqrt(" + generateNode(ast.args[0]) + "))";
                case "atan2":
                    return "(atan((" + generateNode(ast.args[0]) + "),(" + generateNode(ast.args[1]) + "))";
                default: {
                    const args = map(ast.args, (arg) => generateNode(arg)).join(",");
                    return "(" + ast.funcName + "(" + args + "))";
                }
            }
        }
        if (ast instanceof Ast.Assignment) {
            return generateNode(ast.lhs) + "=" + generateNode(ast.expr);
        }
        if (ast instanceof Ast.Program) {
            const stmts = map(ast.statements, (stmt) => generateNode(stmt));
            return stmts.join(";\n") + ";";
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "VALUE") {
            return glslFloatRepr(ast.value);
        }
        if (ast instanceof Ast.PrimaryExpr && ast.type === "CONST") {
            return translateConstants(ast.value).toString();
        }
        if (ast instanceof Ast.PrimaryExpr && (ast.type === "ID" || ast.type === "REG")) {
            return ast.value;
        }
    };

    let glslCode = [];

    // glsl variable declarations
    glslCode = glslCode.concat(map(tables.nonUniforms, (name) => {
        return "float " + name + " = 0.0;";
    }));
    glslCode = glslCode.concat(map(tables.uniforms, (name) => {
        return "uniform float " + name + ";";
    }));
    // include required functions in glsl
    glslCode = glslCode.concat(flow([
        pr(map, (name) => {
            return ((name in glslFuncCode) ? (glslFuncCode[name]) : []);
        }),
        flatten,
    ])(tables.glslUsedFuncs));

    // declarations for precomputed functions
    glslCode = glslCode.concat(flow([
        keys,
        pr(map, (name) => {
            return "uniform float " + name + ";";
        }),
    ])(tables.preCompute));

    // add the functions
    for (const name of glslFuncs) {
        const ast = codeAst[name];
        if (ast) {
            const codeString = generateNode(ast);
            glslCode.push("void " + name + "() {");
            glslCode.push(codeString);
            glslCode.push("}");
        } else {
            glslCode.push("void " + name + "() {}");
        }
    }

    return glslCode.join("\n");
}

type ArgLength = number | {min: number};
const funcArgLengths: {[funcName: string]: ArgLength} = {
    above: 2,
    abs: 1,
    acos: 1,
    asin: 1,
    atan: 1,
    atan2: 2,
    band: 2,
    below: 2,
    bnot: 1,
    bor: 2,
    ceil: 1,
    cos: 1,
    equal: 2,
    floor: 1,
    getosc: 3,
    gettime: 1,
    if: 3,
    invsqrt: 1,
    log: 1,
    max: 2,
    min: 2,
    pow: 2,
    rand: 1,
    select: {
        min: 2,
    },
    sin: 1,
    sqr: 1,
    sqrt: 1,
    tan: 1,
};

Object.assign(funcArgLengths, EXTRA_FUNCTIONS);

const jsMathFuncs = [
    "min", "max", "sin", "cos", "abs", "tan", "asin", "acos",
    "atan", "log", "pow", "sqrt", "floor", "ceil",
];

const glslPreComputeFuncs = ["getosc", "gettime"];

const glslFuncCode = {
    rand: [
        "uniform vec2 __randStep;",
        "vec2 __randSeed;",
        "float rand(float max) {",
        "   __randSeed += __randStep;",
        "   float val = fract(sin(dot(__randSeed.xy ,vec2(12.9898,78.233))) * 43758.5453);",
        "   return (floor(val*max)+1);",
        "}",
    ].join("\n"),
};

/** Fork: what would make a call fail to compile (unknown function, wrong argument count), or null. */
function callProblem(ast: Ast.FuncCall): string | null {
    const requiredArgLength = funcArgLengths[ast.funcName];
    if (requiredArgLength === undefined) {
        return "Unknown function " + ast.funcName;
    }
    if (isNumber(requiredArgLength)) {
        if (ast.args.length !== requiredArgLength) {
            return ast.funcName + " accepts " + requiredArgLength + " arguments";
        }
    } else if (requiredArgLength.min) {
        if (ast.args.length < requiredArgLength.min) {
            return ast.funcName + " accepts atleast " + requiredArgLength.min + " arguments";
        }
    }
    return null;
}

/** Fork: the first call in a statement that would not compile, or null. */
function statementProblem(node: Ast.Statement): string | null {
    if (node instanceof Ast.BinaryExpr) {
        return statementProblem(node.leftOperand) || statementProblem(node.rightOperand);
    }
    if (node instanceof Ast.UnaryExpr) {
        return statementProblem(node.operand);
    }
    if (node instanceof Ast.Assignment) {
        return statementProblem(node.expr);
    }
    if (node instanceof Ast.FuncCall) {
        const own = callProblem(node);
        if (own) {
            return own;
        }
        for (const arg of node.args) {
            const inner = statementProblem(arg);
            if (inner) {
                return inner;
            }
        }
    }
    return null;
}

function checkFunc(ast: Ast.FuncCall) {
    const problem = callProblem(ast);
    if (problem) {
        throw Error(problem);
    }
}

function translateConstants(value: string): number {
    switch (value) {
        case "pi": return Math.PI;
        case "e": return Math.E;
        case "phi": return 1.6180339887;
        default: throw new Error("Unknown constant " + value);
    }
}
