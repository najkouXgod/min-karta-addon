(() => {
  "use strict";

  if (window.__MINKARTA_GPX_BRIDGE_LOADED__) {
    return;
  }

  window.__MINKARTA_GPX_BRIDGE_LOADED__ = true;

  const COMMAND_EVENT = "MINKARTA_GPX_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_RESULT";
  const ELEVATION_URL = "/api/hojdprofil/hojdprofil/v1";

  const HIGHLIGHT_COLOR = "#00e5ff";
  const ELEVATION_CHUNK_LENGTH_METERS = 55_000;
  const MIN_RETRY_CHUNK_LENGTH_METERS = 2_000;
  const MAX_PARALLEL_ELEVATION_REQUESTS = 2;
  const MAX_ELEVATION_INPUT_POINTS = 5_000;
  const COORDINATE_MATCH_TOLERANCE_METERS = 0.5;

  let cachedMap = null;
  let nextFeatureId = 1;

  const featureIds = new WeakMap();
  const featuresById = new Map();
  const featureLayers = new WeakMap();
  const highlightedFeatures = new Map();
  const originalHighlightStates = new WeakMap();

  function isOpenLayersMap(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.getView === "function" &&
      typeof value.getLayers === "function" &&
      typeof value.getViewport === "function" &&
      typeof value.getEventCoordinate === "function"
    );
  }

  function findMap() {
    if (isOpenLayersMap(cachedMap)) {
      return cachedMap;
    }

    const viewport = document.querySelector(".ol-viewport");

    if (!viewport) {
      throw new Error("Kunde inte hitta kartans HTML-element.");
    }

    let element = viewport.parentElement;

    while (element) {
      const fiberKey = Object
        .getOwnPropertyNames(element)
        .find(name => name.startsWith("__reactFiber$"));

      if (fiberKey) {
        const fiber = element[fiberKey];
        const directMap =
          fiber?.return?.stateNode?.props
            ?.maps?.WEMAP_KARTA?.map;

        if (isOpenLayersMap(directMap)) {
          cachedMap = directMap;
          return cachedMap;
        }

        const searchedMap = searchForMap(fiber);

        if (searchedMap) {
          cachedMap = searchedMap;
          return cachedMap;
        }
      }

      element = element.parentElement;
    }

    throw new Error("Kunde inte hitta Min kartas kartobjekt.");
  }

  function searchForMap(root) {
    const visited = new WeakSet();
    let inspectedObjects = 0;
    const maxObjects = 50_000;
    const maxDepth = 16;

    function search(value, depth = 0) {
      if (
        value === null ||
        value === undefined ||
        depth > maxDepth ||
        inspectedObjects >= maxObjects
      ) {
        return null;
      }

      const valueType = typeof value;

      if (
        valueType !== "object" &&
        valueType !== "function"
      ) {
        return null;
      }

      if (isOpenLayersMap(value)) {
        return value;
      }

      if (visited.has(value)) {
        return null;
      }

      visited.add(value);
      inspectedObjects++;

      if (
        value instanceof Node ||
        value === window ||
        value === document
      ) {
        return null;
      }

      let keys;

      try {
        keys = Reflect.ownKeys(value);
      } catch {
        return null;
      }

      for (const key of keys.slice(0, 300)) {
        let descriptor;

        try {
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
          continue;
        }

        if (!descriptor || !("value" in descriptor)) {
          continue;
        }

        const result = search(descriptor.value, depth + 1);

        if (result) {
          return result;
        }
      }

      return null;
    }

    return search(root);
  }

  function getTopLevelLayers(map) {
    return (
      map.getLayers?.().getArray?.() ??
      map.getLayerGroup?.().getLayers?.().getArray?.() ??
      []
    );
  }

  function copyCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) {
      return coordinates;
    }

    return coordinates.map(copyCoordinates);
  }

  function getFeatureId(feature) {
    if (featureIds.has(feature)) {
      return featureIds.get(feature);
    }

    const id = `line-${nextFeatureId++}`;
    featureIds.set(feature, id);
    featuresById.set(id, feature);
    return id;
  }

  function calculateSegmentLength(coordinates) {
    let length = 0;

    for (let index = 1; index < coordinates.length; index++) {
      const previous = coordinates[index - 1];
      const current = coordinates[index];

      length += Math.hypot(
        Number(current?.[0]) - Number(previous?.[0]),
        Number(current?.[1]) - Number(previous?.[1])
      );
    }

    return length;
  }

  function calculateLength(type, coordinates) {
    if (type === "LineString") {
      return calculateSegmentLength(coordinates);
    }

    if (type === "MultiLineString") {
      return coordinates.reduce(
        (total, segment) =>
          total + calculateSegmentLength(segment),
        0
      );
    }

    return 0;
  }

  function countPoints(type, coordinates) {
    if (type === "LineString") {
      return coordinates.length;
    }

    if (type === "MultiLineString") {
      return coordinates.reduce(
        (total, segment) => total + segment.length,
        0
      );
    }

    return 0;
  }

  function getFeatureName(feature, fallbackName) {
    const possibleNames = [
      feature.get?.("minkartaGpxName"),
      feature.get?.("name"),
      feature.get?.("title"),
      feature.get?.("label")
    ];

    const name = possibleNames.find(value =>
      typeof value === "string" && value.trim()
    );

    return name?.trim() ?? fallbackName;
  }

  function findDrawnLines(map) {
    const lines = [];
    let lineNumber = 1;

    function inspectLayer(layer, path) {
      if (!layer) {
        return;
      }

      if (typeof layer.getLayers === "function") {
        const children =
          layer.getLayers()?.getArray?.() ?? [];

        children.forEach((child, index) => {
          inspectLayer(child, `${path}/${index}`);
        });

        return;
      }

      const source = layer.getSource?.();

      if (!source || typeof source.getFeatures !== "function") {
        return;
      }

      let features;

      try {
        features = source.getFeatures();
      } catch {
        return;
      }

      for (const feature of features ?? []) {
        const geometry = feature.getGeometry?.();
        const type = geometry?.getType?.();

        featureLayers.set(feature, layer);

        if (
          type !== "LineString" &&
          type !== "MultiLineString"
        ) {
          continue;
        }

        const rawCoordinates = geometry.getCoordinates?.();

        if (!Array.isArray(rawCoordinates)) {
          continue;
        }

        const coordinates = copyCoordinates(rawCoordinates);
        const fallbackName = `Linje ${lineNumber}`;

        lines.push({
          id: getFeatureId(feature),
          name: getFeatureName(feature, fallbackName),
          type,
          layerPath: path,
          coordinates,
          pointCount: countPoints(type, coordinates),
          lengthMeters: calculateLength(type, coordinates)
        });

        lineNumber++;
      }
    }

    getTopLevelLayers(map).forEach((layer, index) => {
      inspectLayer(layer, `layer-${index}`);
    });

    return lines;
  }

  function getRenderedFeatureStyle(feature) {
    const resolution = cachedMap
      ?.getView?.()
      ?.getResolution?.();

    const directStyle = feature.getStyle?.();

    if (typeof directStyle === "function") {
      return directStyle(feature, resolution);
    }

    if (directStyle) {
      return directStyle;
    }

    const layer = featureLayers.get(feature);
    const layerStyleFunction = layer?.getStyleFunction?.();

    if (typeof layerStyleFunction === "function") {
      return layerStyleFunction(feature, resolution);
    }

    return null;
  }

  function cloneHighlightStyles(style) {
    const sourceStyles = Array.isArray(style) ? style : [style];
    const outlines = [];
    const originals = [];

    for (const sourceStyle of sourceStyles) {
      if (!sourceStyle || typeof sourceStyle.clone !== "function") {
        continue;
      }

      const original = sourceStyle.clone();
      const sourceStroke = sourceStyle.getStroke?.();

      if (sourceStroke) {
        const outline = sourceStyle.clone();
        const stroke = typeof sourceStroke.clone === "function"
          ? sourceStroke.clone()
          : sourceStroke;

        const width = Number(sourceStroke.getWidth?.()) || 2;
        stroke.setColor?.(HIGHLIGHT_COLOR);
        stroke.setWidth?.(width + 5);
        outline.setStroke?.(stroke);
        outline.setFill?.(null);
        outline.setImage?.(null);
        outline.setText?.(null);
        outline.setZIndex?.(9_999);
        outlines.push(outline);
      }

      original.setZIndex?.(10_000);
      originals.push(original);
    }

    const styles = [...outlines, ...originals];
    return styles.length > 0 ? styles : null;
  }

  function applyFeatureHighlight(featureId, feature) {
    if (!feature || highlightedFeatures.has(featureId)) {
      return;
    }

    const directStyle = feature.getStyle?.();

    originalHighlightStates.set(feature, { directStyle });

    const highlightedStyle = cloneHighlightStyles(
      getRenderedFeatureStyle(feature)
    );

    if (highlightedStyle && typeof feature.setStyle === "function") {
      feature.setStyle(highlightedStyle);
    }

    feature.changed?.();
    highlightedFeatures.set(featureId, feature);
  }

  function restoreFeatureHighlight(featureId, feature) {
    const state = originalHighlightStates.get(feature);

    if (state && typeof feature.setStyle === "function") {
      feature.setStyle(state.directStyle);
      originalHighlightStates.delete(feature);
    }

    feature.changed?.();
    highlightedFeatures.delete(featureId);
  }

  function setHighlightedLines(lineIds) {
    const map = findMap();
    findDrawnLines(map);

    const requestedIds = new Set(
      Array.isArray(lineIds)
        ? lineIds.map(String)
        : []
    );

    for (const [featureId, feature] of highlightedFeatures) {
      if (!requestedIds.has(featureId)) {
        restoreFeatureHighlight(featureId, feature);
      }
    }

    for (const featureId of requestedIds) {
      const feature = featuresById.get(featureId);

      if (feature) {
        applyFeatureHighlight(featureId, feature);
      }
    }

    map.render?.();

    return {
      projection:
        map.getView?.().getProjection?.().getCode?.() ?? null,
      lineIds: [...requestedIds].filter(id =>
        highlightedFeatures.has(id)
      )
    };
  }

  function getLineSegments(type, coordinates) {
    if (type === "LineString") {
      return [coordinates];
    }

    if (type === "MultiLineString") {
      return coordinates.filter(segment =>
        Array.isArray(segment) && segment.length >= 2
      );
    }

    return [];
  }

  function createElevationRequest(coordinates) {
    return {
      measureFeatures: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: copyCoordinates(coordinates)
            },
            properties: {
              measure: true,
              length: calculateSegmentLength(coordinates)
            }
          }
        ]
      }
    };
  }

  function normalizeElevationCoordinates(coordinates, noDataValue) {
    if (!Array.isArray(coordinates)) {
      throw new Error("Höjdtjänsten returnerade inga koordinater.");
    }

    return coordinates.map(coordinate => {
      if (!Array.isArray(coordinate) || coordinate.length < 3) {
        throw new Error("Höjdtjänsten returnerade en ogiltig punkt.");
      }

      const easting = Number(coordinate[0]);
      const northing = Number(coordinate[1]);
      const rawElevation = Number(coordinate[2]);

      if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
        throw new Error(
          "Höjdtjänsten returnerade ogiltiga kartkoordinater."
        );
      }

      const elevation =
        Number.isFinite(rawElevation) &&
        rawElevation !== noDataValue
          ? rawElevation
          : null;

      return [easting, northing, elevation];
    });
  }

  function interpolateCoordinate(start, end, fraction) {
    return [
      Number(start[0]) +
        (Number(end[0]) - Number(start[0])) * fraction,
      Number(start[1]) +
        (Number(end[1]) - Number(start[1])) * fraction
    ];
  }

  function splitSegmentByLength(
    coordinates,
    maxLengthMeters = ELEVATION_CHUNK_LENGTH_METERS
  ) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error("Linjen måste innehålla minst två punkter.");
    }

    const chunks = [];
    const epsilon = 0.001;
    let currentChunk = [copyCoordinates(coordinates[0])];
    let currentLength = 0;

    for (let index = 1; index < coordinates.length; index++) {
      let edgeStart = copyCoordinates(coordinates[index - 1]);
      const edgeEnd = copyCoordinates(coordinates[index]);
      let remainingEdgeLength = Math.hypot(
        Number(edgeEnd[0]) - Number(edgeStart[0]),
        Number(edgeEnd[1]) - Number(edgeStart[1])
      );

      if (!Number.isFinite(remainingEdgeLength)) {
        throw new Error("Linjen innehåller ogiltiga koordinater.");
      }

      if (remainingEdgeLength <= epsilon) {
        currentChunk.push(edgeEnd);
        continue;
      }

      while (remainingEdgeLength > epsilon) {
        const remainingChunkLength =
          maxLengthMeters - currentLength;

        if (remainingChunkLength <= epsilon) {
          if (currentChunk.length >= 2) {
            chunks.push(currentChunk);
          }

          currentChunk = [copyCoordinates(edgeStart)];
          currentLength = 0;
          continue;
        }

        if (remainingEdgeLength <= remainingChunkLength + epsilon) {
          currentChunk.push(edgeEnd);
          currentLength += remainingEdgeLength;
          remainingEdgeLength = 0;

          if (currentChunk.length >= MAX_ELEVATION_INPUT_POINTS) {
            chunks.push(currentChunk);
            currentChunk = [copyCoordinates(edgeEnd)];
            currentLength = 0;
          }

          continue;
        }

        const fraction = remainingChunkLength / remainingEdgeLength;
        const splitPoint = interpolateCoordinate(
          edgeStart,
          edgeEnd,
          fraction
        );

        currentChunk.push(splitPoint);
        chunks.push(currentChunk);
        currentChunk = [copyCoordinates(splitPoint)];
        currentLength = 0;
        edgeStart = splitPoint;
        remainingEdgeLength = Math.hypot(
          Number(edgeEnd[0]) - Number(edgeStart[0]),
          Number(edgeEnd[1]) - Number(edgeStart[1])
        );
      }
    }

    if (currentChunk.length >= 2) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  function coordinatesMatch(first, second) {
    if (
      !Array.isArray(first) ||
      !Array.isArray(second) ||
      first.length < 2 ||
      second.length < 2
    ) {
      return false;
    }

    return Math.hypot(
      Number(first[0]) - Number(second[0]),
      Number(first[1]) - Number(second[1])
    ) <= COORDINATE_MATCH_TOLERANCE_METERS;
  }

  function mergeElevationCoordinates(target, source) {
    if (!Array.isArray(source) || source.length === 0) {
      return target;
    }

    if (target.length === 0) {
      target.push(...source);
      return target;
    }

    const startIndex = coordinatesMatch(
      target[target.length - 1],
      source[0]
    ) ? 1 : 0;

    target.push(...source.slice(startIndex));
    return target;
  }

  async function fetchElevationForSegment(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error("Linjen måste innehålla minst två punkter.");
    }

    const response = await fetch(ELEVATION_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify(
        createElevationRequest(coordinates)
      )
    });

    if (!response.ok) {
      const error = new Error(
        `Höjdtjänsten svarade med ${response.status}.`
      );

      error.status = response.status;
      throw error;
    }

    const result = await response.json();
    const geometry = result?.geometry;

    if (
      geometry?.type !== "LineString" ||
      !Array.isArray(geometry.coordinates)
    ) {
      throw new Error("Höjdtjänsten returnerade ett oväntat svar.");
    }

    const rawNoDataValue = Number(
      result?.properties?.nodatavalue
    );
    const noDataValue = Number.isFinite(rawNoDataValue)
      ? rawNoDataValue
      : -9999;

    return {
      coordinates: normalizeElevationCoordinates(
        geometry.coordinates,
        noDataValue
      ),
      noDataValue
    };
  }

  async function fetchElevationForChunk(coordinates) {
    try {
      return await fetchElevationForSegment(coordinates);
    } catch (error) {
      const segmentLength = calculateSegmentLength(coordinates);
      const shouldRetrySmaller =
        error?.status === 422 &&
        segmentLength > MIN_RETRY_CHUNK_LENGTH_METERS;

      if (!shouldRetrySmaller) {
        throw error;
      }

      const retryChunks = splitSegmentByLength(
        coordinates,
        Math.max(
          MIN_RETRY_CHUNK_LENGTH_METERS,
          segmentLength / 2
        )
      );

      if (retryChunks.length <= 1) {
        throw error;
      }

      return fetchAndMergeElevationChunks(retryChunks);
    }
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) {
          return;
        }

        results[index] = await mapper(items[index], index);
      }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    return results;
  }

  async function fetchAndMergeElevationChunks(
    chunks,
    onChunkComplete = null
  ) {
    const results = await mapWithConcurrency(
      chunks,
      MAX_PARALLEL_ELEVATION_REQUESTS,
      async chunk => {
        const result = await fetchElevationForChunk(chunk);
        onChunkComplete?.();
        return result;
      }
    );

    const mergedCoordinates = [];
    let noDataValue = -9999;

    for (const result of results) {
      noDataValue = result.noDataValue;
      mergeElevationCoordinates(
        mergedCoordinates,
        result.coordinates
      );
    }

    return { coordinates: mergedCoordinates, noDataValue };
  }

  async function getElevationForLines(lineIds, requestId) {
    if (!Array.isArray(lineIds) || lineIds.length === 0) {
      throw new Error("Inga linjer valdes för höjdhämtning.");
    }

    const map = findMap();
    findDrawnLines(map);

    const preparedLines = [];
    let totalChunks = 0;

    for (const lineId of lineIds) {
      const feature = featuresById.get(lineId);

      if (!feature) {
        throw new Error(`Kunde inte hitta linjen ${String(lineId)}.`);
      }

      const geometry = feature.getGeometry?.();
      const type = geometry?.getType?.();
      const coordinates = copyCoordinates(
        geometry?.getCoordinates?.()
      );
      const segments = getLineSegments(type, coordinates);

      if (segments.length === 0) {
        throw new Error(
          `Linjen ${String(lineId)} har en typ som inte stöds.`
        );
      }

      const segmentChunks = segments.map(segment =>
        splitSegmentByLength(segment)
      );

      totalChunks += segmentChunks.reduce(
        (total, chunks) => total + chunks.length,
        0
      );

      preparedLines.push({
        id: lineId,
        feature,
        type,
        segmentChunks
      });
    }

    let completedChunks = 0;

    const reportProgress = () => {
      completedChunks++;
      sendResult({
        action: "ELEVATION_PROGRESS",
        requestId,
        completed: completedChunks,
        total: totalChunks
      });
    };

    const elevationLines = [];

    for (const preparedLine of preparedLines) {
      const elevationSegments = [];

      for (const chunks of preparedLine.segmentChunks) {
        const result = await fetchAndMergeElevationChunks(
          chunks,
          reportProgress
        );

        elevationSegments.push(result.coordinates);
      }

      elevationLines.push({
        id: preparedLine.id,
        name: getFeatureName(
          preparedLine.feature,
          String(preparedLine.id)
        ),
        type: preparedLine.type,
        segments: elevationSegments,
        pointCount: elevationSegments.reduce(
          (total, segment) => total + segment.length,
          0
        )
      });
    }

    return {
      projection:
        map.getView?.().getProjection?.().getCode?.() ?? null,
      lines: elevationLines
    };
  }

  function sendResult(payload) {
    window.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        detail: JSON.stringify(payload)
      })
    );
  }

  function sendError(error, requestId = null) {
    console.error("[Min karta GPX]", error);

    sendResult({
      action: "ERROR",
      requestId,
      message:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }

  function parseCommand(detail) {
    if (typeof detail === "string") {
      return JSON.parse(detail);
    }

    if (detail && typeof detail === "object") {
      return detail;
    }

    throw new Error("Ogiltigt kommando.");
  }

  window.addEventListener(COMMAND_EVENT, async event => {
    let command;

    try {
      command = parseCommand(event.detail);
    } catch (error) {
      sendError(error);
      return;
    }

    const { action, requestId = null } = command;

    try {
      switch (action) {
        case "PING":
          sendResult({ action: "PONG", requestId });
          break;

        case "FIND_LINES": {
          const map = findMap();
          const lines = findDrawnLines(map);

          sendResult({
            action: "LINES_FOUND",
            requestId,
            projection:
              map.getView?.().getProjection?.().getCode?.() ?? null,
            lines
          });
          break;
        }

        case "GET_ELEVATION": {
          const result = await getElevationForLines(
            command.lineIds,
            requestId
          );

          sendResult({
            action: "ELEVATION_FOUND",
            requestId,
            projection: result.projection,
            lines: result.lines
          });
          break;
        }

        case "SET_HIGHLIGHTED_LINES": {
          const result = setHighlightedLines(command.lineIds);

          sendResult({
            action: "HIGHLIGHTS_UPDATED",
            requestId,
            projection: result.projection,
            lineIds: result.lineIds
          });
          break;
        }

        default:
          throw new Error(`Okänt kommando: ${String(action)}`);
      }
    } catch (error) {
      cachedMap = null;
      sendError(error, requestId);
    }
  });

  console.log(
    "[Min karta GPX] Page bridge v0.5 är laddad."
  );
})();
