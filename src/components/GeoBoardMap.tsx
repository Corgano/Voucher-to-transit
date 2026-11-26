import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import type {
  BoardDefinition,
  BoardLocation,
  BoardRoute,
  BoundingBox,
  ClaimedRouteState,
  GenerationStageArtifact,
  InfrastructureOverlayVisibility,
  PipelineCorridorCandidate,
  PipelineLocationCandidate,
  PipelineStepId,
  PlayerColor,
  RawTransitCorridor,
  SpotLookupMatch,
  StageEdgeSnapshot,
  WaypointKind,
} from '../shared/types';
import { PLAYER_COLOR_HEX, ROUTE_COLOR_HEX } from '../shared/benchmarks';
import {
  findBestWaypointInsertIndex,
  formatScaleRatio,
  metersPerPixelAt,
  resolveEffectivePathType,
  resolveEffectiveWaypoints,
  sampleGenericPath,
  TRAIN_TO_CIRCLE_RATIO,
  TRAIN_WIDTH_TO_CIRCLE_RATIO,
} from '../shared/geoScale';
import { BOARD_THEMES } from '../lib/theme';
import {
  computeBoardLaneLayouts,
  type ComputedLaneLayout,
} from '../lib/routeLayout';
import {
  LocomotiveSilhouette,
  RouteColorSymbol,
  TunnelPortalBadge,
} from './RouteSymbolSvg';

/**
 * Module-scoped debug verbosity level:
 * 0 = errors only, 1 = major actions, 2 = light debug, 3 = verbose, 4 = spam.
 */
const GEO_MAP_DEBUG_LEVEL = 0;

interface BaseTileStyleOption {
  id: string;
  label: string;
  detailHint: string;
  url: string;
  attribution: string;
  subdomains?: string;
  maxZoom: number;
}

