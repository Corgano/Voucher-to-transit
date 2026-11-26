import React, { useMemo, useRef, useState } from 'react';
import type {
  BoardDefinition,
  BoardLocation,
  BoardRoute,
  ClaimedRouteState,
  PlayerColor,
  RouteColor,
} from '../shared/types';
import { PLAYER_COLOR_HEX, ROUTE_COLOR_HEX } from '../shared/benchmarks';
import {
  computeBoxWidthMeters,
  TRAIN_TO_CIRCLE_RATIO,
  TRAIN_WIDTH_TO_CIRCLE_RATIO,
} from '../shared/geoScale';
import { BOARD_THEMES } from '../lib/theme';

/**
 * Module-scoped debug verbosity level:
 * 0 = errors only, 1 = major render steps, 2 = light debug, 3 = detailed debug, 4 = full trace.
 */
export const BOARD_CANVAS_DEBUG_LEVEL = 0;

interface BoardCanvasProps {
  board: BoardDefinition;
  mode: 'editor' | 'play' | 'preview';
  selectedLocationId?: string | null;
  selectedRouteId?: string | null;
  linkSourceId?: string | null;
  highlightedLocationIds?: Set<string>;
  claimedRoutes?: Record<string, ClaimedRouteState>;
  doubleRoutesAllowed?: boolean;
  builtStations?: Record<string, string>;
  playerColorsById?: Record<string, PlayerColor>;
  stationModeActive?: boolean;
  onSelectLocation?: (loc: BoardLocation) => void;
  onMoveLocation?: (id: string, x: number, y: number) => void;
  onSelectRoute?: (route: BoardRoute, lane: 'laneA' | 'laneB' | 'laneC') => void;
  transparentBackground?: boolean;
  className?: string;
}

function evalQuadBezier(
  p0: { x: number; y: number },
  cp: { x: number; y: number },
  p1: { x: number; y: number },
  t: number
) {
  const mt = 1 - t;
  const x = mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x;
  const y = mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y;
  const dx = 2 * mt * (cp.x - p0.x) + 2 * t * (p1.x - cp.x);
  const dy = 2 * mt * (cp.y - p0.y) + 2 * t * (p1.y - cp.y);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { x, y, angleDeg };
}

function computeControlPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  curveOffset: number,
  laneOffset: number
) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / len;
  const ny = dx / len;
  const totalOffset = curveOffset + laneOffset;
  return {
    cp: { x: mx + nx * totalOffset * 1.4, y: my + ny * totalOffset * 1.4 },
    p0: { x: a.x + nx * laneOffset * 0.65, y: a.y + ny * laneOffset * 0.65 },
    p1: { x: b.x + nx * laneOffset * 0.65, y: b.y + ny * laneOffset * 0.65 },
  };
}

