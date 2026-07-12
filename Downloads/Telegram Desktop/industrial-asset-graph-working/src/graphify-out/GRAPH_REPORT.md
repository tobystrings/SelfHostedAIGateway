# Graph Report - src  (2026-07-11)

## Corpus Check
- 7 files · ~6,184 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 38 nodes · 40 edges · 4 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]

## God Nodes (most connected - your core abstractions)
1. `optional()` - 3 edges
2. `parseEvidenceManifest()` - 3 edges
3. `loadPortlandUtilities()` - 3 edges
4. `loadOpenStreetMapContext()` - 3 edges
5. `object()` - 2 edges
6. `sourceUrl()` - 2 edges
7. `uniqueIds()` - 2 edges
8. `sourceHash()` - 2 edges
9. `fetchWithTimeout()` - 2 edges
10. `loadPortlandBuildings()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.29
Nodes (6): fetchWithTimeout(), loadOpenStreetMapContext(), loadPortlandBuildings(), loadPortlandStreets(), loadPortlandUtilities(), loadPortlandUtilityContext()

### Community 2 - "Community 2"
Cohesion: 0.5
Nodes (2): fetchWithTimeout(), loadPortlandPublicRecords()

### Community 5 - "Community 5"
Cohesion: 0.67
Nodes (3): optional(), sourceHash(), sourceUrl()

### Community 6 - "Community 6"
Cohesion: 0.67
Nodes (3): object(), parseEvidenceManifest(), uniqueIds()

## Knowledge Gaps
- **Thin community `Community 2`** (5 nodes): `publicRecords.ts`, `coordinatePairs()`, `fetchWithTimeout()`, `loadPortlandPublicRecords()`, `officialPermitUrl()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `optional()` connect `Community 5` to `Community 1`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `parseEvidenceManifest()` connect `Community 6` to `Community 1`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._