import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  composeCachedRegionForBbox,
  deleteBoard,
  deleteBoardRulePreset,
  deleteStudioWorkspace,
  findCoveringCachedRegion,
  getBoard,
  getCachedRegion,
  getCacheStats,
  getGenerationStages,
  getStudioWorkspace,
  listAllStudioWorkspaces,
  listBoardRulePresets,
  listBoards,
  listCachedRegions,
  saveBoard,
  saveBoardRulePreset,
  saveCachedRegion,
  saveGenerationStages,
  saveStudioWorkspace,
  seedStarterBoardsIfEmpty,
} from './server/db.ts';
import {
  computeRegionCacheId,
  detectScaleMode,
  discoverAreaDetails,
  enrichLocationsWithGemini,
  fetchCorridorsNearStops,
  fetchRealRegionData,
  geocodePlaceQuery,
  lookupSpotNearby,
  validateBbox,
  warmZoomPyramidCache,
} from './server/osmFetcher.ts';
import {
  generateDestinationTickets,
  generateProceduralBoardWithStages,
} from './server/boardGenerator.ts';
import {
  attachSocket,
  createOrGetRoom,
  detachSocket,
  handleRoomAction,
  joinRoom,
  listActiveRoomsSummary,
} from './server/gameEngine.ts';
import type {
  BoardDefinition,
  BoardTheme,
  GenerationParams,
  StudioMapWorkspace,
} from './src/shared/types.ts';
import { DEFAULT_GENERATION_PARAMS } from './src/shared/benchmarks.ts';

