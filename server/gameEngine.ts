import crypto from 'crypto';
import type { WebSocket } from 'ws';
import type {
  BoardDefinition,
  BoardRoute,
  CardColor,
  DestinationTicket,
  FinalPlayerBreakdown,
  GameEventLogItem,
  GameRules,
  PieceInventory,
  PlayerColor,
  PlayerPrivate,
  PlayerPublic,
  PublicGameState,
  RouteColor,
} from '../src/shared/types.ts';
import {
  computeBoardStats,
  computeDeckDistributionCounts,
  computeRecommendedPieceSplit,
  getBakedBoardRules,
  getRequiredPieceType,
  getRoutePoints,
  isDualRailwayAllowed,
  normalizeGameRules,
} from '../src/shared/benchmarks.ts';
import { getBoard, getSessionSnapshot, listSessionSnapshots, saveSessionSnapshot } from './db.ts';

const PLAYER_COLORS: PlayerColor[] = ['crimson', 'cobalt', 'emerald', 'amber', 'violet'];
const TRAIN_COLORS: Array<Exclude<CardColor, 'locomotive'>> = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
];

interface InternalPlayer extends PlayerPublic {
  privateState: PlayerPrivate;
}

interface InternalRoom {
  state: PublicGameState;
  players: InternalPlayer[];
  deck: CardColor[];
  discard: CardColor[];
  ticketDeck: DestinationTicket[];
  sockets: Map<string, Set<WebSocket>>;
  botTimer?: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, InternalRoom>();

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildTrainDeck(rules: GameRules, board: BoardDefinition | null): CardColor[] {
  const counts = computeDeckDistributionCounts(
    rules.deckBasisEdition || 'USA',
    rules.deckSize || 110,
    board
  );
  const deck: CardColor[] = [];
  for (const c of TRAIN_COLORS) {
    const n = counts[c] || 0;
    for (let i = 0; i < n; i++) deck.push(c);
  }
  const locos = counts.locomotive || 0;
  for (let i = 0; i < locos; i++) deck.push('locomotive');
  return shuffle(deck);
}

function createDefaultRules(board: BoardDefinition | null): GameRules {
  return board ? getBakedBoardRules(board) : normalizeGameRules(undefined, null);
}

function addEvent(room: InternalRoom, text: string): void {
  const item: GameEventLogItem = {
    id: crypto.randomBytes(4).toString('hex'),
    text,
    timestamp: Date.now(),
  };
  room.state.eventLog = [item, ...room.state.eventLog].slice(0, 45);
}

function computeEffectivePiecesTotal(rules: GameRules, board: BoardDefinition | null, playerCount: number): number {
  if (rules.piecesMode === 'fixed' || !board) {
    return Math.max(15, Math.min(80, rules.piecesPerPlayer));
  }
  const stats = computeBoardStats(board);
  const divisor = Math.max(2, Math.min(board.maxPlayers || 5, Math.max(playerCount, 4)));
  const raw = Math.round((stats.totalSpaces * (rules.proportionalPercent / 100)) / divisor);
  return Math.max(18, Math.min(65, raw));
}

function syncPublicPlayers(room: InternalRoom): void {
  // Host is ALWAYS the earliest-joined active connected human player (longest-tenured!)
  const connectedHumans = room.players
    .filter((p) => !p.isBot && p.connected)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const fallbackHumans = room.players
    .filter((p) => !p.isBot)
    .sort((a, b) => a.joinedAt - b.joinedAt);

  room.state.hostPlayerId = connectedHumans[0]?.id ?? fallbackHumans[0]?.id ?? null;
  room.state.players = room.players.map(({ privateState: _priv, ...pub }) => ({
    ...pub,
    cardCount: _priv.hand.length,
    ticketCount: _priv.tickets.length,
  }));
  room.state.deckCount = room.deck.length;
  room.state.discardCount = room.discard.length;
}

function persistRoom(room: InternalRoom): void {
  saveSessionSnapshot(room.state.roomCode, {
    state: room.state,
    players: room.players,
    deck: room.deck,
    discard: room.discard,
    ticketDeck: room.ticketDeck,
  });
}

function broadcastRoom(room: InternalRoom): void {
  syncPublicPlayers(room);
  persistRoom(room);

  for (const [playerId, wsSet] of room.sockets) {
    const player = room.players.find((p) => p.id === playerId);
    const payload = JSON.stringify({
      type: 'state:sync',
      publicState: room.state,
      privateState: player?.privateState ?? { hand: [], tickets: [], pendingTickets: [] },
      playerId,
    });
    for (const ws of wsSet) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }
}

function drawFromDeck(room: InternalRoom): CardColor | null {
  if (room.deck.length === 0) {
    if (room.discard.length === 0) return null;
    room.deck = shuffle(room.discard);
    room.discard = [];
    addEvent(room, 'Reshuffled the train card discard pile into a fresh deck.');
  }
  return room.deck.pop() ?? null;
}

function refillFaceUp(room: InternalRoom): void {
  while (room.state.faceUpCards.length < 5) {
    const c = drawFromDeck(room);
    if (!c) break;
    room.state.faceUpCards.push(c);
  }
  // Classic rule: if 3+ face-up cards are Locomotives, discard all 5 and deal fresh (max 3 retries)
  let guard = 0;
  while (
    guard < 3 &&
    room.state.faceUpCards.filter((c) => c === 'locomotive').length >= 3 &&
    room.deck.length + room.discard.length >= 5
  ) {
    room.discard.push(...room.state.faceUpCards);
    room.state.faceUpCards = [];
    for (let i = 0; i < 5; i++) {
      const c = drawFromDeck(room);
      if (c) room.state.faceUpCards.push(c);
    }
    addEvent(room, '3 face-up Locomotives triggered a fresh market deal.');
    guard += 1;
  }
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function restoreRoomIfNeeded(roomCode: string): InternalRoom | null {
  const code = roomCode.toUpperCase();
  if (rooms.has(code)) return rooms.get(code)!;

  const snap = getSessionSnapshot<{
    state: PublicGameState;
    players: InternalPlayer[];
    deck: CardColor[];
    discard: CardColor[];
    ticketDeck: DestinationTicket[];
  }>(code);
  if (!snap) return null;

  const restoredRules: GameRules = normalizeGameRules(snap.state.rules, snap.state.board);
  const restored: InternalRoom = {
    state: {
      ...snap.state,
      lobbyStep: snap.state.lobbyStep ?? (snap.state.board ? 'RULE_REVIEW' : 'MAP_VOTE'),
      rules: restoredRules,
    },
    players: snap.players.map((p) => ({
      ...p,
      connected: p.isBot ? true : false,
      isReady: p.isBot ? true : Boolean(p.isReady),
      recommendedBoardIds: Array.isArray(p.recommendedBoardIds) ? p.recommendedBoardIds : [],
    })),
    deck: snap.deck,
    discard: snap.discard,
    ticketDeck: snap.ticketDeck,
    sockets: new Map(),
  };
  rooms.set(code, restored);
  return restored;
}

export function listActiveRoomsSummary() {
  const snaps = listSessionSnapshots<{ state: PublicGameState }>();
  return snaps.map((s) => ({
    roomCode: s.state.roomCode,
    boardName: s.state.board?.name ?? 'Selecting board',
    phase: s.state.phase,
    playerCount: s.state.players.length,
    maxPlayers: s.state.board?.maxPlayers ?? 5,
  }));
}

export function createOrGetRoom(requestedCode?: string, initialBoardId?: string): PublicGameState {
  if (requestedCode) {
    const existing = restoreRoomIfNeeded(requestedCode);
    if (existing) return existing.state;
  }

  const roomCode = requestedCode ? requestedCode.toUpperCase().slice(0, 6) : generateRoomCode();
  const board = initialBoardId ? getBoard(initialBoardId) : null;
  const rules = createDefaultRules(board);

  const room: InternalRoom = {
    state: {
      roomCode,
      boardId: board?.id ?? null,
      board,
      hostPlayerId: null,
      phase: 'LOBBY',
      lobbyStep: board ? 'RULE_REVIEW' : 'MAP_VOTE',
      rules,
      players: [],
      faceUpCards: [],
      deckCount: 0,
      discardCount: 0,
      claimedRoutes: {},
      builtStations: {},
      currentTurnIndex: 0,
      turnDrawsRemaining: 2,
      pendingTunnel: null,
      pendingHazard: null,
      finalRoundTriggerPlayerId: null,
      finalTurnsRemaining: 0,
      eventLog: [],
    },
    players: [],
    deck: [],
    discard: [],
    ticketDeck: [],
    sockets: new Map(),
  };

  addEvent(room, `Room ${roomCode} created. Waiting for players.`);
  rooms.set(roomCode, room);
  persistRoom(room);
  return room.state;
}

export function joinRoom(
  roomCode: string,
  nickname: string,
  preferredColor?: PlayerColor,
  existingPlayerId?: string
): { playerId: string; state: PublicGameState } {
  const room = restoreRoomIfNeeded(roomCode);
  if (!room) {
    throw new Error(`Room "${roomCode}" not found.`);
  }

  if (existingPlayerId) {
    const existing = room.players.find((p) => p.id === existingPlayerId);
    if (existing) {
      existing.connected = true;
      syncPublicPlayers(room);
      return { playerId: existing.id, state: room.state };
    }
  }

  if (room.state.phase !== 'LOBBY') {
    throw new Error('Game has already started in this room.');
  }
  const maxP = room.state.board?.maxPlayers ?? 5;
  if (room.players.length >= maxP) {
    throw new Error(`Room is full (max ${maxP} players).`);
  }

  const cleanNick = nickname.trim().slice(0, 22) || `Conductor ${room.players.length + 1}`;
  const usedColors = new Set(room.players.map((p) => p.color));
  const color =
    preferredColor && !usedColors.has(preferredColor)
      ? preferredColor
      : PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? 'crimson';

  const playerId = `p-${crypto.randomBytes(4).toString('hex')}`;
  const totalPieces = computeEffectivePiecesTotal(
    room.state.rules,
    room.state.board,
    room.players.length + 1
  );
  const split = room.state.rules.splitPiecesEnabled
    ? computeRecommendedPieceSplit(room.state.board, totalPieces)
    : { train: totalPieces, bus: 0, ship: 0 };

  const player: InternalPlayer = {
    id: playerId,
    nickname: cleanNick,
    color,
    joinedAt: Date.now(),
    isBot: false,
    connected: true,
    isReady: false,
    recommendedBoardIds: [],
    piecesRemaining: split,
    stationsRemaining: room.state.rules.stationCount,
    cardCount: 0,
    ticketCount: 0,
    score: 0,
    hasPickedInitialTickets: false,
    hasConfiguredSplit: !room.state.rules.splitPiecesEnabled,
    privateState: {
      hand: [],
      tickets: [],
      pendingTickets: [],
    },
  };

  room.players.push(player);
  addEvent(room, `${cleanNick} joined the session.`);
  broadcastRoom(room);
  return { playerId, state: room.state };
}

export function attachSocket(roomCode: string, playerId: string, ws: WebSocket): void {
  const room = restoreRoomIfNeeded(roomCode);
  if (!room) return;
  if (!room.sockets.has(playerId)) {
    room.sockets.set(playerId, new Set());
  }
  room.sockets.get(playerId)!.add(ws);

  const player = room.players.find((p) => p.id === playerId);
  if (player) {
    player.connected = true;
  }
  broadcastRoom(room);
}

export function detachSocket(roomCode: string, playerId: string, ws: WebSocket): void {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return;
  const set = room.sockets.get(playerId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      room.sockets.delete(playerId);
      const player = room.players.find((p) => p.id === playerId);
      if (player && !player.isBot) {
        player.connected = false;
        broadcastRoom(room);
      }
    }
  }
}

function getAvailablePaymentCards(
  hand: CardColor[],
  targetColor: RouteColor,
  length: number,
  ferryLocomotives: number
): CardColor[] | null {
  const locos = hand.filter((c) => c === 'locomotive');
  if (locos.length < ferryLocomotives) return null;

  const tryColor = (c: Exclude<CardColor, 'locomotive'>): CardColor[] | null => {
    const matching = hand.filter((h) => h === c);
    const neededNonFerry = Math.max(0, length - ferryLocomotives);
    const usedMatching = matching.slice(0, neededNonFerry);
    const remainingNeeded = length - usedMatching.length;
    if (locos.length < remainingNeeded || remainingNeeded < ferryLocomotives) {
      return null;
    }
    return [...usedMatching, ...locos.slice(0, remainingNeeded)];
  };

  if (targetColor !== 'gray') {
    return tryColor(targetColor);
  }

  // Gray route: pick the color where player has the most matching cards (using fewest locomotives!)
  let bestPayment: CardColor[] | null = null;
  let bestMatchingCount = -1;
  for (const c of TRAIN_COLORS) {
    const pay = tryColor(c);
    if (pay) {
      const matchCount = pay.filter((x) => x !== 'locomotive').length;
      if (matchCount > bestMatchingCount) {
        bestMatchingCount = matchCount;
        bestPayment = pay;
      }
    }
  }
  return bestPayment;
}

function removeCardsFromHand(hand: CardColor[], cardsToRemove: CardColor[]): CardColor[] {
  const next = [...hand];
  for (const c of cardsToRemove) {
    const idx = next.indexOf(c);
    if (idx >= 0) next.splice(idx, 1);
  }
  return next;
}

function totalRemainingPieces(inv: PieceInventory): number {
  return inv.train + inv.bus + inv.ship;
}

function finishTurn(room: InternalRoom): void {
  const current = room.players[room.state.currentTurnIndex];
  room.state.turnDrawsRemaining = 2;

  if (room.state.phase === 'PLAYING' && current && totalRemainingPieces(current.piecesRemaining) <= 2) {
    room.state.phase = 'FINAL_ROUND';
    room.state.finalRoundTriggerPlayerId = current.id;
    room.state.finalTurnsRemaining = room.players.length;
    addEvent(room, `${current.nickname} has ${totalRemainingPieces(current.piecesRemaining)} pieces left! Final round begins!`);
  } else if (room.state.phase === 'FINAL_ROUND') {
    room.state.finalTurnsRemaining -= 1;
    if (room.state.finalTurnsRemaining <= 0) {
      finalizeGame(room);
      return;
    }
  }

  room.state.currentTurnIndex = (room.state.currentTurnIndex + 1) % room.players.length;
  scheduleBotTurnIfNeeded(room);
}

function isConnectedInGraph(adj: Map<string, Set<string>>, fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const visited = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) || []) {
      if (nxt === toId) return true;
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return false;
}

