(() => {
  "use strict";

  const PANEL_ID = "minkarta-gpx-panel";
  const COMMAND_EVENT = "MINKARTA_GPX_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_RESULT";

  let lines = [];
  const selectedLineIds = new Set();
  const lineSettings = new Map();

  let requestCounter = 0;
  let activeElevationRequestId = null;
  let pendingExportLines = [];
  let pendingExportFilename = null;
  let elevationTimeoutId = null;
  let lastSuggestedFilename = "min-karta-rutt.gpx";

  // Undvik att skapa panelen flera gånger.
  if (document.getElementById(PANEL_ID)) {
    return;
  }

  listenForResults();
  createPanel();

  // Vänta på att Min karta och page-bridge.js ska hinna laddas.
  setTimeout(findLines, 800);

  function createPanel() {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;

    panel.innerHTML = `
      <button
        id="mkgpx-toggle"
        class="mkgpx-toggle"
        type="button"
        aria-expanded="false"
      >
        <span>Min karta GPX</span>
        <span class="mkgpx-arrow">›</span>
      </button>

      <div
        id="mkgpx-content"
        class="mkgpx-content"
        aria-hidden="true"
      >
        <div class="mkgpx-content-inner">
          <p
            id="mkgpx-status"
            class="mkgpx-status"
          >
            Söker efter ritade linjer...
          </p>

          <div
            id="mkgpx-lines"
            class="mkgpx-lines"
          ></div>

          <label class="mkgpx-file-setting">
            <span>GPX-filnamn</span>
            <input
              id="mkgpx-filename"
              type="text"
              value="min-karta-rutt.gpx"
              spellcheck="false"
              autocomplete="off"
            >
          </label>

          <div class="mkgpx-actions">
            <button
              id="mkgpx-refresh"
              type="button"
            >
              Uppdatera
            </button>

            <button
              id="mkgpx-export"
              type="button"
              disabled
            >
              Exportera valda
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const toggleButton =
      document.getElementById("mkgpx-toggle");

    const content =
      document.getElementById("mkgpx-content");

    toggleButton.addEventListener("click", () => {
      const isOpen =
        panel.classList.toggle("mkgpx-open");

      toggleButton.setAttribute(
        "aria-expanded",
        String(isOpen)
      );

      content.setAttribute(
        "aria-hidden",
        String(!isOpen)
      );
    });

    document
      .getElementById("mkgpx-refresh")
      .addEventListener("click", findLines);

    document
      .getElementById("mkgpx-export")
      .addEventListener(
        "click",
        exportSelectedLines
      );

    const filenameInput =
      document.getElementById("mkgpx-filename");

    filenameInput.addEventListener("blur", () => {
      filenameInput.value = normalizeFilename(
        filenameInput.value
      );
    });
  }

  function listenForResults() {
    window.addEventListener(
      RESULT_EVENT,
      event => {
        let result;

        try {
          result =
            typeof event.detail === "string"
              ? JSON.parse(event.detail)
              : event.detail;
        } catch (error) {
          console.error(
            "[Min karta GPX] Kunde inte läsa svar:",
            error
          );

          setStatus(
            "Kunde inte läsa svaret från kartan.",
            true
          );

          return;
        }

        if (
          !result ||
          typeof result !== "object"
        ) {
          return;
        }

        switch (result.action) {
  case "LINES_FOUND":
    handleLinesFound(result);
    break;

  case "ELEVATION_FOUND":
    handleElevationFound(result);
    break;

  case "ELEVATION_PROGRESS": {
    if (
      activeElevationRequestId &&
      result.requestId === activeElevationRequestId
    ) {
      const completed = Number(result.completed) || 0;
      const total = Number(result.total) || 0;

      setStatus(
        total > 0
          ? `Hämtar höjddata... del ${completed} av ${total}`
          : "Hämtar höjddata..."
      );
    }
    break;
  }

  case "HIGHLIGHTS_UPDATED":
    break;

  case "ERROR":
    if (
      activeElevationRequestId &&
      result.requestId === activeElevationRequestId
    ) {
      offerExportWithoutElevation(
        result.message || "Kunde inte hämta höjddata."
      );
      break;
    }

    setStatus(
      result.message || "Ett okänt fel inträffade.",
      true
    );
    break;

  case "PONG":
    console.log(
      "[Min karta GPX] Page bridge svarar."
    );
    break;
        }
      }
    );
  }

  function sendCommand(action, extraData = {}) {
    requestCounter++;

    const requestId =
      `request-${requestCounter}`;

    window.dispatchEvent(
      new CustomEvent(COMMAND_EVENT, {
        detail: JSON.stringify({
          action,
          requestId,
          ...extraData
        })
      })
    );

    return requestId;
  }

  function findLines() {
    setStatus("Söker efter ritade linjer...");

    const linesContainer =
      document.getElementById("mkgpx-lines");

    const exportButton =
      document.getElementById("mkgpx-export");

    if (linesContainer) {
      linesContainer.innerHTML = "";
    }

    if (exportButton) {
      exportButton.disabled = true;
    }

    sendCommand("FIND_LINES");
  }

  function handleLinesFound(result) {
    if (
      result.projection &&
      result.projection !== "EPSG:3006"
    ) {
      setStatus(
        `Oväntad kartprojektion: ${result.projection}`,
        true
      );

      return;
    }

    lines = Array.isArray(result.lines)
      ? result.lines
      : [];

    const availableIds = new Set(
      lines.map(line => line.id)
    );

    // Ta bort val som inte längre finns.
    for (
      const selectedId of [...selectedLineIds]
    ) {
      if (!availableIds.has(selectedId)) {
        selectedLineIds.delete(selectedId);
      }
    }

    // Markera första linjen automatiskt.
    if (
      selectedLineIds.size === 0 &&
      lines.length > 0
    ) {
      selectedLineIds.add(lines[0].id);
    }

    renderLines();
  }

  function renderLines() {
    const container =
      document.getElementById("mkgpx-lines");

    const exportButton =
      document.getElementById("mkgpx-export");

    if (!container || !exportButton) {
      return;
    }

    container.innerHTML = "";

    if (lines.length === 0) {
      selectedLineIds.clear();
      exportButton.disabled = true;

      updateFilenameSuggestion(true);
      syncHighlightedLines();

      setStatus(
        "Ingen ritad linje hittades. Rita en linje och tryck Uppdatera."
      );

      return;
    }

    lines.forEach((line, index) => {
      const settings = getLineSettings(
        line,
        index
      );

      const card =
        document.createElement("div");

      card.className = "mkgpx-line";
      card.dataset.lineId = line.id;

      const topRow =
        document.createElement("div");

      topRow.className = "mkgpx-line-top";

      const checkbox =
        document.createElement("input");

      checkbox.type = "checkbox";
      checkbox.value = line.id;
      checkbox.checked =
        selectedLineIds.has(line.id);
      checkbox.setAttribute(
        "aria-label",
        `Välj ${settings.name}`
      );

      checkbox.addEventListener(
        "change",
        () => {
          if (checkbox.checked) {
            selectedLineIds.add(line.id);
          } else {
            selectedLineIds.delete(line.id);
          }

          exportButton.disabled =
            selectedLineIds.size === 0;

          updateSelectionStatus();
          updateFilenameSuggestion();
          syncHighlightedLines();
        }
      );

      const details =
        document.createElement("small");

      details.textContent =
        `${formatLength(line.lengthMeters)} · ` +
        `${line.pointCount} ritpunkter`;

      topRow.append(checkbox, details);

      const nameLabel =
        document.createElement("label");

      nameLabel.className =
        "mkgpx-line-name";

      const nameCaption =
        document.createElement("span");

      nameCaption.textContent = "Spårnamn";

      const nameInput =
        document.createElement("input");

      nameInput.type = "text";
      nameInput.value = settings.name;
      nameInput.maxLength = 120;
      nameInput.autocomplete = "off";
      nameInput.spellcheck = false;

      nameInput.addEventListener("input", () => {
        settings.name =
          nameInput.value.trimStart();

        checkbox.setAttribute(
          "aria-label",
          `Välj ${
            settings.name ||
            `Linje ${index + 1}`
          }`
        );

        updateFilenameSuggestion();
      });

      nameInput.addEventListener("blur", () => {
        if (!settings.name.trim()) {
          settings.name =
            line.name || `Linje ${index + 1}`;
          nameInput.value = settings.name;
          updateFilenameSuggestion();
        }
      });

      nameLabel.append(
        nameCaption,
        nameInput
      );

      card.append(topRow, nameLabel);
      container.appendChild(card);
    });

    exportButton.disabled =
      selectedLineIds.size === 0;

    updateSelectionStatus();
    updateFilenameSuggestion();
    syncHighlightedLines();
  }

  function getLineSettings(line, index) {
    if (!lineSettings.has(line.id)) {
      lineSettings.set(line.id, {
        name:
          line.name || `Linje ${index + 1}`
      });
    }

    return lineSettings.get(line.id);
  }

  function getEditedLineName(line, index) {
    const settings = getLineSettings(
      line,
      index
    );

    return (
      settings.name.trim() ||
      line.name ||
      `Linje ${index + 1}`
    );
  }

  function updateFilenameSuggestion(force = false) {
    const filenameInput =
      document.getElementById("mkgpx-filename");

    if (!filenameInput) {
      return;
    }

    const selectedLines = lines.filter(line =>
      selectedLineIds.has(line.id)
    );

    let suggestion = "min-karta-rutt.gpx";

    if (selectedLines.length === 1) {
      const line = selectedLines[0];
      const index = lines.indexOf(line);

      suggestion = createFilename(
        getEditedLineName(line, index)
      );
    } else if (selectedLines.length > 1) {
      suggestion = "min-karta-rutter.gpx";
    }

    const currentValue =
      filenameInput.value.trim();

    if (
      force ||
      !currentValue ||
      currentValue === lastSuggestedFilename
    ) {
      filenameInput.value = suggestion;
    }

    lastSuggestedFilename = suggestion;
  }

  function syncHighlightedLines() {
    sendCommand(
      "SET_HIGHLIGHTED_LINES",
      {
        lineIds: [...selectedLineIds]
      }
    );
  }

  function updateSelectionStatus() {
    if (lines.length === 0) {
      return;
    }

    const selectedCount =
      selectedLineIds.size;

    if (selectedCount === 0) {
      setStatus(
        `${lines.length} linjer hittades · ingen vald`
      );

      return;
    }

    setStatus(
      `${lines.length} linjer hittades · ` +
      `${selectedCount} valda`
    );
  }

  function setStatus(
    message,
    isError = false
  ) {
    const status =
      document.getElementById("mkgpx-status");

    if (!status) {
      return;
    }

    status.textContent = message;

    status.classList.toggle(
      "mkgpx-error",
      isError
    );
  }

  function formatLength(lengthMeters) {
    const meters = Number(lengthMeters);

    if (!Number.isFinite(meters)) {
      return "Okänd längd";
    }

    if (meters < 1000) {
      return `${Math.round(meters)} m`;
    }

    return `${(meters / 1000).toLocaleString(
      "sv-SE",
      {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }
    )} km`;
  }

  function exportSelectedLines() {
    if (activeElevationRequestId) {
      return;
    }

    const selectedLines = lines.filter(line =>
      selectedLineIds.has(line.id)
    );

    if (selectedLines.length === 0) {
      setStatus(
        "Välj minst en linje först.",
        true
      );

      return;
    }

    pendingExportLines = selectedLines.map(
      line => {
        const index = lines.indexOf(line);

        return {
  id: line.id,
  name: getEditedLineName(
    line,
    index
  ),
  type: line.type,
  coordinates: line.coordinates
};
      }
    );

    const filenameInput =
      document.getElementById("mkgpx-filename");

    pendingExportFilename = normalizeFilename(
      filenameInput?.value ||
        (selectedLines.length === 1
          ? createFilename(
              pendingExportLines[0].name
            )
          : "min-karta-rutter.gpx")
    );

    setExportBusy(true);
    setStatus(
      selectedLines.length === 1
        ? "Hämtar höjddata..."
        : `Hämtar höjddata för ${selectedLines.length} linjer...`
    );

    activeElevationRequestId = sendCommand(
      "GET_ELEVATION",
      {
        lineIds: selectedLines.map(
          line => line.id
        )
      }
    );

    const totalLengthMeters = selectedLines.reduce(
      (total, line) =>
        total + (Number(line.lengthMeters) || 0),
      0
    );

    const estimatedElevationRequests = Math.max(
      1,
      Math.ceil(totalLengthMeters / 55_000)
    );

    const elevationTimeoutMilliseconds = Math.min(
      15 * 60_000,
      Math.max(
        2 * 60_000,
        Math.ceil(estimatedElevationRequests / 2) * 60_000
      )
    );

    elevationTimeoutId = window.setTimeout(
      () => {
        if (!activeElevationRequestId) {
          return;
        }

        offerExportWithoutElevation(
          "Höjdhämtningen tog för lång tid."
        );
      },
      elevationTimeoutMilliseconds
    );
  }

  function handleElevationFound(result) {
    if (
      !activeElevationRequestId ||
      result.requestId !==
        activeElevationRequestId
    ) {
      return;
    }

    try {
      if (
        result.projection &&
        result.projection !== "EPSG:3006"
      ) {
        throw new Error(
          `Oväntad kartprojektion: ${result.projection}`
        );
      }

      const elevationLines =
        Array.isArray(result.lines)
          ? result.lines
          : [];

      if (elevationLines.length === 0) {
        throw new Error(
          "Höjdtjänsten returnerade inga linjer."
        );
      }

      const namesById = new Map(
        pendingExportLines.map(line => [
          line.id,
          line.name
        ])
      );

      const exportLines = elevationLines.map(
        (line, index) => ({
          ...line,
          name:
            namesById.get(line.id) ||
            line.name ||
            `Linje ${index + 1}`
        })
      );

      const gpx = createGpx(exportLines);

      const filename =
        pendingExportFilename ||
        (exportLines.length === 1
          ? createFilename(
              exportLines[0].name
            )
          : "min-karta-rutter.gpx");

      downloadTextFile(gpx, filename);

      const elevationPointCount =
        exportLines.reduce(
          (total, line) =>
            total +
            (Number(line.pointCount) || 0),
          0
        );

      if (exportLines.length === 1) {
        setStatus(
          `Exporterade ${
            exportLines[0].name ||
            "vald linje"
          } med ${elevationPointCount} höjdpunkter.`
        );
      } else {
        setStatus(
          `Exporterade ${exportLines.length} linjer med ` +
          `${elevationPointCount} höjdpunkter.`
        );
      }
} catch (error) {
  console.error(
    "[Min karta GPX]",
    error
  );

  offerExportWithoutElevation(
    error instanceof Error
      ? error.message
      : "Kunde inte använda höjddatan."
  );
} finally {
  finishElevationRequest();
}
  }

  function offerExportWithoutElevation(errorMessage) {

  const exportLines = pendingExportLines.map(
    (line, index) => ({
      id: line.id,
      name: line.name || `Linje ${index + 1}`,
      type: line.type,
      coordinates: line.coordinates
    })
  );

  const filename =
    pendingExportFilename ||
    (exportLines.length === 1
      ? createFilename(exportLines[0].name)
      : "min-karta-rutter.gpx");

  finishElevationRequest();

  if (exportLines.length === 0) {
    setStatus(
      errorMessage || "Kunde inte hämta höjddata.",
      true
    );
    return;
  }

  const shouldExport = window.confirm(
    "Höjddata kunde inte hämtas.\n\n" +
    `${errorMessage || "Höjdtjänsten svarade med ett fel."}\n\n` +
    "Tillägget försökte även dela långa linjer i mindre delar.\n\n" +
    "Vill du exportera GPX-filen utan höjddata?"
  );

  if (!shouldExport) {
    setStatus("Exporten avbröts.");
    return;
  }

  try {
    const gpx = createGpx(exportLines);

    downloadTextFile(
      gpx,
      filename
    );

    if (exportLines.length === 1) {
      setStatus(
        `Exporterade ${
          exportLines[0].name || "vald linje"
        } utan höjddata.`
      );
    } else {
      setStatus(
        `Exporterade ${exportLines.length} linjer utan höjddata.`
      );
    }
  } catch (error) {
    console.error(
      "[Min karta GPX]",
      error
    );

    setStatus(
      error instanceof Error
        ? error.message
        : "Kunde inte skapa GPX-filen.",
      true
    );
  }
}

  function finishElevationRequest() {
    if (elevationTimeoutId !== null) {
      window.clearTimeout(
        elevationTimeoutId
      );
      elevationTimeoutId = null;
    }

    activeElevationRequestId = null;
    pendingExportLines = [];
    pendingExportFilename = null;
    setExportBusy(false);
  }

  function setExportBusy(isBusy) {
    const exportButton =
      document.getElementById("mkgpx-export");

    const refreshButton =
      document.getElementById("mkgpx-refresh");

    if (exportButton) {
      exportButton.textContent = isBusy
        ? "Hämtar höjd..."
        : "Exportera valda";

      exportButton.disabled =
        isBusy ||
        selectedLineIds.size === 0;
    }

    if (refreshButton) {
      refreshButton.disabled = isBusy;
    }

    document
      .querySelectorAll(
        "#mkgpx-lines input[type=\"checkbox\"]"
      )
      .forEach(checkbox => {
        checkbox.disabled = isBusy;
      });
  }

  function createGpx(selectedLines) {
    if (
      !Array.isArray(selectedLines) ||
      selectedLines.length === 0
    ) {
      throw new Error(
        "Inga linjer valdes för export."
      );
    }

    const tracks = selectedLines
      .map((line, lineIndex) => {
        const segments =
          Array.isArray(line.segments)
            ? line.segments
            : normalizeSegments(
                line.type,
                line.coordinates
              );

        if (segments.length === 0) {
          return "";
        }

        const trackSegments = segments
          .map(segment => {
            const trackPoints = segment
              .map(coordinate => {
                if (
                  !Array.isArray(coordinate) ||
                  coordinate.length < 2
                ) {
                  return "";
                }

                const easting =
                  Number(coordinate[0]);

                const northing =
                  Number(coordinate[1]);

                if (
                  !Number.isFinite(easting) ||
                  !Number.isFinite(northing)
                ) {
                  return "";
                }

                const {
                  latitude,
                  longitude
                } = sweref99TmToWgs84(
                  easting,
                  northing
                );

                const elevation =
                  coordinate.length >= 3 &&
                  coordinate[2] !== null
                    ? Number(coordinate[2])
                    : null;

                if (Number.isFinite(elevation)) {
                  return (
                    `      <trkpt lat="${latitude.toFixed(7)}"` +
                    ` lon="${longitude.toFixed(7)}">\n` +
                    `        <ele>${elevation.toFixed(2)}</ele>\n` +
                    "      </trkpt>"
                  );
                }

                return (
                  `      <trkpt lat="${latitude.toFixed(7)}"` +
                  ` lon="${longitude.toFixed(7)}"></trkpt>`
                );
              })
              .filter(Boolean)
              .join("\n");

            if (!trackPoints) {
              return "";
            }

            return `    <trkseg>
${trackPoints}
    </trkseg>`;
          })
          .filter(Boolean)
          .join("\n");

        if (!trackSegments) {
          return "";
        }

        const trackName = escapeXml(
          line.name ||
            `Linje ${lineIndex + 1}`
        );

        return `  <trk>
    <name>${trackName}</name>
${trackSegments}
  </trk>`;
      })
      .filter(Boolean)
      .join("\n");

    if (!tracks) {
      throw new Error(
        "De valda linjerna saknar giltiga koordinater."
      );
    }

    const metadataName =
      selectedLines.length === 1
        ? escapeXml(
            selectedLines[0].name ||
              "Min karta-rutt"
          )
        : "Min karta-rutter";

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx
  version="1.1"
  creator="Min karta GPX"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${metadataName}</name>
  </metadata>
${tracks}
</gpx>`;
  }

  function normalizeSegments(
    type,
    coordinates
  ) {
    if (!Array.isArray(coordinates)) {
      return [];
    }

    if (type === "LineString") {
      return [coordinates];
    }

    if (type === "MultiLineString") {
      return coordinates.filter(
        Array.isArray
      );
    }

    return [];
  }

  function createFilename(name) {
    const safeName = String(
      name || "min-karta-rutt"
    )
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return `${
      safeName || "min-karta-rutt"
    }.gpx`;
  }

  function normalizeFilename(value) {
    let filename = String(
      value || "min-karta-rutt.gpx"
    )
      .trim()
      .replace(/[\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "");

    if (!filename) {
      filename = "min-karta-rutt.gpx";
    }

    if (!/\.gpx$/i.test(filename)) {
      filename += ".gpx";
    }

    return filename;
  }

  function downloadTextFile(
    text,
    filename
  ) {
    const blob = new Blob(
      [text],
      {
        type:
          "application/gpx+xml;charset=utf-8"
      }
    );

    const objectUrl =
      URL.createObjectURL(blob);

    const link =
      document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }

  function escapeXml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  /*
   * Omvandlar SWEREF 99 TM, EPSG:3006,
   * till WGS84 för GPX.
   */
  function sweref99TmToWgs84(
    easting,
    northing
  ) {
    const semiMajorAxis = 6378137.0;
    const flattening =
      1 / 298.257222101;

    const scale = 0.9996;

    const centralMeridian =
      15 * Math.PI / 180;

    const eccentricitySquared =
      flattening * (2 - flattening);

    const secondEccentricitySquared =
      eccentricitySquared /
      (1 - eccentricitySquared);

    const x = easting - 500000;
    const y = northing;

    const meridionalArc = y / scale;

    const mu =
      meridionalArc /
      (
        semiMajorAxis *
        (
          1 -
          eccentricitySquared / 4 -
          3 *
            eccentricitySquared ** 2 /
            64 -
          5 *
            eccentricitySquared ** 3 /
            256
        )
      );

    const e1 =
      (
        1 -
        Math.sqrt(
          1 - eccentricitySquared
        )
      ) /
      (
        1 +
        Math.sqrt(
          1 - eccentricitySquared
        )
      );

    const footprintLatitude =
      mu +
      (
        3 * e1 / 2 -
        27 * e1 ** 3 / 32
      ) *
        Math.sin(2 * mu) +
      (
        21 * e1 ** 2 / 16 -
        55 * e1 ** 4 / 32
      ) *
        Math.sin(4 * mu) +
      (
        151 * e1 ** 3 / 96
      ) *
        Math.sin(6 * mu) +
      (
        1097 * e1 ** 4 / 512
      ) *
        Math.sin(8 * mu);

    const sinLatitude =
      Math.sin(footprintLatitude);

    const cosLatitude =
      Math.cos(footprintLatitude);

    const tanLatitude =
      Math.tan(footprintLatitude);

    const c1 =
      secondEccentricitySquared *
      cosLatitude ** 2;

    const t1 =
      tanLatitude ** 2;

    const n1 =
      semiMajorAxis /
      Math.sqrt(
        1 -
        eccentricitySquared *
          sinLatitude ** 2
      );

    const r1 =
      (
        semiMajorAxis *
        (1 - eccentricitySquared)
      ) /
      (
        1 -
        eccentricitySquared *
          sinLatitude ** 2
      ) ** 1.5;

    const d = x / (n1 * scale);

    const latitude =
      footprintLatitude -
      (
        n1 *
        tanLatitude /
        r1
      ) *
      (
        d ** 2 / 2 -
        (
          5 +
          3 * t1 +
          10 * c1 -
          4 * c1 ** 2 -
          9 *
            secondEccentricitySquared
        ) *
          d ** 4 /
          24 +
        (
          61 +
          90 * t1 +
          298 * c1 +
          45 * t1 ** 2 -
          252 *
            secondEccentricitySquared -
          3 * c1 ** 2
        ) *
          d ** 6 /
          720
      );

    const longitude =
      centralMeridian +
      (
        d -
        (
          1 +
          2 * t1 +
          c1
        ) *
          d ** 3 /
          6 +
        (
          5 -
          2 * c1 +
          28 * t1 -
          3 * c1 ** 2 +
          8 *
            secondEccentricitySquared +
          24 * t1 ** 2
        ) *
          d ** 5 /
          120
      ) /
        cosLatitude;

    return {
      latitude:
        latitude * 180 / Math.PI,

      longitude:
        longitude * 180 / Math.PI
    };
  }

  console.log(
    "[Min karta GPX] Content script är laddat."
  );
})();