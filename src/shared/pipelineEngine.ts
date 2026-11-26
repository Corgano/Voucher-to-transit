import type {
  BoardDefinition,
  BoardLocation,
  BoardRoute,
  BoundingBox,
  DestinationTicket,
  GenerationParams,
  GenerationPipelineState,
  HazardType,
  MapGenerationCheckpoint,
  PipelineCorridorCandidate,
  PipelineLocationCandidate,
  RawHazardZone,
  RawRegionDataset,
  RawTransitCorridor,
  RouteColor,
  RoutePathType,
  RouteWaypoint,
  Step2LocationSettings,
  Step3CorridorSettings,
  Step4RouteSettings,
  Step5TicketSettings,
  TransportMode,
  WaypointKind,
} from './types';
import {
  computeBoxWidthMeters,
  computeChainTrainCount,
  computeIdealMetersPerTrain,
  computeRouteGeoArcMeters,
  evaluateRelativeWaypointOnCorridor,
  haversineMeters,
  projectPointOntoCorridorCurve,
  resolveEffectivePathType,
  resolveEffectiveWaypoints,
  sampleGenericPath,
} from './geoScale';
import { normalizeGameRules, TTR_AVERAGE_BENCHMARK } from './benchmarks';

/**
 * Debug verbosity level for pipelineEngine:
 * 0 = errors only, 1 = major stages, 2 = light debug, 3 = detailed debug, 4 = spam.
 */
const PIPELINE_DEBUG_LEVEL = 0;

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

