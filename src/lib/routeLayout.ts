import type {
  BoardLocation,
  BoardRoute,
  ClaimedRouteState,
  RouteColor,
} from '../shared/types';
import {
  countCornerWaypoints,
  resolveEffectivePathType,
  resolveEffectiveWaypoints,
  sampleGenericPath,
} from '../shared/geoScale';

export interface SampledPoint {
  x: number;
  y: number;
  cumDist: number;
  angleDeg: number;
}

export interface ComputedSlot extends SampledPoint {
  idx: number;
  isFerryLoco: boolean;
}

export interface ComputedLaneLayout {
  route: BoardRoute;
  lane: 'laneA' | 'laneB' | 'laneC';
  laneColor: RouteColor;
  pts: SampledPoint[];
  slots: ComputedSlot[];
  slotLenPx: number;
  slotWidthPx: number;
  hitPathD: string;
  railsPathD: string;
  tiesPathD: string;
}

interface PlacedSlotOBB {
  routeId: string;
  x: number;
  y: number;
  angleDeg: number;
  halfL: number;
  halfW: number;
}

interface CityNodePx {
  id: string;
  x: number;
  y: number;
  r: number;
}

interface EndpointAdjustment {
  lateralPx: number; // + means outward right-hand normal from city; converted per route direction when offsetting
  setbackPx: number; // extra clearance outward from city center
}

/**
 * Module-scoped debug verbosity level:
 * 0 = errors only, 1 = major layout steps, 2 = light debug, 3 = detailed placement, 4 = full trace.
 */
export const ROUTE_LAYOUT_DEBUG_LEVEL = 0;

/**
 * Clamps numeric value `v` to inclusive `[min, max]`.
 * Call with (v, min, max). Returns clamped number.
 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

export function buildArcTable(ptsRaw: Array<{ a: number; b: number }>): {
  pts: SampledPoint[];
  totalLen: number;
} {
  const pts: SampledPoint[] = [];
  let totalLen = 0;
  for (let i = 0; i < ptsRaw.length; i++) {
    const cur = ptsRaw[i];
    const prev = i > 0 ? ptsRaw[i - 1] : cur;
    const next = i < ptsRaw.length - 1 ? ptsRaw[i + 1] : cur;
    if (i > 0) {
      totalLen += Math.hypot(cur.a - prev.a, cur.b - prev.b);
    }
    const dx = i < ptsRaw.length - 1 ? next.a - cur.a : cur.a - prev.a;
    const dy = i < ptsRaw.length - 1 ? next.b - cur.b : cur.b - prev.b;
    pts.push({
      x: cur.a,
      y: cur.b,
      cumDist: totalLen,
      angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return { pts, totalLen };
}

export function pointAtArcDistance(sampled: SampledPoint[], targetDist: number): SampledPoint {
  if (sampled.length === 0) return { x: 0, y: 0, cumDist: 0, angleDeg: 0 };
  if (targetDist <= 0) return sampled[0];
  const last = sampled[sampled.length - 1];
  if (targetDist >= last.cumDist) return last;

  for (let i = 1; i < sampled.length; i++) {
    const a = sampled[i - 1];
    const b = sampled[i];
    if (b.cumDist >= targetDist) {
      const span = Math.max(1e-6, b.cumDist - a.cumDist);
      const frac = (targetDist - a.cumDist) / span;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      return {
        x: a.x + dx * frac,
        y: a.y + dy * frac,
        cumDist: targetDist,
        angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      };
    }
  }
  return last;
}

function polylineToPathD(pts: Array<{ a: number; b: number }>): string {
  if (pts.length === 0) return '';
  let d = `M ${pts[0].a.toFixed(2)} ${pts[0].b.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].a.toFixed(2)} ${pts[i].b.toFixed(2)}`;
  }
  return d;
}

function pushCubicSamples(
  out: Array<{ a: number; b: number }>,
  p0: { a: number; b: number },
  c1: { a: number; b: number },
  c2: { a: number; b: number },
  p3: { a: number; b: number },
  steps: number,
  includeStart: boolean
) {
  const startStep = includeStart ? 0 : 1;
  for (let s = startStep; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    out.push({
      a:
        mt * mt * mt * p0.a +
        3 * mt * mt * t * c1.a +
        3 * mt * t * t * c2.a +
        t * t * t * p3.a,
      b:
        mt * mt * mt * p0.b +
        3 * mt * mt * t * c1.b +
        3 * mt * t * t * c2.b +
        t * t * t * p3.b,
    });
  }
}

/**
 * Builds railway track geometry under a chain of cars:
 * - Parallel grey rails + equally spaced perpendicular cross-ties
 * - Meets every train car's ends strictly perpendicular
 * - Curves smoothly from/toward the exact centerpoint of each endpoint location
 */
