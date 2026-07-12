export interface PublicRecord { id: string; category: 'permit' | 'document' | 'environmental'; title: string; details: string; status: string; sourceClass: 'official-public'; scope: 'nearby-public-context'; sourceUrl: string; capturedAt: string; position: [number, number, number]; }

interface Feature { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown>; }

function coordinatePairs(value: unknown, output: [number, number][] = []): [number, number][] {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') { output.push([value[0], value[1]]); return output; }
  if (Array.isArray(value)) value.forEach((child) => coordinatePairs(child, output));
  return output;
}

async function fetchWithTimeout(url: string, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
}

function officialPermitUrl(value: unknown, fallback: string): string {
  try {
    const url = new URL(String(value));
    return url.hostname === 'www.portlandmaps.com' ? url.href : fallback;
  } catch { return fallback; }
}

export async function loadPortlandPublicRecords(latitude: number, longitude: number): Promise<PublicRecord[]> {
  const fields = 'OBJECTID,PERMIT,TYPE,STATUS,WORK_DESCRIPTION,PORTLAND_MAPS_URL,DESCRIPTION,ISSUED,FINALED';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '160', units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '50', f: 'geojson' });
  const response = await fetchWithTimeout(`https://www.portlandmaps.com/arcgis/rest/services/Public/BDS_Permit/MapServer/22/query?${params}`);
  if (!response.ok) throw new Error(`Portland public-record request failed (${response.status}).`);
  const data = await response.json() as { features?: Feature[] };
  const capturedAt = new Date().toISOString();
  const metersPerLatitude = 111_320;
  const metersPerLongitude = metersPerLatitude * Math.cos(latitude * Math.PI / 180);
  return (data.features ?? []).flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const pairs = coordinatePairs(feature.geometry?.coordinates);
    if (!pairs.length) return [];
    const [lon, lat] = pairs[0];
    const objectId = String(properties.OBJECTID ?? index);
    const permit = String(properties.PERMIT || `Public permit ${objectId}`);
    const fallbackUrl = `https://www.portlandmaps.com/arcgis/rest/services/Public/BDS_Permit/MapServer/22/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`;
    const sourceUrl = officialPermitUrl(properties.PORTLAND_MAPS_URL, fallbackUrl);
    const details = [properties.TYPE, properties.WORK_DESCRIPTION, properties.DESCRIPTION].filter(Boolean).map(String).join(' | ') || 'No public work description returned.';
    return [{ id: `permit-${objectId}`, category: 'permit' as const, title: permit, details, status: String(properties.STATUS || 'Status not returned'), sourceClass: 'official-public' as const, scope: 'nearby-public-context' as const, sourceUrl, capturedAt, position: [((lon - longitude) * metersPerLongitude) / 12, 0.18, -((lat - latitude) * metersPerLatitude) / 12] as [number, number, number] }];
  });
}

export async function loadPortlandPublicDocuments(latitude: number, longitude: number): Promise<PublicRecord[]> {
  const fields = 'OBJECTID,RECORD_TYPE,DOCUMENT_TYPE,PORTLAND_MAPS_URL,STATE_ID';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '160', units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '50', f: 'geojson' });
  const response = await fetchWithTimeout(`https://www.portlandmaps.com/arcgis/rest/services/Public/BDS_Mapped_Document/MapServer/11/query?${params}`);
  if (!response.ok) throw new Error(`Portland public-document request failed (${response.status}).`);
  const data = await response.json() as { features?: Feature[] };
  const capturedAt = new Date().toISOString();
  const metersPerLatitude = 111_320;
  const metersPerLongitude = metersPerLatitude * Math.cos(latitude * Math.PI / 180);
  return (data.features ?? []).flatMap((feature, index) => {
    const pairs = coordinatePairs(feature.geometry?.coordinates);
    if (!pairs.length) return [];
    const properties = feature.properties ?? {};
    const objectId = String(properties.OBJECTID ?? index);
    const [lon, lat] = pairs[0];
    const sourceUrl = officialPermitUrl(properties.PORTLAND_MAPS_URL, `https://www.portlandmaps.com/arcgis/rest/services/Public/BDS_Mapped_Document/MapServer/11/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`);
    return [{ id: `document-${objectId}`, category: 'document' as const, title: String(properties.DOCUMENT_TYPE || properties.RECORD_TYPE || `Public document ${objectId}`), details: [properties.RECORD_TYPE, properties.STATE_ID].filter(Boolean).map(String).join(' | ') || 'No public document details returned.', status: 'Public mapped document', sourceClass: 'official-public' as const, scope: 'nearby-public-context' as const, sourceUrl, capturedAt, position: [((lon - longitude) * metersPerLongitude) / 12, 0.18, -((lat - latitude) * metersPerLatitude) / 12] as [number, number, number] }];
  });
}

export async function loadOregonDeqContext(latitude: number, longitude: number): Promise<PublicRecord[]> {
  const fields = 'OBJECTID,Site_ID,Status,COMMON_NM,Address,City,GWRisk,SWRisk,Data_Source';
  const params = new URLSearchParams({ where: '1=1', geometry: `${longitude},${latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '500', units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'true', outSR: '4326', resultRecordCount: '50', f: 'geojson' });
  const base = 'https://arcgis.deq.state.or.us/arcgis/rest/services/DEQ_Services/PotentialContaminantSources/MapServer/2';
  const response = await fetchWithTimeout(`${base}/query?${params}`);
  if (!response.ok) throw new Error(`Oregon DEQ environmental-context request failed (${response.status}).`);
  const data = await response.json() as { features?: Feature[] };
  const capturedAt = new Date().toISOString();
  const metersPerLatitude = 111_320;
  const metersPerLongitude = metersPerLatitude * Math.cos(latitude * Math.PI / 180);
  return (data.features ?? []).flatMap((feature, index) => {
    const pairs = coordinatePairs(feature.geometry?.coordinates);
    if (!pairs.length) return [];
    const properties = feature.properties ?? {};
    const objectId = String(properties.OBJECTID ?? index);
    const [lon, lat] = pairs[0];
    return [{ id: `deq-${objectId}`, category: 'environmental' as const, title: String(properties.COMMON_NM || properties.Site_ID || `DEQ cleanup context ${objectId}`), details: [properties.Address, properties.City, properties.GWRisk && `Groundwater risk ${properties.GWRisk}`, properties.SWRisk && `Surface-water risk ${properties.SWRisk}`, properties.Data_Source].filter(Boolean).map(String).join(' | ') || 'No DEQ details returned.', status: String(properties.Status || 'Status not returned'), sourceClass: 'official-public' as const, scope: 'nearby-public-context' as const, sourceUrl: `${base}/query?${new URLSearchParams({ f: 'pjson', objectIds: objectId, outFields: fields, returnGeometry: 'true', outSR: '4326' })}`, capturedAt, position: [((lon - longitude) * metersPerLongitude) / 12, 0.18, -((lat - latitude) * metersPerLatitude) / 12] as [number, number, number] }];
  });
}
