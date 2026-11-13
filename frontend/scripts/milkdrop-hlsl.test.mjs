import assert from "node:assert/strict";
import test from "node:test";

import { RewriteError, logicalOperators, preprocess, rewriteShader, tokenize, untokenize } from "./milkdrop-hlsl.mjs";

/** Spacing aside: the rewriter keeps the original's, which is beside the point here. */
const squash = (text) => text.replace(/\s+/g, "");
const body = (statement) => squash(rewriteShader(`shader_body {\n${statement}\n}`)).replace(/^shader_body\{|\}$/g, "");

test("every operator chain comes out fully parenthesised, by C precedence", () => {
  assert.equal(body("ret = a + b + c + d;"), "ret=(((a+b)+c)+d);");
  assert.equal(body("ret = a * b + c * d;"), "ret=((a*b)+(c*d));");
  assert.equal(body("ret = a + b * c - d / e;"), "ret=((a+(b*c))-(d/e));");
  assert.equal(body("ret = a - b - c;"), "ret=((a-b)-c);");
  assert.equal(body("ret = a < b + c && d >= e || f;"), "ret=(((a<(b+c))&&(d>=e))||f);");
});

test("unary operators, ternaries, swizzles and calls keep their meaning", () => {
  assert.equal(body("ret = -a + b + c;"), "ret=((-a+b)+c);");
  assert.equal(body("ret = a > 0 ? b + c : d * e;"), "ret=((a>0)?(b+c):(d*e));");
  assert.equal(body("ret.xy += uv.yx * q1 * q2;"), "ret.xy+=((uv.yx*q1)*q2);");
  assert.equal(body("ret = sin(a + b + c) * tex2D(sampler_main, uv * 2 + 1).xyz;"), "ret=(sin(((a+b)+c))*tex2D(sampler_main,((uv*2)+1)).xyz);");
  assert.equal(body("ret = (float)a * b;"), "ret=(((float)a)*b);");
});

test("a constructor alone in parentheses loses them — hlslparser cannot parse it before an operator", () => {
  // Right after a `(` hlslparser reads a constructor as a parenthesised one and stops after it:
  // a unary `+` (which changes nothing) keeps `.z` and the operators after it readable.
  assert.equal(body("ret = (float3(1,0,0)) * q1;"), "ret=(+float3(1,0,0)*q1);");
  assert.equal(body("ret = float3(q1,q2,q3).z * 2;"), "ret=(+float3(q1,q2,q3).z*2);");
  assert.equal(body("uvt = float2(q1,q2).xy + uv;"), "uvt=(+float2(q1,q2).xy+uv);");
  // With an operator inside, the parentheses are an expression's and stay (and
  // gain a pair of the rewrite's own, which changes nothing).
  assert.equal(body("ret = (float3(1,0,0) * q1) + q2;"), "ret=(((+float3(1,0,0)*q1))+q2);");
  // Not in front of anything else, and never on a bool (GLSL has no unary + for it).
  assert.equal(body("ret = uv.x * float3(1,0,0);"), "ret=(uv.x*float3(1,0,0));");
  assert.equal(body("b = bool2(x, y).x && c;"), "b=(bool2(x,y).x&&c);");
});