function buildTrackGeometry(
  fromCenter: { x: number; y: number },
  toCenter: { x: number; y: number },
  slots: ComputedSlot[],
  slotLenPx: number,
  slotWidthPx: number
): { hitPathD: string; railsPathD: string; tiesPathD: string } {
  const centerPts: Array<{ a: number; b: number }> = [];

  if (slots.length === 0) {
    centerPts.push(
      { a: fromCenter.x, b: fromCenter.y },
      { a: toCenter.x, b: toCenter.y }
    );
  } else {
    const halfL = slotLenPx * 0.5;
    const cars = slots.map((s) => {
      const rad = (s.angleDeg * Math.PI) / 180;
      const tx = Math.cos(rad);
      const ty = Math.sin(rad);
      return {
        tx,
        ty,
        mid: { a: s.x, b: s.y },
        rear: { a: s.x - tx * halfL, b: s.y - ty * halfL },
        front: { a: s.x + tx * halfL, b: s.y + ty * halfL },
      };
    });

    // 1. Curve smoothly from origin city centerpoint to rear end of first car (arriving perpendicular)
    const first = cars[0];
    const pFrom = { a: fromCenter.x, b: fromCenter.y };
    const dxIn = first.rear.a - pFrom.a;
    const dyIn = first.rear.b - pFrom.b;
    const lenIn = Math.hypot(dxIn, dyIn);
    if (lenIn > 0.8) {
      const ux = dxIn / lenIn;
      const uy = dyIn / lenIn;
      const dot = ux * first.tx + uy * first.ty;
      const c1 =
        dot > -0.2
          ? { a: pFrom.a + ux * (lenIn * 0.36), b: pFrom.b + uy * (lenIn * 0.36) }
          : pFrom;
      const c2 = {
        a: first.rear.a - first.tx * Math.min(lenIn * 0.46, slotLenPx * 0.6),
        b: first.rear.b - first.ty * Math.min(lenIn * 0.46, slotLenPx * 0.6),
      };
      pushCubicSamples(centerPts, pFrom, c1, c2, first.rear, 12, true);
    } else {
      centerPts.push(pFrom, first.rear);
    }

    // 2. Through each car (exact straight axis) + perpendicular Hermite links across gaps
    for (let i = 0; i < cars.length; i++) {
      const cur = cars[i];
      centerPts.push(cur.mid, cur.front);

      if (i < cars.length - 1) {
        const nxt = cars[i + 1];
        const gLen = Math.hypot(nxt.rear.a - cur.front.a, nxt.rear.b - cur.front.b);
        if (gLen > 0.6) {
          const handle = Math.min(gLen * 0.45, slotLenPx * 0.35);
          const c1 = { a: cur.front.a + cur.tx * handle, b: cur.front.b + cur.ty * handle };
          const c2 = { a: nxt.rear.a - nxt.tx * handle, b: nxt.rear.b - nxt.ty * handle };
          pushCubicSamples(centerPts, cur.front, c1, c2, nxt.rear, 8, false);
        } else {
          centerPts.push(nxt.rear);
        }
      }
    }

    // 3. Curve smoothly from front end of last car (departing perpendicular) toward destination centerpoint
    const last = cars[cars.length - 1];
    const pTo = { a: toCenter.x, b: toCenter.y };
    const dxOut = pTo.a - last.front.a;
    const dyOut = pTo.b - last.front.b;
    const lenOut = Math.hypot(dxOut, dyOut);
    if (lenOut > 0.8) {
      const ux = dxOut / lenOut;
      const uy = dyOut / lenOut;
      const dot = ux * last.tx + uy * last.ty;
      const c1 = {
        a: last.front.a + last.tx * Math.min(lenOut * 0.46, slotLenPx * 0.6),
        b: last.front.b + last.ty * Math.min(lenOut * 0.46, slotLenPx * 0.6),
      };
      const c2 =
        dot > -0.2
          ? { a: pTo.a - ux * (lenOut * 0.36), b: pTo.b - uy * (lenOut * 0.36) }
          : pTo;
      pushCubicSamples(centerPts, last.front, c1, c2, pTo, 12, false);
    } else {
      centerPts.push(pTo);
    }
  }

  const railHalfGauge = Math.max(1.0, slotWidthPx * 0.25);
  const tieHalfLen = Math.max(1.6, slotWidthPx * 0.39);
  const tiePitchPx = Math.max(3.2, slotWidthPx * 0.52);

  const leftRail = offsetPolylinePx(centerPts, -railHalfGauge);
  const rightRail = offsetPolylinePx(centerPts, railHalfGauge);
  const railsPathD = `${polylineToPathD(leftRail)} ${polylineToPathD(rightRail)}`;
  const hitPathD = polylineToPathD(centerPts);

  const { pts: arcPts, totalLen } = buildArcTable(centerPts);
  let tiesPathD = '';
  if (totalLen > tiePitchPx * 0.8) {
    const startD = tiePitchPx * 0.5;
    for (let d = startD; d <= totalLen - tiePitchPx * 0.35; d += tiePitchPx) {
      const sp = pointAtArcDistance(arcPts, d);
      const rad = (sp.angleDeg * Math.PI) / 180;
      const nx = -Math.sin(rad);
      const ny = Math.cos(rad);
      const x1 = sp.x - nx * tieHalfLen;
      const y1 = sp.y - ny * tieHalfLen;
      const x2 = sp.x + nx * tieHalfLen;
      const y2 = sp.y + ny * tieHalfLen;
      tiesPathD += `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} `;
    }
  }

  return { hitPathD, railsPathD, tiesPathD: tiesPathD.trim() };
}