function computeLongestContinuousPath(routes: BoardRoute[], claimedIds: Set<string>): number {
  const adj = new Map<string, Array<{ id: string; to: string; len: number }>>();
  for (const r of routes) {
    if (!claimedIds.has(r.id)) continue;
    if (!adj.has(r.fromId)) adj.set(r.fromId, []);
    if (!adj.has(r.toId)) adj.set(r.toId, []);
    adj.get(r.fromId)!.push({ id: r.id, to: r.toId, len: r.length });
    adj.get(r.toId)!.push({ id: r.id, to: r.fromId, len: r.length });
  }

  let best = 0;
  const usedEdges = new Set<string>();
  const dfs = (node: string, acc: number) => {
    if (acc > best) best = acc;
    for (const edge of adj.get(node) || []) {
      if (usedEdges.has(edge.id)) continue;
      usedEdges.add(edge.id);
      dfs(edge.to, acc + edge.len);
      usedEdges.delete(edge.id);
    }
  };
  for (const startNode of adj.keys()) {
    dfs(startNode, 0);
  }
  return best;
}

function finalizeGame(room: InternalRoom): void {
  const board = room.state.board;
  if (!board) return;

  const breakdowns: FinalPlayerBreakdown[] = [];
  let maxLongest = 0;

  for (const player of room.players) {
    const claimedRouteIds = new Set<string>();
    const adj = new Map<string, Set<string>>();

    for (const r of board.routes) {
      const claim = room.state.claimedRoutes[r.id];
      if (claim?.laneA === player.id || claim?.laneB === player.id || claim?.laneC === player.id) {
        claimedRouteIds.add(r.id);
        if (!adj.has(r.fromId)) adj.set(r.fromId, new Set());
        if (!adj.has(r.toId)) adj.set(r.toId, new Set());
        adj.get(r.fromId)!.add(r.toId);
        adj.get(r.toId)!.add(r.fromId);
      }
    }

    // Stations allow borrowing 1 adjacent opponent route per built station
    for (const [locId, ownerId] of Object.entries(room.state.builtStations)) {
      if (ownerId !== player.id) continue;
      // Pick the highest-value opponent route touching locId that helps connect tickets
      for (const r of board.routes) {
        if (r.fromId !== locId && r.toId !== locId) continue;
        const claim = room.state.claimedRoutes[r.id];
        if (claim?.laneA || claim?.laneB || claim?.laneC) {
          if (!adj.has(r.fromId)) adj.set(r.fromId, new Set());
          if (!adj.has(r.toId)) adj.set(r.toId, new Set());
          adj.get(r.fromId)!.add(r.toId);
          adj.get(r.toId)!.add(r.fromId);
          break;
        }
      }
    }

    let ticketPoints = 0;
    const evaluatedTickets = player.privateState.tickets.map((t) => {
      const completed = isConnectedInGraph(adj, t.fromId, t.toId);
      ticketPoints += completed ? t.points : -t.points;
      return {
        id: t.id,
        fromName: t.fromName,
        toName: t.toName,
        points: t.points,
        completed,
      };
    });

    const longestRouteLength = computeLongestContinuousPath(board.routes, claimedRouteIds);
    if (longestRouteLength > maxLongest) maxLongest = longestRouteLength;

    const stationPoints =
      room.state.rules.stationsEnabled && room.state.rules.stationCount > 0
        ? player.stationsRemaining * 4
        : 0;

    breakdowns.push({
      playerId: player.id,
      nickname: player.nickname,
      color: player.color,
      routePoints: player.score,
      ticketPoints,
      longestRouteBonus: 0,
      stationPoints,
      totalScore: 0,
      longestRouteLength,
      tickets: evaluatedTickets,
    });
  }

  for (const b of breakdowns) {
    if (maxLongest > 0 && b.longestRouteLength === maxLongest) {
      b.longestRouteBonus = 10;
    }
    b.totalScore = b.routePoints + b.ticketPoints + b.longestRouteBonus + b.stationPoints;
    const p = room.players.find((pl) => pl.id === b.playerId);
    if (p) p.score = b.totalScore;
  }

  breakdowns.sort((a, b) => b.totalScore - a.totalScore);
  room.state.finalBreakdown = breakdowns;
  room.state.phase = 'GAME_OVER';
  addEvent(room, `Game Over! ${breakdowns[0]?.nickname ?? 'Winner'} takes the crown with ${breakdowns[0]?.totalScore ?? 0} points!`);
  broadcastRoom(room);
}