export function projectPointToCanvas(
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

export function unprojectCanvasToLatLng(
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

function rdpSimplifyGeo(
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
    const left = rdpSimplifyGeo(pts.slice(0, maxIdx + 1), epsilonMeters);
    const right = rdpSimplifyGeo(pts.slice(maxIdx), epsilonMeters);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

export function createDefaultStep2Settings(params?: Partial<GenerationParams>): Step2LocationSettings {
  return {
    targetLocations: params?.targetLocations ?? 40,
    minNodeSpacingTrains: params?.minNodeSpacingTrains ?? 2.0,
    minCandidateScore: 15,
    majorHubShare: 0.25,
    useAiEnrichment: params?.useAiEnrichment ?? false,
  };
}

export function createDefaultStep3Settings(params?: Partial<GenerationParams>): Step3CorridorSettings {
  return {
    minConnections: params?.minConnections ?? 2,
    maxConnections: params?.maxConnections ?? 6,
    transitFidelity: params?.transitFidelity ?? 72,
    traceRealCorridors: params?.traceRealCorridors ?? true,
    curveIntensity: params?.curveIntensity ?? 55,
    minCorridorWeight: 20,
    overlapAvoidance: 75,
    allowBusCrossings: params?.allowBusCrossings ?? true,
  };
}

export function createDefaultStep4Settings(
  bbox: BoundingBox,
  params?: Partial<GenerationParams>,
  lockedMetersPerTrain?: number
): Step4RouteSettings {
  return {
    metersPerTrain:
      lockedMetersPerTrain && lockedMetersPerTrain > 0
        ? lockedMetersPerTrain
        : computeIdealMetersPerTrain(bbox),
    strictScale: false,
    autoAdjustScale: params?.autoAdjustScale ?? true,
    targetTrainSpaces: params?.targetTrainSpaces ?? TTR_AVERAGE_BENCHMARK.spaces,
    corridorAdherence: 95,
    minIncludeWeight: 0,
    doubleThresholdWeight: Math.round(100 - (params?.doubleLaneBias ?? 40) * 0.45),
    tripleThresholdWeight: 90,
    doubleRequiresHub: true,
    doubleLaneBias: params?.doubleLaneBias ?? 40,
    maxRouteLength: 10,
    allowTunnels: params?.allowTunnels ?? true,
    allowFerryLocomotives: params?.allowFerryLocomotives ?? true,
    allowBusCrossings: params?.allowBusCrossings ?? true,
    allowShippingHazards: params?.allowShippingHazards ?? true,
    splitPiecesMode: params?.splitPiecesMode ?? true,
  };
}

export function createDefaultStep5Settings(): Step5TicketSettings {
  return {
    targetTicketCount: 0,
    minTicketLength: 4,
    shortShare: 0.36,
    mediumShare: 0.44,
  };
}

export function createInitialPipelineState(
  bbox: BoundingBox,
  board?: Partial<BoardDefinition>,
  dataset?: RawRegionDataset | null
): GenerationPipelineState {
  const params = board?.generationParams;
  return {
    activeStep: 'area',
    area: {
      bbox,
      zoom: board?.zoom ?? 9,
      regionLabel: board?.regionLabel || 'Custom Region',
      cacheId: board?.cacheId,
      scannedAt: dataset ? new Date().toISOString() : undefined,
      dataset: dataset ?? null,
    },
    locations: {
      settings: createDefaultStep2Settings(params),
      candidates: [],
    },
    corridors: {
      settings: createDefaultStep3Settings(params),
      candidates: [],
    },
    routes: {
      settings: createDefaultStep4Settings(bbox, params, board?.metersPerTrain),
      items: [],
    },
    tickets: {
      settings: createDefaultStep5Settings(),
      items: [],
    },
  };
}

export function hydratePipelineFromBoard(
  board: BoardDefinition,
  dataset?: RawRegionDataset | null
): GenerationPipelineState {
  const base = createInitialPipelineState(board.bbox, board, dataset);
  const hasRoutes = board.routes.length > 0;
  const hasLocations = board.locations.length > 0;
  const locById = new Map(board.locations.map((l) => [l.id, l]));

  const candidates: PipelineLocationCandidate[] = board.locations.map((loc) => ({
    ...loc,
    selected: true,
    autoSelected: true,
    manualOverride: loc.source === 'manual' ? 'manual' : undefined,
  }));

  // Also include unpicked raw POIs if dataset is provided
  if (dataset) {
    const existingIds = new Set(candidates.map((c) => c.id));
    for (const poi of dataset.pois) {
      if (existingIds.has(poi.id)) continue;
      if (
        poi.lat < board.bbox.south ||
        poi.lat > board.bbox.north ||
        poi.lng < board.bbox.west ||
        poi.lng > board.bbox.east
      ) {
        continue;
      }
      const pos = projectPointToCanvas(poi.lat, poi.lng, board.bbox);
      candidates.push({
        id: poi.id,
        name: poi.name,
        lat: poi.lat,
        lng: poi.lng,
        x: pos.x,
        y: pos.y,
        popularityScore: poi.osmScore,
        category: poi.category,
        isMajorHub: false,
        population: poi.population,
        wikiSitelinks: poi.wikiSitelinks,
        source: 'osm',
        selected: false,
        autoSelected: false,
        filterReason: 'not_selected',
        interchangeModes: poi.interchangeModes,
      });
    }
  }

  const corridors: PipelineCorridorCandidate[] = board.routes.map((r, idx) => {
    const a = locById.get(r.fromId);
    const b = locById.get(r.toId);
    const distMeters = a && b ? haversineMeters(a.lat, a.lng, b.lat, b.lng) : r.length * board.metersPerTrain;
    const arcMeters =
      a && b
        ? computeRouteGeoArcMeters(a, b, r.pathType, r.waypoints, r.curveOffset)
        : r.length * board.metersPerTrain;
    return {
      id: r.sourceCorridorId || `corr-${r.fromId}-${r.toId}-${idx}`,
      fromId: r.fromId,
      toId: r.toId,
      mode: r.transportMode,
      transitWeight: r.transitWeight,
      cost: Math.round((1 - r.transitWeight / 120) * 100) / 100,
      distMeters: Math.round(distMeters),
      arcMeters: Math.round(arcMeters),
      pathType: r.pathType ?? (r.waypoints && r.waypoints.length > 0 ? 'bezier' : 'line'),
      waypoints: r.waypoints ? [...r.waypoints] : undefined,
      curveOffset: r.curveOffset,
      tracedFromCorridor: Boolean(r.waypoints && r.waypoints.length > 0),
      isTunnel: r.isTunnel,
      ferryLocomotives: r.ferryLocomotives,
      roadHazard: r.hazardType === 'bus_crossing' ? r.hazardRating : 0,
      maritimeHazard: r.hazardType === 'shipping_lane' ? r.hazardRating : 0,
      realLineName: r.realLineName,
      selected: true,
      autoSelected: true,
      hazardType: r.hazardType,
      hazardRating: r.hazardRating,
      hazardPoint: r.hazardPoint,
    };
  });

  const normalizedRoutes: BoardRoute[] = board.routes.map((r, idx) => ({
    ...r,
    laneCount: r.laneCount ?? (r.isDouble ? 2 : 1),
    sourceCorridorId: r.sourceCorridorId || corridors[idx]?.id,
  }));

  return {
    ...base,
    activeStep: hasRoutes ? 'routes' : hasLocations ? 'locations' : 'area',
    locations: {
      ...base.locations,
      candidates,
      lastAutoRunAt: hasLocations ? board.updatedAt : undefined,
    },
    corridors: {
      ...base.corridors,
      candidates: corridors,
      lastAutoRunAt: hasRoutes ? board.updatedAt : undefined,
    },
    routes: {
      ...base.routes,
      items: normalizedRoutes,
      lastAutoRunAt: hasRoutes ? board.updatedAt : undefined,
    },
    tickets: {
      ...base.tickets,
      items: board.tickets,
      lastAutoRunAt: board.tickets.length > 0 ? board.updatedAt : undefined,
    },
  };
}

export function hydratePipelineFromCheckpoint(
  checkpoint: MapGenerationCheckpoint,
  dataset?: RawRegionDataset | null
): GenerationPipelineState {
  if (checkpoint.pipeline) {
    const mergedSettings = {
      ...createDefaultStep3Settings(),
      ...(checkpoint.pipeline.corridors?.settings || {}),
    };
    return {
      ...checkpoint.pipeline,
      corridors: {
        ...checkpoint.pipeline.corridors,
        settings: mergedSettings,
      },
      area:
        dataset && !checkpoint.pipeline.area.dataset
          ? {
              ...checkpoint.pipeline.area,
              dataset,
              scannedAt: checkpoint.pipeline.area.scannedAt || checkpoint.createdAt,
            }
          : checkpoint.pipeline.area,
    };
  }

  const base = hydratePipelineFromBoard(checkpoint.currentBoard, dataset);
  // Enrich from stage artifacts if present
  const stage1 = checkpoint.stages.find((s) => s.key === 'candidates');
  const stage3 = checkpoint.stages.find((s) => s.key === 'candidate_paths');
  const stage4 = checkpoint.stages.find((s) => s.key === 'selected_paths');

  if (stage1?.locations?.length) {
    const activeIds = new Set(checkpoint.currentBoard.locations.map((l) => l.id));
    const merged: PipelineLocationCandidate[] = checkpoint.currentBoard.locations.map((loc) => ({
      ...loc,
      selected: true,
      autoSelected: true,
    }));
    for (const cand of stage1.locations) {
      if (!activeIds.has(cand.id)) {
        merged.push({
          ...cand,
          selected: false,
          autoSelected: false,
          filterReason: 'pruned',
        });
      }
    }
    base.locations.candidates = merged;
  }

  const edgeStage = stage4?.edges?.length ? stage4 : stage3;
  if (edgeStage?.edges?.length) {
    const locById = new Map(base.locations.candidates.map((l) => [l.id, l]));
    const activeRouteByPair = new Map<string, BoardRoute>();
    for (const r of base.routes.items) {
      const k1 = `${r.fromId}:${r.toId}`;
      const k2 = `${r.toId}:${r.fromId}`;
      activeRouteByPair.set(k1, r);
      activeRouteByPair.set(k2, r);
    }

    const hydratedCorridors: PipelineCorridorCandidate[] = [];
    const seenPairs = new Set<string>();
    for (const e of edgeStage.edges) {
      const pairKey = [e.fromId, e.toId].sort().join(':');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const a = locById.get(e.fromId);
      const b = locById.get(e.toId);
      if (!a || !b) continue;
      const existingRoute = activeRouteByPair.get(`${e.fromId}:${e.toId}`);
      const isSelected = Boolean(existingRoute) || e.status === 'selected' || e.status === 'double';
      hydratedCorridors.push({
        id: existingRoute?.sourceCorridorId || e.id,
        fromId: e.fromId,
        toId: e.toId,
        mode: existingRoute?.transportMode || e.mode,
        transitWeight: e.transitWeight,
        cost: e.cost,
        distMeters: e.distMeters,
        arcMeters: e.arcMeters,
        pathType: existingRoute?.pathType || e.pathType,
        waypoints: existingRoute?.waypoints || e.waypoints,
        curveOffset: existingRoute?.curveOffset ?? 0,
        tracedFromCorridor: Boolean((existingRoute?.waypoints || e.waypoints)?.length),
        isTunnel: existingRoute?.isTunnel ?? false,
        ferryLocomotives: existingRoute?.ferryLocomotives ?? 0,
        roadHazard: existingRoute?.hazardType === 'bus_crossing' ? existingRoute.hazardRating : 0,
        maritimeHazard: existingRoute?.hazardType === 'shipping_lane' ? existingRoute.hazardRating : 0,
        realLineName: existingRoute?.realLineName || e.realLineName,
        selected: isSelected,
        autoSelected: e.status === 'selected' || e.status === 'double',
        rejectionReason: isSelected ? undefined : e.reason || 'not_selected',
        hazardType: existingRoute?.hazardType,
        hazardRating: existingRoute?.hazardRating,
        hazardPoint: existingRoute?.hazardPoint,
      });
    }
    if (hydratedCorridors.length > 0) {
      base.corridors.candidates = hydratedCorridors;
    }
  }

  return base;
}

// =========================================================================
// STEP 2: Candidate Location Detection & Interactive Auto-Selection
// =========================================================================
export function runStep2Locations(options: {
  dataset: RawRegionDataset | null;
  bbox: BoundingBox;
  settings: Step2LocationSettings;
  metersPerTrain: number;
  prevCandidates?: PipelineLocationCandidate[];
  preserveManual?: boolean;
  aiAdjustments?: Map<string, { cleanName?: string; boost?: number }>;
}): {
  candidates: PipelineLocationCandidate[];
  selectedLocations: BoardLocation[];
} {
  const { dataset, bbox, settings, metersPerTrain, prevCandidates = [], preserveManual = true, aiAdjustments } = options;

  const targetCount = Math.max(10, Math.min(60, settings.targetLocations));
  const minTrainsGap = Math.max(1.0, Math.min(4.5, settings.minNodeSpacingTrains));
  const minSpacingMeters = Math.max(50, metersPerTrain * minTrainsGap);
  const minScore = Math.max(0, Math.min(85, settings.minCandidateScore));
  const hubShare = Math.max(0.1, Math.min(0.55, settings.majorHubShare));

  const prevById = new Map(prevCandidates.map((c) => [c.id, c]));
  const rawPool: PipelineLocationCandidate[] = [];

  if (dataset && dataset.pois.length > 0) {
    const inBoxPois = dataset.pois.filter(
      (p) =>
        p.lat >= bbox.south &&
        p.lat <= bbox.north &&
        p.lng >= bbox.west &&
        p.lng <= bbox.east
    );
    const sourcePois = inBoxPois.length >= 6 ? inBoxPois : dataset.pois;

    for (const poi of sourcePois) {
      const prev = prevById.get(poi.id);
      const adj = aiAdjustments?.get(poi.id);
      const lat = prev && preserveManual ? prev.lat : poi.lat;
      const lng = prev && preserveManual ? prev.lng : poi.lng;
      const pos = projectPointToCanvas(lat, lng, bbox);
      const effectiveCategory = prev?.category || poi.category;
      const modes = prev?.interchangeModes || poi.interchangeModes || [];
      const hasMultiHub = modes.length >= 2;
      const interchangeBonus = hasMultiHub
        ? (modes.length - 1) * 8 +
          (modes.includes('ferry') ? 6 : 0) +
          (modes.includes('train') ? 4 : 0)
        : 0;
      const categoryUtilityDelta =
        effectiveCategory === 'port'
          ? 14
          : effectiveCategory === 'station'
            ? 12
            : effectiveCategory === 'district' && !hasMultiHub
              ? -12
              : 0;
      const rawScore =
        prev && preserveManual && prev.manualOverride === 'manual'
          ? prev.popularityScore
          : poi.osmScore + interchangeBonus + categoryUtilityDelta;
      const score = Math.max(8, Math.min(100, rawScore + (adj?.boost ?? 0)));

      rawPool.push({
        id: poi.id,
        name: adj?.cleanName || prev?.name || poi.name,
        lat,
        lng,
        x: pos.x,
        y: pos.y,
        popularityScore: score,
        category: effectiveCategory,
        isMajorHub: prev?.manualOverride === 'include' || prev?.manualOverride === 'manual' ? prev.isMajorHub : false,
        population: poi.population,
        wikiSitelinks: poi.wikiSitelinks,
        source: prev?.source || 'osm',
        selected: false,
        autoSelected: false,
        manualOverride: preserveManual ? prev?.manualOverride : undefined,
        interchangeModes: prev?.interchangeModes || poi.interchangeModes,
        discoveredByBox: prev?.discoveredByBox,
      });
    }
  } else {
    // Re-run over existing candidate pool if no raw dataset is cached
    for (const prev of prevCandidates) {
      const pos = projectPointToCanvas(prev.lat, prev.lng, bbox);
      rawPool.push({
        ...prev,
        x: pos.x,
        y: pos.y,
        selected: false,
        autoSelected: false,
        manualOverride: preserveManual ? prev.manualOverride : undefined,
      });
    }
  }

  // Always retain manual stops (even if created outside OSM dataset)
  const existingIds = new Set(rawPool.map((c) => c.id));
  if (preserveManual) {
    for (const prev of prevCandidates) {
      if ((prev.source === 'manual' || prev.manualOverride === 'manual') && !existingIds.has(prev.id)) {
        const pos = projectPointToCanvas(prev.lat, prev.lng, bbox);
        rawPool.push({
          ...prev,
          x: pos.x,
          y: pos.y,
          selected: true,
          autoSelected: true,
          manualOverride: 'manual',
        });
        existingIds.add(prev.id);
      }
    }
  }

  const chosen: PipelineLocationCandidate[] = [];
  const chosenIds = new Set<string>();
  const reasonById = new Map<string, string>();

  // Forced includes & manual stops go in first
  if (preserveManual) {
    for (const c of rawPool) {
      if (c.source === 'manual' || c.manualOverride === 'manual' || c.manualOverride === 'include') {
        c.selected = true;
        c.autoSelected = true;
        chosen.push(c);
        chosenIds.add(c.id);
      } else if (c.manualOverride === 'exclude') {
        reasonById.set(c.id, 'manual_excluded');
      }
    }
  }

  const eligible = rawPool.filter((c) => {
    if (chosenIds.has(c.id)) return false;
    if (preserveManual && c.manualOverride === 'exclude') return false;
    if (c.popularityScore < minScore) {
      reasonById.set(c.id, `score < ${minScore}`);
      return false;
    }
    return true;
  });

  // 7x5 Spatial Grid Selection
  const cols = 7;
  const rows = 5;
  const cells = new Map<string, PipelineLocationCandidate[]>();
  for (const c of eligible) {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((c.x / CANVAS_W) * cols)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor((c.y / CANVAS_H) * rows)));
    const key = `${gx}:${gy}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(c);
  }
  for (const list of cells.values()) {
    list.sort((a, b) => b.popularityScore - a.popularityScore);
  }

  const trySelect = (loc: PipelineLocationCandidate, spacingM: number): boolean => {
    if (chosenIds.has(loc.id)) return false;
    for (const s of chosen) {
      if (haversineMeters(s.lat, s.lng, loc.lat, loc.lng) < spacingM) {
        if (!reasonById.has(loc.id)) {
          reasonById.set(loc.id, `within ${Math.round(spacingM)}m`);
        }
        return false;
      }
    }
    loc.selected = true;
    loc.autoSelected = true;
    chosen.push(loc);
    chosenIds.add(loc.id);
    reasonById.delete(loc.id);
    return true;
  };

  let round = 0;
  while (chosen.length < targetCount && round < 5) {
    let added = false;
    for (const [, list] of cells) {
      if (chosen.length >= targetCount) break;
      if (round < list.length && trySelect(list[round], minSpacingMeters)) {
        added = true;
      }
    }
    if (!added && round > 1) break;
    round += 1;
  }

  const sortedGlobal = [...eligible].sort((a, b) => b.popularityScore - a.popularityScore);
  for (const mult of [1, 0.85, 0.72]) {
    if (chosen.length >= targetCount) break;
    for (const c of sortedGlobal) {
      if (chosen.length >= targetCount) break;
      trySelect(c, minSpacingMeters * mult);
    }
  }

  // Assign hub flags among chosen nodes
  const hubCutoff = Math.max(3, Math.round(chosen.length * hubShare));
  const sortedChosen = [...chosen].sort((a, b) => b.popularityScore - a.popularityScore);
  const autoHubIds = new Set(sortedChosen.slice(0, hubCutoff).map((l) => l.id));

  for (const c of rawPool) {
    if (c.selected) {
      if (!(preserveManual && (c.source === 'manual' || c.manualOverride === 'include'))) {
        c.isMajorHub = autoHubIds.has(c.id);
      }
      c.filterReason = undefined;
    } else {
      c.isMajorHub = false;
      c.filterReason = reasonById.get(c.id) || 'target_cap';
    }
  }

  const selectedLocations: BoardLocation[] = rawPool
    .filter((c) => c.selected)
    .map(
      ({
        selected: _s,
        autoSelected: _a,
        manualOverride: _m,
        filterReason: _f,
        discoveredByBox: _d,
        interchangeModes: _im,
        ...loc
      }) => loc
    );

  if (PIPELINE_DEBUG_LEVEL >= 1) {
    console.log('[pipeline] runStep2Locations', {
      pool: rawPool.length,
      selected: selectedLocations.length,
    });
  }

  return { candidates: rawPool, selectedLocations };
}

// =========================================================================
// STEP 3: Real-World Corridor Stitching, Stop Splitting, Deduplication & Network Auto-Select
// =========================================================================
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

/**
 * Generates an undirected sorted canonical node-pair key for two stop IDs.
 * Call with (aId, bId).
 * Returns "minId::maxId".
 */
function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}::${bId}` : `${bId}::${aId}`;
}

/**
 * Generates an undirected node-pair + transport-mode deduplication key so genuinely different modes
 * (e.g., rail alongside highway) remain distinct selectable corridors while same-mode duplicates merge.
 * Call with (aId, bId, mode).
 * Returns "minId::maxId::mode".
 */
function pairModeKey(aId: string, bId: string, mode: TransportMode): string {
  return `${pairKey(aId, bId)}::${mode}`;
}

/**
 * Stitches fragmented contiguous OSM ways of the same mode whose endpoints nearly touch
 * (within stitchTolMeters) so a railway or ferry route interrupted across multiple OSM way IDs
 * forms a continuous track through unselected stations down to the next selected stop.
 * Call with RawTransitCorridor[] and endpoint stitch tolerance in meters.
 * Returns stitched RawTransitCorridor[].
 */
function stitchTouchingOsmCorridors(
  rawCorridors: RawTransitCorridor[],
  stitchTolMeters: number
): RawTransitCorridor[] {
  const byMode = new Map<TransportMode, RawTransitCorridor[]>();
  for (const c of rawCorridors) {
    if (!c.points || c.points.length < 2) continue;
    if (!byMode.has(c.mode)) byMode.set(c.mode, []);
    byMode.get(c.mode)!.push(c);
  }

  const stitched: RawTransitCorridor[] = [];
  for (const [mode, list] of byMode) {
    // Highways form dense grids—only stitch named/ref corridors or rail/ferry/bus ways
    const work = list.map((c) => ({
      ...c,
      points: [...c.points],
      used: false,
    }));
    const tol = mode === 'highway' ? Math.min(480, Math.max(240, stitchTolMeters * 0.65)) : stitchTolMeters;

    for (let i = 0; i < work.length; i++) {
      const base = work[i];
      if (base.used) continue;
      base.used = true;

      let grew = true;
      let loops = 0;
      while (grew && loops < 12 && base.points.length < 180) {
        grew = false;
        loops += 1;
        const tail = base.points[base.points.length - 1];
        const prevTail = base.points[Math.max(0, base.points.length - 2)];
        const head = base.points[0];
        const nextHead = base.points[Math.min(base.points.length - 1, 1)];

        const isFoldbackAtJoin = (
          pFrom: { lat: number; lng: number },
          pJoinA: { lat: number; lng: number },
          pJoinB: { lat: number; lng: number },
          pTo: { lat: number; lng: number }
        ) => {
          const v1x = pJoinA.lng - pFrom.lng;
          const v1y = pJoinA.lat - pFrom.lat;
          const v2x = pTo.lng - pJoinB.lng;
          const v2y = pTo.lat - pJoinB.lat;
          const m1 = Math.hypot(v1x, v1y);
          const m2 = Math.hypot(v2x, v2y);
          if (m1 < 1e-6 || m2 < 1e-6) return false;
          const cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
          return cos < -0.55;
        };

        for (let j = 0; j < work.length; j++) {
          const other = work[j];
          if (other.used) continue;
          if (base.id.startsWith('osrm-') || other.id.startsWith('osrm-')) continue;

          const oStart = other.points[0];
          const oSecond = other.points[Math.min(other.points.length - 1, 1)];
          const oPrevEnd = other.points[Math.max(0, other.points.length - 2)];
          const oEnd = other.points[other.points.length - 1];
          const dTailStart = haversineMeters(tail.lat, tail.lng, oStart.lat, oStart.lng);
          const dTailEnd = haversineMeters(tail.lat, tail.lng, oEnd.lat, oEnd.lng);
          const dHeadEnd = haversineMeters(head.lat, head.lng, oEnd.lat, oEnd.lng);
          const dHeadStart = haversineMeters(head.lat, head.lng, oStart.lat, oStart.lng);
          const minTouchDist = Math.min(dTailStart, dTailEnd, dHeadEnd, dHeadStart);
          if (minTouchDist > tol) continue;

          // Avoid jumping across wide gaps between unrelated named routes, while always stitching direct touching junctions
          const strictTouchTol = Math.min(140, tol * 0.45);
          if (
            minTouchDist > strictTouchTol &&
            base.name &&
            other.name &&
            base.name.toLowerCase() !== other.name.toLowerCase() &&
            mode !== 'train'
          ) {
            continue;
          }

          if (dTailStart <= tol) {
            if (dHeadEnd <= tol * 1.6) continue; // Avoid closing loop between parallel routes
            if (isFoldbackAtJoin(prevTail, tail, oStart, oSecond)) continue;
            base.points.push(...other.points.slice(1));
            other.used = true;
            base.weight = Math.max(base.weight, other.weight);
            base.isTunnel = base.isTunnel || other.isTunnel;
            base.isBridge = base.isBridge || other.isBridge;
            if (!base.name && other.name) base.name = other.name;
            grew = true;
            break;
          }
          if (dTailEnd <= tol) {
            if (dHeadStart <= tol * 1.6) continue;
            if (isFoldbackAtJoin(prevTail, tail, oEnd, oPrevEnd)) continue;
            const rev = [...other.points].reverse();
            base.points.push(...rev.slice(1));
            other.used = true;
            base.weight = Math.max(base.weight, other.weight);
            base.isTunnel = base.isTunnel || other.isTunnel;
            base.isBridge = base.isBridge || other.isBridge;
            if (!base.name && other.name) base.name = other.name;
            grew = true;
            break;
          }
          if (dHeadEnd <= tol) {
            if (dTailStart <= tol * 1.6) continue;
            if (isFoldbackAtJoin(oPrevEnd, oEnd, head, nextHead)) continue;
            base.points = [...other.points.slice(0, -1), ...base.points];
            other.used = true;
            base.weight = Math.max(base.weight, other.weight);
            if (!base.name && other.name) base.name = other.name;
            grew = true;
            break;
          }
          if (dHeadStart <= tol) {
            if (dTailEnd <= tol * 1.6) continue;
            if (isFoldbackAtJoin(oSecond, oStart, head, nextHead)) continue;
            const rev = [...other.points].reverse();
            base.points = [...rev.slice(0, -1), ...base.points];
            other.used = true;
            base.weight = Math.max(base.weight, other.weight);
            if (!base.name && other.name) base.name = other.name;
            grew = true;
            break;
          }
        }
      }

      stitched.push({
        id: base.id,
        name: base.name,
        mode: base.mode,
        weight: base.weight,
        isTunnel: base.isTunnel,
        isBridge: base.isBridge,
        points: base.points,
      });
    }
  }

  return stitched;
}

/**
 * Strips sharp zig-zag foldback glitches from an ordered vertex slice before simplifying into waypoints.
 * Removes vertices where the path reverses >142 degrees back toward the previous segment without meaningful advance.
 * Call with metric chain [{ lat, lng, mx, my }].
 * Returns sanitized metric chain with endpoints intact.
 */
function stripZigZagFoldbacks(
  chain: Array<{ lat: number; lng: number; mx: number; my: number }>
): Array<{ lat: number; lng: number; mx: number; my: number }> {
  if (chain.length <= 3) return chain;
  let current = [...chain];
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const next = [current[0]];
    for (let i = 1; i < current.length - 1; i++) {
      const prev = next[next.length - 1];
      const cur = current[i];
      const fwd = current[i + 1];
      const v1x = cur.mx - prev.mx;
      const v1y = cur.my - prev.my;
      const v2x = fwd.mx - cur.mx;
      const v2y = fwd.my - cur.my;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 > 1 && l2 > 1) {
        const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
        // Immediate acute hairpin reversal (back-and-forth spike along same road)
        if (cos < -0.78) {
          changed = true;
          continue;
        }
      }
      next.push(cur);
    }
    next.push(current[current.length - 1]);
    current = next;
    if (!changed || current.length <= 3) break;
  }
  return current;
}

