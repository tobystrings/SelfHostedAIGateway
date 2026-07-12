export interface BuildingFootprint { id: string; name: string; heightMeters: number; approximateHeight: boolean; isFacilityCandidate: boolean; sourceLabel: string; recordId: string; sourceUrl: string; capturedAt: string; geometry: [number, number][]; }
export interface StreetPath { id: string; name: string; kind: string; sourceLabel: string; recordId: string; sourceUrl: string; capturedAt: string; geometry: [number, number][]; }
export interface UtilityPath { id: string; kind: 'water' | 'sewer'; objectId: string; attributeSummary: string; sourceUrl: string; capturedAt: string; geometry: [number, number][]; }
export interface OpenStreetMapContext { buildings: BuildingFootprint[]; streets: StreetPath[]; buildingSource: 'Portland public GIS' | 'OpenStreetMap'; streetSource: 'Portland public GIS' | 'OpenStreetMap' | 'None'; }

interface OverpassWay { id: number; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>; }

interface PortlandFeature { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown>; }

async function fetchWithTimeout(url: string, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
}

function validPath(points: { lat: number; lon: number }[], closed: boolean): [number, number][] {
  const path: [number, number][] = [];
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    const current: [number, number] = [point.lat, point.lon];
    const previous = path.at(-1);
    if (!previous || previous[0] !== current[0] || previous[1] !== current[1]) path.push(current);
  }
  if (closed && path.length > 1 && path[0][0] === path.at(-1)![0] && path[0][1] === path.at(-1)![1]) path.pop();
  return path.length >= (closed ? 3 : 2) ? path : [];
}

function markNearestFacilityCandidate(buildings: BuildingFootprint[], latitude: number, longitude: number): BuildingFootprint[] {
  if (!buildings.length) return buildings;
  const metersPerLatitude = 111_320;
  const metersPerLongitude = metersPerLatitude * Math.cos(latitude * Math.PI / 180);
  const distance = (building: BuildingFootprint) => Math.min(...building.geometry.map(([lat, lon]) => Math.hypot((lat - latitude) * metersPerLatitude, (lon - longitude) * metersPerLongitude)));
  const candidate = buildings.reduce((nearest, building) => distance(building) < distance(nearest) ? building : nearest);
  return buildings.map((building) => ({
    ...building,
    isFacilityCandidate: building.id === candidate.id,
    name: building.id === candidate.id ? `Candidate facility footprint (${building.name})` : building.name,
  }));
}

async function loadPortlandBuildings(latitude: number, longitude: number, radius: number): Promise<BuildingFootprint[]> {
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: String(radius), units: 'esriSRUnit_Meter', outFields: 'BLDG_ID,BLDG_NAME,BLDG_ADDR,AVG_HEIGHT,NUM_STORY,HEIGHT_SRC,SOURCE', returnGeometry: 'true', outSR: '4326', resultRecordCount: '350', f: 'geojson' });
  const response = await fetch(`https://www.portlandmaps.com/arcgis/rest/services/Public/CGIS_Layers/MapServer/1/query?${params}`);
  if (!response.ok) throw new Error(`Portland building request failed (${response.status}).`);
  const data = await response.json() as { features?: PortlandFeature[] };
  const capturedAt = new Date().toISOString();
  return (data.features ?? []).flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const rawCoordinates = feature.geometry?.coordinates as unknown[] | undefined;
    const coordinates = feature.geometry?.type === 'Polygon' ? rawCoordinates?.[0] : feature.geometry?.type === 'MultiPolygon' ? (rawCoordinates?.[0] as unknown[] | undefined)?.[0] : undefined;
    if (!Array.isArray(coordinates)) return [];
    const geometry = validPath((coordinates as unknown[]).flatMap((point): { lat: number; lon: number }[] => {
      if (!Array.isArray(point) || point.length < 2) return [];
      return [{ lat: Number(point[1]), lon: Number(point[0]) }];
    }), true);
    if (!geometry.length) return [];
    const feet = Number(properties.AVG_HEIGHT);
    const stories = Number(properties.NUM_STORY);
    const heightMeters = Number.isFinite(feet) && feet > 0 ? Math.min(feet * 0.3048, 80) : Number.isFinite(stories) ? Math.min(Math.max(stories * 3.5, 3), 80) : 6;
    const name = String(properties.BLDG_NAME || properties.BLDG_ADDR || `Portland building ${index + 1}`);
    const recordId = String(properties.BLDG_ID || index);
    const sourceUrl = `https://www.portlandmaps.com/arcgis/rest/services/Public/CGIS_Layers/MapServer/1/query?${new URLSearchParams({ f: 'pjson', where: `BLDG_ID='${recordId}'`, outFields: '*', returnGeometry: 'true', outSR: '4326' })}`;
    return [{ id: `portland-${recordId}`, name, heightMeters, approximateHeight: !(Number.isFinite(feet) && feet > 0), isFacilityCandidate: false, sourceLabel: 'Portland public building footprint', recordId, sourceUrl, capturedAt, geometry }];
  });
}