test("for headers hlslparser does not read: empty clauses, and the comma operator in them", () => {
  assert.equal(body("for (; i++ < 9; ) { ret += 1; }"), "for(0;(i++<9);0){ret+=1;}");
  // Several steps: at the end of the body, in order, and before every continue of the loop.
  assert.equal(body("for (; i++ < 9; z += d, o += c / z) { d = 1; }"), "for(0;(i++<9);0){d=1;z+=d;o+=(c/z);}");
  assert.equal(body("for (; i < 9; i += 1, j += 2) { if (j > 3) continue; k++; }"),
    "for(0;(i<9);0){if((j>3)){i+=1;j+=2;continue;}k++;i+=1;j+=2;}");
  // An unbraced body, a loop itself.
  assert.equal(body("for (; i < 2; a += 1, b += 1) for (j = 0; j < 2; j++) c += j;"),
    "for(0;(i<2);0){for(j=0;(j<2);j++)c+=j;a+=1;b+=1;}");
  // Several expressions first: statements in a block before the loop; a declaration stays.
  assert.equal(body("for (a = 1, b = 2; i < 3; i++) c += a;"), "{a=1;b=2;for(0;(i<3);i++)c+=a;}");
  assert.equal(body("for (float e = 0, f = 1; e < 3; e++) c += f;"), "for(floate=0,f=1;(e<3);e++)c+=f;");
});

test("the comma operator in parentheses keeps its last value, as HLSL's does", () => {
  // hlslparser would read the group as two more arguments of lerp.
  assert.equal(body("ret = lerp(a, 1, (max(b, c), max(d, e)));"), "ret=lerp(a,1,(max(d,e)));");
  assert.equal(body("ret = (a, b + c) * 2;"), "ret=(((b+c))*2);");
  // Calls, casts and a group whose earlier value assigns are left alone.
  assert.equal(body("x = f(a, b); z = (i++, j);"), "x=f(a,b);z=(i++,j);");
});

test("pow, sqrt, rsqrt and log as MilkDrop's compiler (legacy d3dx9_31) builds them", () => {
  const shader = (statement) => squash(rewriteShader(`shader_body {\n${statement}\n}`));
  const statement = (statement) => shader(statement).replace(/^[\s\S]*shader_body\{|\}$/g, "");
  // |x| where D3D9's pow, rsq and log instructions take it.
  assert.equal(statement("ret = pow(x, 1.7) + pow(x, q1);"), "ret=(pow(abs(x),1.7)+pow(abs(x),q1));");
  assert.equal(statement("ret = sqrt(x) * log(y) + rsqrt(z) + log2(w);"), "ret=(((sqrt(abs(x))*log(abs(y)))+rsqrt(abs(z)))+log2(abs(w)));");
  // A constant exponent it writes out: signed multiplications, a reciprocal, x itself, 1.
  assert.equal(statement("ret = pow(x, 3) + pow(x, -2.0f) + pow(x, 1) + pow(x, 1.0 / 2.0);"),
    "ret=(((hlsl_pow_3(x)+hlsl_pow_m2(x))+(x))+hlsl_pow_h(x));");
  // 7 and 16 are the pow instruction again.
  assert.equal(statement("ret = pow(x, 7) + pow(x, 16);"), "ret=(pow(abs(x),7)+pow(abs(x),16));");
  // A constant vector: a component of 1 is x itself, of 0 is 1; without them, log·mul·exp of |x|.
  assert.equal(statement("ret = pow(v, float3(5, 1, .5)) + pow(v, float3(.6, .95, 5));"),
    "ret=(hlsl_pow_v(v,float3(5,1,.5))+pow(abs(v),float3(.6,.95,5)));");
  // A named constant folds as the DLL folds it: a static global (const or not) and a local never
  // assigned again; a global without `static` is a uniform, a reassigned local a variable.
  const folded = (source) => squash(rewriteShader(source)).replace(/^[\s\S]*shader_body\{|\}$/g, "");
  assert.equal(folded("static const float K = 3;\nconst float U = 3;\nstatic float S = 5;\nshader_body {\nret = pow(x, K) + pow(x, U) + pow(x, S);\n}"),
    "ret=((hlsl_pow_3(x)+pow(abs(x),U))+hlsl_pow_5(x));");
  assert.equal(folded("shader_body {\nfloat k = 3; float m = 3; m += 1; const int n = -1;\nret = pow(x, k) + pow(x, m) + pow(x, n);\n}"),
    "floatk=3;floatm=3;m+=1;constintn=-1;ret=((hlsl_pow_3(x)+pow(abs(x),m))+hlsl_pow_m1(x));");
  assert.equal(folded("static const float3 E = float3(5, 1, 0);\nshader_body {\nret = pow(v, E) + pow(v.z, E.x);\n}"),
    "ret=(hlsl_pow_v(v,E)+hlsl_pow_5(v.z));");
  // Written through an out parameter, or declared twice: left a variable.
  assert.equal(folded("shader_body {\nfloat s = 0, c = 1; sincos(a, s, c);\nret = pow(x, s);\n}"), "floats=0,c=1;sincos(a,s,c);ret=pow(abs(x),s);");
  // The helpers come along, one of each shape, only those used.
  const text = rewriteShader("shader_body {\nret = pow(x, 3);\n}");
  assert.match(text, /^float3 hlsl_pow_3\(float3 x\) \{ return x \* \(x \* x\); \}$/m);
  assert.doesNotMatch(text, /hlsl_pow_2/);
});

