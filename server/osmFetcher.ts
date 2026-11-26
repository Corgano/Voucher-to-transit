import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import type { BoundingBox, ScaleMode, SpotLookupMatch, TransportMode } from '../src/shared/types.ts';
import {
  findCoveringCachedRegion,
  getCachedRegion,
  getProviderCache,
  saveCachedRegion,
  saveProviderCache,
  type RawHazardZone,
  type RawOsmPoi,
  type RawRegionDataset,
  type RawRegionSources,
  type RawTransitCorridor,
} from './db.ts';

/**
 * Debug logging level for server/osmFetcher:
 * 0 = errors only, 1 = major steps, 2 = light debug, 3 = detailed debug, 4 = full console spam.
 */
const OSM_FETCHER_DEBUG_LEVEL = 0;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const USER_AGENT = 'VoucherToTransit/1.0 (self-hosted procedural board studio)';

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function makeBboxCacheKey(bbox: BoundingBox, scaleMode: ScaleMode): string {
  return `${bbox.south.toFixed(3)}:${bbox.west.toFixed(3)}:${bbox.north.toFixed(3)}:${bbox.east.toFixed(3)}:${scaleMode}`;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

export function detectScaleMode(bbox: BoundingBox): { scaleMode: ScaleMode; diagKm: number } {
  const diagKm = haversineKm(bbox.south, bbox.west, bbox.north, bbox.east);
  if (diagKm > 200) return { scaleMode: 'macro', diagKm };
  if (diagKm > 25) return { scaleMode: 'metro', diagKm };
  return { scaleMode: 'city', diagKm };
}

export function validateBbox(bbox: BoundingBox): BoundingBox {
  const south = Number(bbox.south);
  const west = Number(bbox.west);
  const north = Number(bbox.north);
  const east = Number(bbox.east);
  if (
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east) ||
    south >= north ||
    west >= east ||
    south < -85 ||
    north > 85 ||
    west < -180 ||
    east > 180
  ) {
    throw new Error('Invalid geographic bounding box coordinates.');
  }
  return { south, west, north, east };
}

export function computeRegionCacheId(bbox: BoundingBox, scaleMode: ScaleMode): string {
  return `reg-${crypto
    .createHash('sha1')
    .update(
      `${bbox.south.toFixed(3)}:${bbox.west.toFixed(3)}:${bbox.north.toFixed(3)}:${bbox.east.toFixed(3)}:${scaleMode}`
    )
    .digest('hex')
    .slice(0, 10)}`;
}

export function scaleBoundingBox(bbox: BoundingBox, linearFactor: number): BoundingBox {
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLng = (bbox.west + bbox.east) / 2;
  const halfLat = Math.max(0.001, ((bbox.north - bbox.south) / 2) * linearFactor);
  const halfLng = Math.max(0.001, ((bbox.east - bbox.west) / 2) * linearFactor);
  const south = Math.max(-84.5, centerLat - halfLat);
  const north = Math.min(84.5, centerLat + halfLat);
  const west = Math.max(-179.5, centerLng - halfLng);
  const east = Math.min(179.5, centerLng + halfLng);
  return {
    south: Math.min(south, north - 0.002),
    north: Math.max(north, south + 0.002),
    west: Math.min(west, east - 0.002),
    east: Math.max(east, west + 0.002),
  };
}

/**
 * Builds an Overpass QL bounding-box query tuned to macro, metro, or city scale.
 * Explicitly includes ferry ways/relations and ferry terminals across all scales so maritime links are never omitted.
 * Call with validated bbox and scaleMode.
 * Returns Overpass QL query string.
 */
function buildOverpassQuery(bbox: BoundingBox, scaleMode: ScaleMode): string {
  const b = `${bbox.south.toFixed(4)},${bbox.west.toFixed(4)},${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`;

  if (scaleMode === 'macro') {
    return `
      [out:json][timeout:16];
      (
        node["place"~"^(city|town)$"](${b});
        node["aeroway"="aerodrome"]["iata"](${b});
        node["railway"~"^(station|halt)$"](${b});
        node["amenity"~"^(ferry_terminal|bus_station)$"](${b});
        way["railway"~"^(rail|highspeed)$"](${b});
        way["route"="ferry"](${b});
        relation["route"~"^(train|ferry)$"](${b});
        way["highway"~"^(motorway|trunk)$"](${b});
        way["highway"="primary"]["bridge"="yes"](${b});
        node["seamark:type"~"^(wreck|rock|obstruction)$"](${b});
        way["tunnel"="yes"]["railway"](${b});
      );
      out body geom 2000;
    `;
  }

  if (scaleMode === 'metro') {
    return `
      [out:json][timeout:16];
      (
        node["place"~"^(city|town|suburb|borough)$"](${b});
        node["railway"~"^(station|halt)$"](${b});
        node["aeroway"="aerodrome"]["iata"](${b});
        node["tourism"~"^(attraction|museum|theme_park|zoo)$"]["wikipedia"](${b});
        node["amenity"~"^(ferry_terminal|bus_station)$"](${b});
        way["railway"~"^(rail|subway|light_rail|tram)$"](${b});
        relation["route"~"^(train|subway|light_rail|ferry)$"](${b});
        way["route"="ferry"](${b});
        way["highway"~"^(motorway|trunk)$"](${b});
        way["highway"="primary"]["bridge"="yes"](${b});
        node["seamark:type"~"^(wreck|rock|obstruction)$"](${b});
      );
      out body geom 2100;
    `;
  }

  // City / District zoom: prioritize landmarks, transit stations, ferry terminals, bus/tram/metro relations & road intersections
  return `
    [out:json][timeout:16];
    (
      node["tourism"~"^(attraction|museum|viewpoint|gallery|theme_park|zoo)$"](${b});
      node["historic"~"^(monument|castle|memorial|landmark|ruins)$"](${b});
      node["railway"~"^(station|subway_entrance|tram_stop|halt)$"](${b});
      node["amenity"~"^(ferry_terminal|bus_station|university|theatre|arts_centre|marketplace)$"](${b});
      node["leisure"~"^(park|stadium)$"]["name"](${b});
      way["tourism"~"^(attraction|museum)$"]["name"](${b});
      relation["route"~"^(subway|tram|bus|trolleybus|ferry|train|light_rail)$"](${b});
      way["route"="ferry"](${b});
      way["railway"~"^(subway|light_rail|tram|rail)$"](${b});
      way["highway"~"^(primary|secondary|trunk|motorway)$"](${b});
      node["highway"="traffic_signals"](${b});
    );
    out body geom 2200;
  `;
}

/**
 * Compact Overpass backbone fallback omitting suburbs, tourism nodes, and minor roads
 * so wide regions reliably fetch railways, ferries, terminals, stations, and trunk highways even under mirror load.
 */
function buildLightweightTransitOverpassQuery(bbox: BoundingBox): string {
  const b = `${bbox.south.toFixed(4)},${bbox.west.toFixed(4)},${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`;
  return `
    [out:json][timeout:12];
    (
      node["place"~"^(city|town)$"](${b});
      node["railway"~"^(station|halt)$"](${b});
      node["amenity"~"^(ferry_terminal|bus_station)$"](${b});
      way["railway"~"^(rail|highspeed|subway|light_rail)$"](${b});
      way["route"="ferry"](${b});
      relation["route"~"^(train|ferry|light_rail)$"](${b});
      way["highway"~"^(motorway|trunk)$"](${b});
    );
    out body geom 1600;
  `;
}

function isValidOverpassResult(json: any): boolean {
  if (!json || !Array.isArray(json.elements) || json.elements.length === 0) return false;
  const remark = typeof json.remark === 'string' ? json.remark.toLowerCase() : '';
  if (remark.includes('timed out') || remark.includes('runtime error')) return false;
  return true;
}

async function runOverpassMirrorRace(query: string, timeoutMs: number): Promise<{ elements: any[] } | null> {
  try {
    const winner = await Promise.any(
      OVERPASS_ENDPOINTS.map(async (endpoint) => {
        const json = await fetchJsonWithTimeout(
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': USER_AGENT,
            },
            body: `data=${encodeURIComponent(query)}`,
          },
          timeoutMs
        );
        if (!isValidOverpassResult(json)) {
          throw new Error('Empty or incomplete Overpass payload');
        }
        return { elements: json.elements as any[] };
      })
    );
    return winner && winner.elements.length > 0 ? winner : null;
  } catch {
    return null;
  }
}

async function fetchOverpassCached(
  bbox: BoundingBox,
  scaleMode: ScaleMode
): Promise<{ elements: any[] } | null> {
  const cacheKey = makeBboxCacheKey(bbox, scaleMode);
  const cached = getProviderCache<{ elements: any[] }>('overpass', cacheKey);
  if (cached && Array.isArray(cached.elements) && cached.elements.length > 0) {
    return cached;
  }

  let winner = await runOverpassMirrorRace(buildOverpassQuery(bbox, scaleMode), 14000);
  if (!winner && scaleMode !== 'city') {
    winner = await runOverpassMirrorRace(buildLightweightTransitOverpassQuery(bbox), 11000);
  }

  if (winner && winner.elements.length > 0) {
    saveProviderCache('overpass', cacheKey, winner, bbox, winner.elements.length);
    return winner;
  }

  return null;
}

interface WikiPlace {
  title: string;
  lat: number;
  lng: number;
  sitelinks: number;
}

