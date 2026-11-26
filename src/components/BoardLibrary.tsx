import React, { useRef, useState } from 'react';
import { Download, Play, Trash2, Upload, Edit3 } from 'lucide-react';
import type { BoardDefinition } from '../shared/types';
import { computeBoardStats } from '../shared/benchmarks';
import { BOARD_THEMES } from '../lib/theme';
import { BoardCanvas } from './BoardCanvas';

interface BoardLibraryProps {
  boards: BoardDefinition[];
  onOpenInStudio: (board: BoardDefinition) => void;
  onHostGame: (boardId: string) => void;
  onRefreshBoards: () => void;
}

export const BoardLibrary: React.FC<BoardLibraryProps> = ({
  boards,
  onOpenInStudio,
  onHostGame,
  onRefreshBoards,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    await fetch(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    onRefreshBoards();
  };

  const handleExport = (board: BoardDefinition) => {
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${board.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: { ...parsed, id: undefined } }),
      });
      if (!res.ok) throw new Error('Invalid board JSON format');
      onRefreshBoards();
    } catch (err: any) {
      setImportError(err?.message || 'Failed to import board file');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 lg:px-8 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Saved Board Library
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Browse generated and custom-tweaked boards. Each board retains its saved theme and rules in multiplayer play.
          </p>
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={handleImport}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            Import Board JSON
          </button>
        </div>
      </div>

      {importError && (
        <div className="mb-4 px-4 py-2.5 rounded-lg border border-red-300 bg-red-50 text-xs text-red-700">
          {importError}
        </div>
      )}

      {boards.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
          No boards saved yet. Scan any region in the Studio and click Save Board.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {boards.map((b) => {
            const stats = computeBoardStats(b);
            const theme = BOARD_THEMES[b.theme] || BOARD_THEMES.vintage;
            return (
              <div
                key={b.id}
                className="rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col"
              >
                <div className="aspect-[10/7] border-b border-slate-200 overflow-hidden">
                  <BoardCanvas board={b} mode="preview" />
                </div>

                <div className="p-4 flex flex-col gap-3 flex-1 justify-between">
                  <div>
                    <h2 className="text-base font-bold text-slate-900 truncate">
                      {b.name}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 tabular-nums">
                      <span>{theme.label}</span>
                      <span aria-hidden="true">·</span>
                      <span>{stats.locationsCount} stops</span>
                      <span aria-hidden="true">·</span>
                      <span>{stats.routesCount} routes</span>
                      <span aria-hidden="true">·</span>
                      <span>{stats.totalSpaces} spaces</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500 tabular-nums">
                      {b.generationParams.splitPiecesMode ? 'Rails & Sails Split' : 'Unified Pieces'}
                      {' · '}
                      {b.tickets.length} tickets
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => onHostGame(b.id)}
                      className="flex-1 py-2 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Host Game
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenInStudio(b)}
                      className="py-2 px-3 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExport(b)}
                      title="Export JSON"
                      className="p-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(b.id)}
                      title="Delete Board"
                      className="p-2 rounded-lg border border-slate-300 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