/**
 * Converts a slice of true geographic points between stop `a` and stop `b` into clean composite waypoints
 * (marking sharp >50-degree deflections as 'corner' and smooth bends as 'curve') strictly following
 * the underlying real-world OSM polyline without fabricating artificial bows or foldback zig-zags.
 * Call with ordered points between `a` and `b`, `a`, `b`, and `metersPerTrain`.
 * Returns RouteWaypoint[] (empty when the true corridor is essentially collinear or invalid).
 */
function buildCompositeWaypointsFromGeoSlice(
  interiorPts: Array<{ lat: number; lng: number }>,
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  metersPerTrain: number
): RouteWaypoint[] | undefined {
  if (interiorPts.length === 0) return undefined;
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const toMeters = (lat: number, lng: number) => ({
    lat,
    lng,
    mx: (lng - midLng) * mPerDegLng,
    my: (lat - midLat) * mPerDegLat,
  });

  const rawChain = [
    toMeters(a.lat, a.lng),
    ...interiorPts.map((p) => toMeters(p.lat, p.lng)),
    toMeters(b.lat, b.lng),
  ];
  const chain = stripZigZagFoldbacks(rawChain);
  const chordM = Math.max(10, haversineMeters(a.lat, a.lng, b.lat, b.lng));
  // Preserve real map fidelity tightly while stripping millimeter jitter
  const epsM = Math.max(18, Math.min(metersPerTrain * 0.08, chordM * 0.025));
  const simplified = rdpSimplifyGeo(chain, epsM);
  let inner = simplified.slice(1, -1);

  if (inner.length === 0) return undefined;
  if (inner.length > 14) {
    const stride = inner.length / 14;
    const sampled: typeof inner = [];
    for (let k = 0; k < 14; k++) {
      sampled.push(inner[Math.min(inner.length - 1, Math.floor(k * stride))]);
    }
    inner = sampled;
  }

  const fullPts = [chain[0], ...inner, chain[chain.length - 1]];
  const waypoints: RouteWaypoint[] = [];
  for (let i = 1; i < fullPts.length - 1; i++) {
    const v1x = fullPts[i].mx - fullPts[i - 1].mx;
    const v1y = fullPts[i].my - fullPts[i - 1].my;
    const v2x = fullPts[i + 1].mx - fullPts[i].mx;
    const v2y = fullPts[i + 1].my - fullPts[i].my;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    let kind: WaypointKind = 'curve';
    if (l1 > 1 && l2 > 1) {
      const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      if (deg >= 50) kind = 'corner';
    }
    waypoints.push({
      lat: Number(fullPts[i].lat.toFixed(6)),
      lng: Number(fullPts[i].lng.toFixed(6)),
      kind,
      strength: 1.0,
    });
  }

  if (waypoints.length === 0) return undefined;
  const effType: RoutePathType = waypoints.every((w) => w.kind === 'corner') ? 'polyline' : 'bezier';
  const totalArc = computeRouteGeoArcMeters(a, b, effType, waypoints, 0);
  if (totalArc > Math.max(chordM * 2.25, chordM + metersPerTrain * 1.5)) {
    return undefined;
  }
  return waypoints;
}

/**
 * Evaluates which real OSM/OSRM corridors connect BOTH endpoints `(a, b)` within scale-aware snap tolerance,
 * extracting an ordered contiguous slice along the underlying polyline (never sorting vertices by projection `t`).
 * Unmatched spans with zero real corridors receive low fallback weight (4..14) and `matchedReal = false`.
 * Call with stop a, stop b, projected OSM corridors, projected hazards, and snapRadiusMeters.
 * Returns transitWeight, primary mode, flags, matchedReal, and ordered contiguous slice points.
 */
