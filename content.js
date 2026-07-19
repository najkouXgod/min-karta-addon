(() => {
  "use strict";

  const PANEL_ID = "minkarta-gpx-panel";
  const COMMAND_EVENT = "MINKARTA_GPX_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_RESULT";

  let lines = [];
  const selectedLineIds = new Set();
  let requestCounter = 0;

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

          case "ERROR":
            setStatus(
              result.message ||
                "Ett okänt fel inträffade.",
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

      setStatus(
        "Ingen ritad linje hittades. Rita en linje och tryck Uppdatera."
      );

      return;
    }

    lines.forEach((line, index) => {
      const label =
        document.createElement("label");

      label.className = "mkgpx-line";

      const checkbox =
        document.createElement("input");

      checkbox.type = "checkbox";
      checkbox.value = line.id;
      checkbox.checked =
        selectedLineIds.has(line.id);

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
        }
      );

      const information =
        document.createElement("span");

      information.className =
        "mkgpx-line-information";

      const name =
        document.createElement("strong");

      name.textContent =
        line.name || `Linje ${index + 1}`;

      const details =
        document.createElement("small");

      details.textContent =
        `${formatLength(line.lengthMeters)} · ` +
        `${line.pointCount} punkter`;

      information.append(name, details);
      label.append(checkbox, information);
      container.appendChild(label);
    });

    exportButton.disabled =
      selectedLineIds.size === 0;

    updateSelectionStatus();
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

    try {
      const gpx = createGpx(selectedLines);

      const filename =
        selectedLines.length === 1
          ? createFilename(
              selectedLines[0].name
            )
          : "min-karta-rutter.gpx";

      downloadTextFile(gpx, filename);

      if (selectedLines.length === 1) {
        setStatus(
          `Exporterade ${
            selectedLines[0].name ||
            "vald linje"
          }.`
        );
      } else {
        setStatus(
          `Exporterade ${selectedLines.length} linjer.`
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
        const segments = normalizeSegments(
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