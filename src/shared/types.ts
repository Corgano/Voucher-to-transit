export type BoardTheme = 'vintage' | 'metro' | 'dark';

export type RouteColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'black'
  | 'white'
  | 'gray';

export type CardColor = Exclude<RouteColor, 'gray'> | 'locomotive';

export type TransportMode = 'train' | 'bus' | 'ferry' | 'highway';

export type PieceType = 'train' | 'bus' | 'ship';

export type HazardType = 'none' | 'bus_crossing' | 'shipping_lane';

export type ScaleMode = 'macro' | 'metro' | 'city';

export type PlayerColor = 'crimson' | 'cobalt' | 'emerald' | 'amber' | 'violet';

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GenerationParams {
  targetLocations: number; // 16..60 (default 40)
  targetTrainSpaces?: number; // 80..450 (default 276)
  minConnections: number; // 1..4 (default 2)
  maxConnections: number; // 3..10 (default 6)
  transitFidelity: number; // 0..100 (default 70)
  minNodeSpacing: number; // legacy pixel spacing fallback
  minNodeSpacingTrains?: number; // 1.2..4.0 train lengths (default 2.0)
  curveIntensity: number; // 0..100 (default 55)
  doubleLaneBias: number; // 0..100 (default 40)
  autoAdjustScale?: boolean; // default true
  traceRealCorridors?: boolean; // default true
  allowTunnels: boolean;
  allowFerryLocomotives: boolean;
  allowBusCrossings: boolean;
  allowShippingHazards: boolean;
  splitPiecesMode: boolean;
  useAiEnrichment: boolean;
}

export interface BoardLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  x: number; // 0..1000 fallback preview
  y: number; // 0..700 fallback preview
  popularityScore: number; // 0..100
  category: 'city' | 'station' | 'landmark' | 'port' | 'district';
  isMajorHub: boolean;
  population?: number;
  wikiSitelinks?: number;
  source: 'osm' | 'manual';
}

export type RoutePathType = 'line' | 'bezier' | 'polyline';

export type WaypointKind = 'corner' | 'curve';

export interface RouteWaypoint {
  lat: number;
  lng: number;
  kind?: WaypointKind; // 'corner' = sharp angle, 'curve' = smooth pass-through (default 'curve')
  strength?: number; // 0.2..2.0 (default 1.0)
  relT?: number; // 0..1 normalized progress along linked Step 3 map corridor curve
  relOffsetRatio?: number; // signed perpendicular offset relative to parent corridor arc length
}

export interface BoardRoute {
  id: string;
  fromId: string;
  toId: string;
  length: number; // 1..20
  color: RouteColor;
  doubleColor?: RouteColor;
  tripleColor?: RouteColor;
  isDouble: boolean;
  laneCount?: 1 | 2 | 3; // 1=single, 2=double, 3=triple (defaults to isDouble ? 2 : 1)
  curveOffset: number; // -90..90
  pathType?: RoutePathType;
  waypoints?: RouteWaypoint[]; // 0..N geo anchors (bezier control points or hard polyline corners)
  customWaypoints?: boolean; // true once user adds/deletes waypoints specifically on the train route
  transportMode: TransportMode;
  transitWeight: number; // 0..100
  isTunnel: boolean;
  ferryLocomotives: number; // 0..3
  hazardRating: number; // 0..4 (0 = none)
  hazardType: HazardType;
  hazardPoint?: { x: number; y: number };
  hazardLatLng?: { lat: number; lng: number };
  realLineName?: string;
  sourceCorridorId?: string;
}

export type TicketGrade = 'short' | 'medium' | 'long';

export interface DestinationTicket {
  id: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  points: number;
  grade?: TicketGrade;
  shortestPathTrains?: number;
}

export type GenerationStageKey =
  | 'candidates'
  | 'filtered_locations'
  | 'candidate_paths'
  | 'selected_paths'
  | 'final_trains_tickets';