function lineGeometries(feature: PortlandFeature): unknown[][] {
  const coordinates = feature.geometry?.coordinates;
  if (feature.geometry?.type === 'LineString' && Array.isArray(coordinates)) return [coordinates];
  if (feature.geometry?.type === 'MultiLineString' && Array.isArray(coordinates)) return coordinates.filter(Array.isArray);
  return [];
}

function streetKind(cfcc: unknown): string {
  const code = String(cfcc ?? '');
  if (code.startsWith('A1')) return 'primary';
  if (code.startsWith('A2')) return 'secondary';
  if (code.startsWith('A3')) return 'tertiary';
  return 'residential';
}

async function loadPortlandStreets(latitude: number, longitude: number, radius: number): Promise<StreetPath[]> {
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: String(radius), units: 'esriSRUnit_Meter', outFields: 'OBJECTID,FULL_NAME,CFCC,TYPE', returnGeometry: 'true', outSR: '4326', resultRecordCount: '300', f: 'geojson' });
  const response = await fetch(`https://www.portlandmaps.com/arcgis/rest/services/Public/Street_Centerlines/MapServer/0/query?${params}`);
  if (!response.ok) throw new Error(`Portland street request failed (${response.status}).`);
  const data = await response.json() as { features?: PortlandFeature[] };
  const capturedAt = new Date().toISOString();
  return (data.features ?? []).flatMap((feature, index) => {
    const geometry = lineGeometries(feature)[0];
    if (!geometry) return [];
    const path = validPath(geometry.flatMap((point): { lat: number; lon: number }[] => Array.isArray(point) && point.length >= 2 ? [{ lat: Number(point[1]), lon: Number(point[0]) }] : []), false);
    const recordId = String(feature.properties?.OBJECTID ?? index);
    const sourceUrl = `https://www.portlandmaps.com/arcgis/rest/services/Public/Street_Centerlines/MapServer/0/query?${new URLSearchParams({ f: 'pjson', objectIds: recordId, outFields: '*', returnGeometry: 'true', outSR: '4326' })}`;
    return path.length ? [{ id: `portland-street-${recordId}`, name: String(feature.properties?.FULL_NAME ?? 'Unnamed street'), kind: streetKind(feature.properties?.CFCC), sourceLabel: 'Portland public street centerline', recordId, sourceUrl, capturedAt, geometry: path }] : [];
  });
}

async function loadPortlandUtilities(latitude: number, longitude: number, kind: UtilityPath['kind'], layer: number): Promise<UtilityPath[]> {
  const fields = kind === 'water' ? 'OBJECTID,MATERIAL,MAINSIZE' : 'OBJECTID,SYMBOL_GROUP,PIPESIZE,MATERIAL,SERVSTAT';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '250', units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '300', f: 'geojson' });
  const service = kind === 'water' ? 'Utilities_Water' : 'Utilities_Sewer';
  const layerUrl = `https://www.portlandmaps.com/arcgis/rest/services/Public/${service}/MapServer/${layer}`;
  const response = await fetchWithTimeout(`https://www.portlandmaps.com/arcgis/rest/services/Public/${service}/MapServer/${layer}/query?${params}`);
  if (!response.ok) throw new Error(`Portland ${kind} context request failed (${response.status}).`);
  const data = await response.json() as { features?: PortlandFeature[] };
  const capturedAt = new Date().toISOString();
  return (data.features ?? []).flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const objectId = String(properties.OBJECTID ?? `${index}`);
    const attributeSummary = kind === 'water' ? [properties.MATERIAL && `Material ${properties.MATERIAL}`, properties.MAINSIZE && `Main size ${properties.MAINSIZE}`].filter(Boolean).join(' | ') : [properties.SYMBOL_GROUP, properties.PIPESIZE && `Pipe size ${properties.PIPESIZE}`, properties.MATERIAL && `Material ${properties.MATERIAL}`, properties.SERVSTAT && `Service ${properties.SERVSTAT}`].filter(Boolean).join(' | ');
    const sourceUrl = `${layerUrl}/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`;
    return lineGeometries(feature).flatMap((line, segment) => {
    const geometry = validPath(line.flatMap((point): { lat: number; lon: number }[] => Array.isArray(point) && point.length >= 2 ? [{ lat: Number(point[1]), lon: Number(point[0]) }] : []), false);
    return geometry.length ? [{ id: `${kind}-${objectId}-${segment}`, kind, objectId, attributeSummary: attributeSummary || 'No returned public attributes', sourceUrl, capturedAt, geometry }] : [];
    });
  });
}