function executeRouteClaimCommit(
  room: InternalRoom,
  player: InternalPlayer,
  route: BoardRoute,
  lane: 'laneA' | 'laneB' | 'laneC',
  cardsUsed: CardColor[]
): void {
  const pieceType = getRequiredPieceType(route.transportMode, room.state.rules.splitPiecesEnabled);
  player.piecesRemaining[pieceType] = Math.max(0, player.piecesRemaining[pieceType] - route.length);
  player.privateState.hand = removeCardsFromHand(player.privateState.hand, cardsUsed);
  room.discard.push(...cardsUsed);

  if (!room.state.claimedRoutes[route.id]) {
    room.state.claimedRoutes[route.id] = {};
  }
  room.state.claimedRoutes[route.id][lane] = player.id;

  const pts = getRoutePoints(route.length);
  player.score += pts;

  const fromName = room.state.board?.locations.find((l) => l.id === route.fromId)?.name ?? route.fromId;
  const toName = room.state.board?.locations.find((l) => l.id === route.toId)?.name ?? route.toId;
  addEvent(room, `${player.nickname} claimed ${fromName} ↔ ${toName} (${route.length} ${pieceType}s, +${pts} pts).`);
}

function scheduleBotTurnIfNeeded(room: InternalRoom): void {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = undefined;
  }
  if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') return;
  const current = room.players[room.state.currentTurnIndex];
  if (!current || !current.isBot) return;

  room.botTimer = setTimeout(() => {
    try {
      runBotTurn(room, current);
    } catch {
      finishTurn(room);
      broadcastRoom(room);
    }
  }, 650);
}

