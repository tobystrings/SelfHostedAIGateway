export type AssetKind = 'ZONE' | 'ELECTRICAL' | 'CONTROL' | 'SAFETY' | 'PNEUMATIC' | 'HYDRAULIC' | 'STEAM' | 'MAP_CONTEXT';
export type Relation = 'CONTAINS' | 'FEEDS_POWER_TO' | 'CONTROLS' | 'PROTECTS' | 'SUPPLIES_AIR_TO' | 'SUPPLIES_HYDRAULICS_TO' | 'SUPPLIES_STEAM_TO';
export type VerificationStatus = 'verified' | 'field-verify' | 'inferred' | 'retired' | 'disputed';
export type ReviewState = 'unreviewed' | 'accepted' | 'rejected';

export interface Asset {
  id: string;
  label: string;
  kind: AssetKind;
  position: [number, number, number];
  status: 'online' | 'attention' | 'offline';
  details: string;
  source: string;
  sourceUri?: string | null;
  confidence: 'documented' | 'field-verify';
  sourceLocation: string;
  capturedAt: string | null;
  reviewedBy: string | null;
  reviewState: ReviewState;
  verificationStatus: VerificationStatus;
  evidenceGaps: string[];
}

export interface Dependency { id: string; source: string; target: string; relation: Relation; sourceLocation: string; sourceUri?: string | null; evidenceSourceId?: string | null; capturedAt: string | null; reviewedBy: string | null; reviewState: ReviewState; verificationStatus: VerificationStatus; }

export interface MapListing { title: string; address?: string; latitude: number; longitude: number; source: string; sourceUri: string | null; }

// This starter model is intentionally fictional. Replace records only with verified plant documentation.
const starterRecord = { source: 'Starter dataset - not site verified', confidence: 'field-verify' as const, sourceLocation: 'src/graph.ts starter dataset', capturedAt: null, reviewedBy: null, reviewState: 'unreviewed' as const, verificationStatus: 'field-verify' as const, evidenceGaps: ['Asset tag/serial label', 'Physical location and orientation', 'Energy isolation point', 'Source drawing, photo, or field observation'] };
const starterDependency = { sourceLocation: 'src/graph.ts starter dependency', capturedAt: null, reviewedBy: null, reviewState: 'unreviewed' as const, verificationStatus: 'field-verify' as const };

export const assets: Asset[] = [
  { id: 'zone-production', label: 'Production Cell A', kind: 'ZONE', position: [0, -0.25, 0], status: 'online', details: 'Spatial anchor for the demonstration graph.', ...starterRecord },
  { id: 'mcc-1', label: 'MCC-1 / 480V', kind: 'ELECTRICAL', position: [-3.4, 0.3, 1.6], status: 'online', details: 'Main motor control center feeding Cell A loads.', ...starterRecord },
  { id: 'plc-1', label: 'PLC-1', kind: 'CONTROL', position: [-0.2, 0.55, 2.3], status: 'online', details: 'Controls the compressor permissive and machine sequence.', ...starterRecord },
  { id: 'safety-eye-1', label: 'Safety Eye SE-01', kind: 'SAFETY', position: [2.8, 0.45, 2.0], status: 'attention', details: 'Protective device for the infeed zone.', ...starterRecord },
  { id: 'compressor-1', label: 'Air Compressor AC-01', kind: 'PNEUMATIC', position: [-2.8, 0.5, -1.8], status: 'online', details: 'Compressed-air source for tooling in Cell A.', ...starterRecord },
  { id: 'dryer-1', label: 'Air Dryer AD-01', kind: 'PNEUMATIC', position: [0.2, 0.5, -2.3], status: 'online', details: 'Conditions compressed air before distribution.', ...starterRecord },
  { id: 'hyd-1', label: 'Hydraulic Unit HU-01', kind: 'HYDRAULIC', position: [3.2, 0.5, -1.6], status: 'online', details: 'Hydraulic power source for the press station.', ...starterRecord },
  { id: 'boiler-1', label: 'Steam Header SH-01', kind: 'STEAM', position: [4.2, 0.4, 0.35], status: 'offline', details: 'Steam branch shown as unavailable in this demonstration.', ...starterRecord },
];