function evaluateCorridorAlignment(
  a: BoardLocation,
  b: BoardLocation,
  corridors: ProjectedCorridor[],
  hazards: Array<RawHazardZone & { x: number; y: number }>,
  snapRadiusMeters: number
): {
  transitWeight: number;
  mode: TransportMode;
  matchedReal: boolean;
  isTunnel: boolean;
  ferryLocomotives: number;
  roadHazardNearMid: number;
  maritimeHazardNearMid: number;
  realLineName?: string;
  matchedSlicePts?: Array<{ lat: number; lng: number }>;
} {
  const chordM = Math.max(10, haversineMeters(a.lat, a.lng, b.lat, b.lng));
  const bothPorts = a.category === 'port' && b.category === 'port';
  let bestWeight = 0;
  let matchedReal = false;
  let bestMode: TransportMode = bothPorts ? 'ferry' : 'highway';
  let bestName: string | undefined;
  let bestSlice: Array<{ lat: number; lng: number }> | undefined;
  let tunnelHits = 0;

  const midLat = (a.lat + b.lat) / 2;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  for (const c of corridors) {
    if (c.geoPts.length < 2) continue;

    // Require BOTH endpoints to lie close to segments of corridor `c`
    const isWaterLink = c.mode === 'ferry' || bothPorts;
    const endSnapCapM = Math.min(
      isWaterLink ? 8000 : 6200,
      Math.max(isWaterLink ? snapRadiusMeters * 1.45 : snapRadiusMeters * 1.18, chordM * 0.16)
    );

    let bestDistA = Infinity;
    let bestDistB = Infinity;
    let bestSegA = 0;
    let bestSegB = 0;

    for (let i = 0; i < c.geoPts.length - 1; i++) {
      const g1 = c.geoPts[i];
      const g2 = c.geoPts[i + 1];
      const x1 = g1.lng * mPerDegLng;
      const y1 = g1.lat * mPerDegLat;
      const x2 = g2.lng * mPerDegLng;
      const y2 = g2.lat * mPerDegLat;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;

      const ax = a.lng * mPerDegLng;
      const ay = a.lat * mPerDegLat;
      const tA = lenSq < 1 ? 0 : Math.max(0, Math.min(1, ((ax - x1) * dx + (ay - y1) * dy) / lenSq));
      const dA = Math.hypot(ax - (x1 + tA * dx), ay - (y1 + tA * dy));
      if (dA < bestDistA) {
        bestDistA = dA;
        bestSegA = i;
      }

      const bx = b.lng * mPerDegLng;
      const by = b.lat * mPerDegLat;
      const tB = lenSq < 1 ? 0 : Math.max(0, Math.min(1, ((bx - x1) * dx + (by - y1) * dy) / lenSq));
      const dB = Math.hypot(bx - (x1 + tB * dx), by - (y1 + tB * dy));
      if (dB < bestDistB) {
        bestDistB = dB;
        bestSegB = i;
      }
    }

    if (bestDistA > endSnapCapM || bestDistB > endSnapCapM) continue;

    // Extract contiguous slice in NATIVE vertex sequence (no t-projection sorting!)
    const loSeg = Math.min(bestSegA, bestSegB);
    const hiSeg = Math.max(bestSegA, bestSegB);
    const rawSlice = c.geoPts.slice(loSeg + 1, hiSeg + 1);
    const orderedSlice = bestSegA <= bestSegB ? rawSlice : [...rawSlice].reverse();

    // Verify arc length of ordered slice does not backtrack or loop excessively
    let sliceArcM = 0;
    let prevPt: { lat: number; lng: number } = a;
    for (const pt of orderedSlice) {
      sliceArcM += haversineMeters(prevPt.lat, prevPt.lng, pt.lat, pt.lng);
      prevPt = pt;
    }
    sliceArcM += haversineMeters(prevPt.lat, prevPt.lng, b.lat, b.lng);

    if (sliceArcM > Math.max(chordM * 2.15, chordM + snapRadiusMeters * 1.8)) {
      continue;
    }

    const endTightness = 1 - Math.min(1, (bestDistA + bestDistB) / Math.max(1, endSnapCapM * 2));
    const bridgeBonus = c.isBridge ? 8 : 0;
    const effectiveWeight = Math.min(100, Math.round(c.weight * (0.74 + 0.26 * endTightness) + bridgeBonus));
    if (!matchedReal || effectiveWeight > bestWeight) {
      matchedReal = true;
      bestWeight = effectiveWeight;
      bestMode = c.mode;
      bestName = c.name;
      bestSlice = orderedSlice.length > 0 ? orderedSlice : undefined;
    }
    if (c.isTunnel || c.isBridge) {
      tunnelHits += 1;
    }
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

  if (!matchedReal) {
    // Low fallback weights ensure real roads/rails/ferries/bridges always dominate over untraced direct links
    bestMode = bothPorts ? 'ferry' : 'highway';
    bestWeight = bothPorts
      ? 14
      : chordM <= snapRadiusMeters * 3.5
        ? 8
        : 4;
  }

  return {
    transitWeight: Math.min(100, bestWeight),
    mode: bestMode,
    matchedReal,
    isTunnel: tunnelHits > 0,
    ferryLocomotives: bestMode === 'ferry' ? (chordM > 14000 ? 2 : 1) : 0,
    roadHazardNearMid,
    maritimeHazardNearMid,
    realLineName: bestName,
    matchedSlicePts: bestSlice,
  };
}

/**
 * Checks whether an intermediate active stop `m` sits geometrically along the chord or polyline
 * connecting endpoints `u` and `v`. Used to enforce the no-bypass rule (prefer `u->m->v` over direct `u->v`).
 * Call with endpoints u, v, optional interior waypoints, active candidate list, and snap tolerance in meters.
 * Returns the closest blocking intermediate stop or null.
 */
function findIntermediateStopAlongPath(
  u: BoardLocation,
  v: BoardLocation,
  waypoints: RouteWaypoint[] | undefined,
  activeStops: BoardLocation[],
  toleranceMeters: number
): BoardLocation | null {
  const midLat = (u.lat + v.lat) / 2;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const chain = [
    u,
    ...(waypoints || []),
    v,
  ];
  const chordM = Math.max(1, haversineMeters(u.lat, u.lng, v.lat, v.lng));
  const effTol = Math.max(toleranceMeters, chordM * 0.09);

  for (const m of activeStops) {
    if (m.id === u.id || m.id === v.id) continue;
    const dToU = haversineMeters(m.lat, m.lng, u.lat, u.lng);
    const dToV = haversineMeters(m.lat, m.lng, v.lat, v.lng);
    if (dToU >= chordM || dToV >= chordM) continue;

    // Distance from m to polyline segments
    const mx = (m.lng - u.lng) * mPerDegLng;
    const my = (m.lat - u.lat) * mPerDegLat;
    for (let i = 0; i < chain.length - 1; i++) {
      const p1x = (chain[i].lng - u.lng) * mPerDegLng;
      const p1y = (chain[i].lat - u.lat) * mPerDegLat;
      const p2x = (chain[i + 1].lng - u.lng) * mPerDegLng;
      const p2y = (chain[i + 1].lat - u.lat) * mPerDegLat;
      const dx = p2x - p1x;
      const dy = p2y - p1y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1) continue;
      const t = Math.max(0, Math.min(1, ((mx - p1x) * dx + (my - p1y) * dy) / lenSq));
      const dSeg = Math.hypot(mx - (p1x + t * dx), my - (p1y + t * dy));
      if (dSeg <= effTol) {
        return m;
      }
    }
  }
  return null;
}

/**
 * Step 3 Map Corridor Engine:
 * 1. Stitches fragmented OSM corridors of the same mode and splits every real corridor wherever
 *    it passes close enough to active stops at the current scale (`A -> B -> C` splits cleanly into `A -> B` and `B -> C`).
 * 2. Allows long real corridors passing through unselected intermediate locations to bridge between two selected stops cleanly.
 * 3. Deduplicates segments per `(pairKey, mode)` so distinct modes alongside each other (e.g. rail + highway) stay separate
 *    while duplicate tracks/lanes collapse and add `evidenceCount` / `transitWeight`.
 * 4. Enforces No-Bypass rule: prevents proposing `A -> C` when active stop `B` lies along the path, transferring evidence onto `A -> B` & `B -> C`.
 * 5. Never invents fake synthetic curves when OSM geometry isn't present.
 * Call with active+unselected candidates, dataset, bbox, settings, metersPerTrain, prevCorridors, and preserveManual.
 * Returns { corridors }.
 */
