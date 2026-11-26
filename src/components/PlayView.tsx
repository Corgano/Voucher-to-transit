import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Crosshair,
  Crown,
  Dices,
  Layers,
  LogOut,
  Maximize2,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Ticket,
  TrainFront,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  BoardDefinition,
  BoardLocation,
  BoardRoute,
  BoardRulePreset,
  CardColor,
  DeckBasisEdition,
  PlayerColor,
  PlayerPrivate,
  PublicGameState,
} from '../shared/types';
import {
  computeBoardStats,
  computeDeckDistributionCounts,
  computeRecommendedDeckSize,
  computeRecommendedPieceSplit,
  isDualRailwayAllowed,
  OFFICIAL_TTR_BENCHMARKS,
  PLAYER_COLOR_HEX,
  ROUTE_COLOR_HEX,
  summarizeBoardRules,
} from '../shared/benchmarks';
import { soundFx } from '../lib/sound';
import { BoardCanvas } from './BoardCanvas';
import { GeoBoardMap } from './GeoBoardMap';
import { LocomotiveSilhouette, RouteColorSymbol } from './RouteSymbolSvg';

interface PlayViewProps {
  initialBoardId?: string | null;
  initialRoomCode?: string | null;
  isolatedPlayOnly: boolean;
  primaryPort: number;
  playPort: number | null;
}

const CARD_COLORS_ORDER: CardColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
  'locomotive',
];

function getCardStyle(color: CardColor): { bg: string; text: string; border: string; label: string } {
  if (color === 'locomotive') {
    return {
      bg: 'bg-gradient-to-br from-amber-400 via-rose-500 to-indigo-600',
      text: 'text-white',
      border: 'border-amber-300',
      label: 'Loco',
    };
  }
  const map: Record<Exclude<CardColor, 'locomotive'>, { bg: string; text: string; border: string; label: string }> = {
    red: { bg: 'bg-red-600', text: 'text-white', border: 'border-red-800', label: 'Red' },
    orange: { bg: 'bg-orange-500', text: 'text-white', border: 'border-orange-700', label: 'Orange' },
    yellow: { bg: 'bg-yellow-400', text: 'text-slate-900', border: 'border-yellow-600', label: 'Yellow' },
    green: { bg: 'bg-green-600', text: 'text-white', border: 'border-green-800', label: 'Green' },
    blue: { bg: 'bg-blue-600', text: 'text-white', border: 'border-blue-800', label: 'Blue' },
    purple: { bg: 'bg-purple-600', text: 'text-white', border: 'border-purple-800', label: 'Purple' },
    black: { bg: 'bg-slate-900', text: 'text-white', border: 'border-slate-700', label: 'Black' },
    white: { bg: 'bg-white', text: 'text-slate-900', border: 'border-slate-400', label: 'White' },
  };
  return map[color];
}

