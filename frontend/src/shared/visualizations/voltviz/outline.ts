/**
 * The outline of an SVG shape, measured as Chrome's SVGGeometryElement measures it
 * (getTotalLength, getPointAtLength), from the element's tag and attributes, without a DOM.
 *
 * voltviz's Icons samples every element of a lucide icon with 301 calls of getPointAtLength.
 * Chrome measures a path afresh for every call, about 0.2 ms for a curved one: two seconds for
 * the 40 icons, on the page's thread. Here the same answers take milliseconds, because the
 * outline is measured once and every call only looks it up. They are the browser's own
 * answers, computed as Blink and Skia compute them, step for step, in 32-bit floats
 * (Math.fround):
 *
 * - <path>: the data parsed as Blink parses it (svg_parser_utilities.cc,
 *   svg_path_string_source.cc), normalised to moves, lines, cubics and closes
 *   (svg_path_normalizer.cc: quadratics raised to cubics, arcs split into cubics of at most
 *   90°) and measured by SVGPathQuery (path_traversal_state.cc): a cubic is halved until its
 *   control polygon is within 1e-5 of its chord, and a point is the end of the piece it falls
 *   in, moved back along that piece;
 * - <circle> and <line>: Skia's path and SkContourMeasure, as Path::length and
 *   Path::PointAtLength use them: a circle is four conics from its right-hand point, clockwise
 *   (SkPath::addOval), each halved until it is flat within half a unit.
 *
 * Only what lucide's icons are made of: other tags have no outline here (outlineOf: null).
 */

const f = Math.fround;

/** A point of an outline, in the element's user units. */
export interface OutlinePoint {
  x: number;
  y: number;
}

/** What SVGGeometryElement answers for one element. */
export interface Outline {
  getTotalLength(): number;
  getPointAtLength(distance: number): OutlinePoint;
}

/** Where the normalised segments of path data go. */
interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  close(): void;
}

/** A distance in floats: gfx::Vector2dF::Length. */
function length(dx: number, dy: number): number {
  return f(Math.sqrt(dx * dx + dy * dy));
}

// ---------------------------------------------------------------------------------------------
// Path data: Blink's parser and normaliser

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);
const COMMAND = "MmLlHhVvCcSsQqTtAaZz";
const TWO_PI = f(f(Math.PI) * 2);
const PI_OVER_TWO = f(Math.PI / 2);

class PathDataSource {
  private readonly text: string;
  private position = 0;
  failed = false;

  constructor(text: string) {
    this.text = text;
    this.skipSpaces();
  }

  hasMore(): boolean {
    return this.position < this.text.length;
  }

  peek(): string {
    return this.text[this.position] ?? "";
  }

  advance(): void {
    this.position += 1;
  }

  skipSpaces(): void {
    while (this.position < this.text.length && SPACE.has(this.text.charCodeAt(this.position))) this.position += 1;
  }

  /** Spaces, then at most one comma and the spaces after it. */
  private skipSpacesOrDelimiter(): void {
    this.skipSpaces();
    if (this.text[this.position] === ",") {
      this.position += 1;
      this.skipSpaces();
    }
  }

  private digit(index: number): number {
    const code = this.text.charCodeAt(index);
    return code >= 0x30 && code <= 0x39 ? code - 0x30 : -1;
  }