export function runStep3Corridors(options: {
  allCandidates: PipelineLocationCandidate[];
  dataset: RawRegionDataset | null;
  bbox: BoundingBox;
  settings: Step3CorridorSettings;
  metersPerTrain: number;
  prevCorridors?: PipelineCorridorCandidate[];
  preserveManual?: boolean;
}): {
  corridors: PipelineCorridorCandidate[];
} {
  const { allCandidates, dataset, bbox, settings, metersPerTrain, prevCorridors = [], preserveManual = true } = options;
  const active = allCandidates
    .filter((c) => c.selected)
    .map((c) => {
      const p = projectPointToCanvas(c.lat, c.lng, bbox);
      return { ...c, x: p.x, y: p.y };
    });

  if (active.length < 2) return { corridors: [] };

  const activeById = new Map(active.map((l) => [l.id, l]));
  const prevByPairMode = new Map<string, PipelineCorridorCandidate>();
  const prevByPairAny = new Map<string, PipelineCorridorCandidate>();
  for (const pc of prevCorridors) {
    prevByPairMode.set(pairModeKey(pc.fromId, pc.toId, pc.mode), pc);
    prevByPairAny.set(pairKey(pc.fromId, pc.toId), pc);
  }

  // Scale-aware capture radius for matching real corridors to selected stops
  const snapStopMeters = Math.max(180, Math.min(3400, metersPerTrain * 0.78));
  const stitchedRawCorridors = stitchTouchingOsmCorridors(
    dataset?.corridors || [],
    Math.max(220, metersPerTrain * 0.35)
  );

  const projectedCorridors: ProjectedCorridor[] = stitchedRawCorridors.map((c) => ({
    id: c.id,
    mode: c.mode,
    weight: c.weight,
    isTunnel: c.isTunnel,
    isBridge: c.isBridge,
    name: c.name,
    pts: c.points.map((pt) => projectPointToCanvas(pt.lat, pt.lng, bbox)),
    geoPts: c.points,
  }));

  const projectedHazards = (dataset?.hazards || []).map((h) => ({
    ...h,
    ...projectPointToCanvas(h.lat, h.lng, bbox),
  }));

  const candidateMap = new Map<string, PipelineCorridorCandidate>();
  const fidelity = settings.transitFidelity / 100;

  const upsertCandidateSegment = (
    u: BoardLocation,
    v: BoardLocation,
    mode: TransportMode,
    transitWeight: number,
    waypoints: RouteWaypoint[] | undefined,
    tracedFromCorridor: boolean,
    opts: {
      isTunnel: boolean;
      ferryLocomotives: number;
      roadHazard: number;
      maritimeHazard: number;
      realLineName?: string;
      evidenceBoost?: number;
    }
  ) => {
    const orderedU = u.id < v.id ? u : v;
    const orderedV = u.id < v.id ? v : u;
    const pmk = pairModeKey(orderedU.id, orderedV.id, mode);
    const prev = prevByPairMode.get(pmk) || prevByPairAny.get(pairKey(orderedU.id, orderedV.id));
    const directDistM = haversineMeters(orderedU.lat, orderedU.lng, orderedV.lat, orderedV.lng);
    const existing = candidateMap.get(pmk);

    if (existing) {
      // Merge parallel/duplicate tracks of the SAME mode -> raise evidenceCount & transitWeight
      existing.evidenceCount = (existing.evidenceCount || 1) + (opts.evidenceBoost ?? 1);
      existing.transitWeight = Math.min(100, Math.max(existing.transitWeight, transitWeight) + 4);
      if (!existing.realLineName && opts.realLineName) existing.realLineName = opts.realLineName;
      if (!existing.tracedFromCorridor && tracedFromCorridor && waypoints && waypoints.length > 0) {
        existing.waypoints = u.id < v.id ? waypoints : [...waypoints].reverse();
        existing.pathType = waypoints.some((w) => w.kind === 'corner') ? 'polyline' : 'bezier';
        existing.tracedFromCorridor = true;
        existing.arcMeters = Math.round(
          computeRouteGeoArcMeters(orderedU, orderedV, existing.pathType, existing.waypoints, 0)
        );
      }
      return;
    }

    const hasCustomManualShape = Boolean(
      preserveManual &&
        prev?.manualOverride === 'manual' &&
        prev.mode === mode &&
        ((prev.waypoints && prev.waypoints.length > 0) || !tracedFromCorridor)
    );
    const alignedWaypoints = hasCustomManualShape
      ? prev?.waypoints
      : waypoints && waypoints.length > 0
        ? u.id < v.id
          ? waypoints
          : [...waypoints].reverse()
        : undefined;
    const pathType: RoutePathType = hasCustomManualShape
      ? prev!.pathType
      : alignedWaypoints && alignedWaypoints.length > 0
        ? alignedWaypoints.some((w) => w.kind === 'corner')
          ? 'polyline'
          : 'bezier'
        : 'line';

    const arcMeters = computeRouteGeoArcMeters(orderedU, orderedV, pathType, alignedWaypoints, 0);
    const estTrains = computeChainTrainCount(arcMeters, metersPerTrain, pathType, alignedWaypoints || []);
    const normDist = directDistM / (metersPerTrain * 8);
    const transitBonus = 1 - transitWeight / 100;
    const lengthPenalty = estTrains > 10 ? 2.2 : estTrains >= 9 ? 0.9 : estTrains === 8 ? 0.42 : estTrains === 7 ? 0.16 : 0;
    const untracedPenalty = tracedFromCorridor ? 0 : 0.72 + 0.85 * fidelity;
    const modeBias =
      tracedFromCorridor && fidelity > 0.25
        ? mode === 'train'
          ? -0.1 * fidelity
          : mode === 'ferry'
            ? -0.08 * fidelity
            : mode === 'bus'
              ? -0.04 * fidelity
              : 0
        : 0;
    const cost = Math.max(
      0.01,
      (1 - fidelity) * normDist +
        fidelity * (0.42 * normDist + 0.58 * transitBonus) +
        lengthPenalty +
        untracedPenalty +
        modeBias
    );

    candidateMap.set(pmk, {
      id: prev && prev.mode === mode ? prev.id : `corr-${orderedU.id}-${orderedV.id}-${mode}`,
      fromId: orderedU.id,
      toId: orderedV.id,
      mode,
      transitWeight: prev?.manualOverride === 'manual' && prev.mode === mode ? prev.transitWeight : transitWeight,
      cost: Math.round(cost * 100) / 100,
      distMeters: Math.round(directDistM),
      arcMeters: Math.round(arcMeters),
      pathType,
      waypoints: alignedWaypoints,
      curveOffset: 0,
      tracedFromCorridor,
      isTunnel: opts.isTunnel,
      ferryLocomotives: opts.ferryLocomotives,
      roadHazard: opts.roadHazard,
      maritimeHazard: opts.maritimeHazard,
      realLineName: prev?.realLineName || opts.realLineName,
      evidenceCount: opts.evidenceBoost ?? 1,
      selected: false,
      autoSelected: false,
      manualOverride: preserveManual && prev?.mode === mode ? prev.manualOverride : undefined,
    });
  };

  // PASS 1: Trace EVERY stitched OSM corridor and split cleanly at every selected stop it serves
  if (settings.traceRealCorridors) {
    for (const c of projectedCorridors) {
      if (c.geoPts.length < 2) continue;

      // Cumulative distance along corridor vertices
      const cumDist: number[] = [0];
      for (let i = 1; i < c.geoPts.length; i++) {
        cumDist.push(
          cumDist[i - 1] + haversineMeters(c.geoPts[i - 1].lat, c.geoPts[i - 1].lng, c.geoPts[i].lat, c.geoPts[i].lng)
        );
      }

      const midLat = (bbox.south + bbox.north) / 2;
      const mPerDegLat = 111132;
      const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

      interface CorridorStopHit {
        stop: BoardLocation & { x: number; y: number };
        alongMeters: number;
        segIdx: number;
        perpMeters: number;
      }

      const hits: CorridorStopHit[] = [];
      for (const stop of active) {
        const stopCapM =
          c.mode === 'ferry' || stop.category === 'port' ? snapStopMeters * 1.45 : snapStopMeters;
        let bestPerp = Infinity;
        let bestAlong = 0;
        let bestSeg = 0;

        for (let i = 0; i < c.geoPts.length - 1; i++) {
          const g1 = c.geoPts[i];
          const g2 = c.geoPts[i + 1];
          const p1x = g1.lng * mPerDegLng;
          const p1y = g1.lat * mPerDegLat;
          const p2x = g2.lng * mPerDegLng;
          const p2y = g2.lat * mPerDegLat;
          const sx = stop.lng * mPerDegLng;
          const sy = stop.lat * mPerDegLat;
          const dx = p2x - p1x;
          const dy = p2y - p1y;
          const lenSq = dx * dx + dy * dy;
          const t =
            lenSq < 1
              ? 0
              : Math.max(0, Math.min(1, ((sx - p1x) * dx + (sy - p1y) * dy) / lenSq));
          const perp = Math.hypot(sx - (p1x + t * dx), sy - (p1y + t * dy));
          if (perp < bestPerp) {
            bestPerp = perp;
            bestSeg = i;
            bestAlong = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);
          }
        }

        if (bestPerp <= stopCapM) {
          hits.push({ stop, alongMeters: bestAlong, segIdx: bestSeg, perpMeters: bestPerp });
        }
      }

      if (hits.length < 2) continue;
      hits.sort((a, b) => a.alongMeters - b.alongMeters);

      // Deduplicate consecutive hits referring to the same stop
      const orderedHits: CorridorStopHit[] = [];
      for (const h of hits) {
        if (orderedHits.length === 0 || orderedHits[orderedHits.length - 1].stop.id !== h.stop.id) {
          orderedHits.push(h);
        }
      }

      // Split into contiguous atomic segments [hits[k] -> hits[k+1]]
      for (let k = 0; k < orderedHits.length - 1; k++) {
        const hA = orderedHits[k];
        const hB = orderedHits[k + 1];
        if (hA.stop.id === hB.stop.id) continue;
        const chordM = haversineMeters(hA.stop.lat, hA.stop.lng, hB.stop.lat, hB.stop.lng);
        if (chordM > metersPerTrain * 14) continue;

        const loSeg = Math.min(hA.segIdx, hB.segIdx);
        const hiSeg = Math.max(hA.segIdx, hB.segIdx);
        const rawSlice = c.geoPts.slice(loSeg + 1, hiSeg + 1);
        const orientedSlice = hA.segIdx <= hB.segIdx ? rawSlice : [...rawSlice].reverse();

        // Reject anomalous loop/backtrack slices where corridor distance far exceeds endpoint span
        let rawArcM = 0;
        let prevGeo: { lat: number; lng: number } = hA.stop;
        for (const pt of orientedSlice) {
          rawArcM += haversineMeters(prevGeo.lat, prevGeo.lng, pt.lat, pt.lng);
          prevGeo = pt;
        }
        rawArcM += haversineMeters(prevGeo.lat, prevGeo.lng, hB.stop.lat, hB.stop.lng);
        if (rawArcM > Math.max(chordM * 2.2, chordM + metersPerTrain * 1.5)) {
          continue;
        }

        const waypoints = buildCompositeWaypointsFromGeoSlice(
          orientedSlice,
          hA.stop,
          hB.stop,
          metersPerTrain
        );

        let roadHaz = 0;
        let marHaz = 0;
        for (const haz of projectedHazards) {
          if (pointToSegmentDist({ x: haz.x, y: haz.y }, hA.stop, hB.stop) < 32) {
            if (haz.type === 'road_intersection') roadHaz = Math.max(roadHaz, haz.severity);
            if (haz.type === 'maritime_hazard') marHaz = Math.max(marHaz, haz.severity);
          }
        }

        const effectiveWeight = c.isBridge ? Math.min(100, c.weight + 6) : c.weight;
        upsertCandidateSegment(hA.stop, hB.stop, c.mode, effectiveWeight, waypoints, true, {
          isTunnel: c.isTunnel || c.isBridge,
          ferryLocomotives: c.mode === 'ferry' ? (chordM > 14000 ? 2 : 1) : 0,
          roadHazard: roadHaz,
          maritimeHazard: marHaz,
          realLineName: c.name,
        });
      }
    }
  }

  // PASS 2: Evaluate nearby stop pairs not yet linked on a direct stitched line (e.g. maritime ferries or local connectors)
  const maxPreferEdgeMeters = metersPerTrain * 10.5;
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const others = active
      .map((loc, idx) => ({
        idx,
        loc,
        distMeters: haversineMeters(a.lat, a.lng, loc.lat, loc.lng),
      }))
      .filter((o) => o.idx !== i)
      .sort((x, y) => x.distMeters - y.distMeters)
      .slice(0, 8);

    for (let rank = 0; rank < others.length; rank++) {
      const o = others[rank];
      if (o.distMeters > maxPreferEdgeMeters && rank > 2) continue;

      const evalRes = evaluateCorridorAlignment(a, o.loc, projectedCorridors, projectedHazards, snapStopMeters);
      const pmk = pairModeKey(a.id, o.loc.id, evalRes.mode);
      if (candidateMap.has(pmk)) continue;

      // Only add fallback candidate if another mode wasn't already genuinely traced or it matches strong transit
      const hasAnyModeAlready = Array.from(candidateMap.values()).some(
        (cand) => pairKey(cand.fromId, cand.toId) === pairKey(a.id, o.loc.id)
      );
      if (hasAnyModeAlready && (!evalRes.matchedReal || evalRes.transitWeight < 62)) continue;

      const waypoints =
        settings.traceRealCorridors && evalRes.matchedReal && evalRes.matchedSlicePts
          ? buildCompositeWaypointsFromGeoSlice(evalRes.matchedSlicePts, a, o.loc, metersPerTrain)
          : undefined;

      upsertCandidateSegment(
        a,
        o.loc,
        evalRes.mode,
        evalRes.transitWeight,
        waypoints,
        evalRes.matchedReal,
        {
          isTunnel: evalRes.isTunnel,
          ferryLocomotives: evalRes.ferryLocomotives,
          roadHazard: evalRes.roadHazardNearMid,
          maritimeHazard: evalRes.maritimeHazardNearMid,
          realLineName: evalRes.realLineName,
        }
      );
    }
  }

  // PASS 3: Enforce No-Bypass rule — never propose A -> C if active stop B sits along/between the path;
  // instead transfer A -> C's evidenceCount / weight strength onto segments (A, B) and (B, C)
  const bypassTolMeters = Math.max(snapStopMeters * 0.85, 220);
  const prunedKeys = new Set<string>();
  const currentEntries = Array.from(candidateMap.entries());
  for (const [pmk, cand] of currentEntries) {
    if (cand.manualOverride === 'manual' || cand.manualOverride === 'include') continue;
    const u = activeById.get(cand.fromId);
    const v = activeById.get(cand.toId);
    if (!u || !v) continue;

    const blocker = findIntermediateStopAlongPath(u, v, cand.waypoints, active, bypassTolMeters);
    if (!blocker) continue;

    const k1 = pairModeKey(u.id, blocker.id, cand.mode);
    const k2 = pairModeKey(blocker.id, v.id, cand.mode);
    const seg1 = candidateMap.get(k1);
    const seg2 = candidateMap.get(k2);
    const bonusEvidence = cand.evidenceCount || 1;

    if (seg1) {
      seg1.evidenceCount = (seg1.evidenceCount || 1) + bonusEvidence;
      seg1.transitWeight = Math.min(100, Math.max(seg1.transitWeight, Math.round(cand.transitWeight * 0.95)) + 5);
    }
    if (seg2) {
      seg2.evidenceCount = (seg2.evidenceCount || 1) + bonusEvidence;
      seg2.transitWeight = Math.min(100, Math.max(seg2.transitWeight, Math.round(cand.transitWeight * 0.95)) + 5);
    }
    prunedKeys.add(pmk);
  }
  for (const k of prunedKeys) {
    candidateMap.delete(k);
  }

  // Retain manual links between active stops cleanly (upgrading straight untraced lines when real road/transit geometry exists)
  if (preserveManual) {
    for (const prev of prevCorridors) {
      if (prev.manualOverride !== 'manual' && prev.manualOverride !== 'include') continue;
      const u = activeById.get(prev.fromId);
      const v = activeById.get(prev.toId);
      if (!u || !v) continue;
      const pmk = pairModeKey(u.id, v.id, prev.mode);
      if (candidateMap.has(pmk)) continue;

      let nextMode = prev.mode;
      let nextWps = prev.waypoints;
      let nextPathType = prev.pathType;
      let nextTraced = prev.tracedFromCorridor;
      let nextWeight = prev.transitWeight;
      let nextLineName = prev.realLineName;

      if (
        settings.traceRealCorridors &&
        !prev.tracedFromCorridor &&
        (!prev.waypoints || prev.waypoints.length === 0)
      ) {
        const evalRes = evaluateCorridorAlignment(u, v, projectedCorridors, projectedHazards, snapStopMeters);
        if (evalRes.matchedReal && evalRes.matchedSlicePts) {
          const builtWps = buildCompositeWaypointsFromGeoSlice(evalRes.matchedSlicePts, u, v, metersPerTrain);
          if (builtWps && builtWps.length > 0) {
            nextMode = evalRes.mode;
            nextWps = builtWps;
            nextPathType = builtWps.some((w) => w.kind === 'corner') ? 'polyline' : 'bezier';
            nextTraced = true;
            nextWeight = Math.max(prev.transitWeight, evalRes.transitWeight);
            nextLineName = prev.realLineName || evalRes.realLineName;
          }
        }
      }

      const nextPmk = pairModeKey(u.id, v.id, nextMode);
      if (candidateMap.has(nextPmk)) continue;

      const distMeters = haversineMeters(u.lat, u.lng, v.lat, v.lng);
      const arcMeters = computeRouteGeoArcMeters(u, v, nextPathType, nextWps, prev.curveOffset);
      candidateMap.set(nextPmk, {
        ...prev,
        mode: nextMode,
        waypoints: nextWps,
        pathType: nextPathType,
        tracedFromCorridor: nextTraced,
        transitWeight: nextWeight,
        realLineName: nextLineName,
        distMeters: Math.round(distMeters),
        arcMeters: Math.round(arcMeters),
        selected: true,
        autoSelected: true,
      });
    }
  }

  const candidates = Array.from(candidateMap.values()).sort((a, b) => a.cost - b.cost);
  const minConn = Math.max(1, Math.min(4, settings.minConnections));
  const maxConn = Math.max(minConn + 1, Math.min(10, settings.maxConnections));

  const parent = new Map<string, string>();
  for (const loc of active) parent.set(loc.id, loc.id);
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  };

  const degree = new Map<string, number>();
  for (const loc of active) degree.set(loc.id, 0);
  const chosen: PipelineCorridorCandidate[] = [];
  const selectedPairSet = new Set<string>();

  const overlapAvoidance = Math.max(0, Math.min(100, settings.overlapAvoidance ?? 75));
  const canvasPolyCache = new Map<string, Array<{ x: number; y: number }>>();
  const getCorridorCanvasPoly = (edge: PipelineCorridorCandidate): Array<{ x: number; y: number }> => {
    const cached = canvasPolyCache.get(edge.id);
    if (cached) return cached;
    const p1 = activeById.get(edge.fromId);
    const p2 = activeById.get(edge.toId);
    if (!p1 || !p2) return [];
    const effType = resolveEffectivePathType(edge.pathType, edge.waypoints, edge.curveOffset);
    const effWps = resolveEffectiveWaypoints(p1, p2, effType, edge.waypoints, edge.curveOffset);
    const sampled = sampleGenericPath(
      { a: p1.lng, b: p1.lat },
      { a: p2.lng, b: p2.lat },
      effWps.map((w) => ({ a: w.lng, b: w.lat, kind: w.kind, strength: w.strength })),
      effType,
      10
    ).map((pt) => projectPointToCanvas(pt.b, pt.a, bbox));
    canvasPolyCache.set(edge.id, sampled);
    return sampled;
  };

  /**
   * Checks both composite polyline crossings and near-parallel corridor overlaps against already selected corridors
   * according to `overlapAvoidance` (0 = permit freely, 100 = strictly avoid when alternatives exist).
   */
  const checkCorridorConflict = (
    edge: PipelineCorridorCandidate
  ): {
    blocked: boolean;
    reason?: 'crossing' | 'overlap';
    busCrossingPoint?: { x: number; y: number };
    busHazardRating: number;
  } => {
    const p1 = activeById.get(edge.fromId);
    const p2 = activeById.get(edge.toId);
    if (!p1 || !p2) return { blocked: true, busHazardRating: 0 };

    const edgePts = getCorridorCanvasPoly(edge);
    if (edgePts.length < 2) return { blocked: true, busHazardRating: 0 };

    let crossings = 0;
    let bestPt: { x: number; y: number } | undefined;
    let valid45 = true;
    let maxOverlapRatio = 0;

    const overlapTolPx = 5 + (overlapAvoidance / 100) * 14; // 5px..19px corridor envelope
    const overlapRatioThreshold = Math.max(0.14, 0.44 - (overlapAvoidance / 100) * 0.28); // 0.44..0.16

    for (const existing of chosen) {
      const sharesFrom = existing.fromId === edge.fromId || existing.toId === edge.fromId;
      const sharesTo = existing.fromId === edge.toId || existing.toId === edge.toId;
      const sharesEndpoint = sharesFrom || sharesTo;
      const existingPts = getCorridorCanvasPoly(existing);
      if (existingPts.length < 2) continue;

      // 1. Check composite polyline segment crossings
      if (!sharesEndpoint || (edgePts.length > 2 && existingPts.length > 2)) {
        for (let i = 0; i < edgePts.length - 1; i++) {
          if (sharesFrom && i === 0) continue;
          if (sharesTo && i === edgePts.length - 2) continue;
          for (let j = 0; j < existingPts.length - 1; j++) {
            if (sharesEndpoint && (j === 0 || j === existingPts.length - 2)) continue;
            const hit = segmentsIntersectionPoint(
              edgePts[i],
              edgePts[i + 1],
              existingPts[j],
              existingPts[j + 1]
            );
            if (hit) {
              crossings += 1;
              bestPt = { x: hit.x, y: hit.y };
              if (hit.angleDeg < 28 || hit.angleDeg > 72) valid45 = false;
            }
          }
        }
      }

      // 2. Check near-parallel hugging overlap along interior samples (when overlapAvoidance > 0)
      if (overlapAvoidance > 0) {
        let closeSamples = 0;
        let testedSamples = 0;
        const startIdx = sharesFrom ? 2 : 1;
        const endIdx = edgePts.length - (sharesTo ? 2 : 1);
        for (let k = startIdx; k < endIdx; k++) {
          const sp = edgePts[k];
          // Exclude small endpoint halo around shared stops so diverging spokes don't false-positive
          if (sharesFrom && distPx(sp, p1) < 16) continue;
          if (sharesTo && distPx(sp, p2) < 16) continue;
          testedSamples += 1;
          let minD = Infinity;
          for (let j = 0; j < existingPts.length - 1; j++) {
            minD = Math.min(minD, pointToSegmentDist(sp, existingPts[j], existingPts[j + 1]));
            if (minD <= overlapTolPx) break;
          }
          if (minD <= overlapTolPx) closeSamples += 1;
        }
        if (testedSamples > 0) {
          maxOverlapRatio = Math.max(maxOverlapRatio, closeSamples / testedSamples);
        }
      }
    }

    if (crossings > 0) {
      if (settings.allowBusCrossings && edge.mode === 'bus' && crossings === 1 && valid45) {
        return {
          blocked: false,
          busCrossingPoint: bestPt,
          busHazardRating: Math.max(1, Math.min(4, edge.roadHazard || 2)),
        };
      }
      if (overlapAvoidance >= 15) {
        return { blocked: true, reason: 'crossing', busHazardRating: 0 };
      }
    }

    if (overlapAvoidance >= 20 && maxOverlapRatio >= overlapRatioThreshold) {
      return { blocked: true, reason: 'overlap', busHazardRating: 0 };
    }

    return { blocked: false, busHazardRating: 0 };
  };

  const acceptEdge = (c: PipelineCorridorCandidate, hazardPt?: { x: number; y: number }, hazardRating = 0) => {
    c.selected = true;
    c.autoSelected = true;
    c.rejectionReason = undefined;
    if (hazardRating > 0) {
      c.hazardType = 'bus_crossing';
      c.hazardRating = hazardRating;
      c.hazardPoint = hazardPt;
    } else if (c.hazardType === 'bus_crossing') {
      c.hazardType = 'none';
      c.hazardRating = 0;
      c.hazardPoint = undefined;
    }
    chosen.push(c);
    selectedPairSet.add(pairKey(c.fromId, c.toId));
    union(c.fromId, c.toId);
    degree.set(c.fromId, (degree.get(c.fromId) || 0) + 1);
    degree.set(c.toId, (degree.get(c.toId) || 0) + 1);
  };

  // Pre-accept manual includes first
  if (preserveManual) {
    for (const c of candidates) {
      if (c.manualOverride === 'manual' || c.manualOverride === 'include') {
        const conflict = checkCorridorConflict(c);
        acceptEdge(c, conflict.busCrossingPoint, conflict.busHazardRating);
      } else if (c.manualOverride === 'exclude') {
        c.rejectionReason = 'manual_excluded';
      }
    }
  }

  const eligible = candidates.filter((c) => {
    if (c.selected) return false;
    if (preserveManual && c.manualOverride === 'exclude') return false;
    if (c.transitWeight < settings.minCorridorWeight) {
      c.rejectionReason = `weight < ${settings.minCorridorWeight}`;
      return false;
    }
    return true;
  });

  // 1. Non-crossing / non-overlapping Kruskal MST (traced real corridors prioritized)
  for (const c of eligible) {
    if (find(c.fromId) !== find(c.toId)) {
      const conflict = checkCorridorConflict(c);
      if (!conflict.blocked) {
        acceptEdge(c, conflict.busCrossingPoint, conflict.busHazardRating);
      } else {
        c.rejectionReason = conflict.reason || 'crossing';
      }
    }
  }

  // 2. Connectivity fallback (strictly connect isolated islands if no non-overlapping / high-weight edge bridged them)
  for (const c of candidates) {
    if (c.selected || (preserveManual && c.manualOverride === 'exclude')) continue;
    if (find(c.fromId) !== find(c.toId)) {
      acceptEdge(c);
    }
  }

  // 3. Satisfy minConnections while avoiding overlaps/crossings
  for (let pass = 0; pass < 2; pass++) {
    for (const loc of active) {
      if ((degree.get(loc.id) || 0) >= minConn) continue;
      for (const c of eligible) {
        if (c.selected) continue;
        if (selectedPairSet.has(pairKey(c.fromId, c.toId))) continue;
        if (c.fromId !== loc.id && c.toId !== loc.id) continue;
        if ((degree.get(c.fromId) || 0) >= maxConn || (degree.get(c.toId) || 0) >= maxConn) {
          c.rejectionReason = c.rejectionReason || 'max_connections';
          continue;
        }
        const conflict = checkCorridorConflict(c);
        if (conflict.blocked) {
          c.rejectionReason = c.rejectionReason || conflict.reason || 'crossing';
          continue;
        }
        acceptEdge(c, conflict.busCrossingPoint, conflict.busHazardRating);
        if ((degree.get(loc.id) || 0) >= minConn) break;
      }
    }
  }

  // 4. Fill healthy route density up to ~2.1x stops avoiding overlaps
  const targetRouteCount = Math.min(
    Math.round(active.length * 2.15),
    Math.round((active.length * (minConn + maxConn)) / 2.2)
  );
  for (const c of eligible) {
    if (chosen.length >= targetRouteCount) break;
    if (c.selected) continue;
    if (selectedPairSet.has(pairKey(c.fromId, c.toId))) continue;
    if ((degree.get(c.fromId) || 0) >= maxConn || (degree.get(c.toId) || 0) >= maxConn) {
      c.rejectionReason = c.rejectionReason || 'max_connections';
      continue;
    }
    const conflict = checkCorridorConflict(c);
    if (conflict.blocked) {
      c.rejectionReason = c.rejectionReason || conflict.reason || 'crossing';
      continue;
    }
    acceptEdge(c, conflict.busCrossingPoint, conflict.busHazardRating);
  }

  for (const c of candidates) {
    if (!c.selected && !c.rejectionReason) {
      c.rejectionReason = 'route_budget';
    }
  }

  if (PIPELINE_DEBUG_LEVEL >= 1) {
    console.log('[pipeline] runStep3Corridors', {
      totalCandidates: candidates.length,
      selected: chosen.length,
      bypassPruned: prunedKeys.size,
      overlapAvoidance,
    });
  }

  return { corridors: candidates };
}