// Multi-point Wikipedia GeoSearch + langlinks popularity, validated and cached per box
async function fetchWikipediaHotspots(
  bbox: BoundingBox,
  diagKm: number,
  scaleMode: ScaleMode
): Promise<WikiPlace[]> {
  const cacheKey = makeBboxCacheKey(bbox, scaleMode);
  const cached = getProviderCache<WikiPlace[]>('wikipedia', cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  try {
    const latSpan = bbox.north - bbox.south;
    const lngSpan = bbox.east - bbox.west;
    const centerLat = (bbox.south + bbox.north) / 2;
    const centerLng = (bbox.west + bbox.east) / 2;

    // Sample center + 4 quadrant points when box diagonal > 18km so wide regions get full geographic coverage
    const sampleCoords =
      diagKm > 18
        ? [
            { lat: centerLat, lng: centerLng },
            { lat: bbox.south + latSpan * 0.28, lng: bbox.west + lngSpan * 0.28 },
            { lat: bbox.south + latSpan * 0.28, lng: bbox.west + lngSpan * 0.72 },
            { lat: bbox.south + latSpan * 0.72, lng: bbox.west + lngSpan * 0.28 },
            { lat: bbox.south + latSpan * 0.72, lng: bbox.west + lngSpan * 0.72 },
          ]
        : [{ lat: centerLat, lng: centerLng }];

    const radiusMeters = Math.min(10000, Math.max(1200, Math.round((diagKm * 1000) / 2)));

    const geoResponses = await Promise.allSettled(
      sampleCoords.map(async (pt) => {
        const geoUrl = new URL('https://en.wikipedia.org/w/api.php');
        geoUrl.searchParams.set('action', 'query');
        geoUrl.searchParams.set('list', 'geosearch');
        geoUrl.searchParams.set('gscoord', `${pt.lat.toFixed(5)}|${pt.lng.toFixed(5)}`);
        geoUrl.searchParams.set('gsradius', String(radiusMeters));
        geoUrl.searchParams.set('gslimit', '40');
        geoUrl.searchParams.set('format', 'json');
        return fetchJsonWithTimeout(
          geoUrl.toString(),
          { headers: { 'User-Agent': USER_AGENT } },
          7500
        );
      })
    );

    const dedup = new Map<number, any>();
    for (const r of geoResponses) {
      if (r.status !== 'fulfilled') continue;
      const list: any[] = r.value?.query?.geosearch ?? [];
      for (const item of list) {
        if (
          typeof item?.pageid === 'number' &&
          item.lat >= bbox.south &&
          item.lat <= bbox.north &&
          item.lon >= bbox.west &&
          item.lon <= bbox.east &&
          !dedup.has(item.pageid)
        ) {
          dedup.set(item.pageid, item);
        }
      }
    }

    const list = Array.from(dedup.values());
    if (list.length === 0) return [];

    // Fetch langlinks count (number of language Wikipedias) in batches of 50 as popularity proxy
    const pages: Record<string, any> = {};
    for (let i = 0; i < Math.min(list.length, 100); i += 50) {
      const pageIds = list
        .slice(i, i + 50)
        .map((item) => item.pageid)
        .join('|');
      try {
        const infoUrl = new URL('https://en.wikipedia.org/w/api.php');
        infoUrl.searchParams.set('action', 'query');
        infoUrl.searchParams.set('pageids', pageIds);
        infoUrl.searchParams.set('prop', 'langlinks');
        infoUrl.searchParams.set('lllimit', '500');
        infoUrl.searchParams.set('format', 'json');
        const infoJson = await fetchJsonWithTimeout(
          infoUrl.toString(),
          { headers: { 'User-Agent': USER_AGENT } },
          7000
        );
        Object.assign(pages, infoJson?.query?.pages ?? {});
      } catch {
        // continue with base sitelink=1 if langlinks call fails
      }
    }

    const places: WikiPlace[] = list
      .map((item) => {
        const p = pages[String(item.pageid)];
        const sitelinks = Array.isArray(p?.langlinks) ? p.langlinks.length + 1 : 1;
        return {
          title: String(item.title),
          lat: Number(item.lat),
          lng: Number(item.lon),
          sitelinks,
        };
      })
      .sort((a, b) => b.sitelinks - a.sitelinks);

    if (places.length > 0) {
      saveProviderCache('wikipedia', cacheKey, places, bbox, places.length);
    }
    return places;
  } catch {
    return [];
  }
}

interface WikidataPoiCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  sitelinks: number;
  population?: number;
}

// Wikidata SPARQL bounding-box lookup: covers full bbox at any scale cleanly!
async function fetchWikidataBoxPois(
  bbox: BoundingBox,
  scaleMode: ScaleMode
): Promise<WikidataPoiCandidate[]> {
  const cacheKey = makeBboxCacheKey(bbox, scaleMode);
  const cached = getProviderCache<WikidataPoiCandidate[]>('wikidata', cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  try {
    const minSitelinks = scaleMode === 'macro' ? 12 : scaleMode === 'metro' ? 4 : 2;
    const sparql = `SELECT ?item ?itemLabel ?coord ?pop ?sitelinks WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${bbox.west.toFixed(4)} ${bbox.south.toFixed(4)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${bbox.east.toFixed(4)} ${bbox.north.toFixed(4)})"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  OPTIONAL { ?item wdt:P1082 ?pop . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} ORDER BY DESC(?sitelinks) LIMIT 90`;

    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const json = await fetchJsonWithTimeout(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/sparql-results+json',
        },
      },
      9500
    );

    const bindings: any[] = json?.results?.bindings ?? [];
    if (!Array.isArray(bindings) || bindings.length === 0) return [];

    const NON_PLACE_RE = /\b(arch)?diocese\b|\bparish\b|\bpresbytery\b|\bsynod\b|\belection\b|\bcup\b|\bchampionship\b|\btournament\b|\bautonomous zone\b|\bmassacre\b|^\d{4}\s/i;
    const out: WikidataPoiCandidate[] = [];
    const seenNames = new Set<string>();
    for (const row of bindings) {
      const wkt = String(row?.coord?.value || '');
      const m = wkt.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/i);
      const name = String(row?.itemLabel?.value || '').trim();
      if (!m || !name || /^Q\d+$/.test(name) || NON_PLACE_RE.test(name)) continue;
      const lng = Number(m[1]);
      const lat = Number(m[2]);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < bbox.south ||
        lat > bbox.north ||
        lng < bbox.west ||
        lng > bbox.east
      ) {
        continue;
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const qid = String(row?.item?.value || '').split('/').pop() || `${lat}-${lng}`;
      out.push({
        id: `wd-${qid}`,
        name,
        lat,
        lng,
        sitelinks: Number(row?.sitelinks?.value || 5),
        population: row?.pop?.value ? Number(row.pop.value) || undefined : undefined,
      });
    }

    if (out.length > 0) {
      saveProviderCache('wikidata', cacheKey, out, bbox, out.length);
    }
    return out;
  } catch {
    return [];
  }
}

