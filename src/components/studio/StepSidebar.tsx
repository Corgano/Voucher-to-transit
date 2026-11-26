import React, { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  GitBranch,
  HelpCircle,
  Link2,
  MapPin,
  Move,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BoardDefinition,
  BoardRoute,
  BoardTheme,
  DeckBasisEdition,
  DestinationTicket,
  GameRules,
  GenerationPipelineState,
  HazardType,
  PipelineCorridorCandidate,
  PipelineLocationCandidate,
  PipelineStepId,
  RouteColor,
  Step2LocationSettings,
  Step3CorridorSettings,
  Step4RouteSettings,
  Step5TicketSettings,
  TransportMode,
  WaypointKind,
} from '../../shared/types';
import { computeBoardStats, normalizeGameRules, ROUTE_COLOR_HEX } from '../../shared/benchmarks';
import { formatScaleRatio } from '../../shared/geoScale';
import type { StudioEditTool } from '../GeoBoardMap';

/**
 * Module-scoped debug verbosity level for StepSidebar:
 * 0 = errors only, 1 = major actions, 2 = light debug, 3 = verbose, 4 = spam.
 */
const SIDEBAR_DEBUG_LEVEL = 0;

const ALL_ROUTE_COLORS: RouteColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'black',
  'white',
  'gray',
];

/**
 * Displays an option label with an interactive hover tooltip badge explaining what the option controls.
 * Call with { label, tooltip, className }.
 * Returns a clean inline label + hover popover span.
 */
const TooltipLabel: React.FC<{
  label: string;
  tooltip: string;
  className?: string;
}> = ({ label, tooltip, className = 'text-slate-600' }) => (
  <span
    className={`inline-flex items-center gap-1 group relative cursor-help ${className}`}
    title={tooltip}
  >
    <span className="border-b border-dotted border-slate-400/80">{label}</span>
    <HelpCircle className="w-3 h-3 text-slate-400 shrink-0" />
    <span className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-0 bottom-full mb-1.5 z-50 w-56 rounded-md bg-slate-900 text-white text-[10px] leading-snug p-2 shadow-lg font-normal whitespace-normal">
      {tooltip}
    </span>
  </span>
);

/**
 * Standard slider row showing live numeric value plus the typical recommended range on the right
 * (`value (typ. typicalRange)`), paired with an explanatory hover tooltip.
 * Call with label, tooltip, valueLabel, typicalRange, min, max, step, value, and onChange.
 * Returns a labeled range input element.
 */
const SliderWithRange: React.FC<{
  label: string;
  tooltip: string;
  valueLabel: string;
  typicalRange: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (val: number) => void;
}> = ({
  label,
  tooltip,
  valueLabel,
  typicalRange,
  min,
  max,
  step = 1,
  value,
  onChange,
}) => (
  <label className="flex flex-col gap-1">
    <div className="flex justify-between items-center gap-2 text-[11px]">
      <TooltipLabel label={label} tooltip={tooltip} />
      <span className="font-mono-num text-right whitespace-nowrap shrink-0">
        <span className="font-semibold text-slate-900">{valueLabel}</span>{' '}
        <span className="text-[10px] text-slate-400">(typ. {typicalRange})</span>
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      title={tooltip}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </label>
);

/**
 * Collapsible container for Auto-Detection & Batch Generation controls so they sit cleanly
 * collapsed at the bottom once map items exist, keeping active editing unobstructed.
 * Call with title, summary, defaultOpen, syncKey (resets open state only when item presence flips), and children.
 * Returns collapsible panel JSX.
 */
