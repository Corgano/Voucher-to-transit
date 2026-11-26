import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  BoardDefinition,
  BoardRulePreset,
  CachedRegionSummary,
  BoundingBox,
  GameRules,
  GenerationStageArtifact,
  RawHazardZone,
  RawOsmPoi,
  RawRegionDataset,
  RawRegionSources,
  RawTransitCorridor,
  ScaleMode,
  StudioMapWorkspace,
} from '../src/shared/types.ts';
import {
  DEFAULT_GENERATION_PARAMS,
  getBakedBoardRules,
  normalizeGameRules,
} from '../src/shared/benchmarks.ts';
import {
  computeBoxWidthMeters,
  computeChainTrainCount,
  computeIdealMetersPerTrain,
  computeRouteGeoArcMeters,
} from '../src/shared/geoScale.ts';

export type {
  RawOsmPoi,
  RawTransitCorridor,
  RawHazardZone,
  RawRegionSources,
  RawRegionDataset,
};

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'cartograph.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS osm_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bbox_json TEXT NOT NULL,
    zoom INTEGER NOT NULL,
    scale_mode TEXT NOT NULL,
    raw_data_json TEXT NOT NULL,
    pois_count INTEGER NOT NULL,
    transit_count INTEGER NOT NULL,
    hazards_count INTEGER NOT NULL,
    is_pyramid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    theme TEXT NOT NULL,
    cache_id TEXT,
    board_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    room_code TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generation_runs (
    board_id TEXT PRIMARY KEY,
    stages_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS board_rule_presets (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rules_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS studio_workspaces (
    board_id TEXT PRIMARY KEY,
    workspace_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    bbox_json TEXT,
    payload_json TEXT NOT NULL,
    quality_score INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
`);

try {
  db.exec(`ALTER TABLE osm_cache ADD COLUMN is_pyramid INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists on newer databases
}

const stmtSaveCache = db.prepare(`
  INSERT INTO osm_cache (id, name, bbox_json, zoom, scale_mode, raw_data_json, pois_count, transit_count, hazards_count, is_pyramid, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = CASE WHEN excluded.is_pyramid = 0 THEN excluded.name ELSE osm_cache.name END,
    raw_data_json = excluded.raw_data_json,
    pois_count = excluded.pois_count,
    transit_count = excluded.transit_count,
    hazards_count = excluded.hazards_count,
    is_pyramid = CASE WHEN excluded.is_pyramid = 0 THEN 0 ELSE osm_cache.is_pyramid END,
    created_at = excluded.created_at
`);

const stmtGetCacheById = db.prepare(`SELECT * FROM osm_cache WHERE id = ?`);
const stmtListCache = db.prepare(`
  SELECT id, name, bbox_json, zoom, scale_mode, pois_count, transit_count, hazards_count, is_pyramid, created_at
  FROM osm_cache
  WHERE is_pyramid = 0
  ORDER BY created_at DESC
  LIMIT 40
`);
const stmtListAllCacheForLookup = db.prepare(`
  SELECT id, name, bbox_json, zoom, scale_mode, pois_count, transit_count, hazards_count, is_pyramid, created_at
  FROM osm_cache
  ORDER BY is_pyramid ASC, created_at DESC
  LIMIT 220
`);
const stmtCountCacheStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN is_pyramid = 0 THEN 1 ELSE 0 END) as user_count,
    SUM(CASE WHEN is_pyramid = 1 THEN 1 ELSE 0 END) as pyramid_count
  FROM osm_cache
`);
const stmtProviderCacheStats = db.prepare(`
  SELECT provider, COUNT(*) as cnt FROM provider_cache GROUP BY provider
`);

const stmtSaveBoard = db.prepare(`
  INSERT INTO boards (id, name, theme, cache_id, board_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    theme = excluded.theme,
    cache_id = excluded.cache_id,
    board_json = excluded.board_json,
    updated_at = excluded.updated_at
`);

const stmtGetBoard = db.prepare(`SELECT board_json FROM boards WHERE id = ?`);
const stmtListBoards = db.prepare(`SELECT board_json FROM boards ORDER BY updated_at DESC`);
const stmtDeleteBoard = db.prepare(`DELETE FROM boards WHERE id = ?`);
const stmtCountBoards = db.prepare(`SELECT COUNT(*) as cnt FROM boards`);

const stmtSaveSession = db.prepare(`
  INSERT INTO sessions (room_code, state_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(room_code) DO UPDATE SET
    state_json = excluded.state_json,
    updated_at = excluded.updated_at
`);
const stmtGetSession = db.prepare(`SELECT state_json FROM sessions WHERE room_code = ?`);
const stmtListSessions = db.prepare(`SELECT state_json FROM sessions ORDER BY updated_at DESC LIMIT 20`);

const stmtSaveGenRun = db.prepare(`
  INSERT INTO generation_runs (board_id, stages_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(board_id) DO UPDATE SET
    stages_json = excluded.stages_json,
    updated_at = excluded.updated_at
`);
const stmtGetGenRun = db.prepare(`SELECT stages_json FROM generation_runs WHERE board_id = ?`);

const stmtListBoardPresets = db.prepare(`
  SELECT id, board_id, name, rules_json, created_at
  FROM board_rule_presets
  WHERE board_id = ?
  ORDER BY created_at DESC
`);
const stmtInsertBoardPreset = db.prepare(`
  INSERT INTO board_rule_presets (id, board_id, name, rules_json, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtDeleteBoardPreset = db.prepare(`
  DELETE FROM board_rule_presets WHERE id = ? AND board_id = ?
`);
const stmtDeletePresetsForBoard = db.prepare(`DELETE FROM board_rule_presets WHERE board_id = ?`);
const stmtDeleteGenRunForBoard = db.prepare(`DELETE FROM generation_runs WHERE board_id = ?`);

const stmtSaveWorkspace = db.prepare(`
  INSERT INTO studio_workspaces (board_id, workspace_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(board_id) DO UPDATE SET
    workspace_json = excluded.workspace_json,
    updated_at = excluded.updated_at
`);
const stmtGetWorkspace = db.prepare(`SELECT workspace_json FROM studio_workspaces WHERE board_id = ?`);
const stmtListWorkspaces = db.prepare(`SELECT workspace_json FROM studio_workspaces ORDER BY updated_at DESC`);
const stmtDeleteWorkspace = db.prepare(`DELETE FROM studio_workspaces WHERE board_id = ?`);

const stmtSaveProviderCache = db.prepare(`
  INSERT INTO provider_cache (cache_key, provider, bbox_json, payload_json, quality_score, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    bbox_json = excluded.bbox_json,
    payload_json = excluded.payload_json,
    quality_score = excluded.quality_score,
    created_at = excluded.created_at
`);
const stmtGetProviderCache = db.prepare(`
  SELECT payload_json, quality_score, created_at FROM provider_cache WHERE cache_key = ?
`);

export function saveCachedRegion(
  id: string,
  name: string,
  dataset: RawRegionDataset,
  isPyramid = false
): CachedRegionSummary {
  const createdAt = new Date().toISOString();
  stmtSaveCache.run(
    id,
    name,
    JSON.stringify(dataset.bbox),
    dataset.zoom,
    dataset.scaleMode,
    JSON.stringify(dataset),
    dataset.pois.length,
    dataset.corridors.length,
    dataset.hazards.length,
    isPyramid ? 1 : 0,
    createdAt
  );
  return {
    id,
    name,
    bbox: dataset.bbox,
    zoom: dataset.zoom,
    scaleMode: dataset.scaleMode,
    poisCount: dataset.pois.length,
    transitCount: dataset.corridors.length,
    hazardsCount: dataset.hazards.length,
    isPyramid,
    createdAt,
  };
}

export function getCachedRegion(
  id: string
): { summary: CachedRegionSummary; dataset: RawRegionDataset } | null {
  const row = stmtGetCacheById.get(id) as
    | {
        id: string;
        name: string;
        bbox_json: string;
        zoom: number;
        scale_mode: ScaleMode;
        raw_data_json: string;
        pois_count: number;
        transit_count: number;
        hazards_count: number;
        is_pyramid?: number;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    summary: {
      id: row.id,
      name: row.name,
      bbox: JSON.parse(row.bbox_json),
      zoom: row.zoom,
      scaleMode: row.scale_mode,
      poisCount: row.pois_count,
      transitCount: row.transit_count,
      hazardsCount: row.hazards_count,
      isPyramid: Boolean(row.is_pyramid),
      createdAt: row.created_at,
    },
    dataset: JSON.parse(row.raw_data_json),
  };
}

export function getProviderCache<T>(
  provider: string,
  key: string,
  maxAgeMs = 14 * 24 * 60 * 60 * 1000
): T | null {
  try {
    const cacheKey = `${provider}:${key}`;
    const row = stmtGetProviderCache.get(cacheKey) as
      | { payload_json: string; quality_score: number; created_at: string }
      | undefined;
    if (!row || row.quality_score <= 0) return null;
    const age = Date.now() - (Date.parse(row.created_at) || 0);
    if (maxAgeMs > 0 && age > maxAgeMs) return null;
    return JSON.parse(row.payload_json) as T;
  } catch {
    return null;
  }
}

export function saveProviderCache(
  provider: string,
  key: string,
  payload: unknown,
  bbox?: BoundingBox,
  qualityScore = 1
): void {
  if (qualityScore <= 0 || payload === null || payload === undefined) return;
  const cacheKey = `${provider}:${key}`;
  stmtSaveProviderCache.run(
    cacheKey,
    provider,
    bbox ? JSON.stringify(bbox) : null,
    JSON.stringify(payload),
    qualityScore,
    new Date().toISOString()
  );
}

type CacheRowSummary = {
  id: string;
  name: string;
  bbox_json: string;
  zoom: number;
  scale_mode: ScaleMode;
  pois_count: number;
  transit_count: number;
  hazards_count: number;
  is_pyramid?: number;
  created_at: string;
};

function mapCacheRowSummary(r: CacheRowSummary): CachedRegionSummary {
  return {
    id: r.id,
    name: r.name,
    bbox: JSON.parse(r.bbox_json),
    zoom: r.zoom,
    scaleMode: r.scale_mode,
    poisCount: r.pois_count,
    transitCount: r.transit_count,
    hazardsCount: r.hazards_count,
    isPyramid: Boolean(r.is_pyramid),
    createdAt: r.created_at,
  };
}

export function listCachedRegions(includePyramid = false): CachedRegionSummary[] {
  const rows = (
    includePyramid ? stmtListAllCacheForLookup.all() : stmtListCache.all()
  ) as CacheRowSummary[];
  return rows.map(mapCacheRowSummary);
}

export function getCacheStats(): {
  regionsCount: number;
  userRegionsCount: number;
  pyramidRegionsCount: number;
  providerEntriesCount: number;
  byProvider: Record<string, number>;
} {
  const counts = stmtCountCacheStats.get() as
    | { total?: number; user_count?: number; pyramid_count?: number }
    | undefined;
  const provRows = stmtProviderCacheStats.all() as Array<{ provider: string; cnt: number }>;
  const byProvider: Record<string, number> = {};
  let providerEntriesCount = 0;
  for (const r of provRows) {
    byProvider[r.provider] = Number(r.cnt || 0);
    providerEntriesCount += Number(r.cnt || 0);
  }
  return {
    regionsCount: Number(counts?.total || 0),
    userRegionsCount: Number(counts?.user_count || 0),
    pyramidRegionsCount: Number(counts?.pyramid_count || 0),
    providerEntriesCount,
    byProvider,
  };
}

const SCALE_TIER_ORDER: Record<ScaleMode, number> = {
  city: 0,
  metro: 1,
  macro: 2,
};

/**
 * Finds an already-cached good region dataset across any stored zoom tier (-1..+2)
 * whose bounding box either matches (>=86% overlap) or covers the requested bbox with rich POIs inside it.
 */
export function findCoveringCachedRegion(
  bbox: BoundingBox,
  preferredScaleMode?: ScaleMode,
  requireCorridors = true,
  minInsidePois = 4
): { summary: CachedRegionSummary; dataset: RawRegionDataset } | null {
  const summaries = listCachedRegions(true);
  const reqArea = Math.max(1e-9, (bbox.north - bbox.south) * (bbox.east - bbox.west));
  const tol = 0.005;

  let best: { id: string; score: number } | null = null;
  for (const s of summaries) {
    if (s.poisCount < minInsidePois) continue;
    if (requireCorridors && s.transitCount <= 0) continue;

    // Avoid substituting a coarse macro dataset into a tight city-level scan when we want finer local POIs
    if (
      preferredScaleMode &&
      Math.abs(SCALE_TIER_ORDER[s.scaleMode] - SCALE_TIER_ORDER[preferredScaleMode]) >= 2
    ) {
      continue;
    }

    const cb = s.bbox;
    const interS = Math.max(cb.south, bbox.south);
    const interN = Math.min(cb.north, bbox.north);
    const interW = Math.max(cb.west, bbox.west);
    const interE = Math.min(cb.east, bbox.east);
    if (interN <= interS || interE <= interW) continue;

    const interArea = (interN - interS) * (interE - interW);
    const cachedArea = Math.max(1e-9, (cb.north - cb.south) * (cb.east - cb.west));
    const covers =
      cb.south <= bbox.south + tol &&
      cb.north >= bbox.north - tol &&
      cb.west <= bbox.west + tol &&
      cb.east >= bbox.east - tol &&
      reqArea / cachedArea >= 0.03;
    const highOverlap = interArea / Math.max(reqArea, cachedArea) >= 0.86;

    if (!covers && !highOverlap) continue;

    const full = getCachedRegion(s.id);
    if (!full) continue;
    const insidePois = full.dataset.pois.filter(
      (p) =>
        p.lat >= bbox.south &&
        p.lat <= bbox.north &&
        p.lng >= bbox.west &&
        p.lng <= bbox.east
    ).length;
    if (insidePois < minInsidePois) continue;

    const areaSimilarity = Math.min(reqArea, cachedArea) / Math.max(reqArea, cachedArea);
    let score = (interArea / Math.max(reqArea, cachedArea)) * 100 + areaSimilarity * 55 + Math.min(40, insidePois);
    if (preferredScaleMode) {
      if (s.scaleMode === preferredScaleMode) score += 120;
      else score += 20;
    }
    if (!s.isPyramid) score += 8;
    if (s.transitCount > 0) score += 30;
    if (!best || score > best.score) {
      best = { id: s.id, score };
    }
  }

  return best ? getCachedRegion(best.id) : null;
}

/**
 * Combines overlapping cached tiles/zoom layers locally when panning or zooming out across previously
 * scanned sub-regions, avoiding outbound API traffic whenever >=72% of the bbox grid is covered.
 */
export function composeCachedRegionForBbox(
  bbox: BoundingBox,
  preferredScaleMode: ScaleMode,
  targetZoom = 10
): { summary: CachedRegionSummary; dataset: RawRegionDataset } | null {
  const summaries = listCachedRegions(true);
  const candidates = summaries.filter((s) => {
    if (s.poisCount < 3) return false;
    if (
      Math.abs(SCALE_TIER_ORDER[s.scaleMode] - SCALE_TIER_ORDER[preferredScaleMode]) >= 2
    ) {
      return false;
    }
    const cb = s.bbox;
    return !(
      cb.north <= bbox.south ||
      cb.south >= bbox.north ||
      cb.east <= bbox.west ||
      cb.west >= bbox.east
    );
  });

  if (candidates.length < 2) return null;

  // Verify grid coverage (>= 18 of 25 sample points covered by cached boxes)
  let coveredPoints = 0;
  for (let r = 0; r < 5; r++) {
    const lat = bbox.south + ((r + 0.5) / 5) * (bbox.north - bbox.south);
    for (let c = 0; c < 5; c++) {
      const lng = bbox.west + ((c + 0.5) / 5) * (bbox.east - bbox.west);
      if (
        candidates.some(
          (s) =>
            lat >= s.bbox.south &&
            lat <= s.bbox.north &&
            lng >= s.bbox.west &&
            lng <= s.bbox.east
        )
      ) {
        coveredPoints += 1;
      }
    }
  }
  if (coveredPoints < 18) return null;

  const poisByKey = new Map<string, RawOsmPoi>();
  const corridorsById = new Map<string, RawTransitCorridor>();
  const hazardsById = new Map<string, RawHazardZone>();
  const sources: RawRegionSources = {
    overpass: false,
    wikipedia: false,
    wikidata: false,
    photon: false,
    osrm: false,
  };

  const padLat = (bbox.north - bbox.south) * 0.15;
  const padLng = (bbox.east - bbox.west) * 0.15;

  for (const s of candidates) {
    const full = getCachedRegion(s.id);
    if (!full) continue;
    const ds = full.dataset;
    if (ds.sources) {
      sources.overpass = sources.overpass || ds.sources.overpass;
      sources.wikipedia = sources.wikipedia || ds.sources.wikipedia;
      sources.wikidata = sources.wikidata || ds.sources.wikidata;
      sources.photon = sources.photon || ds.sources.photon;
      sources.osrm = sources.osrm || ds.sources.osrm;
    }

    for (const p of ds.pois) {
      if (
        p.lat < bbox.south ||
        p.lat > bbox.north ||
        p.lng < bbox.west ||
        p.lng > bbox.east
      ) {
        continue;
      }
      const key = p.name.trim().toLowerCase();
      const prev = poisByKey.get(key);
      if (!prev || p.osmScore > prev.osmScore) {
        poisByKey.set(key, p);
      }
    }

    for (const c of ds.corridors) {
      if (corridorsById.has(c.id)) continue;
      const intersects = c.points.some(
        (pt) =>
          pt.lat >= bbox.south - padLat &&
          pt.lat <= bbox.north + padLat &&
          pt.lng >= bbox.west - padLng &&
          pt.lng <= bbox.east + padLng
      );
      if (intersects) corridorsById.set(c.id, c);
    }

    for (const h of ds.hazards) {
      if (hazardsById.has(h.id)) continue;
      if (
        h.lat >= bbox.south &&
        h.lat <= bbox.north &&
        h.lng >= bbox.west &&
        h.lng <= bbox.east
      ) {
        hazardsById.set(h.id, h);
      }
    }
  }

  const pois = Array.from(poisByKey.values())
    .sort((a, b) => b.osmScore - a.osmScore)
    .slice(0, 260);
  const corridors = Array.from(corridorsById.values()).slice(0, 650);
  const hazards = Array.from(hazardsById.values()).slice(0, 350);

  if (pois.length < 4 || corridors.length === 0) return null;

  const dataset: RawRegionDataset = {
    bbox,
    zoom: targetZoom,
    scaleMode: preferredScaleMode,
    pois,
    corridors,
    hazards,
    fetchedAt: new Date().toISOString(),
    sources,
  };
  const composedId = `reg-comp-${crypto
    .createHash('sha1')
    .update(
      `${bbox.south.toFixed(3)}:${bbox.west.toFixed(3)}:${bbox.north.toFixed(3)}:${bbox.east.toFixed(3)}:${preferredScaleMode}`
    )
    .digest('hex')
    .slice(0, 10)}`;

  const summary = saveCachedRegion(
    composedId,
    `${candidates[0].name.replace(/\s*\[z\d+\]$/, '')} (Composed)`,
    dataset,
    true
  );
  return { summary, dataset };
}

export function saveBoard(board: BoardDefinition): BoardDefinition {
  const now = new Date().toISOString();
  const updated: BoardDefinition = {
    ...board,
    createdAt: board.createdAt || now,
    updatedAt: now,
  };
  stmtSaveBoard.run(
    updated.id,
    updated.name,
    updated.theme,
    updated.cacheId ?? null,
    JSON.stringify(updated),
    updated.createdAt,
    updated.updatedAt
  );
  return updated;
}

function normalizeBoardScale(board: BoardDefinition): BoardDefinition {
  const needsScale = !board.metersPerTrain || board.metersPerTrain <= 0;
  const isUnmodifiedStarter =
    board.id === 'starter-puget-sound' && board.createdAt === board.updatedAt;
  const bakedRules = getBakedBoardRules(board);
  if (!needsScale && !isUnmodifiedStarter) {
    return board.defaultRules ? { ...board, defaultRules: bakedRules } : { ...board, defaultRules: bakedRules };
  }

  const metersPerTrain = isUnmodifiedStarter
    ? computeIdealMetersPerTrain(board.bbox)
    : board.metersPerTrain > 0
      ? board.metersPerTrain
      : computeIdealMetersPerTrain(board.bbox);
  const locById = new Map(board.locations.map((l) => [l.id, l]));
  const routes = isUnmodifiedStarter
    ? board.routes.map((r) => {
        const a = locById.get(r.fromId);
        const b = locById.get(r.toId);
        if (!a || !b) return r;
        const arcM = computeRouteGeoArcMeters(a, b, r.pathType, r.waypoints, r.curveOffset);
        return {
          ...r,
          pathType: r.pathType || (Math.abs(r.curveOffset) >= 1 ? 'bezier' : 'line'),
          length: computeChainTrainCount(arcM, metersPerTrain, r.pathType, r.waypoints?.length || 0),
        };
      })
    : board.routes;

  return {
    ...board,
    metersPerTrain,
    scaleSpanKm: Math.round((computeBoxWidthMeters(board.bbox) / 1000) * 10) / 10,
    defaultRules: bakedRules,
    routes,
  };
}

export function getBoard(id: string): BoardDefinition | null {
  const row = stmtGetBoard.get(id) as { board_json: string } | undefined;
  return row ? normalizeBoardScale(JSON.parse(row.board_json)) : null;
}

export function listBoards(): BoardDefinition[] {
  const rows = stmtListBoards.all() as Array<{ board_json: string }>;
  return rows.map((r) => normalizeBoardScale(JSON.parse(r.board_json)));
}

export function deleteBoard(id: string): boolean {
  const info = stmtDeleteBoard.run(id);
  stmtDeletePresetsForBoard.run(id);
  stmtDeleteGenRunForBoard.run(id);
  stmtDeleteWorkspace.run(id);
  return info.changes > 0;
}

export function saveStudioWorkspace(boardId: string, workspace: StudioMapWorkspace): void {
  stmtSaveWorkspace.run(boardId, JSON.stringify(workspace), new Date().toISOString());
}

export function getStudioWorkspace(boardId: string): StudioMapWorkspace | null {
  const row = stmtGetWorkspace.get(boardId) as { workspace_json: string } | undefined;
  return row ? (JSON.parse(row.workspace_json) as StudioMapWorkspace) : null;
}

export function listAllStudioWorkspaces(): StudioMapWorkspace[] {
  const rows = stmtListWorkspaces.all() as Array<{ workspace_json: string }>;
  return rows.map((r) => JSON.parse(r.workspace_json) as StudioMapWorkspace);
}

export function deleteStudioWorkspace(boardId: string): boolean {
  const info = stmtDeleteWorkspace.run(boardId);
  return info.changes > 0;
}

export function saveSessionSnapshot(roomCode: string, state: unknown): void {
  stmtSaveSession.run(roomCode, JSON.stringify(state), new Date().toISOString());
}

export function getSessionSnapshot<T>(roomCode: string): T | null {
  const row = stmtGetSession.get(roomCode) as { state_json: string } | undefined;
  return row ? (JSON.parse(row.state_json) as T) : null;
}

export function listSessionSnapshots<T>(): T[] {
  const rows = stmtListSessions.all() as Array<{ state_json: string }>;
  return rows.map((r) => JSON.parse(r.state_json) as T);
}

export function saveGenerationStages(boardId: string, stages: GenerationStageArtifact[]): void {
  stmtSaveGenRun.run(boardId, JSON.stringify(stages), new Date().toISOString());
}

export function getGenerationStages(boardId: string): GenerationStageArtifact[] | null {
  const row = stmtGetGenRun.get(boardId) as { stages_json: string } | undefined;
  return row ? (JSON.parse(row.stages_json) as GenerationStageArtifact[]) : null;
}

export function listBoardRulePresets(boardId: string): BoardRulePreset[] {
  const board = getBoard(boardId);
  const rows = stmtListBoardPresets.all(boardId) as Array<{
    id: string;
    board_id: string;
    name: string;
    rules_json: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    rules: normalizeGameRules(JSON.parse(r.rules_json), board),
    createdAt: r.created_at,
  }));
}

export function saveBoardRulePreset(
  boardId: string,
  name: string,
  rules: Partial<GameRules>
): BoardRulePreset {
  const board = getBoard(boardId);
  const cleanName = String(name || '').trim().slice(0, 48) || 'Custom Preset';
  const normalized = normalizeGameRules(rules, board);
  const preset: BoardRulePreset = {
    id: `preset-${crypto.randomBytes(4).toString('hex')}`,
    boardId,
    name: cleanName,
    rules: normalized,
    createdAt: new Date().toISOString(),
  };
  stmtInsertBoardPreset.run(
    preset.id,
    preset.boardId,
    preset.name,
    JSON.stringify(preset.rules),
    preset.createdAt
  );
  return preset;
}

export function deleteBoardRulePreset(boardId: string, presetId: string): boolean {
  const info = stmtDeleteBoardPreset.run(presetId, boardId);
  return info.changes > 0;
}

// Seed starter showcase boards if library is empty so Play Lobby works immediately
export function seedStarterBoardsIfEmpty(): void {
  const count = (stmtCountBoards.get() as { cnt: number }).cnt;
  if (count > 0) return;

  const now = new Date().toISOString();
  const pugetLocations = [
    { id: 'loc-sea', name: 'Seattle Union', lat: 47.6062, lng: -122.3321, x: 540, y: 375, popularityScore: 98, category: 'station' as const, isMajorHub: true, source: 'osm' as const },
    { id: 'loc-bel', name: 'Bellevue Transit', lat: 47.6101, lng: -122.2015, x: 690, y: 365, popularityScore: 86, category: 'city' as const, isMajorHub: true, source: 'osm' as const },
    { id: 'loc-bai', name: 'Bainbridge Ferry', lat: 47.6223, lng: -122.5105, x: 350, y: 340, popularityScore: 82, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-bre', name: 'Bremerton Pier', lat: 47.5653, lng: -122.625, x: 245, y: 445, popularityScore: 79, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-eve', name: 'Everett Station', lat: 47.979, lng: -122.2021, x: 675, y: 115, popularityScore: 84, category: 'station' as const, isMajorHub: true, source: 'osm' as const },
    { id: 'loc-edm', name: 'Edmonds Landing', lat: 47.8107, lng: -122.3774, x: 490, y: 215, popularityScore: 76, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-kin', name: 'Kingston Terminal', lat: 47.7982, lng: -122.4956, x: 345, y: 215, popularityScore: 72, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-tac', name: 'Tacoma Dome', lat: 47.2392, lng: -122.427, x: 455, y: 585, popularityScore: 90, category: 'station' as const, isMajorHub: true, source: 'osm' as const },
    { id: 'loc-red', name: 'Redmond Tech Hub', lat: 47.674, lng: -122.1215, x: 785, y: 295, popularityScore: 80, category: 'district' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-iss', name: 'Issaquah Alps', lat: 47.5301, lng: -122.0326, x: 865, y: 445, popularityScore: 74, category: 'landmark' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-sea-air', name: 'SeaTac Airport', lat: 47.4502, lng: -122.3088, x: 565, y: 495, popularityScore: 92, category: 'station' as const, isMajorHub: true, source: 'osm' as const },
    { id: 'loc-muk', name: 'Mukilteo Wharf', lat: 47.9445, lng: -122.3046, x: 555, y: 135, popularityScore: 71, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-cli', name: 'Clinton Whidbey', lat: 47.975, lng: -122.35, x: 465, y: 105, popularityScore: 70, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-pou', name: 'Poulsbo Harbor', lat: 47.7359, lng: -122.6465, x: 225, y: 265, popularityScore: 73, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-gig', name: 'Gig Harbor', lat: 47.3293, lng: -122.5801, x: 295, y: 545, popularityScore: 75, category: 'port' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-bal', name: 'Ballard Locks', lat: 47.6655, lng: -122.3971, x: 470, y: 300, popularityScore: 81, category: 'landmark' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-uw', name: 'University District', lat: 47.6588, lng: -122.313, x: 585, y: 300, popularityScore: 85, category: 'district' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-ren', name: 'Renton Landing', lat: 47.4829, lng: -122.2171, x: 695, y: 485, popularityScore: 77, category: 'city' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-aub', name: 'Auburn Junction', lat: 47.3073, lng: -122.2285, x: 685, y: 590, popularityScore: 74, category: 'station' as const, isMajorHub: false, source: 'osm' as const },
    { id: 'loc-bot', name: 'Bothell River', lat: 47.7601, lng: -122.2054, x: 705, y: 215, popularityScore: 72, category: 'city' as const, isMajorHub: false, source: 'osm' as const },
  ];

  const pugetRoutes = [
    { id: 'r1', fromId: 'loc-sea', toId: 'loc-bai', length: 3, color: 'blue' as const, isDouble: false, curveOffset: -18, transportMode: 'ferry' as const, transitWeight: 92, isTunnel: false, ferryLocomotives: 1, hazardRating: 2, hazardType: 'shipping_lane' as const, hazardPoint: { x: 445, y: 348 }, realLineName: 'WSF Seattle–Bainbridge' },
    { id: 'r2', fromId: 'loc-sea', toId: 'loc-bre', length: 5, color: 'gray' as const, isDouble: false, curveOffset: 24, transportMode: 'ferry' as const, transitWeight: 85, isTunnel: false, ferryLocomotives: 2, hazardRating: 3, hazardType: 'shipping_lane' as const, hazardPoint: { x: 392, y: 422 }, realLineName: 'Bremerton Fast Ferry' },
    { id: 'r3', fromId: 'loc-sea', toId: 'loc-bel', length: 2, color: 'orange' as const, doubleColor: 'green' as const, isDouble: true, curveOffset: 0, transportMode: 'train' as const, transitWeight: 95, isTunnel: true, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'East Link Light Rail' },
    { id: 'r4', fromId: 'loc-sea', toId: 'loc-uw', length: 2, color: 'red' as const, doubleColor: 'blue' as const, isDouble: true, curveOffset: 0, transportMode: 'train' as const, transitWeight: 98, isTunnel: true, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: '1 Line Subway Tunnel' },
    { id: 'r5', fromId: 'loc-sea', toId: 'loc-bal', length: 2, color: 'yellow' as const, isDouble: false, curveOffset: -14, transportMode: 'bus' as const, transitWeight: 88, isTunnel: false, ferryLocomotives: 0, hazardRating: 2, hazardType: 'bus_crossing' as const, hazardPoint: { x: 505, y: 335 }, realLineName: 'RapidRide D Line' },
    { id: 'r6', fromId: 'loc-bal', toId: 'loc-uw', length: 2, color: 'purple' as const, isDouble: false, curveOffset: 10, transportMode: 'bus' as const, transitWeight: 82, isTunnel: false, ferryLocomotives: 0, hazardRating: 1, hazardType: 'bus_crossing' as const, hazardPoint: { x: 528, y: 300 }, realLineName: 'Route 44 Crosstown' },
    { id: 'r7', fromId: 'loc-sea', toId: 'loc-sea-air', length: 3, color: 'black' as const, doubleColor: 'white' as const, isDouble: true, curveOffset: 0, transportMode: 'train' as const, transitWeight: 96, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'Link 1 Line South' },
    { id: 'r8', fromId: 'loc-sea-air', toId: 'loc-tac', length: 3, color: 'green' as const, isDouble: false, curveOffset: 14, transportMode: 'train' as const, transitWeight: 90, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'Sounder South' },
    { id: 'r9', fromId: 'loc-sea-air', toId: 'loc-ren', length: 2, color: 'orange' as const, isDouble: false, curveOffset: -12, transportMode: 'bus' as const, transitWeight: 78, isTunnel: false, ferryLocomotives: 0, hazardRating: 3, hazardType: 'bus_crossing' as const, hazardPoint: { x: 630, y: 490 }, realLineName: 'Stride S1 BRT' },
    { id: 'r10', fromId: 'loc-ren', toId: 'loc-aub', length: 2, color: 'yellow' as const, isDouble: false, curveOffset: 0, transportMode: 'train' as const, transitWeight: 88, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'Sounder Valley Line' },
    { id: 'r11', fromId: 'loc-aub', toId: 'loc-tac', length: 4, color: 'red' as const, isDouble: false, curveOffset: 14, transportMode: 'highway' as const, transitWeight: 74, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'SR-18 Corridor' },
    { id: 'r12', fromId: 'loc-bel', toId: 'loc-red', length: 2, color: 'blue' as const, isDouble: false, curveOffset: 0, transportMode: 'train' as const, transitWeight: 92, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: '2 Line Eastside' },
    { id: 'r13', fromId: 'loc-bel', toId: 'loc-iss', length: 3, color: 'green' as const, isDouble: false, curveOffset: 16, transportMode: 'bus' as const, transitWeight: 76, isTunnel: false, ferryLocomotives: 0, hazardRating: 2, hazardType: 'bus_crossing' as const, hazardPoint: { x: 777, y: 405 }, realLineName: 'I-90 Express 554' },
    { id: 'r14', fromId: 'loc-ren', toId: 'loc-bel', length: 3, color: 'purple' as const, isDouble: false, curveOffset: -15, transportMode: 'bus' as const, transitWeight: 80, isTunnel: false, ferryLocomotives: 0, hazardRating: 3, hazardType: 'bus_crossing' as const, hazardPoint: { x: 692, y: 425 }, realLineName: 'I-405 Stride BRT' },
    { id: 'r15', fromId: 'loc-uw', toId: 'loc-bot', length: 3, color: 'white' as const, isDouble: false, curveOffset: -12, transportMode: 'bus' as const, transitWeight: 82, isTunnel: false, ferryLocomotives: 0, hazardRating: 1, hazardType: 'bus_crossing' as const, hazardPoint: { x: 645, y: 257 }, realLineName: 'SR-522 Bus Rapid' },
    { id: 'r16', fromId: 'loc-bot', toId: 'loc-red', length: 2, color: 'black' as const, isDouble: false, curveOffset: 12, transportMode: 'bus' as const, transitWeight: 72, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r17', fromId: 'loc-bot', toId: 'loc-eve', length: 2, color: 'orange' as const, isDouble: false, curveOffset: 0, transportMode: 'highway' as const, transitWeight: 85, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'I-5 Express' },
    { id: 'r18', fromId: 'loc-bal', toId: 'loc-edm', length: 2, color: 'red' as const, isDouble: false, curveOffset: -16, transportMode: 'train' as const, transitWeight: 90, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'Sounder North Coast' },
    { id: 'r19', fromId: 'loc-edm', toId: 'loc-muk', length: 2, color: 'yellow' as const, isDouble: false, curveOffset: -12, transportMode: 'train' as const, transitWeight: 88, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r20', fromId: 'loc-muk', toId: 'loc-eve', length: 2, color: 'blue' as const, isDouble: false, curveOffset: 0, transportMode: 'bus' as const, transitWeight: 79, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r21', fromId: 'loc-edm', toId: 'loc-kin', length: 3, color: 'gray' as const, isDouble: false, curveOffset: 14, transportMode: 'ferry' as const, transitWeight: 91, isTunnel: false, ferryLocomotives: 1, hazardRating: 2, hazardType: 'shipping_lane' as const, hazardPoint: { x: 418, y: 215 }, realLineName: 'Edmonds–Kingston Ferry' },
    { id: 'r22', fromId: 'loc-muk', toId: 'loc-cli', length: 2, color: 'gray' as const, isDouble: false, curveOffset: -10, transportMode: 'ferry' as const, transitWeight: 90, isTunnel: false, ferryLocomotives: 1, hazardRating: 1, hazardType: 'shipping_lane' as const, hazardPoint: { x: 510, y: 120 }, realLineName: 'Mukilteo–Clinton Ferry' },
    { id: 'r23', fromId: 'loc-kin', toId: 'loc-pou', length: 3, color: 'green' as const, isDouble: false, curveOffset: 10, transportMode: 'bus' as const, transitWeight: 70, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r24', fromId: 'loc-pou', toId: 'loc-bai', length: 3, color: 'white' as const, isDouble: false, curveOffset: -14, transportMode: 'bus' as const, transitWeight: 74, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r25', fromId: 'loc-pou', toId: 'loc-bre', length: 4, color: 'purple' as const, isDouble: false, curveOffset: -18, transportMode: 'highway' as const, transitWeight: 78, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r26', fromId: 'loc-bre', toId: 'loc-gig', length: 3, color: 'orange' as const, isDouble: false, curveOffset: 12, transportMode: 'highway' as const, transitWeight: 75, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r27', fromId: 'loc-gig', toId: 'loc-tac', length: 3, color: 'gray' as const, isDouble: false, curveOffset: 16, transportMode: 'highway' as const, transitWeight: 91, isTunnel: true, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const, realLineName: 'Tacoma Narrows Crossing' },
    { id: 'r28', fromId: 'loc-iss', toId: 'loc-ren', length: 3, color: 'black' as const, isDouble: false, curveOffset: 16, transportMode: 'highway' as const, transitWeight: 69, isTunnel: false, ferryLocomotives: 0, hazardRating: 0, hazardType: 'none' as const },
    { id: 'r29', fromId: 'loc-cli', toId: 'loc-kin', length: 3, color: 'gray' as const, isDouble: false, curveOffset: -18, transportMode: 'ferry' as const, transitWeight: 65, isTunnel: false, ferryLocomotives: 1, hazardRating: 3, hazardType: 'shipping_lane' as const, hazardPoint: { x: 405, y: 160 }, realLineName: 'Admiralty Inlet Shipping Lane' },
  ];

  const pugetTickets = [
    { id: 't1', fromId: 'loc-eve', toId: 'loc-tac', fromName: 'Everett Station', toName: 'Tacoma Dome', points: 11 },
    { id: 't2', fromId: 'loc-cli', toId: 'loc-bre', fromName: 'Clinton Whidbey', toName: 'Bremerton Pier', points: 12 },
    { id: 't3', fromId: 'loc-red', toId: 'loc-gig', fromName: 'Redmond Tech Hub', toName: 'Gig Harbor', points: 14 },
    { id: 't4', fromId: 'loc-iss', toId: 'loc-pou', fromName: 'Issaquah Alps', toName: 'Poulsbo Harbor', points: 13 },
    { id: 't5', fromId: 'loc-sea', toId: 'loc-tac', fromName: 'Seattle Union', toName: 'Tacoma Dome', points: 6 },
    { id: 't6', fromId: 'loc-bai', toId: 'loc-bel', fromName: 'Bainbridge Ferry', toName: 'Bellevue Transit', points: 5 },
    { id: 't7', fromId: 'loc-bal', toId: 'loc-aub', fromName: 'Ballard Locks', toName: 'Auburn Junction', points: 9 },
    { id: 't8', fromId: 'loc-edm', toId: 'loc-sea-air', fromName: 'Edmonds Landing', toName: 'SeaTac Airport', points: 7 },
    { id: 't9', fromId: 'loc-kin', toId: 'loc-iss', fromName: 'Kingston Terminal', toName: 'Issaquah Alps', points: 12 },
    { id: 't10', fromId: 'loc-muk', toId: 'loc-ren', fromName: 'Mukilteo Wharf', toName: 'Renton Landing', points: 9 },
    { id: 't11', fromId: 'loc-bre', toId: 'loc-aub', fromName: 'Bremerton Pier', toName: 'Auburn Junction', points: 10 },
    { id: 't12', fromId: 'loc-uw', toId: 'loc-gig', fromName: 'University District', toName: 'Gig Harbor', points: 11 },
  ];

  const pugetBbox = { south: 47.2, west: -122.72, north: 48.02, east: -121.95 };
  const pugetMetersPerTrain = computeIdealMetersPerTrain(pugetBbox);
  const pugetLocById = new Map(pugetLocations.map((l) => [l.id, l]));
  const calibratedPugetRoutes = pugetRoutes.map((r) => {
    const a = pugetLocById.get(r.fromId)!;
    const b = pugetLocById.get(r.toId)!;
    const pathType = Math.abs(r.curveOffset) >= 1 ? ('bezier' as const) : ('line' as const);
    const arcM = computeRouteGeoArcMeters(a, b, pathType, undefined, r.curveOffset);
    return {
      ...r,
      pathType,
      length: computeChainTrainCount(arcM, pugetMetersPerTrain, pathType, 0),
    };
  });

  saveBoard({
    id: 'starter-puget-sound',
    name: 'Puget Sound Rails, Ferries & Rapid Bus',
    regionLabel: 'Seattle & Puget Sound Basin',
    theme: 'vintage',
    bbox: pugetBbox,
    zoom: 10,
    scaleMode: 'metro',
    metersPerTrain: pugetMetersPerTrain,
    scaleSpanKm: Math.round((computeBoxWidthMeters(pugetBbox) / 1000) * 10) / 10,
    maxPlayers: 5,
    generationParams: {
      ...DEFAULT_GENERATION_PARAMS,
      targetLocations: 20,
      splitPiecesMode: true,
    },
    defaultRules: normalizeGameRules(
      {
        splitPiecesEnabled: true,
        stationCount: 3,
        doubleRouteMinPlayers: 4,
        piecesMode: 'fixed',
        piecesPerPlayer: 45,
        deckBasisEdition: 'USA',
        deckSize: 110,
      },
      {
        generationParams: {
          ...DEFAULT_GENERATION_PARAMS,
          targetLocations: 20,
          splitPiecesMode: true,
        },
        locations: pugetLocations,
        routes: calibratedPugetRoutes,
      }
    ),
    locations: pugetLocations,
    routes: calibratedPugetRoutes,
    tickets: pugetTickets,
    createdAt: now,
    updatedAt: now,
  });
}
