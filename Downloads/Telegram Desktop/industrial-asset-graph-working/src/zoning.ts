export interface ZoningArea { id: string; zone: string; sourceUrl: string; capturedAt: string; geometry: [number, number][]; }
export interface ParcelArea { id: string; label: string; sourceUrl: string; capturedAt: string; geometry: [number, number][]; }

interface Feature { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown>; }

function ring(feature: Feature): unknown[] | null {
  const coordinates = feature.geometry?.coordinates as unknown[] | undefined;
  if (feature.geometry?.type === 'Polygon') return Array.isArray(coordinates?.[0]) ? coordinates[0] as unknown[] : null;
  if (feature.geometry?.type === 'MultiPolygon') return Array.isArray(coordinates?.[0]) && Array.isArray((coordinates[0] as unknown[])[0]) ? (coordinates[0] as unknown[])[0] as unknown[] : null;
  return null;
}

export async function loadPortlandZoning(latitude: number, longitude: number, radius: number): Promise<ZoningArea[]> {
  const fields = 'OBJECTID,ZONE';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: String(Math.min(radius, 1_000)), units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '60', f: 'geojson' });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://www.portlandmaps.com/arcgis/rest/services/Public/Zoning/MapServer/0/query?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Portland zoning request failed (${response.status}).`);
    const data = await response.json() as { features?: Feature[] };
    const capturedAt = new Date().toISOString();
    return (data.features ?? []).flatMap((feature, index) => {
      const points = (ring(feature) ?? []).flatMap((point): [number, number][] => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) ? [[Number(point[1]), Number(point[0])]] : []);
      if (points.length < 3) return [];
      const objectId = String(feature.properties?.OBJECTID ?? index);
      return [{ id: `zone-${objectId}`, zone: String(feature.properties?.ZONE ?? 'Public zoning area'), sourceUrl: `https://www.portlandmaps.com/arcgis/rest/services/Public/Zoning/MapServer/0/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`, capturedAt, geometry: points }];
    });
  } finally { window.clearTimeout(timeout); }
}

export async function loadWashingtonCountyParcel(latitude: number, longitude: number): Promise<ParcelArea[]> {
  const fields = 'OBJECTID,TLNO,MAPNO';
  const serviceUrl = 'https://gispub.co.washington.or.us/server/rest/services/Washington_County_Taxlots/FeatureServer/0';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '5', f: 'geojson' });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${serviceUrl}/query?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Washington County parcel request failed (${response.status}).`);
    const data = await response.json() as { features?: Feature[] };
    const capturedAt = new Date().toISOString();
    return (data.features ?? []).flatMap((feature, index) => {
      const points = (ring(feature) ?? []).flatMap((point): [number, number][] => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) ? [[Number(point[1]), Number(point[0])]] : []);
      if (points.length < 3) return [];
      const objectId = String(feature.properties?.OBJECTID ?? index);
      const taxlot = String(feature.properties?.TLNO || `Tax lot ${objectId}`);
      const mapNumber = String(feature.properties?.MAPNO || '').trim();
      const label = mapNumber ? `${taxlot} (map ${mapNumber})` : taxlot;
      return [{ id: `washco-parcel-${objectId}`, label, sourceUrl: `${serviceUrl}/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`, capturedAt, geometry: points }];
    });
  } finally { window.clearTimeout(timeout); }
}
