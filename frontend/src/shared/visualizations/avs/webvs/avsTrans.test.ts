import assert from "node:assert/strict";
import test from "node:test";

import { applyAvsTrans, translateCode } from "./avsTrans.ts";

const CRLF = "\r\n";

test("a C-style #define is expanded with the call's arguments, word by word", () => {
    const prefix = "#define lerp(a,b,t,out) out = a+(b-a)*t;" + CRLF;
    assert.equal(translateCode(prefix, "x1 = 2; lerp(x1,ta,tb,res)"), "x1 = 2;" + CRLF + "res = x1+(ta-x1)*tb;" + CRLF);
    // "t" is a parameter, "tt" and "t2" are not; a call with the wrong count of arguments stays.
    const own = "#define f(t) tt=t2+t" + CRLF;
    assert.equal(translateCode(own, "f(q); f(q,r)"), "tt=t2+q;" + CRLF + "f(q,r);" + CRLF);
});

test("comments go, ## glues tokens, plain defines replace text whatever its case", () => {
    const prefix = "#define VAR(n) v##n" + CRLF + "#define SPEED .5" + CRLF + "/* block */";
    assert.equal(translateCode(prefix, "VAR(1) = speed; // note" + CRLF + "a = 4 / 2"), "v1 = .5;" + CRLF + "a = 4 / 2;" + CRLF);
});

test("//$notrans and empty code are left alone", () => {
    assert.equal(translateCode("#define a b" + CRLF, "//$notrans" + CRLF + "a=1"), "//$notrans" + CRLF + "a=1");
    assert.equal(translateCode("#define a b" + CRLF, ""), "");
});

test("only a preset with an enabled AVS Trans Automation is translated", () => {
    const macro = "#define twice(x) x*2" + CRLF;
    const make = (enabled: boolean): any => ({
        components: [
            { type: "AVSTransAutomation", enabled, code: macro },
            { type: "EffectList", code: { enabled: true, init: "", perFrame: "y=twice(3)" }, components: [
                { type: "Movement", code: "d=twice(d)" }
            ] }
        ]
    });
    const on = applyAvsTrans(make(true));
    assert.equal(on.components[1].code.perFrame, "y=3*2;" + CRLF);
    assert.equal(on.components[1].code.init, "");
    assert.equal(on.components[1].components[0].code, "d=d*2;" + CRLF);
    assert.equal(on.components[0].code, macro);
    const off = applyAvsTrans(make(false));
    assert.equal(off.components[1].code.perFrame, "y=twice(3)");
});

test("exec mode (the APE's default): sequences and assignments in arguments become exec2/exec3 and assign", () => {
    // A sequence inside a call's argument: 2.81 cut the piece at every `;`, the APE nested it.
    assert.equal(translateCode("", "if(fb, pbt=gettime(start); x=1, 0)"),
        "if(fb,exec2(assign(pbt,gettime(start)),assign(x,1)),0);" + CRLF);
    // Four statements: exec3 of the first three, exec2 with the fourth.
    assert.equal(translateCode("", "loop(n, a=a+1; b=b+a; c=c*b; d=1)"),
        "loop(n,exec2(exec3(assign(a,a+1),assign(b,b+a),assign(c,c*b)),assign(d,1)));" + CRLF);
    // At the top level the statements stay, but an assignment to megabuf(…) or megabuf[…] is
    // always rewritten, and [ ] become ( ).
    assert.equal(translateCode("", "x = 1; megabuf[i] = 2"), "x = 1;" + CRLF + "assign(megabuf(i) , 2);" + CRLF);
    // a=b=c: the right side is code of its own.
    assert.equal(translateCode("", "a=b=c"), "assign(a,assign(b,c));" + CRLF);
});

test("translate first level, the mode comment, and the prefix of every component's code", () => {
    assert.equal(translateCode("", "x=1; y=2", true), "exec2(assign(x,1),assign(y,2));" + CRLF);
    // linear: the statements as written; the APE's tail (a semicolon and a line break) follows any output.
    assert.equal(translateCode("", "//$avstrans_mode=linear" + CRLF + "if(a, b=1; c=2, 0)"), "if(a, b=1; c=2, 0);" + CRLF + ";" + CRLF);
    const preset: any = {
        components: [
            { type: "AVSTransAutomation", enabled: true, translateFirstLevel: true, code: "#define one 1" },
            { type: "SuperScope", code: { perFrame: "t=one; u=2" } }
        ]
    };
    assert.equal(applyAvsTrans(preset).components[1].code.perFrame, "exec2(assign(t,1),assign(u,2));" + CRLF);
});