// Photon OSM POI query (places + stations + ferries inside bbox) cached per box
async function fetchPhotonBoxPois(
  bbox: BoundingBox,
  scaleMode: ScaleMode
): Promise<RawOsmPoi[]> {
  const cacheKey = makeBboxCacheKey(bbox, scaleMode);
  const cached = getProviderCache<RawOsmPoi[]>('photon', cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  try {
    const centerLat = (bbox.south + bbox.north) / 2;
    const centerLng = (bbox.west + bbox.east) / 2;
    const bboxParam = `${bbox.west.toFixed(4)},${bbox.south.toFixed(4)},${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`;
    const queries =
      scaleMode === 'macro'
        ? [
            `q=station&osm_tag=railway:station`,
            `q=ferry&osm_tag=amenity:ferry_terminal`,
            `q=city&osm_tag=place:city`,
          ]
        : [
            `q=station&osm_tag=railway:station`,
            `q=ferry&osm_tag=amenity:ferry_terminal`,
            `q=terminal&osm_tag=amenity:ferry_terminal`,
            `q=transit&osm_tag=amenity:bus_station`,
            `q=town&osm_tag=place:town&osm_tag=place:city`,
          ];

    const responses = await Promise.allSettled(
      queries.map((qs) =>
        fetchJsonWithTimeout(
          `https://photon.komoot.io/api/?${qs}&bbox=${bboxParam}&lat=${centerLat.toFixed(4)}&lon=${centerLng.toFixed(4)}&limit=30`,
          { headers: { 'User-Agent': USER_AGENT } },
          7000
        )
      )
    );

    const out: RawOsmPoi[] = [];
    const seen = new Set<string>();
    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const features: any[] = r.value?.features ?? [];
      for (const f of features) {
        const coords = f?.geometry?.coordinates;
        const props = f?.properties || {};
        const name = String(props.name || '').trim();
        if (!Array.isArray(coords) || coords.length < 2 || !name) continue;
        const lng = Number(coords[0]);
        const lat = Number(coords[1]);
        if (
          lat < bbox.south ||
          lat > bbox.north ||
          lng < bbox.west ||
          lng > bbox.east
        ) {
          continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const osmKey = String(props.osm_key || '');
        const osmVal = String(props.osm_value || '');
        const category: RawOsmPoi['category'] =
          osmVal === 'ferry_terminal'
            ? 'port'
            : osmKey === 'railway' || osmVal === 'bus_station' || osmVal === 'aerodrome'
              ? 'station'
              : osmVal === 'suburb' || osmVal === 'borough' || osmVal === 'quarter'
                ? 'district'
                : 'city';
        const score =
          osmVal === 'ferry_terminal'
            ? 84
            : osmVal === 'station'
              ? 82
              : osmVal === 'city'
                ? 78
                : osmVal === 'bus_station'
                  ? 74
                  : osmVal === 'town'
                    ? 66
                    : osmVal === 'suburb' || osmVal === 'borough'
                      ? 38
                      : 54;
        out.push({
          id: `pho-${props.osm_id || `${lat.toFixed(4)}-${lng.toFixed(4)}`}`,
          name,
          lat,
          lng,
          category,
          osmScore: score,
          tags: { osm_key: osmKey, osm_value: osmVal, source: 'photon' },
        });
      }
    }

    if (out.length > 0) {
      saveProviderCache('photon', cacheKey, out, bbox, out.length);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fetches an actual driving road polyline between two coordinates via OSRM and caches it in SQLite provider_cache.
 * Rejects wildly indirect OSRM routes (e.g. >3x straight chord across Puget Sound water) so ferries remain water routes.
 */
async function fetchOsrmSingleCorridor(
  a: { id: string; name: string; lat: number; lng: number; category?: string },
  b: { id: string; name: string; lat: number; lng: number; category?: string },
  bbox: BoundingBox
): Promise<RawTransitCorridor | null> {
  const pairKey = `${a.lat.toFixed(3)},${a.lng.toFixed(3)}:${b.lat.toFixed(3)},${b.lng.toFixed(3)}`;
  const cached = getProviderCache<RawTransitCorridor>('osrm', pairKey);
  if (cached && cached.points.length >= 2) return cached;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng.toFixed(5)},${a.lat.toFixed(5)};${b.lng.toFixed(5)},${b.lat.toFixed(5)}?overview=simplified&geometries=geojson`;
    const json = await fetchJsonWithTimeout(
      url,
      { headers: { 'User-Agent': USER_AGENT } },
      6000
    );
    const coords: [number, number][] = json?.routes?.[0]?.geometry?.coordinates ?? [];
    if (json?.code !== 'Ok' || !Array.isArray(coords) || coords.length < 2) {
      return null;
    }
    const routeDistM = Number(json?.routes?.[0]?.distance || 0);
    const chordM = Math.max(100, haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000);
    // Reject gigantic around-the-sound driving detours across water when straight span is water crossing
    if (routeDistM > Math.max(chordM * 2.35, chordM + 12000)) {
      return null;
    }

    const pts = coords.map(([lng, lat]) => ({ lat, lng }));
    const corridor: RawTransitCorridor = {
      id: `osrm-${a.id}-${b.id}`,
      name: `${a.name}–${b.name} Highway`,
      mode: 'highway',
      weight: a.category === 'station' || b.category === 'station' ? 76 : 68,
      isTunnel: false,
      isBridge: false,
      points: pts,
    };
    saveProviderCache('osrm', pairKey, corridor, bbox, pts.length);
    return corridor;
  } catch {
    return null;
  }
}

// OSRM real road corridor fallback when Overpass ways are unavailable
async function fetchOsrmFallbackCorridors(
  pois: RawOsmPoi[],
  bbox: BoundingBox
): Promise<RawTransitCorridor[]> {
  if (pois.length < 3) return [];
  const top = pois.slice(0, 20);
  const pairs: Array<{ a: RawOsmPoi; b: RawOsmPoi; d: number }> = [];

  // Build MST + local neighbor links (up to 24 real OSRM road corridors)
  const visited = new Set<number>([0]);
  const pairSet = new Set<string>();
  while (visited.size < top.length) {
    let bestU = -1;
    let bestV = -1;
    let bestD = Infinity;
    for (const u of visited) {
      for (let v = 0; v < top.length; v++) {
        if (visited.has(v)) continue;
        const d = haversineKm(top[u].lat, top[u].lng, top[v].lat, top[v].lng);
        if (d < bestD) {
          bestD = d;
          bestU = u;
          bestV = v;
        }
      }
    }
    if (bestU < 0 || bestV < 0) break;
    visited.add(bestV);
    const key = [top[bestU].id, top[bestV].id].sort().join(':');
    pairSet.add(key);
    pairs.push({ a: top[bestU], b: top[bestV], d: bestD });
  }

  for (let i = 0; i < top.length && pairs.length < 24; i++) {
    let nearest = -1;
    let nearestD = Infinity;
    for (let j = 0; j < top.length; j++) {
      if (i === j) continue;
      const key = [top[i].id, top[j].id].sort().join(':');
      if (pairSet.has(key)) continue;
      const d = haversineKm(top[i].lat, top[i].lng, top[j].lat, top[j].lng);
      if (d < nearestD) {
        nearestD = d;
        nearest = j;
      }
    }
    if (nearest >= 0) {
      pairSet.add([top[i].id, top[nearest].id].sort().join(':'));
      pairs.push({ a: top[i], b: top[nearest], d: nearestD });
    }
  }

  const corridors: RawTransitCorridor[] = [];
  const batchSize = 5;
  for (let idx = 0; idx < pairs.length; idx += batchSize) {
    const chunk = pairs.slice(idx, idx + batchSize);
    const results = await Promise.allSettled(
      chunk.map(({ a, b }) => fetchOsrmSingleCorridor(a, b, bbox))
    );
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) {
        corridors.push(res.value);
      }
    }
  }

  return corridors;
}

function classifyPoiCategory(tags: Record<string, string>): RawOsmPoi['category'] {
  if (tags.amenity === 'ferry_terminal' || tags.harbour === 'yes' || tags.ferry === 'yes' || tags['seamark:type']) {
    return 'port';
  }
  if (
    tags.railway === 'station' ||
    tags.railway === 'halt' ||
    tags.public_transport === 'station' ||
    tags.amenity === 'bus_station' ||
    tags.aeroway === 'aerodrome'
  ) {
    return 'station';
  }
  if (
    tags.place === 'suburb' ||
    tags.place === 'borough' ||
    tags.place === 'quarter' ||
    tags.place === 'neighbourhood'
  ) {
    return 'district';
  }
  if (tags.tourism || tags.historic || tags.leisure) {
    return 'landmark';
  }
  return 'city';
}

function scoreOsmPoi(tags: Record<string, string>, scaleMode: ScaleMode): number {
  let score = 20;
  const pop = Number(tags.population || 0);
  if (pop > 0) {
    score += Math.min(48, Math.log10(pop) * 7.5);
  }
  if (tags.capital === 'yes' || tags.admin_level === '2') score += 26;
  if (tags.place === 'city') score += 26;
  if (tags.place === 'town') score += 18;
  // Community names, boroughs, suburbs, and neighborhoods rank significantly below cities, stations, ports, and hubs
  if (tags.place === 'suburb' || tags.place === 'borough') score += 2;
  if (tags.place === 'quarter' || tags.place === 'neighbourhood' || tags.place === 'hamlet') score -= 4;

  // Big boosts for ferry ports, train stations, transit stations, and international hubs
  if (tags.amenity === 'ferry_terminal' || tags.ferry === 'yes' || tags.harbour === 'yes') score += 38;
  if (tags.man_made === 'pier') score += 24;
  if (tags.railway === 'station') score += scaleMode === 'city' ? 36 : 34;
  if (tags.railway === 'halt' || tags.public_transport === 'station') score += 26;
  if (tags.amenity === 'bus_station') score += 26;
  if (tags.aeroway === 'aerodrome' && tags.iata) score += 32;
  if (tags.station === 'subway' || tags.station === 'light_rail') score += 18;

  if (tags.tourism === 'attraction' || tags.tourism === 'museum') score += 18;
  if (tags.historic === 'castle' || tags.historic === 'monument') score += 16;
  if (tags.wikipedia || tags.wikidata) score += 12;
  if (tags.name && Object.keys(tags).length > 5) score += 6;
  return Math.max(10, Math.min(100, Math.round(score)));
}

function parseCorridorModeAndWeight(tags: Record<string, string>): {
  mode: RawTransitCorridor['mode'];
  weight: number;
} {
  if (tags.route === 'ferry') {
    return { mode: 'ferry', weight: 90 };
  }
  if (tags.route === 'train' || tags.railway === 'rail' || tags.railway === 'highspeed') {
    const highSpeed = tags.railway === 'highspeed' || tags.usage === 'main';
    return { mode: 'train', weight: highSpeed ? 96 : 86 };
  }
  if (tags.route === 'subway' || tags.railway === 'subway' || tags.route === 'light_rail' || tags.railway === 'light_rail') {
    return { mode: 'train', weight: 88 };
  }
  if (tags.route === 'tram' || tags.railway === 'tram') {
    return { mode: 'bus', weight: 76 };
  }
  if (tags.route === 'bus' || tags.route === 'trolleybus') {
    let weight = 68;
    const intervalStr = tags.interval || tags.headway || '';
    const mins = parseInt(intervalStr, 10);
    if (!Number.isNaN(mins) && mins > 0) {
      if (mins <= 10) weight = 90;
      else if (mins <= 20) weight = 80;
      else if (mins <= 30) weight = 72;
    }
    if (tags.bus === 'express' || tags.network?.toLowerCase().includes('rapid')) {
      weight = Math.max(weight, 86);
    }
    return { mode: 'bus', weight };
  }
  if (tags.highway === 'motorway') return { mode: 'highway', weight: 84 };
  if (tags.highway === 'trunk') return { mode: 'highway', weight: 74 };
  if (tags.highway === 'primary') return { mode: 'highway', weight: 62 };
  return { mode: 'highway', weight: 48 };
}

export async function fetchRealRegionData(
  rawBbox: BoundingBox,
  zoom: number
): Promise<RawRegionDataset> {
  const bbox = validateBbox(rawBbox);
  const { scaleMode, diagKm } = detectScaleMode(bbox);

  // Query Overpass, multi-point Wikipedia GeoSearch, and Wikidata bounding box in parallel
  const [overpassData, wikiPlaces, wikidataPlaces] = await Promise.all([
    fetchOverpassCached(bbox, scaleMode),
    fetchWikipediaHotspots(bbox, diagKm, scaleMode),
    fetchWikidataBoxPois(bbox, scaleMode),
  ]);

  const elements: any[] = overpassData?.elements ?? [];
  const poisMap = new Map<string, RawOsmPoi>();
  const corridors: RawTransitCorridor[] = [];
  const hazards: RawHazardZone[] = [];

  const roadIntersectionCounts = new Map<
    string,
    { lat: number; lng: number; maxWeight: number; count: number }
  >();

  for (const el of elements) {
    const tags: Record<string, string> = el.tags || {};

    if (el.type === 'node') {
      if (tags['seamark:type']) {
        const seamark = tags['seamark:type'];
        hazards.push({
          id: `haz-${el.id}`,
          type: 'maritime_hazard',
          lat: el.lat,
          lng: el.lon,
          severity: seamark === 'wreck' || seamark === 'rock' ? 3 : 2,
          label: tags['seamark:name'] || seamark,
        });
      }
      if (tags.highway === 'traffic_signals') {
        hazards.push({
          id: `sig-${el.id}`,
          type: 'road_intersection',
          lat: el.lat,
          lng: el.lon,
          severity: 2,
        });
      }
      if (
        tags.name &&
        (tags.place || tags.railway || tags.tourism || tags.historic || tags.amenity || tags.aeroway || tags.leisure)
      ) {
        const key = tags.name.trim().toLowerCase();
        const osmScore = scoreOsmPoi(tags, scaleMode);
        const existing = poisMap.get(key);
        if (!existing || osmScore > existing.osmScore) {
          poisMap.set(key, {
            id: `osm-${el.id}`,
            name: tags.name.trim(),
            lat: el.lat,
            lng: el.lon,
            category: classifyPoiCategory(tags),
            population: tags.population ? Number(tags.population) || undefined : undefined,
            osmScore,
            tags,
          });
        }
      }
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      if (tags.name && (tags.tourism || tags.historic) && !tags.highway && !tags.railway) {
        const mid = el.geometry[Math.floor(el.geometry.length / 2)];
        const key = tags.name.trim().toLowerCase();
        if (!poisMap.has(key)) {
          poisMap.set(key, {
            id: `osm-way-${el.id}`,
            name: tags.name.trim(),
            lat: mid.lat,
            lng: mid.lon,
            category: 'landmark',
            osmScore: scoreOsmPoi(tags, scaleMode),
            tags,
          });
        }
      }

      if (tags.railway || tags.route === 'ferry' || tags.highway) {
        const { mode, weight } = parseCorridorModeAndWeight(tags);
        const step = Math.max(1, Math.floor(el.geometry.length / 26));
        const pts: { lat: number; lng: number }[] = [];
        for (let i = 0; i < el.geometry.length; i += step) {
          pts.push({ lat: el.geometry[i].lat, lng: el.geometry[i].lon });
        }
        const last = el.geometry[el.geometry.length - 1];
        if (
          pts.length === 0 ||
          pts[pts.length - 1].lat !== last.lat ||
          pts[pts.length - 1].lng !== last.lon
        ) {
          pts.push({ lat: last.lat, lng: last.lon });
        }

        const isTunnel = tags.tunnel === 'yes' || tags.tunnel === 'building_passage';
        const isBridge = tags.bridge === 'yes';

        corridors.push({
          id: `way-${el.id}`,
          name: tags.name || tags.ref,
          mode,
          weight,
          isTunnel,
          isBridge,
          points: pts,
        });

        if (isTunnel || isBridge) {
          const mid = pts[Math.floor(pts.length / 2)];
          hazards.push({
            id: `tun-${el.id}`,
            type: 'tunnel_terrain',
            lat: mid.lat,
            lng: mid.lng,
            severity: isTunnel ? 3 : 2,
            label: tags.name || (isTunnel ? 'Tunnel' : 'Major Bridge'),
          });
        }

        if (tags.highway && Array.isArray(el.nodes)) {
          for (let i = 0; i < el.nodes.length; i += Math.max(1, Math.floor(el.nodes.length / 4))) {
            const nid = String(el.nodes[i]);
            const pt = el.geometry[i];
            if (!pt) continue;
            const prev = roadIntersectionCounts.get(nid);
            if (prev) {
              prev.count += 1;
              prev.maxWeight = Math.max(prev.maxWeight, weight);
            } else {
              roadIntersectionCounts.set(nid, {
                lat: pt.lat,
                lng: pt.lon,
                maxWeight: weight,
                count: 1,
              });
            }
          }
        }
      }
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      const { mode, weight } = parseCorridorModeAndWeight(tags);
      // Chain continuous member way geometries faithfully so ferry/train relations match real geometry
      const chains: Array<Array<{ lat: number; lng: number }>> = [];
      for (const m of el.members) {
        if (!Array.isArray(m.geometry) || m.geometry.length < 2) continue;
        const step = Math.max(1, Math.floor(m.geometry.length / 10));
        const segPts: { lat: number; lng: number }[] = [];
        for (let k = 0; k < m.geometry.length; k += step) {
          segPts.push({ lat: m.geometry[k].lat, lng: m.geometry[k].lon });
        }
        const tailRaw = m.geometry[m.geometry.length - 1];
        const tailSeg = segPts[segPts.length - 1];
        if (!tailSeg || tailSeg.lat !== tailRaw.lat || tailSeg.lng !== tailRaw.lon) {
          segPts.push({ lat: tailRaw.lat, lng: tailRaw.lon });
        }

        if (chains.length === 0) {
          chains.push(segPts);
        } else {
          const curChain = chains[chains.length - 1];
          const curEnd = curChain[curChain.length - 1];
          const curStart = curChain[0];
          const dEndToStart = haversineKm(curEnd.lat, curEnd.lng, segPts[0].lat, segPts[0].lng);
          const dEndToEnd = haversineKm(
            curEnd.lat,
            curEnd.lng,
            segPts[segPts.length - 1].lat,
            segPts[segPts.length - 1].lng
          );
          const dStartToEnd = haversineKm(
            curStart.lat,
            curStart.lng,
            segPts[segPts.length - 1].lat,
            segPts[segPts.length - 1].lng
          );
          const dStartToStart = haversineKm(curStart.lat, curStart.lng, segPts[0].lat, segPts[0].lng);

          if (dEndToStart < 0.25) {
            curChain.push(...segPts.slice(1));
          } else if (dEndToEnd < 0.25) {
            const rev = [...segPts].reverse();
            curChain.push(...rev.slice(1));
          } else if (dStartToEnd < 0.25) {
            chains[chains.length - 1] = [...segPts.slice(0, -1), ...curChain];
          } else if (dStartToStart < 0.25) {
            const rev = [...segPts].reverse();
            chains[chains.length - 1] = [...rev.slice(0, -1), ...curChain];
          } else {
            chains.push(segPts);
          }
        }
      }

      chains.forEach((chainPts, cIdx) => {
        if (chainPts.length < 2) return;
        const maxPts = 96;
        const stride = chainPts.length > maxPts ? Math.ceil(chainPts.length / maxPts) : 1;
        const compact = chainPts.filter((_, i) => i === chainPts.length - 1 || i % stride === 0);
        corridors.push({
          id: chains.length === 1 ? `rel-${el.id}` : `rel-${el.id}-${cIdx}`,
          name: tags.name || tags.ref || `${mode.toUpperCase()} Line`,
          mode,
          weight,
          isTunnel: false,
          isBridge: false,
          points: compact,
        });
      });
    }
  }

  for (const [, inter] of roadIntersectionCounts) {
    if (inter.count >= 2) {
      const severity =
        inter.maxWeight >= 80 ? 4 : inter.maxWeight >= 70 ? 3 : inter.maxWeight >= 60 ? 2 : 1;
      hazards.push({
        id: `int-${inter.lat.toFixed(4)}-${inter.lng.toFixed(4)}`,
        type: 'road_intersection',
        lat: inter.lat,
        lng: inter.lng,
        severity,
      });
    }
  }

  // Merge Wikidata bounding-box entities (cities, landmarks, stations, ferry terminals)
  for (const wd of wikidataPlaces) {
    const cleanName = wd.name.replace(/\s*\(.*?\)\s*$/, '');
    const inferredPort = /\b(ferry terminal|ferry dock|port of|harbor|harbour|wharf|terminal)\b/i.test(cleanName);
    const inferredStation = /\b(station|transit center|transit centre|airport)\b/i.test(cleanName);
    const wdBoost = Math.min(40, Math.round(Math.log2(wd.sitelinks + 1) * 6.8));
    const popBoost = wd.population && wd.population > 0 ? Math.min(18, Math.log10(wd.population) * 2.5) : 0;
    const transitCatBonus = inferredPort ? 16 : inferredStation ? 14 : 0;
    const score = Math.min(99, Math.round(38 + wdBoost * 0.72 + popBoost + transitCatBonus));
    let matched = false;
    for (const poi of poisMap.values()) {
      if (haversineKm(poi.lat, poi.lng, wd.lat, wd.lng) < (scaleMode === 'city' ? 0.35 : 3.5)) {
        poi.wikiSitelinks = Math.max(poi.wikiSitelinks || 0, wd.sitelinks);
        if (!poi.population && wd.population) poi.population = wd.population;
        // Preserve port/station priority boosts above pure place popularity
        if (poi.category === 'port' || poi.category === 'station') {
          poi.osmScore = Math.max(poi.osmScore, Math.min(100, score + 10));
        } else {
          poi.osmScore = Math.max(poi.osmScore, score);
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      const key = wd.name.toLowerCase();
      poisMap.set(key, {
        id: wd.id,
        name: cleanName,
        lat: wd.lat,
        lng: wd.lng,
        category: inferredPort
          ? 'port'
          : inferredStation
            ? 'station'
            : wd.population && wd.population > 8000
              ? 'city'
              : scaleMode === 'macro'
                ? 'city'
                : 'landmark',
        population: wd.population,
        wikiSitelinks: wd.sitelinks,
        osmScore: score,
        tags: { source: 'wikidata' },
      });
    }
  }

  // Merge Wikipedia GeoSearch hotspots & sitelink popularity boosts
  for (const wp of wikiPlaces) {
    const cleanTitle = wp.title.replace(/\s*\(.*?\)\s*$/, '');
    const inferredPort = /\b(ferry terminal|ferry dock|port of|harbor|harbour|wharf|terminal)\b/i.test(cleanTitle);
    const inferredStation = /\b(station|transit center|transit centre|airport)\b/i.test(cleanTitle);
    const wikiBoost = Math.min(40, Math.round(Math.log2(wp.sitelinks + 1) * 6.8));
    let matched = false;
    for (const poi of poisMap.values()) {
      if (haversineKm(poi.lat, poi.lng, wp.lat, wp.lng) < (scaleMode === 'city' ? 0.35 : 3.5)) {
        poi.wikiSitelinks = Math.max(poi.wikiSitelinks || 0, wp.sitelinks);
        if (poi.category === 'port' || poi.category === 'station') {
          poi.osmScore = Math.max(poi.osmScore, Math.min(100, 52 + wikiBoost));
        } else {
          poi.osmScore = Math.min(100, Math.round(poi.osmScore * 0.65 + (38 + wikiBoost) * 0.5));
        }
        matched = true;
        break;
      }
    }
    if (!matched && (wp.sitelinks >= 2 || inferredPort || inferredStation || poisMap.size < 25)) {
      const key = wp.title.toLowerCase();
      poisMap.set(key, {
        id: `wiki-${wp.lat.toFixed(4)}-${wp.lng.toFixed(4)}`,
        name: cleanTitle,
        lat: wp.lat,
        lng: wp.lng,
        category: inferredPort
          ? 'port'
          : inferredStation
            ? 'station'
            : scaleMode === 'macro'
              ? 'city'
              : 'landmark',
        wikiSitelinks: wp.sitelinks,
        osmScore: Math.min(98, 40 + wikiBoost + (inferredPort ? 16 : inferredStation ? 14 : 0)),
        tags: { source: 'wikipedia' },
      });
    }
  }

  // Always supplement with Photon OSM stations/ferries/towns when Overpass didn't succeed or POIs are sparse
  let photonUsed = false;
  if (!overpassData || poisMap.size < 35) {
    const photonPois = await fetchPhotonBoxPois(bbox, scaleMode);
    if (photonPois.length > 0) {
      photonUsed = true;
      for (const pp of photonPois) {
        const key = pp.name.toLowerCase();
        if (poisMap.has(key)) continue;
        let close = false;
        for (const existing of poisMap.values()) {
          if (haversineKm(existing.lat, existing.lng, pp.lat, pp.lng) < (scaleMode === 'city' ? 0.25 : 1.5)) {
            close = true;
            break;
          }
        }
        if (!close) {
          poisMap.set(key, pp);
        }
      }
    }
  }

  // Prioritize railways, ferries, and bus lines before clipping corridor list so highways never drown transit lines
  const modePriority = (m: TransportMode) => (m === 'ferry' ? 40 : m === 'train' ? 30 : m === 'bus' ? 18 : 0);
  corridors.sort((a, b) => modePriority(b.mode) + b.weight * 0.2 - (modePriority(a.mode) + a.weight * 0.2));

  const rawPois = Array.from(poisMap.values());
  const pois = enrichPoiTransitUtility(rawPois, corridors, bbox)
    .sort((a, b) => b.osmScore - a.osmScore)
    .slice(0, 280);

  // If Overpass corridors were unavailable, trace real geographic road corridors with OSRM
  let osrmUsed = false;
  if (corridors.length < 16 && pois.length >= 3) {
    const osrmCorridors = await fetchOsrmFallbackCorridors(pois, bbox);
    if (osrmCorridors.length > 0) {
      osrmUsed = true;
      corridors.push(...osrmCorridors);
    }
  }

  if (pois.length < 3) {
    throw new Error(
      'Could not gather enough real landmarks or stations inside this bounding box. Try expanding the box over a populated region or retrying in a moment.'
    );
  }

  const sources: RawRegionSources = {
    overpass: Boolean(overpassData && elements.length > 0),
    wikipedia: wikiPlaces.length > 0,
    wikidata: wikidataPlaces.length > 0,
    photon: photonUsed,
    osrm: osrmUsed,
  };

  if (OSM_FETCHER_DEBUG_LEVEL >= 1) {
    console.log('[osmFetcher] fetchRealRegionData complete', {
      scaleMode,
      poisCount: pois.length,
      corridorsCount: corridors.length,
      ferries: corridors.filter((c) => c.mode === 'ferry').length,
      trains: corridors.filter((c) => c.mode === 'train').length,
    });
  }

  return {
    bbox,
    zoom,
    scaleMode,
    pois,
    corridors: corridors.slice(0, 950),
    hazards: hazards.slice(0, 350),
    fetchedAt: new Date().toISOString(),
    sources,
  };
}

/**
 * Computes multimodal transit interchange utility for candidate POIs based on distinct real-world modes
 * (ferry, rail, bus, major highway) converging within scale-appropriate proximity.
 * Strongly boosts ferry ports, train stations, and multimodal transit hubs while down-ranking plain boroughs/community names.
 * Call with POIs array, corridors array, and region bounding box.
 * Returns mutated/enriched RawOsmPoi[] with `interchangeModes` and updated `osmScore`.
 */
export function enrichPoiTransitUtility(
  pois: RawOsmPoi[],
  corridors: RawTransitCorridor[],
  bbox: BoundingBox
): RawOsmPoi[] {
  const diagKm = Math.max(1, haversineKm(bbox.south, bbox.west, bbox.north, bbox.east));
  // Radius shrinks cleanly at city zoom and widens at metro/macro scale
  const probeRadiusKm = Math.max(0.32, Math.min(2.8, diagKm * 0.02));

  return pois.map((poi) => {
    const modes = new Set<TransportMode>(poi.interchangeModes || []);
    if (poi.category === 'port' || poi.tags?.amenity === 'ferry_terminal') modes.add('ferry');
    if (poi.category === 'station' || poi.tags?.railway) modes.add('train');
    if (poi.tags?.amenity === 'bus_station') modes.add('bus');

    for (const c of corridors) {
      if (c.weight < 54 && c.mode === 'highway') continue;
      for (let i = 0; i < c.points.length; i++) {
        const pt = c.points[i];
        if (Math.abs(pt.lat - poi.lat) > 0.04 || Math.abs(pt.lng - poi.lng) > 0.06) continue;
        if (haversineKm(poi.lat, poi.lng, pt.lat, pt.lng) <= probeRadiusKm) {
          modes.add(c.mode);
          break;
        }
      }
      if (modes.size >= 4) break;
    }

    const modeList = Array.from(modes);
    const isHubName = /\b(transit|hub|interchange|exchange|union|central|terminal)\b/i.test(poi.name);
    let utilityDelta = 0;

    if (poi.category === 'port') utilityDelta += 14;
    else if (poi.category === 'station') utilityDelta += 12;

    if (modeList.length >= 2) {
      utilityDelta +=
        (modeList.length - 1) * 11 +
        (modes.has('ferry') ? 8 : 0) +
        (modes.has('train') ? 6 : 0) +
        (isHubName ? 4 : 0);
    } else if (modes.has('ferry')) {
      utilityDelta += 10;
    } else if (modes.has('train')) {
      utilityDelta += 8;
    }

    // Demote plain community names / boroughs unless they sit right on a ferry/rail transit hub
    if (poi.category === 'district' && modeList.length < 2 && !modes.has('ferry') && !modes.has('train')) {
      utilityDelta -= 14;
    }

    return {
      ...poi,
      interchangeModes: modeList.length > 0 ? modeList : undefined,
      osmScore: Math.max(10, Math.min(100, poi.osmScore + utilityDelta)),
    };
  });
}

/**
 * Queries OSM Overpass, Wikipedia, and Photon over a small user-dragged discovery box in Step 2
 * to uncover high-utility transit interchanges (ferry landings, rail halts, bus hubs, towns/landmarks).
 * Call with small sub-box, map zoom, and optional already-cached corridors for multimodal scoring.
 * Returns { pois, corridors, hazards }.
 */
export async function discoverAreaDetails(
  rawBbox: BoundingBox,
  zoom: number,
  existingCorridors: RawTransitCorridor[] = []
): Promise<{
  pois: RawOsmPoi[];
  corridors: RawTransitCorridor[];
  hazards: RawHazardZone[];
}> {
  const bbox = validateBbox(rawBbox);
  const { diagKm } = detectScaleMode(bbox);
  // Use finer resolution for area discovery inside a sub-box
  const targetScale: ScaleMode = diagKm > 90 ? 'metro' : 'city';
  const cacheKey = `disc:${makeBboxCacheKey(bbox, targetScale)}`;
  const cached = getProviderCache<{ pois: RawOsmPoi[]; corridors: RawTransitCorridor[]; hazards: RawHazardZone[] }>(
    'discover_area',
    cacheKey
  );
  if (cached && cached.pois.length > 0) {
    return {
      pois: enrichPoiTransitUtility(cached.pois, [...existingCorridors, ...cached.corridors], bbox),
      corridors: cached.corridors,
      hazards: cached.hazards,
    };
  }

  const b = `${bbox.south.toFixed(4)},${bbox.west.toFixed(4)},${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`;
  const discoverQuery = `
    [out:json][timeout:14];
    (
      node["amenity"~"^(ferry_terminal|bus_station|university|marketplace|townhall)$"](${b});
      way["amenity"~"^(ferry_terminal|bus_station)$"](${b});
      node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${b});
      node["place"~"^(city|town|village|suburb|borough|hamlet|island)$"](${b});
      node["tourism"~"^(attraction|museum|viewpoint|marina|theme_park)$"](${b});
      node["man_made"="pier"]["name"](${b});
      way["route"="ferry"](${b});
      relation["route"~"^(ferry|train|subway|light_rail|bus)$"](${b});
      way["railway"~"^(rail|subway|light_rail|tram)$"](${b});
      way["highway"~"^(motorway|trunk|primary)$"](${b});
    );
    out body geom 900;
  `;

  let elements: any[] = [];
  try {
    const winner = await Promise.any(
      OVERPASS_ENDPOINTS.map(async (endpoint) => {
        const json = await fetchJsonWithTimeout(
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': USER_AGENT,
            },
            body: `data=${encodeURIComponent(discoverQuery)}`,
          },
          6500
        );
        if (!json || !Array.isArray(json.elements)) throw new Error('Invalid discover Overpass');
        return json.elements as any[];
      })
    );
    elements = winner;
  } catch {
    elements = [];
  }

  const [wikiPlaces, photonPois] = await Promise.all([
    fetchWikipediaHotspots(bbox, diagKm, targetScale),
    fetchPhotonBoxPois(bbox, targetScale),
  ]);

  const poisMap = new Map<string, RawOsmPoi>();
  const corridors: RawTransitCorridor[] = [];
  const hazards: RawHazardZone[] = [];

  for (const el of elements) {
    const tags: Record<string, string> = el.tags || {};
    if (el.type === 'node' && tags.name) {
      const key = tags.name.trim().toLowerCase();
      const score = scoreOsmPoi(tags, targetScale);
      const prev = poisMap.get(key);
      if (!prev || score > prev.osmScore) {
        poisMap.set(key, {
          id: `disc-${el.id}`,
          name: tags.name.trim(),
          lat: el.lat,
          lng: el.lon,
          category: tags.man_made === 'pier' ? 'port' : classifyPoiCategory(tags),
          population: tags.population ? Number(tags.population) || undefined : undefined,
          osmScore: score,
          tags,
        });
      }
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      if (tags.name && (tags.amenity === 'ferry_terminal' || tags.amenity === 'bus_station') && !poisMap.has(tags.name.toLowerCase())) {
        const mid = el.geometry[Math.floor(el.geometry.length / 2)];
        poisMap.set(tags.name.toLowerCase(), {
          id: `disc-way-${el.id}`,
          name: tags.name.trim(),
          lat: mid.lat,
          lng: mid.lon,
          category: tags.amenity === 'ferry_terminal' ? 'port' : 'station',
          osmScore: scoreOsmPoi(tags, targetScale),
          tags,
        });
      }
      if (tags.railway || tags.route === 'ferry' || tags.highway) {
        const { mode, weight } = parseCorridorModeAndWeight(tags);
        const step = Math.max(1, Math.floor(el.geometry.length / 22));
        const pts = el.geometry.filter((_: any, i: number) => i === el.geometry.length - 1 || i % step === 0).map((g: any) => ({ lat: g.lat, lng: g.lon }));
        corridors.push({
          id: `disc-way-${el.id}`,
          name: tags.name || tags.ref,
          mode,
          weight,
          isTunnel: tags.tunnel === 'yes',
          isBridge: tags.bridge === 'yes',
          points: pts,
        });
      }
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      const { mode, weight } = parseCorridorModeAndWeight(tags);
      const pts: { lat: number; lng: number }[] = [];
      for (const m of el.members) {
        if (!Array.isArray(m.geometry)) continue;
        const step = Math.max(1, Math.floor(m.geometry.length / 8));
        for (let k = 0; k < m.geometry.length; k += step) {
          pts.push({ lat: m.geometry[k].lat, lng: m.geometry[k].lon });
        }
        if (pts.length > 80) break;
      }
      if (pts.length >= 2) {
        corridors.push({
          id: `disc-rel-${el.id}`,
          name: tags.name || tags.ref || `${mode.toUpperCase()} Line`,
          mode,
          weight,
          isTunnel: false,
          isBridge: false,
          points: pts,
        });
      }
    }
  }

  for (const pp of photonPois) {
    const k = pp.name.toLowerCase();
    if (!poisMap.has(k)) poisMap.set(k, pp);
  }
  for (const wp of wikiPlaces) {
    const k = wp.title.toLowerCase();
    if (!poisMap.has(k)) {
      poisMap.set(k, {
        id: `disc-wiki-${wp.lat.toFixed(4)}-${wp.lng.toFixed(4)}`,
        name: wp.title.replace(/\s*\(.*?\)\s*$/, ''),
        lat: wp.lat,
        lng: wp.lng,
        category: 'landmark',
        wikiSitelinks: wp.sitelinks,
        osmScore: Math.min(96, 44 + Math.min(40, wp.sitelinks * 4)),
        tags: { source: 'wikipedia' },
      });
    }
  }

  const combinedCorridors = [...existingCorridors, ...corridors];
  const pois = enrichPoiTransitUtility(Array.from(poisMap.values()), combinedCorridors, bbox)
    .sort((a, b) => b.osmScore - a.osmScore)
    .slice(0, 60);

  if (pois.length > 0 || corridors.length > 0) {
    saveProviderCache('discover_area', cacheKey, { pois, corridors, hazards }, bbox, pois.length + corridors.length);
  }

  if (OSM_FETCHER_DEBUG_LEVEL >= 2) {
    console.log('[osmFetcher] discoverAreaDetails', { zoom, pois: pois.length, corridors: corridors.length });
  }

  return { pois, corridors, hazards };
}

/**
 * Looks up real transit facilities, settlements, piers, or landmarks near a manually placed stop coordinate
 * so the creator can pick an accurate place name/category from a popup tooltip next to the pin.
 * Call with clicked lat, lng, current zoom, and optional local corridors/POIs from the active dataset.
 * Returns ranked SpotLookupMatch[] ordered by proximity + prominence.
 */
export async function lookupSpotNearby(
  lat: number,
  lng: number,
  zoom: number,
  datasetCorridors: RawTransitCorridor[] = [],
  existingPois: RawOsmPoi[] = []
): Promise<SpotLookupMatch[]> {
  const radiusMeters = zoom >= 14 ? 420 : zoom >= 11 ? 1400 : 3800;
  const cacheKey = `spot:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusMeters}`;
  const cached = getProviderCache<SpotLookupMatch[]>('lookup_spot', cacheKey);
  if (cached && cached.length > 0) {
    return cached;
  }

  const matchesMap = new Map<string, SpotLookupMatch>();
  const addMatch = (m: SpotLookupMatch) => {
    const key = m.name.trim().toLowerCase();
    const prev = matchesMap.get(key);
    if (!prev || m.distanceMeters < prev.distanceMeters - 40) {
      matchesMap.set(key, m);
    }
  };

  // Check locally cached region POIs first
  for (const poi of existingPois) {
    const distM = Math.round(haversineKm(lat, lng, poi.lat, poi.lng) * 1000);
    if (distM <= radiusMeters * 1.4) {
      const modes = poi.interchangeModes?.length ? ` (${poi.interchangeModes.join(' + ')})` : '';
      addMatch({
        id: poi.id,
        name: poi.name,
        category: poi.category,
        lat: poi.lat,
        lng: poi.lng,
        distanceMeters: distM,
        reason: `Cached ${poi.category}${modes}`,
        osmScore: poi.osmScore,
        isMajorHub: poi.osmScore >= 76,
      });
    }
  }

  // Targeted Overpass around query for transit hubs & named features
  const q = `
    [out:json][timeout:8];
    (
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["amenity"~"^(ferry_terminal|bus_station|university|marketplace|townhall)$"];
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["railway"~"^(station|halt|tram_stop|subway_entrance)$"];
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["place"~"^(city|town|village|suburb|borough|neighbourhood|island|locality)$"];
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["man_made"="pier"];
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["tourism"];
      node(around:${radiusMeters},${lat.toFixed(5)},${lng.toFixed(5)})["name"]["historic"];
    );
    out body 35;
  `;

  const [overpassRes, photonRes, nominatimRes] = await Promise.allSettled([
    Promise.any(
      OVERPASS_ENDPOINTS.slice(0, 3).map(async (ep) => {
        const json = await fetchJsonWithTimeout(
          ep,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': USER_AGENT,
            },
            body: `data=${encodeURIComponent(q)}`,
          },
          4800
        );
        return json?.elements || [];
      })
    ),
    fetchJsonWithTimeout(
      `https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&limit=5`,
      { headers: { 'User-Agent': USER_AGENT } },
      4500
    ),
    fetchJsonWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&format=jsonv2&zoom=${Math.max(10, Math.min(18, Math.round(zoom || 13)))}`,
      { headers: { 'User-Agent': USER_AGENT } },
      4500
    ),
  ]);

  if (overpassRes.status === 'fulfilled' && Array.isArray(overpassRes.value)) {
    for (const el of overpassRes.value) {
      const tags = el.tags || {};
      if (!tags.name || typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      const distM = Math.round(haversineKm(lat, lng, el.lat, el.lon) * 1000);
      const cat = tags.man_made === 'pier' ? 'port' : classifyPoiCategory(tags);
      const reasonTag =
        tags.amenity === 'ferry_terminal'
          ? 'Ferry Terminal'
          : tags.railway
            ? `Rail (${tags.railway})`
            : tags.amenity === 'bus_station'
              ? 'Bus Station'
              : tags.place
                ? `Place (${tags.place})`
                : tags.man_made === 'pier'
                  ? 'Pier / Dock'
                  : 'Landmark';
      const score = scoreOsmPoi(tags, zoom >= 13 ? 'city' : 'metro');
      addMatch({
        id: `spot-osm-${el.id}`,
        name: String(tags.name).trim(),
        category: cat,
        lat: el.lat,
        lng: el.lon,
        distanceMeters: distM,
        reason: reasonTag,
        osmScore: score,
        isMajorHub: score >= 76 || cat === 'port' || tags.railway === 'station',
      });
    }
  }

  if (photonRes.status === 'fulfilled') {
    const feats: any[] = photonRes.value?.features || [];
    for (const f of feats) {
      const coords = f?.geometry?.coordinates;
      const p = f?.properties || {};
      const name = String(p.name || p.city || p.town || p.locality || '').trim();
      if (!name || !Array.isArray(coords) || coords.length < 2) continue;
      const fLng = Number(coords[0]);
      const fLat = Number(coords[1]);
      const distM = Math.round(haversineKm(lat, lng, fLat, fLng) * 1000);
      const cat: RawOsmPoi['category'] =
        p.osm_value === 'ferry_terminal'
          ? 'port'
          : p.osm_key === 'railway'
            ? 'station'
            : p.osm_key === 'place'
              ? 'city'
              : 'landmark';
      addMatch({
        id: `spot-pho-${p.osm_id || `${fLat.toFixed(4)}-${fLng.toFixed(4)}`}`,
        name,
        category: cat,
        lat: fLat,
        lng: fLng,
        distanceMeters: distM,
        reason: p.osm_value ? `OSM ${p.osm_value}` : 'Photon Reverse',
        osmScore: cat === 'port' || cat === 'station' ? 76 : 64,
        isMajorHub: cat === 'port' || cat === 'station',
      });
    }
  }

  if (nominatimRes.status === 'fulfilled' && nominatimRes.value) {
    const n = nominatimRes.value;
    const addr = n.address || {};
    const primary = n.name || addr.ferry_terminal || addr.station || addr.suburb || addr.town || addr.city || addr.village;
    if (primary) {
      const nLat = Number(n.lat || lat);
      const nLng = Number(n.lon || lng);
      addMatch({
        id: `spot-nom-${n.osm_id || `${nLat.toFixed(4)}-${nLng.toFixed(4)}`}`,
        name: String(primary).trim(),
        category: n.type === 'ferry_terminal' ? 'port' : n.category === 'railway' ? 'station' : 'city',
        lat: nLat,
        lng: nLng,
        distanceMeters: Math.round(haversineKm(lat, lng, nLat, nLng) * 1000),
        reason: `Nominatim (${n.type || n.category || 'place'})`,
        osmScore: 68,
        isMajorHub: n.type === 'ferry_terminal' || n.type === 'station',
      });
    }
  }

  // Note nearby transit modes intersecting the clicked coordinate
  const nearModes = new Set<TransportMode>();
  for (const c of datasetCorridors) {
    if (c.points.some((pt) => haversineKm(lat, lng, pt.lat, pt.lng) <= radiusMeters / 1000)) {
      nearModes.add(c.mode);
    }
  }

  const out = Array.from(matchesMap.values())
    .map((m) =>
      nearModes.size >= 2 && !m.reason.includes('+')
        ? {
            ...m,
            reason: `${m.reason} · near ${Array.from(nearModes).join('+')}`,
            osmScore: Math.min(100, m.osmScore + 8),
            isMajorHub: true,
          }
        : m
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters * 0.4 - (a.osmScore - b.osmScore) * 12)
    .slice(0, 8);

  if (out.length > 0) {
    saveProviderCache('lookup_spot', cacheKey, out, undefined, out.length);
  }
  return out;
}