  /** GenericParseNumber in floats: the integer part from the right, the decimals by 0.1 steps. */
  number(): number {
    if (this.failed) return 0;
    this.skipSpaces();
    let at = this.position;
    let sign = 1;
    if (this.text[at] === "+") at += 1;
    else if (this.text[at] === "-") {
      at += 1;
      sign = -1;
    }
    if (at >= this.text.length || (this.digit(at) < 0 && this.text[at] !== ".")) return this.fail();
    const digitsStart = at;
    while (this.digit(at) >= 0) at += 1;
    let integer = 0;
    let multiplier = 1;
    for (let scan = at - 1; scan >= digitsStart; scan -= 1) {
      integer = f(integer + f(multiplier * this.digit(scan)));
      multiplier = f(multiplier * 10);
    }
    let decimal = 0;
    if (this.text[at] === ".") {
      at += 1;
      if (this.digit(at) < 0) return this.fail();
      let fraction = 1;
      const tenth = f(0.1);
      while (this.digit(at) >= 0) {
        fraction = f(fraction * tenth);
        decimal = f(decimal + f(this.digit(at) * fraction));
        at += 1;
      }
    }
    let exponent = 0;
    let exponentSign = 1;
    const e = this.text[at];
    const next = this.text[at + 1];
    if (at + 1 < this.text.length && (e === "e" || e === "E") && next !== "x" && next !== "m") {
      at += 1;
      if (this.text[at] === "+") at += 1;
      else if (this.text[at] === "-") {
        at += 1;
        exponentSign = -1;
      }
      if (this.digit(at) < 0) return this.fail();
      while (this.digit(at) >= 0) {
        exponent = f(f(exponent * 10) + this.digit(at));
        at += 1;
      }
      if (exponent > 128) return this.fail();
    }
    let value = f(f(integer + decimal) * sign);
    if (exponent) value = f(value * f(10 ** (exponentSign * exponent)));
    if (!Number.isFinite(value)) return this.fail();
    this.position = at;
    this.skipSpacesOrDelimiter();
    return value;
  }

  flag(): boolean {
    if (this.failed) return false;
    const character = this.text[this.position];
    if (character !== "0" && character !== "1") {
      this.fail();
      return false;
    }
    this.position += 1;
    this.skipSpacesOrDelimiter();
    return character === "1";
  }

  private fail(): number {
    this.failed = true;
    return 0;
  }
}

/**
 * SVGPathNormalizer::DecomposeArcToCubic: the arc as cubics of at most 90°, into the sink.
 * False where it is a line (a zero radius) or nothing (the same end point).
 */
function arcToCubics(sink: PathSink, fromX: number, fromY: number, rxIn: number, ryIn: number, angle: number,
  large: boolean, sweep: boolean, toX: number, toY: number): boolean {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) return false;
  if (toX === fromX && toY === fromY) return false;
  // AffineTransform works in doubles; MapPoint rounds what it returns to floats.
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const midX = f(f(fromX - toX) * 0.5);
  const midY = f(f(fromY - toY) * 0.5);
  // rotate(-angle)
  const transformedX = f(cosine * midX + sine * midY);
  const transformedY = f(-sine * midX + cosine * midY);
  const squareRx = f(rx * rx);
  const squareRy = f(ry * ry);
  const squareX = f(transformedX * transformedX);
  const squareY = f(transformedY * transformedY);
  const radiiScale = f(f(squareX / squareRx) + f(squareY / squareRy));
  if (radiiScale > 1) {
    const root = f(Math.sqrt(radiiScale));
    rx = f(rx * root);
    ry = f(ry * root);
  }
  // scale(1 / rx, 1 / ry) · rotate(-angle)
  const inverseRx = f(1 / rx);
  const inverseRy = f(1 / ry);
  const toUnit = (x: number, y: number): [number, number] => [
    f(inverseRx * cosine * x + inverseRx * sine * y),
    f(-inverseRy * sine * x + inverseRy * cosine * y)
  ];
  let [point1X, point1Y] = toUnit(fromX, fromY);
  let [point2X, point2Y] = toUnit(toX, toY);
  let deltaX = f(point2X - point1X);
  let deltaY = f(point2Y - point1Y);
  const d = f(f(deltaX * deltaX) + f(deltaY * deltaY));
  const scaleFactorSquared = Math.max(f(f(1 / d) - 0.25), 0);
  let scaleFactor = f(Math.sqrt(scaleFactorSquared));
  if (sweep === large) scaleFactor = -scaleFactor;
  deltaX = f(deltaX * scaleFactor);
  deltaY = f(deltaY * scaleFactor);
  let centerX = f(point1X + point2X);
  let centerY = f(point1Y + point2Y);
  centerX = f(centerX * 0.5);
  centerY = f(centerY * 0.5);
  centerX = f(centerX - deltaY);
  centerY = f(centerY + deltaX);
  const theta1 = f(Math.atan2(f(point1Y - centerY), f(point1X - centerX)));
  const theta2 = f(Math.atan2(f(point2Y - centerY), f(point2X - centerX)));
  let thetaArc = f(theta2 - theta1);
  if (thetaArc < 0 && sweep) thetaArc = f(thetaArc + TWO_PI);
  else if (thetaArc > 0 && !sweep) thetaArc = f(thetaArc - TWO_PI);
  // rotate(angle) · scale(rx, ry)
  const fromUnit = (x: number, y: number): [number, number] => [
    f(cosine * rx * x - sine * ry * y),
    f(sine * rx * x + cosine * ry * y)
  ];
  const segments = Math.ceil(Math.abs(f(thetaArc / f(PI_OVER_TWO + f(0.001)))));
  const third = f(8 / f(6));
  for (let i = 0; i < segments; i += 1) {
    const startTheta = f(theta1 + f(f(i * thetaArc) / segments));
    const endTheta = f(theta1 + f(f((i + 1) * thetaArc) / segments));
    const t = f(third * f(Math.tan(f(0.25 * f(endTheta - startTheta)))));
    if (!Number.isFinite(t)) return false;
    const sinStart = f(Math.sin(startTheta));
    const cosStart = f(Math.cos(startTheta));
    const sinEnd = f(Math.sin(endTheta));
    const cosEnd = f(Math.cos(endTheta));
    point1X = f(f(cosStart - f(t * sinStart)) + centerX);
    point1Y = f(f(sinStart + f(t * cosStart)) + centerY);
    const targetX = f(cosEnd + centerX);
    const targetY = f(sinEnd + centerY);
    point2X = f(targetX + f(t * sinEnd));
    point2Y = f(targetY + f(-f(t * cosEnd)));
    const [c1x, c1y] = fromUnit(point1X, point1Y);
    const [c2x, c2y] = fromUnit(point2X, point2Y);
    const [ex, ey] = fromUnit(targetX, targetY);
    sink.cubicTo(c1x, c1y, c2x, c2y, ex, ey);
  }
  return true;
}

