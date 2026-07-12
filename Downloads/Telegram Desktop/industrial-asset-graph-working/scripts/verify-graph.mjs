import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/graph.ts', import.meta.url), 'utf8');
const assetSection = source.slice(source.indexOf('export const assets'), source.indexOf('export const dependencies'));
const assets = [...assetSection.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
if (assets.length < 8) throw new Error('Expected the starter graph to contain the complete cross-system model.');
for (const relation of ['FEEDS_POWER_TO', 'CONTROLS', 'PROTECTS', 'SUPPLIES_AIR_TO', 'SUPPLIES_HYDRAULICS_TO', 'SUPPLIES_STEAM_TO']) {
  if (!source.includes(`relation: '${relation}'`)) throw new Error(`Missing ${relation} dependency type.`);
}
if (!source.includes('Starter dataset - not site verified')) throw new Error('Starter records must retain their provenance disclaimer.');
if (!source.includes('parseGeographicExport') || !source.includes('MAP_CONTEXT')) throw new Error('Geographic imports must remain provenance-preserving context records.');
for (const field of ['sourceLocation', 'capturedAt', 'reviewedBy', 'reviewState', 'verificationStatus']) {
  if (!source.includes(field)) throw new Error(`Missing provenance field: ${field}.`);
}
console.log(`Graph verified: ${assets.length} starter assets with cross-system dependencies and explicit provenance.`);