export async function loadPortlandUtilityContext(latitude: number, longitude: number): Promise<UtilityPath[]> {
  const results = await Promise.allSettled([
    loadPortlandUtilities(latitude, longitude, 'water', 8),
    loadPortlandUtilities(latitude, longitude, 'sewer', 3),
  ]);
  const paths = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!paths.length && results.every((result) => result.status === 'rejected')) throw new Error('Portland public utility context is unavailable.');
  return paths;
}

export async function loadOpenStreetMapContext(latitude: number, longitude: number, radius = 400): Promise<OpenStreetMapContext> {
  const boundedRadius = Math.min(Math.max(radius, 25), 5_000);
  const [portlandBuildings, portlandStreets] = await Promise.all([
    loadPortlandBuildings(latitude, longitude, boundedRadius).catch(() => []),
    loadPortlandStreets(latitude, longitude, boundedRadius).catch(() => []),
  ]);
  if (portlandBuildings.length) return { buildings: markNearestFacilityCandidate(portlandBuildings, latitude, longitude), streets: portlandStreets, buildingSource: 'Portland public GIS', streetSource: portlandStreets.length ? 'Portland public GIS' : 'None' };
  const query = `[out:json][timeout:15];(way(around:${boundedRadius},${latitude},${longitude})[building];way(around:${boundedRadius},${latitude},${longitude})[highway~"^(primary|secondary|tertiary|residential|service|unclassified)$"];);out tags geom;`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    let ways: OverpassWay[] = [];
    let osmError: unknown;
    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: query }), signal: controller.signal });
      if (!response.ok) throw new Error(`OpenStreetMap request failed (${response.status}).`);
      const data = await response.json() as { elements?: OverpassWay[] };
      ways = (data.elements ?? []).slice(0, 800);
    } catch (error) { osmError = error; }
    const buildings = ways.filter((way) => way.tags?.building).slice(0, 350).flatMap((way) => {
      const geometry = validPath(way.geometry ?? [], true);
      if (!geometry.length) return [];
      const height = Number(way.tags?.height);
      const levels = Number(way.tags?.['building:levels']);
      const approximateHeight = !Number.isFinite(height);
      const heightMeters = Number.isFinite(height) ? Math.min(Math.max(height, 3), 80) : Number.isFinite(levels) ? Math.min(Math.max(levels * 3.5, 3), 80) : 6;
      return [{ id: `osm-${way.id}`, name: way.tags?.name ?? way.tags?.building ?? `OSM building ${way.id}`, heightMeters, approximateHeight, isFacilityCandidate: false, sourceLabel: 'OpenStreetMap building', recordId: String(way.id), sourceUrl: `https://www.openstreetmap.org/way/${way.id}`, capturedAt: new Date().toISOString(), geometry }];
    });
    const streets = ways.filter((way) => way.tags?.highway).slice(0, 300).flatMap((way) => {
      const geometry = validPath(way.geometry ?? [], false);
      return geometry.length ? [{ id: `osm-road-${way.id}`, name: way.tags?.name ?? 'Unnamed street', kind: way.tags!.highway, sourceLabel: 'OpenStreetMap street', recordId: String(way.id), sourceUrl: `https://www.openstreetmap.org/way/${way.id}`, capturedAt: new Date().toISOString(), geometry }] : [];
    });
    const contextStreets = streets.length ? streets : portlandStreets;
    const streetSource: OpenStreetMapContext['streetSource'] = streets.length ? 'OpenStreetMap' : portlandStreets.length ? 'Portland public GIS' : 'None';
    if (portlandBuildings.length) return { buildings: markNearestFacilityCandidate(portlandBuildings, latitude, longitude), streets: contextStreets, buildingSource: 'Portland public GIS', streetSource };
    if (ways.length) return { buildings: markNearestFacilityCandidate(buildings, latitude, longitude), streets: contextStreets, buildingSource: 'OpenStreetMap', streetSource };
    if (osmError) throw osmError;
    return { buildings: [], streets: contextStreets, buildingSource: 'OpenStreetMap', streetSource };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('OpenStreetMap request timed out.');
    throw error;
  } finally { window.clearTimeout(timeout); }
}