/**
 * Path data, parsed (SVGPathStringSource) and normalised (SVGPathNormalizer) into the sink.
 * Bad data ends the path where it goes wrong, as in the browser.
 */
function normalisePath(data: string, sink: PathSink): void {
  const source = new PathDataSource(data);
  let previous = "";
  let currentX = 0;
  let currentY = 0;
  let subPathX = 0;
  let subPathY = 0;
  let controlX = 0;
  let controlY = 0;
  let lastCommand = "";
  const isCubic = (command: string): boolean => command !== "" && "CcSs".includes(command);
  const isQuadratic = (command: string): boolean => command !== "" && "QqTt".includes(command);
  while (source.hasMore()) {
    const lookahead = source.peek();
    let command = COMMAND.includes(lookahead) ? lookahead : "";
    if (!previous) {
      if (command !== "M" && command !== "m") break;
      source.advance();
    } else if (!command) {
      // An implicit repetition: a number after any command but a close; after a move, a line.
      if (!/[0-9+\-.]/.test(lookahead) || previous === "Z" || previous === "z") break;
      command = previous === "M" ? "L" : previous === "m" ? "l" : previous;
    } else {
      source.advance();
    }
    previous = command;
    const upper = command.toUpperCase();
    const relative = command !== upper;
    let x1 = 0;
    let y1 = 0;
    let x2 = 0;
    let y2 = 0;
    let x = 0;
    let y = 0;
    let rx = 0;
    let ry = 0;
    let angle = 0;
    let large = false;
    let sweep = false;
    if (upper === "C" || upper === "Q") {
      x1 = source.number();
      y1 = source.number();
    }
    if (upper === "C" || upper === "S") {
      x2 = source.number();
      y2 = source.number();
    }
    if (upper === "A") {
      rx = source.number();
      ry = source.number();
      angle = source.number();
      large = source.flag();
      sweep = source.flag();
    }
    if (upper === "H") x = source.number();
    else if (upper === "V") y = source.number();
    else if (upper === "Z") source.skipSpaces();
    else {
      x = source.number();
      y = source.number();
    }
    if (source.failed) break;

    // Relative to absolute, in floats (a relative H or V adds the current point to its 0).
    if (upper === "Z") {
      x = subPathX;
      y = subPathY;
    } else if (relative) {
      if (upper === "C" || upper === "Q") {
        x1 = f(x1 + currentX);
        y1 = f(y1 + currentY);
      }
      if (upper === "C" || upper === "S") {
        x2 = f(x2 + currentX);
        y2 = f(y2 + currentY);
      }
      x = f(x + currentX);
      y = f(y + currentY);
    } else if (upper === "H") {
      y = currentY;
    } else if (upper === "V") {
      x = currentX;
    }

    switch (upper) {
      case "M":
        subPathX = x;
        subPathY = y;
        sink.moveTo(x, y);
        break;
      case "L": case "H": case "V":
        sink.lineTo(x, y);
        break;
      case "Z":
        sink.close();
        break;
      case "C": case "S":
        if (upper === "S") {
          // the first control point: the last one reflected, after a cubic
          x1 = isCubic(lastCommand) ? f(f(2 * currentX) - controlX) : currentX;
          y1 = isCubic(lastCommand) ? f(f(2 * currentY) - controlY) : currentY;
        }
        controlX = x2;
        controlY = y2;
        sink.cubicTo(x1, y1, x2, y2, x, y);
        break;
      case "Q": case "T": {
        if (upper === "T") {
          x1 = isQuadratic(lastCommand) ? f(f(2 * currentX) - controlX) : currentX;
          y1 = isQuadratic(lastCommand) ? f(f(2 * currentY) - controlY) : currentY;
        }
        controlX = x1;
        controlY = y1;
        // raised to a cubic, BlendPoints: (p1 + 2·p2) / 3
        const third = f(1 / f(3));
        sink.cubicTo(
          f(f(currentX + f(2 * x1)) * third), f(f(currentY + f(2 * y1)) * third),
          f(f(x + f(2 * x1)) * third), f(f(y + f(2 * y1)) * third),
          x, y
        );
        break;
      }
      case "A":
        if (!arcToCubics(sink, currentX, currentY, rx, ry, angle, large, sweep, x, y)) sink.lineTo(x, y);
        break;
    }
    currentX = x;
    currentY = y;
    if (!isCubic(command) && !isQuadratic(command)) {
      controlX = x;
      controlY = y;
    }
    lastCommand = command;
  }
}