/**
 * Fetches real railways, ferry routes, and highways passing near added or edited stops via Overpass,
 * and supplements explicit stop pairs and neighbor links with cached OSRM real highway curves (e.g., US-101 Olympia-Shelton).
 * Call with dirty/added stops list, active bbox, map zoom, optional allActiveStops, and optional explicitPairs `{fromId, toId}[]`.
 * Returns RawTransitCorridor[] merged from Overpass + OSRM.
 */
export async function fetchCorridorsNearStops(
  stops: Array<{ id: string; name: string; lat: number; lng: number }>,
  bbox: BoundingBox,
  zoom: number,
  allActiveStops?: Array<{ id: string; name: string; lat: number; lng: number }>,
  explicitPairs?: Array<{ fromId: string; toId: string }>
): Promise<RawTransitCorridor[]> {
  const pool = allActiveStops && allActiveStops.length >= 2 ? allActiveStops : stops || [];
  const poolById = new Map(pool.map((s) => [s.id, s]));

  // Resolve explicit pairs first so untraced or manually linked pairs always trace their real road geometry
  const explicitPairObjs: Array<{
    a: { id: string; name: string; lat: number; lng: number };
    b: { id: string; name: string; lat: number; lng: number };
    key: string;
  }> = [];
  const explicitStopMap = new Map<string, { id: string; name: string; lat: number; lng: number }>();
  if (Array.isArray(explicitPairs)) {
    for (const pair of explicitPairs) {
      const a = poolById.get(pair.fromId);
      const b = poolById.get(pair.toId);
      if (!a || !b || a.id === b.id) continue;
      const key = [a.id, b.id].sort().join('::');
      if (explicitPairObjs.some((p) => p.key === key)) continue;
      explicitPairObjs.push({ a, b, key });
      explicitStopMap.set(a.id, a);
      explicitStopMap.set(b.id, b);
    }
  }

  const effectiveStops = stops && stops.length > 0 ? stops : Array.from(explicitStopMap.values());
  if (effectiveStops.length === 0 && explicitPairObjs.length === 0) return [];

  const sampleStops = effectiveStops.slice(0, 12);
  const { diagKm, scaleMode } = detectScaleMode(bbox);
  const radiusM = Math.max(1200, Math.min(26000, Math.round((diagKm * 1000) / 4.8)));
  const relModes = radiusM > 7000 ? 'ferry|train|subway|light_rail' : 'ferry|train|subway|light_rail|bus';
  const pairsSig = explicitPairObjs
    .slice(0, 12)
    .map((p) => `${p.a.lat.toFixed(2)},${p.a.lng.toFixed(2)}>${p.b.lat.toFixed(2)},${p.b.lng.toFixed(2)}`)
    .join(';');
  const cacheKey = `near3:${scaleMode}:${sampleStops.map((s) => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`).join('|')}:${pairsSig}`;
  const cached = getProviderCache<RawTransitCorridor[]>('near_corridors', cacheKey);
  if (cached && cached.length > 0) {
    return cached;
  }

  const clauses = sampleStops
    .map((s) => {
      const c = `${radiusM},${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
      return `
        way(around:${c})["railway"~"^(rail|highspeed|subway|light_rail|tram)$"];
        way(around:${c})["route"="ferry"];
        relation(around:${c})["route"~"^(${relModes})$"];
        way(around:${c})["highway"~"^(motorway|trunk|primary)$"];
      `;
    })
    .join('\n');

  const query = `
    [out:json][timeout:14];
    (
      ${clauses}
    );
    out body geom 1100;
  `;

  const out: RawTransitCorridor[] = [];
  const seen = new Set<string>();

  if (sampleStops.length > 0) {
    try {
      const winner = await Promise.any(
        OVERPASS_ENDPOINTS.map(async (ep) => {
          const json = await fetchJsonWithTimeout(
            ep,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'User-Agent': USER_AGENT,
              },
              body: `data=${encodeURIComponent(query)}`,
            },
            11000
          );
          if (!isValidOverpassResult(json)) throw new Error('Invalid Overpass near-stop payload');
          return json.elements as any[];
        })
      );

      for (const el of winner) {
        const tags: Record<string, string> = el.tags || {};
        if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
          const id = `way-${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const { mode, weight } = parseCorridorModeAndWeight(tags);
          const step = Math.max(1, Math.floor(el.geometry.length / 26));
          const pts = el.geometry
            .filter((_: any, i: number) => i === el.geometry.length - 1 || i % step === 0)
            .map((g: any) => ({ lat: g.lat, lng: g.lon }));
          out.push({
            id,
            name: tags.name || tags.ref,
            mode,
            weight,
            isTunnel: tags.tunnel === 'yes',
            isBridge: tags.bridge === 'yes',
            points: pts,
          });
        } else if (el.type === 'relation' && Array.isArray(el.members)) {
          const id = `rel-${el.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const { mode, weight } = parseCorridorModeAndWeight(tags);
          const pts: { lat: number; lng: number }[] = [];
          for (const m of el.members) {
            if (!Array.isArray(m.geometry)) continue;
            const step = Math.max(1, Math.floor(m.geometry.length / 8));
            for (let k = 0; k < m.geometry.length; k += step) {
              pts.push({ lat: m.geometry[k].lat, lng: m.geometry[k].lon });
            }
            if (pts.length > 96) break;
          }
          if (pts.length >= 2) {
            out.push({
              id,
              name: tags.name || tags.ref || `${mode.toUpperCase()} Line`,
              mode,
              weight,
              isTunnel: false,
              isBridge: false,
              points: pts,
            });
          }
        }
      }
    } catch {
      // Fall through to OSRM pair highway routing below
    }
  }

  // Always supplement explicit untraced pairs first, then nearest neighbor stop pairs via cached OSRM highway curves
  const osrmStops = effectiveStops.slice(0, 24);
  const pairQueue: Array<{
    a: { id: string; name: string; lat: number; lng: number };
    b: { id: string; name: string; lat: number; lng: number };
  }> = [];
  const queuedKeys = new Set<string>();

  for (const ep of explicitPairObjs) {
    queuedKeys.add(ep.key);
    pairQueue.push({ a: ep.a, b: ep.b });
  }

  for (const s of osrmStops) {
    const nearest = pool
      .filter((o) => o.id !== s.id)
      .map((o) => ({ o, d: haversineKm(s.lat, s.lng, o.lat, o.lng) }))
      .filter((x) => x.d <= Math.max(45, diagKm * 0.5))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    for (const n of nearest) {
      const k = [s.id, n.o.id].sort().join('::');
      if (!queuedKeys.has(k)) {
        queuedKeys.add(k);
        pairQueue.push({ a: s, b: n.o });
      }
    }
  }

  const cappedPairs = pairQueue.slice(0, 28);
  for (let i = 0; i < cappedPairs.length; i += 4) {
    const res = await Promise.allSettled(
      cappedPairs.slice(i, i + 4).map(({ a, b }) => fetchOsrmSingleCorridor(a, b, bbox))
    );
    for (const r of res) {
      if (r.status === 'fulfilled' && r.value && !seen.has(r.value.id)) {
        seen.add(r.value.id);
        out.push(r.value);
      }
    }
  }

  if (out.length > 0) {
    saveProviderCache('near_corridors', cacheKey, out, bbox, out.length);
  }
  if (OSM_FETCHER_DEBUG_LEVEL >= 1) {
    console.log('[osmFetcher] fetchCorridorsNearStops', {
      zoom,
      stopCount: sampleStops.length,
      explicitPairs: explicitPairObjs.length,
      found: out.length,
    });
  }
  return out;
}

