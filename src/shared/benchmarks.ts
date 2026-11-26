import {
  BoardDefinition,
  CardColor,
  DeckBasisEdition,
  GameRules,
  GenerationParams,
  PieceType,
  PlayerColor,
  RouteColor,
  TransportMode,
} from './types';

export interface TtrBenchmarkEdition {
  name: Exclude<DeckBasisEdition, 'Board Matched'>;
  region: string;
  cities: number;
  routes: number;
  spaces: number;
  trainsPerPlayer: number;
  players: string;
  baseDeckSize: number;
  locomotivesCount: number;
  perColorCount: number;
}

export const OFFICIAL_TTR_BENCHMARKS: TtrBenchmarkEdition[] = [
  {
    name: 'USA',
    region: 'North America',
    cities: 36,
    routes: 80,
    spaces: 309,
    trainsPerPlayer: 45,
    players: '2–5',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
  {
    name: 'Europe',
    region: 'Europe',
    cities: 46,
    routes: 95,
    spaces: 306,
    trainsPerPlayer: 45,
    players: '2–5',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
  {
    name: 'Germany',
    region: 'Central Europe',
    cities: 51,
    routes: 102,
    spaces: 285,
    trainsPerPlayer: 45,
    players: '2–5',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
  {
    name: 'Nordic Countries',
    region: 'Scandinavia',
    cities: 39,
    routes: 70,
    spaces: 250,
    trainsPerPlayer: 40,
    players: '2–3',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
  {
    name: 'India',
    region: 'South Asia',
    cities: 35,
    routes: 61,
    spaces: 215,
    trainsPerPlayer: 45,
    players: '2–4',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
  {
    name: 'Legendary Asia',
    region: 'Asia',
    cities: 36,
    routes: 68,
    spaces: 289,
    trainsPerPlayer: 45,
    players: '2–5',
    baseDeckSize: 110,
    locomotivesCount: 14,
    perColorCount: 12,
  },
];

export const TTR_AVERAGE_BENCHMARK = {
  cities: Math.round(
    OFFICIAL_TTR_BENCHMARKS.reduce((acc, b) => acc + b.cities, 0) / OFFICIAL_TTR_BENCHMARKS.length
  ), // 41
  routes: Math.round(
    OFFICIAL_TTR_BENCHMARKS.reduce((acc, b) => acc + b.routes, 0) / OFFICIAL_TTR_BENCHMARKS.length
  ), // 79
  spaces: Math.round(
    OFFICIAL_TTR_BENCHMARKS.reduce((acc, b) => acc + b.spaces, 0) / OFFICIAL_TTR_BENCHMARKS.length
  ), // 276
};

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  targetLocations: 40,
  targetTrainSpaces: TTR_AVERAGE_BENCHMARK.spaces,
  minConnections: 2,
  maxConnections: 6,
  transitFidelity: 70,
  minNodeSpacing: 58,
  minNodeSpacingTrains: 2.0,
  curveIntensity: 55,
  doubleLaneBias: 40,
  autoAdjustScale: true,
  traceRealCorridors: true,
  allowTunnels: true,
  allowFerryLocomotives: true,
  allowBusCrossings: true,
  allowShippingHazards: true,
  splitPiecesMode: false,
  useAiEnrichment: false,
};

const DECK_CARD_COLORS: Array<Exclude<CardColor, 'locomotive'>> = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
];

export function getDeckDistributionShares(
  edition: DeckBasisEdition,
  board?: BoardDefinition | null
): Record<CardColor, number> {
  if (edition === 'Board Matched' && board && board.routes.length > 0) {
    const colorDemand: Record<Exclude<CardColor, 'locomotive'>, number> = {
      red: 2,
      orange: 2,
      yellow: 2,
      green: 2,
      blue: 2,
      purple: 2,
      black: 2,
      white: 2,
    };
    let ferryLocos = 0;
    let totalSpaces = 0;
    for (const r of board.routes) {
      const lanes = r.laneCount ?? (r.isDouble ? 2 : 1);
      totalSpaces += r.length * lanes;
      ferryLocos += r.ferryLocomotives;
      if (r.color !== 'gray') {
        colorDemand[r.color] += r.length;
      }
      if (lanes >= 2 && r.doubleColor && r.doubleColor !== 'gray') {
        colorDemand[r.doubleColor] += r.length;
      }
      if (lanes >= 3 && r.tripleColor && r.tripleColor !== 'gray') {
        colorDemand[r.tripleColor] += r.length;
      }
    }
    const locoShare = Math.min(
      0.2,
      Math.max(0.127, 0.127 + (ferryLocos / Math.max(20, totalSpaces)) * 0.25)
    );
    const colorBudget = 1 - locoShare;
    const sumDemand = DECK_CARD_COLORS.reduce((acc, c) => acc + colorDemand[c], 0);
    const shares = { locomotive: locoShare } as Record<CardColor, number>;
    for (const c of DECK_CARD_COLORS) {
      shares[c] = (colorDemand[c] / sumDemand) * colorBudget;
    }
    return shares;
  }

  const bench =
    OFFICIAL_TTR_BENCHMARKS.find((b) => b.name === edition) || OFFICIAL_TTR_BENCHMARKS[0];
  const baseTotal = Math.max(1, bench.perColorCount * 8 + bench.locomotivesCount);
  const shares = {
    locomotive: bench.locomotivesCount / baseTotal,
  } as Record<CardColor, number>;
  for (const c of DECK_CARD_COLORS) {
    shares[c] = bench.perColorCount / baseTotal;
  }
  return shares;
}

export function computeDeckDistributionCounts(
  edition: DeckBasisEdition,
  deckSize: number,
  board?: BoardDefinition | null
): Record<CardColor, number> {
  const safeSize = Math.max(40, Math.min(300, Math.round(deckSize || 110)));
  const shares = getDeckDistributionShares(edition, board);
  const allKeys: CardColor[] = [...DECK_CARD_COLORS, 'locomotive'];

  const counts = {} as Record<CardColor, number>;
  const remainders: Array<{ color: CardColor; frac: number }> = [];
  let assigned = 0;

  for (const k of allKeys) {
    const exact = shares[k] * safeSize;
    const base = Math.floor(exact);
    counts[k] = base;
    assigned += base;
    remainders.push({ color: k, frac: exact - base });
  }

  remainders.sort((a, b) => b.frac - a.frac);
  let left = safeSize - assigned;
  let idx = 0;
  while (left > 0) {
    const pick = remainders[idx % remainders.length].color;
    counts[pick] += 1;
    left -= 1;
    idx += 1;
  }

  return counts;
}

export function computeRecommendedDeckSize(totalSpaces: number): number {
  return Math.max(55, Math.min(240, Math.round(110 * (Math.max(40, totalSpaces) / 276))));
}

const VALID_DECK_BASIS_SET = new Set<DeckBasisEdition>([
  'USA',
  'Europe',
  'Germany',
  'Nordic Countries',
  'India',
  'Legendary Asia',
  'Board Matched',
]);

export function isDualRailwayAllowed(playerCount: number, doubleRouteMinPlayers: number): boolean {
  return doubleRouteMinPlayers > 0 && playerCount >= doubleRouteMinPlayers;
}

export function normalizeGameRules(
  raw?: Partial<GameRules> | null,
  board?: Pick<BoardDefinition, 'generationParams' | 'defaultRules' | 'locations' | 'routes'> | null
): GameRules {
  const baseFromBoard = board?.defaultRules;
  const src = {
    ...(baseFromBoard || {}),
    ...(raw || {}),
    enabledHazards: {
      tunnels: board?.generationParams?.allowTunnels ?? true,
      ferries: board?.generationParams?.allowFerryLocomotives ?? true,
      busCrossings: board?.generationParams?.allowBusCrossings ?? true,
      shippingHazards: board?.generationParams?.allowShippingHazards ?? true,
      ...(baseFromBoard?.enabledHazards || {}),
      ...(raw?.enabledHazards || {}),
    },
  };

  let stationCount: number;
  if (typeof raw?.stationCount === 'number') {
    stationCount = Math.max(0, Math.min(10, Math.round(raw.stationCount)));
  } else if (raw?.stationsEnabled === false) {
    stationCount = 0;
  } else if (typeof baseFromBoard?.stationCount === 'number') {
    stationCount = Math.max(0, Math.min(10, Math.round(baseFromBoard.stationCount)));
  } else if (baseFromBoard?.stationsEnabled === false) {
    stationCount = 0;
  } else {
    stationCount = 3;
  }

  const rawDoubleMin =
    typeof src.doubleRouteMinPlayers === 'number' ? Math.round(src.doubleRouteMinPlayers) : 4;
  const doubleRouteMinPlayers = rawDoubleMin <= 0 ? 0 : Math.max(2, Math.min(6, rawDoubleMin));

  const ticketsInitialDraw = Math.max(2, Math.min(7, Math.round(Number(src.ticketsInitialDraw) || 5)));
  const ticketsInitialKeep = Math.max(
    1,
    Math.min(ticketsInitialDraw, Math.round(Number(src.ticketsInitialKeep) || 2))
  );
  const ticketsMidDraw = Math.max(1, Math.min(5, Math.round(Number(src.ticketsMidDraw) || 3)));
  const ticketsMidKeep = Math.max(
    1,
    Math.min(ticketsMidDraw, Math.round(Number(src.ticketsMidKeep) || 1))
  );

  const deckBasisEdition: DeckBasisEdition = VALID_DECK_BASIS_SET.has(
    src.deckBasisEdition as DeckBasisEdition
  )
    ? (src.deckBasisEdition as DeckBasisEdition)
    : 'USA';

  return {
    piecesMode: src.piecesMode === 'proportional' ? 'proportional' : 'fixed',
    piecesPerPlayer: Math.max(15, Math.min(80, Math.round(Number(src.piecesPerPlayer) || 45))),
    proportionalPercent: Math.max(
      30,
      Math.min(100, Math.round(Number(src.proportionalPercent) || 65))
    ),
    splitPiecesEnabled:
      typeof src.splitPiecesEnabled === 'boolean'
        ? src.splitPiecesEnabled
        : Boolean(board?.generationParams?.splitPiecesMode),
    deckBasisEdition,
    deckSize: Math.max(40, Math.min(300, Math.round(Number(src.deckSize) || 110))),
    ticketsInitialDraw,
    ticketsInitialKeep,
    ticketsMidDraw,
    ticketsMidKeep,
    stationCount,
    stationsEnabled: stationCount > 0,
    doubleRouteMinPlayers,
    enabledHazards: {
      tunnels: Boolean(src.enabledHazards.tunnels),
      ferries: Boolean(src.enabledHazards.ferries),
      busCrossings: Boolean(src.enabledHazards.busCrossings),
      shippingHazards: Boolean(src.enabledHazards.shippingHazards),
    },
  };
}

export function getBakedBoardRules(
  board: Pick<BoardDefinition, 'generationParams' | 'defaultRules' | 'locations' | 'routes'>
): GameRules {
  return normalizeGameRules(board.defaultRules, board);
}

export function summarizeBoardRules(board: BoardDefinition) {
  const rules = getBakedBoardRules(board);
  const stats = computeBoardStats(board);

  const hazards: string[] = [];
  if (rules.enabledHazards.tunnels && stats.tunnelCount > 0) {
    hazards.push(`Tunnels (${stats.tunnelCount})`);
  }
  if (rules.enabledHazards.ferries && stats.ferryHazardCount > 0) {
    hazards.push(`Ferry Locos (${stats.ferryHazardCount})`);
  }
  if (rules.enabledHazards.busCrossings && stats.busHazardCount > 0) {
    hazards.push(`Bus 45° (${stats.busHazardCount})`);
  }
  if (rules.enabledHazards.shippingHazards && stats.shippingHazardCount > 0) {
    hazards.push(`Shipping (${stats.shippingHazardCount})`);
  }

  return {
    rules,
    stats,
    hazardsLabel: hazards.length > 0 ? hazards.join(', ') : 'None',
    dualLabel:
      rules.doubleRouteMinPlayers === 0
        ? 'Disabled (Single lane only)'
        : `${rules.doubleRouteMinPlayers}+ players`,
    trainsLabel:
      rules.piecesMode === 'fixed'
        ? `${rules.piecesPerPlayer} pieces`
        : `${rules.proportionalPercent}% share`,
    vehiclesLabel: rules.splitPiecesEnabled ? 'Train / Bus / Ship Split' : 'Trains Only',
    stationsLabel: rules.stationCount > 0 ? `${rules.stationCount}` : 'None',
  };
}

export const ROUTE_SCORE_TABLE: Record<number, number> = {
  1: 1,
  2: 2,
  3: 4,
  4: 7,
  5: 10,
  6: 15,
  7: 18,
  8: 21,
  9: 27,
  10: 31,
  11: 36,
  12: 41,
  13: 46,
  14: 52,
  15: 58,
  16: 64,
  17: 70,
  18: 76,
  19: 82,
  20: 88,
};

export function getRoutePoints(length: number): number {
  return ROUTE_SCORE_TABLE[Math.max(1, Math.min(20, length))] ?? length * 4.2;
}

export function computeBoardStats(board: Pick<BoardDefinition, 'locations' | 'routes'>) {
  let totalSpaces = 0;
  let totalConnections = 0;
  const modeCounts: Record<TransportMode, number> = {
    train: 0,
    bus: 0,
    ferry: 0,
    highway: 0,
  };
  let tunnelCount = 0;
  let ferryHazardCount = 0;
  let busHazardCount = 0;
  let shippingHazardCount = 0;

  for (const r of board.routes) {
    const lanes = r.laneCount ?? (r.isDouble ? 2 : 1);
    totalConnections += lanes;
    totalSpaces += r.length * lanes;
    modeCounts[r.transportMode] = (modeCounts[r.transportMode] || 0) + lanes;
    if (r.isTunnel) tunnelCount += 1;
    if (r.ferryLocomotives > 0) ferryHazardCount += 1;
    if (r.hazardType === 'bus_crossing' && r.hazardRating > 0) busHazardCount += 1;
    if (r.hazardType === 'shipping_lane' && r.hazardRating > 0) shippingHazardCount += 1;
  }

  return {
    locationsCount: board.locations.length,
    routesCount: board.routes.length,
    segmentsCount: totalConnections,
    totalSpaces,
    modeCounts,
    tunnelCount,
    ferryHazardCount,
    busHazardCount,
    shippingHazardCount,
  };
}

export function getRequiredPieceType(mode: TransportMode, splitEnabled: boolean): PieceType {
  if (!splitEnabled) return 'train';
  if (mode === 'ferry') return 'ship';
  if (mode === 'bus') return 'bus';
  return 'train';
}

export function computeRecommendedPieceSplit(
  board: BoardDefinition | null,
  totalPieces: number
): { train: number; bus: number; ship: number } {
  if (!board || !board.generationParams.splitPiecesMode) {
    return { train: totalPieces, bus: 0, ship: 0 };
  }
  let trainSpaces = 0;
  let busSpaces = 0;
  let shipSpaces = 0;
  for (const r of board.routes) {
    const lanes = r.laneCount ?? (r.isDouble ? 2 : 1);
    const spaces = r.length * lanes;
    if (r.transportMode === 'ferry') shipSpaces += spaces;
    else if (r.transportMode === 'bus') busSpaces += spaces;
    else trainSpaces += spaces;
  }
  const sum = Math.max(1, trainSpaces + busSpaces + shipSpaces);
  const train = Math.max(
    trainSpaces > 0 ? 4 : 0,
    Math.round((trainSpaces / sum) * totalPieces)
  );
  const bus = Math.max(
    busSpaces > 0 ? 4 : 0,
    Math.round((busSpaces / sum) * totalPieces)
  );
  const ship = Math.max(0, totalPieces - train - bus);
  // Normalize sum exactly to totalPieces
  const diff = totalPieces - (train + bus + ship);
  return { train: Math.max(0, train + diff), bus, ship };
}

export type RouteSymbolKind =
  | 'square'
  | 'triangle'
  | 'star'
  | 'circle'
  | 'diamond'
  | 'cross'
  | 'hexagon'
  | 'ring'
  | 'none';

export const ROUTE_COLOR_HEX: Record<
  RouteColor,
  { fill: string; stroke: string; symbolColor: string; symbol: RouteSymbolKind; label: string }
> = {
  red: { fill: '#F3B8B8', stroke: '#991B1B', symbolColor: '#7F1D1D', symbol: 'square', label: 'Red' },
  orange: { fill: '#F9CFA8', stroke: '#C2410C', symbolColor: '#9A3412', symbol: 'triangle', label: 'Orange' },
  yellow: { fill: '#FBF0A8', stroke: '#A16207', symbolColor: '#854D0E', symbol: 'star', label: 'Yellow' },
  green: { fill: '#BCE8CB', stroke: '#15803D', symbolColor: '#14532D', symbol: 'circle', label: 'Green' },
  blue: { fill: '#BBD6FA', stroke: '#1D4ED8', symbolColor: '#1E3A8A', symbol: 'diamond', label: 'Blue' },
  purple: { fill: '#DFC9FA', stroke: '#7E22CE', symbolColor: '#581C87', symbol: 'cross', label: 'Purple' },
  black: { fill: '#64748B', stroke: '#0F172A', symbolColor: '#F8FAFC', symbol: 'hexagon', label: 'Black' },
  white: { fill: '#F8FAFC', stroke: '#64748B', symbolColor: '#334155', symbol: 'ring', label: 'White' },
  gray: { fill: '#E2E8F0', stroke: '#475569', symbolColor: '#475569', symbol: 'none', label: 'Gray' },
};

export const PLAYER_COLOR_HEX: Record<PlayerColor, { hex: string; light: string; label: string }> = {
  crimson: { hex: '#C81E1E', light: '#FEE2E2', label: 'Crimson' },
  cobalt: { hex: '#1D4ED8', light: '#DBEAFE', label: 'Cobalt' },
  emerald: { hex: '#047857', light: '#D1FAE5', label: 'Emerald' },
  amber: { hex: '#D97706', light: '#FEF3C7', label: 'Amber' },
  violet: { hex: '#7C3AED', light: '#EDE9FE', label: 'Violet' },
};
