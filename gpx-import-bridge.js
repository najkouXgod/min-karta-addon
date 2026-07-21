(() => {
  "use strict";

  if (window.__MINKARTA_GPX_IMPORT_BRIDGE_LOADED__) {
    return;
  }

  window.__MINKARTA_GPX_IMPORT_BRIDGE_LOADED__ = true;

  const COMMAND_EVENT = "MINKARTA_GPX_IMPORT_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_IMPORT_RESULT";
  const OLD_OVERLAY_ID = "mkgpx-import-map-overlay";
  const TARGET_PATH_STORAGE_KEY =
    "minkarta-gpx-import-target-layer-path";

  let cachedMap = null;
  let cachedTarget = null;

  removeOldCanvasOverlay();

  window.addEventListener(COMMAND_EVENT, async event => {
    let command;

    try {
      command = parseCommand(event.detail);
    } catch (error) {
      sendError(error);
      return;
    }

    const requestId = command.requestId ?? null;

    try {
      if (command.action !== "IMPORT_GPX_AS_LINES") {
        throw new Error(
          `Okänt importkommando: ${String(command.action)}`
        );
      }

      await importGpxAsLines(command, requestId);
    } catch (error) {
      cachedMap = null;
      sendError(error, requestId);
    }
  });

  async function importGpxAsLines(command, requestId) {
    removeOldCanvasOverlay();

    const map = findMap();
    const tracks = Array.isArray(command.tracks)
      ? command.tracks
      : [];

    const rawSegments = [];
    const totalSegments = tracks.reduce(
      (total, track) =>
        total + (Array.isArray(track.segments) ? track.segments.length : 0),
      0
    );

    let convertedSegmentCount = 0;

    sendProgress(
      requestId,
      "Förbereder GPX-spåret..."
    );
    await yieldToBrowser();

    for (const track of tracks) {
      const explicitName =
        typeof track.name === "string" && track.name.trim()
          ? track.name.trim()
          : null;

      const segments = Array.isArray(track.segments)
        ? track.segments
        : [];

      const convertedSegments = [];

      for (const segment of segments) {
        const converted = await convertSegmentAsync(segment);
        convertedSegmentCount++;

        sendProgress(
          requestId,
          totalSegments > 1
            ? `Förbereder spår ${convertedSegmentCount} av ${totalSegments}...`
            : "Förbereder GPX-spåret..."
        );

        if (converted.length >= 2) {
          convertedSegments.push(converted);
        }
      }

      convertedSegments.forEach((coordinates, segmentIndex) => {
        rawSegments.push({
          requestedName:
            explicitName && convertedSegments.length > 1
              ? `${explicitName} – del ${segmentIndex + 1}`
              : explicitName,
          coordinates
        });
      });
    }

    if (rawSegments.length === 0) {
      throw new Error(
        "GPX-filen innehåller inga giltiga spår eller rutter."
      );
    }

    const usedNames = collectExistingLineNames(map);
    const nextLineNumber = createLineNumberGenerator(usedNames);

    const importSegments = rawSegments.map(segment => ({
      ...segment,
      name: createUniqueLineName(
        segment.requestedName,
        usedNames,
        nextLineNumber
      )
    }));

    sendProgress(
      requestId,
      "Hittar Min kartas linjelager..."
    );
    await yieldToBrowser();

    const context = findImportContext(map);
    const importedFeatures = [];

    for (let index = 0; index < importSegments.length; index++) {
      const segment = importSegments[index];

      sendProgress(
        requestId,
        importSegments.length > 1
          ? `Lägger till linje ${index + 1} av ${importSegments.length}...`
          : "Lägger till GPX-spåret som linje..."
      );
      await yieldToBrowser();

      const feature = createIntegratedFeature(
        context,
        segment.name,
        segment.coordinates,
        map
      );

      importedFeatures.push(feature);
    }

    context.source?.changed?.();
    context.layer?.changed?.();
    map.render?.();

    /* Spara den riktiga målkällan även när första importen skapades via Draw. */
    const discoveredTarget = findBestLineTarget(map);

    if (discoveredTarget) {
      cachedTarget = discoveredTarget;
      rememberTargetPath(discoveredTarget.path);
    }

    zoomToCoordinates(
      map,
      importSegments.map(segment => segment.coordinates)
    );

    sendResult({
      action: "GPX_IMPORTED_AS_LINES",
      requestId,
      lineCount: importedFeatures.length,
      lineNames: importSegments.map(segment => segment.name),
      pointCount: importSegments.reduce(
        (total, segment) =>
          total + segment.coordinates.length,
        0
      )
    });
  }

  function findImportContext(map) {
    const currentTarget = findBestLineTarget(map);

    if (currentTarget) {
      cachedTarget = currentTarget;
      rememberTargetPath(currentTarget.path);

      return {
        strategy: "clone",
        ...currentTarget
      };
    }

    if (isUsableCachedTarget(cachedTarget, map)) {
      return {
        strategy: "clone",
        ...cachedTarget
      };
    }

    const rememberedTarget = findRememberedTarget(map);
    const drawInteraction = findLineDrawInteraction(
      map,
      rememberedTarget?.source ?? null
    );

    if (drawInteraction) {
      return {
        strategy: "draw",
        interaction: drawInteraction.interaction,
        source:
          drawInteraction.source ??
          rememberedTarget?.source ??
          null,
        layer: rememberedTarget?.layer ?? null,
        path: rememberedTarget?.path ?? null
      };
    }

    /*
     * Om lagersökvägen är känd men draw-interaktionen inte kan hittas,
     * kan en tidigare cachad template fortfarande användas under samma sida.
     */
    if (
      rememberedTarget &&
      cachedTarget?.templateFeature &&
      typeof cachedTarget.templateFeature.clone === "function"
    ) {
      return {
        strategy: "clone",
        ...rememberedTarget,
        templateFeature: cachedTarget.templateFeature
      };
    }

    throw new Error(
      "Kunde inte skapa en linje i Min karta. " +
      "Öppna ritverktyget en gång eller rita en kort linje och försök igen."
    );
  }

  function createIntegratedFeature(
    context,
    name,
    coordinates,
    map
  ) {
    if (context.strategy === "draw") {
      return createWithDrawInteraction(
        context.interaction,
        name,
        coordinates,
        map
      );
    }

    return createByCloningTemplate(
      context,
      name,
      coordinates
    );
  }

  function createWithDrawInteraction(
    interaction,
    name,
    coordinates,
    map
  ) {
    if (
      typeof interaction?.appendCoordinates !== "function" ||
      typeof interaction?.finishDrawing !== "function"
    ) {
      throw new Error(
        "Min kartas ritverktyg kunde inte användas för importen."
      );
    }

    const source = getInteractionSource(interaction);
    const existingFeatures = new Set(
      source?.getFeatures?.() ?? []
    );

    let createdFeature = null;

    const drawEndHandler = event => {
      createdFeature = event?.feature ?? createdFeature;
    };

    interaction.once?.("drawend", drawEndHandler);

    const wasActive = interaction.getActive?.();

    if (wasActive === false) {
      interaction.setActive?.(true);
    }

    try {
      interaction.abortDrawing?.();

      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];

      /*
       * Mata bara ritverktyget med två punkter. Att skicka tusentals
       * GPX-punkter via appendCoordinates är mycket långsamt.
       * Hela geometrin sätts direkt efter att featuren har skapats.
       */
      interaction.appendCoordinates([
        [Number(first[0]), Number(first[1])],
        [Number(last[0]), Number(last[1])]
      ]);

      const returnedFeature = interaction.finishDrawing();
      createdFeature = returnedFeature ?? createdFeature;

      if (!createdFeature && source?.getFeatures) {
        createdFeature = source
          .getFeatures()
          .find(feature => !existingFeatures.has(feature)) ?? null;
      }
    } finally {
      if (wasActive === false) {
        interaction.setActive?.(false);
      }
    }

    if (!createdFeature) {
      throw new Error(
        "Min kartas ritverktyg skapade ingen linje."
      );
    }

    const geometry = createdFeature.getGeometry?.();

    if (!geometry || typeof geometry.setCoordinates !== "function") {
      throw new Error(
        "Den importerade linjens geometri kunde inte uppdateras."
      );
    }

    geometry.setCoordinates(
      coordinates.map(coordinate => [
        Number(coordinate[0]),
        Number(coordinate[1])
      ])
    );

    createdFeature.setGeometry?.(geometry);
    applyImportedMetadata(createdFeature, name);
    clearClonedHighlightStyle(createdFeature);
    reapplyImportedName(createdFeature, name);
    createdFeature.changed?.();
    source?.changed?.();
    map.render?.();

    return createdFeature;
  }

  function createByCloningTemplate(
    context,
    name,
    coordinates
  ) {
    const templateFeature = context.templateFeature;

    if (
      !templateFeature ||
      typeof templateFeature.clone !== "function"
    ) {
      throw new Error("Linjemallen saknas.");
    }

    const feature = templateFeature.clone();
    const templateGeometry = templateFeature.getGeometry?.();
    const geometry = templateGeometry?.clone?.();

    if (!geometry || typeof geometry.setCoordinates !== "function") {
      throw new Error("Linjemallens geometri kunde inte kopieras.");
    }

    geometry.setCoordinates(
      coordinates.map(coordinate => [
        Number(coordinate[0]),
        Number(coordinate[1])
      ])
    );

    feature.setGeometry(geometry);

    /*
     * templateFeature kan vara vald och ha en cyan direktstil.
     * Den stilen ska inte följa med till den nya linjen.
     */
    clearClonedHighlightStyle(feature);
    applyImportedMetadata(feature, name);

    if (typeof feature.setId === "function") {
      feature.setId(undefined);
    }

    context.source.addFeature(feature);
    context.source.changed?.();
    context.layer?.changed?.();

    reapplyImportedName(feature, name);
    feature.changed?.();

    return feature;
  }

  function clearClonedHighlightStyle(feature) {
    if (typeof feature?.setStyle === "function") {
      feature.setStyle(undefined);
    }
  }

  function applyImportedMetadata(feature, name) {
    const properties = {
      name,
      title: name,
      label: name,
      minkartaGpxName: name,
      minkartaGpxImported: true
    };

    if (typeof feature.setProperties === "function") {
      feature.setProperties(properties, true);
    } else {
      Object.entries(properties).forEach(([key, value]) => {
        feature.set?.(key, value, true);
      });
    }

    feature.changed?.();
  }

  function reapplyImportedName(feature, name) {
    /*
     * Min karta kan sätta egna feature-egenskaper i drawend.
     * Namnet återställs några gånger, men stilen lämnas orörd så
     * vanlig cyan markering fortfarande fungerar när linjen väljs.
     */
    [0, 80, 300, 900].forEach(delay => {
      window.setTimeout(() => {
        if (!feature?.getGeometry?.()) {
          return;
        }

        applyImportedMetadata(feature, name);
      }, delay);
    });
  }

  function findBestLineTarget(map) {
    const candidates = [];

    walkLayers(map, (layer, source, path) => {
      if (
        !source ||
        typeof source.getFeatures !== "function" ||
        typeof source.addFeature !== "function"
      ) {
        return;
      }

      let features;

      try {
        features = source.getFeatures();
      } catch {
        return;
      }

      if (!Array.isArray(features)) {
        return;
      }

      const layerSourceText = [
        propertiesAsText(layer),
        propertiesAsText(source),
        path
      ].join(" ").toLowerCase();

      const looksLikeDrawingLayer =
        /measure|measurement|distance|length|mat|mät|draw|drawing|sketch|rit/.test(
          layerSourceText
        );

      /* Hoppa över stora bakgrundslager som annars kan ta lång tid att skanna. */
      if (features.length > 500 && !looksLikeDrawingLayer) {
        return;
      }

      features.forEach((feature, featureIndex) => {
        const geometry = feature.getGeometry?.();
        const type = geometry?.getType?.();

        if (type !== "LineString") {
          return;
        }

        if (
          typeof feature.clone !== "function" ||
          typeof geometry.clone !== "function"
        ) {
          return;
        }

        candidates.push({
          layer,
          source,
          templateFeature: feature,
          path,
          map,
          score: scoreLineCandidate(
            layer,
            source,
            feature,
            features.length,
            featureIndex,
            path
          )
        });
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  function scoreLineCandidate(
    layer,
    source,
    feature,
    featureCount,
    featureIndex,
    path
  ) {
    let score = 0;

    const searchableText = [
      propertiesAsText(layer),
      propertiesAsText(source),
      propertiesAsText(feature),
      path
    ]
      .join(" ")
      .toLowerCase();

    if (/measure|measurement|distance|length|mat|mät/.test(searchableText)) {
      score += 300;
    }

    if (/draw|drawing|sketch|rit/.test(searchableText)) {
      score += 180;
    }

    if (feature.get?.("measure") === true) {
      score += 300;
    }

    if (feature.get?.("minkartaGpxImported") === true) {
      score -= 40;
    }

    if (layer.getVisible?.() !== false) {
      score += 40;
    }

    const zIndex = Number(layer.getZIndex?.());

    if (Number.isFinite(zIndex)) {
      score += Math.min(100, Math.max(-100, zIndex / 10));
    }

    if (featureCount <= 50) {
      score += 80;
    } else if (featureCount <= 250) {
      score += 25;
    } else if (featureCount > 1000) {
      score -= 250;
    }

    score += Math.min(20, featureIndex);
    return score;
  }

  function findLineDrawInteraction(map, preferredSource) {
    const interactions =
      map.getInteractions?.().getArray?.() ?? [];

    const candidates = [];

    interactions.forEach((interaction, index) => {
      if (
        typeof interaction?.appendCoordinates !== "function" ||
        typeof interaction?.finishDrawing !== "function"
      ) {
        return;
      }

      const source = getInteractionSource(interaction);
      const text = interactionAsText(interaction).toLowerCase();
      let score = 0;

      if (/linestring|line string|line/.test(text)) {
        score += 500;
      }

      if (/measure|distance|length|mat|mät/.test(text)) {
        score += 250;
      }

      if (/draw|sketch|rit/.test(text)) {
        score += 100;
      }

      if (/polygon|circle|point/.test(text)) {
        score -= 600;
      }

      if (source && source === preferredSource) {
        score += 1_000;
      }

      if (
        source &&
        typeof source.addFeature === "function"
      ) {
        score += 100;
      }

      if (interaction.getActive?.() === true) {
        score += 25;
      }

      score -= index / 100;

      /*
       * Använd inte en okänd draw-interaktion om vi saknar både
       * LineString-indikation och matchande källa.
       */
      if (
        score < 400 &&
        !(preferredSource && source === preferredSource)
      ) {
        return;
      }

      candidates.push({
        interaction,
        source,
        score
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  function getInteractionSource(interaction) {
    const possibleSources = [
      interaction.source_,
      interaction.get?.("source"),
      interaction.source,
      interaction.getSource?.()
    ];

    return possibleSources.find(source =>
      source && typeof source.addFeature === "function"
    ) ?? null;
  }

  function interactionAsText(interaction) {
    const values = [];

    let keys;

    try {
      keys = Reflect.ownKeys(interaction);
    } catch {
      return "";
    }

    for (const key of keys.slice(0, 250)) {
      let value;

      try {
        value = interaction[key];
      } catch {
        continue;
      }

      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        values.push(`${String(key)} ${String(value)}`);
      }
    }

    values.push(interaction.constructor?.name ?? "");
    return values.join(" ");
  }

  function collectExistingLineNames(map) {
    const names = new Set();

    walkLayers(map, (_layer, source) => {
      if (!source || typeof source.getFeatures !== "function") {
        return;
      }

      let features;

      try {
        features = source.getFeatures();
      } catch {
        return;
      }

      const featureList = features ?? [];
      const sourceText = propertiesAsText(source).toLowerCase();

      if (
        featureList.length > 500 &&
        !/measure|measurement|distance|length|mat|mät|draw|drawing|sketch|rit/.test(sourceText)
      ) {
        return;
      }

      for (const feature of featureList) {
        const type = feature.getGeometry?.()?.getType?.();

        if (
          type !== "LineString" &&
          type !== "MultiLineString"
        ) {
          continue;
        }

        const name = getKnownFeatureName(feature);

        if (name) {
          names.add(name);
        }
      }
    });

    return names;
  }

  function getKnownFeatureName(feature) {
    const possibleNames = [
      feature.get?.("minkartaGpxName"),
      feature.get?.("name"),
      feature.get?.("title"),
      feature.get?.("label")
    ];

    const name = possibleNames.find(value =>
      typeof value === "string" && value.trim()
    );

    return name?.trim() ?? null;
  }

  function createLineNumberGenerator(usedNames) {
    let next = 1;

    for (const name of usedNames) {
      const match = /^Linje\s+(\d+)$/i.exec(name);

      if (match) {
        next = Math.max(next, Number(match[1]) + 1);
      }
    }

    return () => {
      while (usedNames.has(`Linje ${next}`)) {
        next++;
      }

      const name = `Linje ${next}`;
      next++;
      return name;
    };
  }

  function createUniqueLineName(
    requestedName,
    usedNames,
    nextLineNumber
  ) {
    if (!requestedName) {
      const generated = nextLineNumber();
      usedNames.add(generated);
      return generated;
    }

    const cleanName = requestedName.trim();

    if (!usedNames.has(cleanName)) {
      usedNames.add(cleanName);
      return cleanName;
    }

    let duplicateNumber = 2;
    let candidate = `${cleanName} (${duplicateNumber})`;

    while (usedNames.has(candidate)) {
      duplicateNumber++;
      candidate = `${cleanName} (${duplicateNumber})`;
    }

    usedNames.add(candidate);
    return candidate;
  }

  function rememberTargetPath(path) {
    if (!path) {
      return;
    }

    try {
      window.sessionStorage.setItem(
        TARGET_PATH_STORAGE_KEY,
        path
      );
    } catch {
      /* Lagring är bara en optimering. */
    }
  }

  function findRememberedTarget(map) {
    let path;

    try {
      path = window.sessionStorage.getItem(
        TARGET_PATH_STORAGE_KEY
      );
    } catch {
      return null;
    }

    if (!path) {
      return null;
    }

    const layer = findLayerByPath(map, path);
    const source = layer?.getSource?.();

    if (
      !source ||
      typeof source.addFeature !== "function"
    ) {
      return null;
    }

    return {
      map,
      path,
      layer,
      source
    };
  }

  function findLayerByPath(map, path) {
    const indices = String(path)
      .split("/")
      .map(part => {
        const match = /(?:layer-)?(\d+)$/.exec(part);
        return match ? Number(match[1]) : NaN;
      });

    if (
      indices.length === 0 ||
      indices.some(index => !Number.isInteger(index))
    ) {
      return null;
    }

    let layers = getTopLevelLayers(map);
    let layer = null;

    for (const index of indices) {
      layer = layers[index];

      if (!layer) {
        return null;
      }

      layers = layer.getLayers?.().getArray?.() ?? [];
    }

    return layer;
  }

  function isUsableCachedTarget(target, map) {
    return Boolean(
      target &&
      target.map === map &&
      target.source &&
      typeof target.source.addFeature === "function" &&
      target.templateFeature &&
      typeof target.templateFeature.clone === "function"
    );
  }

  function propertiesAsText(object) {
    if (!object) {
      return "";
    }

    let properties = {};

    try {
      properties = object.getProperties?.() ?? {};
    } catch {
      properties = {};
    }

    return Object.entries(properties)
      .filter(([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(" ");
  }

  function walkLayers(map, visit) {
    const rootLayers = getTopLevelLayers(map);

    function inspect(layer, path) {
      if (!layer) {
        return;
      }

      if (typeof layer.getLayers === "function") {
        const children =
          layer.getLayers()?.getArray?.() ?? [];

        children.forEach((child, index) => {
          inspect(child, `${path}/${index}`);
        });

        return;
      }

      visit(layer, layer.getSource?.(), path);
    }

    rootLayers.forEach((layer, index) => {
      inspect(layer, `layer-${index}`);
    });
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

  async function convertSegmentAsync(segment) {
    if (!Array.isArray(segment)) {
      return [];
    }

    const converted = [];
    const batchSize = 5_000;

    for (let index = 0; index < segment.length; index++) {
      const coordinate = convertCoordinate(segment[index]);

      if (coordinate) {
        converted.push(coordinate);
      }

      if (index > 0 && index % batchSize === 0) {
        await yieldToBrowser();
      }
    }

    return converted;
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

    return [easting, northing];
  }

  function zoomToCoordinates(map, segments) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    segments.forEach(segment => {
      segment.forEach(coordinate => {
        const x = Number(coordinate?.[0]);
        const y = Number(coordinate?.[1]);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return;
        }

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      });
    });

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return;
    }

    const view = map.getView?.();

    view?.fit?.([minX, minY, maxX, maxY], {
      padding: [70, 70, 70, 70],
      duration: 450,
      maxZoom: 16
    });
  }

  function removeOldCanvasOverlay() {
    document.getElementById(OLD_OVERLAY_ID)?.remove();
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
    const semiMajorAxis = 6378137.0;
    const flattening = 1 / 298.257222101;
    const centralMeridian = 15 * Math.PI / 180;
    const scale = 0.9996;
    const falseEasting = 500000;

    const latitudeRadians = latitude * Math.PI / 180;
    const longitudeRadians = longitude * Math.PI / 180;

    const eccentricitySquared =
      flattening * (2 - flattening);

    const secondEccentricitySquared =
      eccentricitySquared /
      (1 - eccentricitySquared);

    const sinLatitude = Math.sin(latitudeRadians);
    const cosLatitude = Math.cos(latitudeRadians);
    const tanLatitude = Math.tan(latitudeRadians);

    const n =
      semiMajorAxis /
      Math.sqrt(
        1 -
        eccentricitySquared * sinLatitude ** 2
      );

    const t = tanLatitude ** 2;
    const c =
      secondEccentricitySquared * cosLatitude ** 2;

    const a =
      cosLatitude *
      (longitudeRadians - centralMeridian);

    const meridionalArc =
      semiMajorAxis *
      (
        (
          1 -
          eccentricitySquared / 4 -
          3 * eccentricitySquared ** 2 / 64 -
          5 * eccentricitySquared ** 3 / 256
        ) * latitudeRadians -
        (
          3 * eccentricitySquared / 8 +
          3 * eccentricitySquared ** 2 / 32 +
          45 * eccentricitySquared ** 3 / 1024
        ) * Math.sin(2 * latitudeRadians) +
        (
          15 * eccentricitySquared ** 2 / 256 +
          45 * eccentricitySquared ** 3 / 1024
        ) * Math.sin(4 * latitudeRadians) -
        (
          35 * eccentricitySquared ** 3 / 3072
        ) * Math.sin(6 * latitudeRadians)
      );

    const easting =
      falseEasting +
      scale * n *
      (
        a +
        (1 - t + c) * a ** 3 / 6 +
        (
          5 -
          18 * t +
          t ** 2 +
          72 * c -
          58 * secondEccentricitySquared
        ) * a ** 5 / 120
      );

    const northing =
      scale *
      (
        meridionalArc +
        n * tanLatitude *
        (
          a ** 2 / 2 +
          (
            5 -
            t +
            9 * c +
            4 * c ** 2
          ) * a ** 4 / 24 +
          (
            61 -
            58 * t +
            t ** 2 +
            600 * c -
            330 * secondEccentricitySquared
          ) * a ** 6 / 720
        )
      );

    return { easting, northing };
  }


  function sendProgress(requestId, message) {
    sendResult({
      action: "GPX_IMPORT_PROGRESS",
      requestId,
      message
    });
  }

  function yieldToBrowser() {
    return new Promise(resolve => {
      window.setTimeout(resolve, 0);
    });
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
    "[Min karta GPX] Integrerad GPX-import v0.5 är laddad."
  );
})();