function runBotTurn(room: InternalRoom, bot: InternalPlayer): void {
  if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') return;
  const board = room.state.board;
  if (!board) return;

  // Resolve pending tunnel if bot triggered one
  if (room.state.pendingTunnel && room.state.pendingTunnel.playerId === bot.id) {
    const pt = room.state.pendingTunnel;
    const remainingHand = removeCardsFromHand(bot.privateState.hand, pt.cardsUsed);
    const extraPay = getAvailablePaymentCards(
      remainingHand,
      pt.targetColor,
      pt.extraRequired,
      0
    );
    handleRoomAction(room.state.roomCode, bot.id, {
      type: 'resolve_tunnel',
      pay: Boolean(extraPay),
      extraCards: extraPay ?? [],
    });
    return;
  }

  // Try claiming an unclaimed route (preferring shorter/affordable routes)
  const shuffledRoutes = shuffle(board.routes);
  const allowDouble = isDualRailwayAllowed(
    room.players.length,
    room.state.rules.doubleRouteMinPlayers
  );
  for (const r of shuffledRoutes) {
    const claim = room.state.claimedRoutes[r.id] || {};
    const laneCount = r.laneCount ?? (r.isDouble ? 2 : 1);
    const isMulti = laneCount >= 2;
    const anyClaim = Boolean(claim.laneA || claim.laneB || claim.laneC);
    if (isMulti && !allowDouble && anyClaim) continue;
    if (claim.laneA === bot.id || claim.laneB === bot.id || claim.laneC === bot.id) continue;

    const lanesToTry: Array<'laneA' | 'laneB' | 'laneC'> = [];
    if (!claim.laneA) lanesToTry.push('laneA');
    if (laneCount >= 2 && !claim.laneB) lanesToTry.push('laneB');
    if (laneCount >= 3 && !claim.laneC) lanesToTry.push('laneC');
    if (lanesToTry.length === 0) continue;

    for (const lane of lanesToTry) {
      const targetColor =
        lane === 'laneC'
          ? r.tripleColor ?? r.doubleColor ?? r.color
          : lane === 'laneB'
            ? r.doubleColor ?? r.color
            : r.color;
      const pieceType = getRequiredPieceType(r.transportMode, room.state.rules.splitPiecesEnabled);
      if (bot.piecesRemaining[pieceType] < r.length) continue;

      const ferryLocos = room.state.rules.enabledHazards.ferries ? r.ferryLocomotives : 0;
      const pay = getAvailablePaymentCards(bot.privateState.hand, targetColor, r.length, ferryLocos);
      if (pay) {
        handleRoomAction(room.state.roomCode, bot.id, {
          type: 'claim_route',
          routeId: r.id,
          lane,
          cardsUsed: pay,
        });
        if (room.state.pendingHazard?.playerId === bot.id) {
          handleRoomAction(room.state.roomCode, bot.id, { type: 'ack_hazard' });
        }
        if (room.state.pendingTunnel?.playerId === bot.id) {
          runBotTurn(room, bot);
        }
        return;
      }
    }
  }

  // Otherwise draw 2 cards
  if (room.state.turnDrawsRemaining === 2) {
    const nextState = handleRoomAction(room.state.roomCode, bot.id, {
      type: 'draw_card',
      source: 'deck',
    });
    if (
      nextState.turnDrawsRemaining === 1 &&
      nextState.players[nextState.currentTurnIndex]?.id === bot.id
    ) {
      handleRoomAction(room.state.roomCode, bot.id, { type: 'draw_card', source: 'deck' });
    }
  }
}