export const BoardCanvas: React.FC<BoardCanvasProps> = ({
  board,
  mode,
  selectedLocationId,
  selectedRouteId,
  linkSourceId,
  highlightedLocationIds,
  claimedRoutes = {},
  doubleRoutesAllowed = true,
  builtStations = {},
  playerColorsById = {},
  stationModeActive = false,
  onSelectLocation,
  onMoveLocation,
  onSelectRoute,
  transparentBackground = false,
  className = '',
}) => {
  const palette = BOARD_THEMES[board.theme] || BOARD_THEMES.vintage;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoveredRouteKey, setHoveredRouteKey] = useState<string | null>(null);

  const locMap = useMemo(() => {
    const m = new Map<string, BoardLocation>();
    for (const loc of board.locations) m.set(loc.id, loc);
    return m;
  }, [board.locations]);

  const getSvgCoords = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1000;
    const y = ((e.clientY - rect.top) / rect.height) * 700;
    return {
      x: Math.max(25, Math.min(975, Math.round(x * 10) / 10)),
      y: Math.max(25, Math.min(675, Math.round(y * 10) / 10)),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'editor' || !draggingId || !onMoveLocation) return;
    const pt = getSvgCoords(e);
    onMoveLocation(draggingId, pt.x, pt.y);
  };

  const handlePointerUp = () => {
    if (draggingId) setDraggingId(null);
  };

  // Fixed board-wide train piece size so trains never shrink or stretch across routes
  const uniformCircleDiam = mode === 'preview' ? 8 : 15;
  const uniformSlotW = useMemo(() => {
    if (board.bbox && board.metersPerTrain > 0) {
      const boxW = computeBoxWidthMeters(board.bbox);
      const scaled = (board.metersPerTrain / Math.max(50, boxW)) * 900;
      if (Number.isFinite(scaled) && scaled > 0) {
        return Math.max(mode === 'preview' ? 14 : 18, Math.min(mode === 'preview' ? 28 : 40, scaled));
      }
    }
    return uniformCircleDiam * TRAIN_TO_CIRCLE_RATIO;
  }, [board.bbox, board.metersPerTrain, mode, uniformCircleDiam]);
  const uniformSlotH = useMemo(
    () => Math.max(mode === 'preview' ? 5 : 7, (uniformSlotW / TRAIN_TO_CIRCLE_RATIO) * TRAIN_WIDTH_TO_CIRCLE_RATIO),
    [uniformSlotW, mode]
  );

  /**
   * Renders a single route lane with strictly uniform-size car slots centered cleanly along its Bezier arc.
   * Call with (route, fromLoc, toLoc, lane, laneColor, laneOffset).
   * Returns an SVG group element.
   */
  const renderLane = (
    route: BoardRoute,
    a: BoardLocation,
    b: BoardLocation,
    lane: 'laneA' | 'laneB' | 'laneC',
    laneColor: RouteColor,
    laneOffset: number
  ) => {
    const { cp, p0, p1 } = computeControlPoint(a, b, route.curveOffset, laneOffset);
    const pathD = `M ${p0.x} ${p0.y} Q ${cp.x} ${cp.y} ${p1.x} ${p1.y}`;
    const claimOwnerId = claimedRoutes[route.id]?.[lane];
    const ownerColor = claimOwnerId ? playerColorsById[claimOwnerId] : undefined;
    const isClaimed = Boolean(claimOwnerId);
    const colorSpec = ROUTE_COLOR_HEX[laneColor] || ROUTE_COLOR_HEX.gray;

    const laneKey = `${route.id}:${lane}`;
    const isHovered = hoveredRouteKey === laneKey;
    const isSelected = mode === 'editor' && selectedRouteId === route.id;

    // Strictly uniform train car size across the entire board (kissing city circles on tight 1-car links)
    const slotW = uniformSlotW;
    const slotH = uniformSlotH;
    const slots = [];
    const spanPx = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const edgeFrac = Math.min(0.45, (uniformCircleDiam * 0.5 + slotW * 0.5) / Math.max(1, spanPx));

    for (let i = 0; i < route.length; i++) {
      const t =
        route.length === 1
          ? 0.5
          : edgeFrac + (i / (route.length - 1)) * Math.max(0.02, 1 - 2 * edgeFrac);
      const pt = evalQuadBezier(p0, cp, p1, t);
      const isFerryLocoSlot = i < route.ferryLocomotives;
      slots.push({ ...pt, isFerryLocoSlot, idx: i });
    }

    const fillHex = isClaimed && ownerColor ? PLAYER_COLOR_HEX[ownerColor].hex : colorSpec.fill;
    const strokeHex = isClaimed && ownerColor ? '#FFFFFF' : colorSpec.stroke;

    return (
      <g
        key={laneKey}
        className={mode !== 'preview' ? 'cursor-pointer' : undefined}
        onMouseEnter={() => mode !== 'preview' && setHoveredRouteKey(laneKey)}
        onMouseLeave={() => mode !== 'preview' && setHoveredRouteKey(null)}
        onClick={(e) => {
          e.stopPropagation();
          onSelectRoute?.(route, lane);
        }}
      >
        {/* Invisible wide hit target */}
        {mode !== 'preview' && (
          <path d={pathD} fill="none" stroke="transparent" strokeWidth={18} />
        )}

        {/* Subtle railway guide line */}
        <path
          d={pathD}
          fill="none"
          stroke={isSelected || isHovered ? '#F59E0B' : '#64748B'}
          strokeWidth={isSelected || isHovered ? 3.5 : 1.6}
          strokeDasharray="3 2"
          opacity={isClaimed ? 0.9 : isHovered || isSelected ? 0.95 : 0.55}
        />

        {/* Individual Track / Car Slots */}
        {slots.map((s) => (
          <g
            key={s.idx}
            transform={`translate(${s.x}, ${s.y}) rotate(${s.angleDeg})`}
          >
            {route.isTunnel && (
              <rect
                x={-slotW / 2 - 1}
                y={-slotH / 2 - 1}
                width={slotW + 2}
                height={slotH + 2}
                rx={2.5}
                fill="none"
                stroke="#374151"
                strokeWidth={1.4}
              />
            )}
            <rect
              x={-slotW / 2}
              y={-slotH / 2}
              width={slotW}
              height={slotH}
              rx={isClaimed ? 3 : 2}
              fill={!isClaimed && s.isFerryLocoSlot ? '#FDE047' : fillHex}
              stroke={isSelected || isHovered ? '#F59E0B' : strokeHex}
              strokeWidth={isClaimed ? 1.4 : 1.1}
              opacity={isClaimed ? 1 : 0.94}
            />
          </g>
        ))}
      </g>
    );
  };

  const midHazardBadge = (route: BoardRoute, a: BoardLocation, b: BoardLocation) => {
    if (route.hazardRating <= 0 || route.hazardType === 'none' || mode === 'preview') return null;
    const pt = route.hazardPoint || {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
    const isShipping = route.hazardType === 'shipping_lane';
    return (
      <g
        key={`haz-${route.id}`}
        transform={`translate(${pt.x}, ${pt.y})`}
        className="pointer-events-none"
      >
        <polygon
          points="0,-11 10,8 -10,8"
          fill={isShipping ? '#FDE047' : '#FACC15'}
          stroke={isShipping ? '#0369A1' : '#713F12'}
          strokeWidth={1.6}
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
  };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 1000 700"
      className={`w-full h-full select-none ${className}`}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {/* Background */}
      {!transparentBackground && (
        <g>
          <rect x={0} y={0} width={1000} height={700} fill={palette.boardBg} />
          {/* Subtle cartographic coordinate grid */}
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <line
              key={`gx-${i}`}
              x1={i * 100}
              y1={16}
              x2={i * 100}
              y2={684}
              stroke={palette.boardGridStroke}
              strokeWidth={0.8}
              strokeDasharray={board.theme === 'vintage' ? '3 5' : undefined}
              opacity={0.7}
            />
          ))}
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <line
              key={`gy-${i}`}
              x1={16}
              y1={i * 100}
              x2={984}
              y2={i * 100}
              stroke={palette.boardGridStroke}
              strokeWidth={0.8}
              strokeDasharray={board.theme === 'vintage' ? '3 5' : undefined}
              opacity={0.7}
            />
          ))}
          <rect
            x={14}
            y={14}
            width={972}
            height={672}
            fill="none"
            stroke={palette.boardFrameStroke}
            strokeWidth={board.theme === 'vintage' ? 2.5 : 1.5}
            rx={board.theme === 'vintage' ? 4 : 8}
          />
        </g>
      )}

      {/* Routes */}
      <g>
        {board.routes.map((route) => {
          const a = locMap.get(route.fromId);
          const b = locMap.get(route.toId);
          if (!a || !b) return null;
          const laneCount = route.laneCount ?? (route.isDouble ? 2 : 1);
          if (laneCount >= 2) {
            const claim = claimedRoutes[route.id];
            const hasClaim = Boolean(claim?.laneA || claim?.laneB || claim?.laneC);
            if (!doubleRoutesAllowed && hasClaim) {
              const lane: 'laneA' | 'laneB' | 'laneC' =
                claim?.laneC && !claim?.laneA && !claim?.laneB
                  ? 'laneC'
                  : claim?.laneB && !claim?.laneA
                    ? 'laneB'
                    : 'laneA';
              const color =
                lane === 'laneC'
                  ? route.tripleColor || route.doubleColor || route.color
                  : lane === 'laneB'
                    ? route.doubleColor || route.color
                    : route.color;
              return renderLane(route, a, b, lane, color, 0);
            }
            if (laneCount >= 3) {
              return (
                <React.Fragment key={route.id}>
                  {renderLane(route, a, b, 'laneA', route.color, -8)}
                  {renderLane(
                    route,
                    a,
                    b,
                    'laneB',
                    route.doubleColor || route.color,
                    0
                  )}
                  {renderLane(
                    route,
                    a,
                    b,
                    'laneC',
                    route.tripleColor || route.doubleColor || route.color,
                    8
                  )}
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={route.id}>
                {renderLane(route, a, b, 'laneA', route.color, -5.5)}
                {renderLane(
                  route,
                  a,
                  b,
                  'laneB',
                  route.doubleColor || route.color,
                  5.5
                )}
              </React.Fragment>
            );
          }
          return renderLane(route, a, b, 'laneA', route.color, 0);
        })}
      </g>

      {/* Hazard Warning Triangles (! 1-4) */}
      <g>
        {board.routes.map((route) => {
          const a = locMap.get(route.fromId);
          const b = locMap.get(route.toId);
          if (!a || !b) return null;
          return midHazardBadge(route, a, b);
        })}
      </g>

      {/* Cities / Landmarks */}
      <g>
        {board.locations.map((loc) => {
          const isSelected = selectedLocationId === loc.id || linkSourceId === loc.id;
          const isHighlighted = highlightedLocationIds?.has(loc.id);
          const stationOwnerId = builtStations[loc.id];
          const stationColor = stationOwnerId ? playerColorsById[stationOwnerId] : undefined;
          const radius = mode === 'preview' ? (loc.isMajorHub ? 6 : 4) : loc.isMajorHub ? 10 : 7.5;

          return (
            <g
              key={loc.id}
              transform={`translate(${loc.x}, ${loc.y})`}
              className={mode !== 'preview' ? 'cursor-pointer' : undefined}
              onPointerDown={(e) => {
                if (mode === 'editor' && !linkSourceId) {
                  e.stopPropagation();
                  setDraggingId(loc.id);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectLocation?.(loc);
              }}
            >
              {/* Pulse/Highlight ring for active tickets or station mode */}
              {(isSelected || isHighlighted || (stationModeActive && !stationOwnerId)) && (
                <circle
                  cx={0}
                  cy={0}
                  r={radius + 6}
                  fill="none"
                  stroke={isSelected ? '#F59E0B' : '#10B981'}
                  strokeWidth={2.4}
                  strokeDasharray={stationModeActive ? '3 2' : undefined}
                />
              )}

              {/* City marker */}
              <circle
                cx={0}
                cy={0}
                r={radius}
                fill={loc.isMajorHub ? palette.nodeHubFill : palette.nodeFill}
                stroke={palette.nodeStroke}
                strokeWidth={2.2}
              />

              {/* Station roof icon if built */}
              {stationColor && (
                <polygon
                  points="0,-13 9,-4 -9,-4"
                  fill={PLAYER_COLOR_HEX[stationColor].hex}
                  stroke="#FFFFFF"
                  strokeWidth={1.4}
                />
              )}

              {/* Label */}
              {mode !== 'preview' && (
                <g transform={`translate(0, ${radius + 11})`}>
                  <rect
                    x={-(loc.name.length * 3.3 + 6)}
                    y={-7}
                    width={loc.name.length * 6.6 + 12}
                    height={14}
                    rx={3}
                    fill={palette.nodeLabelBg}
                  />
                  <text
                    x={0}
                    y={3.2}
                    textAnchor="middle"
                    fontSize={loc.isMajorHub ? '10.5' : '9.5'}
                    fontWeight={loc.isMajorHub ? '700' : '600'}
                    fill={palette.nodeLabelText}
                  >
                    {loc.name}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};