// ---------------------------------------------------------------------------------------------
// <path>: SVGPathQuery over PathTraversalState

/** A piece is flat when (polygon − chord)² is within 1e-16 of the cubic's scale (squared). */
const TOLERANCE_SQUARED = 1e-16;
const SPLIT_DEPTH_LIMIT = 20;

const mid = (a: number, b: number): number => f(f(a + b) / 2);

/**
 * The path's measuring, done once. Every place where Chrome's traversal could stop for a
 * distance is an event: the end of a line, a move, or a piece of a halved cubic. A point at a
 * distance is found at the first event that stops there.
 */
class PathTraversal implements PathSink {
  /** The traversal's running length where each event is checked (non-decreasing). */
  private readonly totals: number[] = [];
  /** A cubic's piece stops when the length passes the distance; the rest when they reach it. */
  private readonly strict: boolean[] = [];
  /** The piece (or line) each event stands for: start and end, flattened. */
  private readonly spans: number[] = [];
  private total = 0;
  private currentX = 0;
  private currentY = 0;
  private startX = 0;
  private startY = 0;

  private event(value: number, strict: boolean, x0: number, y0: number, x1: number, y1: number): void {
    this.totals.push(value);
    this.strict.push(strict);
    this.spans.push(x0, y0, x1, y1);
  }

  moveTo(x: number, y: number): void {
    this.currentX = this.startX = x;
    this.currentY = this.startY = y;
    this.event(this.total, false, x, y, x, y);
  }

