import crypto from 'crypto';
import type {
  BoardDefinition,
  BoardLocation,
  BoardRoute,
  BoardTheme,
  BoundingBox,
  DestinationTicket,
  GenerationParams,
  GenerationStageArtifact,
  HazardType,
  RouteColor,
  RoutePathType,
  RouteWaypoint,
  StageEdgeSnapshot,
  TicketGrade,
  TransportMode,
} from '../src/shared/types.ts';
import type { RawHazardZone, RawRegionDataset, RawTransitCorridor } from './db.ts';
import { getRoutePoints, normalizeGameRules, TTR_AVERAGE_BENCHMARK } from '../src/shared/benchmarks.ts';
import {
  computeBoxWidthMeters,
  computeChainTrainCount,
  computeControlLatLngFromOffset,
  computeIdealMetersPerTrain,
  computeRouteGeoArcMeters,
  haversineMeters,
} from '../src/shared/geoScale.ts';

const CANVAS_W = 1000;
const CANVAS_H = 700;
const MARGIN_X = 62;
const MARGIN_Y = 52;

const ROUTE_COLORS_POOL: RouteColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
];

function projectPoint(
  lat: number,
  lng: number,
  bbox: BoundingBox
): { x: number; y: number } {
  const lonSpan = Math.max(0.0001, bbox.east - bbox.west);
  const latSpan = Math.max(0.0001, bbox.north - bbox.south);
  const nx = (lng - bbox.west) / lonSpan;
  const ny = 1 - (lat - bbox.south) / latSpan;
  return {
    x: Math.round((MARGIN_X + nx * (CANVAS_W - MARGIN_X * 2)) * 10) / 10,
    y: Math.round((MARGIN_Y + ny * (CANVAS_H - MARGIN_Y * 2)) * 10) / 10,
  };
}

function unprojectPointToLatLng(
  x: number,
  y: number,
  bbox: BoundingBox
): { lat: number; lng: number } {
  const nx = (x - MARGIN_X) / (CANVAS_W - MARGIN_X * 2);
  const ny = (y - MARGIN_Y) / (CANVAS_H - MARGIN_Y * 2);
  return {
    lat: bbox.south + (1 - ny) * (bbox.north - bbox.south),
    lng: bbox.west + nx * (bbox.east - bbox.west),
  };
}

function distPx(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Segment intersection helper (excluding shared endpoints)
function segmentsIntersectionPoint(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number }
): { x: number; y: number; angleDeg: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return null;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;

  if (t > 0.08 && t < 0.92 && u > 0.08 && u < 0.92) {
    const dot = d1x * d2x + d1y * d2y;
    const lenProd = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
    const cos = Math.max(-1, Math.min(1, dot / Math.max(1e-6, lenProd)));
    const angleDeg = (Math.acos(Math.abs(cos)) * 180) / Math.PI;
    return {
      x: Math.round((p1.x + t * d1x) * 10) / 10,
      y: Math.round((p1.y + t * d1y) * 10) / 10,
      angleDeg,
    };
  }
  return null;
}

function pointToSegmentDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return distPx(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return distPx(p, { x: a.x + t * dx, y: a.y + t * dy });
}

interface ProjectedCorridor {
  id: string;
  mode: TransportMode;
  weight: number;
  isTunnel: boolean;
  isBridge: boolean;
  name?: string;
  pts: { x: number; y: number }[];
  geoPts: { lat: number; lng: number }[];
}

function evaluateCorridorAlignment(
  a: BoardLocation,
  b: BoardLocation,
  corridors: ProjectedCorridor[],
  hazards: Array<RawHazardZone & { x: number; y: number }>
): {
  transitWeight: number;
  mode: TransportMode;
  isTunnel: boolean;
  ferryLocomotives: number;
  roadHazardNearMid: number;
  maritimeHazardNearMid: number;
  realLineName?: string;
} {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const q1 = { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 };
  const q3 = { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 };

  let bestWeight = 20;
  let bestMode: TransportMode = a.category === 'port' && b.category === 'port' ? 'ferry' : 'highway';
  let bestName: string | undefined;
  let tunnelHits = 0;

  for (const c of corridors) {
    if (c.pts.length < 2) continue;
    let minMid = Infinity;
    let minQ1 = Infinity;
    let minQ3 = Infinity;
    for (let i = 0; i < c.pts.length - 1; i++) {
      const p1 = c.pts[i];
      const p2 = c.pts[i + 1];
      minMid = Math.min(minMid, pointToSegmentDist(mid, p1, p2));
      minQ1 = Math.min(minQ1, pointToSegmentDist(q1, p1, p2));
      minQ3 = Math.min(minQ3, pointToSegmentDist(q3, p1, p2));
    }

    const avgCorridorDist = (minMid + minQ1 + minQ3) / 3;
    if (avgCorridorDist < 46) {
      const proximityFactor = 1 - avgCorridorDist / 50;
      const effectiveWeight = Math.round(c.weight * (0.55 + 0.45 * proximityFactor));
      if (effectiveWeight > bestWeight) {
        bestWeight = effectiveWeight;
        bestMode = c.mode;
        bestName = c.name;
      }
      if (c.isTunnel || c.isBridge) {
        tunnelHits += 1;
      }
    }
  }

  if (bestWeight < 40 && (a.category === 'landmark' || b.category === 'landmark')) {
    bestMode = 'bus';
  }

  let roadHazardNearMid = 0;
  let maritimeHazardNearMid = 0;
  for (const h of hazards) {
    const d = pointToSegmentDist({ x: h.x, y: h.y }, a, b);
    if (d < 34) {
      if (h.type === 'tunnel_terrain') tunnelHits += 1;
      if (h.type === 'road_intersection') roadHazardNearMid = Math.max(roadHazardNearMid, h.severity);
      if (h.type === 'maritime_hazard') maritimeHazardNearMid = Math.max(maritimeHazardNearMid, h.severity);
    }
  }

  const isTunnel = tunnelHits > 0;
  const ferryLocomotives =
    bestMode === 'ferry' ? (distPx(a, b) > 165 ? 2 : 1) : 0;

  return {
    transitWeight: Math.min(100, bestWeight),
    mode: bestMode,
    isTunnel,
    ferryLocomotives,
    roadHazardNearMid,
    maritimeHazardNearMid,
    realLineName: bestName,
  };
}

/**
 * Ramer-Douglas-Peucker simplification on local meter coordinates (mx, my).
 */
