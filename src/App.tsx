import { useEffect, useState } from 'react';
import type {
  BoardDefinition,
  GenerationStageArtifact,
  StudioMapWorkspace,
} from './shared/types';
import {
  createUntitledWorkspace,
  createWorkspaceFromSavedBoard,
  loadActiveClientWorkspace,
  loadClientWorkspaceById,
  saveClientWorkspace,
} from './lib/studioStorage';
import { MapStudio } from './components/MapStudio';
import { BoardLibrary } from './components/BoardLibrary';
import { BenchmarksView } from './components/BenchmarksView';
import { PlayView } from './components/PlayView';

type AppTab = 'editor' | 'library' | 'play' | 'benchmarks';

function parseRouteFromLocation(isolatedPlayOnly: boolean): {
  tab: AppTab;
  roomCode: string | null;
} {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');
  if (isolatedPlayOnly || path.startsWith('/play')) {
    return { tab: 'play', roomCode };
  }
  if (path.startsWith('/library')) return { tab: 'library', roomCode: null };
  if (path.startsWith('/benchmarks')) return { tab: 'benchmarks', roomCode: null };
  return { tab: 'editor', roomCode: null };
}

export default function App() {
  const [serverInfo, setServerInfo] = useState<{
    isolatedPlayOnly: boolean;
    primaryPort: number;
    editorPort?: number | null;
    playPort: number | null;
    geminiAvailable: boolean;
  }>({
    isolatedPlayOnly: false,
    primaryPort: 3000,
    editorPort: 47291,
    playPort: 58413,
    geminiAvailable: false,
  });

  const [tab, setTab] = useState<AppTab>('editor');
  const [boards, setBoards] = useState<BoardDefinition[]>([]);
  const [studioWorkspace, setStudioWorkspace] = useState<StudioMapWorkspace | null>(null);
  const [hostBoardId, setHostBoardId] = useState<string | null>(null);
  const [initialRoomCode, setInitialRoomCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBoards = async () => {
    try {
      const res = await fetch('/api/play/boards');
      const data = await res.json();
      if (Array.isArray(data.boards)) {
        setBoards(data.boards);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    Promise.all([
      fetch('/api/server-info').then((r) => r.json()).catch(() => null),
      fetch('/api/play/boards').then((r) => r.json()).catch(() => null),
      loadActiveClientWorkspace().catch(() => null),
    ]).then(([info, bData, savedActiveWs]) => {
      const isolated = Boolean(info?.isolatedPlayOnly);
      if (info) setServerInfo(info);
      if (Array.isArray(bData?.boards)) {
        setBoards(bData.boards);
      }
      if (savedActiveWs) {
        setStudioWorkspace(savedActiveWs);
      } else {
        const blank = createUntitledWorkspace();
        setStudioWorkspace(blank);
        saveClientWorkspace(blank, true).catch(() => {});
      }
      const route = parseRouteFromLocation(isolated);
      setTab(route.tab);
      setInitialRoomCode(route.roomCode);
      setLoading(false);
    });

    const onPopState = () => {
      const route = parseRouteFromLocation(serverInfo.isolatedPlayOnly);
      setTab(route.tab);
      setInitialRoomCode(route.roomCode);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (nextTab: AppTab) => {
    if (serverInfo.isolatedPlayOnly && nextTab !== 'play') return;
    setTab(nextTab);
    const nextPath =
      nextTab === 'editor'
        ? '/editor'
        : nextTab === 'library'
          ? '/library'
          : nextTab === 'benchmarks'
            ? '/benchmarks'
            : '/play';
    window.history.pushState({}, '', nextPath);
  };

  const handleHostGame = (boardId: string) => {
    setHostBoardId(boardId);
    navigate('play');
  };

  const handleOpenBoardInStudio = async (b: BoardDefinition) => {
    const [localWs, serverWsRes, stagesRes] = await Promise.all([
      loadClientWorkspaceById(b.id).catch(() => null),
      fetch(`/api/boards/${encodeURIComponent(b.id)}/workspace`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`/api/boards/${encodeURIComponent(b.id)}/stages`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const serverWs: StudioMapWorkspace | null = serverWsRes?.workspace || null;
    const stages: GenerationStageArtifact[] = Array.isArray(stagesRes?.stages)
      ? stagesRes.stages
      : [];

    let chosen: StudioMapWorkspace;
    if (localWs && serverWs) {
      const localTs = Date.parse(localWs.lastLocalSaveAt || '') || 0;
      const serverTs = Date.parse(serverWs.lastLocalSaveAt || '') || 0;
      chosen = localTs >= serverTs ? localWs : serverWs;
    } else if (localWs) {
      chosen = localWs;
    } else if (serverWs) {
      chosen = serverWs;
    } else {
      chosen = createWorkspaceFromSavedBoard(b, stages);
    }

    await saveClientWorkspace(chosen, true).catch(() => {});
    setStudioWorkspace(chosen);
    navigate('editor');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F4EFE6] text-[#2C241E] flex items-center justify-center text-sm font-medium">
        Loading Voucher to Transit...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-16 px-6 bg-white border-b border-slate-200 flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => navigate(serverInfo.isolatedPlayOnly ? 'play' : 'editor')}
          className="text-lg font-bold tracking-tight text-slate-900 font-vintage whitespace-nowrap shrink-0 cursor-pointer"
        >
          Voucher to Transit
        </button>

        {/* Zone 2: Clean single-line text nav links */}
        {!serverInfo.isolatedPlayOnly ? (
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => navigate('editor')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'editor' ? 'text-slate-900 underline underline-offset-8' : ''
              }`}
            >
              Map Studio
            </button>
            <button
              type="button"
              onClick={() => {
                fetchBoards();
                navigate('library');
              }}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'library' ? 'text-slate-900 underline underline-offset-8' : ''
              }`}
            >
              Board Library
            </button>
            <button
              type="button"
              onClick={() => navigate('play')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'play' ? 'text-slate-900 underline underline-offset-8' : ''
              }`}
            >
              Play Lobby
            </button>
            <button
              type="button"
              onClick={() => navigate('benchmarks')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'benchmarks' ? 'text-slate-900 underline underline-offset-8' : ''
              }`}
            >
              Benchmarks
            </button>
          </nav>
        ) : (
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <span className="whitespace-nowrap shrink-0">Multiplayer Play Session</span>
          </div>
        )}

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          {tab === 'play' ? (
            !serverInfo.isolatedPlayOnly && (
              <button
                type="button"
                onClick={() => navigate('editor')}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                Open Studio
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={() => navigate('play')}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Play Lobby
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">
        {tab === 'editor' && studioWorkspace && !serverInfo.isolatedPlayOnly && (
          <MapStudio
            initialWorkspace={studioWorkspace}
            geminiAvailable={serverInfo.geminiAvailable}
            editorPort={serverInfo.editorPort}
            playPort={serverInfo.playPort}
            onWorkspaceChange={setStudioWorkspace}
            onBoardSaved={() => {
              fetchBoards();
            }}
            onHostBoard={handleHostGame}
          />
        )}
        {tab === 'library' && !serverInfo.isolatedPlayOnly && (
          <BoardLibrary
            boards={boards}
            onOpenInStudio={handleOpenBoardInStudio}
            onHostGame={handleHostGame}
            onRefreshBoards={fetchBoards}
          />
        )}
        {tab === 'benchmarks' && !serverInfo.isolatedPlayOnly && <BenchmarksView />}
        {tab === 'play' && (
          <PlayView
            initialBoardId={hostBoardId}
            initialRoomCode={initialRoomCode}
            isolatedPlayOnly={serverInfo.isolatedPlayOnly}
            primaryPort={serverInfo.primaryPort}
            playPort={serverInfo.playPort}
          />
        )}
      </main>
    </div>
  );
}