export function offsetPolylinePx(
  pts: Array<{ a: number; b: number }>,
  offsetPx: number
): Array<{ a: number; b: number }> {
  if (Math.abs(offsetPx) < 0.1 || pts.length < 2) return pts;
  return pts.map((p, idx) => {
    const prev = pts[Math.max(0, idx - 1)];
    const next = pts[Math.min(pts.length - 1, idx + 1)];
    const dx = next.a - prev.a;
    const dy = next.b - prev.b;
    const len = Math.max(1e-6, Math.hypot(dx, dy));
    return {
      a: p.a + (-dy / len) * offsetPx,
      b: p.b + (dx / len) * offsetPx,
    };
  });
}

// 2D Oriented Bounding Box overlap test (SAT)
export function obbOverlaps(
  c1: { x: number; y: number; angleDeg: number },
  c2: { x: number; y: number; angleDeg: number },
  halfL1: number,
  halfW1: number,
  halfL2 = halfL1,
  halfW2 = halfW1
): boolean {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const maxSep = halfL1 + halfL2 + halfW1 + halfW2;
  if (dx * dx + dy * dy > maxSep * maxSep) return false;

  const r1 = (c1.angleDeg * Math.PI) / 180;
  const r2 = (c2.angleDeg * Math.PI) / 180;
  const axes = [
    { x: Math.cos(r1), y: Math.sin(r1) },
    { x: -Math.sin(r1), y: Math.cos(r1) },
    { x: Math.cos(r2), y: Math.sin(r2) },
    { x: -Math.sin(r2), y: Math.cos(r2) },
  ];

  const u1 = axes[0];
  const v1 = axes[1];
  const u2 = axes[2];
  const v2 = axes[3];

  for (const ax of axes) {
    const dist = Math.abs(dx * ax.x + dy * ax.y);
    const proj1 =
      Math.abs(u1.x * ax.x + u1.y * ax.y) * halfL1 +
      Math.abs(v1.x * ax.x + v1.y * ax.y) * halfW1;
    const proj2 =
      Math.abs(u2.x * ax.x + u2.y * ax.y) * halfL2 +
      Math.abs(v2.x * ax.x + v2.y * ax.y) * halfW2;
    if (dist > proj1 + proj2) return false;
  }
  return true;
}

// Exact Circle vs Oriented Bounding Box overlap test
function circleOverlapsOBB(
  circle: { x: number; y: number; r: number },
  box: { x: number; y: number; angleDeg: number },
  halfL: number,
  halfW: number
): boolean {
  const dx = circle.x - box.x;
  const dy = circle.y - box.y;
  const maxD = circle.r + halfL + halfW;
  if (dx * dx + dy * dy > maxD * maxD) return false;

  const rad = (-box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  const cx = clamp(lx, -halfL, halfL);
  const cy = clamp(ly, -halfW, halfW);
  const ddx = lx - cx;
  const ddy = ly - cy;
  return ddx * ddx + ddy * ddy < circle.r * circle.r;
}

function subdivideLineIfNeeded(
  pts: Array<{ a: number; b: number }>,
  needsSubdiv: boolean
): Array<{ a: number; b: number }> {
  if (!needsSubdiv || pts.length !== 2) return pts;
  const p0 = pts[0];
  const p1 = pts[1];
  const out: Array<{ a: number; b: number }> = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      a: p0.a + (p1.a - p0.a) * t,
      b: p0.b + (p1.b - p0.b) * t,
    });
  }
  return out;
}

/**
 * Applies smooth endpoint lateral fanning ("shuffle to the side") so routes
 * converging tightly into a city spread cleanly and rejoin mid-route.
 */