  lineTo(x: number, y: number): void {
    this.total = f(this.total + length(f(x - this.currentX), f(y - this.currentY)));
    this.event(this.total, false, this.currentX, this.currentY, x, y);
    this.currentX = x;
    this.currentY = y;
  }

  close(): void {
    this.lineTo(this.startX, this.startY);
  }

  /**
   * CurveLength<CubicBezier>: halved until flat for the curve's scale (at most 20 times), the
   * pieces' control polygons summed.
   */
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const base = this.total;
    const x0 = this.currentX;
    const y0 = this.currentY;
    this.currentX = x;
    this.currentY = y;
    // CubicBezier::MagnitudeSquared: the points' squares (floats) summed in doubles, over 16
    const dot = (px: number, py: number): number => f(f(px * px) + f(py * py));
    const scale = (dot(x0, y0) + dot(x1, y1) + dot(x2, y2) + dot(x, y)) / 16;
    if (scale < TOLERANCE_SQUARED) {
      this.event(base, false, x0, y0, x0, y0);
      return;
    }
    let within = 0;
    let last = 0;
    let curve = [x0, y0, x1, y1, x2, y2, x, y];
    let depth = 0;
    const stack: [number[], number][] = [[curve, depth]];
    do {
      const c = curve;
      const polygon = f(f(length(f(c[2]! - c[0]!), f(c[3]! - c[1]!)) + length(f(c[4]! - c[2]!), f(c[5]! - c[3]!)))
        + length(f(c[6]! - c[4]!), f(c[7]! - c[5]!)));
      const discrepancy = f(polygon - length(f(c[6]! - c[0]!), f(c[7]! - c[1]!)));
      if ((discrepancy * discrepancy) / scale > TOLERANCE_SQUARED && depth < SPLIT_DEPTH_LIMIT) {
        // CubicBezier::Split
        const m12x = mid(c[2]!, c[4]!);
        const m12y = mid(c[3]!, c[5]!);
        const l1x = mid(c[0]!, c[2]!);
        const l1y = mid(c[1]!, c[3]!);
        const l2x = mid(l1x, m12x);
        const l2y = mid(l1y, m12y);
        const r2x = mid(c[4]!, c[6]!);
        const r2y = mid(c[5]!, c[7]!);
        const r1x = mid(r2x, m12x);
        const r1y = mid(r2y, m12y);
        const mx = mid(l2x, r1x);
        const my = mid(l2y, r1y);
        depth += 1;
        curve = [c[0]!, c[1]!, l1x, l1y, l2x, l2y, mx, my];
        stack.push([[mx, my, r1x, r1y, r2x, r2y, c[6]!, c[7]!], depth]);
      } else {
        within = f(within + polygon);
        this.event(f(base + within), true, c[0]!, c[1]!, c[6]!, c[7]!);
        last = this.spans.length - 4;
        [curve, depth] = stack.pop()!;
      }
    } while (stack.length > 0);
    this.total = f(base + within);
    const s = this.spans;
    // where the whole cubic reaches the distance: its last piece
    this.event(this.total, false, s[last]!, s[last + 1]!, s[last + 2]!, s[last + 3]!);
  }

  outline(): Outline {
    const totals = this.totals;
    const strict = this.strict;
    const spans = this.spans;
    const total = this.total;
    return {
      getTotalLength: () => total,
      getPointAtLength(at: number): OutlinePoint {
        const d = f(Math.min(Math.max(at, 0), total));
        // the first event at or after d; one that only stops past d moves on through ties
        let lo = 0;
        let hi = totals.length;
        while (lo < hi) {
          const middle = (lo + hi) >> 1;
          if (totals[middle]! < d) lo = middle + 1;
          else hi = middle;
        }
        while (lo < totals.length && totals[lo] === d && strict[lo]) lo += 1;
        if (lo >= totals.length) return { x: 0, y: 0 };
        // PathTraversalState::ProcessSegment: back from the end along the piece
        const x0 = spans[lo * 4]!;
        const y0 = spans[lo * 4 + 1]!;
        const x1 = spans[lo * 4 + 2]!;
        const y1 = spans[lo * 4 + 3]!;
        const offset = f(d - totals[lo]!);
        if (offset === 0) return { x: x1, y: y1 };
        const slope = f(Math.atan2(f(y1 - y0), f(x1 - x0)));
        return { x: f(x1 + f(offset * f(Math.cos(slope)))), y: f(y1 + f(offset * f(Math.sin(slope)))) };
      }
    };
  }
}

