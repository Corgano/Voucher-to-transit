import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Crosshair,
  Loader2,
  Maximize2,
  Redo2,
  Save,
  Search,
  SquareDashedMousePointer,
  Undo2,
} from 'lucide-react';
import type {
  BoardDefinition,
  BoardEditEntry,
  BoardLocation,
  BoardRoute,
  BoardTheme,
  BoundingBox,
  CachedRegionSummary,
  DestinationTicket,
  GameRules,
  GenerationPipelineState,
  InfrastructureOverlayVisibility,
  MapGenerationCheckpoint,
  PipelineCorridorCandidate,
  PipelineLocationCandidate,
  PipelineStepId,
  RawRegionDataset,
  RawTransitCorridor,
  RoutePathType,
  RouteWaypoint,
  SpotLookupMatch,
  Step2LocationSettings,
  Step3CorridorSettings,
  Step4RouteSettings,
  Step5TicketSettings,
  StudioMapWorkspace,
  WaypointKind,
} from '../shared/types';
import {
  createInitialPipelineState,
  hydratePipelineFromBoard,
  hydratePipelineFromCheckpoint,
  projectPointToCanvas,
  propagateAfterStep2Edit,
  propagateAfterStep3Edit,
  propagateAfterStep4Edit,
  recalculateTicketPoints,
  runStep2Locations,
  runStep3Corridors,
  runStep4TrainRoutes,
  runStep5Tickets,
  syncBoardFromPipeline,
} from '../shared/pipelineEngine';
import {
  computeBoxWidthMeters,
  computeIdealMetersPerTrain,
  findBestWaypointInsertIndex,
  haversineMeters,
  projectPointOntoCorridorCurve,
  resolveEffectivePathType,
  resolveEffectiveWaypoints,
} from '../shared/geoScale';
import { normalizeGameRules } from '../shared/benchmarks';
import {
  createBlankUntitledBoard,
  createUntitledWorkspace,
  createWorkspaceFromSavedBoard,
  deleteClientWorkspace,
  isOutsidePreviousGenerationArea,
  listClientWorkspaces,
  saveClientWorkspace,
} from '../lib/studioStorage';
import {
  GeoBoardMap,
  type ManualStopLookupState,
  type StudioEditTool,
} from './GeoBoardMap';
import { ProjectsHome } from './studio/ProjectsHome';
import { ProjectOverview } from './studio/ProjectOverview';
import { StepSidebar } from './studio/StepSidebar';

/**
 * Module-scoped debug verbosity level for MapStudio:
 * 0 = errors only, 1 = major lifecycle, 2 = light debug, 3 = verbose, 4 = spam.
 */
const MAP_STUDIO_DEBUG_LEVEL = 0;

type StudioViewLevel = 'projects' | 'project' | 'generation';

const STEPS_META: Array<{ id: PipelineStepId; label: string }> = [
  { id: 'area', label: '1. Area' },
  { id: 'locations', label: '2. Locations' },
  { id: 'corridors', label: '3. Map Routes' },
  { id: 'routes', label: '4. Train Routes' },
  { id: 'tickets', label: '5. Tickets' },
];

interface MapStudioProps {
  initialWorkspace: StudioMapWorkspace;
  geminiAvailable: boolean;
  editorPort?: number | null;
  playPort?: number | null;
  onWorkspaceChange: (ws: StudioMapWorkspace) => void;
  onBoardSaved: (board: BoardDefinition) => void;
  onHostBoard: (boardId: string) => void;
}