const activePyramidWarms = new Set<string>();

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipDatasetToBbox(
  source: RawRegionDataset,
  targetBbox: BoundingBox,
  targetZoom: number,
  targetScaleMode: ScaleMode
): RawRegionDataset {
  const padLat = (targetBbox.north - targetBbox.south) * 0.15;
  const padLng = (targetBbox.east - targetBbox.west) * 0.15;
  const pois = source.pois.filter(
    (p) =>
      p.lat >= targetBbox.south &&
      p.lat <= targetBbox.north &&
      p.lng >= targetBbox.west &&
      p.lng <= targetBbox.east
  );
  const corridors = source.corridors.filter((c) =>
    c.points.some(
      (pt) =>
        pt.lat >= targetBbox.south - padLat &&
        pt.lat <= targetBbox.north + padLat &&
        pt.lng >= targetBbox.west - padLng &&
        pt.lng <= targetBbox.east + padLng
    )
  );
  const hazards = source.hazards.filter(
    (h) =>
      h.lat >= targetBbox.south &&
      h.lat <= targetBbox.north &&
      h.lng >= targetBbox.west &&
      h.lng <= targetBbox.east
  );
  return {
    bbox: targetBbox,
    zoom: targetZoom,
    scaleMode: targetScaleMode,
    pois,
    corridors,
    hazards,
    fetchedAt: source.fetchedAt || new Date().toISOString(),
    sources: source.sources,
  };
}