export const dependencies: Dependency[] = [
  { id: 'd1', source: 'zone-production', target: 'mcc-1', relation: 'CONTAINS', ...starterDependency },
  { id: 'd2', source: 'zone-production', target: 'plc-1', relation: 'CONTAINS', ...starterDependency },
  { id: 'd3', source: 'mcc-1', target: 'compressor-1', relation: 'FEEDS_POWER_TO', ...starterDependency },
  { id: 'd4', source: 'mcc-1', target: 'hyd-1', relation: 'FEEDS_POWER_TO', ...starterDependency },
  { id: 'd5', source: 'plc-1', target: 'compressor-1', relation: 'CONTROLS', ...starterDependency },
  { id: 'd6', source: 'safety-eye-1', target: 'plc-1', relation: 'PROTECTS', ...starterDependency },
  { id: 'd7', source: 'compressor-1', target: 'dryer-1', relation: 'SUPPLIES_AIR_TO', ...starterDependency },
  { id: 'd8', source: 'hyd-1', target: 'zone-production', relation: 'SUPPLIES_HYDRAULICS_TO', ...starterDependency },
  { id: 'd9', source: 'boiler-1', target: 'zone-production', relation: 'SUPPLIES_STEAM_TO', ...starterDependency },
];

export const colorFor: Record<AssetKind, string> = {
  ZONE: '#8aa2a8', ELECTRICAL: '#f4b942', CONTROL: '#49b6d8', SAFETY: '#e85c5c', PNEUMATIC: '#48bd88', HYDRAULIC: '#c975d8', STEAM: '#e8e1c5', MAP_CONTEXT: '#7e9eff',
};

export function connectedAssetIds(id: string, edges: Dependency[] = dependencies) {
  const ids = new Set([id]);
  edges.forEach((edge) => { if (edge.source === id) ids.add(edge.target); if (edge.target === id) ids.add(edge.source); });
  return ids;
}

export function parseGeographicExport(text: string): MapListing[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array from the scraper export.');
  const listings = rows.flatMap((row, index) => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    const latitude = Number(value.latitude ?? value.lat);
    const longitude = Number(value.longitude ?? value.lng ?? value.lon);
    const title = String(value.title ?? value.name ?? `Untitled map record ${index + 1}`).trim();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !title) return [];
    let sourceUri: string | null = null;
    try { const url = new URL(String(value.url ?? value.website ?? value.sourceUrl ?? '')); if (['http:', 'https:'].includes(url.protocol)) sourceUri = url.href; } catch { /* Source URL is optional context metadata. */ }
    return [{ title, latitude, longitude, address: String(value.address ?? '').trim() || undefined, source: 'Imported geographic JSON - field relevance unverified', sourceUri }];
  });
  if (!listings.length) throw new Error('No latitude/longitude records found in the JSON file.');
  return listings;
}

export function mapListingsToAssets(listings: MapListing[]): Asset[] {
  const origin = listings[0];
  const metersPerLatitude = 111_320;
  const metersPerLongitude = metersPerLatitude * Math.cos(origin.latitude * Math.PI / 180);
  return listings.map((listing, index) => ({
    id: `map-context-${index}`,
    label: listing.title,
    kind: 'MAP_CONTEXT',
    position: [((listing.longitude - origin.longitude) * metersPerLongitude) / 12, 0.32, -((listing.latitude - origin.latitude) * metersPerLatitude) / 12],
    status: 'attention',
    details: listing.address ? `${listing.address}. Imported geographic context; it is not an equipment dependency.` : 'Imported geographic context; it is not an equipment dependency.',
    source: listing.source,
    sourceUri: listing.sourceUri,
    confidence: 'field-verify',
    sourceLocation: 'Imported JSON record in this browser session',
    capturedAt: null,
    reviewedBy: null,
    reviewState: 'unreviewed',
    verificationStatus: 'field-verify',
    evidenceGaps: ['Original source file retention', 'Field relevance', 'Relationship to any plant asset'],
  }));
}
