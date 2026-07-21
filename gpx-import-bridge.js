(() => {
  "use strict";

  if (window.__MINKARTA_GPX_IMPORT_BRIDGE_LOADED__) {
    return;
  }

  window.__MINKARTA_GPX_IMPORT_BRIDGE_LOADED__ = true;

  const COMMAND_EVENT = "MINKARTA_GPX_IMPORT_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_IMPORT_RESULT";
  const CANVAS_ID = "mkgpx-import-map-overlay";
  const LINE_COLOR = "#ff5a1f";
  const LINE_OUTLINE_COLOR = "rgba(255, 255, 255, 0.92)";
  const WAYPOINT_COLOR = "#ff5a1f";

  let cachedMap = null;
  let overlayCanvas = null;
  let importedTracks = [];
  let importedWaypoints = [];
  let mapListenersInstalled = false;

  window.addEventListener(
    COMMAND_EVENT,
    event => {
      let command;

      try {
        command = parseCommand(event.detail);
      } catch (error) {
        sendError(error);
        return;
      }

      const requestId = command.requestId ?? null;

      try {
        switch (command.action) {
          case "IMPORT_GPX":
            importGpx(command, requestId);
            break;

          case "CLEAR_IMPORTED_GPX":
            clearImportedGpx(requestId);
            break;
        }
      } catch (error) {
        sendError(error, requestId);
      }
    }
  );

  function importGpx(command, requestId) {
    const map = findMap();
    const tracks = Array.isArray(command.tracks)
      ? command.tracks
      : [];

    const waypoints = Array.isArray(command.waypoints)
      ? command.waypoints
      : [];

    const convertedTracks = tracks
      .map((track, trackIndex) => {
        const segments = Array.isArray(track.segments)
          ? track.segments
              .map(convertSegment)
              .filter(segment => segment.length >= 2)
          : [];

        return {
          name:
            typeof track.name === "string" && track.name.trim()
              ? track.name.trim()
              : `Spår ${trackIndex + 1}`,
          segments
        };
      })
      .filter(track => track.segments.length > 0);

    const convertedWaypoints = waypoints
      .map((waypoint, waypointIndex) => {
        const coordinate = convertCoordinate(
          waypoint.coordinate
        );

        if (!coordinate) {
          return null;
        }

        return {
          name:
            typeof waypoint.name === "string" &&
            waypoint.name.trim()
              ? waypoint.name.trim()
              : `Punkt ${waypointIndex + 1}`,
          coordinate
        };
      })
      .filter(Boolean);

    if (
      convertedTracks.length === 0 &&
      convertedWaypoints.length === 0
    ) {
      throw new Error(
        "GPX-filen saknar giltiga koordinater."
      );
    }

    importedTracks = convertedTracks;
    importedWaypoints = convertedWaypoints;

    ensureOverlayCanvas(map);
    installMapListeners(map);
    redrawOverlay();
    zoomToImportedData(map);

    const segmentCount = importedTracks.reduce(
      (total, track) => total + track.segments.length,
      0
    );

    const trackPointCount = importedTracks.reduce(
      (trackTotal, track) =>
        trackTotal +
        track.segments.reduce(
          (segmentTotal, segment) =>
            segmentTotal + segment.length,
          0
        ),
      0
    );

    sendResult({
      action: "GPX_IMPORTED",
      requestId,
      trackCount: importedTracks.length,
      segmentCount,
      waypointCount: importedWaypoints.length,
      pointCount:
        trackPointCount + importedWaypoints.length
    });
  }

  function clearImportedGpx(requestId) {
    importedTracks = [];
    importedWaypoints = [];
    clearCanvas();

    sendResult({
      action: "GPX_IMPORT_CLEARED",
      requestId
    });
  }

  function convertSegment(segment) {
    if (!Array.isArray(segment)) {
      return [];
    }

    return segment
      .map(convertCoordinate)
      .filter(Boolean);
  }

  function convertCoordinate(coordinate) {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2
    ) {
      return null;
    }

    const longitude = Number(coordinate[0]);
    const latitude = Number(coordinate[1]);

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      return null;
    }

    const { easting, northing } =
      wgs84ToSweref99Tm(latitude, longitude);

    const elevation =
      coordinate.length >= 3
        ? Number(coordinate[2])
        : null;

    if (Number.isFinite(elevation)) {
      return [easting, northing, elevation];
    }

    return [easting, northing];
  }

  function ensureOverlayCanvas(map) {
    const viewport = map.getViewport?.() ||
      document.querySelector(".ol-viewport");

    if (!viewport) {
      throw new Error("Kunde inte hitta kartans visningsyta.");
    }

    let canvas = document.getElementById(CANVAS_ID);

    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = CANVAS_ID;
      canvas.setAttribute("aria-hidden", "true");

      Object.assign(canvas.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none"
      });

      const controlsContainer =
        viewport.querySelector(
          ".ol-overlaycontainer-stopevent"
        );

      viewport.insertBefore(
        canvas,
        controlsContainer || null
      );
    }

    overlayCanvas = canvas;
    resizeCanvas();
  }

  function installMapListeners(map) {
    if (mapListenersInstalled) {
      return;
    }

    mapListenersInstalled = true;

    map.on?.("postrender", redrawOverlay);
    map.on?.("moveend", redrawOverlay);
    map.on?.("change:size", redrawOverlay);

    window.addEventListener("resize", redrawOverlay);
  }

  function redrawOverlay() {
    if (!overlayCanvas || !cachedMap) {
      return;
    }

    resizeCanvas();

    const context = overlayCanvas.getContext("2d");

    if (!context) {
      return;
    }

    const width = overlayCanvas.clientWidth;
    const height = overlayCanvas.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;

    context.setTransform(
      pixelRatio,
      0,
      0,
      pixelRatio,
      0,
      0
    );

    context.clearRect(0, 0, width, height);

    if (
      importedTracks.length === 0 &&
      importedWaypoints.length === 0
    ) {
      return;
    }

    context.lineCap = "round";
    context.lineJoin = "round";

    drawTracks(context, LINE_OUTLINE_COLOR, 8);
    drawTracks(context, LINE_COLOR, 4);
    drawWaypoints(context);
  }

  function drawTracks(context, strokeStyle, lineWidth) {
    context.strokeStyle = strokeStyle;
    context.lineWidth = lineWidth;

    for (const track of importedTracks) {
      for (const segment of track.segments) {
        let pathStarted = false;

        context.beginPath();

        for (const coordinate of segment) {
          const pixel = cachedMap.getPixelFromCoordinate?.(
            coordinate
          );

          if (
            !Array.isArray(pixel) ||
            !Number.isFinite(pixel[0]) ||
            !Number.isFinite(pixel[1])
          ) {
            pathStarted = false;
            continue;
          }

          if (!pathStarted) {
            context.moveTo(pixel[0], pixel[1]);
            pathStarted = true;
          } else {
            context.lineTo(pixel[0], pixel[1]);
          }
        }

        if (pathStarted) {
          context.stroke();
        }
      }
    }
  }

  function drawWaypoints(context) {
    context.font = "12px system-ui, sans-serif";
    context.textBaseline = "middle";

    const showLabels = importedWaypoints.length <= 40;

    for (const waypoint of importedWaypoints) {
      const pixel = cachedMap.getPixelFromCoordinate?.(
        waypoint.coordinate
      );

      if (
        !Array.isArray(pixel) ||
        !Number.isFinite(pixel[0]) ||
        !Number.isFinite(pixel[1])
      ) {
        continue;
      }

      context.beginPath();
      context.arc(pixel[0], pixel[1], 6, 0, Math.PI * 2);
      context.fillStyle = WAYPOINT_COLOR;
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "white";
      context.stroke();

      if (showLabels && waypoint.name) {
        context.lineWidth = 3;
        context.strokeStyle = "rgba(255,255,255,0.95)";
        context.strokeText(
          waypoint.name,
          pixel[0] + 10,
          pixel[1]
        );

        context.fillStyle = "#202020";
        context.fillText(
          waypoint.name,
          pixel[0] + 10,
          pixel[1]
        );
      }
    }
  }

  function resizeCanvas() {
    if (!overlayCanvas) {
      return;
    }

    const width = Math.max(
      1,
      Math.round(overlayCanvas.clientWidth)
    );

    const height = Math.max(
      1,
      Math.round(overlayCanvas.clientHeight)
    );

    const pixelRatio = window.devicePixelRatio || 1;
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);

    if (
      overlayCanvas.width !== targetWidth ||
      overlayCanvas.height !== targetHeight
    ) {
      overlayCanvas.width = targetWidth;
      overlayCanvas.height = targetHeight;
    }
  }

  function clearCanvas() {
    if (!overlayCanvas) {
      return;
    }

    const context = overlayCanvas.getContext("2d");

    context?.clearRect(
      0,
      0,
      overlayCanvas.width,
      overlayCanvas.height
    );
  }

  function zoomToImportedData(map) {
    const extent = calculateImportedExtent();

    if (!extent) {
      return;
    }

    const view = map.getView?.();

    if (!view) {
      return;
    }

    const width = extent[2] - extent[0];
    const height = extent[3] - extent[1];

    if (width < 1 && height < 1) {
      view.setCenter?.([
        (extent[0] + extent[2]) / 2,
        (extent[1] + extent[3]) / 2
      ]);

      const currentZoom = Number(view.getZoom?.());

      if (!Number.isFinite(currentZoom) || currentZoom < 14) {
        view.setZoom?.(14);
      }

      return;
    }

    view.fit?.(extent, {
      padding: [70, 70, 70, 70],
      duration: 450,
      maxZoom: 16
    });
  }

  function calculateImportedExtent() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const inspect = coordinate => {
      const x = Number(coordinate?.[0]);
      const y = Number(coordinate?.[1]);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    for (const track of importedTracks) {
      for (const segment of track.segments) {
        segment.forEach(inspect);
      }
    }

    for (const waypoint of importedWaypoints) {
      inspect(waypoint.coordinate);
    }

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return null;
    }

    return [minX, minY, maxX, maxY];
  }

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
          descriptor =
            Object.getOwnPropertyDescriptor(value, key);
        } catch {
          continue;
        }

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

  function wgs84ToSweref99Tm(latitude, longitude) {
    const axis = 6378137.0;
    const flattening = 1 / 298.257222101;
    const centralMeridian = 15.0;
    const scale = 0.9996;
    const falseNorthing = 0.0;
    const falseEasting = 500000.0;

    const e2 = flattening * (2.0 - flattening);
    const n = flattening / (2.0 - flattening);
    const aRoof =
      axis /
      (1.0 + n) *
      (1.0 + n ** 2 / 4.0 + n ** 4 / 64.0);

    const a = e2;
    const b = (5.0 * e2 ** 2 - e2 ** 3) / 6.0;
    const c =
      (104.0 * e2 ** 3 - 45.0 * e2 ** 4) / 120.0;
    const d = 1237.0 * e2 ** 4 / 1260.0;

    const beta1 =
      n / 2.0 -
      2.0 * n ** 2 / 3.0 +
      5.0 * n ** 3 / 16.0 +
      41.0 * n ** 4 / 180.0;

    const beta2 =
      13.0 * n ** 2 / 48.0 -
      3.0 * n ** 3 / 5.0 +
      557.0 * n ** 4 / 1440.0;

    const beta3 =
      61.0 * n ** 3 / 240.0 -
      103.0 * n ** 4 / 140.0;

    const beta4 =
      49561.0 * n ** 4 / 161280.0;

    const degreesToRadians = Math.PI / 180.0;
    const phi = latitude * degreesToRadians;
    const lambda = longitude * degreesToRadians;
    const lambdaZero = centralMeridian * degreesToRadians;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    const phiStar =
      phi -
      sinPhi * cosPhi *
      (
        a +
        b * sinPhi ** 2 +
        c * sinPhi ** 4 +
        d * sinPhi ** 6
      );

    const deltaLambda = lambda - lambdaZero;

    const xiPrime = Math.atan(
      Math.tan(phiStar) / Math.cos(deltaLambda)
    );

    const etaPrime = atanh(
      Math.cos(phiStar) * Math.sin(deltaLambda)
    );

    const northing =
      scale * aRoof *
      (
        xiPrime +
        beta1 *
          Math.sin(2.0 * xiPrime) *
          Math.cosh(2.0 * etaPrime) +
        beta2 *
          Math.sin(4.0 * xiPrime) *
          Math.cosh(4.0 * etaPrime) +
        beta3 *
          Math.sin(6.0 * xiPrime) *
          Math.cosh(6.0 * etaPrime) +
        beta4 *
          Math.sin(8.0 * xiPrime) *
          Math.cosh(8.0 * etaPrime)
      ) +
      falseNorthing;

    const easting =
      scale * aRoof *
      (
        etaPrime +
        beta1 *
          Math.cos(2.0 * xiPrime) *
          Math.sinh(2.0 * etaPrime) +
        beta2 *
          Math.cos(4.0 * xiPrime) *
          Math.sinh(4.0 * etaPrime) +
        beta3 *
          Math.cos(6.0 * xiPrime) *
          Math.sinh(6.0 * etaPrime) +
        beta4 *
          Math.cos(8.0 * xiPrime) *
          Math.sinh(8.0 * etaPrime)
      ) +
      falseEasting;

    return { easting, northing };
  }

  function atanh(value) {
    return 0.5 * Math.log((1.0 + value) / (1.0 - value));
  }

  function parseCommand(detail) {
    if (typeof detail === "string") {
      return JSON.parse(detail);
    }

    if (detail && typeof detail === "object") {
      return detail;
    }

    throw new Error("Ogiltigt importkommando.");
  }

  function sendResult(payload) {
    window.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        detail: JSON.stringify(payload)
      })
    );
  }

  function sendError(error, requestId = null) {
    console.error("[Min karta GPX import]", error);

    sendResult({
      action: "GPX_IMPORT_ERROR",
      requestId,
      message:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }

  console.log(
    "[Min karta GPX] Importbryggan är laddad."
  );
})();
