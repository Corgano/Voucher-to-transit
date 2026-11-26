import type { BoundingBox, RoutePathType, RouteWaypoint, WaypointKind } from './types';

const EARTH_RADIUS_M = 6371000;

/**
 * Train car length is 250% (2.5x) of city circle diameter D (25% longer than 2.0x),
 * and train car width is 80% (0.8x) of city circle diameter D.
 */
export const TRAIN_TO_CIRCLE_RATIO = 2.5;
export const TRAIN_WIDTH_TO_CIRCLE_RATIO = 0.8;

/**
 * Module-scoped debug verbosity level:
 * 0 = errors only, 1 = major steps, 2 = light debug, 3 = detailed debug, 4 = full console spam.
 */
export const GEO_SCALE_DEBUG_LEVEL = 0;

/**
 * Computes the great-circle surface distance between two WGS84 points.
 * Call with (lat1, lng1, lat2, lng2) in decimal degrees.
 * Returns distance in meters.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Computes the horizontal span of a geographic bounding box at its mid-latitude.
 * Call with a BoundingBox { south, west, north, east }.
 * Returns width in meters (minimum 100).
 */
export function computeBoxWidthMeters(bbox: BoundingBox): number {
  const midLat = (bbox.south + bbox.north) / 2;
  return Math.max(100, haversineMeters(midLat, bbox.west, midLat, bbox.east));
}

/**
 * Computes the SW-to-NE diagonal span of a geographic bounding box.
 * Call with a BoundingBox { south, west, north, east }.
 * Returns diagonal distance in meters (minimum 100).
 */
export function computeBoxDiagMeters(bbox: BoundingBox): number {
  return Math.max(100, haversineMeters(bbox.south, bbox.west, bbox.north, bbox.east));
}

/**
 * Computes the natural meters-per-train scale ratio for a bounding box.
 * Calibrated for 2.5x train-to-circle proportions across the board area.
 * Call with (bbox, optional target trainsAcrossWidth).
 * Returns meters per 1 train slot.
 */
export function computeIdealMetersPerTrain(
  bbox: BoundingBox,
  trainsAcrossWidth = 17.5
): number {
  const widthM = computeBoxWidthMeters(bbox);
  return Math.max(15, Math.round((widthM / Math.max(8, trainsAcrossWidth)) * 10) / 10);
}

/**
 * Formats a meters-per-train value into human-readable units.
 * Call with metersPerTrain (numeric meters).
 * Returns formatted scale string (e.g., "4.2 km / train" or "650 m / train").
 */
