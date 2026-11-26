import React, { useState } from 'react';
import { Copy, FolderOpen, Play, Plus, Trash2 } from 'lucide-react';
import type { BoardDefinition, StudioMapWorkspace } from '../../shared/types';
import { computeBoardStats } from '../../shared/benchmarks';
import { BoardCanvas } from '../BoardCanvas';

interface ProjectsHomeProps {
  workspaces: StudioMapWorkspace[];
  libraryBoards: BoardDefinition[];
  activeWorkspaceId: string;
  onCreateProject: (name?: string) => void;
  onOpenWorkspace: (ws: StudioMapWorkspace) => void;
  onOpenLibraryBoard: (board: BoardDefinition) => void;
  onDuplicateWorkspace: (ws: StudioMapWorkspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onHostBoard: (boardId: string) => void;
}

export const ProjectsHome: React.FC<ProjectsHomeProps> = ({
  workspaces,
  libraryBoards,
  activeWorkspaceId,
  onCreateProject,
  onOpenWorkspace,
  onOpenLibraryBoard,
  onDuplicateWorkspace,
  onDeleteWorkspace,
  onHostBoard,
}) => {
  const [newName, setNewName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const wsIds = new Set(workspaces.map((w) => w.id));
  const unindexedLibraryBoards = libraryBoards.filter((b) => !wsIds.has(b.id));

  return (
    <div className="max-w-7xl mx-auto px-4 lg:px-8 py-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Map Projects</h1>
          <p className="text-xs text-slate-600 mt-1">
            Each project keeps its own generation checkpoints, multi-step edits, and undo history.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreateProject(newName.trim() || undefined);
            setNewName('');
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name..."
            className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 w-48 focus:outline-none focus:border-slate-500"
          />
          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Project
          </button>
        </form>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {workspaces.map((ws) => {
          const activeGen =
            ws.generations.find((g) => g.id === ws.activeGenerationId) ||
            ws.generations[ws.generations.length - 1] ||
            null;
          const previewBoard = activeGen?.currentBoard || ws.draftBoard;
          const stats = computeBoardStats(previewBoard);
          const isCurrent = ws.id === activeWorkspaceId;
          const isConfirming = confirmDeleteId === ws.id;

          return (
            <div
              key={ws.id}
              className={`rounded-lg border bg-white overflow-hidden flex flex-col ${
                isCurrent ? 'border-amber-500' : 'border-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => onOpenWorkspace(ws)}
                className="aspect-[10/6.5] border-b border-slate-200 overflow-hidden bg-slate-100 text-left cursor-pointer"
              >
                {previewBoard.locations.length > 0 ? (
                  <BoardCanvas board={previewBoard} mode="preview" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                    Area selected · Ready to scan
                  </div>
                )}
              </button>

              <div className="p-4 flex flex-col gap-3 flex-1 justify-between">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-bold text-slate-900 truncate">{ws.name}</h2>
                    {ws.isSavedToLibrary && (
                      <span className="text-[11px] font-medium text-emerald-700 whitespace-nowrap shrink-0">
                        In Library
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 truncate">
                    {previewBoard.regionLabel}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 tabular-nums">
                    <span>{ws.generations.length} gen(s)</span>
                    <span aria-hidden="true">·</span>
                    <span>{stats.locationsCount} stops</span>
                    <span aria-hidden="true">·</span>
                    <span>{stats.routesCount} routes</span>
                    <span aria-hidden="true">·</span>
                    <span>{stats.totalSpaces} spaces</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-2.5 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(ws)}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    Open
                  </button>
                  {ws.isSavedToLibrary && previewBoard.routes.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onHostBoard(ws.id)}
                      className="py-1.5 px-2.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Host
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDuplicateWorkspace(ws)}
                    title="Duplicate project"
                    className="p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  {isConfirming ? (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        onDeleteWorkspace(ws.id);
                      }}
                      onMouseLeave={() => setConfirmDeleteId(null)}
                      className="py-1.5 px-2 rounded-lg bg-red-600 text-white text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Confirm
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(ws.id)}
                      title="Delete project"
                      className="p-1.5 rounded-lg border border-slate-300 text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {unindexedLibraryBoards.map((b) => {
          const stats = computeBoardStats(b);
          return (
            <div
              key={b.id}
              className="rounded-lg border border-slate-200 bg-white overflow-hidden flex flex-col"
            >
              <button
                type="button"
                onClick={() => onOpenLibraryBoard(b)}
                className="aspect-[10/6.5] border-b border-slate-200 overflow-hidden bg-slate-100 text-left cursor-pointer"
              >
                <BoardCanvas board={b} mode="preview" />
              </button>

              <div className="p-4 flex flex-col gap-3 flex-1 justify-between">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-bold text-slate-900 truncate">{b.name}</h2>
                    <span className="text-[11px] font-medium text-emerald-700 whitespace-nowrap shrink-0">
                      Library Board
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 truncate">{b.regionLabel}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 tabular-nums">
                    <span>{stats.locationsCount} stops</span>
                    <span aria-hidden="true">·</span>
                    <span>{stats.routesCount} routes</span>
                    <span aria-hidden="true">·</span>
                    <span>{stats.totalSpaces} spaces</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-2.5 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => onOpenLibraryBoard(b)}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    Open in Studio
                  </button>
                  <button
                    type="button"
                    onClick={() => onHostBoard(b.id)}
                    className="py-1.5 px-2.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Host
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