// =========================================================================
// STEP 4: Convert Map Corridors -> Train / Bus / Ferry Game Routes
// =========================================================================
/**
 * Abstracts real-world Step 3 composite waypoints toward simplified game-board curves according to
 * `corridorAdherence` (0 = direct chord, 100 = full OSM curves + corners).
 * Preserves per-waypoint `kind` ('corner' | 'curve') on surviving anchors.
 * Call with from/to endpoints, pathType, waypoints, curveOffset, adherence, and metersPerTrain.
 * Returns { pathType, waypoints, curveOffset }.
 */
export function simplifyWaypointsByAdherence(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  pathType: RoutePathType,
  waypoints: RouteWaypoint[] | undefined,
  curveOffset: number,
  adherence: number,
  metersPerTrain: number
): { pathType: RoutePathType; waypoints?: RouteWaypoint[]; curveOffset: number } {
  const clampAdh = Math.max(0, Math.min(100, adherence));
  if (!waypoints || waypoints.length === 0 || pathType === 'line') {
    if (clampAdh < 15) return { pathType: 'line', waypoints: undefined, curveOffset: 0 };
    return { pathType, waypoints, curveOffset };
  }

  const normalizedWaypoints: RouteWaypoint[] = waypoints.map((w) => ({
    ...w,
    kind: w.kind || (pathType === 'polyline' ? 'corner' : 'curve'),
  }));

  if (clampAdh >= 90) {
    return { pathType, waypoints: normalizedWaypoints, curveOffset };
  }

  if (clampAdh < 18) {
    return { pathType: 'line', waypoints: undefined, curveOffset: 0 };
  }

  const midLat = (from.lat + to.lat) / 2;
  const midLng = (from.lng + to.lng) / 2;
  const mPerDegLat = 111132;
  const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const toMeters = (w: { lat: number; lng: number; kind?: WaypointKind }) => ({
    lat: w.lat,
    lng: w.lng,
    kind: w.kind || 'curve',
    mx: (w.lng - midLng) * mPerDegLng,
    my: (w.lat - midLat) * mPerDegLat,
  });

  const chord = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const chain = [
    toMeters(from),
    ...normalizedWaypoints.map((w) => toMeters(w)),
    toMeters(to),
  ];
  const factor = (100 - clampAdh) / 100; // 0.1..0.82
  const eps = Math.max(metersPerTrain * 0.2, chord * factor * 0.25);
  const simplified = rdpSimplifyGeo(chain, eps);
  let inner = simplified.slice(1, -1);

  if (clampAdh < 50 && inner.length > 1) {
    inner = [inner[Math.floor(inner.length / 2)]];
  }

  if (inner.length === 0) {
    return { pathType: 'line', waypoints: undefined, curveOffset: 0 };
  }

  // Re-match closest original waypoint kind for each surviving simplified anchor
  const outWaypoints: RouteWaypoint[] = inner.map((p) => {
    let bestKind: WaypointKind = clampAdh < 55 ? 'curve' : 'curve';
    if (clampAdh >= 55) {
      let bestD = Infinity;
      for (const orig of normalizedWaypoints) {
        const d = haversineMeters(p.lat, p.lng, orig.lat, orig.lng);
        if (d < bestD) {
          bestD = d;
          bestKind = orig.kind || 'curve';
        }
      }
    }
    return {
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
      kind: bestKind,
      strength: bestKind === 'curve' ? 0.95 : 1.0,
    };
  });

  const nextPathType: RoutePathType =
    outWaypoints.every((w) => w.kind === 'corner') ? 'polyline' : 'bezier';

  return {
    pathType: nextPathType,
    waypoints: outWaypoints,
    curveOffset,
  };
}

