/**
 * AVS's grouping of binary operators, applied to eel-wasm's syntax tree.
 *
 * AVS 2.81's ns-eel parser (yacc: %left '|', %left '&', %left '+' '-', %left '*' '/' '%') puts
 * `* / %` on one level and `+ -` on another, each read left to right, with `&` above `|` — its
 * parser tables give `a*b%c` as `(a*b)%c`. eel-wasm follows EEL2, where `%` binds tighter than
 * `/`, `/` than `*` and `-` than `+`, and `&` and `|` share a level. Presets were written for the
 * former: Orifice's `x = dirx*w%w/w*2-1` wraps a position in AVS and is always -1 in EEL2.
 *
 * Every chain of these operators that the author did not put in brackets is flattened in source
 * order and rebuilt AVS's way. A bracketed sub-expression stays as it is; brackets are read from
 * the source, since eel-wasm keeps none (its nodes carry line/column spans without them).
 * Pure: no imports, so the tests load it with plain Node.
 */

export interface GroupingNode {
  type: string;
  operator?: string;
  left?: GroupingNode;
  right?: GroupingNode;
  loc?: { first_line: number; first_column: number; last_line: number; last_column: number };
  [key: string]: unknown;
}

const LEVEL: Record<string, number> = { "|": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "%": 4 };

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** Whether the node's own text is enclosed by a matching pair of brackets in the source. */
function bracketed(node: GroupingNode, source: string, starts: number[]): boolean {
  const loc = node.loc;
  if (!loc) return false;
  const start = (starts[loc.first_line - 1] ?? 0) + loc.first_column;
  const end = (starts[loc.last_line - 1] ?? 0) + loc.last_column;
  let open = start - 1;
  while (open >= 0 && /\s/.test(source[open]!)) open -= 1;
  if (source[open] !== "(") return false;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        let after = end;
        while (after < source.length && /\s/.test(source[after]!)) after += 1;
        return index === after;
      }
    }
  }
  return false;
}

const isChainLink = (node: GroupingNode | undefined): node is GroupingNode =>
  Boolean(node && node.type === "BINARY_EXPRESSION" && node.operator !== undefined && node.operator in LEVEL);

/** The whole tree with every operator chain grouped AVS's way. */
export function avsGrouping<T extends GroupingNode>(tree: T, source: string): T {
  const starts = lineStarts(source);

  /**
   * A sign (or signs) in front of an unbracketed chain: eel-wasm reads `-a*b%c` as
   * `-(a*b%c)`, AVS (UMINUS above everything) as `((-a)*b)%c`. The signs, outermost first,
   * and the chain they stand before; null when the node is something else.
   */
  const signedChain = (node: GroupingNode): { signs: string[]; chain: GroupingNode } | null => {
    const signs: string[] = [];
    let current: GroupingNode = node;
    while (current.type === "UNARY_EXPRESSION" && (current.operator === "-" || current.operator === "+")) {
      signs.push(current.operator);
      current = current.value as GroupingNode;
      if (!current || typeof current !== "object" || bracketed(current, source, starts)) return null;
    }
    return signs.length && isChainLink(current) ? { signs, chain: current } : null;
  };

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const current = node as GroupingNode;
    if (isChainLink(current) || signedChain(current)) return regroup(current);
    for (const key of Object.keys(current)) {
      if (key === "loc") continue;
      const child = current[key];
      if (child && typeof child === "object") (current as Record<string, unknown>)[key] = visit(child);
    }
    return current;
  };

  const regroup = (root: GroupingNode): GroupingNode => {
    // Operands and operators in source order; a bracketed or non-chain node is one operand.
    const operands: GroupingNode[] = [];
    const operators: string[] = [];
    // Signs waiting for the next operand (the leftmost one of a signed chain).
    const flatten = (node: GroupingNode, top: boolean, signs: string[]): void => {
      const signed = signedChain(node);
      if (isChainLink(node) && (top || !bracketed(node, source, starts))) {
        flatten(node.left!, false, signs);
        operators.push(node.operator!);
        flatten(node.right!, false, []);
      } else if (signed && (top || !bracketed(node, source, starts))) {
        flatten(signed.chain, true, [...signs, ...signed.signs]);
      } else {
        let operand = visit(node) as GroupingNode;
        for (let index = signs.length - 1; index >= 0; index -= 1) {
          operand = { type: "UNARY_EXPRESSION", operator: signs[index], value: operand, loc: node.loc };
        }
        operands.push(operand);
      }
    };
    flatten(root, true, []);
    // Precedence climbing, every level left to right: operators[i] stands between
    // operands[i] and operands[i + 1].
    let index = 0;
    const climb = (left: GroupingNode, minimum: number): GroupingNode => {
      while (index < operators.length && LEVEL[operators[index]!]! >= minimum) {
        const operator = operators[index]!;
        const level = LEVEL[operator]!;
        index += 1;
        let right = operands[index]!;
        while (index < operators.length && LEVEL[operators[index]!]! > level) {
          right = climb(right, LEVEL[operators[index]!]!);
        }
        left = { type: "BINARY_EXPRESSION", operator, left, right, loc: root.loc };
      }
      return left;
    };
    return climb(operands[0]!, 1);
  };

  return visit(tree) as T;
}