export function handleRoomAction(
  roomCode: string,
  playerId: string,
  action: any
): PublicGameState {
  const room = restoreRoomIfNeeded(roomCode);
  if (!room) throw new Error('Room not found.');

  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Player not in room.');
  const isHost = room.state.hostPlayerId === playerId;

  switch (action.type) {
    case 'toggle_recommend_board': {
      if (room.state.phase !== 'LOBBY') throw new Error('Map recommendations are only open in lobby.');
      const targetBoardId = String(action.boardId || '');
      if (!targetBoardId || !getBoard(targetBoardId)) {
        throw new Error('Board not found.');
      }
      const cur = Array.isArray(player.recommendedBoardIds) ? [...player.recommendedBoardIds] : [];
      const existingIdx = cur.indexOf(targetBoardId);
      if (existingIdx >= 0) {
        cur.splice(existingIdx, 1);
      } else {
        if (cur.length >= 3) {
          throw new Error('You can recommend up to 3 maps. Deselect one first.');
        }
        cur.push(targetBoardId);
      }
      player.recommendedBoardIds = cur;
      broadcastRoom(room);
      return room.state;
    }

    case 'clear_recommendations': {
      if (room.state.phase !== 'LOBBY') throw new Error('Map recommendations are only open in lobby.');
      player.recommendedBoardIds = [];
      broadcastRoom(room);
      return room.state;
    }

    case 'select_board': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can choose the map in lobby.');
      const board = getBoard(String(action.boardId));
      if (!board) throw new Error('Board not found.');
      room.state.boardId = board.id;
      room.state.board = board;
      room.state.lobbyStep = 'RULE_REVIEW';
      room.state.rules = getBakedBoardRules(board);

      const total = computeEffectivePiecesTotal(room.state.rules, board, room.players.length);
      for (const p of room.players) {
        p.piecesRemaining = room.state.rules.splitPiecesEnabled
          ? computeRecommendedPieceSplit(board, total)
          : { train: total, bus: 0, ship: 0 };
        p.stationsRemaining = room.state.rules.stationCount;
        p.hasConfiguredSplit = !room.state.rules.splitPiecesEnabled;
        if (!p.isBot) p.isReady = false;
      }
      addEvent(room, `Host selected map "${board.name}". Review rules and mark Ready.`);
      broadcastRoom(room);
      return room.state;
    }

    case 'reopen_map_selection': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can reopen map selection.');
      room.state.lobbyStep = 'MAP_VOTE';
      for (const p of room.players) {
        if (!p.isBot) p.isReady = false;
      }
      addEvent(room, 'Host reopened map selection for the room.');
      broadcastRoom(room);
      return room.state;
    }

    case 'update_rules': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can update rules in lobby.');
      const merged = {
        ...room.state.rules,
        ...(action.rules || {}),
        enabledHazards: {
          ...room.state.rules.enabledHazards,
          ...(action.rules?.enabledHazards || {}),
        },
      };
      if (typeof action.rules?.stationsEnabled === 'boolean' && action.rules?.stationCount === undefined) {
        merged.stationCount = action.rules.stationsEnabled ? Math.max(1, room.state.rules.stationCount || 3) : 0;
      }
      const nextRules = normalizeGameRules(merged, room.state.board);
      room.state.rules = nextRules;

      const total = computeEffectivePiecesTotal(nextRules, room.state.board, room.players.length);
      for (const p of room.players) {
        p.piecesRemaining = nextRules.splitPiecesEnabled
          ? computeRecommendedPieceSplit(room.state.board, total)
          : { train: total, bus: 0, ship: 0 };
        p.stationsRemaining = nextRules.stationCount;
        p.hasConfiguredSplit = !nextRules.splitPiecesEnabled;
        if (!p.isBot) p.isReady = false;
      }
      addEvent(room, 'Host customized session rules.');
      broadcastRoom(room);
      return room.state;
    }

    case 'reset_rules_to_board': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can reset rules.');
      if (!room.state.board) throw new Error('No map selected.');
      const nextRules = getBakedBoardRules(room.state.board);
      room.state.rules = nextRules;

      const total = computeEffectivePiecesTotal(nextRules, room.state.board, room.players.length);
      for (const p of room.players) {
        p.piecesRemaining = nextRules.splitPiecesEnabled
          ? computeRecommendedPieceSplit(room.state.board, total)
          : { train: total, bus: 0, ship: 0 };
        p.stationsRemaining = nextRules.stationCount;
        p.hasConfiguredSplit = !nextRules.splitPiecesEnabled;
        if (!p.isBot) p.isReady = false;
      }
      addEvent(room, 'Host reset rules to the map defaults.');
      broadcastRoom(room);
      return room.state;
    }

    case 'toggle_ready': {
      if (room.state.phase !== 'LOBBY') throw new Error('Ready status can only change in lobby.');
      if (!room.state.board || room.state.lobbyStep !== 'RULE_REVIEW') {
        throw new Error('Select a map before marking ready.');
      }
      const nextReady = typeof action.ready === 'boolean' ? action.ready : !player.isReady;
      player.isReady = nextReady;
      addEvent(room, `${player.nickname} is ${nextReady ? 'ready' : 'not ready'}.`);
      broadcastRoom(room);
      return room.state;
    }

    case 'set_piece_split': {
      if (room.state.phase !== 'LOBBY' || !room.state.rules.splitPiecesEnabled) {
        throw new Error('Piece splitting is not active.');
      }
      const totalAllowed = computeEffectivePiecesTotal(
        room.state.rules,
        room.state.board,
        room.players.length
      );
      const train = Math.max(0, Math.round(Number(action.train) || 0));
      const bus = Math.max(0, Math.round(Number(action.bus) || 0));
      const ship = Math.max(0, Math.round(Number(action.ship) || 0));
      if (train + bus + ship !== totalAllowed) {
        throw new Error(`Split must total exactly ${totalAllowed} pieces.`);
      }
      player.piecesRemaining = { train, bus, ship };
      player.hasConfiguredSplit = true;
      broadcastRoom(room);
      return room.state;
    }

    case 'add_bot': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can add bots.');
      const maxP = room.state.board?.maxPlayers ?? 5;
      if (room.players.length >= maxP) throw new Error(`Max ${maxP} players reached.`);
      const usedColors = new Set(room.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? 'amber';
      const total = computeEffectivePiecesTotal(
        room.state.rules,
        room.state.board,
        room.players.length + 1
      );
      const botNames = ['Locomotive AI', 'Express Bot', 'Dispatch Bot', 'Harbor AI'];
      const botName = botNames[room.players.filter((p) => p.isBot).length % botNames.length];
      const bot: InternalPlayer = {
        id: `bot-${crypto.randomBytes(3).toString('hex')}`,
        nickname: botName,
        color,
        joinedAt: Date.now() + 100000,
        isBot: true,
        connected: true,
        isReady: true,
        recommendedBoardIds: [],
        piecesRemaining: room.state.rules.splitPiecesEnabled
          ? computeRecommendedPieceSplit(room.state.board, total)
          : { train: total, bus: 0, ship: 0 },
        stationsRemaining: room.state.rules.stationCount,
        cardCount: 0,
        ticketCount: 0,
        score: 0,
        hasPickedInitialTickets: true,
        hasConfiguredSplit: true,
        privateState: { hand: [], tickets: [], pendingTickets: [] },
      };
      room.players.push(bot);
      addEvent(room, `${botName} joined as AI opponent.`);
      broadcastRoom(room);
      return room.state;
    }

    case 'remove_bot': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can remove bots.');
      room.players = room.players.filter((p) => !(p.id === action.botId && p.isBot));
      broadcastRoom(room);
      return room.state;
    }

    case 'start_game': {
      if (!isHost || room.state.phase !== 'LOBBY') throw new Error('Only host can start.');
      if (!room.state.board || room.state.lobbyStep !== 'RULE_REVIEW') {
        throw new Error('Decide on a map first.');
      }
      if (room.players.length < 2) throw new Error('At least 2 players (or 1 human + 1 bot) required.');
      if (!room.players.every((p) => p.isReady)) {
        throw new Error('Every player (including the host) must mark Ready before starting.');
      }

      room.deck = buildTrainDeck(room.state.rules, room.state.board);
      room.discard = [];
      room.state.faceUpCards = [];
      room.ticketDeck = shuffle(room.state.board.tickets);
      room.state.claimedRoutes = {};
      room.state.builtStations = {};
      room.state.finalBreakdown = undefined;
      room.state.pendingTunnel = null;
      room.state.pendingHazard = null;

      const totalPieces = computeEffectivePiecesTotal(
        room.state.rules,
        room.state.board,
        room.players.length
      );

      // Randomize starting player order
      const firstIndex = Math.floor(Math.random() * room.players.length);
      room.state.currentTurnIndex = firstIndex;
      room.state.turnDrawsRemaining = 2;

      for (const p of room.players) {
        if (!room.state.rules.splitPiecesEnabled) {
          p.piecesRemaining = { train: totalPieces, bus: 0, ship: 0 };
        } else if (totalRemainingPieces(p.piecesRemaining) !== totalPieces) {
          p.piecesRemaining = computeRecommendedPieceSplit(room.state.board, totalPieces);
        }
        p.stationsRemaining = room.state.rules.stationCount;
        p.score = 0;
        p.privateState.hand = [];
        for (let i = 0; i < 4; i++) {
          const c = drawFromDeck(room);
          if (c) p.privateState.hand.push(c);
        }
        const initialTickets: DestinationTicket[] = [];
        for (let i = 0; i < room.state.rules.ticketsInitialDraw; i++) {
          const t = room.ticketDeck.pop();
          if (t) initialTickets.push(t);
        }
        if (p.isBot) {
          p.privateState.tickets = initialTickets.slice(0, room.state.rules.ticketsInitialKeep);
          p.privateState.pendingTickets = [];
          p.hasPickedInitialTickets = true;
        } else {
          p.privateState.tickets = [];
          p.privateState.pendingTickets = initialTickets;
          p.hasPickedInitialTickets = false;
        }
      }

      refillFaceUp(room);
      const allHumansReady = room.players.every((p) => p.hasPickedInitialTickets);
      room.state.phase = allHumansReady ? 'PLAYING' : 'INITIAL_TICKETS';
      addEvent(
        room,
        `Game started! Random draw selected ${room.players[firstIndex].nickname} to go first.`
      );
      broadcastRoom(room);
      if (room.state.phase === 'PLAYING') scheduleBotTurnIfNeeded(room);
      return room.state;
    }

    case 'pick_initial_tickets': {
      if (room.state.phase !== 'INITIAL_TICKETS') throw new Error('Not in initial ticket phase.');
      const keepIds = new Set<string>(Array.isArray(action.ticketIds) ? action.ticketIds : []);
      const kept = player.privateState.pendingTickets.filter((t) => keepIds.has(t.id));
      if (kept.length < Math.min(room.state.rules.ticketsInitialKeep, player.privateState.pendingTickets.length)) {
        throw new Error(`Must keep at least ${room.state.rules.ticketsInitialKeep} tickets.`);
      }
      const returned = player.privateState.pendingTickets.filter((t) => !keepIds.has(t.id));
      room.ticketDeck.unshift(...returned);
      player.privateState.tickets.push(...kept);
      player.privateState.pendingTickets = [];
      player.hasPickedInitialTickets = true;

      addEvent(room, `${player.nickname} kept ${kept.length} starting destination tickets.`);
      if (room.players.every((p) => p.hasPickedInitialTickets)) {
        room.state.phase = 'PLAYING';
        addEvent(room, `All players ready! ${room.players[room.state.currentTurnIndex].nickname}'s turn.`);
        scheduleBotTurnIfNeeded(room);
      }
      broadcastRoom(room);
      return room.state;
    }

    case 'draw_card': {
      if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') {
        throw new Error('Game not active.');
      }
      const active = room.players[room.state.currentTurnIndex];
      if (active?.id !== playerId) throw new Error('Not your turn.');
      if (room.state.pendingTunnel || room.state.pendingHazard) {
        throw new Error('Resolve pending route challenge first.');
      }

      if (action.source === 'deck') {
        const card = drawFromDeck(room);
        if (!card) throw new Error('No cards left in deck or discard.');
        player.privateState.hand.push(card);
        room.state.turnDrawsRemaining -= 1;
        addEvent(room, `${player.nickname} drew a card from the deck.`);
      } else {
        const idx = Number(action.index);
        const card = room.state.faceUpCards[idx];
        if (!card) throw new Error('Invalid face-up card slot.');
        if (card === 'locomotive' && room.state.turnDrawsRemaining < 2) {
          throw new Error('Cannot take a face-up Locomotive as your second draw.');
        }
        room.state.faceUpCards.splice(idx, 1);
        player.privateState.hand.push(card);
        room.state.turnDrawsRemaining -= card === 'locomotive' ? 2 : 1;
        refillFaceUp(room);
        addEvent(room, `${player.nickname} took a face-up ${card} card.`);
      }

      if (room.state.turnDrawsRemaining <= 0) {
        finishTurn(room);
      }
      broadcastRoom(room);
      return room.state;
    }

    case 'draw_tickets': {
      if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') {
        throw new Error('Game not active.');
      }
      const active = room.players[room.state.currentTurnIndex];
      if (active?.id !== playerId) throw new Error('Not your turn.');
      if (room.state.turnDrawsRemaining < 2) throw new Error('Cannot draw tickets after drawing a card.');
      if (room.ticketDeck.length === 0) throw new Error('Ticket deck is empty.');

      const drawn: DestinationTicket[] = [];
      for (let i = 0; i < room.state.rules.ticketsMidDraw; i++) {
        const t = room.ticketDeck.pop();
        if (t) drawn.push(t);
      }
      player.privateState.pendingTickets = drawn;
      addEvent(room, `${player.nickname} drew ${drawn.length} destination tickets to inspect.`);
      broadcastRoom(room);
      return room.state;
    }

    case 'keep_tickets': {
      const pending = player.privateState.pendingTickets;
      if (pending.length === 0) throw new Error('No pending tickets.');
      const keepIds = new Set<string>(Array.isArray(action.ticketIds) ? action.ticketIds : []);
      const kept = pending.filter((t) => keepIds.has(t.id));
      const minKeep = Math.min(room.state.rules.ticketsMidKeep, pending.length);
      if (kept.length < minKeep) throw new Error(`Keep at least ${minKeep} ticket.`);
      const returned = pending.filter((t) => !keepIds.has(t.id));
      room.ticketDeck.unshift(...returned);
      player.privateState.tickets.push(...kept);
      player.privateState.pendingTickets = [];
      addEvent(room, `${player.nickname} kept ${kept.length} new destination ticket(s).`);
      finishTurn(room);
      broadcastRoom(room);
      return room.state;
    }

    case 'claim_route': {
      if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') {
        throw new Error('Game not active.');
      }
      const active = room.players[room.state.currentTurnIndex];
      if (active?.id !== playerId) throw new Error('Not your turn.');
      if (room.state.turnDrawsRemaining < 2) throw new Error('Finish drawing your second card first.');

      const board = room.state.board;
      const route = board?.routes.find((r) => r.id === action.routeId);
      if (!route) throw new Error('Route not found.');

      const laneCount = route.laneCount ?? (route.isDouble ? 2 : 1);
      const isMulti = laneCount >= 2;
      const lane: 'laneA' | 'laneB' | 'laneC' =
        action.lane === 'laneC' && laneCount >= 3
          ? 'laneC'
          : action.lane === 'laneB' && laneCount >= 2
            ? 'laneB'
            : 'laneA';
      const existing = room.state.claimedRoutes[route.id] || {};
      const doubleAllowed = isDualRailwayAllowed(
        room.players.length,
        room.state.rules.doubleRouteMinPlayers
      );

      if (existing[lane]) throw new Error('This route lane is already claimed.');
      if (isMulti && !doubleAllowed && (existing.laneA || existing.laneB || existing.laneC)) {
        throw new Error(
          room.state.rules.doubleRouteMinPlayers === 0
            ? 'Dual railways are disabled in this session; corridor already claimed.'
            : `Dual railways require ${room.state.rules.doubleRouteMinPlayers}+ players; corridor already claimed.`
        );
      }
      if (existing.laneA === playerId || existing.laneB === playerId || existing.laneC === playerId) {
        throw new Error('You already own a parallel lane on this route.');
      }

      const pieceType = getRequiredPieceType(route.transportMode, room.state.rules.splitPiecesEnabled);
      if (player.piecesRemaining[pieceType] < route.length) {
        throw new Error(`Not enough ${pieceType} pieces remaining.`);
      }

      const targetColor =
        lane === 'laneC'
          ? route.tripleColor ?? route.doubleColor ?? route.color
          : lane === 'laneB'
            ? route.doubleColor ?? route.color
            : route.color;
      const ferryReq = room.state.rules.enabledHazards.ferries ? route.ferryLocomotives : 0;

      // Use client-selected cards if valid, else auto-pick from hand
      let cardsUsed: CardColor[] | null = null;
      if (Array.isArray(action.cardsUsed) && action.cardsUsed.length === route.length) {
        const candidate: CardColor[] = action.cardsUsed;
        const tempHand = [...player.privateState.hand];
        let validOwnership = true;
        for (const c of candidate) {
          const i = tempHand.indexOf(c);
          if (i < 0) {
            validOwnership = false;
            break;
          }
          tempHand.splice(i, 1);
        }
        const locosCount = candidate.filter((c) => c === 'locomotive').length;
        const nonLocos = candidate.filter((c) => c !== 'locomotive');
        const allSameColor = new Set(nonLocos).size <= 1;
        const colorMatches =
          targetColor === 'gray' || nonLocos.length === 0 || nonLocos[0] === targetColor;
        if (validOwnership && locosCount >= ferryReq && allSameColor && colorMatches) {
          cardsUsed = candidate;
        }
      }
      if (!cardsUsed) {
        cardsUsed = getAvailablePaymentCards(
          player.privateState.hand,
          targetColor,
          route.length,
          ferryReq
        );
      }
      if (!cardsUsed) {
        throw new Error('You do not have the required matching cards or ferry locomotives.');
      }

      // Check probabilistic Collision / Shipping Hazard FIRST
      const hazardActive =
        route.hazardRating > 0 &&
        ((route.hazardType === 'bus_crossing' && room.state.rules.enabledHazards.busCrossings) ||
          (route.hazardType === 'shipping_lane' && room.state.rules.enabledHazards.shippingHazards));

      if (hazardActive) {
        const roll = Math.floor(Math.random() * 6) + 1;
        const success = roll > route.hazardRating;
        room.state.pendingHazard = {
          playerId,
          routeId: route.id,
          lane,
          cardsUsed,
          hazardRating: route.hazardRating,
          hazardType: route.hazardType,
          rollResult: roll,
          success,
        };
        if (!success) {
          // Failed collision/maritime roll: lose 1 piece, route placement canceled!
          player.piecesRemaining[pieceType] = Math.max(0, player.piecesRemaining[pieceType] - 1);
          addEvent(
            room,
            `${player.nickname} rolled ${roll} (needed >${route.hazardRating}) on hazard! Lost 1 ${pieceType} and route canceled.`
          );
        } else {
          addEvent(
            room,
            `${player.nickname} rolled ${roll} (needed >${route.hazardRating}) and cleared the hazard!`
          );
        }
        broadcastRoom(room);
        return room.state;
      }

      // Check Tunnel flip (Ticket to Ride Europe)
      if (route.isTunnel && room.state.rules.enabledHazards.tunnels) {
        const drawnCards: CardColor[] = [];
        for (let i = 0; i < 3; i++) {
          const c = drawFromDeck(room);
          if (c) drawnCards.push(c);
        }
        room.discard.push(...drawnCards);

        const matchColor =
          targetColor === 'gray'
            ? cardsUsed.find((c) => c !== 'locomotive') ?? 'locomotive'
            : targetColor;
        const extraRequired = drawnCards.filter(
          (c) => c === 'locomotive' || (matchColor !== 'locomotive' && c === matchColor)
        ).length;

        if (extraRequired === 0) {
          executeRouteClaimCommit(room, player, route, lane, cardsUsed);
          addEvent(room, `Tunnel flip clear (0 matching cards drawn).`);
          finishTurn(room);
        } else {
          room.state.pendingTunnel = {
            playerId,
            routeId: route.id,
            lane,
            cardsUsed,
            drawnCards,
            extraRequired,
            targetColor: matchColor as RouteColor,
          };
          addEvent(
            room,
            `Tunnel flip drew ${drawnCards.join(', ')} — requires ${extraRequired} extra card(s).`
          );
        }
        broadcastRoom(room);
        return room.state;
      }

      executeRouteClaimCommit(room, player, route, lane, cardsUsed);
      finishTurn(room);
      broadcastRoom(room);
      return room.state;
    }

    case 'ack_hazard': {
      const ph = room.state.pendingHazard;
      if (!ph || ph.playerId !== playerId) throw new Error('No pending hazard.');
      room.state.pendingHazard = null;

      if (!ph.success) {
        finishTurn(room);
        broadcastRoom(room);
        return room.state;
      }

      const route = room.state.board?.routes.find((r) => r.id === ph.routeId);
      if (!route) {
        finishTurn(room);
        broadcastRoom(room);
        return room.state;
      }

      // Proceed to tunnel check if route is also a tunnel
      if (route.isTunnel && room.state.rules.enabledHazards.tunnels) {
        const drawnCards: CardColor[] = [];
        for (let i = 0; i < 3; i++) {
          const c = drawFromDeck(room);
          if (c) drawnCards.push(c);
        }
        room.discard.push(...drawnCards);
        const targetColor =
          ph.lane === 'laneC'
            ? route.tripleColor ?? route.doubleColor ?? route.color
            : ph.lane === 'laneB'
              ? route.doubleColor ?? route.color
              : route.color;
        const matchColor =
          targetColor === 'gray'
            ? ph.cardsUsed.find((c) => c !== 'locomotive') ?? 'locomotive'
            : targetColor;
        const extraRequired = drawnCards.filter(
          (c) => c === 'locomotive' || (matchColor !== 'locomotive' && c === matchColor)
        ).length;

        if (extraRequired > 0) {
          room.state.pendingTunnel = {
            playerId,
            routeId: route.id,
            lane: ph.lane,
            cardsUsed: ph.cardsUsed,
            drawnCards,
            extraRequired,
            targetColor: matchColor as RouteColor,
          };
          broadcastRoom(room);
          return room.state;
        }
      }

      executeRouteClaimCommit(room, player, route, ph.lane, ph.cardsUsed);
      finishTurn(room);
      broadcastRoom(room);
      return room.state;
    }

    case 'resolve_tunnel': {
      const pt = room.state.pendingTunnel;
      if (!pt || pt.playerId !== playerId) throw new Error('No pending tunnel.');
      const route = room.state.board?.routes.find((r) => r.id === pt.routeId);
      room.state.pendingTunnel = null;

      if (!action.pay || !route) {
        addEvent(room, `${player.nickname} aborted the tunnel crossing and kept their cards.`);
        finishTurn(room);
        broadcastRoom(room);
        return room.state;
      }

      const remainingHand = removeCardsFromHand(player.privateState.hand, pt.cardsUsed);
      const extraPay = getAvailablePaymentCards(
        remainingHand,
        pt.targetColor,
        pt.extraRequired,
        0
      );
      if (!extraPay) {
        addEvent(room, `${player.nickname} lacked extra tunnel cards; crossing aborted.`);
        finishTurn(room);
        broadcastRoom(room);
        return room.state;
      }

      executeRouteClaimCommit(room, player, route, pt.lane, [...pt.cardsUsed, ...extraPay]);
      finishTurn(room);
      broadcastRoom(room);
      return room.state;
    }

    case 'build_station': {
      const maxStations = room.state.rules.stationCount ?? (room.state.rules.stationsEnabled ? 3 : 0);
      if (!room.state.rules.stationsEnabled || maxStations <= 0) {
        throw new Error('Stations are disabled.');
      }
      if (room.state.phase !== 'PLAYING' && room.state.phase !== 'FINAL_ROUND') {
        throw new Error('Game not active.');
      }
      const active = room.players[room.state.currentTurnIndex];
      if (active?.id !== playerId) throw new Error('Not your turn.');
      if (room.state.turnDrawsRemaining < 2) throw new Error('Finish drawing your second card first.');
      if (player.stationsRemaining <= 0) throw new Error('No stations remaining.');

      const locId = String(action.locationId);
      if (room.state.builtStations[locId]) throw new Error('Location already has a station.');
      const builtCount = Math.max(0, maxStations - player.stationsRemaining);
      const cost = Math.min(4, builtCount + 1); // 1st=1, 2nd=2, 3rd=3, 4th+=4
      const pay = getAvailablePaymentCards(player.privateState.hand, 'gray', cost, 0);
      if (!pay) throw new Error(`Need ${cost} matching cards to build this station.`);

      player.privateState.hand = removeCardsFromHand(player.privateState.hand, pay);
      room.discard.push(...pay);
      player.stationsRemaining -= 1;
      room.state.builtStations[locId] = playerId;

      const locName = room.state.board?.locations.find((l) => l.id === locId)?.name ?? locId;
      addEvent(room, `${player.nickname} built a Station in ${locName} (${cost} card${cost > 1 ? 's' : ''}).`);
      finishTurn(room);
      broadcastRoom(room);
      return room.state;
    }

    default:
      throw new Error(`Unknown action: ${String(action.type)}`);
  }
}
