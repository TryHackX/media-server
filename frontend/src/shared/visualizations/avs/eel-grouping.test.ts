import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "eel-wasm";

import { avsGrouping, type GroupingNode } from "./eel-grouping.ts";

/** The first statement's right-hand side, bracketed fully. */
function grouped(code: string): string {
  const tree = avsGrouping(parse(code) as unknown as GroupingNode, code) as GroupingNode & { body: GroupingNode[] };
  const show = (node: GroupingNode): string => {
    if (node.type === "BINARY_EXPRESSION") return `(${show(node.left!)}${node.operator}${show(node.right!)})`;
    if (node.type === "UNARY_EXPRESSION") return `${node.operator}${show(node.value as GroupingNode)}`;
    if (node.type === "CALL_EXPRESSION") {
      const callee = node.callee as { value: string };
      return `${callee.value}(${(node.arguments as GroupingNode[]).map(show).join(",")})`;
    }
    return String(node.value);
  };
  return show(tree.body[0]!.right!);
}

test("* / % share a level and read left to right, as AVS's parser tables do", () => {
  assert.equal(grouped("x=a*b%c;"), "((a*b)%c)");
  assert.equal(grouped("x=dirx*w%w/w*2-1;"), "(((((dirx*w)%w)/w)*2)-1)");
  assert.equal(grouped("x=a/b%c;"), "((a/b)%c)");
  assert.equal(grouped("x=a%b*c;"), "((a%b)*c)");
  assert.equal(grouped("x=a*b/c;"), "((a*b)/c)");
});

test("+ and - share a level; & binds tighter than |", () => {
  assert.equal(grouped("x=a+b-c;"), "((a+b)-c)");
  assert.equal(grouped("x=a-b+c;"), "((a-b)+c)");
  assert.equal(grouped("x=a+b*c%d;"), "(a+((b*c)%d))");
  assert.equal(grouped("x=a|b&c;"), "(a|(b&c))");
  assert.equal(grouped("x=a&b|c;"), "((a&b)|c)");
  assert.equal(grouped("x=a+b&c+d;"), "((a+b)&(c+d))");
});

test("what the author bracketed stays as written", () => {
  assert.equal(grouped("x=a*(b%c);"), "(a*(b%c))");
  assert.equal(grouped("x=(a+b)*(c-d)%e;"), "(((a+b)*(c-d))%e)");
  assert.equal(grouped("x=a*(b)%(c);"), "((a*b)%c)");
  assert.equal(grouped("x = a*\n ( b % c ) ;"), "(a*(b%c))");
  assert.equal(grouped("x=f(a*b%c, d);"), "f(((a*b)%c),d)");
  assert.equal(grouped("x=-a*b%c;"), "((-a*b)%c)");
  assert.equal(grouped("x=a- -b*c%d;"), "(a-((-b*c)%d))");
  assert.equal(grouped("x=-(a*b)%c;"), "(-(a*b)%c)");
});