test("HLSL's float indices and flattened array initializers, written as GLSL ES reads them", () => {
  // A float index is truncated in HLSL; GLSL ES wants int(…). A plain number and a declaration's size stay.
  assert.match(body("ret = tab[u.x % 4][2];"), /shader_body\{ret=tab\[int\(hlsl_fmod\(u\.x,4\)\)\]\[2\];$/);
  assert.equal(body("float a[4]; ret = a[i + 1];"), "floata[4];ret=a[int((i+1))];");
  // float spec[8] from two float4s: one value an element, component by component.
  assert.equal(body("static const float spec[8] = {frac(_qa), _qb};"),
    "staticconstfloatspec[8]={(+(frac(_qa))).x,(+(frac(_qa))).y,(+(frac(_qa))).z,(+(frac(_qa))).w,(+(_qb)).x,(+(_qb)).y,(+(_qb)).z,(+(_qb)).w};");
  // Already one value an element: as it was.
  assert.equal(body("float b[2] = {1, 2};"), "floatb[2]={1,2};");
  // float4 s[2] from eight numbers: grouped into constructors.
  assert.equal(body("const float4 s[2] = { -1.0, 0.0, 0, 0.25, 1.0, 0.0, 0, 0.25 };"),
    "constfloat4s[2]={float4(-1.0,0.0,0,0.25),float4(1.0,0.0,0,0.25)};");
  assert.equal(body("float2 t[2] = { a, b };"), "float2t[2]={a,b};");
});

test("#if takes expressions, as a C preprocessor does (BeatDrop's #if HAS_FFT_PEAK)", async () => {
  const { evaluateCondition } = await import("./milkdrop-hlsl.mjs");
  const defines = preprocess(tokenize("#define HAS_FFT_PEAK 1\n#define TWO 2\n").tokens);
  assert.deepEqual(defines, []);
  assert.equal(body("#define HAS_FFT_PEAK 1\n#if HAS_FFT_PEAK\nret = 1;\n#else\nret = 2;\n#endif"), "ret=1;");
  assert.equal(body("#if defined(NOPE) || 2 > 3\nret = 1;\n#elif !defined(NOPE) && (1 + 1) * 2 == 4\nret = 3;\n#endif"), "ret=3;");
  assert.equal(evaluateCondition("UNKNOWN"), 0);
  assert.equal(evaluateCondition("(7 / 2) % 2 ? 10 : 20"), 10);
  assert.throws(() => evaluateCondition("1.5"), RewriteError);
});

test("statements, declarations and loops: only their expressions change", () => {
  assert.equal(body("if (a > b) ret = c + d + e; else ret = 0;"), "if((a>b))ret=((c+d)+e);elseret=0;");
  assert.equal(body("for (int i = 0; i < n + 1 + m; i++) { ret += i; }"), "for(inti=0;(i<((n+1)+m));i++){ret+=i;}");
  assert.equal(body("float3 x = a + b + c, y = 2;"), "float3x=((a+b)+c),y=2;");
  assert.equal(body("float2x2 r = { a - 0.1 - b, c, -d, e };"), "float2x2r={((a-0.1)-b),c,-d,e};");
});

test("text without an operator chain is returned as it was, spacing included", () => {
  const header = "sampler sampler_pw_noise_lq;\nsampler2D sampler_pic;\n\nshader_body\n{\n    ret = tex2D(sampler_main, uv).xyz;\n}";
  // prepareShader removes "sampler sampler_pw_noise_lq;\n" by exact text, so the line must survive as it is.
  assert.equal(rewriteShader(header), header);
  const { tokens, trailing } = tokenize(header);
  assert.equal(untokenize(tokens, trailing), header);
});

test("the prelude's macros are expanded, so their own chains are parenthesised too", () => {
  // GetBlur1 is tex2D(...).xyz*scale1 + bias1: the chain the bug turns into &&.
  assert.equal(body("ret = GetBlur1(uv) * 2;"), "ret=((((tex2D(sampler_blur1,uv).xyz*scale1)+bias1))*2);");
  assert.equal(body("ret = lum(GetPixel(uv));"), "ret=(dot((tex2D(sampler_main,uv).xyz),float3(0.32,0.49,0.29)));");
  // A variable may share lum's name: only lum( is the macro.
  assert.equal(body("float lum = lum(ret); ret = lum * 2;"), "floatlum=(dot(ret,float3(0.32,0.49,0.29)));ret=(lum*2);");
});

test("a preset's own #defines and #if blocks are resolved the way a preprocessor would", () => {
  const source = "#define MyGet GetPixel //GetBlur1\n#define sat saturate\n#if 0\nret = 1;\n#else\nret = sat(MyGet(uv) + a + b);\n#endif\n";
  assert.equal(squash(rewriteShader(source)), "ret=saturate((((tex2D(sampler_main,uv).xyz)+a)+b));");
  assert.throws(() => rewriteShader("#include \"other.fx\"\nret = 1;"), RewriteError);
  assert.throws(() => rewriteShader("#if 1\nret = 1;"), RewriteError);
});

test("a macro that names itself is not expanded for ever", () => {
  const tokens = preprocess(tokenize("#define a a + 1\nret = a;").tokens);
  assert.equal(squash(untokenize(tokens)), "ret=a+1;");
});

test("logical operators are counted, the bug's signature being an extra &&", () => {
  assert.deepEqual(logicalOperators("a && b || c && d"), { and: 2, or: 1 });
  assert.deepEqual(logicalOperators("ret = a + b;"), { and: 0, or: 0 });
});

let tools = null;
try {
  tools = (await import("./milkdrop-convert.mjs")).loadConverter();
} catch { /* hlslparser-js not installed: the integration test below is skipped */ }

test("with the rewrite, hlslparser-js translates chains faithfully; without it, it does not",
  { skip: !tools && "hlslparser-js / milkdrop-preset-utils are not installed" },
  async () => {
    const { hlslToGlsl } = await import("./milkdrop-convert.mjs");
    const quiet = console.log;
    console.log = () => undefined;
    try {
      const shader = "shader_body {\nret = GetBlur1(uv) * 2 - GetPixel(uv) + q1 * q2 * q3;\n}";
      const raw = await hlslToGlsl(shader, tools);
      const rewritten = rewriteShader(shader);
      const fixed = await hlslToGlsl(rewritten, tools);
      assert.ok(logicalOperators(raw).and > 0, "the translator's bug no longer shows — the workaround may be unnecessary now");
      assert.equal(logicalOperators(fixed).and, logicalOperators(rewritten).and);
      assert.doesNotMatch(fixed, /parsing failed/);
      assert.match(fixed, /scale1\)\) \+ vec3 \(bias1\)/);
    } finally {
      console.log = quiet;
    }
  });