export const MapStudio: React.FC<MapStudioProps> = ({
  initialWorkspace,
  geminiAvailable,
  onWorkspaceChange,
  onBoardSaved,
  onHostBoard,
}) => {
  const [workspace, setWorkspace] = useState<StudioMapWorkspace>(() => initialWorkspace);
  const [viewLevel, setViewLevel] = useState<StudioViewLevel>('generation');
  const [allWorkspaces, setAllWorkspaces] = useState<StudioMapWorkspace[]>([]);
  const [libraryBoards, setLibraryBoards] = useState<BoardDefinition[]>([]);
  const [cachedRegions, setCachedRegions] = useState<CachedRegionSummary[]>([]);

  // Area search & map UI state
  const [searchQuery, setSearchQuery] = useState('');
  const [geocodeResults, setGeocodeResults] = useState<
    Array<{ displayName: string; bbox: BoundingBox; lat: number; lng: number }>
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [fitTrigger, setFitTrigger] = useState(0);

  // Interactive selection & map tools
  const [editTool, setEditTool] = useState<StudioEditTool>('select');
  const [newWaypointKind, setNewWaypointKind] = useState<WaypointKind>('curve');
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [movingLocationId, setMovingLocationId] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [selectedCorridorId, setSelectedCorridorId] = useState<string | null>(null);
  const [selectedCorridorWaypointIdx, setSelectedCorridorWaypointIdx] = useState<number | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedWaypointIdx, setSelectedWaypointIdx] = useState<number | null>(null);
  const [selectedHazardRouteId, setSelectedHazardRouteId] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [showRejectedCorridors, setShowRejectedCorridors] = useState(true);
  const [infraVisibility, setInfraVisibility] = useState<InfrastructureOverlayVisibility>({
    train: false,
    ferry: false,
    bus: false,
    highway: false,
  });
  const [dirtyStopIds, setDirtyStopIds] = useState<string[]>([]);
  const [manualStopLookup, setManualStopLookup] = useState<ManualStopLookupState | null>(null);
  const [pendingDeleteStop, setPendingDeleteStop] = useState<{
    stopId: string;
    stopName: string;
    corridorCount: number;
    routeCount: number;
    ticketCount: number;
  } | null>(null);

  // Guard prompt when scanning completely outside current generation area on unsaved workspace
  const [outsideAreaPrompt, setOutsideAreaPrompt] = useState<{
    pendingBbox: BoundingBox;
    pendingZoom: number;
    regionLabel: string;
  } | null>(null);

  const dragUndoCapturedRef = useRef(false);
  const serverSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync when App loads a different workspace from BoardLibrary
  useEffect(() => {
    setWorkspace((prev) => {
      if (prev.id === initialWorkspace.id) return prev;
      return initialWorkspace;
    });
    setSelectedLocationId(null);
    setMovingLocationId(null);
    setLinkSourceId(null);
    setSelectedCorridorId(null);
    setSelectedCorridorWaypointIdx(null);
    setSelectedRouteId(null);
    setSelectedWaypointIdx(null);
    setSelectedTicketId(null);
    setManualStopLookup(null);
    setDirtyStopIds([]);
    setEditTool('select');
    setFitTrigger((n) => n + 1);
  }, [initialWorkspace.id]);

  // Ensure every generation has a hydrated pipeline
  const activeGen = useMemo<MapGenerationCheckpoint | null>(() => {
    const found =
      workspace.generations.find((g) => g.id === workspace.activeGenerationId) ||
      workspace.generations[workspace.generations.length - 1] ||
      null;
    if (!found) return null;
    if (!found.pipeline) {
      return { ...found, pipeline: hydratePipelineFromCheckpoint(found) };
    }
    return found;
  }, [workspace]);

  const board = activeGen?.currentBoard || workspace.draftBoard;
  const pipeline = useMemo<GenerationPipelineState>(() => {
    if (activeGen?.pipeline) return activeGen.pipeline;
    if (workspace.draftPipeline) return workspace.draftPipeline;
    return createInitialPipelineState(board.bbox, board);
  }, [activeGen, workspace.draftPipeline, board]);

  const activeStep: PipelineStepId = pipeline.activeStep;

  // Refresh workspaces & cached regions directory
  const refreshDirectories = useCallback(async () => {
    const [localList, serverWsRes, boardsRes, cacheRes] = await Promise.all([
      listClientWorkspaces().catch(() => []),
      fetch('/api/workspaces').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/boards').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/cache').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    const merged = new Map<string, StudioMapWorkspace>();
    for (const w of localList) merged.set(w.id, w);
    if (Array.isArray(serverWsRes?.workspaces)) {
      for (const sw of serverWsRes.workspaces as StudioMapWorkspace[]) {
        const existing = merged.get(sw.id);
        if (
          !existing ||
          Date.parse(sw.lastLocalSaveAt || '0') > Date.parse(existing.lastLocalSaveAt || '0')
        ) {
          merged.set(sw.id, sw);
        }
      }
    }
    setAllWorkspaces(
      Array.from(merged.values()).sort(
        (a, b) => Date.parse(b.lastLocalSaveAt || '0') - Date.parse(a.lastLocalSaveAt || '0')
      )
    );
    if (Array.isArray(boardsRes?.boards)) setLibraryBoards(boardsRes.boards);
    if (Array.isArray(cacheRes?.regions)) setCachedRegions(cacheRes.regions);
  }, []);

  useEffect(() => {
    void refreshDirectories();
  }, [refreshDirectories]);

  // Persist workspace locally & sync to SQLite when saved or active
  const commitWorkspace = useCallback(
    (next: StudioMapWorkspace) => {
      const stamped: StudioMapWorkspace = {
        ...next,
        lastLocalSaveAt: new Date().toISOString(),
      };
      setWorkspace(stamped);
      onWorkspaceChange(stamped);
      saveClientWorkspace(stamped, true).catch(() => {});

      if (serverSyncTimerRef.current) clearTimeout(serverSyncTimerRef.current);
      serverSyncTimerRef.current = setTimeout(() => {
        fetch(`/api/boards/${encodeURIComponent(stamped.id)}/workspace`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace: stamped }),
        }).catch(() => {});
      }, 900);
    },
    [onWorkspaceChange]
  );

  // Lazy-fetch raw dataset if board has cacheId but pipeline.area.dataset is empty
  useEffect(() => {
    const cid = pipeline.area.cacheId || board.cacheId;
    if (!cid || pipeline.area.dataset || !activeGen) return;
    let cancelled = false;
    fetch(`/api/cache/${encodeURIComponent(cid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.dataset) return;
        setWorkspace((cur) => {
          const idx = cur.generations.findIndex((g) => g.id === activeGen.id);
          if (idx < 0) return cur;
          const g = cur.generations[idx];
          const p = hydratePipelineFromCheckpoint(g, data.dataset);
          const nextGens = [...cur.generations];
          nextGens[idx] = { ...g, pipeline: p };
          return { ...cur, generations: nextGens };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeGen?.id, board.cacheId, pipeline.area.cacheId, Boolean(pipeline.area.dataset)]);

  // Update active generation + optional undo snapshot
  const updateActiveGeneration = useCallback(
    (
      updater: (
        gen: MapGenerationCheckpoint,
        curPipeline: GenerationPipelineState,
        curBoard: BoardDefinition
      ) => { pipeline: GenerationPipelineState; board: BoardDefinition; label?: string },
      recordUndoLabel?: string
    ) => {
      if (!activeGen) return;
      const curPipeline = activeGen.pipeline || hydratePipelineFromCheckpoint(activeGen);
      const curBoard = activeGen.currentBoard;
      const res = updater(activeGen, curPipeline, curBoard);

      let nextUndo = activeGen.undoStack;
      let nextRedo = activeGen.redoStack;
      if (recordUndoLabel) {
        const entry: BoardEditEntry = {
          id: `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
          label: recordUndoLabel,
          timestamp: new Date().toISOString(),
          board: curBoard,
          pipeline: curPipeline,
        };
        nextUndo = [...activeGen.undoStack.slice(-39), entry];
        nextRedo = [];
      }

      const nextGen: MapGenerationCheckpoint = {
        ...activeGen,
        label: res.label || activeGen.label,
        currentBoard: res.board,
        pipeline: res.pipeline,
        undoStack: nextUndo,
        redoStack: nextRedo,
      };

      const nextGens = workspace.generations.map((g) => (g.id === nextGen.id ? nextGen : g));
      commitWorkspace({
        ...workspace,
        generations: nextGens,
        draftBoard: res.board,
        draftPipeline: res.pipeline,
      });
    },
    [activeGen, workspace, commitWorkspace]
  );

  const handleUndo = useCallback(() => {
    if (!activeGen || activeGen.undoStack.length === 0) return;
    const prevEntry = activeGen.undoStack[activeGen.undoStack.length - 1];
    const currentRedoEntry: BoardEditEntry = {
      id: `redo-${Date.now().toString(36)}`,
      label: prevEntry.label,
      timestamp: new Date().toISOString(),
      board: activeGen.currentBoard,
      pipeline: activeGen.pipeline,
    };
    const restoredPipeline =
      prevEntry.pipeline || hydratePipelineFromBoard(prevEntry.board, pipeline.area.dataset);
    const nextGen: MapGenerationCheckpoint = {
      ...activeGen,
      currentBoard: prevEntry.board,
      pipeline: restoredPipeline,
      undoStack: activeGen.undoStack.slice(0, -1),
      redoStack: [...activeGen.redoStack, currentRedoEntry],
    };
    commitWorkspace({
      ...workspace,
      generations: workspace.generations.map((g) => (g.id === nextGen.id ? nextGen : g)),
      draftBoard: prevEntry.board,
      draftPipeline: restoredPipeline,
    });
    setStatusNote(`Undid: ${prevEntry.label}`);
  }, [activeGen, pipeline.area.dataset, workspace, commitWorkspace]);

  const handleRedo = useCallback(() => {
    if (!activeGen || activeGen.redoStack.length === 0) return;
    const redoEntry = activeGen.redoStack[activeGen.redoStack.length - 1];
    const currentUndoEntry: BoardEditEntry = {
      id: `undo-${Date.now().toString(36)}`,
      label: redoEntry.label,
      timestamp: new Date().toISOString(),
      board: activeGen.currentBoard,
      pipeline: activeGen.pipeline,
    };
    const restoredPipeline =
      redoEntry.pipeline || hydratePipelineFromBoard(redoEntry.board, pipeline.area.dataset);
    const nextGen: MapGenerationCheckpoint = {
      ...activeGen,
      currentBoard: redoEntry.board,
      pipeline: restoredPipeline,
      undoStack: [...activeGen.undoStack, currentUndoEntry],
      redoStack: activeGen.redoStack.slice(0, -1),
    };
    commitWorkspace({
      ...workspace,
      generations: workspace.generations.map((g) => (g.id === nextGen.id ? nextGen : g)),
      draftBoard: redoEntry.board,
      draftPipeline: restoredPipeline,
    });
    setStatusNote(`Redid: ${redoEntry.label}`);
  }, [activeGen, pipeline.area.dataset, workspace, commitWorkspace]);

  // Global keyboard shortcuts Ctrl+Z / Ctrl+Y in Studio generation view
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (viewLevel !== 'generation') return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewLevel, handleUndo, handleRedo]);

  /**
   * Fetches nearby real-world corridors for modified, added, or explicitly paired stops,
   * merges them into the cached dataset, and re-runs Step 3 corridor splitting.
   */
  const fetchCorridorsNearStopsAndSync = useCallback(
    async (
      targetStopIds: string[],
      switchToStep3 = false,
      explicitPairs?: Array<{ fromId: string; toId: string }>
    ) => {
      const allActiveStops = pipeline.locations.candidates
        .filter((c) => c.selected)
        .map((c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng }));
      const stopObjs =
        targetStopIds.length > 0
          ? allActiveStops.filter((c) => targetStopIds.includes(c.id))
          : explicitPairs && explicitPairs.length > 0
            ? []
            : allActiveStops;
      if (stopObjs.length === 0 && (!explicitPairs || explicitPairs.length === 0)) return;

      setIsBusy(true);
      try {
        const res = await fetch('/api/pipeline/corridors-near-stops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stops: stopObjs,
            allActiveStops,
            pairs: explicitPairs,
            bbox: pipeline.area.bbox,
            zoom: pipeline.area.zoom,
          }),
        });
        const data = await res.json();
        const extraCorridors: RawTransitCorridor[] = Array.isArray(data?.corridors)
          ? data.corridors
          : [];

        updateActiveGeneration((_g, curP, curB) => {
          const existingDs = curP.area.dataset || {
            bbox: curP.area.bbox,
            zoom: curP.area.zoom,
            scaleMode: curB.scaleMode,
            pois: [],
            corridors: [],
            hazards: [],
          };
          const seenIds = new Set(existingDs.corridors.map((c) => c.id));
          const mergedCorridors = [...existingDs.corridors];
          for (const rc of extraCorridors) {
            if (!seenIds.has(rc.id)) {
              seenIds.add(rc.id);
              mergedCorridors.push(rc);
            }
          }
          const updatedDs: RawRegionDataset = {
            ...existingDs,
            corridors: mergedCorridors,
          };
          const s3 = runStep3Corridors({
            allCandidates: curP.locations.candidates,
            dataset: updatedDs,
            bbox: curP.area.bbox,
            settings: curP.corridors.settings,
            metersPerTrain: curP.routes.settings.metersPerTrain,
            prevCorridors: curP.corridors.candidates,
            preserveManual: true,
          });
          const nextP: GenerationPipelineState = {
            ...curP,
            activeStep: switchToStep3 ? 'corridors' : curP.activeStep,
            area: { ...curP.area, dataset: updatedDs },
            corridors: {
              ...curP.corridors,
              candidates: s3.corridors,
              lastAutoRunAt: new Date().toISOString(),
            },
          };
          return propagateAfterStep3Edit(nextP, curB);
        });
        setDirtyStopIds([]);
        if (extraCorridors.length > 0) {
          setStatusNote(
            `Fetched ${extraCorridors.length} real transit links near stops.`
          );
        }
      } catch (err: any) {
        if (MAP_STUDIO_DEBUG_LEVEL >= 1) {
          console.warn('[MapStudio] fetchCorridorsNearStopsAndSync failed', err);
        }
      } finally {
        setIsBusy(false);
      }
    },
    [pipeline.area.bbox, pipeline.area.zoom, pipeline.locations.candidates, updateActiveGeneration]
  );

  // Navigate between Steps 1-5 cleanly, running incremental fetches / auto-pass if needed
  const goToStep = (targetStep: PipelineStepId) => {
    setEditTool('select');
    setMovingLocationId(null);
    setLinkSourceId(null);
    setSelectedLocationId(null);
    setSelectedCorridorId(null);
    setSelectedCorridorWaypointIdx(null);
    setSelectedRouteId(null);
    setSelectedWaypointIdx(null);
    setSelectedTicketId(null);
    setManualStopLookup(null);

    const dirtyCopy = [...dirtyStopIds];
    let untracedPairsOnEnter: Array<{ fromId: string; toId: string }> = [];
    const untracedStopSet = new Set<string>(dirtyCopy);

    updateActiveGeneration((_g, curP, curB) => {
      let nextP = { ...curP, activeStep: targetStep };
      let nextB = curB;

      if (targetStep === 'locations' && nextP.locations.candidates.length === 0 && nextP.area.dataset) {
        const res = runStep2Locations({
          dataset: nextP.area.dataset,
          bbox: nextP.area.bbox,
          settings: nextP.locations.settings,
          metersPerTrain: nextP.routes.settings.metersPerTrain,
        });
        nextP = {
          ...nextP,
          locations: {
            ...nextP.locations,
            candidates: res.candidates,
            lastAutoRunAt: new Date().toISOString(),
          },
        };
        nextB = syncBoardFromPipeline(nextB, nextP);
      } else if (targetStep === 'corridors' && (nextP.corridors.candidates.length === 0 || dirtyCopy.length > 0)) {
        if (nextP.locations.candidates.length === 0 && nextP.area.dataset) {
          const s2 = runStep2Locations({
            dataset: nextP.area.dataset,
            bbox: nextP.area.bbox,
            settings: nextP.locations.settings,
            metersPerTrain: nextP.routes.settings.metersPerTrain,
          });
          nextP = {
            ...nextP,
            locations: { ...nextP.locations, candidates: s2.candidates },
          };
        }
        const s3 = runStep3Corridors({
          allCandidates: nextP.locations.candidates,
          dataset: nextP.area.dataset,
          bbox: nextP.area.bbox,
          settings: nextP.corridors.settings,
          metersPerTrain: nextP.routes.settings.metersPerTrain,
          prevCorridors: nextP.corridors.candidates,
          preserveManual: true,
        });
        nextP = {
          ...nextP,
          corridors: {
            ...nextP.corridors,
            candidates: s3.corridors,
            lastAutoRunAt: new Date().toISOString(),
          },
        };
        nextB = syncBoardFromPipeline(nextB, nextP);
      } else if (targetStep === 'routes' && nextP.routes.items.length === 0) {
        if (nextP.corridors.candidates.length === 0 && nextP.locations.candidates.some((c) => c.selected)) {
          const s3 = runStep3Corridors({
            allCandidates: nextP.locations.candidates,
            dataset: nextP.area.dataset,
            bbox: nextP.area.bbox,
            settings: nextP.corridors.settings,
            metersPerTrain: nextP.routes.settings.metersPerTrain,
          });
          nextP = {
            ...nextP,
            corridors: { ...nextP.corridors, candidates: s3.corridors },
          };
        }
        const activeLocs = nextP.locations.candidates.filter((c) => c.selected);
        const s4 = runStep4TrainRoutes({
          activeLocations: activeLocs,
          corridors: nextP.corridors.candidates,
          bbox: nextP.area.bbox,
          settings: nextP.routes.settings,
        });
        nextP = {
          ...nextP,
          routes: {
            ...nextP.routes,
            settings: { ...nextP.routes.settings, metersPerTrain: s4.effectiveMetersPerTrain },
            items: s4.routes,
            lastAutoRunAt: new Date().toISOString(),
          },
        };
        nextB = syncBoardFromPipeline(nextB, nextP);
      } else if (targetStep === 'tickets' && nextP.tickets.items.length === 0) {
        const activeLocs = nextP.locations.candidates.filter((c) => c.selected);
        if (nextP.routes.items.length === 0 && nextP.corridors.candidates.some((c) => c.selected)) {
          const s4 = runStep4TrainRoutes({
            activeLocations: activeLocs,
            corridors: nextP.corridors.candidates,
            bbox: nextP.area.bbox,
            settings: nextP.routes.settings,
          });
          nextP = {
            ...nextP,
            routes: {
              ...nextP.routes,
              settings: { ...nextP.routes.settings, metersPerTrain: s4.effectiveMetersPerTrain },
              items: s4.routes,
            },
          };
        }
        if (nextP.routes.items.length > 0 && activeLocs.length >= 4) {
          const t = runStep5Tickets(activeLocs, nextP.routes.items, nextP.tickets.settings);
          nextP = {
            ...nextP,
            tickets: { ...nextP.tickets, items: t, lastAutoRunAt: new Date().toISOString() },
          };
          nextB = syncBoardFromPipeline(nextB, nextP);
        }
      }

      if (targetStep === 'corridors' && nextP.corridors.settings.traceRealCorridors) {
        untracedPairsOnEnter = nextP.corridors.candidates
          .filter((c) => c.selected && !c.tracedFromCorridor && (!c.waypoints || c.waypoints.length === 0))
          .map((c) => {
            untracedStopSet.add(c.fromId);
            untracedStopSet.add(c.toId);
            return { fromId: c.fromId, toId: c.toId };
          });
      }

      return { pipeline: nextP, board: nextB };
    });

    if (
      targetStep === 'corridors' &&
      (dirtyCopy.length > 0 || untracedPairsOnEnter.length > 0)
    ) {
      void fetchCorridorsNearStopsAndSync(
        Array.from(untracedStopSet),
        true,
        untracedPairsOnEnter.length > 0 ? untracedPairsOnEnter : undefined
      );
    }
  };

  // =========================================================================
  // STEP 1: SEARCH & AREA SCAN
  // =========================================================================
  const handleGeocodeSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setIsSearching(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Place lookup failed');
      setGeocodeResults(data.results || []);
      if (data.results?.[0]) {
        const first = data.results[0];
        updateActiveGeneration((_g, curP, curB) => {
          const nextMeters = computeIdealMetersPerTrain(first.bbox);
          const nextP: GenerationPipelineState = {
            ...curP,
            area: { ...curP.area, bbox: first.bbox, regionLabel: first.displayName.split(',')[0] },
            routes: {
              ...curP.routes,
              settings: { ...curP.routes.settings, metersPerTrain: nextMeters },
            },
          };
          const nextB: BoardDefinition = {
            ...curB,
            bbox: first.bbox,
            regionLabel: first.displayName.split(',')[0],
            metersPerTrain: nextMeters,
          };
          return { pipeline: nextP, board: nextB };
        });
        setFitTrigger((n) => n + 1);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Geocode search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const executeScanArea = async (
    targetBbox: BoundingBox,
    targetZoom: number,
    targetLabel: string,
    asNewProject = false,
    forceRescan = false
  ) => {
    setIsBusy(true);
    setErrorMsg(null);
    setOutsideAreaPrompt(null);
    try {
      const res = await fetch('/api/pipeline/scan-area', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bbox: targetBbox,
          zoom: targetZoom,
          regionLabel: targetLabel,
          forceRescan,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to scan region data');

      const dataset = data.dataset as RawRegionDataset;
      const summary = data.cacheSummary as CachedRegionSummary;
      const idealScale = computeIdealMetersPerTrain(targetBbox);

      let targetWs = workspace;
      if (asNewProject) {
        targetWs = createUntitledWorkspace(targetBbox, `${targetLabel} Transit`);
      }

      const targetGen =
        targetWs.generations.find((g) => g.id === targetWs.activeGenerationId) ||
        targetWs.generations[0];
      const baseP =
        targetGen?.pipeline || createInitialPipelineState(targetBbox, targetWs.draftBoard, dataset);

      const s2Settings = baseP.locations.settings;
      const s2Res = runStep2Locations({
        dataset,
        bbox: targetBbox,
        settings: s2Settings,
        metersPerTrain: idealScale,
      });

      const nextPipeline: GenerationPipelineState = {
        ...baseP,
        activeStep: 'locations',
        area: {
          bbox: targetBbox,
          zoom: dataset.zoom,
          regionLabel: targetLabel,
          cacheId: summary.id,
          scannedAt: new Date().toISOString(),
          dataset,
        },
        locations: {
          settings: s2Settings,
          candidates: s2Res.candidates,
          lastAutoRunAt: new Date().toISOString(),
        },
        corridors: {
          ...baseP.corridors,
          candidates: [],
        },
        routes: {
          ...baseP.routes,
          settings: { ...baseP.routes.settings, metersPerTrain: idealScale },
          items: [],
        },
        tickets: {
          ...baseP.tickets,
          items: [],
        },
      };

      const nextBoard = syncBoardFromPipeline(
        {
          ...(targetGen?.currentBoard || targetWs.draftBoard),
          name: targetWs.name === 'Untitled Project' ? `${targetLabel} Transit` : targetWs.name,
          regionLabel: targetLabel,
          cacheId: summary.id,
        },
        nextPipeline
      );

      const nextGen: MapGenerationCheckpoint = {
        ...(targetGen || {
          id: `gen-${Date.now().toString(36)}`,
          index: 1,
          label: `Gen #1 · ${targetLabel}`,
          createdAt: new Date().toISOString(),
          baseBoard: nextBoard,
          stages: [],
          currentBoard: nextBoard,
          undoStack: [],
          redoStack: [],
        }),
        label: `Gen #${targetGen?.index ?? 1} · ${targetLabel}`,
        baseBoard: nextBoard,
        currentBoard: nextBoard,
        pipeline: nextPipeline,
        undoStack: [],
        redoStack: [],
      };

      const nextWs: StudioMapWorkspace = {
        ...targetWs,
        name: targetWs.name === 'Untitled Project' ? `${targetLabel} Transit` : targetWs.name,
        activeGenerationId: nextGen.id,
        generations: targetWs.generations.some((g) => g.id === nextGen.id)
          ? targetWs.generations.map((g) => (g.id === nextGen.id ? nextGen : g))
          : [...targetWs.generations, nextGen],
        draftBoard: nextBoard,
        draftPipeline: nextPipeline,
      };

      commitWorkspace(nextWs);
      setEditTool('select');
      setStatusNote(
        data.fromCache
          ? `Loaded cached dataset (${dataset.pois.length} POIs, ${dataset.corridors.length} corridors).`
          : `Scanned ${dataset.pois.length} POIs & ${dataset.corridors.length} corridors.`
      );
      void refreshDirectories();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Area scan failed');
    } finally {
      setIsBusy(false);
    }
  };

  const handleScanButtonClick = () => {
    const hasExistingContent =
      pipeline.locations.candidates.length > 0 || board.routes.length > 0;
    const prevScannedBox = pipeline.area.scannedAt ? board.bbox : null;
    if (
      hasExistingContent &&
      prevScannedBox &&
      isOutsidePreviousGenerationArea(prevScannedBox, pipeline.area.bbox) &&
      !workspace.isSavedToLibrary
    ) {
      setOutsideAreaPrompt({
        pendingBbox: pipeline.area.bbox,
        pendingZoom: pipeline.area.zoom,
        regionLabel: pipeline.area.regionLabel,
      });
      return;
    }
    void executeScanArea(pipeline.area.bbox, pipeline.area.zoom, pipeline.area.regionLabel, false);
  };

  const handleLoadCachedRegion = async (cacheId: string) => {
    if (!cacheId) return;
    setIsBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/cache/${encodeURIComponent(cacheId)}`);
      const data = await res.json();
      if (!res.ok || !data?.dataset) throw new Error('Failed to load cached region');
      const ds = data.dataset as RawRegionDataset;
      const summary = data.summary as CachedRegionSummary;
      await executeScanArea(ds.bbox, ds.zoom, summary.name, false);
      setFitTrigger((n) => n + 1);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not load cache');
    } finally {
      setIsBusy(false);
    }
  };

  // =========================================================================
  // STEP 2 HANDLERS
  // =========================================================================
  const handleRunStep2Auto = async () => {
    setIsBusy(true);
    setErrorMsg(null);
    try {
      let ds = pipeline.area.dataset;
      if (!ds) {
        const res = await fetch('/api/pipeline/scan-area', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bbox: pipeline.area.bbox,
            zoom: pipeline.area.zoom,
            regionLabel: pipeline.area.regionLabel,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');
        ds = data.dataset;
      }

      let aiAdj: Map<string, { cleanName?: string; boost?: number }> | undefined;
      if (pipeline.locations.settings.useAiEnrichment && geminiAvailable && ds?.pois?.length) {
        const aiRes = await fetch('/api/pipeline/polish-locations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            regionLabel: pipeline.area.regionLabel,
            pois: ds.pois.slice(0, 80),
          }),
        });
        if (aiRes.ok) {
          const aiJson = await aiRes.json();
          if (Array.isArray(aiJson.adjustments)) {
            aiAdj = new Map(aiJson.adjustments.map((a: any) => [a.id, a]));
          }
        }
      }

      updateActiveGeneration((_g, curP, curB) => {
        const res = runStep2Locations({
          dataset: ds,
          bbox: curP.area.bbox,
          settings: curP.locations.settings,
          metersPerTrain: curP.routes.settings.metersPerTrain,
          prevCandidates: curP.locations.candidates,
          preserveManual: true,
          aiAdjustments: aiAdj,
        });
        const nextP: GenerationPipelineState = {
          ...curP,
          area: { ...curP.area, dataset: ds },
          locations: {
            ...curP.locations,
            candidates: res.candidates,
            lastAutoRunAt: new Date().toISOString(),
          },
        };
        return propagateAfterStep2Edit(nextP, curB);
      }, 'Auto-Select Locations');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Auto-select failed');
    } finally {
      setIsBusy(false);
    }
  };

  const markStopDirty = useCallback((stopId: string) => {
    setDirtyStopIds((prev) => (prev.includes(stopId) ? prev : [...prev, stopId]));
  }, []);

  /**
   * Queries Overpass inside a user-dragged box for local stations, ferry terminals, and multimodal
   * transfer hubs, adding them to the Step 2 candidate list.
   */
  const handleDiscoverAreaBox = async (targetBox: BoundingBox) => {
    setIsBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/pipeline/discover-area', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bbox: targetBox,
          zoom: pipeline.area.zoom,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Discovery scan failed');

      const foundPois = Array.isArray(data.pois) ? data.pois : [];
      const foundCorridors: RawTransitCorridor[] = Array.isArray(data.corridors)
        ? data.corridors
        : [];
      let addedCount = 0;

      updateActiveGeneration((_g, curP, curB) => {
        const existingDs = curP.area.dataset || {
          bbox: curP.area.bbox,
          zoom: curP.area.zoom,
          scaleMode: curB.scaleMode,
          pois: [],
          corridors: [],
          hazards: [],
        };
        const dsPoiIds = new Set(existingDs.pois.map((p) => p.id));
        const dsCorrIds = new Set(existingDs.corridors.map((c) => c.id));
        const candIds = new Set(curP.locations.candidates.map((c) => c.id));
        const nextPois = [...existingDs.pois];
        const nextCands = [...curP.locations.candidates];

        for (const p of foundPois) {
          if (!dsPoiIds.has(p.id)) {
            dsPoiIds.add(p.id);
            nextPois.push(p);
          }
          if (!candIds.has(p.id)) {
            candIds.add(p.id);
            const pos = projectPointToCanvas(p.lat, p.lng, curP.area.bbox);
            const cand: PipelineLocationCandidate = {
              id: p.id,
              name: p.name,
              lat: p.lat,
              lng: p.lng,
              x: pos.x,
              y: pos.y,
              popularityScore: p.osmScore,
              category: p.category,
              isMajorHub: false,
              population: p.population,
              wikiSitelinks: p.wikiSitelinks,
              source: 'osm',
              selected: false,
              autoSelected: false,
              discoveredByBox: true,
              interchangeModes: p.interchangeModes,
              filterReason: 'discovered_zone',
            };
            nextCands.push(cand);
            addedCount += 1;
          }
        }

        const nextCorrs = [...existingDs.corridors];
        for (const c of foundCorridors) {
          if (!dsCorrIds.has(c.id)) {
            dsCorrIds.add(c.id);
            nextCorrs.push(c);
          }
        }

        const nextP: GenerationPipelineState = {
          ...curP,
          area: {
            ...curP.area,
            dataset: { ...existingDs, pois: nextPois, corridors: nextCorrs },
          },
          locations: { ...curP.locations, candidates: nextCands },
        };
        return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
      }, 'Discover Zone Candidates');

      setEditTool('select');
      setStatusNote(
        addedCount > 0
          ? `Discovered ${addedCount} additional stops/interchanges inside box.`
          : `Checked zone (${foundPois.length} POIs already known).`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Discover area failed');
    } finally {
      setIsBusy(false);
    }
  };

  const handleToggleCandidate = useCallback(
    (id: string) => {
      const prevCand = pipeline.locations.candidates.find((c) => c.id === id);
      if (prevCand && !prevCand.selected) {
        markStopDirty(id);
      }
      updateActiveGeneration((_g, curP, curB) => {
        const nextCands: PipelineLocationCandidate[] = curP.locations.candidates.map((c) => {
          if (c.id !== id) return c;
          const nextSel = !c.selected;
          return {
            ...c,
            selected: nextSel,
            manualOverride: nextSel ? 'include' : 'exclude',
            filterReason: nextSel ? undefined : 'manual_excluded',
          };
        });
        const nextP: GenerationPipelineState = {
          ...curP,
          locations: { ...curP.locations, candidates: nextCands },
        };
        return propagateAfterStep2Edit(nextP, curB);
      }, 'Toggle Location');
    },
    [pipeline.locations.candidates, updateActiveGeneration]
  );

  /**
   * Selects a location or potential candidate on first click; toggles its enabled/included state
   * if it is already selected (unless armed in move mode).
   */
  const handleSelectOrToggleCandidateLocation = useCallback(
    (locId: string) => {
      if (movingLocationId === locId) {
        setSelectedLocationId(locId);
        return;
      }
      if (selectedLocationId === locId) {
        handleToggleCandidate(locId);
      } else {
        setSelectedLocationId(locId);
      }
    },
    [movingLocationId, selectedLocationId, handleToggleCandidate]
  );

  /**
   * Clears all active selections and transient interactive tools across Steps 1-5.
   */
  const clearAllSelections = useCallback(() => {
    setSelectedLocationId(null);
    setSelectedCorridorId(null);
    setSelectedCorridorWaypointIdx(null);
    setSelectedRouteId(null);
    setSelectedHazardRouteId(null);
    setSelectedWaypointIdx(null);
    setSelectedTicketId(null);
    setMovingLocationId(null);
    setLinkSourceId(null);
    setEditTool('select');
  }, []);

  const handleUpdateCandidate = (id: string, patch: Partial<PipelineLocationCandidate>) => {
    updateActiveGeneration((_g, curP, curB) => {
      const nextCands = curP.locations.candidates.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      );
      const nextP: GenerationPipelineState = {
        ...curP,
        locations: { ...curP.locations, candidates: nextCands },
      };
      return propagateAfterStep2Edit(nextP, curB);
    }, 'Edit Location');
  };

  const handleMoveLocationLatLng = (
    id: string,
    lat: number,
    lng: number,
    withUndo: boolean
  ) => {
    markStopDirty(id);
    const pos = projectPointToCanvas(lat, lng, pipeline.area.bbox);
    updateActiveGeneration(
      (_g, curP, curB) => {
        const nextCands = curP.locations.candidates.map((c) =>
          c.id === id ? { ...c, lat, lng, x: pos.x, y: pos.y } : c
        );
        const nextP: GenerationPipelineState = {
          ...curP,
          locations: { ...curP.locations, candidates: nextCands },
        };
        return propagateAfterStep2Edit(nextP, curB);
      },
      withUndo ? 'Move Location' : undefined
    );
  };

  /**
   * Places a manual stop at the clicked lat/lng, flags it dirty for incremental Step 3 corridor loading,
   * and opens an anchored reverse-lookup popup listing nearby OSM stations, ports, and towns.
   */
  const handleAddManualStop = async (lat: number, lng: number) => {
    const pos = projectPointToCanvas(lat, lng, pipeline.area.bbox);
    const id = `loc-man-${Date.now().toString(36)}`;
    const newStop: PipelineLocationCandidate = {
      id,
      name: `Stop ${activeLocsCount + 1}`,
      lat,
      lng,
      x: pos.x,
      y: pos.y,
      popularityScore: 70,
      category: 'station',
      isMajorHub: false,
      source: 'manual',
      selected: true,
      autoSelected: true,
      manualOverride: 'manual',
    };
    updateActiveGeneration((_g, curP, curB) => {
      const nextP: GenerationPipelineState = {
        ...curP,
        locations: {
          ...curP.locations,
          candidates: [...curP.locations.candidates, newStop],
        },
      };
      return propagateAfterStep2Edit(nextP, curB);
    }, 'Add Manual Stop');
    markStopDirty(id);
    setSelectedLocationId(id);
    setEditTool('select');
    setManualStopLookup({ stopId: id, lat, lng, loading: true, matches: [] });

    try {
      const res = await fetch('/api/pipeline/lookup-spot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, zoom: pipeline.area.zoom }),
      });
      const data = await res.json();
      const matches: SpotLookupMatch[] = Array.isArray(data?.matches) ? data.matches : [];
      setManualStopLookup((cur) =>
        cur && cur.stopId === id ? { ...cur, loading: false, matches } : cur
      );
    } catch {
      setManualStopLookup((cur) =>
        cur && cur.stopId === id ? { ...cur, loading: false, matches: [] } : cur
      );
    }
  };

  /**
   * Applies a selected OSM spot-lookup match onto a newly dropped manual stop.
   */
  const handlePickManualStopMatch = (stopId: string, match: SpotLookupMatch) => {
    const pos = projectPointToCanvas(match.lat, match.lng, pipeline.area.bbox);
    markStopDirty(stopId);
    updateActiveGeneration((_g, curP, curB) => {
      const nextCands = curP.locations.candidates.map((c) =>
        c.id === stopId
          ? {
              ...c,
              name: match.name,
              category: match.category,
              lat: match.lat,
              lng: match.lng,
              x: pos.x,
              y: pos.y,
              popularityScore: match.osmScore,
              isMajorHub: match.isMajorHub,
            }
          : c
      );
      const nextP: GenerationPipelineState = {
        ...curP,
        locations: { ...curP.locations, candidates: nextCands },
      };
      return propagateAfterStep2Edit(nextP, curB);
    }, `Identify Stop: ${match.name}`);
    setManualStopLookup(null);
  };

  /**
   * Executes cascading removal of a stop along with all connected corridors, train routes, and affected tickets.
   */
  const executeCascadeDeleteStop = useCallback(
    (stopId: string) => {
      updateActiveGeneration((_g, curP, curB) => {
        const stopName =
          curP.locations.candidates.find((c) => c.id === stopId)?.name || stopId;
        const remainingCands = curP.locations.candidates.filter((c) => c.id !== stopId);
        const remainingCorrs = curP.corridors.candidates.filter(
          (c) => c.fromId !== stopId && c.toId !== stopId
        );
        const remainingRoutes = curP.routes.items.filter(
          (r) => r.fromId !== stopId && r.toId !== stopId
        );
        const activeLocs = remainingCands.filter((c) => c.selected);
        const updatedTickets =
          curP.tickets.items.length > 0
            ? recalculateTicketPoints(activeLocs, remainingRoutes, curP.tickets.items)
            : [];

        const nextP: GenerationPipelineState = {
          ...curP,
          locations: { ...curP.locations, candidates: remainingCands },
          corridors: { ...curP.corridors, candidates: remainingCorrs },
          routes: { ...curP.routes, items: remainingRoutes },
          tickets: { ...curP.tickets, items: updatedTickets },
        };
        setStatusNote(`Removed ${stopName} and its connected routes.`);
        return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
      }, 'Delete Stop & Connected Routes');

      setPendingDeleteStop(null);
      setManualStopLookup((cur) => (cur?.stopId === stopId ? null : cur));
      if (selectedLocationId === stopId) setSelectedLocationId(null);
    },
    [selectedLocationId, updateActiveGeneration]
  );

  /**
   * Deletes a stop immediately when <= 2 active connections exist, or opens an inline confirmation modal
   * when > 2 corridors/routes depend on the stop so accidental cascade deletions are prevented.
   */
  const handleRequestDeleteStop = useCallback(
    (stopId: string) => {
      const stop = pipeline.locations.candidates.find((c) => c.id === stopId);
      if (!stop) return;
      const corridorCount = pipeline.corridors.candidates.filter(
        (c) => c.selected && (c.fromId === stopId || c.toId === stopId)
      ).length;
      const routeCount = pipeline.routes.items.filter(
        (r) => r.fromId === stopId || r.toId === stopId
      ).length;
      const ticketCount = pipeline.tickets.items.filter(
        (t) => t.fromId === stopId || t.toId === stopId
      ).length;

      if (Math.max(corridorCount, routeCount) > 2) {
        setPendingDeleteStop({
          stopId,
          stopName: stop.name,
          corridorCount,
          routeCount,
          ticketCount,
        });
        return;
      }
      executeCascadeDeleteStop(stopId);
    },
    [pipeline.corridors.candidates, pipeline.locations.candidates, pipeline.routes.items, pipeline.tickets.items, executeCascadeDeleteStop]
  );

  // =========================================================================
  // STEP 3 HANDLERS (CORRIDORS + COMPOSITE WAYPOINTS)
  // =========================================================================
  const handleRunStep3Auto = () => {
    let untracedStopIds: string[] = [];
    let untracedPairs: Array<{ fromId: string; toId: string }> = [];
    updateActiveGeneration((_g, curP, curB) => {
      const res = runStep3Corridors({
        allCandidates: curP.locations.candidates,
        dataset: curP.area.dataset,
        bbox: curP.area.bbox,
        settings: curP.corridors.settings,
        metersPerTrain: curP.routes.settings.metersPerTrain,
        prevCorridors: curP.corridors.candidates,
        preserveManual: true,
      });
      const untracedSet = new Set<string>();
      const pairList: Array<{ fromId: string; toId: string }> = [];
      for (const c of res.corridors) {
        if (!c.tracedFromCorridor && c.selected) {
          untracedSet.add(c.fromId);
          untracedSet.add(c.toId);
          pairList.push({ fromId: c.fromId, toId: c.toId });
        }
      }
      untracedStopIds = Array.from(untracedSet);
      untracedPairs = pairList;
      const nextP: GenerationPipelineState = {
        ...curP,
        corridors: {
          ...curP.corridors,
          candidates: res.corridors,
          lastAutoRunAt: new Date().toISOString(),
        },
      };
      return propagateAfterStep3Edit(nextP, curB);
    }, 'Auto-Detect Map Corridors');

    if (
      (untracedStopIds.length > 0 || untracedPairs.length > 0) &&
      pipeline.corridors.settings.traceRealCorridors
    ) {
      void fetchCorridorsNearStopsAndSync(
        untracedStopIds,
        false,
        untracedPairs.length > 0 ? untracedPairs : undefined
      );
    }
  };

  const handleToggleCorridor = (id: string) => {
    let fetchPair: { fromId: string; toId: string } | null = null;
    updateActiveGeneration((_g, curP, curB) => {
      const nextCorrs: PipelineCorridorCandidate[] = curP.corridors.candidates.map((c) => {
        if (c.id !== id) return c;
        const nextSel = !c.selected;
        if (
          nextSel &&
          !c.tracedFromCorridor &&
          (!c.waypoints || c.waypoints.length === 0) &&
          curP.corridors.settings.traceRealCorridors
        ) {
          fetchPair = { fromId: c.fromId, toId: c.toId };
        }
        return {
          ...c,
          selected: nextSel,
          manualOverride: nextSel ? 'include' : 'exclude',
          rejectionReason: nextSel ? undefined : 'manual_excluded',
        };
      });
      const nextP: GenerationPipelineState = {
        ...curP,
        corridors: { ...curP.corridors, candidates: nextCorrs },
      };
      return propagateAfterStep3Edit(nextP, curB);
    }, 'Toggle Corridor');

    if (fetchPair) {
      void fetchCorridorsNearStopsAndSync([], false, [fetchPair]);
    }
  };

  const handleUpdateCorridor = (
    id: string,
    patch: Partial<PipelineCorridorCandidate>,
    withUndo = true
  ) => {
    updateActiveGeneration(
      (_g, curP, curB) => {
        const locById = new Map(curP.locations.candidates.map((l) => [l.id, l]));
        const nextCorrs = curP.corridors.candidates.map((c) => {
          if (c.id !== id) return c;
          const updated = { ...c, ...patch, manualOverride: c.manualOverride || ('manual' as const) };
          const a = locById.get(updated.fromId);
          const b = locById.get(updated.toId);
          if (a && b) {
            updated.distMeters = Math.round(haversineMeters(a.lat, a.lng, b.lat, b.lng));
          }
          return updated;
        });
        const nextP: GenerationPipelineState = {
          ...curP,
          corridors: { ...curP.corridors, candidates: nextCorrs },
        };
        return propagateAfterStep3Edit(nextP, curB);
      },
      withUndo ? 'Edit Corridor' : undefined
    );
  };

  const handleDeleteCorridor = useCallback(
    (id: string) => {
      updateActiveGeneration((_g, curP, curB) => {
        const nextP: GenerationPipelineState = {
          ...curP,
          corridors: {
            ...curP.corridors,
            candidates: curP.corridors.candidates.filter((c) => c.id !== id),
          },
        };
        return propagateAfterStep3Edit(nextP, curB);
      }, 'Delete Corridor');
      if (selectedCorridorId === id) {
        setSelectedCorridorId(null);
        setSelectedCorridorWaypointIdx(null);
      }
    },
    [selectedCorridorId, updateActiveGeneration]
  );

  const handleInsertCorridorWaypoint = (
    corridorId: string,
    latLng: { lat: number; lng: number },
    kind: WaypointKind = newWaypointKind,
    insertIndex?: number
  ) => {
    const corr = pipeline.corridors.candidates.find((c) => c.id === corridorId);
    if (!corr) return;
    const a = pipeline.locations.candidates.find((c) => c.id === corr.fromId);
    const b = pipeline.locations.candidates.find((c) => c.id === corr.toId);
    if (!a || !b) return;
    const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
    const currentWps = [...resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset)];
    const idx =
      typeof insertIndex === 'number'
        ? Math.max(0, Math.min(currentWps.length, insertIndex))
        : findBestWaypointInsertIndex(a, b, currentWps, latLng, effType);
    const newPt: RouteWaypoint = {
      lat: Number(latLng.lat.toFixed(6)),
      lng: Number(latLng.lng.toFixed(6)),
      kind,
      strength: 1,
    };
    currentWps.splice(idx, 0, newPt);
    const nextPathType: RoutePathType = currentWps.every((w) => w.kind === 'corner')
      ? 'polyline'
      : 'bezier';
    handleUpdateCorridor(
      corridorId,
      { pathType: nextPathType, waypoints: currentWps },
      true
    );
    setSelectedCorridorWaypointIdx(idx);
  };

  const handleToggleCorridorWaypointKind = (corridorId: string, wpIdx: number) => {
    const corr = pipeline.corridors.candidates.find((c) => c.id === corridorId);
    if (!corr) return;
    const a = pipeline.locations.candidates.find((c) => c.id === corr.fromId);
    const b = pipeline.locations.candidates.find((c) => c.id === corr.toId);
    if (!a || !b) return;
    const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
    const currentWps = [...resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset)];
    const target = currentWps[wpIdx];
    if (!target) return;
    currentWps[wpIdx] = {
      ...target,
      kind: target.kind === 'corner' ? 'curve' : 'corner',
    };
    const nextPathType: RoutePathType = currentWps.every((w) => w.kind === 'corner')
      ? 'polyline'
      : 'bezier';
    handleUpdateCorridor(
      corridorId,
      { pathType: nextPathType, waypoints: currentWps },
      true
    );
  };

  const handleDeleteCorridorWaypoint = useCallback(
    (corridorId: string, wpIdx: number) => {
      const corr = pipeline.corridors.candidates.find((c) => c.id === corridorId);
      if (!corr) return;
      const a = pipeline.locations.candidates.find((c) => c.id === corr.fromId);
      const b = pipeline.locations.candidates.find((c) => c.id === corr.toId);
      if (!a || !b) return;
      const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
      const currentWps = [...resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset)];
      if (wpIdx < 0 || wpIdx >= currentWps.length) return;
      currentWps.splice(wpIdx, 1);
      const nextPathType: RoutePathType =
        currentWps.length === 0
          ? 'line'
          : currentWps.every((w) => w.kind === 'corner')
            ? 'polyline'
            : 'bezier';
      handleUpdateCorridor(
        corridorId,
        { pathType: nextPathType, waypoints: currentWps.length > 0 ? currentWps : undefined },
        true
      );
      setSelectedCorridorWaypointIdx(null);
    },
    [pipeline.corridors.candidates, pipeline.locations.candidates]
  );

  const handleLinkStopsInStep3 = (loc: BoardLocation) => {
    if (!linkSourceId) {
      setLinkSourceId(loc.id);
      return;
    }
    if (linkSourceId === loc.id) {
      setLinkSourceId(null);
      return;
    }
    const existing = pipeline.corridors.candidates.find(
      (c) =>
        (c.fromId === linkSourceId && c.toId === loc.id) ||
        (c.fromId === loc.id && c.toId === linkSourceId)
    );
    if (existing) {
      if (!existing.selected) handleToggleCorridor(existing.id);
      setSelectedCorridorId(existing.id);
      setLinkSourceId(null);
      setEditTool('select');
      return;
    }

    const fromLoc = pipeline.locations.candidates.find((c) => c.id === linkSourceId);
    const distM = fromLoc ? Math.round(haversineMeters(fromLoc.lat, fromLoc.lng, loc.lat, loc.lng)) : 2000;
    const newId = `corr-man-${Date.now().toString(36)}`;
    const newCorr: PipelineCorridorCandidate = {
      id: newId,
      fromId: linkSourceId,
      toId: loc.id,
      mode: fromLoc?.category === 'port' && loc.category === 'port' ? 'ferry' : 'train',
      transitWeight: 75,
      cost: 0.3,
      distMeters: distM,
      arcMeters: distM,
      pathType: 'line',
      curveOffset: 0,
      tracedFromCorridor: false,
      isTunnel: false,
      ferryLocomotives: 0,
      roadHazard: 0,
      maritimeHazard: 0,
      selected: true,
      autoSelected: true,
      manualOverride: 'manual',
    };
    const pairedFrom = linkSourceId;
    const pairedTo = loc.id;
    updateActiveGeneration((_g, curP, curB) => {
      const nextP: GenerationPipelineState = {
        ...curP,
        corridors: {
          ...curP.corridors,
          candidates: [...curP.corridors.candidates, newCorr],
        },
      };
      return propagateAfterStep3Edit(nextP, curB);
    }, 'Add Manual Corridor');
    setSelectedCorridorId(newId);
    setLinkSourceId(null);
    setEditTool('select');

    if (pipeline.corridors.settings.traceRealCorridors) {
      void fetchCorridorsNearStopsAndSync([], false, [{ fromId: pairedFrom, toId: pairedTo }]);
    }
  };

  // =========================================================================
  // STEP 4 HANDLERS (TRAIN ROUTES + PARAMETRIC RELATIVE WAYPOINTS)
  // =========================================================================
  const handleRunStep4Auto = () => {
    updateActiveGeneration((_g, curP, curB) => {
      const activeLocs = curP.locations.candidates.filter((c) => c.selected);
      const res = runStep4TrainRoutes({
        activeLocations: activeLocs,
        corridors: curP.corridors.candidates,
        bbox: curP.area.bbox,
        settings: curP.routes.settings,
        preserveManualOverrides: false,
      });
      const nextP: GenerationPipelineState = {
        ...curP,
        routes: {
          ...curP.routes,
          settings: { ...curP.routes.settings, metersPerTrain: res.effectiveMetersPerTrain },
          items: res.routes,
          lastAutoRunAt: new Date().toISOString(),
        },
      };
      return propagateAfterStep4Edit(nextP, curB);
    }, 'Rebuild Game Routes');
  };

  const handleUpdateRoute = (id: string, patch: Partial<BoardRoute>, withUndo = true) => {
    updateActiveGeneration(
      (_g, curP, curB) => {
        const nextRoutes = curP.routes.items.map((r) => (r.id === id ? { ...r, ...patch } : r));
        const nextP: GenerationPipelineState = {
          ...curP,
          routes: { ...curP.routes, items: nextRoutes },
        };
        return propagateAfterStep4Edit(nextP, curB);
      },
      withUndo ? 'Edit Train Route' : undefined
    );
  };

  const handleInsertRouteWaypoint = (
    routeId: string,
    latLng: { lat: number; lng: number },
    kind: WaypointKind = newWaypointKind,
    insertIndex?: number
  ) => {
    const rt = pipeline.routes.items.find((r) => r.id === routeId);
    if (!rt) return;
    const a = pipeline.locations.candidates.find((c) => c.id === rt.fromId);
    const b = pipeline.locations.candidates.find((c) => c.id === rt.toId);
    if (!a || !b) return;
    const effType = resolveEffectivePathType(rt.pathType, rt.waypoints, rt.curveOffset);
    const currentWps = [...resolveEffectiveWaypoints(a, b, effType, rt.waypoints, rt.curveOffset)];
    const idx =
      typeof insertIndex === 'number'
        ? Math.max(0, Math.min(currentWps.length, insertIndex))
        : findBestWaypointInsertIndex(a, b, currentWps, latLng, effType);

    const parentCorr = rt.sourceCorridorId
      ? pipeline.corridors.candidates.find((c) => c.id === rt.sourceCorridorId)
      : undefined;
    const rel = parentCorr
      ? projectPointOntoCorridorCurve(
          a,
          b,
          parentCorr.waypoints,
          parentCorr.pathType,
          parentCorr.curveOffset,
          latLng
        )
      : undefined;

    currentWps.splice(idx, 0, {
      lat: Number(latLng.lat.toFixed(6)),
      lng: Number(latLng.lng.toFixed(6)),
      kind,
      strength: 1,
      relT: rel?.relT,
      relOffsetRatio: rel?.relOffsetRatio,
    });
    const nextPathType: RoutePathType = currentWps.every((w) => w.kind === 'corner')
      ? 'polyline'
      : 'bezier';
    handleUpdateRoute(
      routeId,
      { pathType: nextPathType, waypoints: currentWps, customWaypoints: true },
      true
    );
    setSelectedWaypointIdx(idx);
  };

  const handleToggleRouteWaypointKind = (routeId: string, wpIdx: number) => {
    const rt = pipeline.routes.items.find((r) => r.id === routeId);
    if (!rt) return;
    const a = pipeline.locations.candidates.find((c) => c.id === rt.fromId);
    const b = pipeline.locations.candidates.find((c) => c.id === rt.toId);
    if (!a || !b) return;
    const effType = resolveEffectivePathType(rt.pathType, rt.waypoints, rt.curveOffset);
    const currentWps = [...resolveEffectiveWaypoints(a, b, effType, rt.waypoints, rt.curveOffset)];
    const target = currentWps[wpIdx];
    if (!target) return;
    currentWps[wpIdx] = {
      ...target,
      kind: target.kind === 'corner' ? 'curve' : 'corner',
    };
    const nextPathType: RoutePathType = currentWps.every((w) => w.kind === 'corner')
      ? 'polyline'
      : 'bezier';
    handleUpdateRoute(
      routeId,
      { pathType: nextPathType, waypoints: currentWps, customWaypoints: true },
      true
    );
  };

  const handleDeleteRouteWaypoint = useCallback(
    (routeId: string, wpIdx: number) => {
      const rt = pipeline.routes.items.find((r) => r.id === routeId);
      if (!rt) return;
      const a = pipeline.locations.candidates.find((c) => c.id === rt.fromId);
      const b = pipeline.locations.candidates.find((c) => c.id === rt.toId);
      if (!a || !b) return;
      const effType = resolveEffectivePathType(rt.pathType, rt.waypoints, rt.curveOffset);
      const currentWps = [...resolveEffectiveWaypoints(a, b, effType, rt.waypoints, rt.curveOffset)];
      if (wpIdx < 0 || wpIdx >= currentWps.length) return;
      currentWps.splice(wpIdx, 1);
      const nextPathType: RoutePathType =
        currentWps.length === 0
          ? 'line'
          : currentWps.every((w) => w.kind === 'corner')
            ? 'polyline'
            : 'bezier';
      handleUpdateRoute(
        routeId,
        {
          pathType: nextPathType,
          waypoints: currentWps.length > 0 ? currentWps : undefined,
          customWaypoints: true,
        },
        true
      );
      setSelectedWaypointIdx(null);
    },
    [pipeline.routes.items, pipeline.locations.candidates]
  );

  const handleResetRouteToCorridor = (routeId: string) => {
    const rt = pipeline.routes.items.find((r) => r.id === routeId);
    if (!rt || !rt.sourceCorridorId) return;
    const parentCorr = pipeline.corridors.candidates.find((c) => c.id === rt.sourceCorridorId);
    const a = pipeline.locations.candidates.find((c) => c.id === rt.fromId);
    const b = pipeline.locations.candidates.find((c) => c.id === rt.toId);
    if (!parentCorr || !a || !b) return;
    const effType = resolveEffectivePathType(
      parentCorr.pathType,
      parentCorr.waypoints,
      parentCorr.curveOffset
    );
    const baseWps = resolveEffectiveWaypoints(
      a,
      b,
      effType,
      parentCorr.waypoints,
      parentCorr.curveOffset
    ).map((w) => {
      const rel = projectPointOntoCorridorCurve(
        a,
        b,
        parentCorr.waypoints,
        parentCorr.pathType,
        parentCorr.curveOffset,
        w
      );
      return { ...w, relT: rel.relT, relOffsetRatio: 0 };
    });
    handleUpdateRoute(
      routeId,
      {
        pathType: effType,
        waypoints: baseWps.length > 0 ? baseWps : undefined,
        customWaypoints: false,
      },
      true
    );
    setSelectedWaypointIdx(null);
  };

  const handleDeleteRoute = useCallback(
    (id: string) => {
      updateActiveGeneration((_g, curP, curB) => {
        const nextRoutes = curP.routes.items.filter((r) => r.id !== id);
        const nextP: GenerationPipelineState = {
          ...curP,
          routes: { ...curP.routes, items: nextRoutes },
        };
        return propagateAfterStep4Edit(nextP, curB);
      }, 'Remove Train Route');
      if (selectedRouteId === id) {
        setSelectedRouteId(null);
        setSelectedWaypointIdx(null);
      }
    },
    [selectedRouteId, updateActiveGeneration]
  );

  // Keyboard shortcuts: Ctrl+Z/Y, Space (deselect all), and Delete/Backspace for selected item
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (viewLevel !== 'generation') return;
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || targetEl?.isContentEditable) {
        return;
      }
      if (pendingDeleteStop || outsideAreaPrompt) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          handleUndo();
        } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
          e.preventDefault();
          handleRedo();
        }
        return;
      }

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        clearAllSelections();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (activeStep === 'corridors' && selectedCorridorId && selectedCorridorWaypointIdx !== null) {
          handleDeleteCorridorWaypoint(selectedCorridorId, selectedCorridorWaypointIdx);
        } else if (activeStep === 'routes' && selectedRouteId && selectedWaypointIdx !== null) {
          handleDeleteRouteWaypoint(selectedRouteId, selectedWaypointIdx);
        } else if (activeStep === 'routes' && selectedRouteId) {
          handleDeleteRoute(selectedRouteId);
        } else if (activeStep === 'corridors' && selectedCorridorId) {
          handleDeleteCorridor(selectedCorridorId);
        } else if (selectedLocationId) {
          handleRequestDeleteStop(selectedLocationId);
        } else if (activeStep === 'tickets' && selectedTicketId) {
          updateActiveGeneration((_g, curP, curB) => {
            const nextP: GenerationPipelineState = {
              ...curP,
              tickets: {
                ...curP.tickets,
                items: curP.tickets.items.filter((t) => t.id !== selectedTicketId),
              },
            };
            return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
          }, 'Delete Ticket');
          setSelectedTicketId(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    viewLevel,
    pendingDeleteStop,
    outsideAreaPrompt,
    activeStep,
    selectedCorridorId,
    selectedCorridorWaypointIdx,
    selectedRouteId,
    selectedWaypointIdx,
    selectedLocationId,
    selectedTicketId,
    handleUndo,
    handleRedo,
    clearAllSelections,
    handleDeleteCorridorWaypoint,
    handleDeleteRouteWaypoint,
    handleDeleteRoute,
    handleDeleteCorridor,
    handleRequestDeleteStop,
    updateActiveGeneration,
  ]);

  // =========================================================================
  // STEP 5 & PUBLISHING HANDLERS
  // =========================================================================
  const handleRunStep5Auto = () => {
    updateActiveGeneration((_g, curP, curB) => {
      const activeLocs = curP.locations.candidates.filter((c) => c.selected);
      const nextTickets = runStep5Tickets(activeLocs, curP.routes.items, curP.tickets.settings);
      const nextP: GenerationPipelineState = {
        ...curP,
        tickets: {
          ...curP.tickets,
          items: nextTickets,
          lastAutoRunAt: new Date().toISOString(),
        },
      };
      return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
    }, 'Auto-Generate Tickets');
  };

  const handleRecalculateTickets = () => {
    updateActiveGeneration((_g, curP, curB) => {
      const activeLocs = curP.locations.candidates.filter((c) => c.selected);
      const nextTickets = recalculateTicketPoints(activeLocs, curP.routes.items, curP.tickets.items);
      const nextP: GenerationPipelineState = {
        ...curP,
        tickets: { ...curP.tickets, items: nextTickets },
      };
      return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
    }, 'Recalculate Ticket Points');
  };

  const handleAddManualTicket = (fromId: string, toId: string) => {
    const fromLoc = pipeline.locations.candidates.find((c) => c.id === fromId);
    const toLoc = pipeline.locations.candidates.find((c) => c.id === toId);
    if (!fromLoc || !toLoc) return;
    const raw: DestinationTicket = {
      id: `tkt-man-${Date.now().toString(36)}`,
      fromId,
      toId,
      fromName: fromLoc.name,
      toName: toLoc.name,
      points: 8,
    };
    const [recalced] = recalculateTicketPoints(board.locations, board.routes, [raw]);
    updateActiveGeneration((_g, curP, curB) => {
      const nextP: GenerationPipelineState = {
        ...curP,
        tickets: {
          ...curP.tickets,
          items: [recalced || raw, ...curP.tickets.items],
        },
      };
      return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
    }, 'Add Manual Ticket');
  };

  const handleSaveToLibrary = async (): Promise<BoardDefinition | null> => {
    if (board.routes.length === 0) return null;
    setIsSaving(true);
    setErrorMsg(null);
    try {
      const payload: BoardDefinition = {
        ...board,
        name: workspace.name || board.name,
        id: workspace.id,
      };
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save board');
      const saved = data.board as BoardDefinition;

      const updatedWs: StudioMapWorkspace = {
        ...workspace,
        id: saved.id,
        name: saved.name,
        isSavedToLibrary: true,
        lastServerSyncAt: new Date().toISOString(),
        draftBoard: saved,
      };
      await fetch(`/api/boards/${encodeURIComponent(saved.id)}/workspace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: updatedWs }),
      }).catch(() => {});

      commitWorkspace(updatedWs);
      onBoardSaved(saved);
      void refreshDirectories();
      setStatusNote(`Saved "${saved.name}" to Board Library.`);
      return saved;
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not save board');
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleHostGame = async () => {
    let targetId = workspace.id;
    if (!workspace.isSavedToLibrary) {
      const saved = await handleSaveToLibrary();
      if (!saved) return;
      targetId = saved.id;
    }
    onHostBoard(targetId);
  };

  // =========================================================================
  // LEVEL 1 & LEVEL 2 WORKSPACE / GENERATION ACTIONS
  // =========================================================================
  const handleCreateProject = (name?: string) => {
    const ws = createUntitledWorkspace(undefined, name);
    commitWorkspace(ws);
    setViewLevel('generation');
    setFitTrigger((n) => n + 1);
    void refreshDirectories();
  };

  const handleOpenWorkspace = (ws: StudioMapWorkspace) => {
    const gen =
      ws.generations.find((g) => g.id === ws.activeGenerationId) ||
      ws.generations[ws.generations.length - 1];
    const nextWs: StudioMapWorkspace = {
      ...ws,
      activeGenerationId: gen ? gen.id : null,
    };
    commitWorkspace(nextWs);
    setViewLevel('project');
  };

  const handleOpenLibraryBoard = (b: BoardDefinition) => {
    const ws = createWorkspaceFromSavedBoard(b);
    commitWorkspace(ws);
    setViewLevel('project');
    void refreshDirectories();
  };

  const handleDuplicateWorkspace = (ws: StudioMapWorkspace) => {
    const id = `draft-${Date.now().toString(36)}`;
    const copy: StudioMapWorkspace = {
      ...ws,
      id,
      name: `${ws.name} (Copy)`,
      isSavedToLibrary: false,
      lastServerSyncAt: null,
      lastLocalSaveAt: new Date().toISOString(),
    };
    commitWorkspace(copy);
    setViewLevel('project');
    void refreshDirectories();
  };

  const handleDeleteWorkspace = async (id: string) => {
    await deleteClientWorkspace(id);
    await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    if (workspace.id === id) {
      const nextWs = createUntitledWorkspace();
      commitWorkspace(nextWs);
    }
    void refreshDirectories();
  };

  const handleCreateGeneration = (seedFromGen?: MapGenerationCheckpoint) => {
    const nextIdx =
      workspace.generations.reduce((mx, g) => Math.max(mx, g.index), 0) + 1;
    const genId = `gen-${Date.now().toString(36)}`;
    const seedBoard = seedFromGen?.currentBoard || createBlankUntitledBoard(board.bbox);
    const seedPipeline = seedFromGen?.pipeline
      ? JSON.parse(JSON.stringify(seedFromGen.pipeline))
      : createInitialPipelineState(seedBoard.bbox, seedBoard, pipeline.area.dataset);

    const newGen: MapGenerationCheckpoint = {
      id: genId,
      index: nextIdx,
      label: `Gen #${nextIdx} · ${seedBoard.regionLabel}`,
      createdAt: new Date().toISOString(),
      baseBoard: seedBoard,
      stages: [],
      currentBoard: seedBoard,
      pipeline: seedPipeline,
      undoStack: [],
      redoStack: [],
    };
    commitWorkspace({
      ...workspace,
      activeGenerationId: genId,
      generations: [...workspace.generations, newGen],
      draftBoard: seedBoard,
      draftPipeline: seedPipeline,
    });
    setViewLevel('generation');
    setFitTrigger((n) => n + 1);
  };

  const handleOpenGeneration = (genId: string, stepOverride?: PipelineStepId) => {
    const target = workspace.generations.find((g) => g.id === genId);
    if (!target) return;
    const baseP = target.pipeline || hydratePipelineFromCheckpoint(target);
    const nextP = stepOverride ? { ...baseP, activeStep: stepOverride } : baseP;
    const nextGen = { ...target, pipeline: nextP };
    commitWorkspace({
      ...workspace,
      activeGenerationId: genId,
      generations: workspace.generations.map((g) => (g.id === genId ? nextGen : g)),
      draftBoard: nextGen.currentBoard,
      draftPipeline: nextP,
    });
    setViewLevel('generation');
    setFitTrigger((n) => n + 1);
  };

  const handleDeleteGeneration = (genId: string) => {
    if (workspace.generations.length <= 1) return;
    const remaining = workspace.generations.filter((g) => g.id !== genId);
    const nextActive =
      workspace.activeGenerationId === genId
        ? remaining[remaining.length - 1]
        : remaining.find((g) => g.id === workspace.activeGenerationId) || remaining[0];
    commitWorkspace({
      ...workspace,
      activeGenerationId: nextActive.id,
      generations: remaining,
      draftBoard: nextActive.currentBoard,
      draftPipeline: nextActive.pipeline,
    });
  };

  const activeLocsCount = pipeline.locations.candidates.filter((c) => c.selected).length;

  // Highlighted endpoints / routes when a ticket is selected in Step 5
  const highlightedTicketLocIds = useMemo(() => {
    const set = new Set<string>();
    if (activeStep === 'tickets' && selectedTicketId) {
      const t = pipeline.tickets.items.find((tk) => tk.id === selectedTicketId);
      if (t) {
        set.add(t.fromId);
        set.add(t.toId);
      }
    }
    return set;
  }, [activeStep, selectedTicketId, pipeline.tickets.items]);

  // =========================================================================
  // RENDER STUDIO CHROME + ACTIVE VIEW LEVEL
  // =========================================================================
  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] bg-slate-50 text-slate-900">
      {/* Compact Studio Breadcrumb & Pipeline Step Bar */}
      <div className="h-11 px-4 bg-white border-b border-slate-200 flex items-center justify-between gap-3 shrink-0 overflow-x-auto">
        {/* Left: Hierarchical Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs shrink-0">
          <button
            type="button"
            onClick={() => {
              void refreshDirectories();
              setViewLevel('projects');
            }}
            className={`px-2 py-1 rounded hover:bg-slate-100 whitespace-nowrap cursor-pointer ${
              viewLevel === 'projects' ? 'font-bold text-slate-900' : 'text-slate-600'
            }`}
          >
            Projects
          </button>

          {viewLevel !== 'projects' && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <button
                type="button"
                onClick={() => setViewLevel('project')}
                className={`px-2 py-1 rounded hover:bg-slate-100 max-w-[160px] truncate whitespace-nowrap cursor-pointer ${
                  viewLevel === 'project' ? 'font-bold text-slate-900' : 'text-slate-600'
                }`}
              >
                {workspace.name}
              </button>
            </>
          )}

          {viewLevel === 'generation' && activeGen && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="px-2 py-1 font-bold text-slate-900 whitespace-nowrap tabular-nums">
                Gen #{activeGen.index}
              </span>
            </>
          )}
        </div>

        {/* Center: 5 Dedicated Pipeline Step Tabs (Generation Level Only) */}
        {viewLevel === 'generation' && (
          <nav className="flex items-center gap-1 shrink-0">
            {STEPS_META.map((s) => {
              const isCurrent = activeStep === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goToStep(s.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    isCurrent
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </nav>
        )}

        {/* Right: Undo/Redo & Save */}
        <div className="flex items-center gap-1.5 shrink-0">
          {viewLevel === 'generation' && activeGen && (
            <>
              <button
                type="button"
                disabled={activeGen.undoStack.length === 0}
                onClick={handleUndo}
                title="Undo (Ctrl+Z)"
                className="p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={activeGen.redoStack.length === 0}
                onClick={handleRedo}
                title="Redo (Ctrl+Y)"
                className="p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            disabled={isSaving || board.routes.length === 0}
            onClick={() => void handleSaveToLibrary()}
            className="px-2.5 py-1 rounded bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3 h-3" />
            Save
          </button>
        </div>
      </div>

      {/* Inline Status / Error Banner */}
      {(errorMsg || statusNote) && (
        <div
          className={`px-4 py-1.5 text-xs flex items-center justify-between border-b shrink-0 ${
            errorMsg
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <span>{errorMsg || statusNote}</span>
          <button
            type="button"
            onClick={() => {
              setErrorMsg(null);
              setStatusNote(null);
            }}
            className="text-[11px] font-medium underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Inline Stop Cascade Delete Confirmation Modal (>2 Connected Routes/Corridors) */}
      {pendingDeleteStop && (
        <div className="fixed inset-0 z-[1200] bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-300 max-w-md w-full p-5 flex flex-col gap-3">
            <h3 className="text-sm font-bold text-slate-900">
              Delete Hub Stop &ldquo;{pendingDeleteStop.stopName}&rdquo;?
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              This stop connects to{' '}
              <strong>
                {Math.max(pendingDeleteStop.corridorCount, pendingDeleteStop.routeCount)} routes
              </strong>{' '}
              ({pendingDeleteStop.corridorCount} map corridors, {pendingDeleteStop.routeCount}{' '}
              train routes) and {pendingDeleteStop.ticketCount} destination tickets. Deleting it
              will remove all attached routes and tickets.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPendingDeleteStop(null)}
                className="py-1.5 px-3 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeCascadeDeleteStop(pendingDeleteStop.stopId)}
                className="py-1.5 px-3 rounded-lg bg-red-700 text-white text-xs font-semibold hover:bg-red-800 cursor-pointer"
              >
                Delete Stop &amp; Connected Routes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Outside-Previous-Area Prompt Modal */}
      {outsideAreaPrompt && (
        <div className="fixed inset-0 z-[1200] bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-300 max-w-md w-full p-5 flex flex-col gap-3">
            <h3 className="text-sm font-bold text-slate-900">
              Scanning Outside Current Project Area
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              This target bounding box does not overlap your previous unsaved generation in{' '}
              <strong>{workspace.name}</strong>. Do you want to start a separate project or
              overwrite the current generation?
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={() =>
                  void executeScanArea(
                    outsideAreaPrompt.pendingBbox,
                    outsideAreaPrompt.pendingZoom,
                    outsideAreaPrompt.regionLabel,
                    true
                  )
                }
                className="flex-1 py-2 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer"
              >
                Start New Project
              </button>
              <button
                type="button"
                onClick={() =>
                  void executeScanArea(
                    outsideAreaPrompt.pendingBbox,
                    outsideAreaPrompt.pendingZoom,
                    outsideAreaPrompt.regionLabel,
                    false
                  )
                }
                className="py-2 px-3 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
              >
                Replace Here
              </button>
              <button
                type="button"
                onClick={() => setOutsideAreaPrompt(null)}
                className="py-2 px-3 rounded-lg text-slate-500 text-xs hover:bg-slate-100 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VIEW LEVEL 1: PROJECTS LIST */}
      {viewLevel === 'projects' && (
        <ProjectsHome
          workspaces={allWorkspaces}
          libraryBoards={libraryBoards}
          activeWorkspaceId={workspace.id}
          onCreateProject={handleCreateProject}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenLibraryBoard={handleOpenLibraryBoard}
          onDuplicateWorkspace={handleDuplicateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onHostBoard={onHostBoard}
        />
      )}

      {/* VIEW LEVEL 2: PROJECT GENERATIONS LIST */}
      {viewLevel === 'project' && (
        <ProjectOverview
          workspace={workspace}
          isSaving={isSaving}
          onRenameProject={(name) => commitWorkspace({ ...workspace, name })}
          onChangeTheme={(theme: BoardTheme) => {
            updateActiveGeneration((_g, curP, curB) => ({
              pipeline: curP,
              board: { ...curB, theme },
            }));
          }}
          onCreateGeneration={handleCreateGeneration}
          onOpenGeneration={handleOpenGeneration}
          onDeleteGeneration={handleDeleteGeneration}
          onSaveToLibrary={() => void handleSaveToLibrary()}
          onHostGame={() => void handleHostGame()}
        />
      )}

      {/* VIEW LEVEL 3: GENERATION PIPELINE (STEP 1 FULL MAP | STEPS 2-5 SPLIT) */}
      {viewLevel === 'generation' && (
        <div
          className={
            activeStep === 'area'
              ? 'relative w-full h-[calc(100vh-6.75rem)] min-h-[500px]'
              : 'flex flex-col lg:flex-row lg:h-[calc(100vh-6.75rem)]'
          }
        >
          {/* Geographic Leaflet Canvas */}
          <div
            className={
              activeStep === 'area'
                ? 'relative w-full h-full'
                : 'relative h-[54vh] min-h-[380px] lg:h-full lg:flex-1'
            }
          >
            <GeoBoardMap
              board={board}
              mode="editor"
              activeBbox={pipeline.area.bbox}
              stepMode={activeStep}
              editTool={editTool}
              newWaypointKind={newWaypointKind}
              selectedLocationId={selectedLocationId}
              selectedRouteId={selectedRouteId}
              selectedWaypointIdx={selectedWaypointIdx}
              selectedHazardRouteId={selectedHazardRouteId}
              selectedCorridorId={selectedCorridorId}
              selectedCorridorWaypointIdx={selectedCorridorWaypointIdx}
              movingLocationId={movingLocationId}
              linkSourceId={linkSourceId}
              highlightedLocationIds={highlightedTicketLocIds}
              candidateLocations={pipeline.locations.candidates}
              candidateCorridors={pipeline.corridors.candidates}
              rawCorridors={pipeline.area.dataset?.corridors}
              infraVisibility={infraVisibility}
              manualStopLookup={manualStopLookup}
              showRejectedCorridors={showRejectedCorridors}
              fitTrigger={fitTrigger}
              onToggleInfraLayer={(layer) =>
                setInfraVisibility((cur) => ({ ...cur, [layer]: !cur[layer] }))
              }
              onDiscoverBox={(box) => void handleDiscoverAreaBox(box)}
              onPickManualStopMatch={handlePickManualStopMatch}
              onDismissManualStopLookup={() => setManualStopLookup(null)}
              onZoomChange={(zoom) => {
                setWorkspace((cur) => {
                  const g = cur.generations.find((gen) => gen.id === cur.activeGenerationId);
                  if (!g || !g.pipeline || g.pipeline.area.zoom === Math.round(zoom)) return cur;
                  const nextP = {
                    ...g.pipeline,
                    area: { ...g.pipeline.area, zoom: Math.round(zoom) },
                  };
                  const nextGen = { ...g, pipeline: nextP };
                  return {
                    ...cur,
                    generations: cur.generations.map((item) =>
                      item.id === nextGen.id ? nextGen : item
                    ),
                  };
                });
              }}
              onChangeBbox={(nextBox) => {
                updateActiveGeneration((_g, curP, curB) => {
                  const nextScale = computeIdealMetersPerTrain(nextBox);
                  const nextP: GenerationPipelineState = {
                    ...curP,
                    area: { ...curP.area, bbox: nextBox },
                    routes: {
                      ...curP.routes,
                      settings: { ...curP.routes.settings, metersPerTrain: nextScale },
                    },
                  };
                  return {
                    pipeline: nextP,
                    board: {
                      ...curB,
                      bbox: nextBox,
                      metersPerTrain: nextScale,
                      scaleSpanKm:
                        Math.round((computeBoxWidthMeters(nextBox) / 1000) * 10) / 10,
                    },
                  };
                });
              }}
              onDragStart={(kind) => {
                if (
                  !dragUndoCapturedRef.current &&
                  activeGen &&
                  kind !== 'box_edge' &&
                  kind !== 'draw_box' &&
                  kind !== 'discover_box'
                ) {
                  dragUndoCapturedRef.current = true;
                  const entry: BoardEditEntry = {
                    id: `drag-${Date.now().toString(36)}`,
                    label: `Drag ${kind}`,
                    timestamp: new Date().toISOString(),
                    board: activeGen.currentBoard,
                    pipeline: activeGen.pipeline,
                  };
                  setWorkspace((cur) => ({
                    ...cur,
                    generations: cur.generations.map((g) =>
                      g.id === activeGen.id
                        ? { ...g, undoStack: [...g.undoStack.slice(-39), entry], redoStack: [] }
                        : g
                    ),
                  }));
                }
              }}
              onDragEnd={() => {
                dragUndoCapturedRef.current = false;
                if (editTool === 'draw_box' || editTool === 'discover_box') setEditTool('select');
              }}
              onAddStopLatLng={(lat, lng) => void handleAddManualStop(lat, lng)}
              onSelectCandidateLocation={(cand) => handleSelectOrToggleCandidateLocation(cand.id)}
              onMoveLocationLatLng={(id, lat, lng) =>
                handleMoveLocationLatLng(id, lat, lng, false)
              }
              onTapRelocateLocation={(id, lat, lng) => {
                handleMoveLocationLatLng(id, lat, lng, true);
                setMovingLocationId(null);
              }}
              onSelectLocation={(loc) => {
                if (activeStep === 'corridors' && editTool === 'add_route') {
                  handleLinkStopsInStep3(loc);
                  return;
                }
                setSelectedLocationId(loc.id);
              }}
              onSelectCorridor={(corr) => {
                setSelectedCorridorId(corr.id);
                setSelectedCorridorWaypointIdx(null);
              }}
              onSelectCorridorWaypoint={(corridorId, index) => {
                setSelectedCorridorId(corridorId);
                setSelectedCorridorWaypointIdx(index);
              }}
              onUpdateCorridorWaypoint={(corridorId, waypointIdx, latLng) => {
                const corr = pipeline.corridors.candidates.find((c) => c.id === corridorId);
                if (!corr) return;
                const a = pipeline.locations.candidates.find((c) => c.id === corr.fromId);
                const b = pipeline.locations.candidates.find((c) => c.id === corr.toId);
                const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
                const wps =
                  a && b
                    ? [...resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset)]
                    : [...(corr.waypoints || [])];
                if (!wps[waypointIdx]) return;
                wps[waypointIdx] = {
                  ...wps[waypointIdx],
                  lat: Number(latLng.lat.toFixed(6)),
                  lng: Number(latLng.lng.toFixed(6)),
                };
                handleUpdateCorridor(corridorId, { waypoints: wps }, false);
              }}
              onInsertCorridorWaypoint={handleInsertCorridorWaypoint}
              onToggleCorridorWaypointKind={handleToggleCorridorWaypointKind}
              onDeleteCorridorWaypoint={handleDeleteCorridorWaypoint}
              onSelectRoute={(route) => {
                setSelectedRouteId(route.id);
                setSelectedWaypointIdx(null);
                setSelectedHazardRouteId(null);
              }}
              onSelectHazard={(route) => {
                setSelectedRouteId(route.id);
                setSelectedHazardRouteId(route.id);
              }}
              onMoveHazardLatLng={(routeId, lat, lng) => {
                handleUpdateRoute(routeId, { hazardLatLng: { lat, lng } }, false);
              }}
              onSelectWaypoint={(routeId, index) => {
                setSelectedRouteId(routeId);
                setSelectedWaypointIdx(index);
              }}
              onUpdateRouteWaypoint={(routeId, idx, latLng) => {
                const rt = pipeline.routes.items.find((r) => r.id === routeId);
                if (!rt) return;
                const a = pipeline.locations.candidates.find((c) => c.id === rt.fromId);
                const b = pipeline.locations.candidates.find((c) => c.id === rt.toId);
                const effType = resolveEffectivePathType(rt.pathType, rt.waypoints, rt.curveOffset);
                const wps =
                  a && b
                    ? [...resolveEffectiveWaypoints(a, b, effType, rt.waypoints, rt.curveOffset)]
                    : [...(rt.waypoints || [])];
                if (!wps[idx]) return;
                const parentCorr = rt.sourceCorridorId
                  ? pipeline.corridors.candidates.find((c) => c.id === rt.sourceCorridorId)
                  : undefined;
                const rel =
                  a && b && parentCorr
                    ? projectPointOntoCorridorCurve(
                        a,
                        b,
                        parentCorr.waypoints,
                        parentCorr.pathType,
                        parentCorr.curveOffset,
                        latLng
                      )
                    : undefined;
                wps[idx] = {
                  ...wps[idx],
                  lat: Number(latLng.lat.toFixed(6)),
                  lng: Number(latLng.lng.toFixed(6)),
                  relT: rel ? rel.relT : wps[idx].relT,
                  relOffsetRatio: rel ? rel.relOffsetRatio : wps[idx].relOffsetRatio,
                };
                handleUpdateRoute(routeId, { waypoints: wps }, false);
              }}
              onInsertRouteWaypoint={handleInsertRouteWaypoint}
              onToggleRouteWaypointKind={handleToggleRouteWaypointKind}
              onDeleteRouteWaypoint={handleDeleteRouteWaypoint}
              onClearSelection={clearAllSelections}
            />

            {/* STEP 1 OVERLAY BAR: Compact Search + Area Selection Action Bar (top-left of full map) */}
            {activeStep === 'area' && (
              <div className="absolute top-3 left-14 right-3 z-[600] flex flex-wrap items-center gap-2 pointer-events-none">
                <form
                  onSubmit={handleGeocodeSearch}
                  className="pointer-events-auto flex items-center bg-white border border-slate-300 rounded-lg overflow-hidden shadow-sm"
                >
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search city or region..."
                    className="px-3 py-1.5 text-xs text-slate-900 w-44 sm:w-56 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={isSearching}
                    className="px-2.5 py-1.5 bg-slate-100 border-l border-slate-200 text-slate-700 hover:bg-slate-200 text-xs font-medium flex items-center gap-1 cursor-pointer"
                  >
                    {isSearching ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    Find
                  </button>
                </form>

                {geocodeResults.length > 1 && (
                  <select
                    onChange={(e) => {
                      const picked = geocodeResults[Number(e.target.value)];
                      if (!picked) return;
                      updateActiveGeneration((_g, curP, curB) => {
                        const s = computeIdealMetersPerTrain(picked.bbox);
                        return {
                          pipeline: {
                            ...curP,
                            area: {
                              ...curP.area,
                              bbox: picked.bbox,
                              regionLabel: picked.displayName.split(',')[0],
                            },
                            routes: {
                              ...curP.routes,
                              settings: { ...curP.routes.settings, metersPerTrain: s },
                            },
                          },
                          board: {
                            ...curB,
                            bbox: picked.bbox,
                            regionLabel: picked.displayName.split(',')[0],
                            metersPerTrain: s,
                          },
                        };
                      });
                      setFitTrigger((n) => n + 1);
                    }}
                    className="pointer-events-auto px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-800 max-w-[200px] shadow-sm"
                  >
                    {geocodeResults.map((r, i) => (
                      <option key={i} value={i}>
                        {r.displayName}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() =>
                    setEditTool(editTool === 'draw_box' ? 'select' : 'draw_box')
                  }
                  className={`pointer-events-auto px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 shadow-sm whitespace-nowrap shrink-0 cursor-pointer ${
                    editTool === 'draw_box'
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <SquareDashedMousePointer className="w-3.5 h-3.5" />
                  {editTool === 'draw_box' ? 'Drag Map Box...' : 'Draw Area Box'}
                </button>

                <button
                  type="button"
                  onClick={() => setFitTrigger((n) => n + 1)}
                  className="pointer-events-auto px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium flex items-center gap-1 shadow-sm whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  Fit Box
                </button>

                {cachedRegions.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => void handleLoadCachedRegion(e.target.value)}
                    className="pointer-events-auto px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-700 max-w-[175px] shadow-sm"
                  >
                    <option value="">Cached Areas...</option>
                    {cachedRegions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.poisCount} POIs)
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  disabled={isBusy}
                  onClick={handleScanButtonClick}
                  className="pointer-events-auto ml-auto px-4 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 shadow-sm whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Crosshair className="w-3.5 h-3.5" />
                  )}
                  {isBusy ? 'Scanning Region...' : 'Scan Area & Continue'}
                </button>
              </div>
            )}
          </div>

          {/* STEPS 2-5 RIGHT/BELOW INSPECTOR SIDEBAR (never overlaps the map) */}
          {activeStep !== 'area' && (
            <aside className="w-full lg:w-[375px] xl:w-[400px] lg:h-full lg:overflow-y-auto border-t lg:border-t-0 lg:border-l border-slate-200 bg-white shrink-0">
              <StepSidebar
                step={activeStep}
                board={board}
                pipeline={pipeline}
                geminiAvailable={geminiAvailable}
                isBusy={isBusy}
                isSaving={isSaving}
                editTool={editTool}
                newWaypointKind={newWaypointKind}
                movingLocationId={movingLocationId}
                linkSourceId={linkSourceId}
                selectedLocationId={selectedLocationId}
                selectedCorridorId={selectedCorridorId}
                selectedCorridorWaypointIdx={selectedCorridorWaypointIdx}
                selectedRouteId={selectedRouteId}
                selectedWaypointIdx={selectedWaypointIdx}
                selectedTicketId={selectedTicketId}
                showRejectedCorridors={showRejectedCorridors}
                dirtyStopCount={dirtyStopIds.length}
                onSetEditTool={(t) => {
                  setEditTool(t);
                  setLinkSourceId(null);
                }}
                onSetNewWaypointKind={setNewWaypointKind}
                onSetShowRejectedCorridors={setShowRejectedCorridors}
                onArmMoveLocation={(id) => {
                  setMovingLocationId(id);
                  if (id) setEditTool('select');
                }}
                onSelectLocationId={(id) => {
                  if (!id) {
                    setSelectedLocationId(null);
                    setMovingLocationId(null);
                    return;
                  }
                  if (activeStep === 'locations') {
                    handleSelectOrToggleCandidateLocation(id);
                  } else {
                    setSelectedLocationId(id);
                  }
                }}
                onSelectCorridorId={(id) => {
                  setSelectedCorridorId(id);
                  setSelectedCorridorWaypointIdx(null);
                }}
                onSelectRouteId={(id) => {
                  setSelectedRouteId(id);
                  setSelectedWaypointIdx(null);
                }}
                onSelectTicketId={setSelectedTicketId}
                onUpdateStep2Settings={(patch: Partial<Step2LocationSettings>) => {
                  updateActiveGeneration((_g, curP, curB) => ({
                    pipeline: {
                      ...curP,
                      locations: {
                        ...curP.locations,
                        settings: { ...curP.locations.settings, ...patch },
                      },
                    },
                    board: curB,
                  }));
                }}
                onRunStep2Auto={() => void handleRunStep2Auto()}
                onRescanArea={() =>
                  void executeScanArea(
                    pipeline.area.bbox,
                    pipeline.area.zoom,
                    pipeline.area.regionLabel,
                    false,
                    true
                  )
                }
                onToggleCandidateLocation={handleToggleCandidate}
                onUpdateCandidateLocation={handleUpdateCandidate}
                onRequestDeleteStop={handleRequestDeleteStop}
                onUpdateStep3Settings={(patch: Partial<Step3CorridorSettings>) => {
                  updateActiveGeneration((_g, curP, curB) => ({
                    pipeline: {
                      ...curP,
                      corridors: {
                        ...curP.corridors,
                        settings: { ...curP.corridors.settings, ...patch },
                      },
                    },
                    board: curB,
                  }));
                }}
                onRunStep3Auto={handleRunStep3Auto}
                onRefreshNearChangedStops={() =>
                  void fetchCorridorsNearStopsAndSync(dirtyStopIds, true)
                }
                onToggleCorridor={handleToggleCorridor}
                onUpdateCorridor={(id, patch) => handleUpdateCorridor(id, patch, true)}
                onToggleCorridorWaypointKind={handleToggleCorridorWaypointKind}
                onDeleteCorridorWaypoint={handleDeleteCorridorWaypoint}
                onClearCorridorWaypoints={(id) =>
                  handleUpdateCorridor(id, { pathType: 'line', waypoints: undefined }, true)
                }
                onDeleteCorridor={handleDeleteCorridor}
                onUpdateStep4Settings={(patch: Partial<Step4RouteSettings>) => {
                  updateActiveGeneration((_g, curP, curB) => ({
                    pipeline: {
                      ...curP,
                      routes: {
                        ...curP.routes,
                        settings: { ...curP.routes.settings, ...patch },
                      },
                    },
                    board: curB,
                  }));
                }}
                onRunStep4Auto={handleRunStep4Auto}
                onUpdateRoute={(id, patch) => handleUpdateRoute(id, patch, true)}
                onToggleRouteWaypointKind={handleToggleRouteWaypointKind}
                onDeleteRouteWaypoint={handleDeleteRouteWaypoint}
                onResetRouteToCorridor={handleResetRouteToCorridor}
                onClearRouteWaypoints={(id) =>
                  handleUpdateRoute(
                    id,
                    { pathType: 'line', waypoints: undefined, curveOffset: 0, customWaypoints: true },
                    true
                  )
                }
                onDeleteRoute={handleDeleteRoute}
                onUpdateStep5Settings={(patch: Partial<Step5TicketSettings>) => {
                  updateActiveGeneration((_g, curP, curB) => ({
                    pipeline: {
                      ...curP,
                      tickets: {
                        ...curP.tickets,
                        settings: { ...curP.tickets.settings, ...patch },
                      },
                    },
                    board: curB,
                  }));
                }}
                onRunStep5Auto={handleRunStep5Auto}
                onRecalculateTickets={handleRecalculateTickets}
                onAddManualTicket={handleAddManualTicket}
                onUpdateTicket={(id, patch) => {
                  updateActiveGeneration((_g, curP, curB) => {
                    const nextP: GenerationPipelineState = {
                      ...curP,
                      tickets: {
                        ...curP.tickets,
                        items: curP.tickets.items.map((t) =>
                          t.id === id ? { ...t, ...patch } : t
                        ),
                      },
                    };
                    return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
                  }, 'Edit Ticket');
                }}
                onDeleteTicket={(id) => {
                  updateActiveGeneration((_g, curP, curB) => {
                    const nextP: GenerationPipelineState = {
                      ...curP,
                      tickets: {
                        ...curP.tickets,
                        items: curP.tickets.items.filter((t) => t.id !== id),
                      },
                    };
                    return { pipeline: nextP, board: syncBoardFromPipeline(curB, nextP) };
                  }, 'Delete Ticket');
                }}
                onUpdateBoardMeta={(patch) => {
                  updateActiveGeneration((_g, curP, curB) => ({
                    pipeline: {
                      ...curP,
                      area: {
                        ...curP.area,
                        regionLabel: patch.regionLabel ?? curP.area.regionLabel,
                      },
                    },
                    board: {
                      ...curB,
                      name: patch.name ?? curB.name,
                      regionLabel: patch.regionLabel ?? curB.regionLabel,
                      theme: patch.theme ?? curB.theme,
                    },
                  }));
                  if (patch.name !== undefined) {
                    setWorkspace((cur) => ({ ...cur, name: patch.name! }));
                  }
                }}
                onUpdateBakedRules={(patch: Partial<GameRules>) => {
                  updateActiveGeneration((_g, curP, curB) => {
                    const merged = normalizeGameRules(
                      { ...curB.defaultRules, ...patch },
                      curB
                    );
                    return {
                      pipeline: curP,
                      board: { ...curB, defaultRules: merged },
                    };
                  }, 'Update Baked Rules');
                }}
                onSaveToLibrary={() => void handleSaveToLibrary()}
                onHostGame={() => void handleHostGame()}
                onNextStep={() => {
                  const order: PipelineStepId[] = [
                    'area',
                    'locations',
                    'corridors',
                    'routes',
                    'tickets',
                  ];
                  const idx = order.indexOf(activeStep);
                  if (idx >= 0 && idx < order.length - 1) {
                    goToStep(order[idx + 1]);
                  }
                }}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
};
