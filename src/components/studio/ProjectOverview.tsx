import React, { useState } from 'react';
import {
  ArrowRight,
  Copy,
  Download,
  Play,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import type {
  BoardTheme,
  MapGenerationCheckpoint,
  PipelineStepId,
  StudioMapWorkspace,
} from '../../shared/types';
import { computeBoardStats } from '../../shared/benchmarks';
import { BoardCanvas } from '../BoardCanvas';

const STEP_LABELS: Record<PipelineStepId, string> = {
  area: '1. Area',
  locations: '2. Locations',
  corridors: '3. Map Routes',
  routes: '4. Train Routes',
  tickets: '5. Tickets',
};

interface ProjectOverviewProps {
  workspace: StudioMapWorkspace;
  isSaving: boolean;
  onRenameProject: (name: string) => void;
  onChangeTheme: (theme: BoardTheme) => void;
  onCreateGeneration: (seedFromGen?: MapGenerationCheckpoint) => void;
  onOpenGeneration: (genId: string, step?: PipelineStepId) => void;
  onDeleteGeneration: (genId: string) => void;
  onSaveToLibrary: () => void;
  onHostGame: () => void;
}

export const ProjectOverview: React.FC<ProjectOverviewProps> = ({
  workspace,
  isSaving,
  onRenameProject,
  onChangeTheme,
  onCreateGeneration,
  onOpenGeneration,
  onDeleteGeneration,
  onSaveToLibrary,
  onHostGame,
}) => {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeGen =
    workspace.generations.find((g) => g.id === workspace.activeGenerationId) ||
    workspace.generations[workspace.generations.length - 1] ||
    null;
  const activeBoard = activeGen?.currentBoard || workspace.draftBoard;

  const handleExportGen = (gen: MapGenerationCheckpoint) => {
    const blob = new Blob([JSON.stringify(gen.currentBoard, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-gen-${gen.index}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 lg:px-8 py-6 flex flex-col gap-6">
      {/* Project Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Project Name
            </label>
            <input
              type="text"
              value={workspace.name}
              onChange={(e) => onRenameProject(e.target.value)}
              className="px-3 py-1.5 text-base font-bold text-slate-900 bg-white border border-slate-300 rounded-lg w-64 focus:outline-none focus:border-slate-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Board Style
            </label>
            <select
              value={activeBoard.theme}
              onChange={(e) => onChangeTheme(e.target.value as BoardTheme)}
              className="px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none"
            >
              <option value="vintage">Vintage Cartography</option>
              <option value="metro">Clean Metro Diagram</option>
              <option value="dark">Night Ops Transit</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onCreateGeneration(activeGen || undefined)}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Generation
          </button>
          <button
            type="button"
            disabled={isSaving || activeBoard.routes.length === 0}
            onClick={onSaveToLibrary}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            {workspace.isSavedToLibrary ? 'Sync to Library' : 'Save to Library'}
          </button>
          {workspace.isSavedToLibrary && activeBoard.routes.length > 0 && (
            <button
              type="button"
              onClick={onHostGame}
              className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              Host Game
            </button>
          )}
        </div>
      </div>

      {/* Generations List */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">
            Generations ({workspace.generations.length})
          </h2>
          <span className="text-xs text-slate-500">
            Compare scales, branch settings, or jump directly to any pipeline step.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {workspace.generations.map((gen) => {
            const stats = computeBoardStats(gen.currentBoard);
            const activeStep = gen.pipeline?.activeStep || 'area';
            const isSelected = gen.id === workspace.activeGenerationId;
            const isConfirming = confirmDeleteId === gen.id;

            return (
              <div
                key={gen.id}
                className={`rounded-lg border bg-white overflow-hidden flex flex-col ${
                  isSelected ? 'border-amber-500' : 'border-slate-200'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenGeneration(gen.id)}
                  className="aspect-[10/6.2] border-b border-slate-200 overflow-hidden bg-slate-100 cursor-pointer"
                >
                  {gen.currentBoard.locations.length > 0 ? (
                    <BoardCanvas board={gen.currentBoard} mode="preview" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                      Area defined · Step 1
                    </div>
                  )}
                </button>

                <div className="p-4 flex flex-col gap-3 flex-1 justify-between">
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-bold text-slate-900 truncate">
                        Generation #{gen.index}
                      </h3>
                      <span className="text-[11px] font-medium text-amber-700 whitespace-nowrap shrink-0">
                        {STEP_LABELS[activeStep]}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500 truncate">
                      {gen.currentBoard.regionLabel} ·{' '}
                      {Math.round(gen.currentBoard.metersPerTrain)} m/train
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 tabular-nums">
                      <span>{stats.locationsCount} stops</span>
                      <span aria-hidden="true">·</span>
                      <span>{stats.routesCount} routes</span>
                      <span aria-hidden="true">·</span>
                      <span>{stats.totalSpaces} spaces</span>
                      <span aria-hidden="true">·</span>
                      <span>{gen.currentBoard.tickets.length} tickets</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                      {gen.undoStack.length} undo snapshot(s)
                    </div>
                  </div>

                  {/* Quick Jump Step Links */}
                  <div className="flex flex-wrap gap-1 pt-2 border-t border-slate-100">
                    {(
                      ['area', 'locations', 'corridors', 'routes', 'tickets'] as PipelineStepId[]
                    ).map((s, idx) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => onOpenGeneration(gen.id, s)}
                        className={`px-2 py-1 rounded text-[11px] font-medium border whitespace-nowrap shrink-0 cursor-pointer ${
                          activeStep === s
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {idx + 1}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => onOpenGeneration(gen.id)}
                      className="flex-1 py-1.5 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Open Pipeline
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onCreateGeneration(gen)}
                      title="Branch new generation from this state"
                      className="p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportGen(gen)}
                      title="Export generation JSON"
                      className="p-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    {workspace.generations.length > 1 &&
                      (isConfirming ? (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDeleteGeneration(gen.id);
                          }}
                          onMouseLeave={() => setConfirmDeleteId(null)}
                          className="py-1.5 px-2 rounded-lg bg-red-600 text-white text-[11px] font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Confirm
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(gen.id)}
                          title="Delete generation"
                          className="p-1.5 rounded-lg border border-slate-300 text-red-600 hover:bg-red-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