const CollapsibleAutoSection: React.FC<{
  title: string;
  summary: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}> = ({ title, summary, defaultOpen, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Expand or collapse automatic generation parameters and batch re-run controls"
        className="w-full px-4 py-2.5 flex items-center justify-between gap-2 bg-slate-50/80 hover:bg-slate-100/90 text-left cursor-pointer"
      >
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 text-xs flex items-center gap-1.5">
            {open ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            )}
            <span>{title}</span>
          </div>
          {!open && (
            <div className="text-[10px] text-slate-500 pl-5 truncate">{summary}</div>
          )}
        </div>
        <span className="text-[10px] font-medium text-slate-500 shrink-0">
          {open ? 'Hide' : 'Configure'}
        </span>
      </button>
      {open && <div className="p-4 pt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
};

interface StepSidebarProps {
  step: PipelineStepId;
  board: BoardDefinition;
  pipeline: GenerationPipelineState;
  geminiAvailable: boolean;
  isBusy: boolean;
  isSaving: boolean;
  editTool: StudioEditTool;
  newWaypointKind: WaypointKind;
  movingLocationId: string | null;
  linkSourceId: string | null;
  selectedLocationId: string | null;
  selectedCorridorId: string | null;
  selectedCorridorWaypointIdx: number | null;
  selectedRouteId: string | null;
  selectedWaypointIdx: number | null;
  selectedTicketId: string | null;
  showRejectedCorridors: boolean;
  dirtyStopCount: number;
  onSetEditTool: (tool: StudioEditTool) => void;
  onSetNewWaypointKind: (kind: WaypointKind) => void;
  onSetShowRejectedCorridors: (show: boolean) => void;
  onArmMoveLocation: (id: string | null) => void;
  onSelectLocationId: (id: string | null) => void;
  onSelectCorridorId: (id: string | null) => void;
  onSelectRouteId: (id: string | null) => void;
  onSelectTicketId: (id: string | null) => void;
  // Step 2 callbacks
  onUpdateStep2Settings: (patch: Partial<Step2LocationSettings>) => void;
  onRunStep2Auto: () => void;
  onRescanArea: () => void;
  onToggleCandidateLocation: (id: string) => void;
  onUpdateCandidateLocation: (id: string, patch: Partial<PipelineLocationCandidate>) => void;
  onRequestDeleteStop: (id: string) => void;
  // Step 3 callbacks
  onUpdateStep3Settings: (patch: Partial<Step3CorridorSettings>) => void;
  onRunStep3Auto: () => void;
  onRefreshNearChangedStops: () => void;
  onToggleCorridor: (id: string) => void;
  onUpdateCorridor: (id: string, patch: Partial<PipelineCorridorCandidate>) => void;
  onToggleCorridorWaypointKind: (corridorId: string, index: number) => void;
  onDeleteCorridorWaypoint: (corridorId: string, index: number) => void;
  onClearCorridorWaypoints: (id: string) => void;
  onDeleteCorridor: (id: string) => void;
  // Step 4 callbacks
  onUpdateStep4Settings: (patch: Partial<Step4RouteSettings>) => void;
  onRunStep4Auto: () => void;
  onUpdateRoute: (id: string, patch: Partial<BoardRoute>) => void;
  onToggleRouteWaypointKind: (routeId: string, index: number) => void;
  onDeleteRouteWaypoint: (routeId: string, index: number) => void;
  onResetRouteToCorridor: (routeId: string) => void;
  onClearRouteWaypoints: (id: string) => void;
  onDeleteRoute: (id: string) => void;
  // Step 5 callbacks
  onUpdateStep5Settings: (patch: Partial<Step5TicketSettings>) => void;
  onRunStep5Auto: () => void;
  onRecalculateTickets: () => void;
  onAddManualTicket: (fromId: string, toId: string) => void;
  onUpdateTicket: (id: string, patch: Partial<DestinationTicket>) => void;
  onDeleteTicket: (id: string) => void;
  onUpdateBoardMeta: (patch: { name?: string; regionLabel?: string; theme?: BoardTheme }) => void;
  onUpdateBakedRules: (patch: Partial<GameRules>) => void;
  onSaveToLibrary: () => void;
  onHostGame: () => void;
  onNextStep: () => void;
}

/**
 * Right-hand pipeline step sidebar for Steps 2..5.
 * Renders interactive item inspectors and lists first, keeps auto-detection sections collapsed
 * at the bottom once items exist, displays typical slider ranges, and documents every option via tooltips.
 */
export const StepSidebar: React.FC<StepSidebarProps> = ({
  step,
  board,
  pipeline,
  geminiAvailable,
  isBusy,
  isSaving,
  editTool,
  newWaypointKind,
  movingLocationId,
  linkSourceId,
  selectedLocationId,
  selectedCorridorId,
  selectedCorridorWaypointIdx,
  selectedRouteId,
  selectedWaypointIdx,
  selectedTicketId,
  showRejectedCorridors,
  dirtyStopCount,
  onSetEditTool,
  onSetNewWaypointKind,
  onSetShowRejectedCorridors,
  onArmMoveLocation,
  onSelectLocationId,
  onSelectCorridorId,
  onSelectRouteId,
  onSelectTicketId,
  onUpdateStep2Settings,
  onRunStep2Auto,
  onRescanArea,
  onToggleCandidateLocation,
  onUpdateCandidateLocation,
  onRequestDeleteStop,
  onUpdateStep3Settings,
  onRunStep3Auto,
  onRefreshNearChangedStops,
  onToggleCorridor,
  onUpdateCorridor,
  onToggleCorridorWaypointKind,
  onDeleteCorridorWaypoint,
  onClearCorridorWaypoints,
  onDeleteCorridor,
  onUpdateStep4Settings,
  onRunStep4Auto,
  onUpdateRoute,
  onToggleRouteWaypointKind,
  onDeleteRouteWaypoint,
  onResetRouteToCorridor,
  onClearRouteWaypoints,
  onDeleteRoute,
  onUpdateStep5Settings,
  onRunStep5Auto,
  onRecalculateTickets,
  onAddManualTicket,
  onUpdateTicket,
  onDeleteTicket,
  onUpdateBoardMeta,
  onUpdateBakedRules,
  onSaveToLibrary,
  onHostGame,
  onNextStep,
}) => {
  const [candFilter, setCandFilter] = useState<'all' | 'selected' | 'unselected'>('all');
  const [corrFilter, setCorrFilter] = useState<'all' | 'selected' | 'unselected'>('selected');
  const [manualTicketFrom, setManualTicketFrom] = useState('');
  const [manualTicketTo, setManualTicketTo] = useState('');

  if (SIDEBAR_DEBUG_LEVEL >= 4) {
    console.debug('[StepSidebar] render step=', step);
  }

  const locNameById = new Map(
    pipeline.locations.candidates.map((l) => [l.id, l.name])
  );
  const activeLocs = pipeline.locations.candidates.filter((c) => c.selected);
  const stats = computeBoardStats(board);

  // =========================================================================
  // STEP 2: LOCATIONS
  // =========================================================================
  if (step === 'locations') {
    const s2 = pipeline.locations.settings;
    const cands = pipeline.locations.candidates;
    const selectedCount = activeLocs.length;
    const selectedCand = cands.find((c) => c.id === selectedLocationId) || null;
    const filteredList = cands
      .filter((c) =>
        candFilter === 'all' ? true : candFilter === 'selected' ? c.selected : !c.selected
      )
      .slice()
      .sort((a, b) => Number(b.selected) - Number(a.selected) || b.popularityScore - a.popularityScore);

    return (
      <div className="flex flex-col divide-y divide-slate-200 text-xs text-slate-800">
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Step 2: Locations</h2>
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {selectedCount} active stops right now · {cands.length} candidates
              </p>
            </div>
            <button
              type="button"
              onClick={onNextStep}
              disabled={selectedCount < 4}
              title="Advance to Step 3: fetches any newly added/moved stop corridors and maps real rail, ferry, and highway routes"
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Next: Map Routes
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => onSetEditTool('select')}
              title="Select or toggle existing candidates on/off, or click a moving stop"
              className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer ${
                editTool === 'select'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Crosshair className="w-3.5 h-3.5 shrink-0" />
              Select
            </button>
            <button
              type="button"
              onClick={() => onSetEditTool(editTool === 'add_stop' ? 'select' : 'add_stop')}
              title="Click anywhere on the map to place a manual stop and search nearby stations, ports, or landmarks"
              className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer ${
                editTool === 'add_stop'
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <MapPin className="w-3.5 h-3.5 shrink-0" />
              {editTool === 'add_stop' ? 'Tap Map' : 'Add Stop'}
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                onSetEditTool(editTool === 'discover_box' ? 'select' : 'discover_box')
              }
              title="Drag a smaller rectangle on the map to discover rail halts, ferry landings, and multimodal transfer hubs inside that zone"
              className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                editTool === 'discover_box'
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <ScanSearch className="w-3.5 h-3.5 shrink-0" />
              {editTool === 'discover_box' ? 'Drag Zone' : 'Discover'}
            </button>
          </div>
        </div>

        {/* Selected Location Inspector */}
        {selectedCand && (
          <div className="p-4 bg-amber-50/50 flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-slate-900 text-xs">{selectedCand.name}</div>
                <div className="text-[11px] text-slate-600 tabular-nums">
                  Score {selectedCand.popularityScore} · {selectedCand.category}
                  {selectedCand.interchangeModes && selectedCand.interchangeModes.length >= 2
                    ? ` · Interchange (${selectedCand.interchangeModes.join('+')})`
                    : ''}
                  {!selectedCand.selected && selectedCand.filterReason
                    ? ` · Rejected (${selectedCand.filterReason})`
                    : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelectLocationId(null)}
                className="p-1 rounded hover:bg-slate-200/70 text-slate-500 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onToggleCandidateLocation(selectedCand.id)}
                title="Include or exclude this stop on the active game board"
                className={`flex-1 py-1.5 px-2.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedCand.selected
                    ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                    : 'bg-slate-900 text-white hover:bg-slate-800'
                }`}
              >
                {selectedCand.selected ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    Included (Exclude)
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    Include Stop
                  </>
                )}
              </button>

              {selectedCand.selected && (
                <button
                  type="button"
                  onClick={() =>
                    onArmMoveLocation(
                      movingLocationId === selectedCand.id ? null : selectedCand.id
                    )
                  }
                  title="Arm move mode to drag this stop or click its new coordinate on the map"
                  className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium flex items-center gap-1 whitespace-nowrap cursor-pointer ${
                    movingLocationId === selectedCand.id
                      ? 'bg-red-700 text-white border-red-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <Move className="w-3.5 h-3.5" />
                  {movingLocationId === selectedCand.id ? 'Tap Map' : 'Move'}
                </button>
              )}
            </div>

            {selectedCand.selected && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <input
                  type="text"
                  value={selectedCand.name}
                  title="Editable display name printed on the game board"
                  onChange={(e) =>
                    onUpdateCandidateLocation(selectedCand.id, { name: e.target.value })
                  }
                  className="col-span-2 px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                />
                <select
                  value={selectedCand.category}
                  title="Stop classification (cities, stations, ferry ports, landmarks, districts)"
                  onChange={(e) =>
                    onUpdateCandidateLocation(selectedCand.id, {
                      category: e.target.value as PipelineLocationCandidate['category'],
                    })
                  }
                  className="px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px]"
                >
                  <option value="city">City</option>
                  <option value="station">Station</option>
                  <option value="port">Port / Ferry</option>
                  <option value="landmark">Landmark</option>
                  <option value="district">District</option>
                </select>
                <label
                  className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px] cursor-pointer"
                  title="Marks this stop as a Major Hub, allowing multi-lane double/triple routes when Hub for Multi-Lane is enabled"
                >
                  <input
                    type="checkbox"
                    checked={selectedCand.isMajorHub}
                    onChange={(e) =>
                      onUpdateCandidateLocation(selectedCand.id, {
                        isMajorHub: e.target.checked,
                      })
                    }
                  />
                  Major Hub
                </label>
              </div>
            )}

            <button
              type="button"
              onClick={() => onRequestDeleteStop(selectedCand.id)}
              title="Delete stop (also removes connected routes and asks confirmation if >2 routes connect here)"
              className="py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 text-[11px] font-medium flex items-center justify-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Stop
            </button>
          </div>
        )}

        {/* All Detected Candidates List */}
        <div className="p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <TooltipLabel
              label="Candidates List"
              tooltip="All detected POIs inside the bounding box. Click a row to inspect or toggle On/Off to override automatic selection."
              className="font-semibold text-slate-900"
            />
            <div className="flex gap-1">
              {(['all', 'selected', 'unselected'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setCandFilter(f)}
                  className={`px-2 py-0.5 rounded text-[11px] capitalize cursor-pointer ${
                    candFilter === f
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
            {filteredList.length === 0 ? (
              <div className="p-3 text-[11px] text-slate-500 text-center">
                No candidates match filter.
              </div>
            ) : (
              filteredList.map((c) => (
                <div
                  key={c.id}
                  onClick={() => onSelectLocationId(c.id)}
                  className={`px-2.5 py-1.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 ${
                    selectedLocationId === c.id ? 'bg-amber-50' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate flex items-center gap-1">
                      <span className="truncate">{c.name}</span>
                      {c.interchangeModes && c.interchangeModes.length >= 2 && (
                        <span className="px-1 py-0.2 rounded bg-teal-50 border border-teal-200 text-teal-800 text-[9px] font-semibold shrink-0">
                          {c.interchangeModes.slice(0, 2).join('+')}
                        </span>
                      )}
                      {c.discoveredByBox && (
                        <span className="px-1 py-0.2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[9px] font-semibold shrink-0">
                          zone
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 tabular-nums">
                      {c.category} · Score {c.popularityScore}
                      {!c.selected && c.filterReason ? ` · ${c.filterReason}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCandidateLocation(c.id);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                      c.selected
                        ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {c.selected ? 'On' : 'Off'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Collapsible Auto-Detection Section at Bottom */}
        <CollapsibleAutoSection
          title="Auto-Select Locations Settings"
          summary={`Target ${s2.targetLocations} · Spacing ${s2.minNodeSpacingTrains.toFixed(1)}x · Min score ${s2.minCandidateScore}`}
          defaultOpen={cands.length === 0}
        >
          {!pipeline.area.dataset && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onRescanArea}
              title="Query OpenStreetMap & transit feeds inside the Step 1 bounding box"
              className="text-[11px] font-medium text-amber-700 hover:underline text-left cursor-pointer"
            >
              Scan Region POIs First
            </button>
          )}

          <SliderWithRange
            label="Target Stops (Auto Goal)"
            tooltip="How many total active stops Auto-Select Locations attempts to pick when you click Auto-Select. It does not change your current count until re-run."
            valueLabel={`${s2.targetLocations}`}
            typicalRange="28–45"
            min={12}
            max={60}
            value={s2.targetLocations}
            onChange={(val) => onUpdateStep2Settings({ targetLocations: val })}
          />

          <SliderWithRange
            label="Min Spacing (trains)"
            tooltip="Minimum geographic distance enforced between auto-selected stops, measured in board train car lengths."
            valueLabel={`${s2.minNodeSpacingTrains.toFixed(1)}x`}
            typicalRange="1.6–2.6x"
            min={1.1}
            max={4.5}
            step={0.1}
            value={s2.minNodeSpacingTrains}
            onChange={(val) => onUpdateStep2Settings({ minNodeSpacingTrains: val })}
          />

          <SliderWithRange
            label="Min Candidate Score"
            tooltip="Minimum popularity/transit interchange utility score required for an OSM candidate to be auto-selected."
            valueLabel={`${s2.minCandidateScore}`}
            typicalRange="15–35"
            min={0}
            max={75}
            step={1}
            value={s2.minCandidateScore}
            onChange={(val) => onUpdateStep2Settings({ minCandidateScore: val })}
          />

          <SliderWithRange
            label="Major Hub Share"
            tooltip="Percentage of auto-selected stops promoted to Major Hubs (eligible for double or triple tracks)."
            valueLabel={`${Math.round(s2.majorHubShare * 100)}%`}
            typicalRange="20–35%"
            min={10}
            max={50}
            step={1}
            value={Math.round(s2.majorHubShare * 100)}
            onChange={(val) => onUpdateStep2Settings({ majorHubShare: val / 100 })}
          />

          {geminiAvailable && (
            <label
              className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer"
              title="Uses AI name cleanup and strategic hub boosts on detected OSM POIs"
            >
              <input
                type="checkbox"
                checked={s2.useAiEnrichment}
                onChange={(e) =>
                  onUpdateStep2Settings({ useAiEnrichment: e.target.checked })
                }
              />
              <Sparkles className="w-3.5 h-3.5 text-amber-600" />
              <TooltipLabel
                label="Use AI Landmark & Name Polish"
                tooltip="Cleans verbose transit names and prioritizes recognizable regional hubs during auto-selection."
              />
            </label>
          )}

          <button
            type="button"
            disabled={isBusy}
            onClick={onRunStep2Auto}
            title="Re-run automatic location selection using the target goal and spacing settings above (preserves manual pins)"
            className="w-full py-2 px-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
            {isBusy ? 'Selecting...' : 'Auto-Select Locations'}
          </button>
        </CollapsibleAutoSection>
      </div>
    );
  }

  // =========================================================================
  // STEP 3: MAP CORRIDORS (REAL RAIL / FERRY / BUS / HIGHWAY LINKS)
  // =========================================================================
  if (step === 'corridors') {
    const s3 = pipeline.corridors.settings;
    const corrs = pipeline.corridors.candidates;
    const activeCorrs = corrs.filter((c) => c.selected);
    const selCorr = corrs.find((c) => c.id === selectedCorridorId) || null;
    const filteredCorrs = corrs.filter((c) =>
      corrFilter === 'all' ? true : corrFilter === 'selected' ? c.selected : !c.selected
    );
    const activeCorrWpKind =
      selCorr && selectedCorridorWaypointIdx !== null
        ? selCorr.waypoints?.[selectedCorridorWaypointIdx]?.kind || 'curve'
        : null;

    return (
      <div className="flex flex-col divide-y divide-slate-200 text-xs text-slate-800">
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Step 3: Map Routes</h2>
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {activeCorrs.length} selected of {corrs.length} real-world segments
              </p>
            </div>
            <button
              type="button"
              onClick={onNextStep}
              disabled={activeCorrs.length === 0}
              title="Advance to Step 4 to fit train pieces onto your selected Step 3 map routes"
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Next: Train Routes
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onSetEditTool('select')}
              title="Click map routes to select them, drag composite points, or hover candidates for yellow map highlights"
              className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
                editTool === 'select'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Crosshair className="w-3.5 h-3.5" />
              Select / Edit
            </button>
            <button
              type="button"
              onClick={() => onSetEditTool(editTool === 'add_route' ? 'select' : 'add_route')}
              title="Click two stops on the map to create a custom real-world map route between them"
              className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
                editTool === 'add_route'
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              {editTool === 'add_route'
                ? linkSourceId
                  ? 'Pick 2nd Stop'
                  : 'Pick 1st Stop'
                : 'Link Two Stops'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label
              className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer"
              title="Shows unselected candidate corridors as subtle lines that glow yellow when hovered"
            >
              <input
                type="checkbox"
                checked={showRejectedCorridors}
                onChange={(e) => onSetShowRejectedCorridors(e.target.checked)}
              />
              Show candidate paths (hover yellow)
            </label>

            <button
              type="button"
              disabled={isBusy}
              onClick={onRefreshNearChangedStops}
              title="Query Overpass for rail, ferry, and highway routes connecting any stops added or moved in Step 2"
              className={`px-2 py-1 rounded border text-[10px] font-semibold flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                dirtyStopCount > 0
                  ? 'bg-amber-100 border-amber-400 text-amber-900 hover:bg-amber-200'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${isBusy ? 'animate-spin' : ''}`} />
              Fetch Near Stops{dirtyStopCount > 0 ? ` (${dirtyStopCount})` : ''}
            </button>
          </div>
        </div>

        {/* Selected Corridor Inspector */}
        {selCorr && (
          <div className="p-4 bg-amber-50/50 flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-slate-900 text-xs">
                  {locNameById.get(selCorr.fromId) || selCorr.fromId} -{' '}
                  {locNameById.get(selCorr.toId) || selCorr.toId}
                </div>
                <div className="text-[11px] text-slate-600 tabular-nums">
                  {selCorr.mode} · Weight {selCorr.transitWeight}
                  {(selCorr.evidenceCount || 1) > 1 ? ` · ${selCorr.evidenceCount} tracks` : ''} ·{' '}
                  {(selCorr.arcMeters / 1000).toFixed(1)} km
                  {!selCorr.selected && selCorr.rejectionReason
                    ? ` · ${selCorr.rejectionReason}`
                    : ''}
                </div>
                {selCorr.realLineName && (
                  <div className="text-[11px] text-slate-500">{selCorr.realLineName}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onSelectCorridorId(null)}
                className="p-1 rounded hover:bg-slate-200/70 text-slate-500 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => onToggleCorridor(selCorr.id)}
                title="Include or exclude this real-world segment from Step 4 train route generation"
                className={`flex-1 py-1.5 px-2.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer ${
                  selCorr.selected
                    ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                    : 'bg-slate-900 text-white hover:bg-slate-800'
                }`}
              >
                {selCorr.selected ? 'Selected (Click to Disable)' : 'Enable Map Route'}
              </button>
              <button
                type="button"
                onClick={() => onDeleteCorridor(selCorr.id)}
                title="Delete this corridor segment (or press Delete key while selected)"
                className="px-2.5 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                <TooltipLabel
                  label="Transit Mode"
                  tooltip="Specifies real-world infrastructure type (Rail, Ferry, Bus, Highway)."
                />
                <select
                  value={selCorr.mode}
                  onChange={(e) =>
                    onUpdateCorridor(selCorr.id, { mode: e.target.value as TransportMode })
                  }
                  className="px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px] text-slate-900"
                >
                  <option value="train">Rail</option>
                  <option value="ferry">Ferry</option>
                  <option value="bus">Bus / Transit</option>
                  <option value="highway">Highway</option>
                </select>
              </label>

              <div className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                <TooltipLabel
                  label="Add Waypoint Tool"
                  tooltip="Click Add Waypoint, then click on the map to insert a point connected between the 2 closest consecutive points on this route. Or right-click anywhere along the line."
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      onSetEditTool(editTool === 'add_waypoint' ? 'select' : 'add_waypoint')
                    }
                    className={`flex-1 py-1.5 px-2 rounded border text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                      editTool === 'add_waypoint'
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <Plus className="w-3 h-3" />
                    {editTool === 'add_waypoint' ? 'Tap Map' : 'Add Waypoint'}
                  </button>
                  <select
                    value={newWaypointKind}
                    title="Choose whether added waypoints are smooth Curves or sharp Corners"
                    onChange={(e) => onSetNewWaypointKind(e.target.value as WaypointKind)}
                    className="px-1.5 py-1 bg-white border border-slate-300 rounded text-[10px] text-slate-900"
                  >
                    <option value="curve">Curve</option>
                    <option value="corner">Corner</option>
                  </select>
                </div>
              </div>
            </div>

            {selectedCorridorWaypointIdx !== null && activeCorrWpKind && (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-white border border-amber-300 text-[11px]">
                <span className="font-semibold text-slate-800">
                  Point #{selectedCorridorWaypointIdx + 1} ({activeCorrWpKind})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onToggleCorridorWaypointKind(selCorr.id, selectedCorridorWaypointIdx)
                    }
                    className="text-amber-700 hover:underline font-medium cursor-pointer"
                  >
                    Switch to {activeCorrWpKind === 'corner' ? 'Curve' : 'Corner'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onDeleteCorridorWaypoint(selCorr.id, selectedCorridorWaypointIdx)
                    }
                    className="text-red-700 hover:underline font-medium cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span>Right-click line to insert Corner or Curve point</span>
              {(selCorr.waypoints?.length || 0) > 0 && (
                <button
                  type="button"
                  onClick={() => onClearCorridorWaypoints(selCorr.id)}
                  className="text-red-700 hover:underline cursor-pointer"
                >
                  Clear ({selCorr.waypoints?.length})
                </button>
              )}
            </div>
          </div>
        )}

        {/* Corridors List */}
        <div className="p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <TooltipLabel
              label="Corridors List"
              tooltip="Detected real-world corridors connecting selected stops. Toggle On/Off or select to edit geometry."
              className="font-semibold text-slate-900"
            />
            <div className="flex gap-1">
              {(['selected', 'unselected', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setCorrFilter(f)}
                  className={`px-2 py-0.5 rounded text-[11px] capitalize cursor-pointer ${
                    corrFilter === f
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
            {filteredCorrs.slice(0, 100).map((c) => (
              <div
                key={c.id}
                onClick={() => onSelectCorridorId(c.id)}
                className={`px-2.5 py-1.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 ${
                  selectedCorridorId === c.id ? 'bg-amber-50' : ''
                }`}
              >
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">
                    {locNameById.get(c.fromId) || c.fromId} -{' '}
                    {locNameById.get(c.toId) || c.toId}
                  </div>
                  <div className="text-[10px] text-slate-500 tabular-nums">
                    {c.mode} · Wt {c.transitWeight}
                    {(c.evidenceCount || 1) > 1 ? ` · ${c.evidenceCount}x` : ''} ·{' '}
                    {(c.arcMeters / 1000).toFixed(1)}km
                    {!c.selected && c.rejectionReason ? ` · ${c.rejectionReason}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCorridor(c.id);
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                    c.selected
                      ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {c.selected ? 'On' : 'Off'}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Collapsible Auto-Detection Section at Bottom */}
        <CollapsibleAutoSection
          title="Auto-Detect Corridors Settings"
          summary={`Links ${s3.minConnections}-${s3.maxConnections} · Fidelity ${s3.transitFidelity}% · Min wt ${s3.minCorridorWeight} · Overlap ${s3.overlapAvoidance ?? 75}%`}
          defaultOpen={corrs.length === 0}
        >
          <SliderWithRange
            label="Min Links / Stop"
            tooltip="Target minimum connections attempted per active stop when auto-selecting the corridor graph."
            valueLabel={`${s3.minConnections}`}
            typicalRange="2–3"
            min={1}
            max={4}
            step={1}
            value={s3.minConnections}
            onChange={(val) => onUpdateStep3Settings({ minConnections: val })}
          />

          <SliderWithRange
            label="Max Links / Stop"
            tooltip="Upper cap on corridor edges meeting at a single stop during auto-detection."
            valueLabel={`${s3.maxConnections}`}
            typicalRange="4–7"
            min={3}
            max={10}
            step={1}
            value={s3.maxConnections}
            onChange={(val) => onUpdateStep3Settings({ maxConnections: val })}
          />

          <SliderWithRange
            label="Transit Fidelity"
            tooltip="How strongly auto-selection favors real rail/ferry corridors over direct shortest shortcuts."
            valueLabel={`${s3.transitFidelity}%`}
            typicalRange="65–90%"
            min={0}
            max={100}
            step={1}
            value={s3.transitFidelity}
            onChange={(val) => onUpdateStep3Settings({ transitFidelity: val })}
          />

          <SliderWithRange
            label="Min Corridor Weight"
            tooltip="Drops candidate links weaker than this real-world transit score from automatic selection."
            valueLabel={`${s3.minCorridorWeight}`}
            typicalRange="15–35"
            min={0}
            max={75}
            step={1}
            value={s3.minCorridorWeight}
            onChange={(val) => onUpdateStep3Settings({ minCorridorWeight: val })}
          />

          <SliderWithRange
            label="Overlap Avoidance"
            tooltip="Detects crossing and near-parallel overlapping map corridors and avoids them whenever non-overlapping alternatives exist."
            valueLabel={`${s3.overlapAvoidance ?? 75}%`}
            typicalRange="60–90%"
            min={0}
            max={100}
            step={1}
            value={s3.overlapAvoidance ?? 75}
            onChange={(val) => onUpdateStep3Settings({ overlapAvoidance: val })}
          />

          <label
            className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer"
            title="Traces real OSM rail, ferry, and road vertices into composite waypoints instead of straight lines"
          >
            <input
              type="checkbox"
              checked={s3.traceRealCorridors}
              onChange={(e) =>
                onUpdateStep3Settings({ traceRealCorridors: e.target.checked })
              }
            />
            <TooltipLabel
              label="Trace real OSM route waypoints"
              tooltip="Follows true geographic rail/ferry curves and corners from cached OSM geometry."
            />
          </label>

          <label
            className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer"
            title="Permits bus routes to cross other routes at shallow/wide angles with a crossing hazard"
          >
            <input
              type="checkbox"
              checked={s3.allowBusCrossings}
              onChange={(e) =>
                onUpdateStep3Settings({ allowBusCrossings: e.target.checked })
              }
            />
            <TooltipLabel
              label="Allow Bus intersection crossings"
              tooltip="Allows bus routes to cross other corridors instead of blocking them as invalid intersections."
            />
          </label>

          <button
            type="button"
            disabled={isBusy}
            onClick={onRunStep3Auto}
            title="Re-detects and splits real OSM corridors across active stops using the settings above"
            className="w-full py-2 px-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <GitBranch className="w-3.5 h-3.5" />
            Auto-Detect Map Corridors
          </button>
        </CollapsibleAutoSection>
      </div>
    );
  }

  // =========================================================================
  // STEP 4: TRAIN ROUTES (PARAMETRIC CONVERSION, LANE WIDTH, COLORS, HAZARDS)
  // =========================================================================
  if (step === 'routes') {
    const s4 = pipeline.routes.settings;
    const routes = pipeline.routes.items;
    const selRoute = routes.find((r) => r.id === selectedRouteId) || null;
    const selLaneCount: 1 | 2 | 3 = selRoute
      ? selRoute.laneCount ?? (selRoute.isDouble ? 2 : 1)
      : 1;
    const activeRouteWpKind =
      selRoute && selectedWaypointIdx !== null
        ? selRoute.waypoints?.[selectedWaypointIdx]?.kind || 'curve'
        : null;
    const hasCustomOrOffsetWps = Boolean(
      selRoute &&
        (selRoute.customWaypoints ||
          selRoute.waypoints?.some((w) => Math.abs(w.relOffsetRatio || 0) > 0.002))
    );

    return (
      <div className="flex flex-col divide-y divide-slate-200 text-xs text-slate-800">
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Step 4: Train Routes</h2>
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {routes.length} routes · {stats.totalSpaces} spaces ·{' '}
                {formatScaleRatio(s4.metersPerTrain)}
              </p>
            </div>
            <button
              type="button"
              onClick={onNextStep}
              disabled={routes.length === 0}
              title="Advance to Step 5 to generate and calibrate Destination Tickets"
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Next: Tickets
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            Train routes inherit waypoints from selected Step 3 map routes and track parent tweaks proportionally.
          </p>
        </div>

        {/* Selected Route Inspector */}
        {selRoute && (
          <div className="p-4 bg-amber-50/50 flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-slate-900">
                  {locNameById.get(selRoute.fromId) || selRoute.fromId} -{' '}
                  {locNameById.get(selRoute.toId) || selRoute.toId}
                </div>
                <div className="text-[11px] text-slate-600 tabular-nums">
                  {selRoute.length} spaces · {selRoute.transportMode} · Wt{' '}
                  {selRoute.transitWeight}
                  {hasCustomOrOffsetWps ? ' · Offset/Custom Path' : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onSelectRouteId(null)}
                className="p-1 rounded hover:bg-slate-200/70 text-slate-500 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Single / Double / Triple Lane Selector */}
            <div>
              <TooltipLabel
                label="Parallel Lanes"
                tooltip="Choose Single, Double, or Triple parallel car tracks on this route."
                className="text-[11px] text-slate-600 mb-1"
              />
              <div className="grid grid-cols-3 gap-1">
                {([1, 2, 3] as const).map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    onClick={() =>
                      onUpdateRoute(selRoute.id, {
                        laneCount: cnt,
                        isDouble: cnt >= 2,
                        doubleColor:
                          cnt >= 2 ? selRoute.doubleColor || 'gray' : undefined,
                        tripleColor:
                          cnt >= 3 ? selRoute.tripleColor || 'blue' : undefined,
                      })
                    }
                    className={`py-1.5 rounded border text-[11px] font-semibold cursor-pointer ${
                      selLaneCount === cnt
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {cnt === 1 ? 'Single' : cnt === 2 ? 'Double' : 'Triple'}
                  </button>
                ))}
              </div>
            </div>

            {/* Colors */}
            <div className="grid grid-cols-3 gap-1.5">
              <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                Lane 1 Color
                <select
                  value={selRoute.color}
                  onChange={(e) =>
                    onUpdateRoute(selRoute.id, { color: e.target.value as RouteColor })
                  }
                  className="px-1.5 py-1 bg-white border border-slate-300 rounded text-[11px] text-slate-900"
                >
                  {ALL_ROUTE_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {ROUTE_COLOR_HEX[c].label}
                    </option>
                  ))}
                </select>
              </label>

              {selLaneCount >= 2 && (
                <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                  Lane 2 Color
                  <select
                    value={selRoute.doubleColor || selRoute.color}
                    onChange={(e) =>
                      onUpdateRoute(selRoute.id, {
                        doubleColor: e.target.value as RouteColor,
                      })
                    }
                    className="px-1.5 py-1 bg-white border border-slate-300 rounded text-[11px] text-slate-900"
                  >
                    {ALL_ROUTE_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {ROUTE_COLOR_HEX[c].label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selLaneCount >= 3 && (
                <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                  Lane 3 Color
                  <select
                    value={selRoute.tripleColor || selRoute.doubleColor || selRoute.color}
                    onChange={(e) =>
                      onUpdateRoute(selRoute.id, {
                        tripleColor: e.target.value as RouteColor,
                      })
                    }
                    className="px-1.5 py-1 bg-white border border-slate-300 rounded text-[11px] text-slate-900"
                  >
                    {ALL_ROUTE_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {ROUTE_COLOR_HEX[c].label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* Length, Mode, Composite Waypoint Insertion Tool, Ferry Locos */}
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <SliderWithRange
                  label="Car Spaces"
                  tooltip="Number of train/bus/ship car spaces players spend cards to claim on this route."
                  valueLabel={`${selRoute.length}`}
                  typicalRange="2–8"
                  min={1}
                  max={15}
                  value={selRoute.length}
                  onChange={(val) => onUpdateRoute(selRoute.id, { length: val })}
                />
              </div>

              <label className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                <TooltipLabel
                  label="Transport Mode"
                  tooltip="Vehicle category for split-piece rules and map iconography."
                />
                <select
                  value={selRoute.transportMode}
                  onChange={(e) =>
                    onUpdateRoute(selRoute.id, {
                      transportMode: e.target.value as TransportMode,
                    })
                  }
                  className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] text-slate-900"
                >
                  <option value="train">Train</option>
                  <option value="bus">Bus</option>
                  <option value="ferry">Ferry</option>
                  <option value="highway">Highway</option>
                </select>
              </label>

              <div className="flex flex-col gap-0.5 text-[10px] text-slate-600">
                <TooltipLabel
                  label="Add Waypoint Tool"
                  tooltip="Click Add Waypoint, then click on the map to insert a point connected between the 2 closest consecutive points on this route. Or right-click the route."
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      onSetEditTool(editTool === 'add_waypoint' ? 'select' : 'add_waypoint')
                    }
                    className={`flex-1 py-1 px-2 rounded border text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                      editTool === 'add_waypoint'
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <Plus className="w-3 h-3" />
                    {editTool === 'add_waypoint' ? 'Tap Map' : 'Add Waypoint'}
                  </button>
                  <select
                    value={newWaypointKind}
                    title="Default kind for newly added waypoints (Curve or sharp Corner)"
                    onChange={(e) => onSetNewWaypointKind(e.target.value as WaypointKind)}
                    className="px-1.5 py-1 bg-white border border-slate-300 rounded text-[10px] text-slate-900"
                  >
                    <option value="curve">Curve</option>
                    <option value="corner">Corner</option>
                  </select>
                </div>
              </div>

              <div className="col-span-2">
                <SliderWithRange
                  label="Ferry Locomotives"
                  tooltip="How many wildcard locomotive cards are required to claim this ferry route."
                  valueLabel={`${selRoute.ferryLocomotives}`}
                  typicalRange="0–2"
                  min={0}
                  max={3}
                  value={selRoute.ferryLocomotives}
                  onChange={(val) =>
                    onUpdateRoute(selRoute.id, { ferryLocomotives: val })
                  }
                />
              </div>
            </div>

            {selectedWaypointIdx !== null && activeRouteWpKind && (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-white border border-amber-300 text-[11px]">
                <span className="font-semibold text-slate-800">
                  Point #{selectedWaypointIdx + 1} ({activeRouteWpKind})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onToggleRouteWaypointKind(selRoute.id, selectedWaypointIdx)
                    }
                    className="text-amber-700 hover:underline font-medium cursor-pointer"
                  >
                    Switch to {activeRouteWpKind === 'corner' ? 'Curve' : 'Corner'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onDeleteRouteWaypoint(selRoute.id, selectedWaypointIdx)
                    }
                    className="text-red-700 hover:underline font-medium cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 items-center">
              <label
                className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer"
                title="Enables tunnel claim card-draw rule on this route"
              >
                <input
                  type="checkbox"
                  checked={selRoute.isTunnel}
                  onChange={(e) =>
                    onUpdateRoute(selRoute.id, { isTunnel: e.target.checked })
                  }
                />
                Tunnel Route
              </label>
              <select
                value={selRoute.hazardType}
                title="Assign an optional crossing or maritime dice hazard to this route"
                onChange={(e) => {
                  const ht = e.target.value as HazardType;
                  onUpdateRoute(selRoute.id, {
                    hazardType: ht,
                    hazardRating: ht === 'none' ? 0 : Math.max(1, selRoute.hazardRating || 2),
                  });
                }}
                className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px]"
              >
                <option value="none">No Hazard</option>
                <option value="bus_crossing">Bus Crossing</option>
                <option value="shipping_lane">Shipping Hazard</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                {selRoute.sourceCorridorId && (
                  <button
                    type="button"
                    onClick={() => onResetRouteToCorridor(selRoute.id)}
                    title="Re-copy waypoints cleanly from the parent Step 3 Map Corridor"
                    className="text-[11px] text-teal-700 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset to Map Route
                  </button>
                )}
                {(selRoute.waypoints?.length || 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => onClearRouteWaypoints(selRoute.id)}
                    className="text-[11px] text-slate-600 hover:underline cursor-pointer"
                  >
                    Clear ({selRoute.waypoints?.length})
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDeleteRoute(selRoute.id)}
                title="Remove this train route from the game board (or press Delete key while selected)"
                className="text-[11px] text-red-700 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                Remove Route
              </button>
            </div>
          </div>
        )}

        {/* Train Routes List */}
        <div className="p-4 flex flex-col gap-2">
          <TooltipLabel
            label={`Game Routes (${routes.length})`}
            tooltip="Click any route here or on the map to adjust lanes, colors, hazards, or composite waypoints."
            className="font-semibold text-slate-900"
          />
          <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
            {routes.map((rt) => {
              const lc = rt.laneCount ?? (rt.isDouble ? 2 : 1);
              return (
                <div
                  key={rt.id}
                  onClick={() => onSelectRouteId(rt.id)}
                  className={`px-2.5 py-1.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 ${
                    selectedRouteId === rt.id ? 'bg-amber-50' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {locNameById.get(rt.fromId) || rt.fromId} -{' '}
                      {locNameById.get(rt.toId) || rt.toId}
                    </div>
                    <div className="text-[10px] text-slate-500 tabular-nums">
                      {rt.length}x · {lc === 1 ? 'Single' : lc === 2 ? 'Double' : 'Triple'} ·{' '}
                      {rt.transportMode}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRoute(rt.id);
                    }}
                    className="p-1 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                    title="Delete route"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Collapsible Step 4 Auto-Conversion Controls at Bottom */}
        <CollapsibleAutoSection
          title="Auto-Convert Game Routes Settings"
          summary={`Adherence ${s4.corridorAdherence}% · Scale ${Math.round(s4.metersPerTrain)}m · Goal ${s4.targetTrainSpaces} cars`}
          defaultOpen={routes.length === 0}
        >
          <SliderWithRange
            label="Corridor Adherence"
            tooltip="Controls how closely auto-converted train routes copy Step 3 map corridor waypoints (90-100% copies exact points; lower simplifies bends)."
            valueLabel={`${s4.corridorAdherence}%`}
            typicalRange="80–100%"
            min={0}
            max={100}
            step={1}
            value={s4.corridorAdherence}
            onChange={(val) => onUpdateStep4Settings({ corridorAdherence: val })}
          />

          <SliderWithRange
            label="Scale Ratio"
            tooltip="Real-world meters represented by 1 train car length. Locking or adjusting this recalculates car counts across all routes."
            valueLabel={`${Math.round(s4.metersPerTrain)} m`}
            typicalRange={`${Math.round(s4.metersPerTrain * 0.8)}–${Math.round(s4.metersPerTrain * 1.25)} m`}
            min={Math.max(40, Math.round(s4.metersPerTrain * 0.4))}
            max={Math.max(400, Math.round(s4.metersPerTrain * 2.2))}
            step={1}
            value={Math.round(s4.metersPerTrain)}
            onChange={(val) =>
              onUpdateStep4Settings({ metersPerTrain: val, strictScale: true })
            }
          />

          <div className="grid grid-cols-2 gap-2">
            <label
              className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer"
              title="Automatically tunes scale ratio toward your Target Car Spaces budget during Rebuild Game Routes"
            >
              <input
                type="checkbox"
                checked={s4.autoAdjustScale && !s4.strictScale}
                onChange={(e) =>
                  onUpdateStep4Settings({
                    autoAdjustScale: e.target.checked,
                    strictScale: !e.target.checked,
                  })
                }
              />
              Auto-fit Scale
            </label>
            <label
              className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer"
              title="Requires at least one endpoint to be a Major Hub before upgrading a route to double or triple lanes"
            >
              <input
                type="checkbox"
                checked={s4.doubleRequiresHub}
                onChange={(e) =>
                  onUpdateStep4Settings({ doubleRequiresHub: e.target.checked })
                }
              />
              Hub for Multi-Lane
            </label>
          </div>

          <SliderWithRange
            label="Target Car Spaces"
            tooltip="Desired total board car-space capacity across the map when Auto-fit Scale is enabled."
            valueLabel={`${s4.targetTrainSpaces}`}
            typicalRange="220–310"
            min={100}
            max={420}
            step={1}
            value={s4.targetTrainSpaces}
            onChange={(val) => onUpdateStep4Settings({ targetTrainSpaces: val })}
          />

          <SliderWithRange
            label="Double-Lane Threshold"
            tooltip="Minimum corridor transit score (+ parallel track evidence) required to make a route double-wide."
            valueLabel={`${s4.doubleThresholdWeight}`}
            typicalRange="68–84"
            min={40}
            max={98}
            step={1}
            value={s4.doubleThresholdWeight}
            onChange={(val) => onUpdateStep4Settings({ doubleThresholdWeight: val })}
          />

          <SliderWithRange
            label="Triple-Lane Threshold"
            tooltip="Minimum corridor transit score required to upgrade a heavy trunk route to triple-wide."
            valueLabel={`${s4.tripleThresholdWeight}`}
            typicalRange="86–96"
            min={70}
            max={100}
            step={1}
            value={s4.tripleThresholdWeight}
            onChange={(val) => onUpdateStep4Settings({ tripleThresholdWeight: val })}
          />

          <SliderWithRange
            label="Max Route Car Length"
            tooltip="Maximum number of car spaces any single route can contain after conversion."
            valueLabel={`${s4.maxRouteLength}`}
            typicalRange="6–9"
            min={6}
            max={15}
            value={s4.maxRouteLength}
            onChange={(val) => onUpdateStep4Settings({ maxRouteLength: val })}
          />

          <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-700">
            <label
              className="flex items-center gap-1.5 cursor-pointer"
              title="Copies tunnel flags from OSM bridge/tunnel corridors"
            >
              <input
                type="checkbox"
                checked={s4.allowTunnels}
                onChange={(e) => onUpdateStep4Settings({ allowTunnels: e.target.checked })}
              />
              Tunnels
            </label>
            <label
              className="flex items-center gap-1.5 cursor-pointer"
              title="Requires wildcard locomotives on ferry routes"
            >
              <input
                type="checkbox"
                checked={s4.allowFerryLocomotives}
                onChange={(e) =>
                  onUpdateStep4Settings({ allowFerryLocomotives: e.target.checked })
                }
              />
              Ferry Locos
            </label>
            <label
              className="flex items-center gap-1.5 cursor-pointer"
              title="Preserves road intersection crossing hazards on bus links"
            >
              <input
                type="checkbox"
                checked={s4.allowBusCrossings}
                onChange={(e) =>
                  onUpdateStep4Settings({ allowBusCrossings: e.target.checked })
                }
              />
              Bus Crossings
            </label>
            <label
              className="flex items-center gap-1.5 cursor-pointer"
              title="Adds maritime shipping hazards to busy ferry corridors"
            >
              <input
                type="checkbox"
                checked={s4.allowShippingHazards}
                onChange={(e) =>
                  onUpdateStep4Settings({ allowShippingHazards: e.target.checked })
                }
              />
              Ship Hazards
            </label>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={onRunStep4Auto}
            title="Re-converts selected Step 3 Map Routes into fresh Train Routes using all settings above"
            className="w-full py-2 px-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Rebuild Game Routes
          </button>
        </CollapsibleAutoSection>
      </div>
    );
  }

  // =========================================================================
  // STEP 5: TICKETS & PUBLISH
  // =========================================================================
  const s5 = pipeline.tickets.settings;
  const tickets = pipeline.tickets.items;
  const rules = normalizeGameRules(board.defaultRules, board);

  return (
    <div className="flex flex-col divide-y divide-slate-200 text-xs text-slate-800">
      <div className="p-4 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Step 5: Tickets & Publish</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {tickets.length} destination tickets · {stats.routesCount} routes
            </p>
          </div>
          <button
            type="button"
            disabled={isSaving || board.routes.length === 0}
            onClick={onSaveToLibrary}
            title="Save this map workspace and finalized board rules to your Board Library"
            className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Save Board
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onSaveToLibrary}
            disabled={isSaving || board.routes.length === 0}
            className="py-1.5 px-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold hover:bg-slate-50 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Sync Library
          </button>
          <button
            type="button"
            onClick={onHostGame}
            disabled={board.routes.length === 0}
            title="Saves and launches a multiplayer game lobby using this board"
            className="py-1.5 px-2.5 rounded-lg bg-emerald-700 text-white font-semibold hover:bg-emerald-800 disabled:opacity-40 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            Host Game
          </button>
        </div>
      </div>

      {/* Board Identity & Baked Game Rules */}
      <div className="p-4 flex flex-col gap-2.5">
        <TooltipLabel
          label="Board Details & Baked Rules"
          tooltip="Sets the display title, visual map styling, and default multiplayer rules packaged with this board."
          className="font-semibold text-slate-900"
        />
        <input
          type="text"
          value={board.name}
          onChange={(e) => onUpdateBoardMeta({ name: e.target.value })}
          placeholder="Board title"
          className="px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs font-medium"
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={board.theme}
            title="Map canvas visual theme"
            onChange={(e) => onUpdateBoardMeta({ theme: e.target.value as BoardTheme })}
            className="px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px]"
          >
            <option value="vintage">Vintage</option>
            <option value="metro">Metro</option>
            <option value="dark">Night Ops</option>
          </select>
          <select
            value={rules.deckBasisEdition}
            title="Card distribution template used for draws"
            onChange={(e) =>
              onUpdateBakedRules({ deckBasisEdition: e.target.value as DeckBasisEdition })
            }
            className="px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px]"
          >
            <option value="USA">Deck: USA</option>
            <option value="Europe">Deck: Europe</option>
            <option value="Germany">Deck: Germany</option>
            <option value="Nordic Countries">Deck: Nordic</option>
            <option value="Board Matched">Deck: Board Matched</option>
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label
            className="flex flex-col gap-0.5 text-[10px] text-slate-600"
            title="Starting pieces given to each player"
          >
            Pieces/Player
            <input
              type="number"
              min={15}
              max={80}
              value={rules.piecesPerPlayer}
              onChange={(e) =>
                onUpdateBakedRules({ piecesPerPlayer: Number(e.target.value) || 45 })
              }
              className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] font-mono-num"
            />
          </label>
          <label
            className="flex flex-col gap-0.5 text-[10px] text-slate-600"
            title="Minimum player count needed before double lanes open up (0 = never)"
          >
            Dual Min P
            <input
              type="number"
              min={0}
              max={6}
              value={rules.doubleRouteMinPlayers}
              onChange={(e) =>
                onUpdateBakedRules({ doubleRouteMinPlayers: Number(e.target.value) })
              }
              className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] font-mono-num"
            />
          </label>
          <label
            className="flex flex-col gap-0.5 text-[10px] text-slate-600"
            title="Station count per player (0 = stations disabled)"
          >
            Stations (0=off)
            <input
              type="number"
              min={0}
              max={10}
              value={rules.stationCount}
              onChange={(e) => {
                const v = Math.max(0, Math.min(10, Number(e.target.value) || 0));
                onUpdateBakedRules({ stationCount: v, stationsEnabled: v > 0 });
              }}
              className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] font-mono-num"
            />
          </label>
        </div>

        <label
          className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer"
          title="Splits player inventory cleanly across Train, Bus, and Ship pieces"
        >
          <input
            type="checkbox"
            checked={rules.splitPiecesEnabled}
            onChange={(e) =>
              onUpdateBakedRules({ splitPiecesEnabled: e.target.checked })
            }
          />
          Split Pieces (Trains / Buses / Ships)
        </label>
      </div>

      {/* Add Manual Ticket + Tickets List */}
      <div className="p-4 flex flex-col gap-2.5">
        <span className="font-semibold text-slate-900">
          Destination Tickets ({tickets.length})
        </span>

        <div className="flex items-center gap-1.5">
          <select
            value={manualTicketFrom}
            onChange={(e) => setManualTicketFrom(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px]"
          >
            <option value="">From stop...</option>
            {activeLocs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <select
            value={manualTicketTo}
            onChange={(e) => setManualTicketTo(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-slate-300 rounded text-[11px]"
          >
            <option value="">To stop...</option>
            {activeLocs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!manualTicketFrom || !manualTicketTo || manualTicketFrom === manualTicketTo}
            title="Create a custom destination ticket and score it from shortest route path"
            onClick={() => {
              onAddManualTicket(manualTicketFrom, manualTicketTo);
              setManualTicketFrom('');
              setManualTicketTo('');
            }}
            className="p-1.5 rounded bg-slate-900 text-white disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
          {tickets.map((t) => (
            <div
              key={t.id}
              onClick={() => onSelectTicketId(selectedTicketId === t.id ? null : t.id)}
              className={`px-2.5 py-1.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 ${
                selectedTicketId === t.id ? 'bg-amber-50' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-900 truncate">
                  {t.fromName} - {t.toName}
                </div>
                <div className="text-[10px] text-slate-500 capitalize">
                  {t.grade || 'standard'} · shortest {t.shortestPathTrains ?? t.points} cars
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="number"
                  min={2}
                  max={35}
                  value={t.points}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onUpdateTicket(t.id, { points: Math.max(2, Number(e.target.value) || 4) })
                  }
                  className="w-12 px-1.5 py-0.5 border border-slate-300 rounded text-center text-[11px] font-mono-num font-bold"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteTicket(t.id);
                  }}
                  className="p-1 text-red-600 hover:bg-red-50 rounded cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Collapsible Auto-Ticket Generator at Bottom */}
      <CollapsibleAutoSection
        title="Auto-Generate Tickets Settings"
        summary={`Count ${s5.targetTicketCount === 0 ? 'Auto' : s5.targetTicketCount} · Min length ${s5.minTicketLength} cars`}
        defaultOpen={tickets.length === 0}
      >
        <SliderWithRange
          label="Ticket Count Goal (0=Auto)"
          tooltip="Number of destination tickets created when running Auto-Generate Tickets. Set to 0 to scale automatically with stop count."
          valueLabel={`${s5.targetTicketCount === 0 ? 'Auto' : s5.targetTicketCount}`}
          typicalRange="0 or 26–42"
          min={0}
          max={70}
          step={1}
          value={s5.targetTicketCount}
          onChange={(val) => onUpdateStep5Settings({ targetTicketCount: val })}
        />

        <SliderWithRange
          label="Min Ticket Length"
          tooltip="Minimum shortest-path car length allowed for generated tickets."
          valueLabel={`${s5.minTicketLength} cars`}
          typicalRange="3–5 cars"
          min={2}
          max={8}
          value={s5.minTicketLength}
          onChange={(val) => onUpdateStep5Settings({ minTicketLength: val })}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRunStep5Auto}
            className="flex-1 py-2 px-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 cursor-pointer"
          >
            Auto-Generate Tickets
          </button>
          <button
            type="button"
            onClick={onRecalculateTickets}
            disabled={tickets.length === 0}
            title="Updates all existing ticket points cleanly against the latest route network"
            className="py-2 px-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
          >
            Recalc Pts
          </button>
        </div>
      </CollapsibleAutoSection>
    </div>
  );
};