function applyEndpointLateralFan(
  pts: Array<{ a: number; b: number }>,
  startFwdLateralPx: number,
  endFwdLateralPx: number,
  isHardPolyline: boolean
): Array<{ a: number; b: number }> {
  if (
    pts.length < 2 ||
    (Math.abs(startFwdLateralPx) < 0.3 && Math.abs(endFwdLateralPx) < 0.3)
  ) {
    return pts;
  }

  // Subdivide hard polylines slightly on first/last segment so only approach zone shifts smoothly
  let workPts = pts;
  if (isHardPolyline && pts.length >= 2) {
    const dense: Array<{ a: number; b: number }> = [];
    for (let seg = 0; seg < pts.length - 1; seg++) {
      const s0 = pts[seg];
      const s1 = pts[seg + 1];
      const nSub = seg === 0 || seg === pts.length - 2 ? 10 : 2;
      for (let k = 0; k < nSub; k++) {
        const t = k / nSub;
        dense.push({ a: s0.a + (s1.a - s0.a) * t, b: s0.b + (s1.b - s0.b) * t });
      }
    }
    dense.push(pts[pts.length - 1]);
    workPts = dense;
  } else {
    workPts = subdivideLineIfNeeded(pts, true);
  }

  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < workPts.length; i++) {
    total += Math.hypot(workPts[i].a - workPts[i - 1].a, workPts[i].b - workPts[i - 1].b);
    cum.push(total);
  }
  if (total < 1) return workPts;

  return workPts.map((p, idx) => {
    const u = cum[idx] / total;
    const prev = workPts[Math.max(0, idx - 1)];
    const next = workPts[Math.min(workPts.length - 1, idx + 1)];
    const dx = next.a - prev.a;
    const dy = next.b - prev.b;
    const len = Math.max(1e-6, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;

    // Anchor circle center closely (0.35 at u=0), reach 1.0 under first car (u~0.08), taper smoothly to 0 by u=0.45
    const wStart =
      Math.abs(startFwdLateralPx) > 0.2 && u < 0.46
        ? (0.35 + 0.65 * Math.min(1, u / 0.07)) * smoothstep(1 - u / 0.46)
        : 0;
    const uEnd = 1 - u;
    const wEnd =
      Math.abs(endFwdLateralPx) > 0.2 && uEnd < 0.46
        ? (0.35 + 0.65 * Math.min(1, uEnd / 0.07)) * smoothstep(1 - uEnd / 0.46)
        : 0;

    const shift = startFwdLateralPx * wStart + endFwdLateralPx * wEnd;
    return {
      a: p.a + nx * shift,
      b: p.b + ny * shift,
    };
  });
}

function countSlotConflicts(
  cand: { x: number; y: number; angleDeg: number },
  routeId: string,
  fromId: string,
  toId: string,
  halfL: number,
  halfW: number,
  placedSlots: PlacedSlotOBB[],
  cityNodes: CityNodePx[]
): number {
  let conflicts = 0;
  for (const city of cityNodes) {
    const isEndpoint = city.id === fromId || city.id === toId;
    // Allow tight single/end cars to kiss endpoint city circles cleanly without false overlap triggers
    const pad = isEndpoint ? -0.6 : 2.0;
    if (
      circleOverlapsOBB(
        { x: city.x, y: city.y, r: Math.max(1, city.r + pad) },
        cand,
        halfL,
        halfW
      )
    ) {
      conflicts += isEndpoint ? 2 : 3;
    }
  }
  for (const other of placedSlots) {
    if (other.routeId === routeId) continue;
    if (
      obbOverlaps(
        cand,
        other,
        halfL + 0.7,
        halfW + 0.7,
        other.halfL + 0.7,
        other.halfW + 0.7
      )
    ) {
      conflicts += 1;
    }
  }
  return conflicts;
}

/**
 * Computes smart route curves and car slot positions across all routes on the board:
 * 1. Tighter dual-lane offsets everywhere (reduces double-route width).
 * 2. Per-city hub angular analysis: fans converging approaches laterally and pushes
 *    crowded single routes slightly back so double routes have clean breathing room.
 * 3. Inter-route 2D OBB slot deconfliction with uneven spacing & subtle lateral nudges.
 */
