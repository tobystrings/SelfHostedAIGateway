import { ChangeEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
const AssetScene = lazy(() => import("./AssetScene").then((module) => ({ default: module.AssetScene })));
import {
  Asset,
  assets,
  colorFor,
  dependencies,
  mapListingsToAssets,
  parseGeographicExport,
} from "./graph";
import {
  attachEvidenceFiles,
  emptyEvidenceData,
  EvidenceData,
  EvidenceSource,
  parseEvidenceManifest,
} from "./evidence";
import {
  BuildingFootprint,
  loadOpenStreetMapContext,
  loadPortlandUtilityContext,
  StreetPath,
  UtilityPath,
} from "./osm";
import { loadOregonDeqContext, loadPortlandPublicDocuments, loadPortlandPublicRecords, PublicRecord } from "./publicRecords";
import { loadPortlandZoning, loadWashingtonCountyParcel, ParcelArea, ZoningArea } from "./zoning";
import { aerialImageUrl, terrainImageUrl } from "./aerial";

type AssetTab = "overview" | "specs" | "history" | "jobs";
type SelectedMapContext =
  | { kind: "building"; record: BuildingFootprint }
  | { kind: "street"; record: StreetPath };
type PublicLayerState = {
  state: "current" | "stale" | "unavailable" | "off" | "loading";
  source: string;
  query: string;
  retrievedAt: string | null;
};

const DEFAULT_SITE = {
  label: "2550 23rd Ave, Forest Grove, OR 97116",
  latitude: 45.523803,
  longitude: -123.1027909,
} as const;
const tabs: AssetTab[] = ["overview", "specs", "history", "jobs"];

export default function App() {
  const [selected, setSelected] = useState<Asset | null>(assets[1]);
  const [isolate, setIsolate] = useState(false);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("ALL");
  const [showFieldVerifyElectrical, setShowFieldVerifyElectrical] = useState(true);
  const [showFieldVerifyPneumatic, setShowFieldVerifyPneumatic] = useState(true);
  const [viewCommand, setViewCommand] = useState<{ preset: "recenter" | "aerial" | "operator"; revision: number }>({ preset: "recenter", revision: 0 });
  const [activeTab, setActiveTab] = useState<AssetTab>("overview");
  const [importedAssets, setImportedAssets] = useState<Asset[]>([]);
  const [importMessage, setImportMessage] = useState(
    "No geographic context imported.",
  );
  const [evidence, setEvidence] = useState<EvidenceData>(emptyEvidenceData);
  const [evidenceMessage, setEvidenceMessage] = useState(
    "No evidence manifest imported.",
  );
  const localSourceUrls = useRef(new Map<string, string>());
  const [origin, setOrigin] = useState<[number, number]>([
    DEFAULT_SITE.latitude, DEFAULT_SITE.longitude,
  ]);
  const [siteLabel, setSiteLabel] = useState<string>(DEFAULT_SITE.label);
  const [footprints, setFootprints] = useState<BuildingFootprint[]>([]);
  const [streets, setStreets] = useState<StreetPath[]>([]);
  const [utilities, setUtilities] = useState<UtilityPath[]>([]);
  const [showUtilities, setShowUtilities] = useState(true);
  const [utilityStatus, setUtilityStatus] = useState("Public utilities off.");
  const [utilityFilter, setUtilityFilter] = useState<"water" | "sewer" | "all">(
    "all",
  );
  const [selectedUtility, setSelectedUtility] = useState<UtilityPath | null>(
    null,
  );
  const [selectedMapContext, setSelectedMapContext] =
    useState<SelectedMapContext | null>(null);
  const [publicRecords, setPublicRecords] = useState<PublicRecord[]>([]);
  const [showRecords, setShowRecords] = useState(true);
  const [recordsStatus, setRecordsStatus] = useState("Public records off.");
  const [selectedRecord, setSelectedRecord] = useState<PublicRecord | null>(
    null,
  );
  const [selectedRecordCluster, setSelectedRecordCluster] = useState<
    PublicRecord[]
  >([]);
  const [publicDocuments, setPublicDocuments] = useState<PublicRecord[]>([]);
  const [showDocuments, setShowDocuments] = useState(true);
  const [environmentalRecords, setEnvironmentalRecords] = useState<PublicRecord[]>([]);
  const [showEnvironmental, setShowEnvironmental] = useState(true);
  const [zones, setZones] = useState<ZoningArea[]>([]);
  const [showZoning, setShowZoning] = useState(true);
  const [selectedZone, setSelectedZone] = useState<ZoningArea | null>(null);
  const [parcels, setParcels] = useState<ParcelArea[]>([]);
  const [showParcels, setShowParcels] = useState(true);
  const [selectedParcel, setSelectedParcel] = useState<ParcelArea | null>(null);
  const [showAerial, setShowAerial] = useState(true);
  const [aerialUrl, setAerialUrl] = useState<string | null>(null);
  const [showTerrain, setShowTerrain] = useState(true);
  const [startupPhase, setStartupPhase] = useState(0);
  const [terrainUrl, setTerrainUrl] = useState<string | null>(null);
  const [contextOpacity, setContextOpacity] = useState(0.4);
  const [contextRadius, setContextRadius] = useState(250);
  const [mapContextStatus, setMapContextStatus] = useState(
    `Loading public map context near ${DEFAULT_SITE.label}...`,
  );
  const [mapLayer, setMapLayer] = useState<PublicLayerState>({
    state: "loading",
    source: "OpenStreetMap and Portland public GIS",
    query: "500 m radius",
    retrievedAt: null,
  });
  const [utilityLayer, setUtilityLayer] = useState<PublicLayerState>({
    state: "off",
    source: "Portland public utilities GIS",
    query: "250 m radius; water and sewer",
    retrievedAt: null,
  });
  const [recordLayer, setRecordLayer] = useState<PublicLayerState>({
    state: "off",
    source: "Portland BDS permit GIS",
    query: "160 m radius; maximum 50 records",
    retrievedAt: null,
  });
  const [zoningLayer, setZoningLayer] = useState<PublicLayerState>({
    state: "off",
    source: "Portland zoning GIS",
    query: "up to 1,000 m radius; maximum 60 areas",
    retrievedAt: null,
  });
  const [parcelLayer, setParcelLayer] = useState<PublicLayerState>({
    state: "off",
    source: "Washington County taxlot GIS",
    query: "tax lot containing the map origin",
    retrievedAt: null,
  });
  const [aerialLayer, setAerialLayer] = useState<PublicLayerState>({ state: "off", source: "Oregon Statewide Imagery Program 2024", query: "up to 1,500 m radius", retrievedAt: null });
  const [terrainLayer, setTerrainLayer] = useState<PublicLayerState>({ state: "off", source: "USGS 3DEP elevation image service", query: "up to 1,500 m radius", retrievedAt: null });
  const [documentLayer, setDocumentLayer] = useState<PublicLayerState>({ state: "off", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: null });
  const [environmentalLayer, setEnvironmentalLayer] = useState<PublicLayerState>({ state: "off", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: null });
  useEffect(() => {
    const timers = [1, 2, 3, 4, 5, 6].map((phase) => window.setTimeout(() => setStartupPhase(phase), phase * 350));
    return () => timers.forEach(window.clearTimeout);
  }, []);
  const displayAssets = useMemo(() => [...assets, ...importedAssets], [importedAssets]);
  const displayDependencies = [...dependencies, ...evidence.dependencies];
  const visibleAssets = useMemo(() => displayAssets.filter((asset) =>
    !(!showFieldVerifyElectrical && asset.kind === "ELECTRICAL" && asset.verificationStatus === "field-verify") &&
    !(!showFieldVerifyPneumatic && asset.kind === "PNEUMATIC" && asset.verificationStatus === "field-verify")
  ), [displayAssets, showFieldVerifyElectrical, showFieldVerifyPneumatic]);
  const visibleAssetIds = new Set(visibleAssets.map((asset) => asset.id));
  const visibleDependencies = displayDependencies.filter((edge) => visibleAssetIds.has(edge.source) && visibleAssetIds.has(edge.target));
  const visibleUtilities = utilities.filter(
    (utility) => utilityFilter === "all" || utility.kind === utilityFilter,
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleAssets.filter(
      (asset) =>
        (kindFilter === "ALL" || asset.kind === kindFilter) &&
        (!needle ||
          [
            asset.label,
            asset.id,
            asset.kind,
            asset.source,
            asset.sourceLocation,
            ...asset.evidenceGaps,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [visibleAssets, kindFilter, query]);
  useEffect(() => {
    if (selected && !visibleAssetIds.has(selected.id)) {
      setSelected(null);
      setIsolate(false);
    }
  }, [selected, showFieldVerifyElectrical, showFieldVerifyPneumatic]);
  const related = selected
    ? visibleDependencies.filter(
        (edge) => edge.source === selected.id || edge.target === selected.id,
      )
    : [];
  const sourceById = useMemo(
    () => new Map(evidence.sources.map((source) => [source.id, source])),
    [evidence.sources],
  );
  const selectedClaims = selected
    ? evidence.claims.filter((claim) => claim.assetId === selected.id)
    : [];
  const selectedEvents = selected
    ? evidence.events.filter((event) => event.assetId === selected.id)
    : [];
  const selectedJobs = selected
    ? evidence.jobs.filter((job) => job.assetId === selected.id)
    : [];
  const publicLayers = [mapLayer, utilityLayer, recordLayer, documentLayer, environmentalLayer, zoningLayer, parcelLayer, aerialLayer, terrainLayer];
  const loadedLayerCount = publicLayers.filter((layer) => layer.state === "current").length;
  const loadingLayerCount = publicLayers.filter((layer) => layer.state === "loading").length;
  const unavailableLayerCount = publicLayers.filter((layer) => layer.state === "unavailable").length;
  const layerText = (name: string, layer: PublicLayerState) =>
    `${name}: ${layer.state} | ${layer.source} | ${layer.query}${layer.retrievedAt ? ` | retrieved ${new Date(layer.retrievedAt).toLocaleString()}` : ""}`;
  const clearLocalSources = () => {
    localSourceUrls.current.forEach((url) => URL.revokeObjectURL(url));
    localSourceUrls.current.clear();
  };
  const sourceReference = (source: EvidenceSource | undefined) => {
    if (!source) return null;
    const localUrl = localSourceUrls.current.get(source.id);
    return (
      <>
        {source.sourceUri ? (
          <a href={source.sourceUri} target="_blank" rel="noreferrer">
            {source.title}
          </a>
        ) : (
          source.title
        )}
        {source.fileName && (
          <>
            {" "}
            | {source.fileName}
            {source.sizeBytes !== null &&
              ` (${source.sizeBytes.toLocaleString()} bytes)`}
          </>
        )}
        {localUrl && (
          <>
            {" "}
            |{" "}
            <a href={localUrl} target="_blank" rel="noreferrer">
              Open imported original
            </a>
          </>
        )}
      </>
    );
  };

  useEffect(
    () => () => {
      clearLocalSources();
    },
    [],
  );

  useEffect(() => {
    let current = true;
    setFootprints([]);
    setStreets([]);
    setMapContextStatus("Loading public OSM building context...");
    setMapLayer({
      state: "loading",
      source: "OpenStreetMap and Portland public GIS",
      query: `${contextRadius} m radius`,
      retrievedAt: null,
    });
    loadOpenStreetMapContext(...origin, contextRadius)
      .then((context) => {
        if (current) {
          const retrievedAt = new Date().toISOString();
          setFootprints(context.buildings);
          setStreets(context.streets);
          setMapContextStatus(
            `${context.buildingSource}: ${context.buildings.length} buildings; nearest footprint highlighted as an unverified facility candidate | ${context.streetSource}: ${context.streets.length} streets. Not an equipment source.`,
          );
          setMapLayer({
            state: "current",
            source: `${context.buildingSource}; ${context.streetSource}`,
            query: `${contextRadius} m radius`,
            retrievedAt,
          });
        }
      })
      .catch((error) => {
        if (current) {
          setMapContextStatus(
            error instanceof Error
              ? error.message
              : "Public OSM context unavailable.",
          );
          setMapLayer({
            state: "unavailable",
            source: "OpenStreetMap and Portland public GIS",
            query: `${contextRadius} m radius`,
            retrievedAt: null,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [origin, contextRadius]);

  useEffect(() => {
    setUtilities([]);
    setSelectedUtility(null);
    if (!showUtilities) {
      setUtilityStatus("Public utilities off.");
      setUtilityLayer({
        state: "off",
        source: "Portland public utilities GIS",
        query: "250 m radius; water and sewer",
        retrievedAt: null,
      });
      return;
    }
    let current = true;
    setUtilityStatus("Loading public utility context...");
    setUtilityLayer({
      state: "loading",
      source: "Portland public utilities GIS",
      query: "250 m radius; water and sewer",
      retrievedAt: null,
    });
    loadPortlandUtilityContext(...origin)
      .then((paths) => {
        if (current) {
          const retrievedAt = new Date().toISOString();
          setUtilities(paths);
          setUtilityStatus(
            "Public utility context captured; not plant dependency evidence.",
          );
          setUtilityLayer({
            state: "current",
            source: "Portland public utilities GIS",
            query: "250 m radius; water and sewer",
            retrievedAt,
          });
        }
      })
      .catch(() => {
        if (current) {
          setUtilityStatus("Public utility context unavailable.");
          setUtilityLayer({
            state: "unavailable",
            source: "Portland public utilities GIS",
            query: "250 m radius; water and sewer",
            retrievedAt: null,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [origin, showUtilities]);

  useEffect(() => {
    setPublicRecords([]);
    setSelectedRecord(null);
    setSelectedRecordCluster([]);
    if (!showRecords) {
      setPublicRecords([]);
      setRecordsStatus("Public records off.");
      setRecordLayer({
        state: "off",
        source: "Portland BDS permit GIS",
        query: "160 m radius; maximum 50 records",
        retrievedAt: null,
      });
      return;
    }
    let current = true;
    const refresh = () => {
      setRecordsStatus("Refreshing nearby public records...");
      setRecordLayer((previous) => ({
        ...previous,
        state: "loading",
        source: "Portland BDS permit GIS",
        query: "160 m radius; maximum 50 records",
      }));
      loadPortlandPublicRecords(...origin)
        .then((records) => {
          if (current) {
            const retrievedAt = new Date().toISOString();
            setPublicRecords(records);
            setRecordsStatus(
              `Preview of ${records.length} nearby public permit records; not correlated to plant equipment.`,
            );
            setRecordLayer({
              state: "current",
              source: "Portland BDS permit GIS",
              query: "160 m radius; maximum 50 records",
              retrievedAt,
            });
          }
        })
        .catch(() => {
          if (current) {
            setRecordsStatus((previous) =>
              previous.startsWith("Preview")
                ? `${previous} Last refresh failed; showing prior capture.`
                : "Public records unavailable.",
            );
            setRecordLayer((previous) =>
              previous.retrievedAt
                ? { ...previous, state: "stale" }
                : {
                    state: "unavailable",
                    source: "Portland BDS permit GIS",
                    query: "160 m radius; maximum 50 records",
                    retrievedAt: null,
                  },
            );
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 86_400_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [origin, showRecords]);

  useEffect(() => {
    setPublicDocuments([]);
    if (!showDocuments) { setDocumentLayer({ state: "off", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: null }); return; }
    if (startupPhase < 1) { setDocumentLayer({ state: "loading", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: null }); return; }
    let current = true;
    setDocumentLayer({ state: "loading", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: null });
    loadPortlandPublicDocuments(...origin).then((documents) => {
      if (current) { setPublicDocuments(documents); setDocumentLayer({ state: "current", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: new Date().toISOString() }); }
    }).catch(() => { if (current) setDocumentLayer({ state: "unavailable", source: "Portland BDS mapped-document GIS", query: "160 m radius; maximum 50 documents", retrievedAt: null }); });
    return () => { current = false; };
  }, [origin, showDocuments, startupPhase >= 1]);

  useEffect(() => {
    setEnvironmentalRecords([]);
    if (!showEnvironmental) { setEnvironmentalLayer({ state: "off", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: null }); return; }
    if (startupPhase < 2) { setEnvironmentalLayer({ state: "loading", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: null }); return; }
    let current = true;
    setEnvironmentalLayer({ state: "loading", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: null });
    loadOregonDeqContext(...origin).then((records) => { if (current) { setEnvironmentalRecords(records); setEnvironmentalLayer({ state: "current", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: new Date().toISOString() }); } }).catch(() => { if (current) setEnvironmentalLayer({ state: "unavailable", source: "Oregon DEQ cleanup GIS", query: "500 m radius; maximum 50 sites", retrievedAt: null }); });
    return () => { current = false; };
  }, [origin, showEnvironmental, startupPhase >= 2]);

  useEffect(() => {
    setZones([]);
    setSelectedZone(null);
    if (!showZoning) {
      setZoningLayer({
        state: "off",
        source: "Portland zoning GIS",
        query: "up to 1,000 m radius; maximum 60 areas",
        retrievedAt: null,
      });
      return;
    }
    if (startupPhase < 3) { setZoningLayer({ state: "loading", source: "Portland zoning GIS", query: "up to 1,000 m radius; maximum 60 areas", retrievedAt: null }); return; }
    let current = true;
    const query = `${Math.min(contextRadius, 1_000)} m radius; maximum 60 areas`;
    setZoningLayer({
      state: "loading",
      source: "Portland zoning GIS",
      query,
      retrievedAt: null,
    });
    loadPortlandZoning(...origin, contextRadius)
      .then((areas) => {
        if (current) {
          setZones(areas);
          setZoningLayer({
            state: "current",
            source: "Portland zoning GIS",
            query,
            retrievedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        if (current) {
          setZones([]);
          setZoningLayer({
            state: "unavailable",
            source: "Portland zoning GIS",
            query,
            retrievedAt: null,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [contextRadius, origin, showZoning, startupPhase >= 3]);

  useEffect(() => {
    setParcels([]);
    setSelectedParcel(null);
    if (!showParcels) {
      setParcelLayer({ state: "off", source: "Washington County taxlot GIS", query: "tax lot containing the map origin", retrievedAt: null });
      return;
    }
    if (startupPhase < 4) { setParcelLayer({ state: "loading", source: "Washington County taxlot GIS", query: "tax lot containing the map origin", retrievedAt: null }); return; }
    let current = true;
    const query = "tax lot containing the map origin";
    setParcelLayer({ state: "loading", source: "Washington County taxlot GIS", query, retrievedAt: null });
    loadWashingtonCountyParcel(...origin).then((areas) => {
      if (current) { setParcels(areas); setParcelLayer({ state: areas.length ? "current" : "unavailable", source: "Washington County taxlot GIS", query, retrievedAt: areas.length ? new Date().toISOString() : null }); }
    }).catch(() => {
      if (current) setParcelLayer({ state: "unavailable", source: "Washington County taxlot GIS", query, retrievedAt: null });
    });
    return () => { current = false; };
  }, [origin, showParcels, startupPhase >= 4]);

  useEffect(() => {
    if (!showAerial) { setAerialUrl(null); setAerialLayer({ state: "off", source: "Oregon Statewide Imagery Program 2024", query: "up to 1,500 m radius", retrievedAt: null }); return; }
    if (startupPhase < 5) { setAerialLayer({ state: "loading", source: "Oregon Statewide Imagery Program 2024", query: "up to 1,500 m radius", retrievedAt: null }); return; }
    let current = true;
    const query = `${Math.min(contextRadius, 1_500)} m radius; 1,024 px image`;
    const url = aerialImageUrl(...origin, contextRadius);
    setAerialLayer({ state: "loading", source: "Oregon Statewide Imagery Program 2024", query, retrievedAt: null });
    const image = new Image();
    const unavailable = () => { if (current) { setAerialUrl(null); setAerialLayer({ state: "unavailable", source: "Oregon Statewide Imagery Program 2024", query, retrievedAt: null }); } };
    const timeout = window.setTimeout(unavailable, 12_000);
    image.onload = () => { if (current) { window.clearTimeout(timeout); setAerialUrl(url); setAerialLayer({ state: "current", source: "Oregon Statewide Imagery Program 2024", query, retrievedAt: new Date().toISOString() }); } };
    image.onerror = unavailable;
    image.src = url;
    return () => { current = false; window.clearTimeout(timeout); };
  }, [contextRadius, origin, showAerial, startupPhase >= 5]);

  useEffect(() => {
    if (!showTerrain) { setTerrainUrl(null); setTerrainLayer({ state: "off", source: "USGS 3DEP elevation image service", query: "up to 1,500 m radius", retrievedAt: null }); return; }
    if (startupPhase < 6) { setTerrainLayer({ state: "loading", source: "USGS 3DEP elevation image service", query: "up to 1,500 m radius", retrievedAt: null }); return; }
    let current = true;
    const query = `${Math.min(contextRadius, 1_500)} m radius; 1,024 px image`;
    const url = terrainImageUrl(...origin, contextRadius);
    setTerrainLayer({ state: "loading", source: "USGS 3DEP elevation image service", query, retrievedAt: null });
    const image = new Image();
    const unavailable = () => { if (current) { setTerrainUrl(null); setTerrainLayer({ state: "unavailable", source: "USGS 3DEP elevation image service", query, retrievedAt: null }); } };
    const timeout = window.setTimeout(unavailable, 12_000);
    image.onload = () => { if (current) { window.clearTimeout(timeout); setTerrainUrl(url); setTerrainLayer({ state: "current", source: "USGS 3DEP elevation image service", query, retrievedAt: new Date().toISOString() }); } };
    image.onerror = unavailable;
    image.src = url;
    return () => { current = false; window.clearTimeout(timeout); };
  }, [contextRadius, origin, showTerrain, startupPhase >= 6]);

  const importMapExport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const listings = parseGeographicExport(await file.text());
      const imported = mapListingsToAssets(listings);
      setImportedAssets(imported);
      setOrigin((current) => {
        if (
          current[0] === listings[0].latitude &&
          current[1] === listings[0].longitude
        )
          return current;
        setSelectedUtility(null);
        setSelectedMapContext(null);
        setSelectedRecord(null);
        setSelectedRecordCluster([]);
        return [listings[0].latitude, listings[0].longitude];
      });
      setSiteLabel(listings[0].address || listings[0].title);
      setImportMessage(
        `Imported ${imported.length} geographic context record${imported.length === 1 ? "" : "s"} and recentered public map context.`,
      );
    } catch (error) {
      setImportMessage(
        error instanceof Error
          ? error.message
          : "Could not read the map export.",
      );
    }
    event.target.value = "";
  };

  const importEvidence = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseEvidenceManifest(
        await file.text(),
        new Set(displayAssets.map((asset) => asset.id)),
      );
      clearLocalSources();
      setEvidence(parsed);
      setEvidenceMessage(
        `Imported ${parsed.sources.length} sources, ${parsed.claims.length} claims, ${parsed.events.length} events, ${parsed.jobs.length} jobs, and ${parsed.dependencies.length} dependency claims.`,
      );
    } catch (error) {
      setEvidenceMessage(
        error instanceof Error
          ? error.message
          : "Could not read the evidence manifest.",
      );
    }
    event.target.value = "";
  };

  const attachEvidence = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    const result = await attachEvidenceFiles(evidence, files);
    const filesByName = new Map(files.map((file) => [file.name, file]));
    result.data.sources.forEach((source) => {
      const file = source.fileName
        ? filesByName.get(source.fileName)
        : undefined;
      if (!file) return;
      const prior = localSourceUrls.current.get(source.id);
      if (prior) URL.revokeObjectURL(prior);
      localSourceUrls.current.set(source.id, URL.createObjectURL(file));
    });
    setEvidence(result.data);
    setEvidenceMessage(
      `Attached ${result.attached} hashed local evidence file${result.attached === 1 ? "" : "s"}; ${result.unmatched} unmatched.`,
    );
    event.target.value = "";
  };

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">Plant knowledge capture</p>
          <h1>Dependency Map</h1>
          <p className="site-location">{siteLabel}</p>
        </div>
        <div className="legend">
          {Object.entries(colorFor).map(([kind, color]) => (
            <span key={kind}>
              <i style={{ background: color }} />
              {kind}
            </span>
          ))}
        </div>
      </header>
      <section className="workspace">
        <aside className="asset-list">
          <label>
            Find an asset
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, ID, source, or evidence gap"
            />
          </label>
          <label className="asset-filter">
            System
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
            >
              <option value="ALL">All systems</option>
              {Object.keys(colorFor).map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label className="map-import">
            Import geographic JSON
            <input
              type="file"
              accept="application/json"
              onChange={importMapExport}
            />
            <small>{importMessage}</small>
          </label>
          <label className="evidence-import">
            Import evidence manifest
            <input
              type="file"
              accept="application/json"
              onChange={importEvidence}
            />
            <small>{evidenceMessage}</small>
          </label>
          <label className="evidence-import">
            Attach local evidence files
            <input
              type="file"
              accept="application/pdf,image/*,text/csv,application/json,text/plain"
              multiple
              onChange={attachEvidence}
            />
          </label>
          <div className="asset-count">
            {filtered.length} field-verify starter records
          </div>
          {filtered.map((asset) => (
            <button
              className={`asset-row ${selected?.id === asset.id ? "selected" : ""}`}
              key={asset.id}
              onClick={() => {
                setSelected(asset);
                setActiveTab("overview");
              }}
            >
              <i style={{ background: colorFor[asset.kind] }} />
              <span>
                {asset.label}
                <small>
                  {asset.kind} | {asset.status}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <section
          className="map"
          aria-label="Interactive three dimensional asset dependency map"
        >
          <div className="map-toolbar">
            <span>{mapContextStatus}</span>
            <div className="view-controls" aria-label="Map view controls">
              <button onClick={() => setViewCommand((current) => ({ preset: "recenter", revision: current.revision + 1 }))}>Recenter</button>
              <button onClick={() => setViewCommand((current) => ({ preset: "aerial", revision: current.revision + 1 }))}>Aerial view</button>
              <button onClick={() => setViewCommand((current) => ({ preset: "operator", revision: current.revision + 1 }))}>Operator view</button>
            </div>
            <label>
              Context
              <input
                type="range"
                min="0.04"
                max="0.4"
                step="0.02"
                value={contextOpacity}
                onChange={(event) =>
                  setContextOpacity(Number(event.target.value))
                }
              />
            </label>
            <label>
              Range
              <input
                type="range"
                min="250"
                max="5000"
                step="250"
                value={contextRadius}
                onChange={(event) =>
                  setContextRadius(Number(event.target.value))
                }
              />
            </label>
            <label title="Live Portland public water and sewer lines. Geographic context only, never plant dependency evidence.">
              <input
                className="utility-toggle"
                type="checkbox"
                checked={showUtilities}
                onChange={(event) => setShowUtilities(event.target.checked)}
              />
              Utilities
            </label>
            {showUtilities && (
              <label>
                Type
                <select
                  value={utilityFilter}
                  onChange={(event) =>
                    setUtilityFilter(
                      event.target.value as "water" | "sewer" | "all",
                    )
                  }
                >
                  <option value="water">Water</option>
                  <option value="sewer">Sewer</option>
                  <option value="all">All municipal</option>
                </select>
              </label>
            )}
            <label title="Opt-in City of Portland permit context, refreshed daily and never merged with plant history or jobs.">
              <input
                className="record-toggle"
                type="checkbox"
                checked={showRecords}
                onChange={(event) => setShowRecords(event.target.checked)}
              />
              Records
            </label>
            <label title="City-mapped public documents, never merged into plant history or jobs.">
              <input type="checkbox" checked={showDocuments} onChange={(event) => setShowDocuments(event.target.checked)} />
              Documents
            </label>
            <label title="Oregon DEQ environmental cleanup context, never plant evidence.">
              <input type="checkbox" checked={showEnvironmental} onChange={(event) => setShowEnvironmental(event.target.checked)} />
              DEQ
            </label>
            <label title="Public land-use designation, not a plant-use or compliance claim.">
              <input
                type="checkbox"
                checked={showZoning}
                onChange={(event) => setShowZoning(event.target.checked)}
              />
              Zoning
            </label>
            <label title="Official Washington County tax-lot boundary containing the map origin. Geographic context only; never proof of ownership or equipment location.">
              <input
                type="checkbox"
                checked={showParcels}
                onChange={(event) => setShowParcels(event.target.checked)}
              />
              Washington County parcel
            </label>
            <label title="Official Oregon aerial imagery, shown only as geographic context.">
              <input type="checkbox" checked={showAerial} onChange={(event) => setShowAerial(event.target.checked)} />
              Aerial
            </label>
            <label title="USGS elevation raster, shown only as terrain context.">
              <input type="checkbox" checked={showTerrain} onChange={(event) => setShowTerrain(event.target.checked)} />
              Terrain
            </label>
            <label title="Hide unverified electrical starter records from both the map and asset list.">
              <input type="checkbox" checked={showFieldVerifyElectrical} onChange={(event) => setShowFieldVerifyElectrical(event.target.checked)} />
              Field-verify electrical
            </label>
            <label title="Hide unverified pneumatic starter records from both the map and asset list.">
              <input type="checkbox" checked={showFieldVerifyPneumatic} onChange={(event) => setShowFieldVerifyPneumatic(event.target.checked)} />
              Field-verify pneumatic
            </label>
            <button
              className={isolate ? "active" : ""}
              onClick={() => setIsolate((value) => !value)}
              disabled={!selected}
            >
              Isolate dependencies
            </button>
            <details className="layer-status">
              <summary>Layer status</summary>
              <small>{layerText("Map", mapLayer)}</small>
              <small>{layerText("Utilities", utilityLayer)}</small>
              <small>{layerText("Records", recordLayer)}</small>
              <small>{layerText("Zoning", zoningLayer)}</small>
              <small>{layerText("Parcels", parcelLayer)}</small>
              <small>{layerText("Aerial", aerialLayer)}</small>
              <small>{layerText("Terrain", terrainLayer)}</small>
              <small>{layerText("Documents", documentLayer)}</small>
              <small>{layerText("DEQ", environmentalLayer)}</small>
            </details>
          </div>
          <div className="loading-progress" aria-live="polite">
            <span className="loading-progress-track"><i style={{ width: `${(loadedLayerCount / publicLayers.length) * 100}%` }} /></span>
            <small>{loadedLayerCount}/{publicLayers.length} public layers loaded{loadingLayerCount ? ` | ${loadingLayerCount} loading` : ""}{unavailableLayerCount ? ` | ${unavailableLayerCount} unavailable` : ""}</small>
          </div>
          {showUtilities && (
            <div className="utility-legend">
              <span>
                <i className="water" />
                Public water main (
                {
                  visibleUtilities.filter((utility) => utility.kind === "water")
                    .length
                }
                )
              </span>
              <span>
                <i className="sewer" />
                Public sewer pipe (
                {
                  visibleUtilities.filter((utility) => utility.kind === "sewer")
                    .length
                }
                )
              </span>
              <small>{utilityStatus}</small>
            </div>
          )}
          {showRecords && (
            <div className="record-legend">
              <i />
              {recordsStatus}
            </div>
          )}
          <Suspense fallback={<div className="map-loading">Loading 3D context...</div>}>
          <AssetScene
            assets={visibleAssets}
            dependencies={visibleDependencies}
            footprints={footprints}
            streets={streets}
            utilities={visibleUtilities}
            records={[...publicRecords, ...publicDocuments, ...environmentalRecords]}
            zones={zones}
            parcels={parcels}
            aerialUrl={aerialUrl}
            terrainUrl={terrainUrl}
            origin={origin}
            contextRadius={contextRadius}
            contextOpacity={contextOpacity}
            viewPreset={viewCommand.preset}
            viewRevision={viewCommand.revision}
            selectedId={selected?.id ?? null}
            selectedUtilityId={selectedUtility?.id ?? null}
            selectedRecordId={selectedRecord?.id ?? null}
            selectedZoneId={selectedZone?.id ?? null}
            selectedParcelId={selectedParcel?.id ?? null}
            isolate={isolate}
            onSelect={(asset) => {
              setSelectedUtility(null);
              setSelectedMapContext(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(null);
              setSelected(asset);
              setActiveTab("overview");
            }}
            onSelectUtility={(utility) => {
              setSelected(null);
              setSelectedMapContext(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(null);
              setIsolate(false);
              setSelectedUtility(utility);
            }}
            onSelectBuilding={(building) => {
              setSelected(null);
              setSelectedUtility(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(null);
              setSelectedMapContext({ kind: "building", record: building });
            }}
            onSelectStreet={(street) => {
              setSelected(null);
              setSelectedUtility(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(null);
              setSelectedMapContext({ kind: "street", record: street });
            }}
            onSelectRecord={(record, cluster) => {
              setSelected(null);
              setSelectedUtility(null);
              setSelectedMapContext(null);
              setSelectedZone(null);
              setIsolate(false);
              setSelectedRecord(record);
              setSelectedRecordCluster(cluster);
            }}
            onSelectZone={(zone) => {
              setSelected(null);
              setSelectedUtility(null);
              setSelectedMapContext(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(zone);
            }}
            onSelectParcel={(parcel) => {
              setSelected(null);
              setSelectedUtility(null);
              setSelectedMapContext(null);
              setSelectedRecord(null);
              setSelectedRecordCluster([]);
              setSelectedZone(null);
              setSelectedParcel(parcel);
            }}
          />
          </Suspense>
          <p className="map-note">
            Drag to rotate | scroll to zoom | select equipment or public context
            for its source record
          </p>
        </section>
        <aside className="detail-panel">
          {selected ? (
            <>
              <div className="detail-heading">
                <i style={{ background: colorFor[selected.kind] }} />
                <div>
                  <p className="eyebrow">{selected.kind}</p>
                  <h2>{selected.label}</h2>
                </div>
              </div>
              <nav className="tabs" aria-label="Asset data views">
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    className={activeTab === tab ? "active" : ""}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </nav>
              {activeTab === "overview" && (
                <>
                  <dl>
                    <div>
                      <dt>Operating state</dt>
                      <dd className={`status ${selected.status}`}>
                        {selected.status}
                      </dd>
                    </div>
                    <div>
                      <dt>Verification</dt>
                      <dd>
                        {selected.verificationStatus} | {selected.reviewState}
                      </dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{selected.source}</dd>
                    </div>
                    <div>
                      <dt>Source location</dt>
                      <dd>{selected.sourceLocation}</dd>
                    </div>
                    <div>
                      <dt>Captured / reviewed</dt>
                      <dd>
                        {selected.capturedAt ?? "Not recorded"} /{" "}
                        {selected.reviewedBy ?? "Not reviewed"}
                      </dd>
                    </div>
                  </dl>
                  {selected.sourceUri && (
                    <p className="details">
                      <a
                        href={selected.sourceUri}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open source record
                      </a>
                    </p>
                  )}
                  <p className="details">{selected.details}</p>
                  <section className="relationships">
                    <h3>Evidence gaps</h3>
                    {selected.evidenceGaps.map((gap) => (
                      <p key={gap}>{gap}</p>
                    ))}
                  </section>
                  <section className="relationships">
                    <h3>Direct dependency claims</h3>
                    {related.length ? (
                      related.map((edge) => {
                        const peer = visibleAssets.find(
                          (asset) =>
                            asset.id ===
                            (edge.source === selected.id
                              ? edge.target
                              : edge.source),
                        )!;
                        const source = edge.evidenceSourceId
                          ? sourceById.get(edge.evidenceSourceId)
                          : undefined;
                        return (
                          <div key={edge.id}>
                            <button
                              title={`${edge.verificationStatus}; source: ${edge.sourceLocation}`}
                              onClick={() => {
                                setSelected(peer);
                                setActiveTab("overview");
                              }}
                            >
                              <span>
                                {edge.source === selected.id ? "OUT" : "IN"} |{" "}
                                {edge.relation.replaceAll("_", " ")} |{" "}
                                {edge.verificationStatus}
                              </span>
                              {peer.label}
                            </button>
                            {source ? (
                              <small>{sourceReference(source)}</small>
                            ) : (
                              edge.sourceUri && (
                                <small>
                                  <a
                                    href={edge.sourceUri}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open source evidence
                                  </a>
                                </small>
                              )
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <p>No documented direct edges.</p>
                    )}
                  </section>
                </>
              )}
              {activeTab === "specs" && (
                <section className="tab-copy">
                  <h3>Record specification</h3>
                  <p>Type: {selected.kind}</p>
                  <p>Graph identifier: {selected.id}</p>
                  {selectedClaims.length ? (
                    selectedClaims.map((claim) => {
                      const source = sourceById.get(claim.sourceId);
                      return (
                        <p key={claim.id}>
                          <strong>{claim.field}:</strong> {claim.value}
                          {claim.unit ? ` ${claim.unit}` : ""} |{" "}
                          {claim.verificationStatus} | {sourceReference(source)}{" "}
                          | {claim.locator}
                          {source?.sha256 ? ` | SHA-256 ${source.sha256}` : ""}
                        </p>
                      );
                    })
                  ) : (
                    <p>
                      No source-backed manufacturer, rating, I/O, pressure,
                      voltage, or isolation data has been supplied.
                    </p>
                  )}
                  <p>
                    Coordinates are 3D visualization positions only; geographic
                    context never proves equipment location.
                  </p>
                </section>
              )}
              {activeTab === "history" && (
                <section className="tab-copy">
                  <h3>Verified history</h3>
                  {selectedEvents.length ? (
                    selectedEvents.map((item) => {
                      const source = sourceById.get(item.sourceId);
                      return (
                        <p key={item.id}>
                          <strong>{item.kind}:</strong> {item.summary} |{" "}
                          {item.occurredAt ?? "Date not recorded"} |{" "}
                          {item.verificationStatus} | {sourceReference(source)}{" "}
                          | {item.locator}
                        </p>
                      );
                    })
                  ) : (
                    <>
                      <p>
                        No source-backed observation, event, photo, drawing
                        review, or maintenance log is recorded.
                      </p>
                      <p>
                        Required evidence: {selected.evidenceGaps.join("; ")}.
                      </p>
                    </>
                  )}
                </section>
              )}
              {activeTab === "jobs" && (
                <section className="tab-copy">
                  <h3>Work orders</h3>
                  {selectedJobs.length ? (
                    selectedJobs.map((job) => {
                      const source = sourceById.get(job.sourceId);
                      return (
                        <p key={job.id}>
                          <strong>{job.status}:</strong> {job.title} |{" "}
                          {job.verificationStatus} | {sourceReference(source)} |{" "}
                          {job.locator}
                        </p>
                      );
                    })
                  ) : (
                    <>
                      <p>
                        No source-backed work order is recorded for this asset.
                      </p>
                      <p>
                        LOTO source, isolation point, stored-energy release, and
                        verification steps are not documented. Do not treat
                        control relationships as isolation evidence.
                      </p>
                    </>
                  )}
                </section>
              )}
            </>
          ) : selectedUtility ? (
            <section className="tab-copy">
              <h3>Public utility context</h3>
              <p>
                {selectedUtility.kind === "water"
                  ? "City-mapped public water main"
                  : "City-mapped public sewer pipe"}
                ; no facility connection is documented.
              </p>
              <p>Feature: {selectedUtility.objectId}</p>
              <p>Returned attributes: {selectedUtility.attributeSummary}</p>
              <p>
                Last successful capture:{" "}
                {new Date(selectedUtility.capturedAt).toLocaleString()}
              </p>
              <p>
                <a
                  href={selectedUtility.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official source record
                </a>
              </p>
            </section>
          ) : selectedMapContext ? (
            <section className="tab-copy">
              <h3>Public map context</h3>
              <p>
                {selectedMapContext.kind === "building"
                  ? `${selectedMapContext.record.sourceLabel}${selectedMapContext.record.isFacilityCandidate ? "; nearest footprint to the address point and highlighted as a candidate facility outline" : ""}`
                  : selectedMapContext.record.sourceLabel}
                ; not a plant asset or dependency.
              </p>
              {selectedMapContext.kind === "building" && selectedMapContext.record.isFacilityCandidate && (
                <p>This exterior outline is inferred from proximity to the geocoded address. Confirm it against a site plan or field observation before accepting it as the facility boundary.</p>
              )}
              <p>
                {selectedMapContext.kind === "building"
                  ? `Building: ${selectedMapContext.record.name} | ${selectedMapContext.record.heightMeters.toFixed(1)} m mapped height`
                  : `Street: ${selectedMapContext.record.name}`}
              </p>
              <p>Record: {selectedMapContext.record.recordId}</p>
              <p>
                Captured:{" "}
                {new Date(
                  selectedMapContext.record.capturedAt,
                ).toLocaleString()}
              </p>
              <p>
                <a
                  href={selectedMapContext.record.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official source record
                </a>
              </p>
            </section>
          ) : selectedRecord ? (
            <section className="tab-copy">
              <h3>{selectedRecord.category === "environmental" ? "Nearby DEQ context" : selectedRecord.category === "permit" ? "Nearby public record" : "Nearby public document"}</h3>
              <p>
                {selectedRecord.category === "permit" ? "City permit context" : selectedRecord.category === "document" ? "City-mapped document context" : "Oregon DEQ environmental context"} only; geographic placement is not equipment location and this record is not merged into History or Jobs.
              </p>
              <p>
                {selectedRecord.title} | {selectedRecord.status}
              </p>
              <p>{selectedRecord.details}</p>
              {selectedRecordCluster.length > 1 && (
                <section className="relationships">
                  <h3>{selectedRecordCluster.length} records at this marker</h3>
                  {selectedRecordCluster.map((record) => (
                    <button
                      key={record.id}
                      onClick={() => setSelectedRecord(record)}
                    >
                      {record.title}
                    </button>
                  ))}
                </section>
              )}
              <p>
                Last successful capture:{" "}
                {new Date(selectedRecord.capturedAt).toLocaleString()}
              </p>
              <p>
                <a
                  href={selectedRecord.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official source record
                </a>
              </p>
            </section>
          ) : selectedZone ? (
            <section className="tab-copy">
              <h3>Public zoning context</h3>
              <p>
                Public land-use designation only; it does not establish plant
                use, compliance, or any equipment dependency.
              </p>
              <p>Zone: {selectedZone.zone}</p>
              <p>
                Captured: {new Date(selectedZone.capturedAt).toLocaleString()}
              </p>
              <p>
                <a
                  href={selectedZone.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official zoning record
                </a>
              </p>
            </section>
          ) : selectedParcel ? (
            <section className="tab-copy">
              <h3>Public parcel context</h3>
              <p>Official Washington County tax-lot boundary only; it does not establish plant ownership, use, or equipment location.</p>
              <p>Parcel: {selectedParcel.label}</p>
              <p>Captured: {new Date(selectedParcel.capturedAt).toLocaleString()}</p>
              <p><a href={selectedParcel.sourceUrl} target="_blank" rel="noreferrer">Open official parcel record</a></p>
            </section>
          ) : (
            <p>Select an asset or public context feature from the model.</p>
          )}
        </aside>
      </section>
      <footer>
        Starter dependencies are examples only. Imported map records are
        geographic context, never equipment links, until corroborated by
        drawings, labels, or a site walkdown. OpenStreetMap data: ODbL.
      </footer>
    </main>
  );
}
