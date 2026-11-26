import React from 'react';
import type { RouteSymbolKind } from '../shared/benchmarks';

interface SymbolProps {
  symbol: RouteSymbolKind;
  size: number;
  color: string;
  x?: number;
}

export const RouteColorSymbol: React.FC<SymbolProps> = ({ symbol, size, color, x = 0 }) => {
  if (symbol === 'none' || size < 1.5) return null;
  const r = size * 0.5;

  switch (symbol) {
    case 'square':
      return (
        <rect
          x={x - r * 0.85}
          y={-r * 0.85}
          width={r * 1.7}
          height={r * 1.7}
          rx={r * 0.18}
          fill={color}
        />
      );
    case 'triangle':
      return (
        <polygon
          points={`${x},${-r} ${x + r * 0.95},${r * 0.82} ${x - r * 0.95},${r * 0.82}`}
          fill={color}
        />
      );
    case 'star': {
      // Classic 6-pointed star (2 overlapping triangles)
      return (
        <g fill={color}>
          <polygon points={`${x},${-r} ${x + r * 0.86},${r * 0.52} ${x - r * 0.86},${r * 0.52}`} />
          <polygon points={`${x},${r} ${x + r * 0.86},${-r * 0.52} ${x - r * 0.86},${-r * 0.52}`} />
        </g>
      );
    }
    case 'circle':
      return <circle cx={x} cy={0} r={r * 0.88} fill={color} />;
    case 'diamond':
      return (
        <polygon
          points={`${x},${-r} ${x + r * 0.92},0 ${x},${r} ${x - r * 0.92},0`}
          fill={color}
        />
      );
    case 'cross': {
      const w = r * 0.52;
      return (
        <path
          d={`M ${x - w / 2} ${-r} h ${w} v ${r - w / 2} h ${r - w / 2} v ${w} h ${-(r - w / 2)} v ${r - w / 2} h ${-w} v ${-(r - w / 2)} h ${-(r - w / 2)} v ${-w} h ${r - w / 2} z`}
          fill={color}
        />
      );
    }
    case 'hexagon': {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const ang = (Math.PI / 3) * i - Math.PI / 6;
        return `${x + Math.cos(ang) * r * 0.95},${Math.sin(ang) * r * 0.95}`;
      }).join(' ');
      return <polygon points={pts} fill={color} />;
    }
    case 'ring':
      return (
        <circle
          cx={x}
          cy={0}
          r={r * 0.78}
          fill="none"
          stroke={color}
          strokeWidth={Math.max(1, r * 0.38)}
        />
      );
    default:
      return null;
  }
};

export const LocomotiveSilhouette: React.FC<{
  len: number;
  width: number;
  color?: string;
}> = ({ len, width, color = '#0F172A' }) => {
  // Normalized inside [-0.42..0.42] x [-0.36..0.36]
  const sx = len * 0.76;
  const sy = width * 0.72;
  return (
    <g transform={`scale(${sx}, ${sy})`} fill={color}>
      {/* Main boiler + cab */}
      <path d="M -0.46 0.16 L -0.46 -0.34 L -0.14 -0.34 L -0.14 -0.18 L 0.24 -0.18 L 0.28 -0.34 L 0.40 -0.34 L 0.36 -0.16 L 0.44 -0.06 L 0.44 0.16 L 0.52 0.24 L -0.48 0.24 Z" />
      {/* Wheels */}
      <circle cx={-0.30} cy={0.30} r={0.11} />
      <circle cx={-0.02} cy={0.30} r={0.11} />
      <circle cx={0.26} cy={0.30} r={0.095} />
    </g>
  );
};

export const TunnelPortalBadge: React.FC<{
  size: number;
  color: string;
  x?: number;
}> = ({ size, color, x = 0 }) => {
  const r = size * 0.48;
  return (
    <g transform={`translate(${x}, 0)`}>
      {/* Stone arch outline + dark tunnel interior */}
      <path
        d={`M ${-r} ${r * 0.85} L ${-r} ${-r * 0.1} A ${r} ${r} 0 0 1 ${r} ${-r * 0.1} L ${r} ${r * 0.85} Z`}
        fill="none"
        stroke={color}
        strokeWidth={Math.max(1, r * 0.34)}
      />
      <path
        d={`M ${-r * 0.52} ${r * 0.85} L ${-r * 0.52} ${0} A ${r * 0.52} ${r * 0.52} 0 0 1 ${r * 0.52} ${0} L ${r * 0.52} ${r * 0.85} Z`}
        fill={color}
      />
    </g>
  );
};
