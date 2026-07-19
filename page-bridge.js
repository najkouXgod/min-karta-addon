(() => {
  "use strict";

  // Förhindra att skriptet startas flera gånger.
  if (window.__MINKARTA_GPX_BRIDGE_LOADED__) {
    return;
  }

  window.__MINKARTA_GPX_BRIDGE_LOADED__ = true;

  const COMMAND_EVENT = "MINKARTA_GPX_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_RESULT";
  const ELEVATION_URL =
    "/api/hojdprofil/hojdprofil/v1";

  let cachedMap = null;

  /*
   * Varje OpenLayers-feature får ett eget ID.
   * Själva feature-objektet skickas inte till content.js.
   */
  const featureIds = new WeakMap();
  const featuresById = new Map();
  const originalHighlightStates = new WeakMap();
  const highlightedFeatures = new Map();

  const HIGHLIGHT_COLOR = "#00e5ff";
  const HIGHLIGHT_WIDTH = 7;

  let nextFeatureId = 1;

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

  function getFeatureId(feature) {
    if (featureIds.has(feature)) {
      return featureIds.get(feature);
    }

    const id = `line-${nextFeatureId++}`;

    featureIds.set(feature, id);
    featuresById.set(id, feature);

    return id;
  }

  /**
   * Försöker först använda sökvägen vi redan hittat.
   * Om Lantmäteriet ändrar React-strukturen görs en bredare sökning.
   */
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

        // Den sökväg vi hittade vid testningen.
        const directMap =
          fiber?.return?.stateNode?.props
            ?.maps?.WEMAP_KARTA?.map;

        if (isOpenLayersMap(directMap)) {
          cachedMap = directMap;
          return cachedMap;
        }

        // Reservmetod om React-strukturen ändras något.
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

      // Undvik att söka igenom hela DOM-trädet.
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
          descriptor =
            Object.getOwnPropertyDescriptor(value, key);
        } catch {
          continue;
        }

        /*
         * Kör inte getters från webbplatsen.
         * Vi läser bara vanliga lagrade värden.
         */
        if (!descriptor || !("value" in descriptor)) {
          continue;
        }

        const result = search(
          descriptor.value,
          depth + 1
        );

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
      map
        .getLayerGroup?.()
        .getLayers?.()
        .getArray?.() ??
      []
    );
  }

  function copyCoordinates(coordinates) {
    if (!Array.isArray(coordinates)) {
      return coordinates;
    }

    return coordinates.map(copyCoordinates);
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

  function calculateSegmentLength(coordinates) {
    let length = 0;

    for (let index = 1; index < coordinates.length; index++) {
      const [previousX, previousY] =
        coordinates[index - 1];

      const [currentX, currentY] =
        coordinates[index];

      length += Math.hypot(
        currentX - previousX,
        currentY - previousY
      );
    }

    return length;
  }

  /*
   * EPSG:3006 använder meter, så avståndet mellan
   * koordinaterna ger en användbar linjelängd i meter.
   */
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

  function getFeatureName(feature, fallbackName) {
    const possibleNames = [
      feature.get?.("name"),
      feature.get?.("title"),
      feature.get?.("label")
    ];

    const name = possibleNames.find(
      value =>
        typeof value === "string" &&
        value.trim().length > 0
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

      /*
       * Ett lager kan vara en grupp med fler lager.
       */
      if (typeof layer.getLayers === "function") {
        const children =
          layer.getLayers()?.getArray?.() ?? [];

        children.forEach((child, index) => {
          inspectLayer(child, `${path}/${index}`);
        });

        return;
      }

      const source = layer.getSource?.();

      if (
        !source ||
        typeof source.getFeatures !== "function"
      ) {
        return;
      }

      let features;

      try {
        features = source.getFeatures();
      } catch {
        return;
      }

      for (const feature of features) {
        const geometry = feature.getGeometry?.();
        const type = geometry?.getType?.();

        if (
          type !== "LineString" &&
          type !== "MultiLineString"
        ) {
          continue;
        }

        const rawCoordinates =
          geometry.getCoordinates?.();

        if (!Array.isArray(rawCoordinates)) {
          continue;
        }

        const coordinates =
          copyCoordinates(rawCoordinates);

        const fallbackName = `Linje ${lineNumber}`;

        lines.push({
          id: getFeatureId(feature),
          name: getFeatureName(
            feature,
            fallbackName
          ),
          type,
          layerPath: path,
          coordinates,
          pointCount: countPoints(
            type,
            coordinates
          ),
          lengthMeters: calculateLength(
            type,
            coordinates
          )
        });

        lineNumber++;
      }
    }

    const layers = getTopLevelLayers(map);

    layers.forEach((layer, index) => {
      inspectLayer(layer, `layer-${index}`);
    });

    return lines;
  }

  function getOwnFeatureProperty(
    feature,
    propertyName
  ) {
    const properties =
      feature.getProperties?.() ?? {};

    return {
      exists: Object.prototype.hasOwnProperty.call(
        properties,
        propertyName
      ),
      value: properties[propertyName]
    };
  }

  function createHighlightPropertyStyle(style) {
    const baseStyle =
      style &&
      typeof style === "object" &&
      !Array.isArray(style)
        ? { ...style }
        : {};

    return {
      ...baseStyle,
      strokeColor: HIGHLIGHT_COLOR,
      strokeWidth: Math.max(
        HIGHLIGHT_WIDTH,
        Number(baseStyle.strokeWidth) || 0
      ),
      pointRadius: Math.max(
        6,
        Number(baseStyle.pointRadius) || 0
      )
    };
  }

  function cloneOpenLayersStyle(style) {
    if (Array.isArray(style)) {
      const clonedStyles = style
        .map(cloneOpenLayersStyle)
        .filter(Boolean);

      return clonedStyles.length > 0
        ? clonedStyles
        : null;
    }

    if (
      !style ||
      typeof style === "function" ||
      typeof style.clone !== "function"
    ) {
      return null;
    }

    const clonedStyle = style.clone();
    const stroke = clonedStyle.getStroke?.();

    if (stroke) {
      const clonedStroke =
        typeof stroke.clone === "function"
          ? stroke.clone()
          : stroke;

      clonedStroke.setColor?.(
        HIGHLIGHT_COLOR
      );
      clonedStroke.setWidth?.(
        Math.max(
          HIGHLIGHT_WIDTH,
          Number(clonedStroke.getWidth?.()) || 0
        )
      );

      if (
        clonedStroke !== stroke &&
        typeof clonedStyle.setStroke === "function"
      ) {
        clonedStyle.setStroke(clonedStroke);
      }
    }

    clonedStyle.setZIndex?.(10_000);

    return clonedStyle;
  }

  function applyFeatureHighlight(
    featureId,
    feature
  ) {
    if (!feature || highlightedFeatures.has(featureId)) {
      return;
    }

    const styleProperty =
      getOwnFeatureProperty(
        feature,
        "style"
      );

    const directStyle =
      feature.getStyle?.();

    originalHighlightStates.set(
      feature,
      {
        stylePropertyExists:
          styleProperty.exists,
        stylePropertyValue:
          styleProperty.value,
        directStyle
      }
    );

    if (typeof feature.set === "function") {
      feature.set(
        "style",
        createHighlightPropertyStyle(
          styleProperty.value
        )
      );
    }

    const highlightedDirectStyle =
      cloneOpenLayersStyle(directStyle);

    if (
      highlightedDirectStyle &&
      typeof feature.setStyle === "function"
    ) {
      feature.setStyle(
        highlightedDirectStyle
      );
    }

    feature.changed?.();
    highlightedFeatures.set(
      featureId,
      feature
    );
  }

  function restoreFeatureHighlight(
    featureId,
    feature
  ) {
    const state =
      originalHighlightStates.get(feature);

    if (state) {
      if (typeof feature.setStyle === "function") {
        feature.setStyle(state.directStyle);
      }

      if (state.stylePropertyExists) {
        feature.set?.(
          "style",
          state.stylePropertyValue
        );
      } else {
        feature.unset?.("style");
      }

      originalHighlightStates.delete(feature);
    }

    feature.changed?.();
    highlightedFeatures.delete(featureId);
  }

  function setHighlightedLines(lineIds) {
    const map = findMap();

    // Uppdatera feature-registret innan ID:n används.
    findDrawnLines(map);

    const requestedIds = new Set(
      Array.isArray(lineIds)
        ? lineIds.map(String)
        : []
    );

    for (
      const [featureId, feature] of
      [...highlightedFeatures.entries()]
    ) {
      if (!requestedIds.has(featureId)) {
        restoreFeatureHighlight(
          featureId,
          feature
        );
      }
    }

    for (const featureId of requestedIds) {
      const feature =
        featuresById.get(featureId);

      if (feature) {
        applyFeatureHighlight(
          featureId,
          feature
        );
      }
    }

    map.render?.();

    return {
      projection:
        map
          .getView?.()
          .getProjection?.()
          .getCode?.() ?? null,
      lineIds: [...requestedIds].filter(
        featureId =>
          highlightedFeatures.has(featureId)
      )
    };
  }

  function getLineSegments(type, coordinates) {
    if (type === "LineString") {
      return [coordinates];
    }

    if (type === "MultiLineString") {
      return coordinates.filter(
        segment =>
          Array.isArray(segment) &&
          segment.length >= 2
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
              coordinates:
                copyCoordinates(coordinates)
            },
            properties: {
              measure: true,
              length:
                calculateSegmentLength(
                  coordinates
                )
            }
          }
        ]
      }
    };
  }

  function normalizeElevationCoordinates(
    coordinates,
    noDataValue
  ) {
    if (!Array.isArray(coordinates)) {
      throw new Error(
        "Höjdtjänsten returnerade inga koordinater."
      );
    }

    return coordinates.map(coordinate => {
      if (
        !Array.isArray(coordinate) ||
        coordinate.length < 3
      ) {
        throw new Error(
          "Höjdtjänsten returnerade en ogiltig punkt."
        );
      }

      const easting = Number(coordinate[0]);
      const northing = Number(coordinate[1]);
      const rawElevation = Number(coordinate[2]);

      if (
        !Number.isFinite(easting) ||
        !Number.isFinite(northing)
      ) {
        throw new Error(
          "Höjdtjänsten returnerade ogiltiga kartkoordinater."
        );
      }

      const elevation =
        Number.isFinite(rawElevation) &&
        rawElevation !== noDataValue
          ? rawElevation
          : null;

      return [
        easting,
        northing,
        elevation
      ];
    });
  }

  async function fetchElevationForSegment(
    coordinates
  ) {
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2
    ) {
      throw new Error(
        "Linjen måste innehålla minst två punkter."
      );
    }

    const response = await fetch(
      ELEVATION_URL,
      {
        method: "POST",
        headers: {
          Accept:
            "application/json, text/plain, */*",
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify(
          createElevationRequest(coordinates)
        )
      }
    );

    if (!response.ok) {
      throw new Error(
        `Höjdtjänsten svarade med ${response.status}.`
      );
    }

    const result = await response.json();
    const geometry = result?.geometry;

    if (
      geometry?.type !== "LineString" ||
      !Array.isArray(geometry.coordinates)
    ) {
      throw new Error(
        "Höjdtjänsten returnerade ett oväntat svar."
      );
    }

    const noDataValue = Number(
      result?.properties?.nodatavalue
    );

    return {
      coordinates:
        normalizeElevationCoordinates(
          geometry.coordinates,
          Number.isFinite(noDataValue)
            ? noDataValue
            : -9999
        ),
      noDataValue:
        Number.isFinite(noDataValue)
          ? noDataValue
          : -9999
    };
  }

  async function getElevationForLines(
    lineIds
  ) {
    if (
      !Array.isArray(lineIds) ||
      lineIds.length === 0
    ) {
      throw new Error(
        "Inga linjer valdes för höjdhämtning."
      );
    }

    const map = findMap();

    /*
     * Uppdatera feature-registret innan ID:n slås upp.
     * Det hjälper om kartan har laddat om sina lager.
     */
    findDrawnLines(map);

    const elevationLines = [];

    for (const lineId of lineIds) {
      const feature = featuresById.get(lineId);

      if (!feature) {
        throw new Error(
          `Kunde inte hitta linjen ${String(lineId)}.`
        );
      }

      const geometry = feature.getGeometry?.();
      const type = geometry?.getType?.();
      const rawCoordinates =
        geometry?.getCoordinates?.();

      if (!Array.isArray(rawCoordinates)) {
        throw new Error(
          `Linjen ${String(lineId)} saknar koordinater.`
        );
      }

      const segments = getLineSegments(
        type,
        copyCoordinates(rawCoordinates)
      );

      if (segments.length === 0) {
        throw new Error(
          `Linjen ${String(lineId)} har en typ som inte stöds.`
        );
      }

      const elevationSegments = [];

      /*
       * Kör delsträckorna i ordning. Det minskar risken
       * att höjdtjänsten belastas med många parallella anrop.
       */
      for (const segment of segments) {
        const elevationResult =
          await fetchElevationForSegment(
            segment
          );

        elevationSegments.push(
          elevationResult.coordinates
        );
      }

      elevationLines.push({
        id: lineId,
        name: getFeatureName(
          feature,
          String(lineId)
        ),
        type,
        segments: elevationSegments,
        pointCount: elevationSegments.reduce(
          (total, segment) =>
            total + segment.length,
          0
        )
      });
    }

    return {
      projection:
        map
          .getView?.()
          .getProjection?.()
          .getCode?.() ?? null,
      lines: elevationLines
    };
  }

  function sendResult(payload) {
    /*
     * JSON-strängen gör kommunikationen mellan MAIN och
     * ISOLATED enklare och förhindrar problem med JS-objekt
     * från olika körmiljöer.
     */
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

    if (
      detail &&
      typeof detail === "object"
    ) {
      return detail;
    }

    throw new Error("Ogiltigt kommando.");
  }

  window.addEventListener(
    COMMAND_EVENT,
    async event => {
      let command;

      try {
        command = parseCommand(event.detail);
      } catch (error) {
        sendError(error);
        return;
      }

      const {
        action,
        requestId = null
      } = command;

      try {
        switch (action) {
          case "PING": {
            sendResult({
              action: "PONG",
              requestId
            });

            break;
          }

          case "FIND_LINES": {
            const map = findMap();
            const view = map.getView();
            const lines = findDrawnLines(map);

            sendResult({
              action: "LINES_FOUND",
              requestId,
              projection:
                view
                  .getProjection?.()
                  .getCode?.() ?? null,
              lines
            });

            break;
          }

          case "GET_ELEVATION": {
            const elevationResult =
              await getElevationForLines(
                command.lineIds
              );

            sendResult({
              action: "ELEVATION_FOUND",
              requestId,
              projection:
                elevationResult.projection,
              lines: elevationResult.lines
            });

            break;
          }

          case "SET_HIGHLIGHTED_LINES": {
            const highlightResult =
              setHighlightedLines(
                command.lineIds
              );

            sendResult({
              action: "HIGHLIGHTS_UPDATED",
              requestId,
              projection:
                highlightResult.projection,
              lineIds: highlightResult.lineIds
            });

            break;
          }

          default: {
            throw new Error(
              `Okänt kommando: ${String(action)}`
            );
          }
        }
      } catch (error) {
        /*
         * Kartobjektet kan ha blivit gammalt efter att
         * webbplatsen har laddat om delar av appen.
         */
        cachedMap = null;
        sendError(error, requestId);
      }
    }
  );

  console.log("[Min karta GPX] Page bridge är laddad.");
})();