// ---------------------------------------------------------------------------------------------
// <circle>, <line>: Skia's path and SkContourMeasure

const MAX_T = 0x3fffffff;
const CURVE_TOLERANCE = 0.5;

const tValue = (t: number): number => f(t) * 2 ** -30;
const interp = (a: number, b: number, t: number): number => f(a + f(f(b - a) * t));

/** A conic's point at t (SkConicCoeff). */
function conicAt(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, weight: number, t: number): [number, number] {
  const axis = (p0: number, p1: number, p2: number): number => {
    const p1w = f(p1 * weight);
    const a = f(f(p2 - f(p1w + p1w)) + p0);
    const half = f(p1w - p0);
    const b = f(half + half);
    return f(f(f(f(a * t) + b) * t) + p0);
  };
  const dw = f(weight - 1);
  const denomB = f(dw + dw);
  const denom = f(f(f(f(-denomB * t) + denomB) * t) + 1);
  return [f(axis(x0, x1, x2) / denom), f(axis(y0, y1, y2) / denom)];
}

const LINE = 0;
const CONIC = 1;

interface Segment {
  distance: number;
  ptIndex: number;
  type: number;
  t: number;
}

/**
 * One closed or open run of lines and conics, measured as SkContourMeasureIter measures it:
 * its segments (fSegments) and the points they index (fPts).
 */
class Contour {
  readonly segments: Segment[] = [];
  readonly points: number[] = [];
  length = 0;
  private ptIndex = 0;
  private lastX: number;
  private lastY: number;

  constructor(x: number, y: number) {
    this.points.push(x, y);
    this.lastX = x;
    this.lastY = y;
  }

  private chord(x0: number, y0: number, x1: number, y1: number, type: number, t: number): void {
    const before = this.length;
    // SkPoint::Distance: the squares summed in floats
    const dx = f(x1 - x0);
    const dy = f(y1 - y0);
    this.length = f(this.length + f(Math.sqrt(f(f(dx * dx) + f(dy * dy)))));
    if (this.length > before) this.segments.push({ distance: this.length, ptIndex: this.ptIndex, type, t });
  }

  lineTo(x: number, y: number): void {
    const before = this.length;
    this.chord(this.lastX, this.lastY, x, y, LINE, MAX_T);
    if (this.length > before) {
      this.points.push(x, y);
      this.ptIndex += 1;
    }
    this.lastX = x;
    this.lastY = y;
  }

  conicTo(x1: number, y1: number, x: number, y: number, weight: number): void {
    const x0 = this.lastX;
    const y0 = this.lastY;
    const halve = (minT: number, minX: number, minY: number, maxT: number, maxX: number, maxY: number): void => {
      const halfT = (minT + maxT) >> 1;
      const [halfX, halfY] = conicAt(x0, y0, x1, y1, x, y, weight, tValue(halfT));
      if (!Number.isFinite(halfX) || !Number.isFinite(halfY)) return;
      const midX = f(f(minX + maxX) * 0.5);
      const midY = f(f(minY + maxY) * 0.5);
      const curvy = Math.max(Math.abs(f(halfX - midX)), Math.abs(f(halfY - midY))) > CURVE_TOLERANCE;
      if (maxT - minT >> 10 !== 0 && curvy) {
        halve(minT, minX, minY, halfT, halfX, halfY);
        halve(halfT, halfX, halfY, maxT, maxX, maxY);
      } else {
        this.chord(minX, minY, maxX, maxY, CONIC, maxT);
      }
    };
    const before = this.length;
    halve(0, x0, y0, MAX_T, x, y);
    if (this.length > before) {
      // the weight in the next point, then the conic's last two
      this.points.push(weight, 0, x1, y1, x, y);
      this.ptIndex += 3;
    }
    this.lastX = x;
    this.lastY = y;
  }

