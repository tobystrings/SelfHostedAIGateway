import { Dependency, Relation, ReviewState, VerificationStatus } from './graph';

export interface EvidenceSource { id: string; title: string; kind: string; sourceUri: string | null; fileName: string | null; mimeType: string | null; sizeBytes: number | null; sha256: string | null; lastModifiedAt: string | null; importedAt: string | null; capturedAt: string | null; reviewer: string | null; }
export interface EvidenceClaim { id: string; assetId: string; field: string; value: string; unit: string | null; sourceId: string; locator: string; observedAt: string | null; verificationStatus: VerificationStatus; reviewState: ReviewState; reviewer: string | null; }
export interface EvidenceEvent { id: string; assetId: string; kind: string; summary: string; occurredAt: string | null; sourceId: string; locator: string; verificationStatus: VerificationStatus; reviewState: ReviewState; reviewer: string | null; }
export interface EvidenceWorkOrder { id: string; assetId: string; title: string; status: string; sourceId: string; locator: string; verificationStatus: VerificationStatus; reviewState: ReviewState; reviewer: string | null; }
export interface EvidenceData { sources: EvidenceSource[]; claims: EvidenceClaim[]; events: EvidenceEvent[]; jobs: EvidenceWorkOrder[]; dependencies: Dependency[]; }