export function computeBoardLaneLayouts(
  locations: BoardLocation[],
  routes: BoardRoute[],
  projectLatLng: (lat: number, lng: number) => { x: number; y: number },
  trainLenPx: number,
  trainWidthPx: number,
  circleRadiusPx: number,
  options?: {
    claimedRoutes?: Record<string, ClaimedRouteState>;
    doubleRoutesAllowed?: boolean;
  }
): ComputedLaneLayout[] {
  const cityById = new Map<string, CityNodePx>();
  const cityNodes: CityNodePx[] = [];
  for (const loc of locations) {
    const pt = projectLatLng(loc.lat, loc.lng);
    const r = Math.max(4, loc.isMajorHub ? circleRadiusPx * 1.15 : circleRadiusPx);
    const node: CityNodePx = { id: loc.id, x: pt.x, y: pt.y, r };
    cityById.set(loc.id, node);
    cityNodes.push(node);
  }

  interface PreparedRoute {
    route: BoardRoute;
    from: CityNodePx;
    to: CityNodePx;
    effPathType: ReturnType<typeof resolveEffectivePathType>;
    hasAnchors: boolean;
    hasCorners: boolean;
    sampledRaw: Array<{ a: number; b: number }>;
    chordPx: number;
    thetaFrom: number;
    thetaTo: number;
  }

  const prepared: PreparedRoute[] = [];
  const citySpokes = new Map<
    string,
    Array<{
      routeId: string;
      end: 'from' | 'to';
      theta: number;
      isDouble: boolean;
      chordPx: number;
      length: number;
    }>
  >();

  for (const route of routes) {
    const from = cityById.get(route.fromId);
    const to = cityById.get(route.toId);
    if (!from || !to) continue;

    const effPathType = resolveEffectivePathType(
      route.pathType,
      route.waypoints,
      route.curveOffset
    );
    const effWaypoints = resolveEffectiveWaypoints(
      { lat: 0, lng: 0 }, // unused when waypoints exist, replaced properly below
      { lat: 0, lng: 0 },
      effPathType,
      route.waypoints,
      route.curveOffset
    );
    void effWaypoints;

    const fromGeo = locations.find((l) => l.id === route.fromId)!;
    const toGeo = locations.find((l) => l.id === route.toId)!;
    const resolvedWps = resolveEffectiveWaypoints(
      fromGeo,
      toGeo,
      effPathType,
      route.waypoints,
      route.curveOffset
    );
    const anchorsPx = resolvedWps.map((w) => {
      const p = projectLatLng(w.lat, w.lng);
      return { a: p.x, b: p.y, kind: w.kind, strength: w.strength ?? 1 };
    });
    const hasCorners = countCornerWaypoints(resolvedWps, effPathType) > 0;

    const sampledRaw = sampleGenericPath(
      { a: from.x, b: from.y },
      { a: to.x, b: to.y },
      anchorsPx,
      effPathType,
      24
    );
    const chordPx = Math.hypot(to.x - from.x, to.y - from.y);

    // Measure actual departure tangent near each endpoint (~14% along curve)
    const startProbeIdx = Math.min(
      sampledRaw.length - 1,
      Math.max(1, Math.floor((sampledRaw.length - 1) * 0.14))
    );
    const endProbeIdx = Math.max(
      0,
      Math.min(sampledRaw.length - 2, Math.ceil((sampledRaw.length - 1) * 0.86))
    );
    const pStartProbe = sampledRaw[startProbeIdx];
    const pEndProbe = sampledRaw[endProbeIdx];

    const thetaFrom = Math.atan2(pStartProbe.b - from.y, pStartProbe.a - from.x);
    const thetaTo = Math.atan2(pEndProbe.b - to.y, pEndProbe.a - to.x);

    prepared.push({
      route,
      from,
      to,
      effPathType,
      hasAnchors: anchorsPx.length > 0,
      hasCorners,
      sampledRaw,
      chordPx,
      thetaFrom,
      thetaTo,
    });

    const pushSpoke = (cityId: string, end: 'from' | 'to', theta: number) => {
      const arr = citySpokes.get(cityId) || [];
      arr.push({
        routeId: route.id,
        end,
        theta,
        isDouble: route.isDouble,
        chordPx,
        length: route.length,
      });
      citySpokes.set(cityId, arr);
    };

    pushSpoke(from.id, 'from', thetaFrom);
    pushSpoke(to.id, 'to', thetaTo);
  }

  // Pass 1: Analyze converging approaches around each city
  const endpointAdjust = new Map<string, EndpointAdjustment>();
  const getAdj = (routeId: string, end: 'from' | 'to'): EndpointAdjustment => {
    const key = `${routeId}:${end}`;
    let adj = endpointAdjust.get(key);
    if (!adj) {
      adj = { lateralPx: 0, setbackPx: 0 };
      endpointAdjust.set(key, adj);
    }
    return adj;
  };

  for (const [cityId, spokes] of citySpokes.entries()) {
    if (spokes.length < 2) continue;
    const city = cityById.get(cityId)!;
    const sorted = [...spokes].sort((a, b) => a.theta - b.theta);
    const m = sorted.length;
    const rCheck = city.r + trainLenPx * 0.55;

    for (let k = 0; k < m; k++) {
      const cur = sorted[k];
      const next = sorted[(k + 1) % m];
      let gap = next.theta - cur.theta;
      if (gap <= 0) gap += Math.PI * 2;

      const halfWCur = cur.isDouble ? trainWidthPx * 1.1 : trainWidthPx * 0.52;
      const halfWNext = next.isDouble ? trainWidthPx * 1.1 : trainWidthPx * 0.52;
      const desiredArc = halfWCur + halfWNext + trainWidthPx * 0.36;
      const minFloor = cur.isDouble || next.isDouble ? 0.54 : 0.40;
      const targetGap = clamp(desiredArc / Math.max(10, rCheck), minFloor, 1.08);

      if (gap < targetGap) {
        const sev = clamp((targetGap - gap) / targetGap, 0, 1);

        // Single routes yield laterally & via setback so double routes keep clear width
        let wCur = 0.5;
        let wNext = 0.5;
        if (cur.isDouble && !next.isDouble) {
          wCur = 0.24;
          wNext = 0.76;
        } else if (!cur.isDouble && next.isDouble) {
          wCur = 0.76;
          wNext = 0.24;
        } else if (cur.length !== next.length) {
          // Slightly prefer keeping short routes cleaner while longer routes adjust
          wCur = cur.length > next.length ? 0.62 : 0.38;
          wNext = 1 - wCur;
        }

        const totalLat = sev * trainWidthPx * 1.18;
        const adjCur = getAdj(cur.routeId, cur.end);
        const adjNext = getAdj(next.routeId, next.end);

        // cur shifts counter-clockwise (-outward normal), next shifts clockwise (+outward normal)
        adjCur.lateralPx -= totalLat * wCur;
        adjNext.lateralPx += totalLat * wNext;

        // Stagger setbacks so converging routes don't stop shoulder-to-shoulder at the same ring
        const curYieldsMore =
          wCur > wNext + 0.05 || (Math.abs(wCur - wNext) <= 0.05 && k % 2 === 1);
        const setCur = sev * trainLenPx * (curYieldsMore ? 0.88 : 0.22);
        const setNext = sev * trainLenPx * (curYieldsMore ? 0.22 : 0.88);
        adjCur.setbackPx = Math.max(adjCur.setbackPx, setCur);
        adjNext.setbackPx = Math.max(adjNext.setbackPx, setNext);
      }
    }

    // Clamp lateral fan and add gentle alternating stagger on very busy hubs (5+ spokes)
    for (let k = 0; k < m; k++) {
      const s = sorted[k];
      const adj = getAdj(s.routeId, s.end);
      const maxLat = trainWidthPx * (s.isDouble ? 0.95 : 1.35);
      adj.lateralPx = clamp(adj.lateralPx, -maxLat, maxLat);
      if (m >= 5 && k % 2 === 1 && !s.isDouble) {
        adj.setbackPx = Math.max(adj.setbackPx, trainLenPx * 0.38);
      }
      adj.setbackPx = clamp(adj.setbackPx, 0, trainLenPx * 1.05);
    }
  }

  // Pass 2: Place double routes first (higher priority), then shorter routes before longer ones
  const ordered = [...prepared].sort((a, b) => {
    if (a.route.isDouble !== b.route.isDouble) {
      return Number(b.route.isDouble) - Number(a.route.isDouble);
    }
    return a.chordPx - b.chordPx;
  });

  const placedSlots: PlacedSlotOBB[] = [];
  const laneResultsByRouteOrder = new Map<string, ComputedLaneLayout[]>();

  for (const item of ordered) {
    const { route, hasCorners, hasAnchors, sampledRaw } = item;
    const fromAdj = getAdj(route.id, 'from');
    const toAdj = getAdj(route.id, 'to');

    // Outward right-hand normal at 'to' is opposite the route's forward right-hand normal
    const startFwdLat = fromAdj.lateralPx;
    const endFwdLat = -toAdj.lateralPx;

    const fannedCenterPts = applyEndpointLateralFan(
      sampledRaw,
      startFwdLat,
      endFwdLat,
      hasCorners
    );

    const claim = options?.claimedRoutes?.[route.id];
    const hasClaim = Boolean(claim?.laneA || claim?.laneB || claim?.laneC);
    const laneCount = route.laneCount ?? (route.isDouble ? 2 : 1);
    const collapseMulti =
      laneCount >= 2 && options?.doubleRoutesAllowed === false && hasClaim;

    const lanes: Array<{
      lane: 'laneA' | 'laneB' | 'laneC';
      color: RouteColor;
      sign: number;
    }> = collapseMulti
      ? [
          claim?.laneC && !claim?.laneA && !claim?.laneB
            ? { lane: 'laneC', color: route.tripleColor || route.doubleColor || route.color, sign: 0 }
            : claim?.laneB && !claim?.laneA
              ? { lane: 'laneB', color: route.doubleColor || route.color, sign: 0 }
              : { lane: 'laneA', color: route.color, sign: 0 },
        ]
      : laneCount >= 3
        ? [
            { lane: 'laneA', color: route.color, sign: -2 },
            { lane: 'laneB', color: route.doubleColor || route.color, sign: 0 },
            { lane: 'laneC', color: route.tripleColor || route.doubleColor || route.color, sign: 2 },
          ]
        : laneCount === 2
          ? [
              { lane: 'laneA', color: route.color, sign: -1 },
              { lane: 'laneB', color: route.doubleColor || route.color, sign: 1 },
            ]
          : [{ lane: 'laneA', color: route.color, sign: 0 }];

    // Tighter parallel spacing everywhere so multi-lane routes have minimal effective width
    const dualOffsetFactor = route.isTunnel ? 0.59 : 0.525;
    const routeLayouts: ComputedLaneLayout[] = [];

    for (const laneSpec of lanes) {
      const laneOffsetPx = laneSpec.sign * (trainWidthPx * dualOffsetFactor);
      const offsetPts = offsetPolylinePx(fannedCenterPts, laneOffsetPx);
      const { pts: rawPts, totalLen } = buildArcTable(offsetPts);
      let pts = rawPts;

      const fromR = item.from.r;
      const toR = item.to.r;
      const count = Math.max(1, route.length);

      // Train car dimensions are strictly invariant across the entire board (never shrunk or stretched)
      const slotWidthPx = Math.max(3.5, trainWidthPx);
      const slotLenPx = trainLenPx;
      const halfL = slotLenPx * 0.5;
      const halfW = slotWidthPx * 0.5;

      const preferredPad = Math.min(totalLen * 0.12, circleRadiusPx * 0.16);
      const baseClearFrom = Math.min(totalLen * 0.24, fromR + preferredPad);
      const baseClearTo = Math.min(totalLen * 0.24, toR + preferredPad);
      const minCarsSpan = count * slotLenPx + Math.max(0, count - 1) * (slotLenPx * 0.04);

      let extraFrom = fromAdj.setbackPx;
      let extraTo = toAdj.setbackPx;
      const maxExtraBudget = Math.max(0, totalLen - baseClearFrom - baseClearTo - minCarsSpan);
      const sumExtra = extraFrom + extraTo;
      if (sumExtra > maxExtraBudget && sumExtra > 0.01) {
        const scale = maxExtraBudget / sumExtra;
        extraFrom *= scale;
        extraTo *= scale;
      }

      let startClear = baseClearFrom + extraFrom;
      let endClear = baseClearTo + extraTo;
      const desiredTightSpan = count * slotLenPx;
      let usablePx = totalLen - startClear - endClear;

      // On tight routes, relax endpoint clearance down until trains cleanly kiss the city rims
      if (usablePx < desiredTightSpan) {
        const shortfallIfTouching = Math.max(0, desiredTightSpan - Math.max(0, totalLen - fromR - toR));
        const minClearFrom = Math.max(0, fromR - shortfallIfTouching * 0.5);
        const minClearTo = Math.max(0, toR - shortfallIfTouching * 0.5);
        const excessFrom = Math.max(0, startClear - minClearFrom);
        const excessTo = Math.max(0, endClear - minClearTo);
        const need = desiredTightSpan - usablePx;
        const totalExcess = excessFrom + excessTo;
        if (totalExcess > 1e-4) {
          const takeFrac = Math.min(1, need / totalExcess);
          startClear -= excessFrom * takeFrac;
          endClear -= excessTo * takeFrac;
        }
        usablePx = totalLen - startClear - endClear;
      }

      let dists: number[] = [];
      const firstCenter = clamp(startClear + halfL, halfL * 0.2, totalLen * 0.5);
      const lastCenter = clamp(totalLen - endClear - halfL, firstCenter, Math.max(firstCenter, totalLen - halfL * 0.2));

      if (count === 1) {
        // Center single fixed-size train cleanly between both cities (kissing evenly when tight)
        const midBias = clamp(
          (startClear + totalLen - endClear) * 0.5,
          Math.min(firstCenter, totalLen * 0.5),
          Math.max(lastCenter, totalLen * 0.5)
        );
        dists.push(midBias);
      } else if (usablePx >= desiredTightSpan * 1.09) {
        for (let i = 0; i < count; i++) {
          dists.push(startClear + ((i + 0.5) / count) * usablePx);
        }
      } else {
        // Pack multi-car slots right up to the kissing city edges without shrinking pieces
        const spanCenters = Math.max(0, lastCenter - firstCenter);
        for (let i = 0; i < count; i++) {
          dists.push(firstCenter + (i / (count - 1)) * spanCenters);
        }
      }

      // Around sharp corners on composite routes, nudge only as needed without dropping or shrinking cars
      if (hasCorners && hasAnchors && count > 1) {
        const minCenterDist = Math.max(0.5, dists[0]);
        const maxCenterDist = Math.max(minCenterDist, dists[dists.length - 1]);
        const cornerDists: number[] = [dists[0]];
        for (let i = 1; i < count; i++) {
          let cursor = Math.max(dists[i], cornerDists[i - 1] + slotLenPx * 1.04);
          cursor = Math.min(cursor, maxCenterDist);
          let candidate = pointAtArcDistance(pts, cursor);
          const prev = pointAtArcDistance(pts, cornerDists[i - 1]);
          let nudges = 0;
          while (
            obbOverlaps(prev, candidate, halfL * 0.96, halfW * 0.94) &&
            cursor + 2 <= maxCenterDist &&
            nudges < 40
          ) {
            cursor = Math.min(maxCenterDist, cursor + 2);
            nudges += 1;
            candidate = pointAtArcDistance(pts, cursor);
          }
          cornerDists.push(cursor);
        }
        // Only adopt nudged corner spacing if all count cars remain cleanly distinct along the curve
        const tailGapOk =
          cornerDists.length === count &&
          cornerDists[count - 1] - cornerDists[count - 2] >= slotLenPx * 0.65;
        if (tailGapOk) {
          dists = cornerDists;
        }
      }

      if (ROUTE_LAYOUT_DEBUG_LEVEL >= 4) {
        console.debug('[routeLayout] placed lane', {
          routeId: route.id,
          count,
          slotLenPx,
          totalLen,
          usablePx,
        });
      }

      // Uneven-spacing + lateral-nudge deconfliction against city circles & other routes
      const minBound = Math.min(firstCenter, fromR + halfL * 0.9);
      const maxBound = Math.max(minBound + 1, totalLen - Math.min(totalLen - lastCenter, toR + halfL * 0.9));
      const minSelfSep = slotLenPx * 1.02;

      const normalNudges = new Array<number>(dists.length).fill(0);

      for (let i = 0; i < dists.length; i++) {
        const curPt = pointAtArcDistance(pts, dists[i]);
        const baseConflicts = countSlotConflicts(
          curPt,
          route.id,
          route.fromId,
          route.toId,
          halfL,
          halfW,
          placedSlots,
          cityNodes
        );
        if (baseConflicts === 0) continue;

        let bestDists = dists;
        let bestNudge = 0;
        let bestScore = baseConflicts * 1000;

        // 1) Try sliding this car toward the open middle of the route (cascading adjacent cars cleanly -> uneven spacing)
        const prefDir = i < dists.length / 2 ? 1 : -1;
        const dirs = [prefDir, -prefDir];
        const maxSlide = Math.min(trainLenPx * 1.5, usablePx * 0.45);
        const stepSize = Math.max(2, slotLenPx * 0.14);

        for (const dir of dirs) {
          for (let mag = stepSize; mag <= maxSlide; mag += stepSize) {
            const nextD = clamp(dists[i] + dir * mag, minBound, maxBound);
            const testDists = [...dists];
            testDists[i] = nextD;

            // Cascade forward/backward to keep minimum self-spacing along the lane
            let validCascade = true;
            let movedEndIdx = i;
            if (dir > 0) {
              for (let j = i + 1; j < testDists.length; j++) {
                if (testDists[j] < testDists[j - 1] + minSelfSep) {
                  testDists[j] = testDists[j - 1] + minSelfSep;
                  movedEndIdx = j;
                }
              }
              if (testDists[testDists.length - 1] > maxBound) validCascade = false;
            } else {
              for (let j = i - 1; j >= 0; j--) {
                if (testDists[j] > testDists[j + 1] - minSelfSep) {
                  testDists[j] = testDists[j + 1] - minSelfSep;
                  movedEndIdx = j;
                }
              }
              if (testDists[0] < minBound) validCascade = false;
            }

            if (!validCascade) continue;

            // Check conflicts across the moved slice of slots
            let cTotal = 0;
            const lo = Math.min(i, movedEndIdx);
            const hi = Math.max(i, movedEndIdx);
            for (let mIdx = lo; mIdx <= hi; mIdx++) {
              const candPt = pointAtArcDistance(pts, testDists[mIdx]);
              cTotal += countSlotConflicts(
                candPt,
                route.id,
                route.fromId,
                route.toId,
                halfL,
                halfW,
                placedSlots,
                cityNodes
              );
            }

            const penalty = cTotal * 1000 + mag * 0.35;
            if (penalty < bestScore) {
              bestScore = penalty;
              bestDists = testDists;
              bestNudge = 0;
            }
            if (cTotal === 0) break;
          }
          if (bestScore < 1000) break;
        }

        // 2) If longitudinal uneven spacing alone still touches, try subtle perpendicular slot nudges
        if (bestScore >= 1000) {
          const latSteps = [
            trainWidthPx * 0.38,
            -trainWidthPx * 0.38,
            trainWidthPx * 0.72,
            -trainWidthPx * 0.72,
          ];
          const basePt = pointAtArcDistance(pts, bestDists[i]);
          const rad = (basePt.angleDeg * Math.PI) / 180;
          const nx = -Math.sin(rad);
          const ny = Math.cos(rad);
          for (const lat of latSteps) {
            const shifted = {
              x: basePt.x + nx * lat,
              y: basePt.y + ny * lat,
              angleDeg: basePt.angleDeg,
            };
            const c = countSlotConflicts(
              shifted,
              route.id,
              route.fromId,
              route.toId,
              halfL,
              halfW,
              placedSlots,
              cityNodes
            );
            const penalty = c * 1000 + Math.abs(lat) * 2.5;
            if (penalty < bestScore) {
              bestScore = penalty;
              bestNudge = lat;
            }
          }
        }

        dists = bestDists;
        normalNudges[i] = bestNudge;
      }

      const slots: ComputedSlot[] = dists.map((d, idx) => {
        const pt = pointAtArcDistance(pts, d);
        const nudge = normalNudges[idx] || 0;
        let x = pt.x;
        let y = pt.y;
        if (Math.abs(nudge) > 0.1) {
          const rad = (pt.angleDeg * Math.PI) / 180;
          x += -Math.sin(rad) * nudge;
          y += Math.cos(rad) * nudge;
        }
        placedSlots.push({
          routeId: route.id,
          x,
          y,
          angleDeg: pt.angleDeg,
          halfL,
          halfW,
        });
        return {
          ...pt,
          x,
          y,
          idx,
          isFerryLoco: idx < route.ferryLocomotives,
        };
      });

      const track = buildTrackGeometry(
        item.from,
        item.to,
        slots,
        slotLenPx,
        slotWidthPx
      );

      routeLayouts.push({
        route,
        lane: laneSpec.lane,
        laneColor: laneSpec.color,
        pts,
        slots,
        slotLenPx,
        slotWidthPx,
        hitPathD: track.hitPathD,
        railsPathD: track.railsPathD,
        tiesPathD: track.tiesPathD,
      });
    }

    laneResultsByRouteOrder.set(route.id, routeLayouts);
  }

  // Emit in original board.routes order for stable SVG DOM ordering
  const out: ComputedLaneLayout[] = [];
  for (const route of routes) {
    const res = laneResultsByRouteOrder.get(route.id);
    if (res) out.push(...res);
  }
  return out;
}