  close(): void {
    const p = this.points;
    const last = this.ptIndex * 2;
    const before = this.length;
    this.chord(p[last]!, p[last + 1]!, p[0]!, p[1]!, LINE, MAX_T);
    if (this.length > before) p.push(p[0]!, p[1]!);
  }

  /** SkContourMeasure::getPosTan, the position only. */
  pointAt(at: number): OutlinePoint {
    const d = at < 0 ? 0 : at > this.length ? this.length : at;
    const segments = this.segments;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const middle = lo + ((hi - lo) >> 1);
      if (segments[middle]!.distance < d) lo = middle + 1;
      else hi = middle;
    }
    if (segments[hi]!.distance < d) hi = Math.min(hi + 1, segments.length - 1);
    const segment = segments[hi]!;
    let startT = 0;
    let startD = 0;
    if (hi > 0) {
      const before = segments[hi - 1]!;
      startD = before.distance;
      if (before.ptIndex === segment.ptIndex) startT = tValue(before.t);
    }
    const t = f(startT + f(f(f(tValue(segment.t) - startT) * f(d - startD)) / f(segment.distance - startD)));
    const p = this.points;
    const i = segment.ptIndex * 2;
    if (segment.type === LINE) return { x: interp(p[i]!, p[i + 2]!, t), y: interp(p[i + 1]!, p[i + 3]!, t) };
    const [x, y] = conicAt(p[i]!, p[i + 1]!, p[i + 4]!, p[i + 5]!, p[i + 6]!, p[i + 7]!, p[i + 2]!, t);
    return { x, y };
  }
}

/** Path::length and Path::PointAtLength over one contour (all a circle or a line has). */
function contourOutline(contour: Contour): Outline {
  const total = contour.segments.length ? contour.length : 0;
  return {
    getTotalLength: () => total,
    getPointAtLength(at: number): OutlinePoint {
      const d = f(Math.min(Math.max(at, 0), total));
      if (!total) return { x: contour.points[0]!, y: contour.points[1]! };
      return contour.pointAt(d);
    }
  };
}

/** An attribute as a number (a length without units); missing or not a number, 0. */
function numeric(value: string | number | undefined): number {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(number) ? f(number) : 0;
}

/**
 * The outline of one element, from its tag and attributes; null for a tag this module does not
 * measure. An element with nothing to draw has a length of 0, as in the browser.
 */
export function outlineOf(tag: string, attributes: Readonly<Record<string, string | number>>): Outline | null {
  switch (tag) {
    case "path": {
      const traversal = new PathTraversal();
      normalisePath(String(attributes["d"] ?? ""), traversal);
      return traversal.outline();
    }
    case "circle": {
      // Path::AddEllipse → SkPath::addOval: from (right, cy), clockwise, four quarter conics.
      const r = numeric(attributes["r"]);
      const cx = numeric(attributes["cx"]);
      const cy = numeric(attributes["cy"]);
      if (!(r > 0)) return contourOutline(new Contour(cx, cy));
      const left = f(cx - r);
      const top = f(cy - r);
      const right = f(left + f(r * 2));
      const bottom = f(top + f(r * 2));
      // SkRect::centerX: the midpoint in doubles
      const midX = f((left + right) * 0.5);
      const midY = f((top + bottom) * 0.5);
      const weight = f(Math.SQRT1_2);
      const contour = new Contour(right, midY);
      contour.conicTo(right, bottom, midX, bottom, weight);
      contour.conicTo(left, bottom, left, midY, weight);
      contour.conicTo(left, top, midX, top, weight);
      contour.conicTo(right, top, right, midY, weight);
      contour.close();
      return contourOutline(contour);
    }
    case "line": {
      const contour = new Contour(numeric(attributes["x1"]), numeric(attributes["y1"]));
      contour.lineTo(numeric(attributes["x2"]), numeric(attributes["y2"]));
      return contourOutline(contour);
    }
    default:
      return null;
  }
}