function readCliPortArg(): number | null {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0 && process.argv[idx + 1]) {
    const parsed = Number(process.argv[idx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

const DEFAULT_RANDOM_EDITOR_PORT = 47291;
const DEFAULT_RANDOM_PLAY_PORT = 58413;

const EDITOR_PORT = Number(process.env.EDITOR_PORT) || DEFAULT_RANDOM_EDITOR_PORT;
const PLAY_PORT_RAW = process.env.PLAY_PORT ? Number(process.env.PLAY_PORT) : DEFAULT_RANDOM_PLAY_PORT;
const PLAY_PORT =
  PLAY_PORT_RAW && Number.isFinite(PLAY_PORT_RAW) && PLAY_PORT_RAW !== EDITOR_PORT
    ? PLAY_PORT_RAW
    : DEFAULT_RANDOM_PLAY_PORT;

const CLI_PORT = readCliPortArg();
const PRIMARY_PORT =
  CLI_PORT || (process.env.PORT ? Number(process.env.PORT) : EDITOR_PORT) || 3000;

seedStarterBoardsIfEmpty();

function mountPlayRoutes(app: express.Express, isolatedPlayOnly: boolean) {
  app.get('/api/server-info', (_req, res) => {
    res.json({
      isolatedPlayOnly,
      primaryPort: PRIMARY_PORT,
      editorPort: EDITOR_PORT,
      playPort: PLAY_PORT,
      geminiAvailable: Boolean(
        process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
    });
  });

  app.get('/api/play/boards', (_req, res) => {
    try {
      res.json({ boards: listBoards() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load boards' });
    }
  });

  app.get('/api/play/boards/:boardId/presets', (req, res) => {
    try {
      const boardId = String(req.params.boardId || '');
      res.json({ presets: listBoardRulePresets(boardId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load presets' });
    }
  });

  app.post('/api/play/boards/:boardId/presets', (req, res) => {
    try {
      const boardId = String(req.params.boardId || '');
      const board = getBoard(boardId);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      const { name, rules } = req.body || {};
      const preset = saveBoardRulePreset(boardId, String(name || 'Custom Preset'), rules || {});
      res.json({ preset, presets: listBoardRulePresets(boardId) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to save preset' });
    }
  });

  app.delete('/api/play/boards/:boardId/presets/:presetId', (req, res) => {
    try {
      const boardId = String(req.params.boardId || '');
      const presetId = String(req.params.presetId || '');
      const deleted = deleteBoardRulePreset(boardId, presetId);
      res.json({ deleted, presets: listBoardRulePresets(boardId) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to delete preset' });
    }
  });

  app.get('/api/play/rooms', (_req, res) => {
    try {
      res.json({ rooms: listActiveRoomsSummary() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to list rooms' });
    }
  });

  app.post('/api/play/rooms', (req, res) => {
    try {
      const { roomCode, boardId } = req.body || {};
      const state = createOrGetRoom(
        typeof roomCode === 'string' && roomCode.trim() ? roomCode.trim() : undefined,
        typeof boardId === 'string' ? boardId : undefined
      );
      res.json({ state });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create room' });
    }
  });

  app.post('/api/play/rooms/:code/join', (req, res) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      const { nickname, color, existingPlayerId } = req.body || {};
      const joined = joinRoom(code, String(nickname || 'Player'), color, existingPlayerId);
      res.json(joined);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to join room' });
    }
  });

  app.post('/api/play/rooms/:code/action', (req, res) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      const { playerId, action } = req.body || {};
      const state = handleRoomAction(code, String(playerId || ''), action);
      res.json({ state });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Action rejected' });
    }
  });
}

function mountEditorRoutes(app: express.Express) {
  app.get('/api/geocode', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
      const results = await geocodePlaceQuery(q);
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Geocode lookup failed' });
    }
  });

  app.get('/api/cache', (_req, res) => {
    try {
      res.json({ regions: listCachedRegions(), stats: getCacheStats() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to list cached regions' });
    }
  });

  app.get('/api/cache/:id', (req, res) => {
    const cached = getCachedRegion(req.params.id);
    if (!cached) return res.status(404).json({ error: 'Cached region not found' });
    res.json(cached);
  });

  app.post('/api/pipeline/scan-area', async (req, res) => {
    try {
      const { bbox: rawBbox, zoom, regionLabel, forceRescan } = req.body || {};
      const bbox = validateBbox(rawBbox);
      const safeZoom = Math.max(2, Math.min(18, Number(zoom) || 10));
      const { scaleMode } = detectScaleMode(bbox);
      const label = String(regionLabel || 'Custom Region').trim().slice(0, 60);
      const cacheId = computeRegionCacheId(bbox, scaleMode);

      let cached = !forceRescan ? getCachedRegion(cacheId) : null;
      let fromCache = Boolean(
        cached && cached.dataset.pois.length >= 3 && cached.dataset.corridors.length > 0
      );

      // Upgrade stale OSRM-only caches that previously timed out on Overpass so railways, ferries, bridges, and ports populate
      const isWeakFallbackCache = Boolean(
        cached &&
          cached.dataset.sources?.overpass === false &&
          cached.dataset.corridors.filter((c) => c.mode !== 'highway').length === 0
      );
      if (isWeakFallbackCache) {
        fromCache = false;
      }

      if (!cached || !fromCache) {
        const covering = !forceRescan ? findCoveringCachedRegion(bbox, scaleMode, true) : null;
        if (
          covering &&
          !(
            covering.dataset.sources?.overpass === false &&
            covering.dataset.corridors.filter((c) => c.mode !== 'highway').length === 0
          )
        ) {
          cached = covering;
          fromCache = true;
        } else if (!forceRescan && !isWeakFallbackCache) {
          const composed = composeCachedRegionForBbox(bbox, scaleMode, safeZoom);
          if (composed) {
            cached = composed;
            fromCache = true;
          }
        }
      }

      if (!cached || !fromCache) {
        try {
          const dataset = await fetchRealRegionData(bbox, safeZoom);
          if (dataset.pois.length >= 3) {
            const summary = saveCachedRegion(cacheId, label, dataset, false);
            cached = { summary, dataset };
          } else if (!cached) {
            throw new Error('Scan returned too few valid stops for this region.');
          }
        } catch (fetchErr) {
          if (!cached) throw fetchErr;
        }
      }

      setImmediate(() => {
        void warmZoomPyramidCache(bbox, safeZoom, label);
      });

      res.json({
        cacheSummary: cached!.summary,
        dataset: cached!.dataset,
        fromCache,
        zoomWarmStarted: true,
        cacheStats: getCacheStats(),
        sources: cached!.dataset.sources,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to scan region data' });
    }
  });

  app.post('/api/pipeline/polish-locations', async (req, res) => {
    try {
      const { regionLabel, pois } = req.body || {};
      if (!Array.isArray(pois) || pois.length === 0) {
        return res.status(400).json({ error: 'POIs array required.' });
      }
      const adj = await enrichLocationsWithGemini(String(regionLabel || 'Region'), pois);
      const adjustments = Array.from(adj.entries()).map(([id, val]) => ({ id, ...val }));
      res.json({ adjustments });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'AI location polish failed' });
    }
  });

  /**
   * POST /api/pipeline/discover-area
   * Scans a small user-dragged Step 2 discovery box for stations, ferry landings, towns, and multimodal hubs.
   */
  app.post('/api/pipeline/discover-area', async (req, res) => {
    try {
      const { bbox: rawBbox, zoom, existingCorridors } = req.body || {};
      const bbox = validateBbox(rawBbox);
      const safeZoom = Math.max(2, Math.min(18, Number(zoom) || 12));
      const result = await discoverAreaDetails(
        bbox,
        safeZoom,
        Array.isArray(existingCorridors) ? existingCorridors : []
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to discover area stops' });
    }
  });

  /**
   * POST /api/pipeline/lookup-spot
   * Reverse-queries OSM Overpass/Photon/Nominatim around a clicked coordinate when placing a manual stop.
   */
  app.post('/api/pipeline/lookup-spot', async (req, res) => {
    try {
      const { lat, lng, zoom, datasetCorridors, existingPois } = req.body || {};
      const numLat = Number(lat);
      const numLng = Number(lng);
      if (!Number.isFinite(numLat) || !Number.isFinite(numLng) || numLat < -85 || numLat > 85 || numLng < -180 || numLng > 180) {
        return res.status(400).json({ error: 'Valid lat/lng coordinates required.' });
      }
      const safeZoom = Math.max(2, Math.min(18, Number(zoom) || 12));
      const matches = await lookupSpotNearby(
        numLat,
        numLng,
        safeZoom,
        Array.isArray(datasetCorridors) ? datasetCorridors : [],
        Array.isArray(existingPois) ? existingPois : []
      );
      res.json({ matches });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Spot lookup failed' });
    }
  });

  /**
   * POST /api/pipeline/corridors-near-stops
   * Queries Overpass for railways, ferries, and highways near added or edited Step 2 stops,
   * and supplements neighbor and explicit stop pairs with OSRM road geometry.
   */
  app.post('/api/pipeline/corridors-near-stops', async (req, res) => {
    try {
      const { stops, allActiveStops, pairs, bbox: rawBbox, zoom } = req.body || {};
      const bbox = validateBbox(rawBbox);
      const safeZoom = Math.max(2, Math.min(18, Number(zoom) || 11));
      const safeStops = Array.isArray(stops) ? stops : [];
      const safePairs = Array.isArray(pairs) ? pairs : [];
      if (safeStops.length === 0 && safePairs.length === 0) {
        return res.json({ corridors: [] });
      }
      const corridors = await fetchCorridorsNearStops(
        safeStops,
        bbox,
        safeZoom,
        Array.isArray(allActiveStops) ? allActiveStops : undefined,
        safePairs.length > 0 ? safePairs : undefined
      );
      res.json({ corridors });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to refresh corridors near stops' });
    }
  });

  app.get('/api/workspaces', (_req, res) => {
    try {
      res.json({ workspaces: listAllStudioWorkspaces() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to list studio workspaces' });
    }
  });

  app.delete('/api/workspaces/:id', (req, res) => {
    try {
      const deleted = deleteStudioWorkspace(String(req.params.id || ''));
      res.json({ deleted });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to delete studio workspace' });
    }
  });

  app.post('/api/boards/scan', async (req, res) => {
    try {
      const {
        bbox: rawBbox,
        zoom,
        regionLabel,
        boardName,
        theme,
        params,
        lockedMetersPerTrain,
        strictScale,
      } = req.body || {};
      const bbox = validateBbox(rawBbox);
      const safeZoom = Math.max(2, Math.min(18, Number(zoom) || 10));
      const { scaleMode } = detectScaleMode(bbox);
      const genParams: GenerationParams = {
        ...DEFAULT_GENERATION_PARAMS,
        ...(params || {}),
      };
      const label = String(regionLabel || 'Custom Region').trim().slice(0, 60);
      const cacheId = computeRegionCacheId(bbox, scaleMode);

      let cached = getCachedRegion(cacheId);
      let fromCache = Boolean(
        cached && cached.dataset.pois.length >= 3 && cached.dataset.corridors.length > 0
      );
      if (!cached || !fromCache) {
        const covering = findCoveringCachedRegion(bbox, scaleMode, true);
        if (covering) {
          cached = covering;
          fromCache = true;
        } else {
          const composed = composeCachedRegionForBbox(bbox, scaleMode, safeZoom);
          if (composed) {
            cached = composed;
            fromCache = true;
          }
        }
      }
      if (!cached || !fromCache) {
        const dataset = await fetchRealRegionData(bbox, safeZoom);
        if (dataset.pois.length >= 3) {
          const summary = saveCachedRegion(cacheId, label, dataset, false);
          cached = { summary, dataset };
        } else {
          throw new Error('Scan returned too few valid stops for this region.');
        }
      }

      // Automatically warm local multi-zoom pyramid (-1 out to +2 in) in the background
      setImmediate(() => {
        void warmZoomPyramidCache(bbox, safeZoom, label);
      });

      const aiAdjustments = genParams.useAiEnrichment
        ? await enrichLocationsWithGemini(label, cached.dataset.pois)
        : undefined;

      const { board, stages } = generateProceduralBoardWithStages({
        name: String(boardName || `${label} Transit`).slice(0, 60),
        regionLabel: label,
        theme: (theme as BoardTheme) || 'vintage',
        cacheId: cached.summary.id,
        dataset: cached.dataset,
        activeBbox: bbox,
        lockedMetersPerTrain:
          typeof lockedMetersPerTrain === 'number' && lockedMetersPerTrain > 0
            ? lockedMetersPerTrain
            : undefined,
        strictScale: Boolean(strictScale),
        params: genParams,
        aiAdjustments,
      });

      saveGenerationStages(board.id, stages);
      res.json({
        board,
        cacheSummary: cached.summary,
        stages,
        fromCache,
        zoomWarmStarted: true,
        cacheStats: getCacheStats(),
        sources: cached.dataset.sources,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to scan region and generate board' });
    }
  });

  app.post('/api/boards/regenerate', async (req, res) => {
    try {
      const {
        cacheId,
        boardId,
        boardName,
        regionLabel,
        theme,
        params,
        bbox: rawBbox,
        lockedMetersPerTrain,
        strictScale,
      } = req.body || {};
      const cached = getCachedRegion(String(cacheId || ''));
      if (!cached) {
        return res.status(404).json({ error: 'Cached region dataset not found. Scan viewport first.' });
      }
      const activeBbox = rawBbox ? validateBbox(rawBbox) : cached.dataset.bbox;
      const genParams: GenerationParams = {
        ...DEFAULT_GENERATION_PARAMS,
        ...(params || {}),
      };
      const label = String(regionLabel || cached.summary.name).slice(0, 60);
      const aiAdjustments = genParams.useAiEnrichment
        ? await enrichLocationsWithGemini(label, cached.dataset.pois)
        : undefined;

      const { board, stages } = generateProceduralBoardWithStages({
        boardId: typeof boardId === 'string' ? boardId : undefined,
        name: String(boardName || `${label} Transit`).slice(0, 60),
        regionLabel: label,
        theme: (theme as BoardTheme) || 'vintage',
        cacheId: cached.summary.id,
        dataset: cached.dataset,
        activeBbox,
        lockedMetersPerTrain:
          typeof lockedMetersPerTrain === 'number' && lockedMetersPerTrain > 0
            ? lockedMetersPerTrain
            : undefined,
        strictScale: Boolean(strictScale),
        params: genParams,
        aiAdjustments,
      });

      saveGenerationStages(board.id, stages);
      res.json({ board, cacheSummary: cached.summary, stages });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to regenerate from cache' });
    }
  });

  app.post('/api/boards/rebuild-tickets', (req, res) => {
    try {
      const { locations, routes } = req.body || {};
      if (!Array.isArray(locations) || !Array.isArray(routes)) {
        return res.status(400).json({ error: 'Locations and routes arrays are required.' });
      }
      const tickets = generateDestinationTickets(locations, routes);
      res.json({ tickets });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to rebuild tickets' });
    }
  });

  app.get('/api/boards', (_req, res) => {
    try {
      res.json({ boards: listBoards() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to list boards' });
    }
  });

  app.get('/api/boards/:id/stages', (req, res) => {
    try {
      const stages = getGenerationStages(req.params.id) || [];
      res.json({ stages });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load generation stages' });
    }
  });

  app.get('/api/boards/:id/workspace', (req, res) => {
    try {
      const workspace = getStudioWorkspace(req.params.id);
      res.json({ workspace });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load studio workspace' });
    }
  });

  app.put('/api/boards/:id/workspace', (req, res) => {
    try {
      const boardId = String(req.params.id || '');
      const workspace = req.body?.workspace as StudioMapWorkspace | undefined;
      if (!boardId || !workspace) {
        return res.status(400).json({ error: 'Workspace payload required.' });
      }
      saveStudioWorkspace(boardId, { ...workspace, id: boardId });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save studio workspace' });
    }
  });

  app.get('/api/boards/:id', (req, res) => {
    const board = getBoard(req.params.id);
    if (!board) return res.status(404).json({ error: 'Board not found' });
    res.json({ board });
  });

  app.post('/api/boards', (req, res) => {
    try {
      const incoming = req.body?.board as BoardDefinition;
      if (!incoming || !incoming.name || !Array.isArray(incoming.locations) || !Array.isArray(incoming.routes)) {
        return res.status(400).json({ error: 'Invalid board payload.' });
      }
      const saved = saveBoard({
        ...incoming,
        id: incoming.id || `board-${crypto.randomBytes(4).toString('hex')}`,
        tickets:
          Array.isArray(incoming.tickets) && incoming.tickets.length > 0
            ? incoming.tickets
            : generateDestinationTickets(incoming.locations, incoming.routes),
      });
      res.json({ board: saved });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save board' });
    }
  });

  app.delete('/api/boards/:id', (req, res) => {
    const deleted = deleteBoard(req.params.id);
    res.json({ deleted });
  });
}

function attachPlayWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });
  const hmrDisabled = process.env.DISABLE_HMR === 'true';
  const noopViteWss = hmrDisabled
    ? new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has('vite-hmr') ? 'vite-hmr' : false),
      })
    : null;

  if (noopViteWss) {
    noopViteWss.on('connection', (ws) => {
      try {
        ws.send(JSON.stringify({ type: 'connected' }));
      } catch {
        // Ignore closed socket on initial greet
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === 'ping' && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // Ignore non-JSON pings
        }
      });
    });
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws/play') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }

    // When HMR is disabled in AI Studio preview, accept @vite/client's upgrade silently
    // so the browser console doesn't throw a WebSocket connection error.
    if (noopViteWss && request.headers['sec-websocket-protocol']?.includes('vite-hmr')) {
      noopViteWss.handleUpgrade(request, socket, head, (ws) => {
        noopViteWss.emit('connection', ws, request);
      });
      return;
    }
  });

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const roomCode = (url.searchParams.get('room') || '').toUpperCase();
    const playerId = url.searchParams.get('playerId') || '';

    if (roomCode && playerId) {
      attachSocket(roomCode, playerId, ws);
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'action' && roomCode && playerId) {
          handleRoomAction(roomCode, playerId, msg.action);
        }
      } catch (err: any) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Invalid action' }));
        }
      }
    });

    ws.on('close', () => {
      if (roomCode && playerId) {
        detachSocket(roomCode, playerId, ws);
      }
    });
  });
}

async function startServer() {
  const primaryApp = express();
  primaryApp.use(express.json({ limit: '25mb' }));
  const primaryHttp = http.createServer(primaryApp);

  mountPlayRoutes(primaryApp, false);
  mountEditorRoutes(primaryApp);

  const isProd = process.env.NODE_ENV === 'production';
  const hmrDisabled = process.env.DISABLE_HMR === 'true';
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;
  let cachedPatchedViteClient: string | null = null;

  /**
   * Express middleware that intercepts GET /@vite/client when DISABLE_HMR=true so Vite 8's
   * hardcoded `const hmrPort = 24678` fallback is replaced with `null` (connecting over the
   * proxied origin port where noopViteWss accepts the handshake without WebSocket errors).
   */
  const mountViteWithCleanClient = (targetApp: express.Express) => {
    if (!viteServer) return;
    if (hmrDisabled) {
      targetApp.get('/@vite/client', async (_req, res, next) => {
        try {
          if (!cachedPatchedViteClient && viteServer) {
            const transformed = await viteServer.transformRequest('/@vite/client');
            if (transformed?.code) {
              cachedPatchedViteClient = transformed.code.replace(
                /const hmrPort = \d+;/g,
                'const hmrPort = null;'
              );
            }
          }
          if (cachedPatchedViteClient) {
            res.status(200).type('application/javascript').send(cachedPatchedViteClient);
            return;
          }
        } catch {
          // Fall through to standard Vite middleware
        }
        next();
      });
    }
    targetApp.use(viteServer.middlewares);
  };

  if (!isProd) {
    viteServer = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: primaryHttp },
      },
      appType: 'spa',
    });
    mountViteWithCleanClient(primaryApp);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    primaryApp.use(express.static(distDir));
    primaryApp.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  attachPlayWebSocket(primaryHttp);

  primaryHttp.listen(PRIMARY_PORT, '0.0.0.0', () => {
    console.log(`Voucher to Transit Primary Server running at http://0.0.0.0:${PRIMARY_PORT}`);
  });

  // Dedicated random Editor port (when platform/preview uses a separate PRIMARY_PORT like 3000)
  if (EDITOR_PORT && EDITOR_PORT !== PRIMARY_PORT && EDITOR_PORT !== PLAY_PORT) {
    const editorHttp = http.createServer(primaryApp);
    attachPlayWebSocket(editorHttp);
    editorHttp.on('error', (err) => {
      console.warn(`Could not bind dedicated Editor port ${EDITOR_PORT}:`, err.message);
    });
    editorHttp.listen(EDITOR_PORT, '0.0.0.0', () => {
      console.log(`Voucher to Transit Dedicated Editor running at http://0.0.0.0:${EDITOR_PORT}`);
    });
  }

  // Dedicated random Public-Facing Play-only server on PLAY_PORT for safe port-forwarding
  if (PLAY_PORT && PLAY_PORT !== PRIMARY_PORT) {
    const playApp = express();
    playApp.use(express.json({ limit: '2mb' }));
    mountPlayRoutes(playApp, true);

    // Block editor API endpoints explicitly on the port-forwarded Play server
    playApp.all(['/api/boards*', '/api/cache*', '/api/geocode*', '/api/pipeline*', '/api/workspaces*'], (_req, res) => {
      res.status(403).json({ error: 'Studio editor endpoints are restricted to the local host port.' });
    });

    if (viteServer) {
      mountViteWithCleanClient(playApp);
    } else {
      const distDir = path.resolve(process.cwd(), 'dist');
      playApp.use(express.static(distDir));
      playApp.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }

    const playHttp = http.createServer(playApp);
    attachPlayWebSocket(playHttp);
    playHttp.on('error', (err) => {
      console.warn(`Could not bind dedicated Public Play port ${PLAY_PORT}:`, err.message);
    });
    playHttp.listen(PLAY_PORT, '0.0.0.0', () => {
      console.log(`Voucher to Transit Public Play Server running at http://0.0.0.0:${PLAY_PORT}`);
    });
  }
}

startServer().catch((err) => {
  console.error('Failed to start Voucher to Transit server:', err);
  process.exit(1);
});