/**
 * Warms a multi-zoom local cache pyramid around a scanned area:
 * -1 zoom level out (2.0x span), +1 zoom level in (0.5x span), and +2 zoom levels in (0.25x span).
 * Reuses matching-scale covering datasets locally when already rich, or fetches finer/wider data
 * with polite spacing and persists only validated results.
 */
export async function warmZoomPyramidCache(
  baseBbox: BoundingBox,
  baseZoom: number,
  regionLabel: string
): Promise<void> {
  const safeBase = validateBbox(baseBbox);
  const { scaleMode: baseScale } = detectScaleMode(safeBase);
  const guardKey = computeRegionCacheId(safeBase, baseScale);
  if (activePyramidWarms.has(guardKey)) return;
  activePyramidWarms.add(guardKey);

  try {
    const cleanLabel = String(regionLabel || 'Region').replace(/\s*\[z\d+\]$/, '').trim().slice(0, 48);
    const roundedZoom = Math.max(2, Math.min(18, Math.round(baseZoom || 10)));
    const tiers: Array<{ offset: number; factor: number }> = [
      { offset: -1, factor: 2.0 },
      { offset: 1, factor: 0.5 },
      { offset: 2, factor: 0.25 },
    ];

    for (const tier of tiers) {
      const targetZoom = Math.max(2, Math.min(18, roundedZoom + tier.offset));
      const subBbox = scaleBoundingBox(safeBase, tier.factor);
      const { scaleMode: subScale, diagKm } = detectScaleMode(subBbox);

      // Avoid runaway continental zoom-out queries if user is already at whole-continent scale
      if (tier.offset < 0 && diagKm > 3200) continue;

      const subId = computeRegionCacheId(subBbox, subScale);
      const existing = getCachedRegion(subId);
      if (existing && existing.dataset.pois.length >= 3 && existing.dataset.corridors.length > 0) {
        continue;
      }

      // If an already-cached covering dataset at the exact same scale tier has rich stops & corridors inside subBbox,
      // derive the sub-box locally with zero external HTTP traffic.
      const covering = findCoveringCachedRegion(subBbox, subScale, true, 10);
      if (covering && covering.summary.scaleMode === subScale) {
        const clipped = clipDatasetToBbox(covering.dataset, subBbox, targetZoom, subScale);
        if (clipped.pois.length >= 6 && clipped.corridors.length > 0) {
          saveCachedRegion(subId, `${cleanLabel} [z${targetZoom}]`, clipped, true);
          continue;
        }
      }

      await sleepMs(650);
      try {
        const dataset = await fetchRealRegionData(subBbox, targetZoom);
        if (dataset.pois.length >= 3) {
          saveCachedRegion(subId, `${cleanLabel} [z${targetZoom}]`, dataset, true);
        }
      } catch {
        // Never cache failed or sparse responses; keep remaining pyramid levels isolated
      }
    }
  } finally {
    activePyramidWarms.delete(guardKey);
  }
}