export function runStep4TrainRoutes(options: {
  activeLocations: BoardLocation[];
  corridors: PipelineCorridorCandidate[];
  bbox: BoundingBox;
  settings: Step4RouteSettings;
  prevRoutes?: BoardRoute[];
  preserveManualOverrides?: boolean;
}): {
  routes: BoardRoute[];
  effectiveMetersPerTrain: number;
} {
  const { activeLocations, corridors, bbox, settings, prevRoutes = [], preserveManualOverrides = true } = options;

  const locById = new Map(activeLocations.map((l) => [l.id, l]));
  const includedCorridors = corridors.filter((c) => {
    if (!c.selected) return false;
    if (!locById.has(c.fromId) || !locById.has(c.toId)) return false;
    if (c.manualOverride === 'include' || c.manualOverride === 'manual') return true;
    return c.transitWeight >= settings.minIncludeWeight;
  });

  const prevByCorridorId = new Map<string, BoardRoute>();
  const prevByPair = new Map<string, BoardRoute>();
  for (const r of prevRoutes) {
    if (r.sourceCorridorId) prevByCorridorId.set(r.sourceCorridorId, r);
    prevByPair.set(pairKey(r.fromId, r.toId), r);
  }

  const buildAtScale = (scaleMeters: number): BoardRoute[] => {
    const colorCursor = { idx: 0 };
    const nextColor = (preferGray: boolean): RouteColor => {
      if (preferGray) return 'gray';
      const c = ROUTE_COLORS_POOL[colorCursor.idx % ROUTE_COLORS_POOL.length];
      colorCursor.idx += 1;
      return c;
    };

    const effectiveDoubleThreshold = Math.max(
      35,
      Math.min(98, settings.doubleThresholdWeight - (settings.doubleLaneBias - 40) * 0.3)
    );

    return includedCorridors.map((corr, idx) => {
      const a = locById.get(corr.fromId)!;
      const b = locById.get(corr.toId)!;
      const prev =
        preserveManualOverrides
          ? prevByCorridorId.get(corr.id) || prevByPair.get(pairKey(corr.fromId, corr.toId))
          : undefined;

      const prevHasRelativeOrCustom =
        Boolean(prev && preserveManualOverrides) &&
        Boolean(
          prev?.customWaypoints ||
            prev?.waypoints?.some((w) => Math.abs(w.relOffsetRatio || 0) > 1e-4)
        );

      let geo: { pathType: RoutePathType; waypoints?: RouteWaypoint[]; curveOffset: number };
      if (prev && prevHasRelativeOrCustom) {
        // Re-evaluate attached train route waypoints proportionally against the updated parent corridor
        const updatedWps = (prev.waypoints || []).map((w) => {
          if (typeof w.relT === 'number') {
            const pt = evaluateRelativeWaypointOnCorridor(
              a,
              b,
              corr.waypoints,
              corr.pathType,
              corr.curveOffset,
              w.relT,
              w.relOffsetRatio || 0
            );
            return { ...w, lat: pt.lat, lng: pt.lng };
          }
          const proj = projectPointOntoCorridorCurve(
            a,
            b,
            corr.waypoints,
            corr.pathType,
            corr.curveOffset,
            w
          );
          return { ...w, relT: proj.relT, relOffsetRatio: proj.relOffsetRatio };
        });
        const effType: RoutePathType =
          updatedWps.length === 0
            ? 'line'
            : updatedWps.every((w) => w.kind === 'corner')
              ? 'polyline'
              : 'bezier';
        geo = {
          pathType: effType,
          waypoints: updatedWps.length > 0 ? updatedWps : undefined,
          curveOffset: prev.curveOffset ?? 0,
        };
      } else {
        const simplified = simplifyWaypointsByAdherence(
          a,
          b,
          corr.pathType,
          corr.waypoints,
          corr.curveOffset,
          settings.corridorAdherence,
          scaleMeters
        );
        // Stamp each copied waypoint with its exact parametric (relT, relOffsetRatio: 0) along parent corridor
        const stampedWps = simplified.waypoints?.map((w) => {
          const proj = projectPointOntoCorridorCurve(
            a,
            b,
            corr.waypoints,
            corr.pathType,
            corr.curveOffset,
            w
          );
          return {
            ...w,
            relT: proj.relT,
            relOffsetRatio: 0,
          };
        });
        geo = {
          ...simplified,
          waypoints: stampedWps,
        };
      }

      const arcMeters = computeRouteGeoArcMeters(a, b, geo.pathType, geo.waypoints, geo.curveOffset);
      const rawLen = computeChainTrainCount(arcMeters, scaleMeters, geo.pathType, geo.waypoints || []);
      const maxLen = Math.max(5, Math.min(15, settings.maxRouteLength || 10));
      const length = Math.max(1, Math.min(maxLen, rawLen));

      // Determine lane count (1 = Single, 2 = Double, 3 = Triple); merged parallel corridor evidence boosts weight
      const evidenceScore = corr.transitWeight + Math.min(14, ((corr.evidenceCount || 1) - 1) * 7);
      let laneCount: 1 | 2 | 3 = 1;
      const hubOk = !settings.doubleRequiresHub || a.isMajorHub || b.isMajorHub;
      if (prev && preserveManualOverrides && prev.laneCount) {
        laneCount = prev.laneCount;
      } else if (
        settings.doubleLaneBias >= 20 &&
        hubOk &&
        evidenceScore >= settings.tripleThresholdWeight &&
        length <= 7
      ) {
        laneCount = 3;
      } else if (
        settings.doubleLaneBias > 0 &&
        hubOk &&
        evidenceScore >= effectiveDoubleThreshold &&
        length <= 8
      ) {
        laneCount = 2;
      }

      const preferGray = idx % 5 === 0 || idx % 5 === 3 || corr.mode === 'ferry';
      const color = prev && preserveManualOverrides ? prev.color : nextColor(preferGray);

      let doubleColor = prev && preserveManualOverrides ? prev.doubleColor : undefined;
      if (laneCount >= 2 && !doubleColor) {
        doubleColor = nextColor(false);
        if (doubleColor === color) doubleColor = nextColor(false);
      }

      let tripleColor = prev && preserveManualOverrides ? prev.tripleColor : undefined;
      if (laneCount >= 3 && !tripleColor) {
        tripleColor = nextColor(false);
        if (tripleColor === color || tripleColor === doubleColor) tripleColor = nextColor(false);
      }

      let hazardType: HazardType = corr.hazardType === 'bus_crossing' && settings.allowBusCrossings ? 'bus_crossing' : 'none';
      let hazardRating = hazardType === 'bus_crossing' ? corr.hazardRating || 2 : 0;
      let hazardPoint = hazardType === 'bus_crossing' ? corr.hazardPoint : undefined;
      let hazardLatLng: { lat: number; lng: number } | undefined = hazardPoint
        ? unprojectCanvasToLatLng(hazardPoint.x, hazardPoint.y, bbox)
        : undefined;

      if (
        hazardType === 'none' &&
        settings.allowShippingHazards &&
        corr.mode === 'ferry' &&
        (corr.maritimeHazard > 0 || length >= 3)
      ) {
        hazardType = 'shipping_lane';
        hazardRating = Math.max(1, Math.min(4, corr.maritimeHazard || (length >= 5 ? 3 : 2)));
        hazardPoint = {
          x: Math.round(((a.x + b.x) / 2) * 10) / 10,
          y: Math.round(((a.y + b.y) / 2) * 10) / 10,
        };
        hazardLatLng = geo.waypoints?.[0] || {
          lat: (a.lat + b.lat) / 2,
          lng: (a.lng + b.lng) / 2,
        };
      }

      return {
        id: prev?.id || `route-${idx + 1}`,
        fromId: corr.fromId,
        toId: corr.toId,
        length,
        color,
        doubleColor: laneCount >= 2 ? doubleColor : undefined,
        tripleColor: laneCount >= 3 ? tripleColor : undefined,
        isDouble: laneCount >= 2,
        laneCount,
        curveOffset: geo.curveOffset,
        pathType: geo.pathType,
        waypoints: geo.waypoints,
        customWaypoints: prev && preserveManualOverrides ? prev.customWaypoints : undefined,
        transportMode: corr.mode,
        transitWeight: corr.transitWeight,
        isTunnel:
          prev && preserveManualOverrides
            ? prev.isTunnel
            : settings.allowTunnels
              ? corr.isTunnel
              : false,
        ferryLocomotives:
          prev && preserveManualOverrides
            ? prev.ferryLocomotives
            : settings.allowFerryLocomotives
              ? corr.ferryLocomotives
              : 0,
        hazardRating: prev && preserveManualOverrides && prev.hazardRating > 0 ? prev.hazardRating : hazardRating,
        hazardType: prev && preserveManualOverrides && prev.hazardType !== 'none' ? prev.hazardType : hazardType,
        hazardPoint: prev && preserveManualOverrides && prev.hazardPoint ? prev.hazardPoint : hazardPoint,
        hazardLatLng: prev && preserveManualOverrides && prev.hazardLatLng ? prev.hazardLatLng : hazardLatLng,
        realLineName: corr.realLineName,
        sourceCorridorId: corr.id,
      };
    });
  };

  let activeScale = Math.max(20, settings.metersPerTrain || computeIdealMetersPerTrain(bbox));
  let routes = buildAtScale(activeScale);

  const countSpaces = (list: BoardRoute[]) =>
    list.reduce((acc, r) => acc + r.length * (r.laneCount ?? (r.isDouble ? 2 : 1)), 0);

  if (settings.autoAdjustScale && !settings.strictScale && routes.length > 0) {
    let totalSpaces = countSpaces(routes);
    const minScale = Math.max(20, activeScale * 0.42);
    for (let step = 0; step < 4; step++) {
      if (totalSpaces >= settings.targetTrainSpaces * 0.88) break;
      const nextScale = Math.max(minScale, Math.round(activeScale * 0.85 * 10) / 10);
      if (nextScale >= activeScale * 0.97) break;
      const candidate = buildAtScale(nextScale);
      const len8 = candidate.filter((r) => r.length === 8).length;
      const len9 = candidate.filter((r) => r.length >= 9).length;
      if (len8 > 4 || len9 > 2) break;
      const candSpaces = countSpaces(candidate);
      if (candSpaces > totalSpaces) {
        routes = candidate;
        activeScale = nextScale;
        totalSpaces = candSpaces;
      } else {
        break;
      }
    }
  }

  return { routes, effectiveMetersPerTrain: activeScale };
}