export function formatScaleRatio(metersPerTrain: number): string {
  if (metersPerTrain >= 1000) {
    const km = metersPerTrain / 1000;
    return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km / train`;
  }
  return `${Math.round(metersPerTrain)} m / train`;
}

/**
 * Computes ground resolution (meters per WebMercator pixel) at latitude and zoom.
 * Call with decimal lat and Leaflet zoom level.
 * Returns meters per pixel.
 */
export function metersPerPixelAt(lat: number, zoom: number): number {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  return (156543.03392 * Math.cos((clampedLat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/**
 * Converts a legacy percentage lateral curveOffset into a single midpoint RouteWaypoint.
 * Call with from/to lat-lng endpoints and signed curveOffset (-90..90).
 * Returns a 'curve' RouteWaypoint or undefined when offset is near zero.
 */
export function computeControlLatLngFromOffset(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  curveOffset: number
): RouteWaypoint | undefined {
  if (Math.abs(curveOffset) < 1) return undefined;
  const midLat = (from.lat + to.lat) / 2;
  const midLng = (from.lng + to.lng) / 2;
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dx = dLng * cosLat;
  const dy = dLat;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const nx = -dy / len;
  const ny = dx / len;
  // Pass-through curve arch reaches midpoint offset directly
  const ratio = (curveOffset / 100) * 0.65;
  return {
    lat: midLat + ny * len * ratio,
    lng: midLng + (nx * len * ratio) / cosLat,
    kind: 'curve',
    strength: 1,
  };
}

/**
 * Determines the effective path hint for backwards compatibility with legacy boards.
 * Note: routes now evaluate uniformly as a composite path supporting both 'corner' and 'curve' waypoints.
 * Call with (pathType, waypoints, curveOffset).
 * Returns effective RoutePathType.
 */
export function resolveEffectivePathType(
  pathType: RoutePathType | undefined,
  waypoints: RouteWaypoint[] | undefined,
  curveOffset: number
): RoutePathType {
  if (waypoints && waypoints.length > 0) {
    const allCorner = waypoints.every((w) => (w.kind || pathType === 'polyline' ? (w.kind || 'corner') === 'corner' : false));
    return allCorner ? 'polyline' : 'bezier';
  }
  if (pathType) return pathType;
  if (Math.abs(curveOffset) >= 1) return 'bezier';
  return 'line';
}

/**
 * Resolves the active waypoint list for a route/corridor, normalizing each waypoint's kind ('corner' | 'curve').
 * Call with (from, to, pathType, waypoints, curveOffset).
 * Returns normalized RouteWaypoint[] with explicit `kind`.
 */
export function resolveEffectiveWaypoints(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  pathType: RoutePathType | undefined,
  waypoints: RouteWaypoint[] | undefined,
  curveOffset: number
): RouteWaypoint[] {
  if (waypoints && waypoints.length > 0) {
    const fallbackKind: WaypointKind = pathType === 'polyline' ? 'corner' : 'curve';
    return waypoints.map((w) => ({
      ...w,
      kind: w.kind || fallbackKind,
      strength: w.strength ?? 1,
    }));
  }
  if (pathType !== 'line' && Math.abs(curveOffset) >= 1) {
    const legacy = computeControlLatLngFromOffset(from, to, curveOffset);
    return legacy ? [legacy] : [];
  }
  return [];
}

/**
 * Counts how many interior waypoints in a list act as sharp 'corner' vertices.
 * Call with (waypoints, fallbackPathType).
 * Returns count of sharp corner vertices.
 */
export function countCornerWaypoints(
  waypoints: RouteWaypoint[] | undefined,
  fallbackPathType?: RoutePathType
): number {
  if (!waypoints || waypoints.length === 0) return 0;
  const fallbackKind: WaypointKind = fallbackPathType === 'polyline' ? 'corner' : 'curve';
  let corners = 0;
  for (const w of waypoints) {
    if ((w.kind || fallbackKind) === 'corner') corners += 1;
  }
  return corners;
}

/**
 * Evaluates a unified composite path made of mixed hard-corner ('corner') and smooth pass-through ('curve')
 * waypoints into a sequence of { a, b } points (works identically for { lat, lng } or { x, y }).
 * Call with start point p0, end point p1, anchors with optional kind/strength, legacy pathType hint, and samplesPerSegment.
 * Returns sampled point array from p0 to p1 passing directly through every anchor.
 */
export function sampleGenericPath(
  p0: { a: number; b: number },
  p1: { a: number; b: number },
  anchors: Array<{ a: number; b: number; kind?: WaypointKind; strength?: number }>,
  pathType: RoutePathType = 'bezier',
  samplesPerSegment = 22
): Array<{ a: number; b: number }> {
  if (anchors.length === 0) {
    return [p0, p1];
  }

  const fallbackKind: WaypointKind = pathType === 'polyline' ? 'corner' : 'curve';
  const nodes: Array<{ a: number; b: number; kind: WaypointKind; strength: number }> = [
    { a: p0.a, b: p0.b, kind: 'corner', strength: 1 },
    ...anchors.map((w) => ({
      a: w.a,
      b: w.b,
      kind: w.kind || fallbackKind,
      strength: w.strength ?? 1,
    })),
    { a: p1.a, b: p1.b, kind: 'corner', strength: 1 },
  ];

  // Fast path: if all anchors are hard corners, emit exact vertex sequence with no extra subsampling needed
  if (nodes.every((n) => n.kind === 'corner')) {
    return nodes.map((n) => ({ a: n.a, b: n.b }));
  }

  // Precompute incoming & outgoing cubic handles for each 'curve' interior node
  const handlesIn: Array<{ a: number; b: number } | null> = new Array(nodes.length).fill(null);
  const handlesOut: Array<{ a: number; b: number } | null> = new Array(nodes.length).fill(null);

  for (let i = 1; i < nodes.length - 1; i++) {
    const cur = nodes[i];
    if (cur.kind !== 'curve') continue;

    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    const dxChord = next.a - prev.a;
    const dyChord = next.b - prev.b;
    const chordLen = Math.hypot(dxChord, dyChord);
    const lenIn = Math.hypot(cur.a - prev.a, cur.b - prev.b);
    const lenOut = Math.hypot(next.a - cur.a, next.b - cur.b);

    if (chordLen < 1e-9 || lenIn < 1e-9 || lenOut < 1e-9) {
      handlesIn[i] = { a: cur.a, b: cur.b };
      handlesOut[i] = { a: cur.a, b: cur.b };
      continue;
    }

    const ux = dxChord / chordLen;
    const uy = dyChord / chordLen;
    const scale = Math.max(0.2, Math.min(1.6, cur.strength));
    // Clamp handle lengths per incoming/outgoing segment to avoid loops on asymmetric segments
    const magIn = Math.min(lenIn * 0.42, chordLen * 0.22 * scale);
    const magOut = Math.min(lenOut * 0.42, chordLen * 0.22 * scale);

    handlesIn[i] = { a: cur.a - ux * magIn, b: cur.b - uy * magIn };
    handlesOut[i] = { a: cur.a + ux * magOut, b: cur.b + uy * magOut };
  }

  const out: Array<{ a: number; b: number }> = [];
  const segSamples = Math.max(12, samplesPerSegment);

  for (let i = 0; i < nodes.length - 1; i++) {
    const cur = nodes[i];
    const next = nodes[i + 1];
    const curIsCurve = cur.kind === 'curve' && handlesOut[i] !== null;
    const nextIsCurve = next.kind === 'curve' && handlesIn[i + 1] !== null;

    if (!curIsCurve && !nextIsCurve) {
      // Straight segment between two sharp corners (or endpoints)
      if (i === 0) out.push({ a: cur.a, b: cur.b });
      out.push({ a: next.a, b: next.b });
      continue;
    }

    let cp1: { a: number; b: number };
    let cp2: { a: number; b: number };

    if (curIsCurve && nextIsCurve) {
      cp1 = handlesOut[i]!;
      cp2 = handlesIn[i + 1]!;
    } else if (!curIsCurve && nextIsCurve) {
      cp2 = handlesIn[i + 1]!;
      // Depart cleanly out of corner toward cp2 without reverse wiggle
      cp1 = {
        a: cur.a + (cp2.a - cur.a) * 0.45,
        b: cur.b + (cp2.b - cur.b) * 0.45,
      };
    } else {
      cp1 = handlesOut[i]!;
      // Approach cleanly into corner from cp1 without reverse wiggle
      cp2 = {
        a: next.a + (cp1.a - next.a) * 0.45,
        b: next.b + (cp1.b - next.b) * 0.45,
      };
    }

    const startStep = i === 0 ? 0 : 1;
    for (let s = startStep; s <= segSamples; s++) {
      const t = s / segSamples;
      const mt = 1 - t;
      out.push({
        a:
          mt * mt * mt * cur.a +
          3 * mt * mt * t * cp1.a +
          3 * mt * t * t * cp2.a +
          t * t * t * next.a,
        b:
          mt * mt * mt * cur.b +
          3 * mt * mt * t * cp1.b +
          3 * mt * t * t * cp2.b +
          t * t * t * next.b,
      });
    }
  }

  if (GEO_SCALE_DEBUG_LEVEL >= 4) {
    console.debug('[geoScale] sampleGenericPath evaluated', {
      anchorCount: anchors.length,
      outputPoints: out.length,
    });
  }

  return out;
}

/**
 * Finds the best insertion index inside `waypoints` when adding a new corner/curve point at `clickPt`.
 * Identifies the closest consecutive pair `(nodes[i], nodes[i+1])` along `p0 -> ...waypoints -> p1`
 * using segment proximity plus endpoint-pair tie-breaking so points insert naturally in the middle.
 * Call with p0, p1, existing waypoints (may be empty), clickPt { lat, lng }, and optional fallbackPathType.
 * Returns integer index in [0..waypoints.length].
 */
export function findBestWaypointInsertIndex(
  p0: { lat: number; lng: number },
  p1: { lat: number; lng: number },
  waypoints: RouteWaypoint[],
  clickPt: { lat: number; lng: number },
  fallbackPathType: RoutePathType = 'bezier'
): number {
  if (!waypoints || waypoints.length === 0) return 0;

  const midLat = (p0.lat + p1.lat) * 0.5;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const nodes: Array<{ lat: number; lng: number; kind?: WaypointKind; strength?: number }> = [
    p0,
    ...waypoints,
    p1,
  ];

  let bestSegIdx = 0;
  let bestScore = Infinity;

  // Evaluate each consecutive node pair [i -> i+1] combining span distance + small endpoint pair sum
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const dx = (b.lng - a.lng) * cosLat;
    const dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    let segDist: number;
    if (lenSq < 1e-12) {
      segDist = Math.hypot((clickPt.lng - a.lng) * cosLat, clickPt.lat - a.lat);
    } else {
      const t = Math.max(
        0,
        Math.min(1, (((clickPt.lng - a.lng) * cosLat) * dx + (clickPt.lat - a.lat) * dy) / lenSq)
      );
      segDist = Math.hypot(
        (clickPt.lng - a.lng) * cosLat - t * dx,
        clickPt.lat - a.lat - t * dy
      );
    }
    const dA = Math.hypot((clickPt.lng - a.lng) * cosLat, clickPt.lat - a.lat);
    const dB = Math.hypot((clickPt.lng - b.lng) * cosLat, clickPt.lat - b.lat);
    // Weight segment closeness primarily while breaking equidistant ties by the closest pair of endpoints
    const score = segDist + 0.14 * (dA + dB);
    if (score < bestScore) {
      bestScore = score;
      bestSegIdx = i;
    }
  }

  if (GEO_SCALE_DEBUG_LEVEL >= 3) {
    console.debug('[geoScale] findBestWaypointInsertIndex', {
      waypointCount: waypoints.length,
      bestSegIdx,
      fallbackPathType,
    });
  }

  return Math.max(0, Math.min(waypoints.length, bestSegIdx));
}

/**
 * Samples a parent corridor's composite polyline in local metric coordinates centered at endpoint `p0`
 * and computes cumulative arc-length fractions for parametric relative offset calculations.
 * Call with (p0, p1, corridorWaypoints, pathType, curveOffset).
 * Returns sampled local-meter vertices, totalMeters, and cosine-scaled degree factors.
 */
function buildCorridorMetricPoly(
  p0: { lat: number; lng: number },
  p1: { lat: number; lng: number },
  corridorWaypoints: RouteWaypoint[] | undefined,
  pathType: RoutePathType | undefined,
  curveOffset: number
): {
  pts: Array<{ lat: number; lng: number; mx: number; my: number; cumM: number }>;
  totalMeters: number;
  mPerDegLat: number;
  mPerDegLng: number;
} {
  const midLat = (p0.lat + p1.lat) * 0.5;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const effType = resolveEffectivePathType(pathType, corridorWaypoints, curveOffset);
  const effAnchors = resolveEffectiveWaypoints(p0, p1, effType, corridorWaypoints, curveOffset);
  const sampled = sampleGenericPath(
    { a: p0.lat, b: p0.lng },
    { a: p1.lat, b: p1.lng },
    effAnchors.map((w) => ({ a: w.lat, b: w.lng, kind: w.kind, strength: w.strength })),
    effType,
    24
  );

  const pts: Array<{ lat: number; lng: number; mx: number; my: number; cumM: number }> = [];
  let cumM = 0;
  for (let i = 0; i < sampled.length; i++) {
    const lat = sampled[i].a;
    const lng = sampled[i].b;
    const mx = (lng - p0.lng) * mPerDegLng;
    const my = (lat - p0.lat) * mPerDegLat;
    if (i > 0) {
      cumM += Math.hypot(mx - pts[i - 1].mx, my - pts[i - 1].my);
    }
    pts.push({ lat, lng, mx, my, cumM });
  }
  return {
    pts,
    totalMeters: Math.max(10, cumM),
    mPerDegLat,
    mPerDegLng,
  };
}

/**
 * Projects a geographic point `targetPt` onto a linked Step 3 corridor's composite path,
 * returning its normalized along-corridor position `relT` in [0.02..0.98] and signed
 * lateral offset `relOffsetRatio` (perpendicular meters divided by total corridor arc meters).
 * Call with corridor endpoints (p0, p1), corridor waypoints/pathType/curveOffset, and targetPt.
 * Returns { relT, relOffsetRatio }.
 */
export function projectPointOntoCorridorCurve(
  p0: { lat: number; lng: number },
  p1: { lat: number; lng: number },
  corridorWaypoints: RouteWaypoint[] | undefined,
  pathType: RoutePathType | undefined,
  curveOffset: number,
  targetPt: { lat: number; lng: number }
): { relT: number; relOffsetRatio: number } {
  const { pts, totalMeters, mPerDegLat, mPerDegLng } = buildCorridorMetricPoly(
    p0,
    p1,
    corridorWaypoints,
    pathType,
    curveOffset
  );
  if (pts.length < 2) {
    return { relT: 0.5, relOffsetRatio: 0 };
  }
  const px = (targetPt.lng - p0.lng) * mPerDegLng;
  const py = (targetPt.lat - p0.lat) * mPerDegLat;

  let bestDistSq = Infinity;
  let bestCumM = totalMeters * 0.5;
  let bestSignedPerpM = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.mx - a.mx;
    const dy = b.my - a.my;
    const segLenSq = dx * dx + dy * dy;
    const segLen = Math.sqrt(segLenSq);
    if (segLen < 1e-4) continue;
    const t = Math.max(0, Math.min(1, ((px - a.mx) * dx + (py - a.my) * dy) / segLenSq));
    const projX = a.mx + t * dx;
    const projY = a.my + t * dy;
    const rx = px - projX;
    const ry = py - projY;
    const dSq = rx * rx + ry * ry;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestCumM = a.cumM + t * segLen;
      // Left-hand normal (-dy/segLen, dx/segLen)
      const nx = -dy / segLen;
      const ny = dx / segLen;
      bestSignedPerpM = rx * nx + ry * ny;
    }
  }

  return {
    relT: Math.max(0.02, Math.min(0.98, Math.round((bestCumM / totalMeters) * 10000) / 10000)),
    relOffsetRatio: Math.round((bestSignedPerpM / totalMeters) * 10000) / 10000,
  };
}

/**
 * Recomputes a geographic waypoint coordinate from a parametric relative position `(relT, relOffsetRatio)`
 * anchored to an updated parent Step 3 corridor curve so corridor tweaks carry attached train routes proportionally.
 * Call with (p0, p1, corridorWaypoints, pathType, curveOffset, relT, relOffsetRatio).
 * Returns updated { lat, lng }.
 */
export function evaluateRelativeWaypointOnCorridor(
  p0: { lat: number; lng: number },
  p1: { lat: number; lng: number },
  corridorWaypoints: RouteWaypoint[] | undefined,
  pathType: RoutePathType | undefined,
  curveOffset: number,
  relT: number,
  relOffsetRatio: number
): { lat: number; lng: number } {
  const { pts, totalMeters, mPerDegLat, mPerDegLng } = buildCorridorMetricPoly(
    p0,
    p1,
    corridorWaypoints,
    pathType,
    curveOffset
  );
  if (pts.length < 2) {
    return {
      lat: p0.lat + (p1.lat - p0.lat) * relT,
      lng: p0.lng + (p1.lng - p0.lng) * relT,
    };
  }
  const targetCum = Math.max(0, Math.min(totalMeters, relT * totalMeters));
  let segIdx = pts.length - 2;
  for (let i = 0; i < pts.length - 1; i++) {
    if (targetCum <= pts[i + 1].cumM) {
      segIdx = i;
      break;
    }
  }
  const a = pts[segIdx];
  const b = pts[segIdx + 1];
  const segLen = Math.max(1e-4, Math.hypot(b.mx - a.mx, b.my - a.my));
  const localT = Math.max(0, Math.min(1, (targetCum - a.cumM) / segLen));
  const baseX = a.mx + (b.mx - a.mx) * localT;
  const baseY = a.my + (b.my - a.my) * localT;
  const nx = -(b.my - a.my) / segLen;
  const ny = (b.mx - a.mx) / segLen;
  const perpM = relOffsetRatio * totalMeters;

  return {
    lat: Number((p0.lat + (baseY + ny * perpM) / mPerDegLat).toFixed(6)),
    lng: Number((p0.lng + (baseX + nx * perpM) / mPerDegLng).toFixed(6)),
  };
}

/**
 * Computes the total geographic arc length of a route or corridor in meters.
 * Call with from/to endpoints, optional pathType hint, waypoints, and legacy curveOffset.
 * Returns arc length in meters.
 */
export function computeRouteGeoArcMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  pathType: RoutePathType | undefined,
  waypoints: RouteWaypoint[] | undefined,
  curveOffset = 0
): number {
  const mode = resolveEffectivePathType(pathType, waypoints, curveOffset);
  const anchors = resolveEffectiveWaypoints(from, to, mode, waypoints, curveOffset);
  const sampled = sampleGenericPath(
    { a: from.lat, b: from.lng },
    { a: to.lat, b: to.lng },
    anchors.map((w) => ({ a: w.lat, b: w.lng, kind: w.kind, strength: w.strength })),
    mode,
    20
  );
  let total = 0;
  for (let i = 1; i < sampled.length; i++) {
    total += haversineMeters(
      sampled[i - 1].a,
      sampled[i - 1].b,
      sampled[i].a,
      sampled[i].b
    );
  }
  return total;
}

/**
 * Legacy helper wrapper kept for compatibility with single control-point calls.
 * Call with from/to coordinates and optional single curve control point.
 * Returns arc length in meters.
 */
export function computeGeoArcMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  control?: { lat: number; lng: number }
): number {
  return computeRouteGeoArcMeters(
    from,
    to,
    control ? 'bezier' : 'line',
    control ? [{ ...control, kind: 'curve' }] : [],
    0
  );
}

/**
 * Converts real-world route arc length (minus exact two endpoint radii = 0.4 * L + breathing pad)
 * into an integer chain of non-overlapping full-size trains (~10% inter-train gap).
 * Never assigns N >= 2 when N full-size trains cannot physically fit between city rims without shrinking.
 * Call with arcMeters, metersPerTrain, optional pathType, and cornerCount (or waypoints array).
 * Returns clamped integer train length in [1..20].
 */
export function computeChainTrainCount(
  arcMeters: number,
  metersPerTrain: number,
  pathType?: RoutePathType,
  cornerOrWaypoints: number | RouteWaypoint[] = 0
): number {
  const twoRadii = metersPerTrain / TRAIN_TO_CIRCLE_RATIO; // 2 * (L / 5) = 0.40 * L
  const endpointClearance = twoRadii + metersPerTrain * 0.08;
  const cornerCount = Array.isArray(cornerOrWaypoints)
    ? countCornerWaypoints(cornerOrWaypoints, pathType)
    : pathType === 'polyline'
      ? cornerOrWaypoints
      : 0;
  const cornerAllowance = cornerCount > 0 ? cornerCount * metersPerTrain * 0.22 : 0;
  const usableMeters = Math.max(
    metersPerTrain * 0.85,
    arcMeters - endpointClearance - cornerAllowance
  );
  const g = 0.10;
  let count = Math.max(1, Math.min(20, Math.round((usableMeters / metersPerTrain + g) / (1 + g))));
  while (count > 1 && arcMeters - twoRadii - cornerAllowance < count * metersPerTrain * 0.98) {
    count -= 1;
  }
  return count;
}