const BASE_TILE_STYLES: BaseTileStyleOption[] = [
  {
    id: 'osm_standard',
    label: 'OSM Standard',
    detailHint: 'Full roads, labels & transit',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    id: 'carto_light',
    label: 'Positron Light',
    detailHint: 'Low-clutter clean light map',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  {
    id: 'carto_nolabels',
    label: 'Positron Clean',
    detailHint: 'Ultra-minimal, zero labels',
    url: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  {
    id: 'esri_gray',
    label: 'ESRI Light Gray',
    detailHint: 'Subtle monochrome canvas',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 16,
  },
  {
    id: 'carto_voyager',
    label: 'Voyager Soft',
    detailHint: 'Balanced muted street base',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  {
    id: 'esri_topo',
    label: 'ESRI Topo',
    detailHint: 'Terrain relief & highways',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
  {
    id: 'carto_dark',
    label: 'Dark Matter',
    detailHint: 'High-contrast dark slate',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
  },
];

const BASE_TILE_STORAGE_KEY = 'ttr_geo_basemap_style';
const GRID_OPACITY_STORAGE_KEY = 'ttr_geo_grid_opacity';

export type StudioEditTool =
  | 'select'
  | 'add_route'
  | 'add_stop'
  | 'draw_box'
  | 'discover_box'
  | 'add_waypoint';

export interface ManualStopLookupState {
  stopId: string;
  lat: number;
  lng: number;
  loading: boolean;
  matches: SpotLookupMatch[];
}

interface GeoBoardMapProps {
  board: BoardDefinition;
  mode: 'editor' | 'play';
  activeBbox?: BoundingBox;
  editTool?: StudioEditTool;
  newWaypointKind?: WaypointKind;
  selectedLocationId?: string | null;
  selectedRouteId?: string | null;
  selectedHazardRouteId?: string | null;
  selectedWaypointIdx?: number | null;
  selectedCorridorWaypointIdx?: number | null;
  selectedArea?: boolean;
  movingLocationId?: string | null;
  linkSourceId?: string | null;
  highlightedLocationIds?: Set<string>;
  claimedRoutes?: Record<string, ClaimedRouteState>;
  doubleRoutesAllowed?: boolean;
  builtStations?: Record<string, string>;
  playerColorsById?: Record<string, PlayerColor>;
  stationModeActive?: boolean;
  fitTrigger?: number;
  stepMode?: PipelineStepId;
  candidateLocations?: PipelineLocationCandidate[];
  candidateCorridors?: PipelineCorridorCandidate[];
  rawCorridors?: RawTransitCorridor[];
  infraVisibility?: InfrastructureOverlayVisibility;
  selectedCorridorId?: string | null;
  highlightedRouteIds?: Set<string>;
  showRejectedCorridors?: boolean;
  stageOverlay?: GenerationStageArtifact | null;
  selectedStageEdgeId?: string | null;
  manualStopLookup?: ManualStopLookupState | null;
  onToggleInfraLayer?: (mode: keyof InfrastructureOverlayVisibility) => void;
  onDiscoverBox?: (bbox: BoundingBox) => void;
  onPickManualStopMatch?: (stopId: string, match: SpotLookupMatch) => void;
  onDismissManualStopLookup?: () => void;
  onSelectStageEdge?: (edge: StageEdgeSnapshot) => void;
  onSelectCandidateLocation?: (cand: PipelineLocationCandidate) => void;
  onSelectCorridor?: (corr: PipelineCorridorCandidate) => void;
  onSelectCorridorWaypoint?: (corridorId: string, index: number) => void;
  onUpdateCorridorWaypoint?: (
    corridorId: string,
    waypointIdx: number,
    latLng: { lat: number; lng: number }
  ) => void;
  onInsertCorridorWaypoint?: (
    corridorId: string,
    latLng: { lat: number; lng: number },
    kind?: WaypointKind,
    insertIndex?: number
  ) => void;
  onToggleCorridorWaypointKind?: (corridorId: string, waypointIdx: number) => void;
  onDeleteCorridorWaypoint?: (corridorId: string, waypointIdx: number) => void;
  onChangeBbox?: (bbox: BoundingBox) => void;
  onSelectArea?: () => void;
  onSelectLocation?: (loc: BoardLocation) => void;
  onMoveLocationLatLng?: (id: string, lat: number, lng: number) => void;
  onTapRelocateLocation?: (id: string, lat: number, lng: number) => void;
  onDragStart?: (kind: DragTarget['kind']) => void;
  onDragEnd?: (kind: DragTarget['kind']) => void;
  onAddStopLatLng?: (lat: number, lng: number) => void;
  onSelectRoute?: (route: BoardRoute, lane: 'laneA' | 'laneB' | 'laneC') => void;
  onSelectHazard?: (route: BoardRoute) => void;
  onMoveHazardLatLng?: (routeId: string, lat: number, lng: number) => void;
  onSelectWaypoint?: (routeId: string, index: number) => void;
  onUpdateRouteWaypoint?: (
    routeId: string,
    waypointIdx: number,
    latLng: { lat: number; lng: number }
  ) => void;
  onInsertRouteWaypoint?: (
    routeId: string,
    latLng: { lat: number; lng: number },
    kind?: WaypointKind,
    insertIndex?: number
  ) => void;
  onToggleRouteWaypointKind?: (routeId: string, waypointIdx: number) => void;
  onDeleteRouteWaypoint?: (routeId: string, waypointIdx: number) => void;
  onZoomChange?: (zoom: number) => void;
  onClearSelection?: () => void;
}

type DragTarget =
  | { kind: 'city'; id: string }
  | { kind: 'waypoint'; routeId: string; index: number }
  | { kind: 'corridor_waypoint'; corridorId: string; index: number }
  | { kind: 'hazard'; routeId: string }
  | { kind: 'box_edge'; edge: 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' }
  | { kind: 'draw_box'; startLatLng: { lat: number; lng: number } }
  | { kind: 'discover_box'; startLatLng: { lat: number; lng: number } };

type MapContextMenuState =
  | {
      kind: 'corridor_line';
      x: number;
      y: number;
      corridorId: string;
      latLng: { lat: number; lng: number };
      insertIndex: number;
    }
  | {
      kind: 'corridor_point';
      x: number;
      y: number;
      corridorId: string;
      index: number;
      currentKind: WaypointKind;
    }
  | {
      kind: 'route_line';
      x: number;
      y: number;
      routeId: string;
      latLng: { lat: number; lng: number };
      insertIndex: number;
    }
  | {
      kind: 'route_point';
      x: number;
      y: number;
      routeId: string;
      index: number;
      currentKind: WaypointKind;
    };

/**
 * Maps a transit mode to its crisp high-contrast stroke color used for active corridors & infrastructure layers.
 * Call with transport mode string ('train' | 'ferry' | 'bus' | 'highway').
 * Returns hex color string.
 */
function modeStrokeHex(modeName: string): string {
  switch (modeName) {
    case 'train':
      return '#1D4ED8';
    case 'ferry':
      return '#0D9488';
    case 'bus':
      return '#059669';
    case 'highway':
    default:
      return '#B45309';
  }
}

/**
 * Interactive Leaflet-synchronized geographic game board & pipeline canvas.
 * Supports safe right-click-and-drag map panning anywhere, right-click composite waypoint editing,
 * global detected infrastructure layer toggles, box-discovery in Step 2, and manual stop OSM lookup popups.
 */
export const GeoBoardMap: React.FC<GeoBoardMapProps> = ({
  board,
  mode,
  activeBbox,
  editTool = 'select',
  newWaypointKind = 'curve',
  selectedLocationId,
  selectedRouteId,
  selectedHazardRouteId,
  selectedWaypointIdx,
  selectedCorridorWaypointIdx,
  selectedArea = false,
  movingLocationId = null,
  linkSourceId,
  highlightedLocationIds,
  claimedRoutes = {},
  doubleRoutesAllowed = true,
  builtStations = {},
  playerColorsById = {},
  stationModeActive = false,
  fitTrigger = 0,
  stepMode,
  candidateLocations,
  candidateCorridors,
  rawCorridors,
  infraVisibility,
  selectedCorridorId = null,
  highlightedRouteIds,
  showRejectedCorridors = true,
  stageOverlay = null,
  selectedStageEdgeId = null,
  manualStopLookup = null,
  onToggleInfraLayer,
  onDiscoverBox,
  onPickManualStopMatch,
  onDismissManualStopLookup,
  onSelectStageEdge,
  onSelectCandidateLocation,
  onSelectCorridor,
  onSelectCorridorWaypoint,
  onUpdateCorridorWaypoint,
  onInsertCorridorWaypoint,
  onToggleCorridorWaypointKind,
  onDeleteCorridorWaypoint,
  onChangeBbox,
  onSelectArea,
  onSelectLocation,
  onMoveLocationLatLng,
  onTapRelocateLocation,
  onDragStart,
  onDragEnd,
  onAddStopLatLng,
  onSelectRoute,
  onSelectHazard,
  onMoveHazardLatLng,
  onSelectWaypoint,
  onUpdateRouteWaypoint,
  onInsertRouteWaypoint,
  onToggleRouteWaypointKind,
  onDeleteRouteWaypoint,
  onZoomChange,
  onClearSelection,
}) => {
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const onDiscoverBoxRef = useRef(onDiscoverBox);
  onDiscoverBoxRef.current = onDiscoverBox;

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panGroupRef = useRef<SVGGElement | null>(null);
  const initialFitDoneRef = useRef(false);
  const wheelAccumRef = useRef(0);
  const renderAnchorRef = useRef<{
    lat: number;
    lng: number;
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const pointerDownScreenRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = useRef(false);

  // Right-click-and-drag panning state stored in refs for zero-latency movement + suppress context menu after pan
  const rightPanRef = useRef<{
    active: boolean;
    dragging: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  }>({ active: false, dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0 });
  const suppressContextUntilRef = useRef(0);

  const [mapState, setMapState] = useState<{
    zoom: number;
    tick: number;
    width: number;
    height: number;
  }>({
    zoom: board.zoom || 10,
    tick: 0,
    width: 1000,
    height: 700,
  });
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [discoverDraftBox, setDiscoverDraftBox] = useState<BoundingBox | null>(null);
  const discoverDraftBoxRef = useRef<BoundingBox | null>(null);
  discoverDraftBoxRef.current = discoverDraftBox;

  const [isRightPanning, setIsRightPanning] = useState(false);
  const [hoveredRouteKey, setHoveredRouteKey] = useState<string | null>(null);
  const [hoveredCorridorId, setHoveredCorridorId] = useState<string | null>(null);
  const [layersMenuOpen, setLayersMenuOpen] = useState(false);
  const [showScaleGrid, setShowScaleGrid] = useState(true);
  const [gridOpacityPct, setGridOpacityPct] = useState<number>(() => {
    try {
      const saved =
        typeof window !== 'undefined' ? window.localStorage.getItem(GRID_OPACITY_STORAGE_KEY) : null;
      if (saved !== null) {
        const parsed = Math.round(Number(saved));
        if (Number.isFinite(parsed) && parsed >= 5 && parsed <= 100) return parsed;
      }
    } catch {
      // Ignore storage access restrictions
    }
    return 40;
  });
  const [baseStyleId, setBaseStyleId] = useState<string>(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(BASE_TILE_STORAGE_KEY) : null;
      if (saved && BASE_TILE_STYLES.some((s) => s.id === saved)) return saved;
    } catch {
      // Ignore storage access restrictions
    }
    return BASE_TILE_STYLES[0].id;
  });
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const didInitTileRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<MapContextMenuState | null>(null);

  const activeTileStyle = useMemo(
    () => BASE_TILE_STYLES.find((s) => s.id === baseStyleId) || BASE_TILE_STYLES[0],
    [baseStyleId]
  );

  const cycleTileStyle = (delta: number) => {
    const idx = BASE_TILE_STYLES.findIndex((s) => s.id === activeTileStyle.id);
    const nextIdx = (idx + delta + BASE_TILE_STYLES.length) % BASE_TILE_STYLES.length;
    setBaseStyleId(BASE_TILE_STYLES[nextIdx].id);
  };

  const palette = BOARD_THEMES[board.theme] || BOARD_THEMES.vintage;
  const displayBbox = activeBbox || board.bbox;

  // Initialize Leaflet map once with ResizeObserver & synchronous pan transform
  useEffect(() => {
    if (!mapDivRef.current || !wrapperRef.current) return;
    const map = L.map(mapDivRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 2,
      maxZoom: 18,
    });

    const initialStyle = BASE_TILE_STYLES.find((s) => s.id === baseStyleId) || BASE_TILE_STYLES[0];
    const layer = L.tileLayer(initialStyle.url, {
      maxZoom: initialStyle.maxZoom,
      attribution: initialStyle.attribution,
      ...(initialStyle.subdomains ? { subdomains: initialStyle.subdomains } : {}),
    }).addTo(map);
    tileLayerRef.current = layer;

    const sync = () => {
      const el = wrapperRef.current;
      const size = map.getSize();
      const w = size.x > 0 ? size.x : el?.clientWidth || 1000;
      const h = size.y > 0 ? size.y : el?.clientHeight || 700;
      const currentZoom = map.getZoom();
      onZoomChangeRef.current?.(currentZoom);
      setMapState((prev) => ({
        zoom: currentZoom,
        tick: prev.tick + 1,
        width: w,
        height: h,
      }));
    };

    const onMove = () => {
      const anchor = renderAnchorRef.current;
      const g = panGroupRef.current;
      if (anchor && g && map.getZoom() === anchor.zoom) {
        const pt = map.latLngToContainerPoint([anchor.lat, anchor.lng]);
        const dx = pt.x - anchor.x;
        const dy = pt.y - anchor.y;
        g.setAttribute('transform', `translate(${dx}, ${dy})`);
        return;
      }
      sync();
    };

    const fitToBoard = () => {
      const el = wrapperRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      map.invalidateSize({ animate: false });
      map.fitBounds(
        [
          [board.bbox.south, board.bbox.west],
          [board.bbox.north, board.bbox.east],
        ],
        { padding: [24, 24], animate: false }
      );
      initialFitDoneRef.current = true;
      sync();
    };

    map.on('move', onMove);
    map.on('zoom moveend zoomend viewreset resize', sync);
    mapRef.current = map;

    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      if (!initialFitDoneRef.current) {
        fitToBoard();
      } else {
        sync();
      }
    });
    ro.observe(wrapperRef.current);

    requestAnimationFrame(() => {
      fitToBoard();
    });

    return () => {
      ro.disconnect();
      map.off('move', onMove);
      map.off('zoom moveend zoomend viewreset resize', sync);
      tileLayerRef.current = null;
      didInitTileRef.current = false;
      map.remove();
      mapRef.current = null;
      initialFitDoneRef.current = false;
    };
  }, []);

  // Persist scale grid opacity preference
  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_OPACITY_STORAGE_KEY, String(gridOpacityPct));
    } catch {
      // Ignore storage failures
    }
  }, [gridOpacityPct]);

  // Swap Leaflet base tile layer cleanly whenever the user switches map tile styles
  useEffect(() => {
    try {
      window.localStorage.setItem(BASE_TILE_STORAGE_KEY, activeTileStyle.id);
    } catch {
      // Ignore storage failures
    }
    if (!didInitTileRef.current) {
      didInitTileRef.current = true;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const prevLayer = tileLayerRef.current;
    const nextLayer = L.tileLayer(activeTileStyle.url, {
      maxZoom: activeTileStyle.maxZoom,
      attribution: activeTileStyle.attribution,
      ...(activeTileStyle.subdomains ? { subdomains: activeTileStyle.subdomains } : {}),
    }).addTo(map);
    nextLayer.bringToBack();
    tileLayerRef.current = nextLayer;
    if (prevLayer && prevLayer !== nextLayer) {
      map.removeLayer(prevLayer);
    }
  }, [activeTileStyle]);

  // Capture ALL mouse wheel / trackpad scroll over the map container to zoom smoothly
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const map = mapRef.current;
      if (!map) return;

      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 32;
      else if (e.deltaMode === 2) dy *= 300;

      wheelAccumRef.current += dy;
      if (Math.abs(wheelAccumRef.current) < 18) return;

      const notches =
        Math.abs(wheelAccumRef.current) >= 75
          ? Math.trunc(wheelAccumRef.current / 75)
          : wheelAccumRef.current > 0
            ? 1
            : -1;
      wheelAccumRef.current = 0;

      const curZoom = map.getZoom();
      const nextZoom = Math.max(
        map.getMinZoom(),
        Math.min(map.getMaxZoom(), curZoom - notches * 0.25)
      );
      if (Math.abs(nextZoom - curZoom) < 0.01) return;

      const rect = el.getBoundingClientRect();
      const pt = L.point(e.clientX - rect.left, e.clientY - rect.top);
      map.setZoomAround(pt, nextZoom, { animate: false });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Global safe right-click-and-drag panning listener (never moves/selects SVG features)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const onWinMove = (e: PointerEvent) => {
      if (!rightPanRef.current.active) return;
      const distStart = Math.hypot(
        e.clientX - rightPanRef.current.startX,
        e.clientY - rightPanRef.current.startY
      );
      if (!rightPanRef.current.dragging && distStart >= 4) {
        rightPanRef.current.dragging = true;
        setIsRightPanning(true);
        setContextMenu(null);
      }
      if (rightPanRef.current.dragging && mapRef.current) {
        const dx = rightPanRef.current.lastX - e.clientX;
        const dy = rightPanRef.current.lastY - e.clientY;
        if (dx !== 0 || dy !== 0) {
          mapRef.current.panBy([dx, dy], { animate: false });
        }
      }
      rightPanRef.current.lastX = e.clientX;
      rightPanRef.current.lastY = e.clientY;
    };

    const onWinUp = (e: PointerEvent) => {
      if (!rightPanRef.current.active) return;
      if (rightPanRef.current.dragging) {
        suppressContextUntilRef.current = performance.now() + 260;
        if (GEO_MAP_DEBUG_LEVEL >= 2) {
          console.debug('[GeoBoardMap] finished right-click map pan');
        }
      }
      rightPanRef.current.active = false;
      rightPanRef.current.dragging = false;
      setIsRightPanning(false);
      if (e.button === 2) {
        pointerDownScreenRef.current = null;
      }
    };

    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinUp);
    return () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinUp);
    };
  }, []);

  // Dismiss any open waypoint context menu on Space / Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || targetEl?.isContentEditable) {
        return;
      }
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  // Click empty map background (without dragging): relocate armed stop, add waypoint, or deselect
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMapClick = (ev: L.LeafletMouseEvent) => {
      setContextMenu(null);
      if (dragTarget || performance.now() < suppressContextUntilRef.current) return;
      if (mode === 'editor' && editTool === 'select' && movingLocationId && onTapRelocateLocation) {
        onTapRelocateLocation(movingLocationId, ev.latlng.lat, ev.latlng.lng);
        return;
      }
      if (onClearSelection && (mode !== 'editor' || editTool === 'select')) {
        onClearSelection();
      }
    };
    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
  }, [mode, editTool, movingLocationId, dragTarget, onTapRelocateLocation, onClearSelection]);

  // Apply board theme filter directly to Leaflet tile pane
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const tilePane = map.getPane('tilePane');
    if (!tilePane) return;
    if (board.theme === 'vintage') {
      tilePane.style.filter = 'sepia(0.55) saturate(0.72) contrast(0.95) brightness(1.03)';
    } else if (board.theme === 'dark') {
      tilePane.style.filter =
        'invert(1) hue-rotate(180deg) brightness(0.84) contrast(1.08) saturate(0.35)';
    } else {
      tilePane.style.filter = 'saturate(0.32) brightness(1.07) contrast(0.94)';
    }
  }, [board.theme]);

  // Fit bounds when explicitly triggered
  useEffect(() => {
    const map = mapRef.current;
    const el = wrapperRef.current;
    if (!map || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
    map.invalidateSize({ animate: false });
    const target = activeBbox || board.bbox;
    map.fitBounds(
      [
        [target.south, target.west],
        [target.north, target.east],
      ],
      { padding: [24, 24], animate: false }
    );
  }, [board.id, fitTrigger]);

  // Toggle Leaflet left-click dragging during custom box/node/waypoint drags or placement modes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (dragTarget || editTool === 'draw_box' || editTool === 'discover_box') {
      map.dragging.disable();
    } else {
      map.dragging.enable();
    }
  }, [dragTarget, editTool]);

  // Close context menu cleanly on zoom/scroll
  useEffect(() => {
    setContextMenu(null);
  }, [mapState.zoom, stepMode]);

  // Sync pan-group baseline anchor after React commits updated projections
  useLayoutEffect(() => {
    const map = mapRef.current;
    const g = panGroupRef.current;
    if (g) g.setAttribute('transform', '');
    if (map) {
      const c = map.getCenter();
      const pt = map.latLngToContainerPoint(c);
      renderAnchorRef.current = {
        lat: c.lat,
        lng: c.lng,
        x: pt.x,
        y: pt.y,
        zoom: map.getZoom(),
      };
    }
  });

  const locMap = useMemo(() => {
    const m = new Map<string, BoardLocation>();
    for (const loc of board.locations) m.set(loc.id, loc);
    return m;
  }, [board.locations]);

  const candLocMap = useMemo(() => {
    const m = new Map<string, PipelineLocationCandidate>();
    for (const c of candidateLocations || []) m.set(c.id, c);
    return m;
  }, [candidateLocations]);

  // Exact real-world pixel dimensions at current map zoom:
  // Train length = 250% of city circle diameter; Train width = 80% of circle diameter.
  const centerLat = (board.bbox.south + board.bbox.north) / 2;
  const mpp = metersPerPixelAt(centerLat, mapState.zoom);
  const rawTrainLenPx = board.metersPerTrain / Math.max(0.01, mpp);
  const trainLenPx = Math.max(7.5, rawTrainLenPx);
  const circleDiamPx = trainLenPx / TRAIN_TO_CIRCLE_RATIO;
  const circleRadiusPx = circleDiamPx / 2;
  const trainWidthPx = circleDiamPx * TRAIN_WIDTH_TO_CIRCLE_RATIO;

  const projectLatLng = (lat: number, lng: number): { x: number; y: number } => {
    const map = mapRef.current;
    if (!map) return { x: 0, y: 0 };
    const pt = map.latLngToContainerPoint([lat, lng]);
    return { x: pt.x, y: pt.y };
  };

  const getContainerPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current || wrapperRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const getContainerLatLng = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    const pt = getContainerPoint(clientX, clientY);
    if (!map || !pt) return null;
    return map.containerPointToLatLng([pt.x, pt.y]);
  };

  const applyDragLatLng = (lat: number, lng: number, target: DragTarget) => {
    if (target.kind === 'city' && onMoveLocationLatLng) {
      onMoveLocationLatLng(target.id, lat, lng);
    } else if (target.kind === 'waypoint' && onUpdateRouteWaypoint) {
      onUpdateRouteWaypoint(target.routeId, target.index, { lat, lng });
    } else if (target.kind === 'corridor_waypoint' && onUpdateCorridorWaypoint) {
      onUpdateCorridorWaypoint(target.corridorId, target.index, { lat, lng });
    } else if (target.kind === 'hazard' && onMoveHazardLatLng) {
      onMoveHazardLatLng(target.routeId, lat, lng);
    } else if (target.kind === 'box_edge' && onChangeBbox) {
      const next = { ...displayBbox };
      const minSpan = 0.002;
      if (target.edge.includes('n')) next.north = Math.max(next.south + minSpan, lat);
      if (target.edge.includes('s')) next.south = Math.min(next.north - minSpan, lat);
      if (target.edge.includes('e')) next.east = Math.max(next.west + minSpan, lng);
      if (target.edge.includes('w')) next.west = Math.min(next.east - minSpan, lng);
      onChangeBbox(next);
    } else if (target.kind === 'draw_box' && onChangeBbox) {
      const s = target.startLatLng;
      onChangeBbox({
        south: Math.min(s.lat, lat),
        north: Math.max(s.lat, lat),
        west: Math.min(s.lng, lng),
        east: Math.max(s.lng, lng),
      });
    } else if (target.kind === 'discover_box') {
      const s = target.startLatLng;
      setDiscoverDraftBox({
        south: Math.min(s.lat, lat),
        north: Math.max(s.lat, lat),
        west: Math.min(s.lng, lng),
        east: Math.max(s.lng, lng),
      });
    }
  };

  useEffect(() => {
    if (!dragTarget || mode !== 'editor') return;
    const onWinMove = (ev: PointerEvent) => {
      const ll = getContainerLatLng(ev.clientX, ev.clientY);
      if (ll) applyDragLatLng(ll.lat, ll.lng, dragTarget);
    };
    const onWinUp = () => {
      const endedKind = dragTarget.kind;
      if (endedKind === 'discover_box') {
        const finalBox = discoverDraftBoxRef.current;
        setDiscoverDraftBox(null);
        if (
          finalBox &&
          finalBox.north - finalBox.south > 0.0005 &&
          finalBox.east - finalBox.west > 0.0005
        ) {
          onDiscoverBoxRef.current?.(finalBox);
        }
      }
      setDragTarget(null);
      onDragEnd?.(endedKind);
    };
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    return () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
    };
  }, [dragTarget, mode, displayBbox, onDragEnd]);

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    setContextMenu(null);
    pointerDownScreenRef.current = { x: e.clientX, y: e.clientY };
    pointerMovedRef.current = false;
    if (mode !== 'editor') return;
    const ll = getContainerLatLng(e.clientX, e.clientY);
    if (!ll) return;

    if (editTool === 'add_stop' && onAddStopLatLng) {
      e.stopPropagation();
      onAddStopLatLng(ll.lat, ll.lng);
      return;
    }

    if (editTool === 'add_waypoint') {
      if (stepMode === 'corridors' && selectedCorridorId && onInsertCorridorWaypoint) {
        const corr = candidateCorridors?.find((c) => c.id === selectedCorridorId);
        const a = corr ? candLocMap.get(corr.fromId) || locMap.get(corr.fromId) : undefined;
        const b = corr ? candLocMap.get(corr.toId) || locMap.get(corr.toId) : undefined;
        if (corr && a && b) {
          e.stopPropagation();
          const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
          const effAnchors = resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset);
          const clickCoord = { lat: ll.lat, lng: ll.lng };
          const insertIdx = findBestWaypointInsertIndex(a, b, effAnchors, clickCoord, effType);
          onInsertCorridorWaypoint(corr.id, clickCoord, newWaypointKind, insertIdx);
          return;
        }
      } else if (stepMode === 'routes' && selectedRouteId && onInsertRouteWaypoint) {
        const rt = board.routes.find((r) => r.id === selectedRouteId);
        const a = rt ? locMap.get(rt.fromId) || candLocMap.get(rt.fromId) : undefined;
        const b = rt ? locMap.get(rt.toId) || candLocMap.get(rt.toId) : undefined;
        if (rt && a && b) {
          e.stopPropagation();
          const effType = resolveEffectivePathType(rt.pathType, rt.waypoints, rt.curveOffset);
          const effAnchors = resolveEffectiveWaypoints(a, b, effType, rt.waypoints, rt.curveOffset);
          const clickCoord = { lat: ll.lat, lng: ll.lng };
          const insertIdx = findBestWaypointInsertIndex(a, b, effAnchors, clickCoord, effType);
          onInsertRouteWaypoint(rt.id, clickCoord, newWaypointKind, insertIdx);
          return;
        }
      }
    }

    if (editTool === 'draw_box' && onChangeBbox) {
      e.stopPropagation();
      onDragStart?.('draw_box');
      setDragTarget({ kind: 'draw_box', startLatLng: { lat: ll.lat, lng: ll.lng } });
      return;
    }

    if (editTool === 'discover_box') {
      e.stopPropagation();
      onDragStart?.('discover_box');
      setDiscoverDraftBox({
        south: ll.lat,
        north: ll.lat,
        west: ll.lng,
        east: ll.lng,
      });
      setDragTarget({ kind: 'discover_box', startLatLng: { lat: ll.lat, lng: ll.lng } });
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (rightPanRef.current.active) return;
    if (pointerDownScreenRef.current) {
      const dist = Math.hypot(
        e.clientX - pointerDownScreenRef.current.x,
        e.clientY - pointerDownScreenRef.current.y
      );
      if (dist >= 6) pointerMovedRef.current = true;
    }
    if (mode !== 'editor' || !dragTarget) return;
    const ll = getContainerLatLng(e.clientX, e.clientY);
    if (!ll) return;
    applyDragLatLng(ll.lat, ll.lng, dragTarget);
  };

  const handleSvgPointerUp = () => {
    if (dragTarget) {
      const endedKind = dragTarget.kind;
      if (endedKind === 'discover_box') {
        const finalBox = discoverDraftBoxRef.current;
        setDiscoverDraftBox(null);
        if (
          finalBox &&
          finalBox.north - finalBox.south > 0.0005 &&
          finalBox.east - finalBox.west > 0.0005
        ) {
          onDiscoverBoxRef.current?.(finalBox);
        }
      }
      setDragTarget(null);
      onDragEnd?.(endedKind);
    }
  };

  // Bounding Box projected corners (Editor Mode)
  const boxNW = projectLatLng(displayBbox.north, displayBbox.west);
  const boxSE = projectLatLng(displayBbox.south, displayBbox.east);
  const boxLeft = Math.min(boxNW.x, boxSE.x);
  const boxRight = Math.max(boxNW.x, boxSE.x);
  const boxTop = Math.min(boxNW.y, boxSE.y);
  const boxBottom = Math.max(boxNW.y, boxSE.y);
  const boxW = Math.max(8, boxRight - boxLeft);
  const boxH = Math.max(8, boxBottom - boxTop);

  // Discover Area Box draft rect projection
  const discRect = discoverDraftBox
    ? (() => {
        const nw = projectLatLng(discoverDraftBox.north, discoverDraftBox.west);
        const se = projectLatLng(discoverDraftBox.south, discoverDraftBox.east);
        return {
          left: Math.min(nw.x, se.x),
          top: Math.min(nw.y, se.y),
          width: Math.max(2, Math.abs(se.x - nw.x)),
          height: Math.max(2, Math.abs(se.y - nw.y)),
        };
      })()
    : null;

  const isPipelineStepOverlay =
    mode === 'editor' &&
    (stepMode === 'area' || stepMode === 'locations' || stepMode === 'corridors');
  const isIntermediateStageOverlay = Boolean(
    !isPipelineStepOverlay && stageOverlay && stageOverlay.key !== 'final_trains_tickets'
  );

  const computedLanes = useMemo(() => {
    if (isPipelineStepOverlay || isIntermediateStageOverlay || mapState.tick === 0 || !mapRef.current) {
      return [] as ComputedLaneLayout[];
    }
    return computeBoardLaneLayouts(
      board.locations,
      board.routes,
      projectLatLng,
      trainLenPx,
      trainWidthPx,
      circleRadiusPx,
      { claimedRoutes, doubleRoutesAllowed }
    );
  }, [
    isPipelineStepOverlay,
    isIntermediateStageOverlay,
    board.locations,
    board.routes,
    board.metersPerTrain,
    mapState.zoom,
    mapState.tick,
    trainLenPx,
    trainWidthPx,
    circleRadiusPx,
    claimedRoutes,
    doubleRoutesAllowed,
  ]);

  const anyInfraVisible = Boolean(
    infraVisibility &&
      (infraVisibility.train ||
        infraVisibility.ferry ||
        infraVisibility.bus ||
        infraVisibility.highway)
  );

  // Visible detected raw OSM infrastructure polylines (drawn strictly underneath active layers on ALL steps)
  const visibleInfraCorridors = useMemo(() => {
    if (!anyInfraVisible || !rawCorridors || rawCorridors.length === 0 || !infraVisibility) {
      return [] as RawTransitCorridor[];
    }
    return rawCorridors.filter((c) => infraVisibility[c.mode] && c.points.length >= 2);
  }, [anyInfraVisible, rawCorridors, infraVisibility]);

  /**
   * Computes faint 1.25-train-length horizontal and vertical scale reference grid lines
   * projected within the active bounding box across all editor steps.
   */
  const scaleGridData = useMemo(() => {
    if (
      mode !== 'editor' ||
      !showScaleGrid ||
      mapState.tick === 0 ||
      !mapRef.current ||
      !board.metersPerTrain ||
      board.metersPerTrain <= 0
    ) {
      return null;
    }
    const stepMeters = board.metersPerTrain * 1.25;
    const midLat = (displayBbox.south + displayBbox.north) * 0.5;
    const midLng = (displayBbox.west + displayBbox.east) * 0.5;
    const mPerDegLat = 111132;
    const mPerDegLng = 111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const stepLat = stepMeters / mPerDegLat;
    const stepLng = stepMeters / mPerDegLng;

    const nw = projectLatLng(displayBbox.north, displayBbox.west);
    const se = projectLatLng(displayBbox.south, displayBbox.east);
    const left = Math.min(nw.x, se.x);
    const right = Math.max(nw.x, se.x);
    const top = Math.min(nw.y, se.y);
    const bottom = Math.max(nw.y, se.y);

    const verticalX: number[] = [];
    const horizontalY: number[] = [];
    const maxLinesPerAxis = 180;

    if (stepLng > 1e-7) {
      for (let k = 1; k <= maxLinesPerAxis; k++) {
        const lng = displayBbox.west + k * stepLng;
        if (lng >= displayBbox.east - stepLng * 0.05) break;
        const p = projectLatLng(midLat, lng);
        verticalX.push(p.x);
      }
    }
    if (stepLat > 1e-7) {
      for (let k = 1; k <= maxLinesPerAxis; k++) {
        const lat = displayBbox.south + k * stepLat;
        if (lat >= displayBbox.north - stepLat * 0.05) break;
        const p = projectLatLng(lat, midLng);
        horizontalY.push(p.y);
      }
    }

    const gridStepPx = trainLenPx * 1.25;
    const baseOpacity = Math.max(0.05, Math.min(1, gridOpacityPct / 100));
    const opacity = gridStepPx < 10 ? Math.max(0.04, baseOpacity * Math.max(0.25, gridStepPx / 10)) : baseOpacity;
    const labelText = `1.25x train (${formatScaleRatio(stepMeters).replace(' / train', '')})`;

    if (GEO_MAP_DEBUG_LEVEL >= 3) {
      console.debug('[GeoBoardMap] scaleGridData computed', {
        stepMeters,
        gridOpacityPct,
        opacity,
        vLines: verticalX.length,
        hLines: horizontalY.length,
      });
    }

    return {
      left,
      right,
      top,
      bottom,
      verticalX,
      horizontalY,
      opacity,
      labelText,
    };
  }, [
    mode,
    stepMode,
    showScaleGrid,
    gridOpacityPct,
    mapState.tick,
    mapState.zoom,
    board.metersPerTrain,
    displayBbox,
    trainLenPx,
  ]);

  const renderComputedLane = (layout: ComputedLaneLayout) => {
    const {
      route,
      lane,
      laneColor,
      slots,
      slotLenPx,
      slotWidthPx,
      hitPathD,
      railsPathD,
      tiesPathD,
    } = layout;

    const claimOwnerId = claimedRoutes[route.id]?.[lane];
    const ownerColor = claimOwnerId ? playerColorsById[claimOwnerId] : undefined;
    const isClaimed = Boolean(claimOwnerId);
    const colorSpec = ROUTE_COLOR_HEX[laneColor] || ROUTE_COLOR_HEX.gray;
    const laneKey = `${route.id}:${lane}`;
    const isHovered = hoveredRouteKey === laneKey;
    const isSelected = mode === 'editor' && selectedRouteId === route.id;
    const isTicketHighlighted = highlightedRouteIds?.has(route.id) ?? false;

    const fillHex = isClaimed && ownerColor ? PLAYER_COLOR_HEX[ownerColor].hex : colorSpec.fill;
    const strokeHex = isClaimed && ownerColor ? '#FFFFFF' : colorSpec.stroke;

    const railStroke =
      isSelected || isHovered || isTicketHighlighted
        ? '#F59E0B'
        : board.theme === 'dark'
          ? '#94A3B8'
          : '#64748B';
    const tieStroke =
      isSelected || isHovered || isTicketHighlighted
        ? '#D97706'
        : board.theme === 'dark'
          ? '#64748B'
          : '#78716C';
    const railStrokeW =
      Math.max(1.0, slotWidthPx * 0.13) + (isSelected || isHovered || isTicketHighlighted ? 0.5 : 0);
    const tieStrokeW = Math.max(0.85, slotWidthPx * 0.11);

    const symbolSize = Math.min(slotWidthPx * 0.72, slotLenPx * 0.34);

    return (
      <g
        key={laneKey}
        className="cursor-pointer pointer-events-auto"
        onMouseEnter={() => setHoveredRouteKey(laneKey)}
        onMouseLeave={() => setHoveredRouteKey(null)}
        onContextMenu={(e) => {
          if (mode !== 'editor' || !onInsertRouteWaypoint) return;
          if (performance.now() < suppressContextUntilRef.current) return;
          e.preventDefault();
          e.stopPropagation();
          const pt = getContainerPoint(e.clientX, e.clientY);
          const ll = getContainerLatLng(e.clientX, e.clientY);
          const a = locMap.get(route.fromId);
          const b = locMap.get(route.toId);
          if (!pt || !ll || !a || !b) return;
          const effType = resolveEffectivePathType(route.pathType, route.waypoints, route.curveOffset);
          const effAnchors = resolveEffectiveWaypoints(a, b, effType, route.waypoints, route.curveOffset);
          const clickCoord = { lat: ll.lat, lng: ll.lng };
          const insertIndex = findBestWaypointInsertIndex(a, b, effAnchors, clickCoord, effType);
          onSelectRoute?.(route, lane);
          setContextMenu({
            kind: 'route_line',
            x: pt.x,
            y: pt.y,
            routeId: route.id,
            latLng: clickCoord,
            insertIndex,
          });
        }}
        onDoubleClick={(e) => {
          if (mode === 'editor' && isSelected && onInsertRouteWaypoint) {
            e.stopPropagation();
            const ll = getContainerLatLng(e.clientX, e.clientY);
            const a = locMap.get(route.fromId);
            const b = locMap.get(route.toId);
            if (ll && a && b) {
              const effType = resolveEffectivePathType(route.pathType, route.waypoints, route.curveOffset);
              const effAnchors = resolveEffectiveWaypoints(a, b, effType, route.waypoints, route.curveOffset);
              const coord = { lat: ll.lat, lng: ll.lng };
              const idx = findBestWaypointInsertIndex(a, b, effAnchors, coord, effType);
              onInsertRouteWaypoint(route.id, coord, newWaypointKind, idx);
            }
          }
        }}
        onClick={(e) => {
          if (e.button !== 0 || pointerMovedRef.current) return;
          e.stopPropagation();
          setContextMenu(null);
          if (mode === 'editor' && (isSelected && (e.shiftKey || editTool === 'add_waypoint')) && onInsertRouteWaypoint) {
            const ll = getContainerLatLng(e.clientX, e.clientY);
            const a = locMap.get(route.fromId);
            const b = locMap.get(route.toId);
            if (ll && a && b) {
              const effType = resolveEffectivePathType(route.pathType, route.waypoints, route.curveOffset);
              const effAnchors = resolveEffectiveWaypoints(a, b, effType, route.waypoints, route.curveOffset);
              const coord = { lat: ll.lat, lng: ll.lng };
              const idx = findBestWaypointInsertIndex(a, b, effAnchors, coord, effType);
              onInsertRouteWaypoint(route.id, coord, newWaypointKind, idx);
            }
            return;
          }
          onSelectRoute?.(route, lane);
        }}
      >
        <path
          d={hitPathD}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(16, slotWidthPx + 12)}
        />

        {tiesPathD && (
          <path
            d={tiesPathD}
            fill="none"
            stroke={tieStroke}
            strokeWidth={tieStrokeW}
            strokeLinecap="round"
            opacity={isSelected || isHovered ? 0.92 : 0.72}
          />
        )}

        {railsPathD && (
          <path
            d={railsPathD}
            fill="none"
            stroke={railStroke}
            strokeWidth={railStrokeW}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={isSelected || isHovered ? 0.98 : 0.85}
          />
        )}

        {slots.map((s) => {
          const rx = Math.max(1.8, slotWidthPx * 0.22);
          const isRainbowLoco = !isClaimed && s.isFerryLoco;
          return (
            <g key={s.idx} transform={`translate(${s.x}, ${s.y}) rotate(${s.angleDeg})`}>
              {route.isTunnel && (
                <rect
                  x={-slotLenPx / 2 - 1.8}
                  y={-slotWidthPx / 2 - 1.8}
                  width={slotLenPx + 3.6}
                  height={slotWidthPx + 3.6}
                  rx={rx + 1.4}
                  fill="none"
                  stroke="#374151"
                  strokeWidth={2.2}
                  strokeDasharray="3.5 1.8"
                />
              )}

              <rect
                x={-slotLenPx / 2}
                y={-slotWidthPx / 2}
                width={slotLenPx}
                height={slotWidthPx}
                rx={rx}
                fill={isRainbowLoco ? 'url(#vtt-rainbow-loco)' : fillHex}
                stroke={isSelected || isHovered ? '#F59E0B' : isRainbowLoco ? '#334155' : strokeHex}
                strokeWidth={isClaimed ? 1.6 : 1.35}
                opacity={isClaimed ? 1 : 0.96}
              />

              {isClaimed && (
                <line
                  x1={-slotLenPx * 0.32}
                  y1={0}
                  x2={slotLenPx * 0.32}
                  y2={0}
                  stroke="#FFFFFF"
                  strokeWidth={Math.max(1.2, slotWidthPx * 0.18)}
                  strokeLinecap="round"
                  opacity={0.9}
                />
              )}

              {isRainbowLoco && (
                <LocomotiveSilhouette
                  len={slotLenPx}
                  width={slotWidthPx}
                  color="#0F172A"
                />
              )}

              {!isClaimed && !isRainbowLoco && symbolSize >= 2.2 && (
                <>
                  <RouteColorSymbol
                    symbol={colorSpec.symbol}
                    size={symbolSize}
                    color={colorSpec.symbolColor}
                    x={route.isTunnel && colorSpec.symbol !== 'none' ? -slotLenPx * 0.16 : 0}
                  />
                  {route.isTunnel && (
                    <TunnelPortalBadge
                      size={symbolSize * 0.95}
                      color={colorSpec.symbol === 'none' ? '#374151' : colorSpec.symbolColor}
                      x={colorSpec.symbol === 'none' ? 0 : slotLenPx * 0.18}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}
      </g>
    );
  };

  // Manual Stop Lookup anchored popup coordinates
  const lookupAnchorPx =
    manualStopLookup && mapState.tick > 0 && mapRef.current
      ? projectLatLng(manualStopLookup.lat, manualStopLookup.lng)
      : null;

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0 overflow-hidden select-none"
      style={{
        backgroundColor: palette.boardBg,
        cursor: isRightPanning ? 'grabbing' : undefined,
      }}
      onPointerDownCapture={(e) => {
        if (e.button === 2) {
          e.stopPropagation();
          rightPanRef.current = {
            active: true,
            dragging: false,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
          };
          return;
        }
        pointerDownScreenRef.current = { x: e.clientX, y: e.clientY };
        pointerMovedRef.current = false;
      }}
      onPointerMoveCapture={(e) => {
        if (rightPanRef.current.active) return;
        if (pointerDownScreenRef.current) {
          const d = Math.hypot(
            e.clientX - pointerDownScreenRef.current.x,
            e.clientY - pointerDownScreenRef.current.y
          );
          if (d >= 6) pointerMovedRef.current = true;
        }
      }}
      onContextMenuCapture={(e) => {
        e.preventDefault();
        if (rightPanRef.current.dragging || performance.now() < suppressContextUntilRef.current) {
          e.stopPropagation();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (rightPanRef.current.dragging || performance.now() < suppressContextUntilRef.current) {
          return;
        }
        setContextMenu(null);
        onClearSelection?.();
      }}
    >
      {/* Underlying Live Leaflet OpenStreetMap */}
      <div ref={mapDivRef} className="absolute inset-0 w-full h-full" />

      {/* Geo-Locked Synchronized Board + Bounding Box SVG Layer */}
      <svg
        ref={svgRef}
        width={mapState.width}
        height={mapState.height}
        viewBox={`0 0 ${mapState.width} ${mapState.height}`}
        className={`absolute inset-0 w-full h-full z-[450] ${
          isRightPanning
            ? 'cursor-grabbing pointer-events-auto'
            : editTool === 'draw_box' ||
                editTool === 'discover_box' ||
                editTool === 'add_stop' ||
                editTool === 'add_waypoint'
              ? 'cursor-crosshair pointer-events-auto'
              : dragTarget
                ? 'pointer-events-auto'
                : 'pointer-events-none'
        }`}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
        onPointerLeave={handleSvgPointerUp}
      >
        <defs>
          <linearGradient id="vtt-rainbow-loco" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FCA5A5" />
            <stop offset="22%" stopColor="#FCD34D" />
            <stop offset="48%" stopColor="#86EFAC" />
            <stop offset="74%" stopColor="#93C5FD" />
            <stop offset="100%" stopColor="#D8B4FE" />
          </linearGradient>
        </defs>

        {mapState.tick > 0 && (
          <g ref={panGroupRef}>
            {/* STANDOUT PURPLE 1.25x TRAIN SCALE REFERENCE GRID (Available across all editor steps) */}
            {scaleGridData && (
              <g data-layer="step2-scale-grid" className="pointer-events-none">
                {scaleGridData.verticalX.map((vx, i) => (
                  <line
                    key={`sgx-${i}`}
                    x1={vx.toFixed(1)}
                    y1={scaleGridData.top.toFixed(1)}
                    x2={vx.toFixed(1)}
                    y2={scaleGridData.bottom.toFixed(1)}
                    stroke={board.theme === 'dark' ? '#C084FC' : '#7C3AED'}
                    strokeWidth={1.15}
                    strokeDasharray="4 4"
                    opacity={scaleGridData.opacity}
                  />
                ))}
                {scaleGridData.horizontalY.map((hy, i) => (
                  <line
                    key={`sgy-${i}`}
                    x1={scaleGridData.left.toFixed(1)}
                    y1={hy.toFixed(1)}
                    x2={scaleGridData.right.toFixed(1)}
                    y2={hy.toFixed(1)}
                    stroke={board.theme === 'dark' ? '#C084FC' : '#7C3AED'}
                    strokeWidth={1.15}
                    strokeDasharray="4 4"
                    opacity={scaleGridData.opacity}
                  />
                ))}
                {scaleGridData.right - scaleGridData.left > 140 && (
                  <g transform={`translate(${(scaleGridData.left + 8).toFixed(1)}, ${(scaleGridData.top + 8).toFixed(1)})`}>
                    <rect
                      x={0}
                      y={0}
                      width={scaleGridData.labelText.length * 6.1 + 14}
                      height={19}
                      rx={3}
                      fill={board.theme === 'dark' ? 'rgba(24, 16, 46, 0.86)' : 'rgba(255, 255, 255, 0.9)'}
                      stroke={board.theme === 'dark' ? 'rgba(192, 132, 252, 0.6)' : 'rgba(124, 58, 237, 0.45)'}
                      strokeWidth={1}
                    />
                    <text
                      x={7}
                      y={13}
                      fontSize="10"
                      fontWeight="600"
                      fontFamily="JetBrains Mono, monospace"
                      fill={board.theme === 'dark' ? '#E9D5FF' : '#6D28D9'}
                    >
                      {scaleGridData.labelText}
                    </text>
                  </g>
                )}
              </g>
            )}

            {/* BASE SUBSTRATE LAYER: Detected OSM Railways / Ferries / Bus / Highways (Strictly underneath ALL active board layers) */}
            {visibleInfraCorridors.length > 0 && (
              <g data-layer="detected-infrastructure" className="pointer-events-none">
                {visibleInfraCorridors.map((rc) => {
                  const pts = rc.points.map((pt) => projectLatLng(pt.lat, pt.lng));
                  const d = pts
                    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                    .join(' ');
                  const stroke = modeStrokeHex(rc.mode);
                  return (
                    <path
                      key={`infra-${rc.id}`}
                      d={d}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={rc.mode === 'train' || rc.mode === 'ferry' ? 3.2 : 2.3}
                      strokeDasharray={rc.mode === 'ferry' ? '6 5' : undefined}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.48}
                    />
                  );
                })}
              </g>
            )}

            {/* Editable Geographic Bounding Box Frame (Editor Mode) */}
            {mode === 'editor' && (
              <g>
                <rect
                  x={boxLeft}
                  y={boxTop}
                  width={boxW}
                  height={boxH}
                  fill="rgba(180, 83, 9, 0.04)"
                  stroke={selectedArea ? '#F59E0B' : '#9B2C2C'}
                  strokeWidth={selectedArea ? 3 : 2}
                  strokeDasharray="8 5"
                />
                <rect
                  x={boxLeft}
                  y={boxTop}
                  width={boxW}
                  height={boxH}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  className="cursor-pointer pointer-events-stroke"
                  style={{ pointerEvents: 'stroke' }}
                  onClick={(e) => {
                    if (e.button !== 0 || pointerMovedRef.current) return;
                    e.stopPropagation();
                    onSelectArea?.();
                  }}
                />
                {(
                  [
                    ['nw', boxLeft, boxTop, 'nwse-resize'],
                    ['ne', boxRight, boxTop, 'nesw-resize'],
                    ['sw', boxLeft, boxBottom, 'nesw-resize'],
                    ['se', boxRight, boxBottom, 'nwse-resize'],
                    ['n', boxLeft + boxW / 2, boxTop, 'ns-resize'],
                    ['s', boxLeft + boxW / 2, boxBottom, 'ns-resize'],
                    ['w', boxLeft, boxTop + boxH / 2, 'ew-resize'],
                    ['e', boxRight, boxTop + boxH / 2, 'ew-resize'],
                  ] as const
                ).map(([edge, hx, hy, cursor]) => (
                  <rect
                    key={edge}
                    x={hx - 6}
                    y={hy - 6}
                    width={12}
                    height={12}
                    rx={2}
                    fill="#FAF7F0"
                    stroke={selectedArea ? '#F59E0B' : '#9B2C2C'}
                    strokeWidth={2}
                    style={{ cursor }}
                    className="pointer-events-auto"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setDragTarget({ kind: 'box_edge', edge });
                    }}
                    onClick={(e) => {
                      if (e.button !== 0 || pointerMovedRef.current) return;
                      e.stopPropagation();
                      onSelectArea?.();
                    }}
                  />
                ))}
              </g>
            )}

            {/* Rubber-band Discover Area Box Preview (Step 2) */}
            {discRect && (
              <rect
                x={discRect.left}
                y={discRect.top}
                width={discRect.width}
                height={discRect.height}
                fill="rgba(13, 148, 136, 0.14)"
                stroke="#0D9488"
                strokeWidth={2.5}
                strokeDasharray="6 4"
                className="pointer-events-none"
              />
            )}

            {isPipelineStepOverlay ? (
              (() => {
                // STEP 1: Area only — clean geographic box without route/node clutter
                if (stepMode === 'area') {
                  return null;
                }

                const cands = candidateLocations || [];

                // STEP 2: All Candidate Locations + Selected Stops
                if (stepMode === 'locations') {
                  const unselected = cands.filter((c) => !c.selected);
                  const selected = cands.filter((c) => c.selected);
                  const rBase = Math.max(4.5, Math.min(11, circleRadiusPx));

                  return (
                    <g>
                      {unselected.map((cand) => {
                        const pt = projectLatLng(cand.lat, cand.lng);
                        const isSel = selectedLocationId === cand.id;
                        const r = Math.max(3.5, Math.min(6.5, 3 + (cand.popularityScore / 100) * 3.5));
                        const isDiscovered = Boolean(cand.discoveredByBox);
                        return (
                          <g
                            key={`cand-${cand.id}`}
                            transform={`translate(${pt.x}, ${pt.y})`}
                            className="cursor-pointer pointer-events-auto"
                            onClick={(e) => {
                              if (e.button !== 0 || pointerMovedRef.current) return;
                              e.stopPropagation();
                              onSelectCandidateLocation?.(cand);
                            }}
                          >
                            <circle r={Math.max(10, r + 5)} fill="transparent" />
                            {isSel && (
                              <circle r={r + 5} fill="none" stroke="#F59E0B" strokeWidth={2.2} />
                            )}
                            <circle
                              r={r}
                              fill={
                                isSel
                                  ? 'rgba(245, 158, 11, 0.35)'
                                  : isDiscovered
                                    ? 'rgba(13, 148, 136, 0.30)'
                                    : 'rgba(100, 116, 139, 0.22)'
                              }
                              stroke={isSel ? '#D97706' : isDiscovered ? '#0D9488' : '#475569'}
                              strokeWidth={isSel ? 2 : 1.3}
                              strokeDasharray="2.5 2"
                            />
                            {isSel && (
                              <g transform={`translate(0, ${r + 12})`}>
                                <rect
                                  x={-(cand.name.length * 3.2 + 5)}
                                  y={-8}
                                  width={cand.name.length * 6.4 + 10}
                                  height={14}
                                  rx={3}
                                  fill="rgba(30, 27, 24, 0.88)"
                                />
                                <text
                                  x={0}
                                  y={2.5}
                                  textAnchor="middle"
                                  fontSize="9.5"
                                  fontWeight="600"
                                  fill="#FAF7F0"
                                >
                                  {cand.name}
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}

                      {selected.map((loc) => {
                        const pt = projectLatLng(loc.lat, loc.lng);
                        const isSel = selectedLocationId === loc.id;
                        const isMovingThisCity = movingLocationId === loc.id;
                        const r = loc.isMajorHub ? rBase * 1.18 : rBase;
                        const fontSize = Math.max(9, Math.min(13.5, circleDiamPx * 0.65));

                        return (
                          <g
                            key={`sel-${loc.id}`}
                            transform={`translate(${pt.x}, ${pt.y})`}
                            className={`pointer-events-auto ${isMovingThisCity ? 'cursor-move' : 'cursor-pointer'}`}
                            onPointerDown={(e) => {
                              if (e.button === 0 && editTool === 'select' && isMovingThisCity) {
                                e.stopPropagation();
                                onDragStart?.('city');
                                setDragTarget({ kind: 'city', id: loc.id });
                              }
                            }}
                            onClick={(e) => {
                              if (e.button !== 0 || pointerMovedRef.current) return;
                              e.stopPropagation();
                              onSelectCandidateLocation?.(loc);
                            }}
                          >
                            <circle r={Math.max(12, r + 6)} fill="transparent" />
                            {isMovingThisCity && (
                              <circle
                                r={r + 9}
                                fill="rgba(155, 44, 44, 0.15)"
                                stroke="#9B2C2C"
                                strokeWidth={2.2}
                                strokeDasharray="4 3"
                              />
                            )}
                            {isSel && (
                              <circle
                                r={r + 5}
                                fill="none"
                                stroke={isMovingThisCity ? '#9B2C2C' : '#F59E0B'}
                                strokeWidth={2.5}
                              />
                            )}
                            <circle
                              r={r}
                              fill={loc.isMajorHub ? palette.nodeHubFill : palette.nodeFill}
                              stroke={loc.manualOverride ? '#F59E0B' : palette.nodeStroke}
                              strokeWidth={loc.manualOverride ? 2.6 : 2}
                            />
                            <g transform={`translate(0, ${r + fontSize * 0.9 + 3})`}>
                              <rect
                                x={-(loc.name.length * (fontSize * 0.31) + 5)}
                                y={-fontSize * 0.72}
                                width={loc.name.length * (fontSize * 0.62) + 10}
                                height={fontSize * 1.25}
                                rx={3}
                                fill={palette.nodeLabelBg}
                              />
                              <text
                                x={0}
                                y={fontSize * 0.28}
                                textAnchor="middle"
                                fontSize={fontSize}
                                fontWeight={loc.isMajorHub ? '700' : '600'}
                                fill={palette.nodeLabelText}
                              >
                                {loc.name}
                              </text>
                            </g>
                          </g>
                        );
                      })}
                    </g>
                  );
                }

                // STEP 3: Candidate Map Corridors & Active Stops (near-transparent unselected, yellow highlighter hover, solid active)
                const corridors = candidateCorridors || [];
                const activeStops = cands.filter((c) => c.selected);
                const unselectedCorridors = showRejectedCorridors
                  ? corridors.filter((c) => !c.selected)
                  : [];
                const selectedCorridors = corridors.filter((c) => c.selected);

                const renderCorridor = (corr: PipelineCorridorCandidate) => {
                  const a = candLocMap.get(corr.fromId) || locMap.get(corr.fromId);
                  const b = candLocMap.get(corr.toId) || locMap.get(corr.toId);
                  if (!a || !b) return null;
                  const pA = projectLatLng(a.lat, a.lng);
                  const pB = projectLatLng(b.lat, b.lng);
                  const effType = resolveEffectivePathType(corr.pathType, corr.waypoints, corr.curveOffset);
                  const effAnchors = resolveEffectiveWaypoints(a, b, effType, corr.waypoints, corr.curveOffset);
                  const anchorsPx = effAnchors.map((w) => {
                    const p = projectLatLng(w.lat, w.lng);
                    return { a: p.x, b: p.y, kind: w.kind, strength: w.strength ?? 1 };
                  });
                  const sampled = sampleGenericPath(
                    { a: pA.x, b: pA.y },
                    { a: pB.x, b: pB.y },
                    anchorsPx,
                    effType,
                    18
                  );
                  const d = sampled
                    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.a.toFixed(1)} ${pt.b.toFixed(1)}`)
                    .join(' ');
                  const isSel = selectedCorridorId === corr.id;
                  const isHovered = hoveredCorridorId === corr.id;
                  const activeStroke = modeStrokeHex(corr.mode);

                  return (
                    <g
                      key={corr.id}
                      className="cursor-pointer pointer-events-auto"
                      onMouseEnter={() => setHoveredCorridorId(corr.id)}
                      onMouseLeave={() => setHoveredCorridorId((prev) => (prev === corr.id ? null : prev))}
                      onContextMenu={(e) => {
                        if (!onInsertCorridorWaypoint || performance.now() < suppressContextUntilRef.current) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const pt = getContainerPoint(e.clientX, e.clientY);
                        const ll = getContainerLatLng(e.clientX, e.clientY);
                        if (!pt || !ll) return;
                        const clickCoord = { lat: ll.lat, lng: ll.lng };
                        const insertIndex = findBestWaypointInsertIndex(a, b, effAnchors, clickCoord, effType);
                        onSelectCorridor?.(corr);
                        setContextMenu({
                          kind: 'corridor_line',
                          x: pt.x,
                          y: pt.y,
                          corridorId: corr.id,
                          latLng: clickCoord,
                          insertIndex,
                        });
                      }}
                      onClick={(e) => {
                        if (e.button !== 0 || pointerMovedRef.current) return;
                        e.stopPropagation();
                        setContextMenu(null);
                        if ((isSel && (e.shiftKey || editTool === 'add_waypoint')) && onInsertCorridorWaypoint) {
                          const ll = getContainerLatLng(e.clientX, e.clientY);
                          if (ll) {
                            const clickCoord = { lat: ll.lat, lng: ll.lng };
                            const idx = findBestWaypointInsertIndex(a, b, effAnchors, clickCoord, effType);
                            onInsertCorridorWaypoint(corr.id, clickCoord, newWaypointKind, idx);
                          }
                          return;
                        }
                        onSelectCorridor?.(corr);
                      }}
                    >
                      {/* Wide transparent hit area */}
                      <path d={d} fill="none" stroke="transparent" strokeWidth={15} />

                      {/* Transparent yellow highlighter glow on hover */}
                      {isHovered && (
                        <path
                          d={d}
                          fill="none"
                          stroke="rgba(250, 204, 21, 0.72)"
                          strokeWidth={10}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}

                      {/* Amber selection collar */}
                      {isSel && (
                        <path
                          d={d}
                          fill="none"
                          stroke="#F59E0B"
                          strokeWidth={6.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity={0.7}
                        />
                      )}

                      {/* Corridor core stroke */}
                      <path
                        d={d}
                        fill="none"
                        stroke={corr.selected ? activeStroke : isHovered ? '#CA8A04' : '#334155'}
                        strokeWidth={isSel ? 4.2 : corr.selected ? 3.4 : isHovered ? 3.2 : 2.1}
                        strokeDasharray={corr.mode === 'ferry' ? '6 4' : undefined}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={isSel ? 1 : corr.selected ? 0.92 : isHovered ? 0.85 : 0.22}
                      />

                      {/* Composite waypoint handles (Square Diamond = Corner, Circle = Curve) */}
                      {isSel &&
                        anchorsPx.map((wp, wi) => {
                          const wpKind = effAnchors[wi]?.kind || 'curve';
                          const isCorner = wpKind === 'corner';
                          const isWpSelected = selectedCorridorWaypointIdx === wi;
                          return (
                            <g
                              key={wi}
                              transform={`translate(${wp.a}, ${wp.b})`}
                              className="cursor-grab pointer-events-auto"
                              onPointerDown={(ev) => {
                                if (ev.button !== 0) return;
                                ev.stopPropagation();
                                setContextMenu(null);
                                onSelectCorridorWaypoint?.(corr.id, wi);
                                onDragStart?.('corridor_waypoint');
                                setDragTarget({
                                  kind: 'corridor_waypoint',
                                  corridorId: corr.id,
                                  index: wi,
                                });
                              }}
                              onClick={(ev) => {
                                if (ev.button !== 0 || pointerMovedRef.current) return;
                                ev.stopPropagation();
                                setContextMenu(null);
                                onSelectCorridorWaypoint?.(corr.id, wi);
                              }}
                              onContextMenu={(ev) => {
                                if (performance.now() < suppressContextUntilRef.current) return;
                                ev.preventDefault();
                                ev.stopPropagation();
                                const pt = getContainerPoint(ev.clientX, ev.clientY);
                                if (!pt) return;
                                onSelectCorridorWaypoint?.(corr.id, wi);
                                setContextMenu({
                                  kind: 'corridor_point',
                                  x: pt.x,
                                  y: pt.y,
                                  corridorId: corr.id,
                                  index: wi,
                                  currentKind: wpKind,
                                });
                              }}
                            >
                              {isWpSelected && (
                                <circle
                                  r={11.5}
                                  fill="none"
                                  stroke="#0F172A"
                                  strokeWidth={2.5}
                                  strokeDasharray="3 2"
                                />
                              )}
                              {isCorner ? (
                                <rect
                                  x={-5.8}
                                  y={-5.8}
                                  width={11.6}
                                  height={11.6}
                                  rx={1.5}
                                  transform="rotate(45)"
                                  fill="#DC2626"
                                  stroke="#FFFFFF"
                                  strokeWidth={1.8}
                                />
                              ) : (
                                <circle
                                  r={6.5}
                                  fill="#F59E0B"
                                  stroke="#1E1B18"
                                  strokeWidth={1.8}
                                />
                              )}
                            </g>
                          );
                        })}
                    </g>
                  );
                };

                const stopsList: BoardLocation[] =
                  activeStops.length > 0 ? activeStops : board.locations;
                const rStop = Math.max(4.5, Math.min(10, circleRadiusPx));

                return (
                  <g>
                    {unselectedCorridors.map(renderCorridor)}
                    {selectedCorridors.map(renderCorridor)}
                    {stopsList.map((loc) => {
                      const pt = projectLatLng(loc.lat, loc.lng);
                      const isSel = linkSourceId === loc.id || selectedLocationId === loc.id;
                      const r = loc.isMajorHub ? rStop * 1.15 : rStop;
                      const fontSize = Math.max(8.5, Math.min(13, circleDiamPx * 0.62));
                      return (
                        <g
                          key={`s3-${loc.id}`}
                          transform={`translate(${pt.x}, ${pt.y})`}
                          className="cursor-pointer pointer-events-auto"
                          onClick={(e) => {
                            if (e.button !== 0 || pointerMovedRef.current) return;
                            e.stopPropagation();
                            setContextMenu(null);
                            onSelectLocation?.(loc);
                          }}
                        >
                          {isSel && (
                            <circle r={r + 5} fill="none" stroke="#F59E0B" strokeWidth={2.5} />
                          )}
                          <circle
                            r={r}
                            fill={loc.isMajorHub ? palette.nodeHubFill : palette.nodeFill}
                            stroke={palette.nodeStroke}
                            strokeWidth={2}
                          />
                          <g transform={`translate(0, ${r + fontSize * 0.9 + 3})`}>
                            <rect
                              x={-(loc.name.length * (fontSize * 0.31) + 4)}
                              y={-fontSize * 0.72}
                              width={loc.name.length * (fontSize * 0.62) + 8}
                              height={fontSize * 1.22}
                              rx={3}
                              fill={palette.nodeLabelBg}
                            />
                            <text
                              x={0}
                              y={fontSize * 0.28}
                              textAnchor="middle"
                              fontSize={fontSize}
                              fontWeight={loc.isMajorHub ? '700' : '600'}
                              fill={palette.nodeLabelText}
                            >
                              {loc.name}
                            </text>
                          </g>
                        </g>
                      );
                    })}
                  </g>
                );
              })()
            ) : isIntermediateStageOverlay && stageOverlay ? (
              (() => {
                const stageLocMap = new Map<string, BoardLocation>();
                for (const l of stageOverlay.locations) stageLocMap.set(l.id, l);
                for (const l of stageOverlay.prunedLocations || []) stageLocMap.set(l.id, l);
                const stageTrainPx = Math.max(
                  7.5,
                  stageOverlay.metersPerTrain / Math.max(0.01, mpp)
                );
                const stageNodeR = Math.max(
                  4,
                  (stageTrainPx / TRAIN_TO_CIRCLE_RATIO) * 0.52
                );

                return (
                  <g>
                    {stageOverlay.edges &&
                      stageOverlay.edges.map((edge) => {
                        const a = stageLocMap.get(edge.fromId);
                        const b = stageLocMap.get(edge.toId);
                        if (!a || !b) return null;

                        const pA = projectLatLng(a.lat, a.lng);
                        const pB = projectLatLng(b.lat, b.lng);
                        const anchors = (edge.waypoints || []).map((w) => {
                          const p = projectLatLng(w.lat, w.lng);
                          return { a: p.x, b: p.y, kind: w.kind, strength: w.strength ?? 1 };
                        });
                        const sampled = sampleGenericPath(
                          { a: pA.x, b: pA.y },
                          { a: pB.x, b: pB.y },
                          anchors,
                          edge.pathType || 'line',
                          16
                        );
                        const d = sampled
                          .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.a.toFixed(1)} ${pt.b.toFixed(1)}`)
                          .join(' ');

                        const isSelEdge = selectedStageEdgeId === edge.id;
                        const isRejected = edge.status === 'rejected';
                        const isDouble = edge.status === 'double';
                        const isCandidate = edge.status === 'candidate';
                        const isFerry = edge.mode === 'ferry';

                        const strokeColor = isSelEdge
                          ? '#F59E0B'
                          : isRejected
                            ? '#DC2626'
                            : isDouble
                              ? '#D97706'
                              : isFerry
                                ? '#0284C7'
                                : isCandidate
                                  ? edge.transitWeight >= 60
                                    ? '#0D9488'
                                    : '#64748B'
                                  : '#0F766E';

                        const strokeW = isSelEdge
                          ? 4.5
                          : isDouble
                            ? 4.2
                            : isRejected
                              ? 1.6
                              : isCandidate
                                ? 2.0
                                : 3.0;

                        return (
                          <g
                            key={edge.id}
                            className="cursor-pointer pointer-events-auto"
                            onClick={(e) => {
                              if (e.button !== 0 || pointerMovedRef.current) return;
                              e.stopPropagation();
                              onSelectStageEdge?.(edge);
                            }}
                          >
                            <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                            <path
                              d={d}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth={strokeW}
                              strokeDasharray={isRejected || isFerry ? '5 4' : undefined}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              opacity={isRejected ? 0.5 : isCandidate ? 0.68 : 0.92}
                            />
                            {isSelEdge &&
                              anchors.map((wp, wi) => (
                                <circle
                                  key={wi}
                                  cx={wp.a}
                                  cy={wp.b}
                                  r={4}
                                  fill="#F59E0B"
                                  stroke="#1E1B18"
                                  strokeWidth={1.5}
                                />
                              ))}
                          </g>
                        );
                      })}

                    {stageOverlay.prunedLocations &&
                      stageOverlay.prunedLocations.map((loc) => {
                        const pt = projectLatLng(loc.lat, loc.lng);
                        const isSel = selectedLocationId === loc.id;
                        return (
                          <g
                            key={`pruned-${loc.id}`}
                            transform={`translate(${pt.x}, ${pt.y})`}
                            className="cursor-pointer pointer-events-auto"
                            onClick={(e) => {
                              if (e.button !== 0 || pointerMovedRef.current) return;
                              e.stopPropagation();
                              onSelectLocation?.(loc);
                            }}
                          >
                            <circle
                              r={isSel ? 7 : 4.5}
                              fill="rgba(220, 38, 38, 0.22)"
                              stroke="#DC2626"
                              strokeWidth={isSel ? 2 : 1.2}
                              strokeDasharray="2 2"
                            />
                          </g>
                        );
                      })}

                    {stageOverlay.locations.map((loc) => {
                      const pt = projectLatLng(loc.lat, loc.lng);
                      const isSel = selectedLocationId === loc.id;
                      const scoreColor =
                        loc.popularityScore >= 78
                          ? '#D97706'
                          : loc.popularityScore >= 55
                            ? '#0F766E'
                            : '#475569';
                      const r =
                        stageOverlay.key === 'candidates'
                          ? Math.max(3.5, Math.min(8, 3 + (loc.popularityScore / 100) * 4.5))
                          : Math.max(4, loc.isMajorHub ? stageNodeR * 1.15 : stageNodeR);

                      const showLabel =
                        isSel ||
                        stageOverlay.key !== 'candidates' ||
                        loc.popularityScore >= 74;

                      return (
                        <g
                          key={`st-${loc.id}`}
                          transform={`translate(${pt.x}, ${pt.y})`}
                          className="cursor-pointer pointer-events-auto"
                          onClick={(e) => {
                            if (e.button !== 0 || pointerMovedRef.current) return;
                            e.stopPropagation();
                            onSelectLocation?.(loc);
                          }}
                        >
                          {isSel && (
                            <circle
                              r={r + 5}
                              fill="none"
                              stroke="#F59E0B"
                              strokeWidth={2.5}
                            />
                          )}
                          <circle
                            r={r}
                            fill={scoreColor}
                            stroke="#FFFFFF"
                            strokeWidth={1.6}
                            opacity={0.95}
                          />
                          {showLabel && (
                            <g transform={`translate(0, ${r + 10})`}>
                              <rect
                                x={-(loc.name.length * 3.1 + 4)}
                                y={-7}
                                width={loc.name.length * 6.2 + 8}
                                height={13}
                                rx={3}
                                fill="rgba(250, 247, 240, 0.9)"
                              />
                              <text
                                x={0}
                                y={2.5}
                                textAnchor="middle"
                                fontSize="9.5"
                                fontWeight={loc.isMajorHub ? '700' : '600'}
                                fill="#1E1B18"
                              >
                                {loc.name}
                              </text>
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })()
            ) : (
              <>
                {/* Step 4 Reference Substrate: show ONLY selected Step 3 corridors underneath game train routes */}
                {mode === 'editor' &&
                  stepMode === 'routes' &&
                  candidateCorridors &&
                  candidateCorridors.some((c) => c.selected) && (
                    <g data-layer="step4-corridor-substrate" className="pointer-events-none">
                      {candidateCorridors
                        .filter((c) => c.selected)
                        .map((corr) => {
                          const a = locMap.get(corr.fromId) || candLocMap.get(corr.fromId);
                          const b = locMap.get(corr.toId) || candLocMap.get(corr.toId);
                          if (!a || !b) return null;
                          const pA = projectLatLng(a.lat, a.lng);
                          const pB = projectLatLng(b.lat, b.lng);
                          const effType = resolveEffectivePathType(
                            corr.pathType,
                            corr.waypoints,
                            corr.curveOffset
                          );
                          const effAnchors = resolveEffectiveWaypoints(
                            a,
                            b,
                            effType,
                            corr.waypoints,
                            corr.curveOffset
                          );
                          const sampled = sampleGenericPath(
                            { a: pA.x, b: pA.y },
                            { a: pB.x, b: pB.y },
                            effAnchors.map((w) => {
                              const p = projectLatLng(w.lat, w.lng);
                              return { a: p.x, b: p.y, kind: w.kind, strength: w.strength ?? 1 };
                            }),
                            effType,
                            18
                          );
                          const d = sampled
                            .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.a.toFixed(1)} ${pt.b.toFixed(1)}`)
                            .join(' ');
                          const isLinkedToSel =
                            Boolean(selectedRouteId) &&
                            board.routes.some(
                              (rt) => rt.id === selectedRouteId && rt.sourceCorridorId === corr.id
                            );
                          return (
                            <path
                              key={`sub-${corr.id}`}
                              d={d}
                              fill="none"
                              stroke={modeStrokeHex(corr.mode)}
                              strokeWidth={isLinkedToSel ? 3.5 : 2.3}
                              strokeDasharray={corr.mode === 'ferry' ? '5 4' : '6 3'}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              opacity={isLinkedToSel ? 0.65 : 0.34}
                            />
                          );
                        })}
                    </g>
                  )}

                {/* Train / Bus / Ship Routes */}
                <g>
                  {computedLanes.map((layout) => renderComputedLane(layout))}
                </g>

                {/* Draggable Multi-Anchor Composite Handles for Selected Route in Editor */}
                {mode === 'editor' &&
                  selectedRouteId &&
                  (() => {
                    const r = board.routes.find((rt) => rt.id === selectedRouteId);
                    if (!r) return null;
                    const a = locMap.get(r.fromId);
                    const b = locMap.get(r.toId);
                    if (!a || !b) return null;
                    const effType = resolveEffectivePathType(r.pathType, r.waypoints, r.curveOffset);
                    const effAnchors = resolveEffectiveWaypoints(
                      a,
                      b,
                      effType,
                      r.waypoints,
                      r.curveOffset
                    );
                    if (effAnchors.length === 0) return null;

                    const pA = projectLatLng(a.lat, a.lng);
                    const pB = projectLatLng(b.lat, b.lng);
                    const ptsPx = effAnchors.map((w) => projectLatLng(w.lat, w.lng));
                    const guidePoly = [pA, ...ptsPx, pB]
                      .map((p) => `${p.x},${p.y}`)
                      .join(' ');

                    return (
                      <g>
                        <polyline
                          points={guidePoly}
                          fill="none"
                          stroke="#F59E0B"
                          strokeWidth={1.3}
                          strokeDasharray="4 4"
                          opacity={0.7}
                          className="pointer-events-none"
                        />
                        {ptsPx.map((pt, idx) => {
                          const isActiveWp = selectedWaypointIdx === idx;
                          const wpKind = effAnchors[idx]?.kind || 'curve';
                          const isCorner = wpKind === 'corner';
                          const hasOffset = Math.abs(effAnchors[idx]?.relOffsetRatio || 0) > 0.002;
                          return (
                            <g
                              key={idx}
                              transform={`translate(${pt.x}, ${pt.y})`}
                              className="cursor-grab pointer-events-auto"
                              onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                setContextMenu(null);
                                onSelectWaypoint?.(r.id, idx);
                                onDragStart?.('waypoint');
                                setDragTarget({ kind: 'waypoint', routeId: r.id, index: idx });
                              }}
                              onClick={(e) => {
                                if (e.button !== 0 || pointerMovedRef.current) return;
                                e.stopPropagation();
                                setContextMenu(null);
                                onSelectWaypoint?.(r.id, idx);
                              }}
                              onContextMenu={(e) => {
                                if (performance.now() < suppressContextUntilRef.current) return;
                                e.preventDefault();
                                e.stopPropagation();
                                const menuPt = getContainerPoint(e.clientX, e.clientY);
                                if (!menuPt) return;
                                onSelectWaypoint?.(r.id, idx);
                                setContextMenu({
                                  kind: 'route_point',
                                  x: menuPt.x,
                                  y: menuPt.y,
                                  routeId: r.id,
                                  index: idx,
                                  currentKind: wpKind,
                                });
                              }}
                            >
                              {isActiveWp && (
                                <circle
                                  r={13}
                                  fill="none"
                                  stroke="#0F172A"
                                  strokeWidth={2.5}
                                  strokeDasharray="3 2"
                                />
                              )}
                              {hasOffset && (
                                <circle
                                  r={10.5}
                                  fill="none"
                                  stroke="#0D9488"
                                  strokeWidth={1.6}
                                />
                              )}
                              {isCorner ? (
                                <rect
                                  x={-7.2}
                                  y={-7.2}
                                  width={14.4}
                                  height={14.4}
                                  rx={2}
                                  transform="rotate(45)"
                                  fill="#DC2626"
                                  stroke="#1E1B18"
                                  strokeWidth={2}
                                />
                              ) : (
                                <circle
                                  r={effAnchors.length > 1 ? 8.5 : 8}
                                  fill="#F59E0B"
                                  stroke="#1E1B18"
                                  strokeWidth={2}
                                />
                              )}
                              <text
                                x={0}
                                y={3}
                                textAnchor="middle"
                                fontSize="8.5"
                                fontWeight="800"
                                fill={isCorner ? '#FFFFFF' : '#1E1B18'}
                              >
                                {idx + 1}
                              </text>
                            </g>
                          );
                        })}
                      </g>
                    );
                  })()}

                {/* Hazard Warning Triangles (! 1-4) */}
                <g>
                  {board.routes.map((route) => {
                    if (route.hazardRating <= 0 || route.hazardType === 'none') return null;
                    const a = locMap.get(route.fromId);
                    const b = locMap.get(route.toId);
                    if (!a || !b) return null;
                    const effType = resolveEffectivePathType(
                      route.pathType,
                      route.waypoints,
                      route.curveOffset
                    );
                    const effAnchors = resolveEffectiveWaypoints(
                      a,
                      b,
                      effType,
                      route.waypoints,
                      route.curveOffset
                    );
                    const cpGeo = route.hazardLatLng ||
                      effAnchors[0] || {
                        lat: (a.lat + b.lat) / 2,
                        lng: (a.lng + b.lng) / 2,
                      };
                    const pt = projectLatLng(cpGeo.lat, cpGeo.lng);
                    const isShipping = route.hazardType === 'shipping_lane';
                    const badgeScale = Math.max(0.8, Math.min(1.45, circleDiamPx / 15));
                    const isSelectedHazard = selectedHazardRouteId === route.id;
                    return (
                      <g
                        key={`haz-${route.id}`}
                        transform={`translate(${pt.x}, ${pt.y}) scale(${badgeScale})`}
                        className={`pointer-events-auto ${
                          mode === 'editor' && editTool === 'select' ? 'cursor-grab' : 'cursor-pointer'
                        }`}
                        onPointerDown={(e) => {
                          if (e.button === 0 && mode === 'editor' && editTool === 'select') {
                            e.stopPropagation();
                            onSelectHazard?.(route);
                            onDragStart?.('hazard');
                            setDragTarget({ kind: 'hazard', routeId: route.id });
                          }
                        }}
                        onClick={(e) => {
                          if (e.button !== 0 || pointerMovedRef.current) return;
                          e.stopPropagation();
                          onSelectHazard?.(route);
                        }}
                      >
                        <circle cx={0} cy={0} r={15} fill="transparent" />
                        {isSelectedHazard && (
                          <circle
                            cx={0}
                            cy={1}
                            r={14}
                            fill="rgba(245, 158, 11, 0.18)"
                            stroke="#F59E0B"
                            strokeWidth={2.2}
                          />
                        )}
                        <polygon
                          points="0,-11 10,8 -10,8"
                          fill={isShipping ? '#FDE047' : '#FACC15'}
                          stroke={isSelectedHazard ? '#9B2C2C' : isShipping ? '#0369A1' : '#713F12'}
                          strokeWidth={isSelectedHazard ? 2.1 : 1.6}
                          strokeLinejoin="round"
                        />
                        <text
                          x={0}
                          y={5.5}
                          textAnchor="middle"
                          fontSize="9.5"
                          fontWeight="800"
                          fill="#1E1B18"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {route.hazardRating}
                        </text>
                      </g>
                    );
                  })}
                </g>

                {/* Geo-Projected City / Landmark Nodes */}
                <g>
                  {board.locations.map((loc) => {
                    const pt = projectLatLng(loc.lat, loc.lng);
                    const isSelected = selectedLocationId === loc.id || linkSourceId === loc.id;
                    const isMovingThisCity = mode === 'editor' && movingLocationId === loc.id;
                    const isHighlighted = highlightedLocationIds?.has(loc.id);
                    const stationOwnerId = builtStations[loc.id];
                    const stationColor = stationOwnerId ? playerColorsById[stationOwnerId] : undefined;
                    const r = Math.max(4, loc.isMajorHub ? circleRadiusPx * 1.15 : circleRadiusPx);
                    const fontSize = Math.max(8.5, Math.min(14, circleDiamPx * 0.65));

                    return (
                      <g
                        key={loc.id}
                        transform={`translate(${pt.x}, ${pt.y})`}
                        className={`pointer-events-auto ${isMovingThisCity ? 'cursor-move' : 'cursor-pointer'}`}
                        onPointerDown={(e) => {
                          if (e.button === 0 && mode === 'editor' && editTool === 'select' && isMovingThisCity) {
                            e.stopPropagation();
                            onDragStart?.('city');
                            setDragTarget({ kind: 'city', id: loc.id });
                          }
                        }}
                        onClick={(e) => {
                          if (e.button !== 0 || pointerMovedRef.current) return;
                          e.stopPropagation();
                          setContextMenu(null);
                          onSelectLocation?.(loc);
                        }}
                      >
                        {isMovingThisCity && (
                          <circle
                            cx={0}
                            cy={0}
                            r={r + 9}
                            fill="rgba(155, 44, 44, 0.14)"
                            stroke="#9B2C2C"
                            strokeWidth={2.2}
                            strokeDasharray="4 3"
                          />
                        )}

                        {(isSelected || isHighlighted || (stationModeActive && !stationOwnerId)) && (
                          <circle
                            cx={0}
                            cy={0}
                            r={r + 5}
                            fill="none"
                            stroke={isMovingThisCity ? '#9B2C2C' : isSelected ? '#F59E0B' : '#10B981'}
                            strokeWidth={2.5}
                            strokeDasharray={stationModeActive ? '3 2' : undefined}
                          />
                        )}

                        <circle
                          cx={0}
                          cy={0}
                          r={r}
                          fill={loc.isMajorHub ? palette.nodeHubFill : palette.nodeFill}
                          stroke={palette.nodeStroke}
                          strokeWidth={2}
                        />

                        {stationColor && (
                          <polygon
                            points={`0,${-r - 9} ${r * 0.8},${-r + 1} ${-r * 0.8},${-r + 1}`}
                            fill={PLAYER_COLOR_HEX[stationColor].hex}
                            stroke="#FFFFFF"
                            strokeWidth={1.4}
                          />
                        )}

                        <g transform={`translate(0, ${r + fontSize * 0.9 + 3})`}>
                          <rect
                            x={-(loc.name.length * (fontSize * 0.31) + 5)}
                            y={-fontSize * 0.72}
                            width={loc.name.length * (fontSize * 0.62) + 10}
                            height={fontSize * 1.25}
                            rx={3}
                            fill={palette.nodeLabelBg}
                          />
                          <text
                            x={0}
                            y={fontSize * 0.28}
                            textAnchor="middle"
                            fontSize={fontSize}
                            fontWeight={loc.isMajorHub ? '700' : '600'}
                            fill={palette.nodeLabelText}
                          >
                            {loc.name}
                          </text>
                        </g>
                      </g>
                    );
                  })}
                </g>
              </>
            )}
          </g>
        )}
      </svg>

      {/* Floating Bottom-Left Map Layers, Tile Style & 1.25x Scale Grid Menu (Available Across ALL Steps 1-5) */}
      {mode === 'editor' && (
        <div
          className="absolute bottom-3 left-3 z-[620] pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {layersMenuOpen ? (
            <div className="bg-white/95 backdrop-blur border border-slate-300 rounded-lg shadow-md p-2.5 w-64 text-xs text-slate-800 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setLayersMenuOpen(false)}
                title="Minimize Map Layers menu"
                className="w-full flex items-center justify-between border-b border-slate-200 pb-1 text-left hover:bg-slate-50 rounded px-0.5 cursor-pointer"
              >
                <span className="font-semibold text-[11px] text-slate-900 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-slate-600" />
                  Detected Layers
                </span>
                <span className="text-[10px] text-slate-500 font-medium">Hide</span>
              </button>

              {infraVisibility && onToggleInfraLayer && (
                <div className="flex flex-col gap-0.5">
                  {(
                    [
                      ['train', 'Railways', '#1D4ED8'],
                      ['ferry', 'Ferry Routes', '#0D9488'],
                      ['bus', 'Bus / Transit', '#059669'],
                      ['highway', 'Major Highways', '#B45309'],
                    ] as const
                  ).map(([key, label, dotColor]) => {
                    const count = (rawCorridors || []).filter((c) => c.mode === key).length;
                    return (
                      <label
                        key={key}
                        className="flex items-center justify-between gap-2 text-[11px] text-slate-700 cursor-pointer hover:bg-slate-50 px-1 py-0.5 rounded"
                        title={`Toggle showing raw detected OSM ${label.toLowerCase()} underneath board elements across all steps`}
                      >
                        <span className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={infraVisibility[key]}
                            onChange={() => onToggleInfraLayer(key)}
                          />
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: dotColor }}
                          />
                          <span>{label}</span>
                        </span>
                        <span className="text-[10px] font-mono-num text-slate-400">{count}</span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div
                className="flex items-center justify-between gap-2 text-[11px] text-slate-700 px-1 py-1 rounded border-t border-slate-200 pt-1.5"
                title="Show 1.25x train-length horizontal and vertical scale grid across all steps and adjust its purple opacity"
              >
                <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={showScaleGrid}
                    onChange={() => setShowScaleGrid((prev) => !prev)}
                  />
                  <span className="w-2.5 h-2.5 rounded-sm border border-dashed border-purple-600 bg-purple-100/70 shrink-0" />
                  <span>Show Grid</span>
                </label>
                <div className="flex items-center gap-1.5 min-w-0">
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={gridOpacityPct}
                    aria-label="Scale grid opacity"
                    onChange={(e) => {
                      setGridOpacityPct(Number(e.target.value));
                      if (!showScaleGrid) setShowScaleGrid(true);
                    }}
                    className={`w-20 h-1.5 accent-purple-600 cursor-pointer ${
                      showScaleGrid ? 'opacity-100' : 'opacity-45'
                    }`}
                  />
                  <span className="text-[10px] font-mono-num text-purple-700 w-7 text-right shrink-0">
                    {gridOpacityPct}%
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-1.5 flex flex-col gap-1">
                <div className="flex items-center justify-between text-[10px] text-slate-500 px-0.5">
                  <span className="font-semibold text-slate-700">Base Map Style</span>
                  <span className="font-mono-num">
                    {BASE_TILE_STYLES.findIndex((s) => s.id === activeTileStyle.id) + 1}/
                    {BASE_TILE_STYLES.length}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => cycleTileStyle(-1)}
                    title="Previous base map style"
                    className="p-1 rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 cursor-pointer shrink-0"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <select
                    value={activeTileStyle.id}
                    onChange={(e) => setBaseStyleId(e.target.value)}
                    aria-label="Base map tile style"
                    className="flex-1 min-w-0 text-[11px] font-medium text-slate-800 bg-white border border-slate-200 rounded px-1.5 py-1 cursor-pointer"
                  >
                    {BASE_TILE_STYLES.map((styleOpt) => (
                      <option key={styleOpt.id} value={styleOpt.id}>
                        {styleOpt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => cycleTileStyle(1)}
                    title="Next base map style"
                    className="p-1 rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 cursor-pointer shrink-0"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[10px] text-slate-500 px-0.5 leading-tight">
                  {activeTileStyle.detailHint}
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLayersMenuOpen(true)}
              title="Toggle detected OSM infrastructure layers, base map style, and 1.25x scale grid"
              className="bg-white/95 backdrop-blur border border-slate-300 rounded-lg shadow-md px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-slate-700" />
              <span>Map Layers</span>
              {anyInfraVisible && infraVisibility && (
                <span className="px-1.5 py-0.5 rounded bg-slate-900 text-white text-[9px] font-mono-num">
                  {Object.values(infraVisibility).filter(Boolean).length}
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Non-Blocking Anchored Manual Stop OSM Reverse Lookup Popup */}
      {mode === 'editor' && manualStopLookup && lookupAnchorPx && (
        <div
          className="absolute z-[650] w-64 bg-white border border-slate-300 rounded-lg shadow-lg p-2.5 text-xs text-slate-800 pointer-events-auto"
          style={{
            left: Math.max(12, Math.min(mapState.width - 270, lookupAnchorPx.x + 14)),
            top: Math.max(12, Math.min(mapState.height - 220, lookupAnchorPx.y - 12)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-200">
            <span className="font-semibold text-[11px] text-slate-900">
              Nearby Places Found
            </span>
            <button
              type="button"
              onClick={onDismissManualStopLookup}
              className="text-[10px] text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              Keep Custom
            </button>
          </div>
          {manualStopLookup.loading ? (
            <div className="py-3 text-center text-[11px] text-slate-500">
              Checking OpenStreetMap nearby...
            </div>
          ) : manualStopLookup.matches.length === 0 ? (
            <div className="py-2 text-[11px] text-slate-500">
              No named landmarks or stations within radius. Keeping manual stop.
            </div>
          ) : (
            <div className="mt-1.5 max-h-44 overflow-y-auto flex flex-col gap-1">
              {manualStopLookup.matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onPickManualStopMatch?.(manualStopLookup.stopId, m)}
                  className="text-left px-2 py-1.5 rounded border border-slate-200 hover:border-amber-500 hover:bg-amber-50/70 transition-colors cursor-pointer"
                >
                  <div className="font-semibold text-slate-900 text-[11px] truncate">{m.name}</div>
                  <div className="text-[10px] text-slate-500 tabular-nums">
                    {m.category} · {m.distanceMeters}m away · {m.reason}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Right-Click Composite Polyline / Waypoint Context Menu */}
      {mode === 'editor' && contextMenu && (
        <div
          className="absolute z-[680] w-44 bg-white border border-slate-300 rounded-lg shadow-lg py-1 text-xs text-slate-800 pointer-events-auto"
          style={{
            left: Math.max(8, Math.min(mapState.width - 185, contextMenu.x + 4)),
            top: Math.max(8, Math.min(mapState.height - 120, contextMenu.y + 4)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {(contextMenu.kind === 'corridor_line' || contextMenu.kind === 'route_line') && (
            <>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.kind === 'corridor_line') {
                    onInsertCorridorWaypoint?.(
                      contextMenu.corridorId,
                      contextMenu.latLng,
                      'corner',
                      contextMenu.insertIndex
                    );
                  } else {
                    onInsertRouteWaypoint?.(
                      contextMenu.routeId,
                      contextMenu.latLng,
                      'corner',
                      contextMenu.insertIndex
                    );
                  }
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-100 font-medium cursor-pointer"
              >
                Add Corner Point
              </button>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.kind === 'corridor_line') {
                    onInsertCorridorWaypoint?.(
                      contextMenu.corridorId,
                      contextMenu.latLng,
                      'curve',
                      contextMenu.insertIndex
                    );
                  } else {
                    onInsertRouteWaypoint?.(
                      contextMenu.routeId,
                      contextMenu.latLng,
                      'curve',
                      contextMenu.insertIndex
                    );
                  }
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-100 font-medium cursor-pointer"
              >
                Add Curve Point
              </button>
            </>
          )}

          {(contextMenu.kind === 'corridor_point' || contextMenu.kind === 'route_point') && (
            <>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.kind === 'corridor_point') {
                    onToggleCorridorWaypointKind?.(contextMenu.corridorId, contextMenu.index);
                  } else {
                    onToggleRouteWaypointKind?.(contextMenu.routeId, contextMenu.index);
                  }
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-100 font-medium cursor-pointer"
              >
                {contextMenu.currentKind === 'corner' ? 'Switch to Curve' : 'Switch to Corner'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (contextMenu.kind === 'corridor_point') {
                    onDeleteCorridorWaypoint?.(contextMenu.corridorId, contextMenu.index);
                  } else {
                    onDeleteRouteWaypoint?.(contextMenu.routeId, contextMenu.index);
                  }
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-[11px] text-red-700 hover:bg-red-50 font-medium cursor-pointer"
              >
                Remove Point
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
