import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Component's constructor calls init(), and class field initializers (TypeScript with
// useDefineForClassFields) run only after it returns: a field with an initializer that init()
// sets is reset right after init(). Until 09.11 that left Texer v1, AVI, the APE/SVP ports,
// Multi Delay and Clear Screen's line blend without their state in the browser.

const HERE = dirname(fileURLToPath(import.meta.url));

function sources(folder: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(folder)) {
        const path = join(folder, entry);
        if (statSync(path).isDirectory()) found.push(...sources(path));
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) found.push(path);
    }
    return found;
}

/** Each class that extends a component: its fields with initializers and what its init() assigns. */
function componentClasses(text: string): { name: string; initialized: string[]; assignedInInit: string[] }[] {
    const classes: { name: string; initialized: string[]; assignedInInit: string[] }[] = [];
    const header = /^export (?:default )?class (\w+) extends (\w+)/gm;
    const starts = [...text.matchAll(header)];
    starts.forEach((match, k) => {
        if (!/^(Component|Container|EffectList|ShaderEffect)$/.test(match[2]!) && !/Component$/.test(match[2]!)) return;
        const body = text.slice(match.index!, k + 1 < starts.length ? starts[k + 1]!.index : text.length);
        const initialized = [...body.matchAll(/^ {4}(?:private |protected |public )?(?:readonly )?(\w+)(?:\??: [^=;\n]+)? = [^;\n]+;/gm)]
            .map((field) => field[1]!)
            .filter((name) => !["componentName", "componentTag", "defaultOptions", "optUpdateHandlers"].includes(name));
        const init = /\n {4}public init\(\)[^{]*\{([\s\S]*?)\n {4}\}/.exec(body);
        const assignedInInit = init ? [...init[1]!.matchAll(/this\.(\w+)\s*=[^=]/g)].map((assignment) => assignment[1]!) : [];
        classes.push({ name: match[1]!, initialized, assignedInInit });
    });
    return classes;
}

test("no component field that init() sets has an initializer", () => {
    const offenders: string[] = [];
    for (const file of sources(HERE)) {
        for (const component of componentClasses(readFileSync(file, "utf8"))) {
            for (const field of component.initialized) {
                if (component.assignedInInit.includes(field)) offenders.push(`${relative(HERE, file)}: ${component.name}.${field}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("the check finds the pattern it guards against", () => {
    const sample = [
        "export default class Sample extends Component {",
        "    private frame: Frame | null = null;",
        "    private ok: number;",
        "    public init() {",
        "        this.frame = new Frame();",
        "        this.ok = 1;",
        "    }",
        "}",
    ].join("\n");
    assert.deepEqual(componentClasses(sample), [{ name: "Sample", initialized: ["frame"], assignedInInit: ["frame", "ok"] }]);
});
