import type {
  BoardDefinition,
  BoundingBox,
  GenerationPipelineState,
  GenerationStageArtifact,
  MapGenerationCheckpoint,
  StudioMapWorkspace,
} from '../shared/types';
import { DEFAULT_GENERATION_PARAMS, normalizeGameRules } from '../shared/benchmarks';
import { computeBoxWidthMeters, computeIdealMetersPerTrain } from '../shared/geoScale';
import {
  createInitialPipelineState,
  hydratePipelineFromBoard,
  hydratePipelineFromCheckpoint,
} from '../shared/pipelineEngine';

const DB_NAME = 'vtt_studio_storage';
const DB_VERSION = 1;
const STORE_NAME = 'workspaces';
const ACTIVE_KEY = '__active_studio_workspace__';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    try {
      const raw = localStorage.getItem(`vtt_ws_${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    try {
      localStorage.setItem(`vtt_ws_${key}`, JSON.stringify(value));
    } catch {
      // quota exceeded fallback ignored
    }
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    try {
      localStorage.removeItem(`vtt_ws_${key}`);
    } catch {
      // ignore
    }
  }
}

async function idbListAllValues<T>(): Promise<Array<{ key: string; value: T }>> {
  try {
    const db = await openDb();
    return await new Promise<Array<{ key: string; value: T }>>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const items: Array<{ key: string; value: T }> = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        items.push({ key: String(cursor.key), value: cursor.value as T });
        cursor.continue();
      };
      req.onerror = () => resolve(items);
    });
  } catch {
    const items: Array<{ key: string; value: T }> = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('vtt_ws_')) {
          const raw = localStorage.getItem(k);
          if (raw) {
            items.push({ key: k.slice('vtt_ws_'.length), value: JSON.parse(raw) as T });
          }
        }
      }
    } catch {
      // ignore
    }
    return items;
  }
}

export function normalizeWorkspacePipelines(ws: StudioMapWorkspace): StudioMapWorkspace {
  const generations = ws.generations.map((g) => ({
    ...g,
    pipeline: hydratePipelineFromCheckpoint(g),
  }));
  const draftPipeline: GenerationPipelineState =
    ws.draftPipeline || createInitialPipelineState(ws.draftBoard.bbox, ws.draftBoard);
  return {
    ...ws,
    generations,
    draftPipeline,
  };
}

export async function saveClientWorkspace(
  workspace: StudioMapWorkspace,
  markAsActive = true
): Promise<void> {
  await idbSet(`board:${workspace.id}`, workspace);
  if (markAsActive) {
    await idbSet(ACTIVE_KEY, workspace);
  }
}

export async function loadActiveClientWorkspace(): Promise<StudioMapWorkspace | null> {
  const ws = await idbGet<StudioMapWorkspace>(ACTIVE_KEY);
  return ws ? normalizeWorkspacePipelines(ws) : null;
}

export async function loadClientWorkspaceById(
  boardId: string
): Promise<StudioMapWorkspace | null> {
  const ws = await idbGet<StudioMapWorkspace>(`board:${boardId}`);
  return ws ? normalizeWorkspacePipelines(ws) : null;
}

export async function listClientWorkspaces(): Promise<StudioMapWorkspace[]> {
  const entries = await idbListAllValues<StudioMapWorkspace>();
  const map = new Map<string, StudioMapWorkspace>();
  for (const e of entries) {
    if (!e.key.startsWith('board:')) continue;
    if (!e.value || !e.value.id) continue;
    map.set(e.value.id, normalizeWorkspacePipelines(e.value));
  }
  return Array.from(map.values()).sort(
    (a, b) => Date.parse(b.lastLocalSaveAt || '0') - Date.parse(a.lastLocalSaveAt || '0')
  );
}

export async function deleteClientWorkspace(boardId: string): Promise<void> {
  await idbDelete(`board:${boardId}`);
  const active = await idbGet<StudioMapWorkspace>(ACTIVE_KEY);
  if (active?.id === boardId) {
    await idbDelete(ACTIVE_KEY);
  }
}

export function createBlankUntitledBoard(seedBbox?: BoundingBox): BoardDefinition {
  const bbox: BoundingBox = seedBbox || {
    south: 47.2,
    west: -122.72,
    north: 48.02,
    east: -121.95,
  };
  const metersPerTrain = computeIdealMetersPerTrain(bbox);
  const now = new Date().toISOString();
  const id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const genParams = { ...DEFAULT_GENERATION_PARAMS };
  return {
    id,
    name: 'Untitled Project',
    regionLabel: 'Custom Region',
    theme: 'vintage',
    bbox,
    zoom: 10,
    scaleMode: 'metro',
    metersPerTrain,
    scaleSpanKm: Math.round((computeBoxWidthMeters(bbox) / 1000) * 10) / 10,
    maxPlayers: 5,
    generationParams: genParams,
    defaultRules: normalizeGameRules(undefined, {
      generationParams: genParams,
      locations: [],
      routes: [],
    }),
    locations: [],
    routes: [],
    tickets: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createUntitledWorkspace(seedBbox?: BoundingBox, name?: string): StudioMapWorkspace {
  const board = createBlankUntitledBoard(seedBbox);
  if (name && name.trim()) {
    board.name = name.trim();
  }
  const pipeline = createInitialPipelineState(board.bbox, board);
  const genId = `gen-${Date.now().toString(36)}`;
  const firstGen: MapGenerationCheckpoint = {
    id: genId,
    index: 1,
    label: 'Gen #1 · Area',
    createdAt: board.createdAt,
    baseBoard: board,
    stages: [],
    currentBoard: board,
    pipeline,
    undoStack: [],
    redoStack: [],
  };
  return {
    id: board.id,
    name: board.name,
    isSavedToLibrary: false,
    lastServerSyncAt: null,
    lastLocalSaveAt: new Date().toISOString(),
    activeGenerationId: genId,
    generations: [firstGen],
    draftBoard: board,
    draftPipeline: pipeline,
    draftUndoStack: [],
    draftRedoStack: [],
  };
}

export function createWorkspaceFromSavedBoard(
  board: BoardDefinition,
  stages: GenerationStageArtifact[] = []
): StudioMapWorkspace {
  const now = new Date().toISOString();
  const genId = `gen-${Date.now().toString(36)}`;
  const pipeline = hydratePipelineFromBoard(board);
  const rawGen: MapGenerationCheckpoint = {
    id: genId,
    index: 1,
    label: `Gen #1 · ${Math.round(board.metersPerTrain)} m/tr`,
    createdAt: board.updatedAt || now,
    baseBoard: board,
    stages,
    currentBoard: board,
    undoStack: [],
    redoStack: [],
  };
  const hydratedPipeline = stages.length > 0 ? hydratePipelineFromCheckpoint(rawGen) : pipeline;
  const initialGen: MapGenerationCheckpoint = {
    ...rawGen,
    pipeline: hydratedPipeline,
  };

  return {
    id: board.id,
    name: board.name,
    isSavedToLibrary: true,
    lastServerSyncAt: board.updatedAt || now,
    lastLocalSaveAt: now,
    activeGenerationId: initialGen.id,
    generations: [initialGen],
    draftBoard: board,
    draftPipeline: hydratedPipeline,
    draftUndoStack: [],
    draftRedoStack: [],
  };
}

export function isOutsidePreviousGenerationArea(
  prevBox: BoundingBox,
  nextBox: BoundingBox
): boolean {
  const interSouth = Math.max(prevBox.south, nextBox.south);
  const interNorth = Math.min(prevBox.north, nextBox.north);
  const interWest = Math.max(prevBox.west, nextBox.west);
  const interEast = Math.min(prevBox.east, nextBox.east);

  if (interNorth <= interSouth || interEast <= interWest) {
    return true;
  }

  const interArea = (interNorth - interSouth) * (interEast - interWest);
  const prevArea = Math.max(1e-9, (prevBox.north - prevBox.south) * (prevBox.east - prevBox.west));
  const nextArea = Math.max(1e-9, (nextBox.north - nextBox.south) * (nextBox.east - nextBox.west));
  const overlapRatio = interArea / Math.min(prevArea, nextArea);
  return overlapRatio < 0.05;
}