const relations: Relation[] = ['CONTAINS', 'FEEDS_POWER_TO', 'CONTROLS', 'PROTECTS', 'SUPPLIES_AIR_TO', 'SUPPLIES_HYDRAULICS_TO', 'SUPPLIES_STEAM_TO'];
const statuses: VerificationStatus[] = ['verified', 'field-verify', 'inferred', 'retired', 'disputed'];
const reviews: ReviewState[] = ['unreviewed', 'accepted', 'rejected'];

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Every manifest record must be an object.'); return value as Record<string, unknown>; }
function text(value: unknown, field: string): string { const result = String(value ?? '').trim(); if (!result) throw new Error(`Missing ${field}.`); return result; }
function optional(value: unknown): string | null { const result = String(value ?? '').trim(); return result || null; }
function review(value: unknown): ReviewState { return reviews.includes(value as ReviewState) ? value as ReviewState : 'unreviewed'; }
function status(value: unknown, reviewState: ReviewState, reviewer: string | null, timestamp: string | null): VerificationStatus { const requested = statuses.includes(value as VerificationStatus) ? value as VerificationStatus : 'field-verify'; return requested === 'verified' && (reviewState !== 'accepted' || !reviewer || !timestamp) ? 'field-verify' : requested; }
function sourceUrl(value: unknown): string | null { const uri = optional(value); if (!uri) return null; const parsed = new URL(uri); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Source URI must use http or https.'); return parsed.href; }
function uniqueIds(rows: { id: string }[], label: string) { if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`${label} IDs must be unique.`); }
function sourceHash(value: unknown): string | null { const hash = optional(value); if (!hash) return null; if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Source SHA-256 must be 64 hexadecimal characters.'); return hash.toLowerCase(); }

export function emptyEvidenceData(): EvidenceData { return { sources: [], claims: [], events: [], jobs: [], dependencies: [] }; }

async function sha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function attachEvidenceFiles(data: EvidenceData, files: File[]): Promise<{ data: EvidenceData; attached: number; unmatched: number }> {
  if (files.some((file) => file.size > 64 * 1024 * 1024)) throw new Error('Local evidence files must be 64 MB or smaller for browser hashing.');
  if (new Set(files.map((file) => file.name)).size !== files.length) throw new Error('Selected evidence files must have unique filenames.');
  const declaredNames = data.sources.flatMap((source) => source.fileName ? [source.fileName] : []);
  if (new Set(declaredNames).size !== declaredNames.length) throw new Error('Manifest source filenames must be unique.');
  const filesByName = new Map(files.map((file) => [file.name, file]));
  let attached = 0;
  const sources = await Promise.all(data.sources.map(async (source) => {
    const file = source.fileName ? filesByName.get(source.fileName) : undefined;
    if (!file) return source;
    const digest = await sha256(file);
    if (source.sha256 && source.sha256 !== digest) throw new Error(`SHA-256 mismatch for ${file.name}.`);
    attached += 1;
    return { ...source, fileName: file.name, mimeType: file.type || null, sizeBytes: file.size, sha256: digest, lastModifiedAt: new Date(file.lastModified).toISOString(), importedAt: new Date().toISOString() };
  }));
  return { data: { ...data, sources }, attached, unmatched: files.length - attached };
}

export function parseEvidenceManifest(textContent: string, knownAssetIds: Set<string>): EvidenceData {
  const root = object(JSON.parse(textContent));
  if (root.version !== 'asset-evidence/v1') throw new Error('Expected an asset-evidence/v1 JSON manifest.');
  const sources = (Array.isArray(root.sources) ? root.sources : []).map((raw) => {
    const row = object(raw);
    return { id: text(row.id, 'source id'), title: text(row.title, 'source title'), kind: text(row.kind, 'source kind'), sourceUri: sourceUrl(row.sourceUri), fileName: optional(row.fileName), mimeType: null, sizeBytes: null, sha256: sourceHash(row.sha256), lastModifiedAt: null, importedAt: null, capturedAt: optional(row.capturedAt), reviewer: optional(row.reviewer) };
  });
  const sourceIds = new Set(sources.map((source) => source.id));
  if (sourceIds.size !== sources.length) throw new Error('Source IDs must be unique.');
  const assetId = (value: unknown) => { const id = text(value, 'assetId'); if (!knownAssetIds.has(id)) throw new Error(`Unknown assetId: ${id}.`); return id; };
  const sourceId = (value: unknown) => { const id = text(value, 'sourceId'); if (!sourceIds.has(id)) throw new Error(`Unknown sourceId: ${id}.`); return id; };
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const claimRows = Array.isArray(root.claims) ? root.claims : [];
  const claims = claimRows.map((raw) => { const row = object(raw); const reviewState = review(row.reviewState); const source = sourceById.get(sourceId(row.sourceId))!; const reviewer = optional(row.reviewer) ?? source.reviewer; const observedAt = optional(row.observedAt) ?? source.capturedAt; return { id: text(row.id, 'claim id'), assetId: assetId(row.assetId), field: text(row.field, 'claim field'), value: text(row.value, 'claim value'), unit: optional(row.unit), sourceId: source.id, locator: text(row.locator, 'claim locator'), observedAt, verificationStatus: status(row.verificationStatus, reviewState, reviewer, observedAt), reviewState, reviewer }; });
  uniqueIds(claims, 'Claim');
  const events = (Array.isArray(root.events) ? root.events : []).map((raw) => { const row = object(raw); const reviewState = review(row.reviewState); const source = sourceById.get(sourceId(row.sourceId))!; const reviewer = optional(row.reviewer) ?? source.reviewer; const occurredAt = optional(row.occurredAt) ?? source.capturedAt; return { id: text(row.id, 'event id'), assetId: assetId(row.assetId), kind: text(row.kind, 'event kind'), summary: text(row.summary, 'event summary'), occurredAt, sourceId: source.id, locator: text(row.locator, 'event locator'), verificationStatus: status(row.verificationStatus, reviewState, reviewer, occurredAt), reviewState, reviewer }; });
  uniqueIds(events, 'Event');
  const jobs = (Array.isArray(root.jobs) ? root.jobs : []).map((raw) => { const row = object(raw); const reviewState = review(row.reviewState); const source = sourceById.get(sourceId(row.sourceId))!; const reviewer = optional(row.reviewer) ?? source.reviewer; const observedAt = optional(row.observedAt) ?? source.capturedAt; return { id: text(row.id, 'job id'), assetId: assetId(row.assetId), title: text(row.title, 'job title'), status: text(row.status, 'job status'), sourceId: source.id, locator: text(row.locator, 'job locator'), verificationStatus: status(row.verificationStatus, reviewState, reviewer, observedAt), reviewState, reviewer }; });
  uniqueIds(jobs, 'Job');
  const dependencies = (Array.isArray(root.dependencies) ? root.dependencies : []).map((raw) => { const row = object(raw); const reviewState = review(row.reviewState); const relation = text(row.relation, 'dependency relation') as Relation; if (!relations.includes(relation)) throw new Error(`Unsupported dependency relation: ${relation}.`); const evidence = sourceById.get(sourceId(row.sourceId))!; const reviewer = optional(row.reviewer) ?? evidence.reviewer; return { id: `evidence-${text(row.id, 'dependency id')}`, source: assetId(row.source), target: assetId(row.target), relation, sourceLocation: `${evidence.title} | ${text(row.locator, 'dependency locator')}`, sourceUri: evidence.sourceUri, evidenceSourceId: evidence.id, capturedAt: evidence.capturedAt, reviewedBy: reviewer, reviewState, verificationStatus: status(row.verificationStatus, reviewState, reviewer, evidence.capturedAt) }; });
  uniqueIds(dependencies, 'Dependency');
  return { sources, claims, events, jobs, dependencies };
}