export interface StageEdgeSnapshot {
  id: string;
  fromId: string;
  toId: string;
  mode: TransportMode;
  transitWeight: number;
  cost: number;
  distMeters: number;
  arcMeters: number;
  estimatedTrains: number;
  pathType: RoutePathType;
  waypoints?: RouteWaypoint[];
  status: 'candidate' | 'selected' | 'rejected' | 'double';
  reason?: string;
  realLineName?: string;
}

export interface GenerationStageArtifact {
  stageIndex: number;
  key: GenerationStageKey;
  title: string;
  summary: string;
  logs: string[];
  metrics: Record<string, string | number>;
  metersPerTrain: number;
  locations: BoardLocation[];
  prunedLocations?: BoardLocation[];
  edges?: StageEdgeSnapshot[];
  routes?: BoardRoute[];
  tickets?: DestinationTicket[];
}

export interface BoardDefinition {
  id: string;
  name: string;
  regionLabel: string;
  theme: BoardTheme;
  bbox: BoundingBox;
  zoom: number;
  scaleMode: ScaleMode;
  metersPerTrain: number; // Locked real-world meters per 1 train length
  scaleSpanKm?: number;
  cacheId?: string;
  maxPlayers: number;
  generationParams: GenerationParams;
  defaultRules?: GameRules;
  locations: BoardLocation[];
  routes: BoardRoute[];
  tickets: DestinationTicket[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardRulePreset {
  id: string;
  boardId: string;
  name: string;
  rules: GameRules;
  createdAt: string;
}

export interface CachedRegionSummary {
  id: string;
  name: string;
  bbox: BoundingBox;
  zoom: number;
  scaleMode: ScaleMode;
  poisCount: number;
  transitCount: number;
  hazardsCount: number;
  isPyramid?: boolean;
  createdAt: string;
}

export type DeckBasisEdition =
  | 'USA'
  | 'Europe'
  | 'Germany'
  | 'Nordic Countries'
  | 'India'
  | 'Legendary Asia'
  | 'Board Matched';

export interface GameRules {
  piecesMode: 'fixed' | 'proportional';
  piecesPerPlayer: number; // default 45
  proportionalPercent: number; // e.g. 65 (% of board train spaces / max players)
  splitPiecesEnabled: boolean;
  deckBasisEdition: DeckBasisEdition;
  deckSize: number; // default 110 (40..300)
  ticketsInitialDraw: number; // default 5
  ticketsInitialKeep: number; // default 2
  ticketsMidDraw: number; // default 3
  ticketsMidKeep: number; // default 1
  stationsEnabled: boolean; // derived: stationCount > 0
  stationCount: number; // 0 = disabled (none), 1..10 stations per player
  doubleRouteMinPlayers: number; // 0 = never dual, or 2..6 min players needed for both rails
  enabledHazards: {
    tunnels: boolean;
    ferries: boolean;
    busCrossings: boolean;
    shippingHazards: boolean;
  };
}

export interface PieceInventory {
  train: number;
  bus: number;
  ship: number;
}

export interface PlayerPublic {
  id: string;
  nickname: string;
  color: PlayerColor;
  joinedAt: number;
  isBot: boolean;
  connected: boolean;
  isReady: boolean;
  recommendedBoardIds: string[];
  piecesRemaining: PieceInventory;
  stationsRemaining: number;
  cardCount: number;
  ticketCount: number;
  score: number;
  hasPickedInitialTickets: boolean;
  hasConfiguredSplit: boolean;
}

export interface PlayerPrivate {
  hand: CardColor[];
  tickets: DestinationTicket[];
  pendingTickets: DestinationTicket[];
}

export interface ClaimedRouteState {
  laneA?: string; // playerId
  laneB?: string; // playerId
  laneC?: string; // playerId
}

export interface PendingTunnelAction {
  playerId: string;
  routeId: string;
  lane: 'laneA' | 'laneB' | 'laneC';
  cardsUsed: CardColor[];
  drawnCards: CardColor[];
  extraRequired: number;
  targetColor: RouteColor;
}

export interface PendingHazardAction {
  playerId: string;
  routeId: string;
  lane: 'laneA' | 'laneB' | 'laneC';
  cardsUsed: CardColor[];
  hazardRating: number;
  hazardType: HazardType;
  rollResult: number;
  success: boolean;
}

export interface FinalPlayerBreakdown {
  playerId: string;
  nickname: string;
  color: PlayerColor;
  routePoints: number;
  ticketPoints: number;
  longestRouteBonus: number;
  stationPoints: number;
  totalScore: number;
  longestRouteLength: number;
  tickets: {
    id: string;
    fromName: string;
    toName: string;
    points: number;
    completed: boolean;
  }[];
}

export type GamePhase =
  | 'LOBBY'
  | 'INITIAL_TICKETS'
  | 'PLAYING'
  | 'FINAL_ROUND'
  | 'GAME_OVER';

export type LobbyStep = 'MAP_VOTE' | 'RULE_REVIEW';

export interface GameEventLogItem {
  id: string;
  text: string;
  timestamp: number;
}

export interface PublicGameState {
  roomCode: string;
  boardId: string | null;
  board: BoardDefinition | null;
  hostPlayerId: string | null;
  phase: GamePhase;
  lobbyStep: LobbyStep;
  rules: GameRules;
  players: PlayerPublic[];
  faceUpCards: CardColor[];
  deckCount: number;
  discardCount: number;
  claimedRoutes: Record<string, ClaimedRouteState>;
  builtStations: Record<string, string>; // locationId -> playerId
  currentTurnIndex: number;
  turnDrawsRemaining: number;
  pendingTunnel: PendingTunnelAction | null;
  pendingHazard: PendingHazardAction | null;
  finalRoundTriggerPlayerId: string | null;
  finalTurnsRemaining: number;
  eventLog: GameEventLogItem[];
  finalBreakdown?: FinalPlayerBreakdown[];
}

export interface RawOsmPoi {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: 'city' | 'station' | 'landmark' | 'port' | 'district';
  population?: number;
  wikiSitelinks?: number;
  osmScore: number;
  interchangeModes?: TransportMode[];
  tags: Record<string, string>;
}

export interface SpotLookupMatch {
  id: string;
  name: string;
  category: BoardLocation['category'];
  lat: number;
  lng: number;
  distanceMeters: number;
  reason: string;
  osmScore: number;
  isMajorHub: boolean;
}

export interface InfrastructureOverlayVisibility {
  train: boolean;
  ferry: boolean;
  bus: boolean;
  highway: boolean;
}

export interface RawTransitCorridor {
  id: string;
  name?: string;
  mode: 'train' | 'bus' | 'ferry' | 'highway';
  weight: number; // 0..100
  isTunnel: boolean;
  isBridge: boolean;
  points: { lat: number; lng: number }[];
}

export interface RawHazardZone {
  id: string;
  type: 'tunnel_terrain' | 'road_intersection' | 'maritime_hazard';
  lat: number;
  lng: number;
  severity: number; // 1..4
  label?: string;
}

export interface RawRegionSources {
  overpass: boolean;
  wikipedia: boolean;
  wikidata: boolean;
  photon: boolean;
  osrm: boolean;
}

export interface RawRegionDataset {
  bbox: BoundingBox;
  zoom: number;
  scaleMode: ScaleMode;
  pois: RawOsmPoi[];
  corridors: RawTransitCorridor[];
  hazards: RawHazardZone[];
  fetchedAt?: string;
  sources?: RawRegionSources;
}

export type PipelineStepId = 'area' | 'locations' | 'corridors' | 'routes' | 'tickets';

export interface Step2LocationSettings {
  targetLocations: number; // 12..60
  minNodeSpacingTrains: number; // 1.1..4.5
  minCandidateScore: number; // 0..80
  majorHubShare: number; // 0.1..0.5
  useAiEnrichment: boolean;
}

export interface PipelineLocationCandidate extends BoardLocation {
  selected: boolean;
  autoSelected: boolean;
  manualOverride?: 'include' | 'exclude' | 'manual';
  filterReason?: string;
  interchangeModes?: TransportMode[];
  discoveredByBox?: boolean;
}

export interface Step3CorridorSettings {
  minConnections: number; // 1..4
  maxConnections: number; // 3..10
  transitFidelity: number; // 0..100
  traceRealCorridors: boolean;
  curveIntensity: number; // 0..100
  minCorridorWeight: number; // 0..80
  overlapAvoidance: number; // 0..100
  allowBusCrossings: boolean;
}

export interface PipelineCorridorCandidate {
  id: string;
  fromId: string;
  toId: string;
  mode: TransportMode;
  transitWeight: number;
  cost: number;
  distMeters: number;
  arcMeters: number;
  pathType: RoutePathType;
  waypoints?: RouteWaypoint[];
  curveOffset: number;
  tracedFromCorridor: boolean;
  isTunnel: boolean;
  ferryLocomotives: number;
  roadHazard: number;
  maritimeHazard: number;
  realLineName?: string;
  selected: boolean;
  autoSelected: boolean;
  manualOverride?: 'include' | 'exclude' | 'manual';
  rejectionReason?: string;
  evidenceCount?: number;
  hazardType?: HazardType;
  hazardRating?: number;
  hazardPoint?: { x: number; y: number };
}

export interface Step4RouteSettings {
  metersPerTrain: number;
  strictScale: boolean;
  autoAdjustScale: boolean;
  targetTrainSpaces: number;
  corridorAdherence: number; // 0..100 (100 = tight OSM polyline/waypoints, 0 = direct simplified line)
  minIncludeWeight: number; // 0..80
  doubleThresholdWeight: number; // 40..98
  tripleThresholdWeight: number; // 70..100
  doubleRequiresHub: boolean;
  doubleLaneBias: number; // 0..100
  maxRouteLength: number; // 6..15
  allowTunnels: boolean;
  allowFerryLocomotives: boolean;
  allowBusCrossings: boolean;
  allowShippingHazards: boolean;
  splitPiecesMode: boolean;
}

export interface Step5TicketSettings {
  targetTicketCount: number; // 0 = proportional auto
  minTicketLength: number; // 3..8
  shortShare: number; // 0.15..0.6
  mediumShare: number; // 0.15..0.6
}

export interface GenerationPipelineState {
  activeStep: PipelineStepId;
  area: {
    bbox: BoundingBox;
    zoom: number;
    regionLabel: string;
    cacheId?: string;
    scannedAt?: string;
    dataset: RawRegionDataset | null;
  };
  locations: {
    settings: Step2LocationSettings;
    candidates: PipelineLocationCandidate[];
    lastAutoRunAt?: string;
  };
  corridors: {
    settings: Step3CorridorSettings;
    candidates: PipelineCorridorCandidate[];
    lastAutoRunAt?: string;
  };
  routes: {
    settings: Step4RouteSettings;
    items: BoardRoute[];
    lastAutoRunAt?: string;
  };
  tickets: {
    settings: Step5TicketSettings;
    items: DestinationTicket[];
    lastAutoRunAt?: string;
  };
}

export interface BoardEditEntry {
  id: string;
  label: string;
  timestamp: string;
  board: BoardDefinition;
  pipeline?: GenerationPipelineState;
}

export interface MapGenerationCheckpoint {
  id: string;
  index: number;
  label: string;
  createdAt: string;
  baseBoard: BoardDefinition;
  stages: GenerationStageArtifact[];
  currentBoard: BoardDefinition;
  pipeline?: GenerationPipelineState;
  undoStack: BoardEditEntry[];
  redoStack: BoardEditEntry[];
}

export interface StudioMapWorkspace {
  id: string;
  name: string;
  isSavedToLibrary: boolean;
  lastServerSyncAt: string | null;
  lastLocalSaveAt: string;
  activeGenerationId: string | null;
  generations: MapGenerationCheckpoint[];
  draftBoard: BoardDefinition;
  draftPipeline?: GenerationPipelineState;
  draftUndoStack: BoardEditEntry[];
  draftRedoStack: BoardEditEntry[];
}