// =========================================================================
// STEP 5: Graded Ticket Generation & Deterministic Point Recalculation
// =========================================================================
function computeShortestPathStats(
  locations: BoardLocation[],
  routes: BoardRoute[]
): (startId: string, endId: string) => { len: number; hops: number; hazardSteps: number } {
  const adj = new Map<string, Array<{ to: string; len: number; isHazardOrTunnel: boolean }>>();
  for (const loc of locations) adj.set(loc.id, []);
  for (const r of routes) {
    const isHazardOrTunnel =
      r.isTunnel || r.ferryLocomotives > 0 || (r.hazardRating > 0 && r.hazardType !== 'none');
    adj.get(r.fromId)?.push({ to: r.toId, len: r.length, isHazardOrTunnel });
    adj.get(r.toId)?.push({ to: r.fromId, len: r.length, isHazardOrTunnel });
  }

  return (startId: string, endId: string) => {
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
}

export function runStep5Tickets(
  locations: BoardLocation[],
  routes: BoardRoute[],
  settings: Step5TicketSettings
): DestinationTicket[] {
  if (locations.length < 4 || routes.length === 0) return [];
  const shortestPathStats = computeShortestPathStats(locations, routes);

  const autoTarget = Math.max(12, Math.min(80, Math.round(locations.length * 0.72 + routes.length * 0.18)));
  const targetTicketCount = settings.targetTicketCount > 0 ? settings.targetTicketCount : autoTarget;
  const minLen = Math.max(2, Math.min(8, settings.minTicketLength || 4));

  interface RawCandidateTicket extends DestinationTicket {
    qualityScore: number;
  }

  const allPairs: RawCandidateTicket[] = [];
  let maxObservedSpan = 10;

  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i];
      const b = locations[j];
      const sp = shortestPathStats(a.id, b.id);
      if (!Number.isFinite(sp.len) || sp.len < minLen || sp.hops < 2) continue;
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
        qualityScore: hubBonus + popScore + Math.min(25, geoMeters / 5000),
      });
    }
  }

  if (allPairs.length === 0) return [];

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

  const shortQuota = Math.round(targetTicketCount * settings.shortShare);
  const medQuota = Math.round(targetTicketCount * settings.mediumShare);
  const longQuota = Math.max(1, targetTicketCount - shortQuota - medQuota);

  const combined = [
    ...pickBalancedTier(allPairs.filter((t) => t.grade === 'short'), shortQuota, usageCount, maxUsesPerStop),
    ...pickBalancedTier(allPairs.filter((t) => t.grade === 'medium'), medQuota, usageCount, maxUsesPerStop),
    ...pickBalancedTier(allPairs.filter((t) => t.grade === 'long'), longQuota, usageCount, maxUsesPerStop),
  ];

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

  return combined.map(({ qualityScore: _q, ...t }, idx) => ({
    ...t,
    id: `tkt-${idx + 1}`,
  }));
}

export function recalculateTicketPoints(
  locations: BoardLocation[],
  routes: BoardRoute[],
  existingTickets: DestinationTicket[]
): DestinationTicket[] {
  if (existingTickets.length === 0) return [];
  const locMap = new Map(locations.map((l) => [l.id, l]));
  const spFn = computeShortestPathStats(locations, routes);

  const valid: DestinationTicket[] = [];
  let maxSpan = 10;
  const spans: number[] = [];

  for (const t of existingTickets) {
    const fromLoc = locMap.get(t.fromId);
    const toLoc = locMap.get(t.toId);
    if (!fromLoc || !toLoc) continue;
    const sp = spFn(t.fromId, t.toId);
    const len = Number.isFinite(sp.len) ? sp.len : t.shortestPathTrains ?? t.points;
    if (len > maxSpan) maxSpan = len;
    spans.push(len);
    valid.push({
      ...t,
      fromName: fromLoc.name,
      toName: toLoc.name,
      shortestPathTrains: Number.isFinite(sp.len) ? sp.len : undefined,
      points: Number.isFinite(sp.len)
        ? Math.max(4, Math.min(26, sp.len + (sp.hazardSteps >= 2 ? 1 : 0)))
        : t.points,
    });
  }

  const shortMax = Math.max(7, Math.round(maxSpan * 0.42));
  const medMax = Math.max(shortMax + 3, Math.round(maxSpan * 0.72));
  return valid.map((t, idx) => {
    const len = spans[idx] ?? t.points;
    return {
      ...t,
      grade: len <= shortMax ? 'short' : len <= medMax ? 'medium' : 'long',
    };
  });
}

// =========================================================================
// DOWNSTREAM PROPAGATION (Step 2 -> Step 3 -> Step 4 -> Step 5)
// =========================================================================
export function syncBoardFromPipeline(
  board: BoardDefinition,
  pipeline: GenerationPipelineState
): BoardDefinition {
  const activeLocations: BoardLocation[] = pipeline.locations.candidates
    .filter((c) => c.selected)
    .map(({ selected: _s, autoSelected: _a, manualOverride: _m, filterReason: _f, ...loc }) => {
      const p = projectPointToCanvas(loc.lat, loc.lng, pipeline.area.bbox);
      return { ...loc, x: p.x, y: p.y };
    });

  const genParams: GenerationParams = {
    ...board.generationParams,
    targetLocations: pipeline.locations.settings.targetLocations,
    minNodeSpacingTrains: pipeline.locations.settings.minNodeSpacingTrains,
    useAiEnrichment: pipeline.locations.settings.useAiEnrichment,
    minConnections: pipeline.corridors.settings.minConnections,
    maxConnections: pipeline.corridors.settings.maxConnections,
    transitFidelity: pipeline.corridors.settings.transitFidelity,
    traceRealCorridors: pipeline.corridors.settings.traceRealCorridors,
    curveIntensity: pipeline.corridors.settings.curveIntensity,
    allowBusCrossings: pipeline.routes.settings.allowBusCrossings,
    allowTunnels: pipeline.routes.settings.allowTunnels,
    allowFerryLocomotives: pipeline.routes.settings.allowFerryLocomotives,
    allowShippingHazards: pipeline.routes.settings.allowShippingHazards,
    splitPiecesMode: pipeline.routes.settings.splitPiecesMode,
    autoAdjustScale: pipeline.routes.settings.autoAdjustScale,
    targetTrainSpaces: pipeline.routes.settings.targetTrainSpaces,
    doubleLaneBias: pipeline.routes.settings.doubleLaneBias,
  };

  return {
    ...board,
    bbox: pipeline.area.bbox,
    zoom: pipeline.area.zoom,
    regionLabel: pipeline.area.regionLabel || board.regionLabel,
    cacheId: pipeline.area.cacheId ?? board.cacheId,
    metersPerTrain: pipeline.routes.settings.metersPerTrain,
    scaleSpanKm: Math.round((computeBoxWidthMeters(pipeline.area.bbox) / 1000) * 10) / 10,
    maxPlayers: activeLocations.length < 24 ? 4 : 5,
    generationParams: genParams,
    defaultRules: normalizeGameRules(board.defaultRules, {
      generationParams: genParams,
      locations: activeLocations,
      routes: pipeline.routes.items,
    }),
    locations: activeLocations,
    routes: pipeline.routes.items,
    tickets: pipeline.tickets.items,
    updatedAt: new Date().toISOString(),
  };
}

export function propagateAfterStep2Edit(
  pipeline: GenerationPipelineState,
  board: BoardDefinition
): { pipeline: GenerationPipelineState; board: BoardDefinition } {
  const activeLocs = pipeline.locations.candidates.filter((c) => c.selected);
  const locById = new Map(pipeline.locations.candidates.map((c) => [c.id, c]));
  const activeIds = new Set(activeLocs.map((c) => c.id));
  const bbox = pipeline.area.bbox;

  const updatedCorridors: PipelineCorridorCandidate[] = [];
  for (const corr of pipeline.corridors.candidates) {
    const a = locById.get(corr.fromId);
    const b = locById.get(corr.toId);
    if (!a || !b) continue;
    const bothSelected = activeIds.has(a.id) && activeIds.has(b.id);
    const distMeters = Math.round(haversineMeters(a.lat, a.lng, b.lat, b.lng));
    const arcMeters = Math.round(
      computeRouteGeoArcMeters(a, b, corr.pathType, corr.waypoints, corr.curveOffset)
    );
    const pA = projectPointToCanvas(a.lat, a.lng, bbox);
    const pB = projectPointToCanvas(b.lat, b.lng, bbox);

    updatedCorridors.push({
      ...corr,
      distMeters,
      arcMeters,
      selected: bothSelected ? corr.selected : false,
      rejectionReason: bothSelected ? corr.rejectionReason : 'stop_disabled',
      hazardPoint:
        corr.hazardType && corr.hazardType !== 'none'
          ? {
              x: Math.round(((pA.x + pB.x) / 2) * 10) / 10,
              y: Math.round(((pA.y + pB.y) / 2) * 10) / 10,
            }
          : corr.hazardPoint,
    });
  }

  let nextPipeline: GenerationPipelineState = {
    ...pipeline,
    corridors: {
      ...pipeline.corridors,
      candidates: updatedCorridors,
    },
  };

  if (nextPipeline.routes.items.length > 0 || updatedCorridors.some((c) => c.selected)) {
    const { routes, effectiveMetersPerTrain } = runStep4TrainRoutes({
      activeLocations: activeLocs,
      corridors: updatedCorridors,
      bbox,
      settings: nextPipeline.routes.settings,
      prevRoutes: nextPipeline.routes.items,
      preserveManualOverrides: true,
    });
    const nextTickets =
      nextPipeline.tickets.items.length > 0
        ? recalculateTicketPoints(activeLocs, routes, nextPipeline.tickets.items)
        : [];
    nextPipeline = {
      ...nextPipeline,
      routes: {
        ...nextPipeline.routes,
        settings: {
          ...nextPipeline.routes.settings,
          metersPerTrain: effectiveMetersPerTrain,
        },
        items: routes,
      },
      tickets: {
        ...nextPipeline.tickets,
        items: nextTickets,
      },
    };
  }

  return {
    pipeline: nextPipeline,
    board: syncBoardFromPipeline(board, nextPipeline),
  };
}

export function propagateAfterStep3Edit(
  pipeline: GenerationPipelineState,
  board: BoardDefinition
): { pipeline: GenerationPipelineState; board: BoardDefinition } {
  const activeLocs = pipeline.locations.candidates.filter((c) => c.selected);
  const bbox = pipeline.area.bbox;

  const { routes, effectiveMetersPerTrain } = runStep4TrainRoutes({
    activeLocations: activeLocs,
    corridors: pipeline.corridors.candidates,
    bbox,
    settings: pipeline.routes.settings,
    prevRoutes: pipeline.routes.items,
    preserveManualOverrides: true,
  });

  const nextTickets =
    pipeline.tickets.items.length > 0
      ? recalculateTicketPoints(activeLocs, routes, pipeline.tickets.items)
      : [];

  const nextPipeline: GenerationPipelineState = {
    ...pipeline,
    routes: {
      ...pipeline.routes,
      settings: {
        ...pipeline.routes.settings,
        metersPerTrain: effectiveMetersPerTrain,
      },
      items: routes,
    },
    tickets: {
      ...pipeline.tickets,
      items: nextTickets,
    },
  };

  return {
    pipeline: nextPipeline,
    board: syncBoardFromPipeline(board, nextPipeline),
  };
}

export function propagateAfterStep4Edit(
  pipeline: GenerationPipelineState,
  board: BoardDefinition
): { pipeline: GenerationPipelineState; board: BoardDefinition } {
  const activeLocs = pipeline.locations.candidates.filter((c) => c.selected);
  const nextTickets =
    pipeline.tickets.items.length > 0
      ? recalculateTicketPoints(activeLocs, pipeline.routes.items, pipeline.tickets.items)
      : [];

  const nextPipeline: GenerationPipelineState = {
    ...pipeline,
    tickets: {
      ...pipeline.tickets,
      items: nextTickets,
    },
  };

  return {
    pipeline: nextPipeline,
    board: syncBoardFromPipeline(board, nextPipeline),
  };
}