export const PlayView: React.FC<PlayViewProps> = ({
  initialBoardId,
  initialRoomCode,
  isolatedPlayOnly,
  playPort,
}) => {
  const [boards, setBoards] = useState<BoardDefinition[]>([]);
  const [activeRooms, setActiveRooms] = useState<
    Array<{ roomCode: string; boardName: string; phase: string; playerCount: number; maxPlayers: number }>
  >([]);

  const [nickname, setNickname] = useState('');
  const [preferredColor, setPreferredColor] = useState<PlayerColor>('crimson');
  const [roomInput, setRoomInput] = useState(initialRoomCode || '');
  const [selectedCreateBoardId, setSelectedCreateBoardId] = useState<string>(initialBoardId || '');

  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [gameState, setGameState] = useState<PublicGameState | null>(null);
  const [privateState, setPrivateState] = useState<PlayerPrivate>({
    hand: [],
    tickets: [],
    pendingTickets: [],
  });

  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(new Set());
  const [hoveredTicketEndpoints, setHoveredTicketEndpoints] = useState<Set<string>>(new Set());
  const [stationMode, setStationMode] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [previewModalBoard, setPreviewModalBoard] = useState<BoardDefinition | null>(null);
  const [previewFitTrigger, setPreviewFitTrigger] = useState(0);
  const [isCustomizingRules, setIsCustomizingRules] = useState(false);
  const [boardPresets, setBoardPresets] = useState<BoardRulePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [presetNameInput, setPresetNameInput] = useState('');
  const [inspectedObj, setInspectedObj] = useState<
    | { kind: 'hazard'; route: BoardRoute }
    | { kind: 'city'; loc: BoardLocation }
    | { kind: 'route'; route: BoardRoute; lane: 'laneA' | 'laneB' | 'laneC' }
    | null
  >(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [splitTrain, setSplitTrain] = useState(25);
  const [splitBus, setSplitBus] = useState(10);
  const [splitShip, setSplitShip] = useState(10);

  const wsRef = useRef<WebSocket | null>(null);
  const lastLogIdRef = useRef<string | null>(null);

  const loadLobbyDirectory = async () => {
    try {
      const [bRes, rRes] = await Promise.all([
        fetch('/api/play/boards').then((r) => r.json()),
        fetch('/api/play/rooms').then((r) => r.json()),
      ]);
      if (Array.isArray(bRes.boards)) {
        setBoards(bRes.boards);
      }
      if (Array.isArray(rRes.rooms)) {
        setActiveRooms(rRes.rooms);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadLobbyDirectory();
  }, [initialBoardId]);

  useEffect(() => {
    if (initialBoardId) setSelectedCreateBoardId(initialBoardId);
  }, [initialBoardId]);

  const loadPresetsForBoard = async (boardId: string | null | undefined) => {
    if (!boardId) {
      setBoardPresets([]);
      setSelectedPresetId('');
      return;
    }
    try {
      const res = await fetch(`/api/play/boards/${encodeURIComponent(boardId)}/presets`);
      const data = await res.json();
      if (Array.isArray(data.presets)) {
        setBoardPresets(data.presets);
        setSelectedPresetId((prev) =>
          data.presets.some((p: BoardRulePreset) => p.id === prev)
            ? prev
            : data.presets[0]?.id || ''
        );
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadPresetsForBoard(gameState?.boardId);
    setIsCustomizingRules(false);
  }, [gameState?.boardId]);

  // Connect WebSocket when in a room
  useEffect(() => {
    if (!roomCode || !playerId) return;
    let closedByUser = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${proto}//${window.location.host}/ws/play?room=${encodeURIComponent(roomCode)}&playerId=${encodeURIComponent(playerId)}`
      );
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state:sync') {
            setGameState(msg.publicState);
            setPrivateState(msg.privateState);
            setErrorMsg(null);

            const newestLog = msg.publicState?.eventLog?.[0];
            if (newestLog && newestLog.id !== lastLogIdRef.current) {
              lastLogIdRef.current = newestLog.id;
              if (msg.publicState.pendingHazard) {
                soundFx.playDiceRoll(msg.publicState.pendingHazard.success);
              } else if (msg.publicState.pendingTunnel) {
                soundFx.playTunnelFlip();
              } else if (newestLog.text.includes('claimed')) {
                soundFx.playRouteClaim();
              } else if (newestLog.text.includes('drew')) {
                soundFx.playCardDraw();
              }
            }
          } else if (msg.type === 'error') {
            setErrorMsg(msg.message);
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!closedByUser) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();
    return () => {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomCode, playerId]);

  // Keep split-piece inputs synced with player's current inventory in Lobby
  useEffect(() => {
    if (!gameState || !playerId) return;
    const me = gameState.players.find((p) => p.id === playerId);
    if (me && gameState.phase === 'LOBBY') {
      setSplitTrain(me.piecesRemaining.train);
      setSplitBus(me.piecesRemaining.bus);
      setSplitShip(me.piecesRemaining.ship);
    }
  }, [gameState?.rules.piecesPerPlayer, gameState?.rules.piecesMode, gameState?.rules.splitPiecesEnabled, gameState?.boardId]);

  const sendAction = async (action: Record<string, unknown>) => {
    if (!roomCode || !playerId) return;
    setErrorMsg(null);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'action', action }));
      return;
    }
    // REST fallback
    try {
      const res = await fetch(`/api/play/rooms/${encodeURIComponent(roomCode)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, action }),
      });
      const data = await res.json();
      if (!res.ok) setErrorMsg(data.error || 'Action failed');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Action failed');
    }
  };

  const createAndEnterRoom = async (preselectedBoardId?: string) => {
    setErrorMsg(null);
    try {
      const res = await fetch('/api/play/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: preselectedBoardId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create room');

      const code = data.state.roomCode;
      const joinRes = await fetch(`/api/play/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: nickname.trim() || 'Conductor 1',
          color: preferredColor,
        }),
      });
      const joinData = await joinRes.json();
      if (!joinRes.ok) throw new Error(joinData.error || 'Could not join created room');

      setRoomCode(code);
      setPlayerId(joinData.playerId);
      setGameState(joinData.state);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create room');
    }
  };

  const handleCreateAndJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    await createAndEnterRoom(selectedCreateBoardId || undefined);
  };

  const handleJoinExisting = async (targetCode: string) => {
    const cleanCode = targetCode.trim().toUpperCase();
    if (!cleanCode) {
      setErrorMsg('Enter a 4-letter room code.');
      return;
    }
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/play/rooms/${encodeURIComponent(cleanCode)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: nickname.trim() || 'Traveler',
          color: preferredColor,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not join room');
      setRoomCode(cleanCode);
      setPlayerId(data.playerId);
      setGameState(data.state);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to join room');
    }
  };

  const handleCopyInvite = () => {
    if (!roomCode) return;
    const url = `${window.location.origin}/play?room=${roomCode}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const me = useMemo(
    () => gameState?.players.find((p) => p.id === playerId) || null,
    [gameState, playerId]
  );

  const isHost = Boolean(gameState && playerId && gameState.hostPlayerId === playerId);
  const isMyTurn = Boolean(
    gameState &&
      playerId &&
      (gameState.phase === 'PLAYING' || gameState.phase === 'FINAL_ROUND') &&
      gameState.players[gameState.currentTurnIndex]?.id === playerId
  );

  const playerColorsById = useMemo(() => {
    const map: Record<string, PlayerColor> = {};
    for (const p of gameState?.players || []) map[p.id] = p.color;
    return map;
  }, [gameState?.players]);

  const handCounts = useMemo(() => {
    const counts: Record<CardColor, number> = {
      red: 0,
      orange: 0,
      yellow: 0,
      green: 0,
      blue: 0,
      purple: 0,
      black: 0,
      white: 0,
      locomotive: 0,
    };
    for (const c of privateState.hand) counts[c] = (counts[c] || 0) + 1;
    return counts;
  }, [privateState.hand]);

  // Real-time client check of which destination tickets I've already connected
  const completedTicketIds = useMemo(() => {
    const done = new Set<string>();
    if (!gameState?.board || !playerId) return done;
    const adj = new Map<string, Set<string>>();
    for (const r of gameState.board.routes) {
      const cl = gameState.claimedRoutes[r.id];
      if (cl?.laneA === playerId || cl?.laneB === playerId || cl?.laneC === playerId) {
        if (!adj.has(r.fromId)) adj.set(r.fromId, new Set());
        if (!adj.has(r.toId)) adj.set(r.toId, new Set());
        adj.get(r.fromId)!.add(r.toId);
        adj.get(r.toId)!.add(r.fromId);
      }
    }
    for (const t of privateState.tickets) {
      const visited = new Set<string>([t.fromId]);
      const q = [t.fromId];
      while (q.length > 0) {
        const cur = q.shift()!;
        if (cur === t.toId) {
          done.add(t.id);
          break;
        }
        for (const nxt of adj.get(cur) || []) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            q.push(nxt);
          }
        }
      }
    }
    return done;
  }, [gameState?.claimedRoutes, gameState?.board, privateState.tickets, playerId]);

  // Pre-Room Entry View
  if (!roomCode || !gameState) {
    const preselectedBoard = selectedCreateBoardId
      ? boards.find((b) => b.id === selectedCreateBoardId) || null
      : null;
    return (
      <div className="max-w-5xl mx-auto px-4 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Multiplayer Play Lobby
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Enter a nickname to create a room or join a friend&apos;s session. Players in a room can browse and recommend up to 3 maps before the Host finalizes the board and rules.
            {playPort && !isolatedPlayOnly && (
              <span className="ml-1 font-medium text-slate-800">
                Isolated friend port active on :{playPort}.
              </span>
            )}
          </p>
        </div>

        {errorMsg && (
          <div className="mb-4 px-4 py-2.5 rounded-lg border border-red-300 bg-red-50 text-xs text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Player Identity + Join */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 flex flex-col gap-4">
            <h2 className="text-base font-bold text-slate-900">Your Conductor Profile</h2>

            <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">
              <span>Nickname</span>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Enter your name..."
                maxLength={22}
                className="px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </label>

            <div className="flex flex-col gap-1.5 text-xs font-medium text-slate-700">
              <span>Piece Color</span>
              <div className="flex items-center gap-2">
                {(Object.keys(PLAYER_COLOR_HEX) as PlayerColor[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setPreferredColor(c)}
                    className={`w-9 h-9 rounded-lg border-2 flex items-center justify-center transition-transform ${
                      preferredColor === c ? 'scale-105 border-slate-900' : 'border-transparent opacity-75'
                    }`}
                    style={{ backgroundColor: PLAYER_COLOR_HEX[c].hex }}
                    title={PLAYER_COLOR_HEX[c].label}
                  >
                    {preferredColor === c && <Check className="w-4 h-4 text-white" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate-700">Join Existing Room</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                  placeholder="Room Code (e.g. RAIL)"
                  maxLength={6}
                  className="flex-1 px-3 py-2 text-sm font-mono-num uppercase rounded-lg border border-slate-300"
                />
                <button
                  type="button"
                  onClick={() => handleJoinExisting(roomInput)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  Join Room
                </button>
              </div>
            </div>
          </div>

          {/* Create New Room + Active Rooms */}
          <div className="lg:col-span-7 flex flex-col gap-5">
            <form
              onSubmit={handleCreateAndJoin}
              className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col gap-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900">Create New Game Room</h2>
                <span className="text-xs text-slate-500">Host enters first</span>
              </div>

              {preselectedBoard ? (
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      Pre-selected map: {preselectedBoard.name}
                    </div>
                    <div className="text-[11px] text-slate-500 tabular-nums">
                      {preselectedBoard.locations.length} stops · {preselectedBoard.routes.length} routes
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedCreateBoardId('')}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-100 whitespace-nowrap shrink-0"
                  >
                    Vote in Lobby Instead
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-600 leading-relaxed">
                  Entering the room opens the collaborative map selector where all players can inspect saved maps, preview full boards, and recommend up to 3 favorites before the Host decides.
                </p>
              )}

              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                {preselectedBoard ? 'Create Room with Selected Map' : 'Create Room & Enter Lobby'}
              </button>
            </form>

            {activeRooms.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <h3 className="text-sm font-bold text-slate-900 mb-3">Open Sessions</h3>
                <div className="divide-y divide-slate-100">
                  {activeRooms.map((r) => (
                    <div key={r.roomCode} className="py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          <span className="font-mono-num mr-2">{r.roomCode}</span>
                          {r.boardName}
                        </div>
                        <div className="text-xs text-slate-500 tabular-nums">
                          {r.phase} · {r.playerCount}/{r.maxPlayers} players
                        </div>
                      </div>
                      {r.phase === 'LOBBY' && (
                        <button
                          type="button"
                          onClick={() => handleJoinExisting(r.roomCode)}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          Join
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Full Saved Map Preview Modal helper
  const renderFullPreviewModal = () => {
    if (!previewModalBoard) return null;
    const summary = summarizeBoardRules(previewModalBoard);
    return (
      <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
        <div className="w-full max-w-5xl rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-bold truncate">{previewModalBoard.name}</h2>
              <div className="text-xs text-slate-500 tabular-nums">
                {previewModalBoard.regionLabel} · {previewModalBoard.theme} · {summary.stats.locationsCount} stops ·{' '}
                {summary.stats.routesCount} routes · {summary.stats.totalSpaces} spaces ·{' '}
                {previewModalBoard.tickets.length} tickets
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setPreviewFitTrigger((n) => n + 1)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap"
              >
                <Crosshair className="w-3.5 h-3.5" />
                Fit Board
              </button>
              <button
                type="button"
                onClick={() => setPreviewModalBoard(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap"
              >
                <X className="w-3.5 h-3.5" />
                Close
              </button>
            </div>
          </div>

          <div className="relative w-full aspect-[10/7] min-h-[380px] bg-slate-100">
            <GeoBoardMap
              board={previewModalBoard}
              mode="play"
              fitTrigger={previewFitTrigger}
            />
          </div>

          <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-600 grid grid-cols-2 sm:grid-cols-5 gap-2 tabular-nums">
            <div>
              <span className="text-slate-400 block text-[11px]">Hazards</span>
              <span className="font-medium text-slate-800">{summary.hazardsLabel}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Dual Railways</span>
              <span className="font-medium text-slate-800">{summary.dualLabel}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Pieces / Player</span>
              <span className="font-medium text-slate-800">{summary.trainsLabel}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Vehicles</span>
              <span className="font-medium text-slate-800">{summary.vehiclesLabel}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Stations</span>
              <span className="font-medium text-slate-800">{summary.stationsLabel}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Active Room — Lobby Configuration Phase
  if (gameState.phase === 'LOBBY') {
    const board = gameState.board;
    const stats = board ? computeBoardStats(board) : null;
    const lobbyStep = gameState.lobbyStep || (board ? 'RULE_REVIEW' : 'MAP_VOTE');
    const totalPiecesAllowed =
      gameState.rules.piecesMode === 'fixed' || !stats
        ? gameState.rules.piecesPerPlayer
        : Math.max(
            18,
            Math.min(
              65,
              Math.round(
                (stats.totalSpaces * (gameState.rules.proportionalPercent / 100)) /
                  Math.max(2, Math.min(board?.maxPlayers || 5, Math.max(gameState.players.length, 4)))
              )
            )
          );

    const readyCount = gameState.players.filter((p) => p.isReady).length;
    const allReady = gameState.players.length >= 2 && readyCount === gameState.players.length;
    const myRecommendations = me?.recommendedBoardIds || [];

    // Aggregate recommendation counts across all players in this room
    const votesMap = new Map<string, { count: number; voterNames: string[] }>();
    for (const p of gameState.players) {
      for (const bId of p.recommendedBoardIds || []) {
        const entry = votesMap.get(bId) || { count: 0, voterNames: [] };
        entry.count += 1;
        entry.voterNames.push(p.nickname);
        votesMap.set(bId, entry);
      }
    }
    const distinctVoteCounts = Array.from(
      new Set(Array.from(votesMap.values()).map((v) => v.count).filter((c) => c > 0))
    ).sort((a, b) => b - a);
    const goldVotes = distinctVoteCounts[0] ?? 0;
    const silverVotes = distinctVoteCounts[1] ?? 0;

    const handleSavePreset = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!board) return;
      const name = presetNameInput.trim() || `${board.name.slice(0, 18)} Preset`;
      try {
        const res = await fetch(
          `/api/play/boards/${encodeURIComponent(board.id)}/presets`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, rules: gameState.rules }),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save preset');
        setBoardPresets(data.presets || []);
        if (data.preset?.id) setSelectedPresetId(data.preset.id);
        setPresetNameInput('');
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to save preset');
      }
    };

    const handleDeletePreset = async (presetId: string) => {
      if (!board || !presetId) return;
      try {
        const res = await fetch(
          `/api/play/boards/${encodeURIComponent(board.id)}/presets/${encodeURIComponent(presetId)}`,
          { method: 'DELETE' }
        );
        const data = await res.json();
        if (Array.isArray(data.presets)) {
          setBoardPresets(data.presets);
          setSelectedPresetId(data.presets[0]?.id || '');
        }
      } catch {
        // ignore
      }
    };

    const renderStarBadge = (count: number, tier: 'gold' | 'silver') => {
      const fill = tier === 'gold' ? '#F59E0B' : '#CBD5E1';
      const stroke = tier === 'gold' ? '#92400E' : '#475569';
      const textColor = tier === 'gold' ? '#FFFFFF' : '#0F172A';
      return (
        <div
          className="relative w-10 h-10 flex items-center justify-center shrink-0"
          title={`${tier === 'gold' ? 'Most recommended' : '2nd most recommended'} (${count} vote${count > 1 ? 's' : ''})`}
        >
          <svg viewBox="0 0 24 24" className="w-10 h-10">
            <polygon
              points="12,1.5 15.1,7.9 22.1,8.9 17,13.8 18.2,20.8 12,17.5 5.8,20.8 7,13.8 1.9,8.9 8.9,7.9"
              fill={fill}
              stroke={stroke}
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="absolute inset-0 flex items-center justify-center text-xs font-bold font-mono-num pt-0.5"
            style={{ color: textColor }}
          >
            {count}
          </span>
        </div>
      );
    };

    return (
      <div className="max-w-7xl mx-auto px-4 lg:px-8 py-6 flex flex-col gap-5">
        {/* Room Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 font-mono-num">
                Room {gameState.roomCode}
              </h1>
              <button
                type="button"
                onClick={handleCopyInvite}
                className="px-3 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Copy className="w-3.5 h-3.5" />
                {copiedInvite ? 'Copied Link' : 'Copy Invite Link'}
              </button>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              {lobbyStep === 'MAP_VOTE'
                ? isHost
                  ? 'You are Host (first player in the room). Everyone may recommend up to 3 maps; choose one to continue.'
                  : `Recommend up to 3 maps while ${gameState.players.find((p) => p.id === gameState.hostPlayerId)?.nickname ?? 'the Host'} selects the board.`
                : isHost
                  ? 'Map decided. Review or customize the match rules, then mark Ready alongside all players to begin.'
                  : `Map decided by Host. Review the rules below and mark Ready when you are set to begin.`}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {lobbyStep === 'RULE_REVIEW' && (
              <span className="text-xs font-medium text-slate-600 tabular-nums">
                {readyCount}/{gameState.players.length} ready
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setRoomCode(null);
                setGameState(null);
                setErrorMsg(null);
                setIsCustomizingRules(false);
                setPreviewModalBoard(null);
                setInspectedObj(null);
                setStationMode(false);
                setBoardPresets([]);
                setSelectedPresetId('');
                setPresetNameInput('');
                loadLobbyDirectory();
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Leave Room
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="px-4 py-2.5 rounded-lg border border-red-300 bg-red-50 text-xs text-red-700">
            {errorMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Players in Room + Piece Split + Ready / Start */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-900">
                  Players in Room ({gameState.players.length}/{board?.maxPlayers ?? 5})
                </h2>
                {isHost && (
                  <button
                    type="button"
                    onClick={() => sendAction({ type: 'add_bot' })}
                    className="px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    Add AI Bot
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-100">
                {gameState.players.map((p) => {
                  const isPlayerHost = p.id === gameState.hostPlayerId;
                  const picksCount = p.recommendedBoardIds?.length ?? 0;
                  return (
                    <div key={p.id} className="py-2.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-3.5 h-3.5 rounded-sm shrink-0"
                          style={{ backgroundColor: PLAYER_COLOR_HEX[p.color].hex }}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900 truncate flex items-center gap-1.5">
                            <span className="truncate">
                              {p.nickname}
                              {p.id === playerId && ' (You)'}
                            </span>
                            {isPlayerHost && (
                              <span className="text-xs font-medium text-amber-700 inline-flex items-center gap-0.5 shrink-0">
                                <Crown className="w-3.5 h-3.5" />
                                Host
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums">
                            {p.isBot ? 'AI Bot' : lobbyStep === 'MAP_VOTE' ? `${picksCount}/3 map picks` : gameState.rules.splitPiecesEnabled ? `${p.piecesRemaining.train}T / ${p.piecesRemaining.bus}B / ${p.piecesRemaining.ship}S` : `${p.piecesRemaining.train} pieces`}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-xs shrink-0">
                        {lobbyStep === 'RULE_REVIEW' && (
                          <span
                            className={`inline-flex items-center gap-1 font-semibold ${
                              p.isReady ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            {p.isReady ? (
                              <>
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Ready
                              </>
                            ) : (
                              <>
                                <Circle className="w-3.5 h-3.5" />
                                Waiting
                              </>
                            )}
                          </span>
                        )}
                        {isHost && p.isBot && (
                          <button
                            type="button"
                            onClick={() => sendAction({ type: 'remove_bot', botId: p.id })}
                            className="text-red-600 hover:underline text-[11px]"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Rails & Sails Piece Split Configurator (when rule review + split enabled) */}
            {lobbyStep === 'RULE_REVIEW' && gameState.rules.splitPiecesEnabled && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">Your Piece Split</h3>
                  <span className="text-xs font-mono-num text-slate-600">
                    {splitTrain + splitBus + splitShip} / {totalPiecesAllowed}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <label className="flex flex-col gap-1">
                    <span>Trains</span>
                    <input
                      type="number"
                      min={0}
                      max={totalPiecesAllowed}
                      value={splitTrain}
                      onChange={(e) => setSplitTrain(Math.max(0, Number(e.target.value) || 0))}
                      className="px-2 py-1.5 rounded border border-slate-300 font-mono-num"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Buses</span>
                    <input
                      type="number"
                      min={0}
                      max={totalPiecesAllowed}
                      value={splitBus}
                      onChange={(e) => setSplitBus(Math.max(0, Number(e.target.value) || 0))}
                      className="px-2 py-1.5 rounded border border-slate-300 font-mono-num"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Ships</span>
                    <input
                      type="number"
                      min={0}
                      max={totalPiecesAllowed}
                      value={splitShip}
                      onChange={(e) => setSplitShip(Math.max(0, Number(e.target.value) || 0))}
                      className="px-2 py-1.5 rounded border border-slate-300 font-mono-num"
                    />
                  </label>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const rec = computeRecommendedPieceSplit(board, totalPiecesAllowed);
                      setSplitTrain(rec.train);
                      setSplitBus(rec.bus);
                      setSplitShip(rec.ship);
                      sendAction({ type: 'set_piece_split', ...rec });
                    }}
                    className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Board Ratio
                  </button>
                  <button
                    type="button"
                    disabled={splitTrain + splitBus + splitShip !== totalPiecesAllowed}
                    onClick={() =>
                      sendAction({
                        type: 'set_piece_split',
                        train: splitTrain,
                        bus: splitBus,
                        ship: splitShip,
                      })
                    }
                    className="flex-1 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white disabled:opacity-40 whitespace-nowrap"
                  >
                    Apply Split
                  </button>
                </div>
              </div>
            )}

            {/* Ready Toggle + Host Start Controls (Rule Review step) */}
            {lobbyStep === 'RULE_REVIEW' && board && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => sendAction({ type: 'toggle_ready' })}
                  className={`w-full py-2.5 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-colors ${
                    me?.isReady
                      ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                      : 'border-2 border-slate-900 bg-white text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  {me?.isReady ? (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      Ready (Click to Unready)
                    </>
                  ) : (
                    <>
                      <Circle className="w-4 h-4" />
                      Mark Ready
                    </>
                  )}
                </button>

                {isHost && (
                  <button
                    type="button"
                    disabled={!allReady}
                    onClick={() => sendAction({ type: 'start_game' })}
                    className="w-full py-3 px-4 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    <Play className="w-4 h-4" />
                    {gameState.players.length < 2
                      ? 'Need 2+ Players (or Add AI Bot)'
                      : !allReady
                        ? `Waiting for Players (${readyCount}/${gameState.players.length} Ready)`
                        : 'Start Game (Random First Player)'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Right Main Area: Step 1 Map Selector Rows OR Step 2 Detailed Rules & Customization */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            {lobbyStep === 'MAP_VOTE' || !board ? (
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      Available Maps ({boards.length})
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Pick up to 3 maps to recommend (or none). Click any thumbnail for a full saved map preview.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono-num text-slate-700 font-semibold">
                      Your Picks: {myRecommendations.length}/3
                    </span>
                    {myRecommendations.length > 0 && (
                      <button
                        type="button"
                        onClick={() => sendAction({ type: 'clear_recommendations' })}
                        className="px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50 whitespace-nowrap"
                      >
                        Clear Picks
                      </button>
                    )}
                    {isHost && board && (
                      <button
                        type="button"
                        onClick={() => sendAction({ type: 'select_board', boardId: board.id })}
                        className="px-3 py-1 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 whitespace-nowrap"
                      >
                        Keep {board.name}
                      </button>
                    )}
                  </div>
                </div>

                {boards.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    No saved maps found. Create one in the Map Studio first.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200">
                    {boards.map((b) => {
                      const summary = summarizeBoardRules(b);
                      const voteInfo = votesMap.get(b.id);
                      const voteCount = voteInfo?.count ?? 0;
                      const isGold = goldVotes > 0 && voteCount === goldVotes;
                      const isSilver = !isGold && silverVotes > 0 && voteCount === silverVotes;
                      const isRecommendedByMe = myRecommendations.includes(b.id);

                      return (
                        <div
                          key={b.id}
                          className={`p-4 flex flex-col sm:flex-row sm:items-center gap-4 transition-colors ${
                            isRecommendedByMe ? 'bg-amber-50/40' : 'hover:bg-slate-50/70'
                          }`}
                        >
                          {/* Clickable Thumbnail */}
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewModalBoard(b);
                              setPreviewFitTrigger((n) => n + 1);
                            }}
                            className="relative w-full sm:w-44 aspect-[10/7] rounded-lg border border-slate-300 overflow-hidden shrink-0 group cursor-pointer bg-slate-100"
                            title="Click for full saved map preview"
                          >
                            <BoardCanvas board={b} mode="preview" />
                            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-slate-900/80 text-white text-[10px] font-medium flex items-center gap-1 opacity-85 group-hover:opacity-100">
                              <Maximize2 className="w-2.5 h-2.5" />
                              Preview
                            </span>
                          </button>

                          {/* Map Name + Baked Rules Info */}
                          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                            <div className="flex items-center gap-2.5">
                              {isGold && renderStarBadge(voteCount, 'gold')}
                              {isSilver && renderStarBadge(voteCount, 'silver')}
                              <div className="min-w-0">
                                <h3 className="text-sm font-bold text-slate-900 truncate">
                                  {b.name}
                                </h3>
                                <div className="text-[11px] text-slate-500 tabular-nums">
                                  {b.theme} · {summary.stats.locationsCount} stops ·{' '}
                                  {summary.stats.routesCount} routes · {summary.stats.totalSpaces}{' '}
                                  spaces · {b.tickets.length} tickets
                                </div>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px] pt-1 text-slate-600 tabular-nums">
                              <div>
                                <span className="text-slate-400">Hazards: </span>
                                <span className="font-medium text-slate-800">{summary.hazardsLabel}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">Dual Rails: </span>
                                <span className="font-medium text-slate-800">{summary.dualLabel}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">Trains: </span>
                                <span className="font-medium text-slate-800">{summary.trainsLabel}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">Vehicles: </span>
                                <span className="font-medium text-slate-800">{summary.vehiclesLabel}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">Stations: </span>
                                <span className="font-medium text-slate-800">{summary.stationsLabel}</span>
                              </div>
                              {voteCount > 0 && !isGold && !isSilver && (
                                <div>
                                  <span className="text-slate-400">Recommended: </span>
                                  <span className="font-medium text-slate-800">{voteCount}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Row Actions */}
                          <div className="flex sm:flex-col items-stretch sm:items-end justify-end gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={!isRecommendedByMe && myRecommendations.length >= 3}
                              onClick={() =>
                                sendAction({ type: 'toggle_recommend_board', boardId: b.id })
                              }
                              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                                isRecommendedByMe
                                  ? 'border-amber-500 bg-amber-100 text-amber-900 hover:bg-amber-200/70'
                                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {isRecommendedByMe ? 'Picked ✓' : 'Recommend'}
                            </button>
                            {isHost && (
                              <button
                                type="button"
                                onClick={() => sendAction({ type: 'select_board', boardId: b.id })}
                                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                              >
                                Select Map
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* Step 2: Map Decided — Detailed Rules, Customization, Reset & Per-Map Presets */
              <div className="flex flex-col gap-4">
                {/* Selected Map Summary Banner */}
                <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4 min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewModalBoard(board);
                        setPreviewFitTrigger((n) => n + 1);
                      }}
                      className="relative w-32 aspect-[10/7] rounded-lg border border-slate-300 overflow-hidden shrink-0 group cursor-pointer"
                      title="Click for full saved map preview"
                    >
                      <BoardCanvas board={board} mode="preview" />
                      <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-slate-900/80 text-white text-[9px] flex items-center gap-0.5">
                        <Maximize2 className="w-2.5 h-2.5" />
                        Full
                      </span>
                    </button>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-slate-500">Selected Map</div>
                      <h2 className="text-lg font-bold text-slate-900 truncate">{board.name}</h2>
                      <div className="text-xs text-slate-500 tabular-nums">
                        {board.theme} · {stats?.locationsCount} stops · {stats?.routesCount} routes ·{' '}
                        {stats?.totalSpaces} spaces · {board.tickets.length} tickets
                      </div>
                    </div>
                  </div>
                  {isHost && (
                    <button
                      type="button"
                      onClick={() => sendAction({ type: 'reopen_map_selection' })}
                      className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      Change Map
                    </button>
                  )}
                </div>

                {/* Detailed Rules Overview + Host Customization + Per-Map Presets */}
                <div className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">Session Rules</h3>
                      <p className="text-xs text-slate-500">
                        Loaded from this map&apos;s baked-in defaults. Changing rules resets player Ready status.
                      </p>
                    </div>
                    {isHost && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => sendAction({ type: 'reset_rules_to_board' })}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Reset Changes
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsCustomizingRules((v) => !v)}
                          className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 whitespace-nowrap ${
                            isCustomizingRules
                              ? 'bg-slate-900 text-white hover:bg-slate-800'
                              : 'border border-slate-300 bg-white hover:bg-slate-50 text-slate-800'
                          }`}
                        >
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                          {isCustomizingRules ? 'Close Customizer' : 'Customize Rules'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Per-Map Presets (keyed to board.id) */}
                  {(isHost || boardPresets.length > 0) && (
                    <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 flex flex-col gap-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                          <Bookmark className="w-3.5 h-3.5 text-slate-600" />
                          Saved Presets for This Map ({boardPresets.length})
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {/* Load preset */}
                        <div className="flex items-center gap-1.5">
                          <select
                            disabled={!isHost || boardPresets.length === 0}
                            value={selectedPresetId}
                            onChange={(e) => setSelectedPresetId(e.target.value)}
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-50"
                          >
                            {boardPresets.length === 0 ? (
                              <option value="">No presets saved for this map</option>
                            ) : (
                              boardPresets.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))
                            )}
                          </select>
                          {isHost && (
                            <>
                              <button
                                type="button"
                                disabled={!selectedPresetId}
                                onClick={() => {
                                  const p = boardPresets.find((x) => x.id === selectedPresetId);
                                  if (p) sendAction({ type: 'update_rules', rules: p.rules });
                                }}
                                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 font-medium disabled:opacity-40 whitespace-nowrap shrink-0"
                              >
                                Load
                              </button>
                              <button
                                type="button"
                                disabled={!selectedPresetId}
                                onClick={() => handleDeletePreset(selectedPresetId)}
                                title="Delete selected preset"
                                className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-red-50 text-red-600 disabled:opacity-40 shrink-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>

                        {/* Save preset (Host) */}
                        {isHost && (
                          <form onSubmit={handleSavePreset} className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={presetNameInput}
                              onChange={(e) => setPresetNameInput(e.target.value)}
                              placeholder="New preset name..."
                              maxLength={40}
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white"
                            />
                            <button
                              type="submit"
                              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 whitespace-nowrap shrink-0"
                            >
                              Save Preset
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Detailed Rule Descriptions */}
                  <div className="divide-y divide-slate-100 text-xs">
                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Starting Pieces: </span>
                        <span className="font-mono-num text-slate-800">
                          {gameState.rules.piecesMode === 'fixed'
                            ? `${gameState.rules.piecesPerPlayer} fixed per player`
                            : `${gameState.rules.proportionalPercent}% share (${totalPiecesAllowed} per player)`}
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Final round triggers when any player has 2 or fewer pieces left.
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Vehicle Split: </span>
                        <span className="text-slate-800">
                          {gameState.rules.splitPiecesEnabled
                            ? 'Trains / Buses / Ships Split'
                            : 'Trains Only'}
                        </span>
                      </div>
                      <span className="text-slate-500">
                        {gameState.rules.splitPiecesEnabled
                          ? 'Routes require matching train, bus, or ship pieces.'
                          : 'Every route accepts standard train pieces.'}
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Dual Railways: </span>
                        <span className="font-mono-num text-slate-800">
                          {gameState.rules.doubleRouteMinPlayers === 0
                            ? 'Disabled (Single lane only)'
                            : `${gameState.rules.doubleRouteMinPlayers}+ players`}
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Below this count, claiming one lane removes the second rail and centers the claimed track.
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Train Stations: </span>
                        <span className="font-mono-num text-slate-800">
                          {gameState.rules.stationCount > 0
                            ? `${gameState.rules.stationCount} per player`
                            : 'None (Disabled)'}
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Place stations on cities (1–4 cards) to borrow an adjacent route; unused stations score +4 pts each.
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Train Card Deck: </span>
                        <span className="font-mono-num text-slate-800">
                          {gameState.rules.deckBasisEdition} · {gameState.rules.deckSize} cards
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Color and Locomotive ratios follow the chosen edition scaled to total deck size.
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Destination Tickets: </span>
                        <span className="font-mono-num text-slate-800">
                          Start {gameState.rules.ticketsInitialDraw} (keep {gameState.rules.ticketsInitialKeep}+) · Mid{' '}
                          {gameState.rules.ticketsMidDraw} (keep {gameState.rules.ticketsMidKeep}+)
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Connected tickets add points; uncompleted tickets subtract their value.
                      </span>
                    </div>

                    <div className="py-2.5 flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                      <div>
                        <span className="font-semibold text-slate-900">Active Hazards: </span>
                        <span className="text-slate-800">
                          {[
                            gameState.rules.enabledHazards.tunnels && 'Tunnels (3-card flip)',
                            gameState.rules.enabledHazards.ferries && 'Ferry Locos',
                            gameState.rules.enabledHazards.busCrossings && 'Bus 45° Rolls',
                            gameState.rules.enabledHazards.shippingHazards && 'Shipping Rolls',
                          ]
                            .filter(Boolean)
                            .join(', ') || 'None'}
                        </span>
                      </div>
                      <span className="text-slate-500">
                        Tunnels flip 3 deck cards; dice hazards roll 1d6 strictly above rating 1–4.
                      </span>
                    </div>
                  </div>

                  {/* Host Inline Rule Customizer */}
                  {isHost && isCustomizingRules && (
                    <div className="pt-4 border-t border-slate-200 flex flex-col gap-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Starting Pieces Mode</span>
                          <select
                            value={gameState.rules.piecesMode}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { piecesMode: e.target.value },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 bg-white"
                          >
                            <option value="fixed">Fixed Count (Default 45)</option>
                            <option value="proportional">Proportional (% of board spaces / players)</option>
                          </select>
                        </label>

                        {gameState.rules.piecesMode === 'fixed' ? (
                          <label className="flex flex-col gap-1">
                            <span className="font-medium text-slate-700">Pieces per Player</span>
                            <input
                              type="number"
                              min={15}
                              max={80}
                              value={gameState.rules.piecesPerPlayer}
                              onChange={(e) =>
                                sendAction({
                                  type: 'update_rules',
                                  rules: { piecesPerPlayer: Number(e.target.value) || 45 },
                                })
                              }
                              className="px-3 py-2 rounded-lg border border-slate-300 font-mono-num"
                            />
                          </label>
                        ) : (
                          <label className="flex flex-col gap-1">
                            <span className="font-medium text-slate-700">Board Spaces Share (%)</span>
                            <input
                              type="number"
                              min={30}
                              max={100}
                              value={gameState.rules.proportionalPercent}
                              onChange={(e) =>
                                sendAction({
                                  type: 'update_rules',
                                  rules: { proportionalPercent: Number(e.target.value) || 65 },
                                })
                              }
                              className="px-3 py-2 rounded-lg border border-slate-300 font-mono-num"
                            />
                          </label>
                        )}

                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Dual Railways Player Threshold</span>
                          <select
                            value={gameState.rules.doubleRouteMinPlayers}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { doubleRouteMinPlayers: Number(e.target.value) },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 bg-white"
                          >
                            <option value={0}>Disabled (Always collapse to center track)</option>
                            <option value={2}>2+ players (Both lanes open at 2+)</option>
                            <option value={3}>3+ players (Collapse below 3)</option>
                            <option value={4}>4+ players (Classic TTR — collapse below 4)</option>
                            <option value={5}>5+ players (Collapse below 5)</option>
                          </select>
                        </label>

                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Train Stations (None or 1–10)</span>
                          <select
                            value={gameState.rules.stationCount}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { stationCount: Number(e.target.value) },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 bg-white font-mono-num"
                          >
                            <option value={0}>None (Stations Disabled)</option>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                              <option key={n} value={n}>
                                {n} station{n > 1 ? 's' : ''} per player
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Starting Tickets Drawn</span>
                          <input
                            type="number"
                            min={2}
                            max={7}
                            value={gameState.rules.ticketsInitialDraw}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: {
                                  ticketsInitialDraw: Math.max(2, Math.min(7, Number(e.target.value) || 5)),
                                },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 font-mono-num"
                          />
                        </label>

                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Minimum Starting Tickets Kept</span>
                          <input
                            type="number"
                            min={1}
                            max={gameState.rules.ticketsInitialDraw}
                            value={gameState.rules.ticketsInitialKeep}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { ticketsInitialKeep: Math.max(1, Number(e.target.value) || 2) },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 font-mono-num"
                          />
                        </label>

                        <label className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Train Deck Basis Edition</span>
                          <select
                            value={gameState.rules.deckBasisEdition || 'USA'}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { deckBasisEdition: e.target.value as DeckBasisEdition },
                              })
                            }
                            className="px-3 py-2 rounded-lg border border-slate-300 bg-white"
                          >
                            {OFFICIAL_TTR_BENCHMARKS.map((ed) => (
                              <option key={ed.name} value={ed.name}>
                                {ed.name} ({ed.perColorCount}/color · {ed.locomotivesCount} loco)
                              </option>
                            ))}
                            <option value="Board Matched">Board Matched (Route Color Share)</option>
                          </select>
                        </label>

                        <div className="flex flex-col gap-1">
                          <span className="font-medium text-slate-700">Total Cards in Train Deck</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={40}
                              max={300}
                              value={gameState.rules.deckSize ?? 110}
                              onChange={(e) =>
                                sendAction({
                                  type: 'update_rules',
                                  rules: {
                                    deckSize: Math.max(40, Math.min(300, Number(e.target.value) || 110)),
                                  },
                                })
                              }
                              className="flex-1 px-3 py-2 rounded-lg border border-slate-300 font-mono-num"
                            />
                            {stats && (
                              <button
                                type="button"
                                onClick={() =>
                                  sendAction({
                                    type: 'update_rules',
                                    rules: { deckSize: computeRecommendedDeckSize(stats.totalSpaces) },
                                  })
                                }
                                className="px-2.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-[11px] font-medium whitespace-nowrap shrink-0"
                                title="Scale deck size proportionally to board train spaces"
                              >
                                Scale to Board
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Live Deck Card Distribution Preview */}
                      {(() => {
                        const dist = computeDeckDistributionCounts(
                          gameState.rules.deckBasisEdition || 'USA',
                          gameState.rules.deckSize || 110,
                          board
                        );
                        return (
                          <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 text-[11px] text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                            <span className="font-semibold text-slate-800">
                              Deck ({gameState.rules.deckSize || 110}):
                            </span>
                            {CARD_COLORS_ORDER.map((c) => (
                              <span key={c} className="inline-flex items-center gap-1">
                                <span
                                  className="w-2 h-2 rounded-sm border border-slate-400/50"
                                  style={{
                                    backgroundColor:
                                      c === 'locomotive' ? '#F59E0B' : ROUTE_COLOR_HEX[c]?.fill,
                                  }}
                                />
                                <span>
                                  {c === 'locomotive' ? 'Loco' : ROUTE_COLOR_HEX[c]?.label}:{' '}
                                  <strong className="font-mono-num text-slate-900">{dist[c]}</strong>
                                </span>
                              </span>
                            ))}
                          </div>
                        );
                      })()}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                        <label className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200">
                          <span>Split Pieces (Trains / Buses / Ships)</span>
                          <input
                            type="checkbox"
                            checked={gameState.rules.splitPiecesEnabled}
                            onChange={(e) =>
                              sendAction({
                                type: 'update_rules',
                                rules: { splitPiecesEnabled: e.target.checked },
                              })
                            }
                          />
                        </label>
                        {(
                          [
                            ['tunnels', 'Enable Tunnel 3-Card Flips'],
                            ['ferries', 'Enable Ferry Locomotives'],
                            ['busCrossings', 'Enable Bus 45° Collision Rolls'],
                            ['shippingHazards', 'Enable Maritime Hazard Rolls'],
                          ] as const
                        ).map(([key, label]) => (
                          <label
                            key={key}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200"
                          >
                            <span>{label}</span>
                            <input
                              type="checkbox"
                              checked={gameState.rules.enabledHazards[key]}
                              onChange={(e) =>
                                sendAction({
                                  type: 'update_rules',
                                  rules: {
                                    enabledHazards: {
                                      ...gameState.rules.enabledHazards,
                                      [key]: e.target.checked,
                                    },
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {renderFullPreviewModal()}
      </div>
    );
  }

  // Active Game Tabletop (Clean GUI decoupled from board visual theme; GeoBoardMap carries board.theme)
  const board = gameState.board!;
  const activePlayer = gameState.players[gameState.currentTurnIndex];

  const renderInspectedObjPanel = () => {
    if (!inspectedObj) return null;
    return (
      <div className="rounded-xl border border-slate-300 bg-white p-3.5 text-xs text-slate-900 flex flex-col gap-2">
        {inspectedObj.kind === 'hazard' &&
          (() => {
            const r = inspectedObj.route;
            const from = board.locations.find((l) => l.id === r.fromId);
            const to = board.locations.find((l) => l.id === r.toId);
            const isShipping = r.hazardType === 'shipping_lane';
            const passPct = Math.round(((7 - Math.max(1, r.hazardRating)) / 6) * 100);
            const cl = gameState.claimedRoutes[r.id];
            const laneCount = r.laneCount ?? (r.isDouble ? 2 : 1);
            const canClaimA = isMyTurn && !cl?.laneA;
            const canClaimB = isMyTurn && laneCount >= 2 && !cl?.laneB;
            const canClaimC = isMyTurn && laneCount >= 3 && !cl?.laneC;
            return (
              <>
                <div className="flex items-start justify-between gap-2 pb-1.5 border-b border-slate-200">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded bg-amber-100 border border-amber-400 shrink-0">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
                    </span>
                    <div>
                      <div className="font-bold">
                        {isShipping ? 'Shipping Lane Hazard' : 'Bus 45° Crossing'}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {from?.name || 'Stop A'} ↔ {to?.name || 'Stop B'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedObj(null)}
                    className="p-0.5 rounded hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-[11px] text-slate-700 leading-relaxed">
                  Requires rolling{' '}
                  <span className="font-mono-num font-bold">≥ {r.hazardRating}</span> on
                  1d6 ({passPct}% chance) when claiming this {r.length}-car{' '}
                  {r.transportMode} route.
                </div>
                {(canClaimA || canClaimB || canClaimC) && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {canClaimA && (
                      <button
                        type="button"
                        onClick={() => {
                          sendAction({ type: 'claim_route', routeId: r.id, lane: 'laneA' });
                          setInspectedObj(null);
                        }}
                        className="flex-1 py-1.5 px-2 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 whitespace-nowrap"
                      >
                        Claim ({ROUTE_COLOR_HEX[r.color]?.label})
                      </button>
                    )}
                    {canClaimB && (
                      <button
                        type="button"
                        onClick={() => {
                          sendAction({ type: 'claim_route', routeId: r.id, lane: 'laneB' });
                          setInspectedObj(null);
                        }}
                        className="flex-1 py-1.5 px-2 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 whitespace-nowrap"
                      >
                        Claim ({ROUTE_COLOR_HEX[r.doubleColor || r.color]?.label})
                      </button>
                    )}
                    {canClaimC && (
                      <button
                        type="button"
                        onClick={() => {
                          sendAction({ type: 'claim_route', routeId: r.id, lane: 'laneC' });
                          setInspectedObj(null);
                        }}
                        className="flex-1 py-1.5 px-2 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 whitespace-nowrap"
                      >
                        Claim ({ROUTE_COLOR_HEX[r.tripleColor || r.doubleColor || r.color]?.label})
                      </button>
                    )}
                  </div>
                )}
              </>
            );
          })()}

        {inspectedObj.kind === 'city' &&
          (() => {
            const loc = inspectedObj.loc;
            const stationOwnerId = gameState.builtStations[loc.id];
            const stationOwner = stationOwnerId
              ? gameState.players.find((p) => p.id === stationOwnerId)
              : null;
            const connected = board.routes.filter(
              (rt) => rt.fromId === loc.id || rt.toId === loc.id
            );
            return (
              <>
                <div className="flex items-start justify-between gap-2 pb-1.5 border-b border-slate-200">
                  <div>
                    <div className="font-bold text-sm">{loc.name}</div>
                    <div className="text-[11px] text-slate-500 capitalize">
                      {loc.isMajorHub ? 'Major Hub · ' : ''}
                      {loc.category} · {connected.length} routes
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedObj(null)}
                    className="p-0.5 rounded hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-[11px] text-slate-700">
                  Station:{' '}
                  <span className="font-semibold">
                    {stationOwner ? `Built by ${stationOwner.nickname}` : 'Open'}
                  </span>
                </div>
              </>
            );
          })()}

        {inspectedObj.kind === 'route' &&
          (() => {
            const { route, lane } = inspectedObj;
            const from = board.locations.find((l) => l.id === route.fromId);
            const to = board.locations.find((l) => l.id === route.toId);
            const laneColor =
              lane === 'laneC'
                ? route.tripleColor || route.doubleColor || route.color
                : lane === 'laneB'
                  ? route.doubleColor || route.color
                  : route.color;
            const doubleAllowed = isDualRailwayAllowed(
              gameState.players.length,
              gameState.rules.doubleRouteMinPlayers
            );
            const laneCount = route.laneCount ?? (route.isDouble ? 2 : 1);
            const cl = gameState.claimedRoutes[route.id];
            const ownerId =
              cl?.[lane] ||
              (laneCount >= 2 && !doubleAllowed ? cl?.laneA || cl?.laneB || cl?.laneC : undefined);
            const owner = ownerId
              ? gameState.players.find((p) => p.id === ownerId)
              : null;
            return (
              <>
                <div className="flex items-start justify-between gap-2 pb-1.5 border-b border-slate-200">
                  <div>
                    <div className="font-bold">
                      {from?.name || 'Stop A'} ↔ {to?.name || 'Stop B'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {route.length} spaces · {ROUTE_COLOR_HEX[laneColor]?.label} ·{' '}
                      {route.transportMode}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedObj(null)}
                    className="p-0.5 rounded hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-[11px] text-slate-700 flex flex-wrap gap-1.5">
                  {owner ? (
                    <span className="font-semibold">
                      Claimed by {owner.nickname}
                    </span>
                  ) : (
                    <span>Unclaimed (wait for your turn to claim)</span>
                  )}
                  {route.isTunnel && <span>· Tunnel (flip 3 cards)</span>}
                  {route.ferryLocomotives > 0 && (
                    <span>· {route.ferryLocomotives} Loco required</span>
                  )}
                  {route.hazardRating > 0 && route.hazardType !== 'none' && (
                    <span>· Hazard ≥ {route.hazardRating}</span>
                  )}
                </div>
              </>
            );
          })()}
      </div>
    );
  };

  return (
    <div className="min-h-[calc(100vh-65px)] bg-slate-100 text-slate-900">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 py-3 flex flex-col gap-3">
        {/* Compact Tabletop Scoreboard & Turn HUD */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl border bg-white border-slate-200">
          <div className="flex flex-wrap items-center gap-4">
            {gameState.players.map((p, idx) => {
              const active = idx === gameState.currentTurnIndex && gameState.phase !== 'GAME_OVER';
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg border ${
                    active ? 'border-amber-500 ring-1 ring-amber-500/40 bg-amber-50/40' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-sm shrink-0"
                    style={{ backgroundColor: PLAYER_COLOR_HEX[p.color].hex }}
                  />
                  <div className="text-xs">
                    <div className="font-bold flex items-center gap-1.5">
                      <span>{p.nickname}</span>
                      {active && (
                        <span className="text-[10px] font-semibold text-amber-700">
                          ACTIVE TURN
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono-num text-slate-500">
                      {p.score} pts ·{' '}
                      {gameState.rules.splitPiecesEnabled
                        ? `${p.piecesRemaining.train}T ${p.piecesRemaining.bus}B ${p.piecesRemaining.ship}S`
                        : `${p.piecesRemaining.train} pcs`}{' '}
                      · {p.cardCount} cards
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-xs">
            {gameState.phase === 'FINAL_ROUND' && (
              <span className="font-bold text-red-600 mr-2">
                FINAL ROUND ({gameState.finalTurnsRemaining} left)
              </span>
            )}
            <button
              type="button"
              onClick={() => setFitTrigger((n) => n + 1)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 flex items-center gap-1 font-medium"
              title="Reset Map View to Board Area"
            >
              <Crosshair className="w-3.5 h-3.5" />
              Fit Board
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                soundFx.enabled = next;
              }}
              className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
              title="Toggle Sound"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 text-red-700 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Main Tabletop Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Geo-Locked Board Map */}
          <div className="lg:col-span-8 flex flex-col gap-3">
            <div className="relative w-full aspect-[10/7] min-h-[420px] rounded-xl border border-slate-200 bg-white overflow-hidden">
              <GeoBoardMap
                board={board}
                mode="play"
                selectedLocationId={inspectedObj?.kind === 'city' ? inspectedObj.loc.id : null}
                selectedHazardRouteId={
                  inspectedObj?.kind === 'hazard' ? inspectedObj.route.id : null
                }
                claimedRoutes={gameState.claimedRoutes}
                doubleRoutesAllowed={isDualRailwayAllowed(
                  gameState.players.length,
                  gameState.rules.doubleRouteMinPlayers
                )}
                builtStations={gameState.builtStations}
                playerColorsById={playerColorsById}
                highlightedLocationIds={hoveredTicketEndpoints}
                stationModeActive={stationMode}
                fitTrigger={fitTrigger}
                onSelectLocation={(loc) => {
                  if (stationMode && isMyTurn) {
                    sendAction({ type: 'build_station', locationId: loc.id });
                    setStationMode(false);
                    setInspectedObj(null);
                  } else {
                    setInspectedObj({ kind: 'city', loc });
                  }
                }}
                onSelectHazard={(route) => {
                  setInspectedObj({ kind: 'hazard', route });
                }}
                onSelectRoute={(route, lane) => {
                  const cl = gameState.claimedRoutes[route.id];
                  const doubleAllowed = isDualRailwayAllowed(
                    gameState.players.length,
                    gameState.rules.doubleRouteMinPlayers
                  );
                  const laneCount = route.laneCount ?? (route.isDouble ? 2 : 1);
                  const blockedByCollapse =
                    laneCount >= 2 && !doubleAllowed && Boolean(cl?.laneA || cl?.laneB || cl?.laneC);
                  const alreadyClaimed = Boolean(cl?.[lane]) || blockedByCollapse;
                  if (isMyTurn && !alreadyClaimed) {
                    sendAction({ type: 'claim_route', routeId: route.id, lane });
                    setInspectedObj(null);
                  } else {
                    setInspectedObj({ kind: 'route', route, lane });
                  }
                }}
                onClearSelection={() => setInspectedObj(null)}
              />
            </div>

            {/* Mobile: Selected Object Inspector immediately below map so it never blocks canvas */}
            {inspectedObj && (
              <div className="lg:hidden">{renderInspectedObjPanel()}</div>
            )}

            {/* Player Hand Tray */}
            <div className="p-3.5 rounded-xl border bg-white border-slate-200">
              <div className="flex items-center justify-between mb-2.5 text-xs">
                <span className="font-bold">
                  Your Hand ({privateState.hand.length} cards)
                </span>
                <span className="text-slate-500">
                  {isMyTurn
                    ? gameState.turnDrawsRemaining === 2
                      ? 'Your Turn: Draw 2 cards, click a route to claim, or draw tickets.'
                      : 'Draw 1 more non-Locomotive card or deck card.'
                    : `Waiting for ${activePlayer?.nickname ?? 'opponent'}...`}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {CARD_COLORS_ORDER.map((c) => {
                  const count = handCounts[c];
                  if (count === 0) return null;
                  const style = getCardStyle(c);
                  return (
                    <div
                      key={c}
                      className={`px-3 py-2 rounded-lg border-2 flex items-center gap-1.5 text-xs font-bold ${style.bg} ${style.text} ${style.border}`}
                    >
                      <svg viewBox="-8 -8 16 16" className="w-3.5 h-3.5 shrink-0">
                        {c === 'locomotive' ? (
                          <LocomotiveSilhouette len={13} width={11} color="#FFFFFF" />
                        ) : (
                          <RouteColorSymbol
                            symbol={ROUTE_COLOR_HEX[c].symbol}
                            size={11}
                            color={c === 'white' ? '#334155' : '#FFFFFF'}
                          />
                        )}
                      </svg>
                      <span>{style.label}</span>
                      <span className="font-mono-num opacity-90">×{count}</span>
                    </div>
                  );
                })}
                {privateState.hand.length === 0 && (
                  <span className="text-xs text-slate-500">No cards in hand.</span>
                )}
              </div>
            </div>
          </div>

          {/* Right Tabletop Sidebar: Off-Map Inspector (Desktop), Market, Tickets, Log */}
          <div className="lg:col-span-4 flex flex-col gap-3">
            {inspectedObj && (
              <div className="hidden lg:block">{renderInspectedObjPanel()}</div>
            )}
            {/* Draw Market */}
            <div className="p-3.5 rounded-xl border bg-white border-slate-200 flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold">Train Card Market</span>
                <span className="font-mono-num text-slate-500">
                  Deck {gameState.deckCount} · Discard {gameState.discardCount}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {gameState.faceUpCards.map((c, idx) => {
                  const style = getCardStyle(c);
                  const disabled =
                    !isMyTurn ||
                    (c === 'locomotive' && gameState.turnDrawsRemaining < 2);
                  return (
                    <button
                      key={`${c}-${idx}`}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        sendAction({ type: 'draw_card', source: 'faceup', index: idx })
                      }
                      className={`py-2.5 px-2 rounded-lg border-2 text-xs font-bold flex items-center justify-center gap-1 transition-transform hover:scale-[1.02] disabled:opacity-45 ${style.bg} ${style.text} ${style.border}`}
                    >
                      <svg viewBox="-8 -8 16 16" className="w-3.5 h-3.5 shrink-0">
                        {c === 'locomotive' ? (
                          <LocomotiveSilhouette len={13} width={11} color="#FFFFFF" />
                        ) : (
                          <RouteColorSymbol
                            symbol={ROUTE_COLOR_HEX[c].symbol}
                            size={11}
                            color={c === 'white' ? '#334155' : '#FFFFFF'}
                          />
                        )}
                      </svg>
                      <span>{style.label}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={!isMyTurn}
                  onClick={() => sendAction({ type: 'draw_card', source: 'deck' })}
                  className="py-2.5 px-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-45"
                >
                  <Layers className="w-3.5 h-3.5" />
                  Deck
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!isMyTurn || gameState.turnDrawsRemaining < 2}
                  onClick={() => sendAction({ type: 'draw_tickets' })}
                  className="py-2 px-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <Ticket className="w-3.5 h-3.5" />
                  Draw Tickets
                </button>
                {gameState.rules.stationsEnabled && (
                  <button
                    type="button"
                    disabled={!isMyTurn || (me?.stationsRemaining ?? 0) <= 0 || gameState.turnDrawsRemaining < 2}
                    onClick={() => setStationMode((v) => !v)}
                    className={`py-2 px-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 ${
                      stationMode ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <Building2 className="w-3.5 h-3.5" />
                    {stationMode ? 'Click City...' : `Station (${me?.stationsRemaining ?? 0})`}
                  </button>
                )}
              </div>
            </div>

            {/* Destination Tickets */}
            <div className="p-3.5 rounded-xl border bg-white border-slate-200 flex flex-col gap-2">
              <div className="text-xs font-bold flex justify-between">
                <span>Your Destination Tickets ({privateState.tickets.length})</span>
                <span className="text-slate-500">Hover to locate</span>
              </div>
              <div className="flex flex-col gap-1.5 max-h-52 overflow-auto">
                {privateState.tickets.map((t) => {
                  const done = completedTicketIds.has(t.id);
                  return (
                    <div
                      key={t.id}
                      onMouseEnter={() =>
                        setHoveredTicketEndpoints(new Set([t.fromId, t.toId]))
                      }
                      onMouseLeave={() => setHoveredTicketEndpoints(new Set())}
                      className={`px-2.5 py-2 rounded-lg border text-xs flex items-center justify-between gap-2 ${
                        done
                          ? 'border-emerald-500/60 bg-emerald-50'
                          : 'border-slate-200'
                      }`}
                    >
                      <span className="font-medium truncate">
                        {t.fromName} ↔ {t.toName}
                      </span>
                      <span className="font-mono-num font-bold shrink-0">
                        {done ? '✓ ' : ''}
                        {t.points} pts
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live Dispatch Log */}
            <div className="p-3.5 rounded-xl border bg-white border-slate-200 flex flex-col gap-2">
              <div className="text-xs font-bold">Dispatch Log</div>
              <div className="flex flex-col gap-1.5 max-h-44 overflow-auto text-[11px] text-slate-600">
                {gameState.eventLog.map((ev) => (
                  <div key={ev.id} className="pb-1 border-b last:border-b-0 border-slate-100">
                    {ev.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Initial or Mid-Game Destination Ticket Picker */}
      {privateState.pendingTickets.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white text-slate-900 p-5 shadow-xl">
            <h2 className="text-lg font-bold mb-1">Choose Destination Tickets</h2>
            <p className="text-xs mb-4 text-slate-500">
              Keep at least{' '}
              {gameState.phase === 'INITIAL_TICKETS'
                ? gameState.rules.ticketsInitialKeep
                : gameState.rules.ticketsMidKeep}{' '}
              ticket(s). Unkept tickets return to the bottom of the deck.
            </p>

            <div className="flex flex-col gap-2 mb-5">
              {privateState.pendingTickets.map((t) => {
                const checked = selectedTicketIds.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setSelectedTicketIds((prev) => {
                        const nxt = new Set(prev);
                        if (nxt.has(t.id)) nxt.delete(t.id);
                        else nxt.add(t.id);
                        return nxt;
                      });
                    }}
                    className={`p-3 rounded-lg border text-left text-sm flex items-center justify-between ${
                      checked ? 'border-amber-500 bg-amber-50 font-semibold' : 'border-slate-200'
                    }`}
                  >
                    <span>
                      {t.fromName} ↔ {t.toName}
                    </span>
                    <span className="font-mono-num font-bold">{t.points} pts</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              disabled={
                selectedTicketIds.size <
                Math.min(
                  privateState.pendingTickets.length,
                  gameState.phase === 'INITIAL_TICKETS'
                    ? gameState.rules.ticketsInitialKeep
                    : gameState.rules.ticketsMidKeep
                )
              }
              onClick={() => {
                const ids = Array.from(selectedTicketIds);
                setSelectedTicketIds(new Set());
                sendAction({
                  type:
                    gameState.phase === 'INITIAL_TICKETS'
                      ? 'pick_initial_tickets'
                      : 'keep_tickets',
                  ticketIds: ids,
                });
              }}
              className="w-full py-2.5 rounded-lg text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Confirm {selectedTicketIds.size} Ticket(s)
            </button>
          </div>
        </div>
      )}

      {/* Modal: Probabilistic Bus 45° Collision / Maritime Shipping Dice Roll */}
      {gameState.pendingHazard && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white text-slate-900 p-5 shadow-xl text-center">
            <div className="mx-auto w-12 h-12 rounded-xl bg-yellow-400 text-slate-900 flex items-center justify-center mb-3">
              <Dices className="w-7 h-7" />
            </div>
            <h2 className="text-lg font-bold">
              {gameState.pendingHazard.hazardType === 'shipping_lane'
                ? 'Maritime Shipping Hazard Roll'
                : 'Bus 45° Intersection Collision Roll'}
            </h2>
            <p className="text-xs mt-1 text-slate-500">
              Need d6 roll strictly above hazard rating{' '}
              <span className="font-mono-num font-bold">{gameState.pendingHazard.hazardRating}</span>
            </p>

            <div className="my-5 text-4xl font-bold font-mono-num">
              Rolled {gameState.pendingHazard.rollResult}
            </div>

            <div
              className={`mb-4 py-2 px-3 rounded-lg text-xs font-semibold ${
                gameState.pendingHazard.success
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              {gameState.pendingHazard.success
                ? 'Hazard cleared! Route placement succeeds.'
                : 'Collision! Lost 1 piece and route placement canceled.'}
            </div>

            {gameState.pendingHazard.playerId === playerId && (
              <button
                type="button"
                onClick={() => sendAction({ type: 'ack_hazard' })}
                className="w-full py-2.5 rounded-lg text-sm font-bold bg-slate-900 text-white hover:bg-slate-800"
              >
                Continue
              </button>
            )}
          </div>
        </div>
      )}

      {/* Modal: Tunnel 3-Card Flip */}
      {gameState.pendingTunnel && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white text-slate-900 p-5 shadow-xl">
            <h2 className="text-lg font-bold mb-1">Tunnel Cost Check</h2>
            <p className="text-xs mb-4 text-slate-500">
              3 cards flipped from the deck. {gameState.pendingTunnel.extraRequired} matching card(s) required to complete this tunnel.
            </p>

            <div className="grid grid-cols-3 gap-2 mb-5">
              {gameState.pendingTunnel.drawnCards.map((c, idx) => {
                const st = getCardStyle(c);
                return (
                  <div
                    key={idx}
                    className={`py-4 rounded-lg border-2 text-center text-xs font-bold ${st.bg} ${st.text} ${st.border}`}
                  >
                    {st.label}
                  </div>
                );
              })}
            </div>

            {gameState.pendingTunnel.playerId === playerId && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => sendAction({ type: 'resolve_tunnel', pay: false })}
                  className="py-2.5 rounded-lg border border-slate-300 text-xs font-semibold hover:bg-slate-50"
                >
                  Abort & Keep Cards
                </button>
                <button
                  type="button"
                  onClick={() => sendAction({ type: 'resolve_tunnel', pay: true })}
                  className="py-2.5 rounded-lg text-xs font-bold bg-slate-900 text-white hover:bg-slate-800"
                >
                  Pay +{gameState.pendingTunnel.extraRequired} & Claim
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Game Over Podium */}
      {gameState.phase === 'GAME_OVER' && gameState.finalBreakdown && (
        <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white text-slate-900 p-6 shadow-2xl">
            <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
              <TrainFront className="w-5 h-5" />
              Final Dispatch Standings
            </h2>
            <p className="text-xs mb-4 text-slate-500">
              Includes claimed routes, completed/failed destination tickets, longest continuous route (+10), and unused stations (+4 each).
            </p>

            <div className="overflow-x-auto mb-5">
              <table className="w-full text-left text-xs border-collapse tabular-nums">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3">Player</th>
                    <th className="py-2 px-2 text-right">Routes</th>
                    <th className="py-2 px-2 text-right">Tickets</th>
                    <th className="py-2 px-2 text-right">Longest</th>
                    <th className="py-2 px-2 text-right">Stations</th>
                    <th className="py-2 pl-2 text-right font-bold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {gameState.finalBreakdown.map((b, idx) => (
                    <tr key={b.playerId}>
                      <td className="py-2.5 pr-3 font-semibold flex items-center gap-2">
                        <span className="font-mono-num opacity-60">#{idx + 1}</span>
                        <span
                          className="w-2.5 h-2.5 rounded-sm"
                          style={{ backgroundColor: PLAYER_COLOR_HEX[b.color].hex }}
                        />
                        <span>{b.nickname}</span>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono-num">{b.routePoints}</td>
                      <td className="py-2.5 px-2 text-right font-mono-num">
                        {b.ticketPoints >= 0 ? `+${b.ticketPoints}` : b.ticketPoints}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono-num">
                        {b.longestRouteBonus > 0 ? `+${b.longestRouteBonus}` : '—'} ({b.longestRouteLength})
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono-num">+{b.stationPoints}</td>
                      <td className="py-2.5 pl-2 text-right font-mono-num font-bold text-sm">
                        {b.totalScore}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={() => {
                setRoomCode(null);
                setGameState(null);
                loadLobbyDirectory();
              }}
              className="w-full py-2.5 rounded-lg text-sm font-bold bg-slate-900 text-white hover:bg-slate-800"
            >
              Return to Play Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