function rdpSimplify(
  pts: Array<{ lat: number; lng: number; mx: number; my: number }>,
  epsilonMeters: number
): Array<{ lat: number; lng: number; mx: number; my: number }> {
  if (pts.length <= 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = last.mx - first.mx;
  const dy = last.my - first.my;
  const lenSq = dx * dx + dy * dy;

  let maxDist = -1;
  let maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    let dist: number;
    if (lenSq < 1e-3) {
      dist = Math.hypot(p.mx - first.mx, p.my - first.my);
    } else {
      const t = Math.max(0, Math.min(1, ((p.mx - first.mx) * dx + (p.my - first.my) * dy) / lenSq));
      dist = Math.hypot(p.mx - (first.mx + t * dx), p.my - (first.my + t * dy));
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilonMeters) {
    const left = rdpSimplify(pts.slice(0, maxIdx + 1), epsilonMeters);
    const right = rdpSimplify(pts.slice(maxIdx), epsilonMeters);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/**
 * Traces real OSM rail/road/bus corridors between two stops, returning geo waypoints
 * and choosing 'bezier' or 'polyline' depending on bend sharpness.
 */
function traceCorridorWaypoints(
  a: BoardLocation,
  b: BoardLocation,
  preferredMode: TransportMode,
  corridors: ProjectedCorridor[],
  metersPerTrain: number,
  curveIntensity: number,
  traceEnabled: boolean,
  edgeIndex: number,
  transitWeight: number
): {
  pathType: RoutePathType;
  waypoints?: RouteWaypoint[];
  curveOffset: number;
  tracedFromCorridor: boolean;
} {
  const chordMeters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  if (!traceEnabled || preferredMode === 'ferry' || chordMeters < metersPerTrain * 1.1) {
    const curveMax = (curveIntensity / 100) * 32;
    let curveOffset = 0;
    const needsCurve =
      transitWeight < 45 || preferredMode === 'ferry' || chordMeters < metersPerTrain * 3.5;
    if (curveMax > 2 && needsCurve) {
      curveOffset = Math.round((edgeIndex % 2 === 0 ? 1 : -1) * Math.min(curveMax, 26));
    }
    const ctrl = computeControlLatLngFromOffset(a, b, curveOffset);
    return {
      pathType: ctrl ? 'bezier' : 'line',
      waypoints: ctrl ? [ctrl] : undefined,
      curveOffset,
      tracedFromCorridor: false,
    };
  }

  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const toMeters = (lat: number, lng: number) => ({
    mx: (lng - midLng) * mPerDegLng,
    my: (lat - midLat) * mPerDegLat,
  });

  const mA = toMeters(a.lat, a.lng);
  const mB = toMeters(b.lat, b.lng);
  const abX = mB.mx - mA.mx;
  const abY = mB.my - mA.my;
  const abLen = Math.max(1, Math.hypot(abX, abY));
  const ux = abX / abLen;
  const uy = abY / abLen;

  const snapRadiusM = Math.min(chordMeters * 0.3, Math.max(metersPerTrain * 1.65, 220));
  const minLateralOffsetM = Math.max(metersPerTrain * 0.14, chordMeters * 0.035);

  const compatibleCorridors = corridors.filter(
    (c) =>
      c.geoPts.length >= 2 &&
      c.mode !== 'ferry' &&
      (c.mode === preferredMode || c.mode === 'train' || c.mode === 'highway')
  );

  // Strategy A: Find a single continuous corridor spanning a large portion of A -> B
  let bestSinglePts: Array<{ lat: number; lng: number; mx: number; my: number; t: number; perp: number }> | null =
    null;
  let bestSingleScore = -1;

  for (const c of compatibleCorridors) {
    const mapped = c.geoPts.map((pt) => {
      const m = toMeters(pt.lat, pt.lng);
      const dx = m.mx - mA.mx;
      const dy = m.my - mA.my;
      const along = dx * ux + dy * uy;
      const t = along / abLen;
      const perp = Math.abs(-dx * uy + dy * ux);
      return { lat: pt.lat, lng: pt.lng, mx: m.mx, my: m.my, t, perp };
    });

    const nearEnvelope = mapped.filter((p) => p.t >= -0.05 && p.t <= 1.05 && p.perp <= snapRadiusM);
    if (nearEnvelope.length < 3) continue;

    let minT = 1;
    let maxT = 0;
    let maxPerp = 0;
    for (const p of nearEnvelope) {
      minT = Math.min(minT, p.t);
      maxT = Math.max(maxT, p.t);
      maxPerp = Math.max(maxPerp, p.perp);
    }
    const span = maxT - minT;
    if (span < 0.32 || maxPerp < minLateralOffsetM) continue;

    const modeBonus = c.mode === preferredMode ? 25 : 0;
    const score = span * 100 + (c.weight * 0.4) + modeBonus;
    if (score > bestSingleScore) {
      bestSingleScore = score;
      bestSinglePts = nearEnvelope;
    }
  }

  let rawInterior: Array<{ lat: number; lng: number; mx: number; my: number }> = [];

  if (bestSinglePts && bestSinglePts.length >= 3) {
    const interior = bestSinglePts
      .filter((p) => p.t > 0.08 && p.t < 0.92)
      .sort((p1, p2) => p1.t - p2.t);
    // Deduplicate points that are very close in progression t
    for (const pt of interior) {
      if (
        rawInterior.length === 0 ||
        Math.hypot(pt.mx - rawInterior[rawInterior.length - 1].mx, pt.my - rawInterior[rawInterior.length - 1].my) >
          metersPerTrain * 0.35
      ) {
        rawInterior.push({ lat: pt.lat, lng: pt.lng, mx: pt.mx, my: pt.my });
      }
    }
  } else if (compatibleCorridors.length > 0) {
    // Strategy B: Sample interior stations along A -> B and snap to nearest compatible corridor point
    const sampleFractions = [0.18, 0.34, 0.5, 0.66, 0.82];
    const snapped: Array<{ lat: number; lng: number; mx: number; my: number; t: number }> = [];
    for (const frac of sampleFractions) {
      const sx = mA.mx + abX * frac;
      const sy = mA.my + abY * frac;
      let bestPt: { lat: number; lng: number; mx: number; my: number; t: number; d: number } | null = null;
      for (const c of compatibleCorridors) {
        for (const gp of c.geoPts) {
          const m = toMeters(gp.lat, gp.lng);
          const d = Math.hypot(m.mx - sx, m.my - sy);
          if (d <= snapRadiusM * 0.85) {
            const t = ((m.mx - mA.mx) * ux + (m.my - mA.my) * uy) / abLen;
            if (t > 0.08 && t < 0.92 && (!bestPt || d < bestPt.d)) {
              bestPt = { lat: gp.lat, lng: gp.lng, mx: m.mx, my: m.my, t, d };
            }
          }
        }
      }
      if (bestPt) {
        const perp = Math.abs(-(bestPt.mx - mA.mx) * uy + (bestPt.my - mA.my) * ux);
        const prevT = snapped.length > 0 ? snapped[snapped.length - 1].t : 0.05;
        if (perp >= minLateralOffsetM && bestPt.t > prevT + 0.07) {
          snapped.push(bestPt);
        }
      }
    }
    rawInterior = snapped.map(({ lat, lng, mx, my }) => ({ lat, lng, mx, my }));
  }

  if (rawInterior.length > 0) {
    const chain = [
      { lat: a.lat, lng: a.lng, mx: mA.mx, my: mA.my },
      ...rawInterior,
      { lat: b.lat, lng: b.lng, mx: mB.mx, my: mB.my },
    ];
    const eps = Math.max(metersPerTrain * 0.16, chordMeters * 0.03);
    const simplified = rdpSimplify(chain, eps);
    let inner = simplified.slice(1, -1);

    // Keep at most 5 waypoints so routes stay clean & readable on the board
    if (inner.length > 5) {
      const step = inner.length / 5;
      const picked: typeof inner = [];
      for (let i = 0; i < 5; i++) {
        picked.push(inner[Math.min(inner.length - 1, Math.floor(i * step))]);
      }
      inner = picked;
    }

    if (inner.length > 0) {
      // Measure sharpest deflection angle to choose smooth bezier vs zig-zag polyline
      const fullPts = [chain[0], ...inner, chain[chain.length - 1]];
      let maxDeflectDeg = 0;
      for (let i = 1; i < fullPts.length - 1; i++) {
        const v1x = fullPts[i].mx - fullPts[i - 1].mx;
        const v1y = fullPts[i].my - fullPts[i - 1].my;
        const v2x = fullPts[i + 1].mx - fullPts[i].mx;
        const v2y = fullPts[i + 1].my - fullPts[i].my;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 > 1 && l2 > 1) {
          const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
          const deg = (Math.acos(cos) * 180) / Math.PI;
          if (deg > maxDeflectDeg) maxDeflectDeg = deg;
        }
      }

      const pathType: RoutePathType = maxDeflectDeg > 58 && inner.length >= 2 ? 'polyline' : 'bezier';
      const waypoints: RouteWaypoint[] = inner.map((p) => ({
        lat: Number(p.lat.toFixed(6)),
        lng: Number(p.lng.toFixed(6)),
        strength: pathType === 'bezier' ? 0.95 : 1.0,
      }));
      return {
        pathType,
        waypoints,
        curveOffset: 0,
        tracedFromCorridor: true,
      };
    }
  }

  // Fallback gentle curve if enabled
  const curveMax = (curveIntensity / 100) * 28;
  const curveOffset =
    curveMax > 2 && (transitWeight < 45 || chordMeters < metersPerTrain * 3.2)
      ? Math.round((edgeIndex % 2 === 0 ? 1 : -1) * Math.min(curveMax, 22))
      : 0;
  const ctrl = computeControlLatLngFromOffset(a, b, curveOffset);
  return {
    pathType: ctrl ? 'bezier' : 'line',
    waypoints: ctrl ? [ctrl] : undefined,
    curveOffset,
    tracedFromCorridor: false,
  };
}

interface CandidateEdge {
  uIdx: number;
  vIdx: number;
  distMeters: number;
  arcMeters: number;
  estimatedTrains: number;
  dPx: number;
  cost: number;
  transitWeight: number;
  mode: TransportMode;
  isTunnel: boolean;
  ferryLocomotives: number;
  roadHazard: number;
  maritimeHazard: number;
  realLineName?: string;
  pathType: RoutePathType;
  waypoints?: RouteWaypoint[];
  curveOffset: number;
  tracedFromCorridor: boolean;
}

interface ChosenEdge extends CandidateEdge {
  hazardType: HazardType;
  hazardRating: number;
  hazardPoint?: { x: number; y: number };
}

interface NetworkPassResult {
  metersPerTrain: number;
  minSpacingMeters: number;
  selected: BoardLocation[];
  prunedLocations: BoardLocation[];
  candidateEdges: CandidateEdge[];
  chosenEdges: ChosenEdge[];
  edgeSnapshots: StageEdgeSnapshot[];
  routes: BoardRoute[];
  totalSpaces: number;
  len8Count: number;
  len9PlusCount: number;
  tracedCount: number;
  logsStage2: string[];
  logsStage3: string[];
  logsStage4: string[];
}

export function generateProceduralBoardWithStages(options: {
  boardId?: string;
  name: string;
  regionLabel: string;
  theme: BoardTheme;
  cacheId?: string;
  dataset: RawRegionDataset;
  activeBbox?: BoundingBox;
  lockedMetersPerTrain?: number;
  strictScale?: boolean;
  params: GenerationParams;
  aiAdjustments?: Map<string, { cleanName?: string; boost?: number }>;
}): { board: BoardDefinition; stages: GenerationStageArtifact[] } {
  const { dataset, params, theme, aiAdjustments } = options;
  const bbox = options.activeBbox || dataset.bbox;
  const initialMetersPerTrain =
    options.lockedMetersPerTrain && options.lockedMetersPerTrain > 0
      ? options.lockedMetersPerTrain
      : computeIdealMetersPerTrain(bbox);

  const targetCount = Math.max(12, Math.min(60, params.targetLocations));
  const targetSpaces = Math.max(60, Math.min(500, params.targetTrainSpaces ?? TTR_AVERAGE_BENCHMARK.spaces));
  const minTrainsGap = Math.max(1.1, Math.min(4.5, params.minNodeSpacingTrains ?? 2.0));
  const minConn = Math.max(1, Math.min(4, params.minConnections));
  const maxConn = Math.max(minConn + 1, Math.min(10, params.maxConnections));
  const traceCorridors = params.traceRealCorridors !== false;
  const autoAdjustScale = params.autoAdjustScale !== false && !options.strictScale;

  // STAGE 1: Detect Candidate Locations inside active bounding box
  const inBoxPois = dataset.pois.filter(
    (p) =>
      p.lat >= bbox.south &&
      p.lat <= bbox.north &&
      p.lng >= bbox.west &&
      p.lng <= bbox.east
  );
  const sourcePois = inBoxPois.length >= 6 ? inBoxPois : dataset.pois;

  const candidates: BoardLocation[] = sourcePois.map((poi) => {
    const pos = projectPoint(poi.lat, poi.lng, bbox);
    const adj = aiAdjustments?.get(poi.id);
    const score = Math.max(5, Math.min(100, poi.osmScore + (adj?.boost ?? 0)));
    return {
      id: poi.id,
      name: adj?.cleanName || poi.name,
      lat: poi.lat,
      lng: poi.lng,
      x: pos.x,
      y: pos.y,
      popularityScore: score,
      category: poi.category,
      isMajorHub: score >= 78,
      population: poi.population,
      wikiSitelinks: poi.wikiSitelinks,
      source: 'osm',
    };
  });

  const catBreakdown: Record<string, number> = {};
  for (const c of candidates) {
    catBreakdown[c.category] = (catBreakdown[c.category] || 0) + 1;
  }

  const stage1Artifact: GenerationStageArtifact = {
    stageIndex: 1,
    key: 'candidates',
    title: 'Candidate Locations Detected',
    summary: `Scanned ${candidates.length} real-world POIs in the active bounding box (${inBoxPois.length} strict inside box, ${dataset.pois.length} total cached).`,
    logs: [
      `Detected ${candidates.length} candidate nodes across ${Object.entries(catBreakdown)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}.`,
      `Detected ${dataset.corridors.length} transit/road corridors and ${dataset.hazards.length} terrain/traffic hazards.`,
      aiAdjustments && aiAdjustments.size > 0
        ? `Applied Gemini popularity & naming polish to ${aiAdjustments.size} locations.`
        : 'Scored candidates using OSM population, transit class, and Wikipedia sitelinks.',
    ],
    metrics: {
      'Raw POIs': candidates.length,
      'Corridors': dataset.corridors.length,
      'Hazards': dataset.hazards.length,
      'Target Stops': targetCount,
    },
    metersPerTrain: initialMetersPerTrain,
    locations: candidates,
  };

  // Project corridors & hazards once for the active bbox
  const projectedCorridors: ProjectedCorridor[] = dataset.corridors.map((c: RawTransitCorridor) => ({
    id: c.id,
    mode: c.mode,
    weight: c.weight,
    isTunnel: c.isTunnel,
    isBridge: c.isBridge,
    name: c.name,
    pts: c.points.map((pt) => projectPoint(pt.lat, pt.lng, bbox)),
    geoPts: c.points,
  }));

  const projectedHazards = dataset.hazards.map((h) => ({
    ...h,
    ...projectPoint(h.lat, h.lng, bbox),
  }));

  const runNetworkPass = (passMetersPerTrain: number): NetworkPassResult => {
    const minSpacingMeters = passMetersPerTrain * minTrainsGap;
    const logsStage2: string[] = [];
    const logsStage3: string[] = [];
    const logsStage4: string[] = [];

    // STAGE 2: Spatial Grid Distribution & Anti-Clustering Spacing Filter
    const cols = 7;
    const rows = 5;
    const cells = new Map<string, BoardLocation[]>();
    for (const c of candidates) {
      const gx = Math.min(cols - 1, Math.max(0, Math.floor((c.x / CANVAS_W) * cols)));
      const gy = Math.min(rows - 1, Math.max(0, Math.floor((c.y / CANVAS_H) * rows)));
      const key = `${gx}:${gy}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(c);
    }
    for (const list of cells.values()) {
      list.sort((a, b) => b.popularityScore - a.popularityScore);
    }

    const selected: BoardLocation[] = [];
    const selectedIds = new Set<string>();
    let prunedForSpacing = 0;

    const trySelect = (loc: BoardLocation, spacingM: number): boolean => {
      if (selectedIds.has(loc.id)) return false;
      for (const s of selected) {
        if (haversineMeters(s.lat, s.lng, loc.lat, loc.lng) < spacingM) {
          prunedForSpacing += 1;
          return false;
        }
      }
      selected.push({ ...loc });
      selectedIds.add(loc.id);
      return true;
    };

    let round = 0;
    while (selected.length < targetCount && round < 5) {
      let addedInRound = false;
      for (const [, list] of cells) {
        if (selected.length >= targetCount) break;
        if (round < list.length) {
          if (trySelect(list[round], minSpacingMeters)) {
            addedInRound = true;
          }
        }
      }
      if (!addedInRound && round > 1) break;
      round += 1;
    }

    const sortedGlobal = [...candidates].sort((a, b) => b.popularityScore - a.popularityScore);
    for (const spacingMult of [1, 0.85, 0.72]) {
      if (selected.length >= targetCount) break;
      for (const loc of sortedGlobal) {
        if (selected.length >= targetCount) break;
        trySelect(loc, minSpacingMeters * spacingMult);
      }
    }

    const hubCutoff = Math.max(3, Math.round(selected.length * 0.25));
    const byPop = [...selected].sort((a, b) => b.popularityScore - a.popularityScore);
    const hubIds = new Set(byPop.slice(0, hubCutoff).map((l) => l.id));
    for (const loc of selected) {
      loc.isMajorHub = hubIds.has(loc.id);
    }

    const prunedLocations = candidates.filter((c) => !selectedIds.has(c.id));
    logsStage2.push(
      `Minimum spacing threshold: ${Math.round(minSpacingMeters)} m (${minTrainsGap.toFixed(1)}× train length at ${Math.round(passMetersPerTrain)} m/train).`
    );
    logsStage2.push(
      `Kept ${selected.length} / ${candidates.length} stops across a 7×5 spatial grid; promoted top ${hubCutoff} to Major Hubs.`
    );
    logsStage2.push(
      `Pruned ${prunedLocations.length} candidates (${prunedForSpacing} spacing rejections + grid/cap overflow).`
    );

    // STAGE 3: Candidate Path Detection & OSM Corridor Waypoint Tracing
    const candidateMap = new Map<string, CandidateEdge>();
    const maxPreferEdgeMeters = passMetersPerTrain * 9.5;
    let tracedCount = 0;
    let edgeCounter = 0;

    for (let i = 0; i < selected.length; i++) {
      const others = selected
        .map((loc, idx) => ({
          idx,
          distMeters: haversineMeters(selected[i].lat, selected[i].lng, loc.lat, loc.lng),
          dPx: distPx(selected[i], loc),
        }))
        .filter((o) => o.idx !== i)
        .sort((a, b) => a.distMeters - b.distMeters)
        .slice(0, 10);

      for (const o of others) {
        const u = Math.min(i, o.idx);
        const v = Math.max(i, o.idx);
        const key = `${u}:${v}`;
        if (candidateMap.has(key)) continue;
        if (o.distMeters > maxPreferEdgeMeters && others.indexOf(o) > 2) continue;

        const evalRes = evaluateCorridorAlignment(
          selected[u],
          selected[v],
          projectedCorridors,
          projectedHazards
        );

        const trace = traceCorridorWaypoints(
          selected[u],
          selected[v],
          evalRes.mode,
          projectedCorridors,
          passMetersPerTrain,
          params.curveIntensity,
          traceCorridors,
          edgeCounter++,
          evalRes.transitWeight
        );

        const arcMeters = computeRouteGeoArcMeters(
          selected[u],
          selected[v],
          trace.pathType,
          trace.waypoints,
          trace.curveOffset
        );
        const estimatedTrains = computeChainTrainCount(
          arcMeters,
          passMetersPerTrain,
          trace.pathType,
          trace.waypoints?.length || 0
        );

        if (trace.tracedFromCorridor) tracedCount += 1;

        const fidelity = params.transitFidelity / 100;
        const normDist = o.distMeters / (passMetersPerTrain * 8);
        const transitBonus = 1 - evalRes.transitWeight / 100;
        // Penalize overly long routes (>6 trains) to preserve classic TTR pacing (only 1-2 length-8 tracks, very rare 9-10)
        const lengthPenalty =
          estimatedTrains > 10
            ? 2.2
            : estimatedTrains >= 9
              ? 0.9
              : estimatedTrains === 8
                ? 0.42
                : estimatedTrains === 7
                  ? 0.16
                  : 0;
        const cost =
          (1 - fidelity) * normDist +
          fidelity * (0.45 * normDist + 0.55 * transitBonus) +
          lengthPenalty;

        candidateMap.set(key, {
          uIdx: u,
          vIdx: v,
          distMeters: o.distMeters,
          arcMeters,
          estimatedTrains,
          dPx: o.dPx,
          cost,
          transitWeight: evalRes.transitWeight,
          mode: evalRes.mode,
          isTunnel: evalRes.isTunnel,
          ferryLocomotives: evalRes.ferryLocomotives,
          roadHazard: evalRes.roadHazardNearMid,
          maritimeHazard: evalRes.maritimeHazardNearMid,
          realLineName: evalRes.realLineName,
          pathType: trace.pathType,
          waypoints: trace.waypoints,
          curveOffset: trace.curveOffset,
          tracedFromCorridor: trace.tracedFromCorridor,
        });
      }
    }

    const candidatesList = Array.from(candidateMap.values()).sort((a, b) => a.cost - b.cost);
    logsStage3.push(
      `Evaluated ${candidatesList.length} candidate neighbor pairs across ${selected.length} stops.`
    );
    logsStage3.push(
      traceCorridors
        ? `Traced real OSM rail/road geometry waypoints on ${tracedCount} candidate paths (increasing organic curvature & train slots).`
        : 'Corridor waypoint tracing disabled; using direct lines and parametric curves.'
    );

    // STAGE 4: Path Ranking, Crossing Check, Length Guardrails & Selection
    const parent = selected.map((_, idx) => idx);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number): boolean => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return false;
      parent[ra] = rb;
      return true;
    };

    const chosenEdges: ChosenEdge[] = [];
    const chosenSet = new Set<string>();
    const rejectionReasonByKey = new Map<string, string>();
    const degree = new Array<number>(selected.length).fill(0);

    let len8Count = 0;
    let len9PlusCount = 0;

    const canAcceptRouteLength = (len: number, isEssentialMst: boolean): boolean => {
      if (isEssentialMst) return len <= 12;
      if (len > 10) return false;
      if (len >= 9) return len9PlusCount < 1; // Very rare: at most 1 (or 2 if MST needed it)
      if (len === 8) return len8Count < 2; // Classic TTR cap: max 1–2 eight-train tracks
      return true;
    };

    const recordChosenLength = (len: number) => {
      if (len === 8) len8Count += 1;
      else if (len >= 9) len9PlusCount += 1;
    };

    const checkCrossing = (
      edge: CandidateEdge
    ): {
      blocked: boolean;
      busCrossingPoint?: { x: number; y: number };
      busHazardRating: number;
    } => {
      const p1 = selected[edge.uIdx];
      const p2 = selected[edge.vIdx];
      let crossings = 0;
      let bestCrossingPt: { x: number; y: number } | undefined;
      let valid45Deg = true;

      for (const existing of chosenEdges) {
        if (
          existing.uIdx === edge.uIdx ||
          existing.uIdx === edge.vIdx ||
          existing.vIdx === edge.uIdx ||
          existing.vIdx === edge.vIdx
        ) {
          continue;
        }
        const hit = segmentsIntersectionPoint(
          p1,
          p2,
          selected[existing.uIdx],
          selected[existing.vIdx]
        );
        if (hit) {
          crossings += 1;
          bestCrossingPt = { x: hit.x, y: hit.y };
          if (hit.angleDeg < 28 || hit.angleDeg > 72) {
            valid45Deg = false;
          }
        }
      }

      if (crossings === 0) return { blocked: false, busHazardRating: 0 };

      if (params.allowBusCrossings && edge.mode === 'bus' && crossings === 1 && valid45Deg) {
        const rating = Math.max(1, Math.min(4, edge.roadHazard || 2));
        return {
          blocked: false,
          busCrossingPoint: bestCrossingPt,
          busHazardRating: rating,
        };
      }

      return { blocked: true, busHazardRating: 0 };
    };

    // 4a. Non-crossing Kruskal MST
    for (const edge of candidatesList) {
      if (find(edge.uIdx) !== find(edge.vIdx)) {
        const key = `${edge.uIdx}:${edge.vIdx}`;
        const cross = checkCrossing(edge);
        if (!cross.blocked) {
          union(edge.uIdx, edge.vIdx);
          chosenSet.add(key);
          degree[edge.uIdx] += 1;
          degree[edge.vIdx] += 1;
          recordChosenLength(edge.estimatedTrains);
          chosenEdges.push({
            ...edge,
            hazardType: cross.busHazardRating > 0 ? 'bus_crossing' : 'none',
            hazardRating: cross.busHazardRating,
            hazardPoint: cross.busCrossingPoint,
          });
        } else {
          rejectionReasonByKey.set(key, 'crossing');
        }
      }
    }

    // 4b. Connectivity fallback if graph remained disconnected
    for (const edge of candidatesList) {
      if (find(edge.uIdx) !== find(edge.vIdx)) {
        const key = `${edge.uIdx}:${edge.vIdx}`;
        union(edge.uIdx, edge.vIdx);
        chosenSet.add(key);
        degree[edge.uIdx] += 1;
        degree[edge.vIdx] += 1;
        recordChosenLength(edge.estimatedTrains);
        chosenEdges.push({
          ...edge,
          hazardType: 'none',
          hazardRating: 0,
        });
      }
    }

    // 4c. Satisfy minConnections per stop
    for (let pass = 0; pass < 2; pass++) {
      for (let idx = 0; idx < selected.length; idx++) {
        if (degree[idx] >= minConn) continue;
        for (const edge of candidatesList) {
          if (edge.uIdx !== idx && edge.vIdx !== idx) continue;
          const key = `${edge.uIdx}:${edge.vIdx}`;
          if (chosenSet.has(key)) continue;
          if (degree[edge.uIdx] >= maxConn || degree[edge.vIdx] >= maxConn) {
            rejectionReasonByKey.set(key, 'max_connections');
            continue;
          }
          if (!canAcceptRouteLength(edge.estimatedTrains, false)) {
            rejectionReasonByKey.set(key, 'length_cap');
            continue;
          }
          const cross = checkCrossing(edge);
          if (cross.blocked) {
            rejectionReasonByKey.set(key, 'crossing');
            continue;
          }
          chosenSet.add(key);
          degree[edge.uIdx] += 1;
          degree[edge.vIdx] += 1;
          recordChosenLength(edge.estimatedTrains);
          chosenEdges.push({
            ...edge,
            hazardType: cross.busHazardRating > 0 ? 'bus_crossing' : 'none',
            hazardRating: cross.busHazardRating,
            hazardPoint: cross.busCrossingPoint,
          });
          if (degree[idx] >= minConn) break;
        }
      }
    }

    // 4d. Fill remaining route budget up to targetRouteCount (and boost toward targetTrainSpaces if below)
    const baseTargetRouteCount = Math.min(
      Math.round(selected.length * 2.15),
      Math.round((selected.length * (minConn + maxConn)) / 2.2)
    );
    let currentRunningSpaces = chosenEdges.reduce((acc, e) => acc + Math.min(10, e.estimatedTrains), 0);

    for (const edge of candidatesList) {
      const underSpaceGoal = currentRunningSpaces < targetSpaces * 0.92;
      if (chosenEdges.length >= baseTargetRouteCount && !underSpaceGoal) break;
      if (chosenEdges.length >= selected.length * 2.35) break;

      const key = `${edge.uIdx}:${edge.vIdx}`;
      if (chosenSet.has(key)) continue;
      if (degree[edge.uIdx] >= maxConn || degree[edge.vIdx] >= maxConn) {
        rejectionReasonByKey.set(key, 'max_connections');
        continue;
      }
      if (!canAcceptRouteLength(edge.estimatedTrains, false)) {
        rejectionReasonByKey.set(key, 'length_cap');
        continue;
      }
      const cross = checkCrossing(edge);
      if (cross.blocked) {
        rejectionReasonByKey.set(key, 'crossing');
        continue;
      }
      chosenSet.add(key);
      degree[edge.uIdx] += 1;
      degree[edge.vIdx] += 1;
      recordChosenLength(edge.estimatedTrains);
      currentRunningSpaces += Math.min(10, edge.estimatedTrains);
      chosenEdges.push({
        ...edge,
        hazardType: cross.busHazardRating > 0 ? 'bus_crossing' : 'none',
        hazardRating: cross.busHazardRating,
        hazardPoint: cross.busCrossingPoint,
      });
    }

    // STAGE 5: Build Final BoardRoutes (with max 2 parallel lanes for busy/important corridors)
    const colorCursor = { idx: 0 };
    const nextRouteColor = (preferGray: boolean): RouteColor => {
      if (preferGray) return 'gray';
      const c = ROUTE_COLORS_POOL[colorCursor.idx % ROUTE_COLORS_POOL.length];
      colorCursor.idx += 1;
      return c;
    };

    let doubleLaneCount = 0;
    const doubleThreshold = 100 - params.doubleLaneBias * 0.45;

    const routes: BoardRoute[] = chosenEdges.map((edge, idx) => {
      const a = selected[edge.uIdx];
      const b = selected[edge.vIdx];
      const length = Math.max(1, Math.min(10, edge.estimatedTrains));

      // Only promote genuinely busy/important hub corridors to double lanes (max 2 parallel runs)
      const isBusyImportant =
        edge.transitWeight >= doubleThreshold &&
        (a.isMajorHub || b.isMajorHub) &&
        length <= 8;
      const isDouble = isBusyImportant;
      if (isDouble) doubleLaneCount += 1;

      const preferGray = idx % 5 === 0 || idx % 5 === 3 || edge.mode === 'ferry';
      const color = nextRouteColor(preferGray);
      let doubleColor: RouteColor | undefined;
      if (isDouble) {
        doubleColor = nextRouteColor(false);
        if (doubleColor === color) {
          doubleColor = nextRouteColor(false);
        }
      }

      let hazardType: HazardType = edge.hazardType;
      let hazardRating = edge.hazardRating;
      let hazardPoint = edge.hazardPoint;
      let hazardLatLng: { lat: number; lng: number } | undefined = hazardPoint
        ? unprojectPointToLatLng(hazardPoint.x, hazardPoint.y, bbox)
        : undefined;

      if (
        hazardType === 'none' &&
        params.allowShippingHazards &&
        edge.mode === 'ferry' &&
        (edge.maritimeHazard > 0 || length >= 3)
      ) {
        hazardType = 'shipping_lane';
        hazardRating = Math.max(1, Math.min(4, edge.maritimeHazard || (length >= 5 ? 3 : 2)));
        hazardPoint = {
          x: Math.round(((a.x + b.x) / 2) * 10) / 10,
          y: Math.round(((a.y + b.y) / 2) * 10) / 10,
        };
        hazardLatLng = edge.waypoints?.[0] || {
          lat: (a.lat + b.lat) / 2,
          lng: (a.lng + b.lng) / 2,
        };
      }

      return {
        id: `route-${idx + 1}`,
        fromId: a.id,
        toId: b.id,
        length,
        color,
        doubleColor,
        isDouble,
        curveOffset: edge.curveOffset,
        pathType: edge.pathType,
        waypoints: edge.waypoints,
        transportMode: edge.mode,
        transitWeight: edge.transitWeight,
        isTunnel: params.allowTunnels ? edge.isTunnel : false,
        ferryLocomotives: params.allowFerryLocomotives ? edge.ferryLocomotives : 0,
        hazardRating,
        hazardType,
        hazardPoint,
        hazardLatLng,
        realLineName: edge.realLineName,
      };
    });

    const totalSpaces = routes.reduce((acc, r) => acc + r.length * (r.isDouble ? 2 : 1), 0);
    const routeByEdgeKey = new Map<string, BoardRoute>();
    chosenEdges.forEach((e, idx) => {
      routeByEdgeKey.set(`${e.uIdx}:${e.vIdx}`, routes[idx]);
    });

    const edgeSnapshots: StageEdgeSnapshot[] = candidatesList.map((e, idx) => {
      const key = `${e.uIdx}:${e.vIdx}`;
      const r = routeByEdgeKey.get(key);
      const status: StageEdgeSnapshot['status'] = r
        ? r.isDouble
          ? 'double'
          : 'selected'
        : 'rejected';
      return {
        id: `cand-${idx + 1}`,
        fromId: selected[e.uIdx].id,
        toId: selected[e.vIdx].id,
        mode: e.mode,
        transitWeight: e.transitWeight,
        cost: Math.round(e.cost * 100) / 100,
        distMeters: Math.round(e.distMeters),
        arcMeters: Math.round(e.arcMeters),
        estimatedTrains: e.estimatedTrains,
        pathType: e.pathType,
        waypoints: e.waypoints,
        status,
        reason: r ? undefined : rejectionReasonByKey.get(key) || 'route_budget',
        realLineName: e.realLineName,
      };
    });

    logsStage4.push(
      `Selected ${routes.length} routes (${doubleLaneCount} double-lane busy corridors, max 2 parallel lanes) totaling ${totalSpaces} train spaces.`
    );
    logsStage4.push(
      `Long-track distribution: ${len8Count} route(s) of 8 cars, ${len9PlusCount} route(s) of 9–10 cars (capped for single-color deck playability).`
    );

    return {
      metersPerTrain: passMetersPerTrain,
      minSpacingMeters,
      selected,
      prunedLocations,
      candidateEdges: candidatesList,
      chosenEdges,
      edgeSnapshots,
      routes,
      totalSpaces,
      len8Count,
      len9PlusCount,
      tracedCount,
      logsStage2,
      logsStage3,
      logsStage4,
    };
  };

  // Run initial pass and auto-adjust scale downward if largely under targetTrainSpaces
  const scaleLogs: string[] = [];
  let activeScale = initialMetersPerTrain;
  let bestPass = runNetworkPass(activeScale);
  scaleLogs.push(
    `Initial pass @ ${Math.round(activeScale)} m/train -> ${bestPass.selected.length} stops, ${bestPass.routes.length} routes, ${bestPass.totalSpaces}/${targetSpaces} train spaces.`
  );

  if (autoAdjustScale && bestPass.totalSpaces < targetSpaces * 0.85) {
    const minAllowedScale = Math.max(20, initialMetersPerTrain * 0.42);
    for (let step = 1; step <= 4; step++) {
      if (bestPass.totalSpaces >= targetSpaces * 0.88) break;
      const nextScale = Math.max(minAllowedScale, Math.round(activeScale * 0.84 * 10) / 10);
      if (nextScale >= activeScale * 0.97) break;

      const candidatePass = runNetworkPass(nextScale);
      scaleLogs.push(
        `Scale step #${step}: reduced scale ${Math.round(activeScale)} -> ${Math.round(nextScale)} m/train -> ${candidatePass.selected.length} stops, ${candidatePass.routes.length} routes, ${candidatePass.totalSpaces} spaces (8-car: ${candidatePass.len8Count}, 9-10-car: ${candidatePass.len9PlusCount}).`
      );

      if (candidatePass.len8Count > 3 || candidatePass.len9PlusCount > 2) {
        scaleLogs.push(
          `Stopped scale reduction before exceeding healthy long-track limits (max 2-3 eight-car, <=2 nine/ten-car).`
        );
        break;
      }

      if (candidatePass.totalSpaces > bestPass.totalSpaces) {
        bestPass = candidatePass;
        activeScale = nextScale;
      } else {
        break;
      }
    }
  } else if (!autoAdjustScale && bestPass.totalSpaces < targetSpaces * 0.85) {
    scaleLogs.push(
      `Under target (${bestPass.totalSpaces}/${targetSpaces} spaces), but scale auto-adjustment is disabled/locked.`
    );
  }

  const finalMetersPerTrain = bestPass.metersPerTrain;
  const tickets = generateDestinationTickets(bestPass.selected, bestPass.routes);
  const now = new Date().toISOString();

  const genParamsFinal: GenerationParams = {
    ...params,
    targetTrainSpaces: targetSpaces,
    autoAdjustScale,
    traceRealCorridors: traceCorridors,
  };

  const board: BoardDefinition = {
    id: options.boardId || `board-${crypto.randomBytes(4).toString('hex')}`,
    name: options.name,
    regionLabel: options.regionLabel,
    theme,
    bbox,
    zoom: dataset.zoom,
    scaleMode: dataset.scaleMode,
    metersPerTrain: finalMetersPerTrain,
    scaleSpanKm: Math.round((computeBoxWidthMeters(bbox) / 1000) * 10) / 10,
    cacheId: options.cacheId,
    maxPlayers: bestPass.selected.length < 24 ? 4 : 5,
    generationParams: genParamsFinal,
    defaultRules: normalizeGameRules(undefined, {
      generationParams: genParamsFinal,
      locations: bestPass.selected,
      routes: bestPass.routes,
    }),
    locations: bestPass.selected,
    routes: bestPass.routes,
    tickets,
    createdAt: now,
    updatedAt: now,
  };

  // Assemble the 5 intermediate Stage Artifacts for inspection
  const shortT = tickets.filter((t) => t.grade === 'short').length;
  const medT = tickets.filter((t) => t.grade === 'medium').length;
  const longT = tickets.filter((t) => t.grade === 'long').length;

  const stage2Artifact: GenerationStageArtifact = {
    stageIndex: 2,
    key: 'filtered_locations',
    title: 'Spatial Filtering & Hub Selection',
    summary: `Filtered ${candidates.length} raw POIs down to ${bestPass.selected.length} stops separated by at least ${Math.round(bestPass.minSpacingMeters)} m.`,
    logs: [...bestPass.logsStage2, ...scaleLogs],
    metrics: {
      'Kept Stops': bestPass.selected.length,
      'Pruned POIs': bestPass.prunedLocations.length,
      'Min Spacing': `${Math.round(bestPass.minSpacingMeters)} m`,
      'Major Hubs': bestPass.selected.filter((l) => l.isMajorHub).length,
    },
    metersPerTrain: finalMetersPerTrain,
    locations: bestPass.selected,
    prunedLocations: bestPass.prunedLocations,
  };

  const stage3Artifact: GenerationStageArtifact = {
    stageIndex: 3,
    key: 'candidate_paths',
    title: 'Potential Path Detection & Corridor Tracing',
    summary: `Detected ${bestPass.edgeSnapshots.length} candidate links and traced OSM rail/road waypoints on ${bestPass.tracedCount} links.`,
    logs: bestPass.logsStage3,
    metrics: {
      'Candidate Links': bestPass.edgeSnapshots.length,
      'OSM Traced': bestPass.tracedCount,
      'Avg Cost':
        bestPass.edgeSnapshots.length > 0
          ? (
              bestPass.edgeSnapshots.reduce((a, e) => a + e.cost, 0) /
              bestPass.edgeSnapshots.length
            ).toFixed(2)
          : '0',
    },
    metersPerTrain: finalMetersPerTrain,
    locations: bestPass.selected,
    edges: bestPass.edgeSnapshots.map((e) => ({ ...e, status: 'candidate' })),
  };

  const rejectedEdgesCount = bestPass.edgeSnapshots.filter((e) => e.status === 'rejected').length;
  const stage4Artifact: GenerationStageArtifact = {
    stageIndex: 4,
    key: 'selected_paths',
    title: 'Path Ranking, Selection & Double Lanes',
    summary: `Selected ${bestPass.routes.length} routes (${rejectedEdgesCount} candidate links rejected for crossings, degree cap, or length guardrails).`,
    logs: [...bestPass.logsStage4, ...scaleLogs],
    metrics: {
      'Selected Routes': bestPass.routes.length,
      'Double Lanes': bestPass.routes.filter((r) => r.isDouble).length,
      'Rejected Links': rejectedEdgesCount,
      'Scale Ratio': `${Math.round(finalMetersPerTrain)} m/train`,
    },
    metersPerTrain: finalMetersPerTrain,
    locations: bestPass.selected,
    edges: bestPass.edgeSnapshots,
  };

  const stage5Artifact: GenerationStageArtifact = {
    stageIndex: 5,
    key: 'final_trains_tickets',
    title: 'Train Placement & Graded Tickets',
    summary: `Placed ${bestPass.totalSpaces} train spaces (target ${targetSpaces}) and graded ${tickets.length} destination tickets.`,
    logs: [
      `Final network: ${bestPass.selected.length} stops, ${bestPass.routes.length} routes, ${bestPass.totalSpaces} total train spaces.`,
      `Generated ${tickets.length} proportional destination tickets (${shortT} Short · ${medT} Medium · ${longT} Long).`,
      ...scaleLogs,
    ],
    metrics: {
      'Train Spaces': `${bestPass.totalSpaces} / ${targetSpaces}`,
      '8-Car Tracks': bestPass.len8Count,
      '9-10 Car Tracks': bestPass.len9PlusCount,
      'Tickets': tickets.length,
    },
    metersPerTrain: finalMetersPerTrain,
    locations: bestPass.selected,
    routes: bestPass.routes,
    tickets,
  };

  return {
    board,
    stages: [stage1Artifact, stage2Artifact, stage3Artifact, stage4Artifact, stage5Artifact],
  };
}

export function generateProceduralBoard(options: {
  boardId?: string;
  name: string;
  regionLabel: string;
  theme: BoardTheme;
  cacheId?: string;
  dataset: RawRegionDataset;
  activeBbox?: BoundingBox;
  lockedMetersPerTrain?: number;
  strictScale?: boolean;
  params: GenerationParams;
  aiAdjustments?: Map<string, { cleanName?: string; boost?: number }>;
}): BoardDefinition {
  return generateProceduralBoardWithStages(options).board;
}

/**
 * Generates and grades Destination Tickets proportionally to the board's stops and routes.
 */
export function generateDestinationTickets(
  locations: BoardLocation[],
  routes: BoardRoute[]
): DestinationTicket[] {
  if (locations.length < 4 || routes.length === 0) return [];

  const adj = new Map<
    string,
    Array<{ to: string; len: number; isHazardOrTunnel: boolean; isSingleLane: boolean }>
  >();
  for (const loc of locations) adj.set(loc.id, []);
  for (const r of routes) {
    const isHazardOrTunnel =
      r.isTunnel || r.ferryLocomotives > 0 || (r.hazardRating > 0 && r.hazardType !== 'none');
    const isSingleLane = !r.isDouble;
    adj.get(r.fromId)?.push({ to: r.toId, len: r.length, isHazardOrTunnel, isSingleLane });
    adj.get(r.toId)?.push({ to: r.fromId, len: r.length, isHazardOrTunnel, isSingleLane });
  }

  const shortestPathStats = (
    startId: string,
    endId: string
  ): { len: number; hops: number; hazardSteps: number } => {
    const distMap = new Map<string, { len: number; hops: number; hazardSteps: number }>();
    const visited = new Set<string>();
    distMap.set(startId, { len: 0, hops: 0, hazardSteps: 0 });

    while (true) {
      let bestNode: string | null = null;
      let bestDist = Infinity;
      for (const [id, info] of distMap) {
        if (!visited.has(id) && info.len < bestDist) {
          bestDist = info.len;
          bestNode = id;
        }
      }
      if (!bestNode) break;
      const curInfo = distMap.get(bestNode)!;
      if (bestNode === endId) return curInfo;
      visited.add(bestNode);

      for (const edge of adj.get(bestNode) || []) {
        const nd = curInfo.len + edge.len;
        const prev = distMap.get(edge.to);
        if (!prev || nd < prev.len) {
          distMap.set(edge.to, {
            len: nd,
            hops: curInfo.hops + 1,
            hazardSteps: curInfo.hazardSteps + (edge.isHazardOrTunnel ? 1 : 0),
          });
        }
      }
    }
    return { len: Infinity, hops: 0, hazardSteps: 0 };
  };

  // Proportional target ticket count anchored to stops & routes (mirrors USA 30 / Europe 46 / Germany 55)
  const targetTicketCount = Math.max(
    14,
    Math.min(80, Math.round(locations.length * 0.72 + routes.length * 0.18))
  );

  interface RawCandidateTicket extends DestinationTicket {
    qualityScore: number;
    hops: number;
  }

  const allPairs: RawCandidateTicket[] = [];
  let maxObservedSpan = 10;

  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i];
      const b = locations[j];
      const sp = shortestPathStats(a.id, b.id);
      if (!Number.isFinite(sp.len) || sp.len < 4 || sp.hops < 2) continue;
      if (sp.len > maxObservedSpan) maxObservedSpan = sp.len;

      const hubBonus = (a.isMajorHub ? 12 : 0) + (b.isMajorHub ? 12 : 0);
      const popScore = (a.popularityScore + b.popularityScore) * 0.35;
      const geoMeters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      const difficultyBonus = sp.hazardSteps >= 2 ? 1 : 0;
      const points = Math.max(4, Math.min(26, sp.len + difficultyBonus));

      allPairs.push({
        id: `tkt-raw-${allPairs.length + 1}`,
        fromId: a.id,
        toId: b.id,
        fromName: a.name,
        toName: b.name,
        points,
        shortestPathTrains: sp.len,
        hops: sp.hops,
        qualityScore: hubBonus + popScore + Math.min(25, geoMeters / 5000),
      });
    }
  }

  if (allPairs.length === 0) return [];

  // Grade tickets relative to the board's actual span
  const shortMax = Math.max(7, Math.round(maxObservedSpan * 0.42));
  const medMax = Math.max(shortMax + 3, Math.round(maxObservedSpan * 0.72));

  for (const t of allPairs) {
    const len = t.shortestPathTrains ?? t.points;
    t.grade = len <= shortMax ? 'short' : len <= medMax ? 'medium' : 'long';
  }

  const pickBalancedTier = (
    pool: RawCandidateTicket[],
    quota: number,
    usageCount: Map<string, number>,
    maxUsesPerStop: number
  ): RawCandidateTicket[] => {
    const sorted = [...pool].sort((a, b) => b.qualityScore - a.qualityScore);
    const chosen: RawCandidateTicket[] = [];
    const chosenPairKeys = new Set<string>();

    for (const strictCap of [maxUsesPerStop, maxUsesPerStop + 2, 99]) {
      for (const item of sorted) {
        if (chosen.length >= quota) break;
        const pKey = `${item.fromId}:${item.toId}`;
        if (chosenPairKeys.has(pKey)) continue;
        const uFrom = usageCount.get(item.fromId) || 0;
        const uTo = usageCount.get(item.toId) || 0;
        if (uFrom >= strictCap || uTo >= strictCap) continue;

        chosen.push(item);
        chosenPairKeys.add(pKey);
        usageCount.set(item.fromId, uFrom + 1);
        usageCount.set(item.toId, uTo + 1);
      }
      if (chosen.length >= quota) break;
    }
    return chosen;
  };

  const maxUsesPerStop = Math.max(3, Math.ceil((targetTicketCount * 2) / locations.length) + 1);
  const usageCount = new Map<string, number>();

  const shortQuota = Math.round(targetTicketCount * 0.36);
  const medQuota = Math.round(targetTicketCount * 0.44);
  const longQuota = Math.max(2, targetTicketCount - shortQuota - medQuota);

  const pickedShort = pickBalancedTier(
    allPairs.filter((t) => t.grade === 'short'),
    shortQuota,
    usageCount,
    maxUsesPerStop
  );
  const pickedMed = pickBalancedTier(
    allPairs.filter((t) => t.grade === 'medium'),
    medQuota,
    usageCount,
    maxUsesPerStop
  );
  const pickedLong = pickBalancedTier(
    allPairs.filter((t) => t.grade === 'long'),
    longQuota,
    usageCount,
    maxUsesPerStop
  );

  const combined = [...pickedShort, ...pickedMed, ...pickedLong];

  // Top up if one tier was sparse on small boards
  if (combined.length < targetTicketCount) {
    const pickedSet = new Set(combined.map((t) => `${t.fromId}:${t.toId}`));
    const remaining = allPairs
      .filter((t) => !pickedSet.has(`${t.fromId}:${t.toId}`))
      .sort((a, b) => b.qualityScore - a.qualityScore);
    for (const item of remaining) {
      if (combined.length >= targetTicketCount) break;
      combined.push(item);
    }
  }

  return combined.map(({ qualityScore: _q, hops: _h, ...t }, idx) => ({
    ...t,
    id: `tkt-${idx + 1}`,
  }));
}

export function computeRouteTotalPoints(length: number): number {
  return getRoutePoints(length);
}