export async function geocodePlaceQuery(query: string): Promise<
  Array<{ displayName: string; lat: number; lng: number; bbox: BoundingBox }>
> {
  const clean = query.trim();
  const cacheKey = clean.toLowerCase();
  const cached = getProviderCache<
    Array<{ displayName: string; lat: number; lng: number; bbox: BoundingBox }>
  >('geocode', cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  let results: Array<{ displayName: string; lat: number; lng: number; bbox: BoundingBox }> = [];

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', clean);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '5');

    const items: any[] = await fetchJsonWithTimeout(
      url.toString(),
      { headers: { 'User-Agent': USER_AGENT } },
      7000
    );
    if (Array.isArray(items) && items.length > 0) {
      results = items.map((item) => {
        const bb = item.boundingbox || [];
        return {
          displayName: String(item.display_name),
          lat: Number(item.lat),
          lng: Number(item.lon),
          bbox: {
            south: Number(bb[0] ?? Number(item.lat) - 0.15),
            north: Number(bb[1] ?? Number(item.lat) + 0.15),
            west: Number(bb[2] ?? Number(item.lon) - 0.25),
            east: Number(bb[3] ?? Number(item.lon) + 0.25),
          },
        };
      });
    }
  } catch {
    // Fall back to Photon below
  }

  if (results.length === 0) {
    try {
      const json = await fetchJsonWithTimeout(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(clean)}&limit=5`,
        { headers: { 'User-Agent': USER_AGENT } },
        7000
      );
      const features: any[] = json?.features ?? [];
      results = features
        .filter((f) => Array.isArray(f?.geometry?.coordinates))
        .map((f) => {
          const [lng, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          const extent = Array.isArray(p.extent) && p.extent.length === 4 ? p.extent : null;
          const labelParts = [p.name, p.city, p.state, p.country].filter(Boolean);
          return {
            displayName: labelParts.join(', ') || clean,
            lat: Number(lat),
            lng: Number(lng),
            bbox: extent
              ? {
                  west: Number(extent[0]),
                  north: Number(extent[1]),
                  east: Number(extent[2]),
                  south: Number(extent[3]),
                }
              : {
                  south: Number(lat) - 0.15,
                  north: Number(lat) + 0.15,
                  west: Number(lng) - 0.25,
                  east: Number(lng) + 0.25,
                },
          };
        });
    } catch {
      throw new Error('Geocoding lookup failed across providers.');
    }
  }

  if (results.length > 0) {
    saveProviderCache('geocode', cacheKey, results, undefined, results.length);
  }
  return results;
}

// Optional server-side Gemini AI enrichment (cached when valid so re-runs don't burn quota)
export async function enrichLocationsWithGemini(
  regionLabel: string,
  pois: RawOsmPoi[]
): Promise<Map<string, { cleanName?: string; boost?: number }>> {
  const apiKey = process.env.GEMINI_API_KEY;
  const result = new Map<string, { cleanName?: string; boost?: number }>();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || pois.length === 0) {
    return result;
  }

  const sample = pois.slice(0, 60).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    score: p.osmScore,
  }));
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${regionLabel.toLowerCase()}:${sample.map((s) => s.id).join(',')}`)
    .digest('hex')
    .slice(0, 14);

  const cached = getProviderCache<Array<[string, { cleanName?: string; boost?: number }]>>(
    'gemini_polish',
    cacheKey
  );
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return new Map(cached);
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Region: "${regionLabel}". Given these real-world OSM/Wikipedia locations for a Ticket to Ride board game, return concise board-friendly stop names (max 22 chars, remove redundant "Station" or parentheses only when helpful) and an importance adjustment (-15 to +20) favoring iconic landmarks, cultural hubs, and key geographic terminals.\n\nLocations:\n${JSON.stringify(sample)}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              cleanName: { type: Type.STRING },
              boost: { type: Type.NUMBER },
            },
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '[]').trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      for (const item of parsed) {
        if (item?.id) {
          result.set(String(item.id), {
            cleanName: typeof item.cleanName === 'string' ? item.cleanName.slice(0, 26) : undefined,
            boost: typeof item.boost === 'number' ? Math.max(-15, Math.min(20, item.boost)) : 0,
          });
        }
      }
      if (result.size > 0) {
        saveProviderCache('gemini_polish', cacheKey, Array.from(result.entries()), undefined, result.size);
      }
    }
  } catch {
    // Gracefully fall back to OSM/Wikipedia/Wikidata scores
  }
  return result;
}
