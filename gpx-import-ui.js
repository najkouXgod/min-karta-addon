(() => {
  "use strict";

  if (window.__MINKARTA_GPX_IMPORT_UI_LOADED__) {
    return;
  }

  window.__MINKARTA_GPX_IMPORT_UI_LOADED__ = true;

  const COMMAND_EVENT = "MINKARTA_GPX_IMPORT_COMMAND";
  const RESULT_EVENT = "MINKARTA_GPX_IMPORT_RESULT";
  const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
  const MAX_IMPORT_POINTS = 150_000;

  let requestCounter = 0;
  let activeRequestId = null;
  let importIsVisible = false;

  listenForImportResults();
  initializeWhenPanelExists();

  function initializeWhenPanelExists() {
    const initialize = () => {
      const panel = document.getElementById("minkarta-gpx-panel");

      if (!panel) {
        return false;
      }

      if (document.getElementById("mkgpx-import-section")) {
        return true;
      }

      createImportControls(panel);
      return true;
    };

    if (initialize()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (initialize()) {
        observer.disconnect();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setTimeout(() => observer.disconnect(), 15_000);
  }

  function createImportControls(panel) {
    const section = document.createElement("section");
    section.id = "mkgpx-import-section";
    section.className = "mkgpx-import-section";

    section.innerHTML = `
      <div class="mkgpx-import-heading">Importera GPX</div>

      <div class="mkgpx-import-actions">
        <button id="mkgpx-import-button" type="button">
          Välj GPX-fil
        </button>

        <button
          id="mkgpx-clear-import-button"
          type="button"
          disabled
        >
          Ta bort import
        </button>
      </div>

      <input
        id="mkgpx-import-file"
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        hidden
      >

      <p id="mkgpx-import-status" class="mkgpx-import-status">
        Importerade spår visas ovanpå kartan.
      </p>
    `;

    const contentInner =
      panel.querySelector(".mkgpx-content-inner") || panel;

    const fileSetting =
      contentInner.querySelector(".mkgpx-file-setting");

    if (fileSetting) {
      contentInner.insertBefore(section, fileSetting);
    } else {
      contentInner.appendChild(section);
    }

    const importButton =
      section.querySelector("#mkgpx-import-button");

    const clearButton =
      section.querySelector("#mkgpx-clear-import-button");

    const fileInput =
      section.querySelector("#mkgpx-import-file");

    importButton.addEventListener("click", () => {
      fileInput.value = "";
      fileInput.click();
    });

    clearButton.addEventListener("click", () => {
      if (activeRequestId) {
        return;
      }

      activeRequestId = sendImportCommand(
        "CLEAR_IMPORTED_GPX"
      );

      setImportBusy(true, "Tar bort importerad GPX...");
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];

      if (!file) {
        return;
      }

      await importGpxFile(file);
    });
  }

  async function importGpxFile(file) {
    if (activeRequestId) {
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setImportStatus(
        "GPX-filen är större än 25 MB.",
        true
      );
      return;
    }

    setImportBusy(true, `Läser ${file.name}...`);

    try {
      const xmlText = await file.text();
      const parsed = parseGpx(xmlText, file.name);

      activeRequestId = sendImportCommand(
        "IMPORT_GPX",
        parsed
      );

      setImportStatus("Ritar GPX-spåret på kartan...");
    } catch (error) {
      activeRequestId = null;
      setImportBusy(false);

      setImportStatus(
        error instanceof Error
          ? error.message
          : "Kunde inte läsa GPX-filen.",
        true
      );
    }
  }

  function parseGpx(xmlText, filename) {
    const xml = new DOMParser().parseFromString(
      xmlText,
      "application/xml"
    );

    if (xml.querySelector("parsererror")) {
      throw new Error("Filen innehåller ogiltig GPX/XML.");
    }

    const root = xml.documentElement;

    if (!root || root.localName.toLowerCase() !== "gpx") {
      throw new Error("Filen verkar inte vara en GPX-fil.");
    }

    const tracks = [];
    const waypoints = [];
    let totalPointCount = 0;

    for (const trackElement of elementsByName(root, "trk")) {
      const segments = [];

      for (
        const segmentElement of
        directChildrenByName(trackElement, "trkseg")
      ) {
        const segment = readPointElements(
          directChildrenByName(segmentElement, "trkpt")
        );

        if (segment.length >= 2) {
          segments.push(segment);
          totalPointCount += segment.length;
        }
      }

      if (segments.length > 0) {
        tracks.push({
          name:
            directChildText(trackElement, "name") ||
            `Spår ${tracks.length + 1}`,
          sourceType: "track",
          segments
        });
      }
    }

    for (const routeElement of elementsByName(root, "rte")) {
      const route = readPointElements(
        directChildrenByName(routeElement, "rtept")
      );

      if (route.length >= 2) {
        tracks.push({
          name:
            directChildText(routeElement, "name") ||
            `Rutt ${tracks.length + 1}`,
          sourceType: "route",
          segments: [route]
        });

        totalPointCount += route.length;
      }
    }

    for (const waypointElement of elementsByName(root, "wpt")) {
      const point = readPoint(waypointElement);

      if (!point) {
        continue;
      }

      waypoints.push({
        name:
          directChildText(waypointElement, "name") ||
          `Punkt ${waypoints.length + 1}`,
        description:
          directChildText(waypointElement, "desc") ||
          directChildText(waypointElement, "cmt") ||
          "",
        coordinate: point
      });

      totalPointCount++;
    }

    if (tracks.length === 0 && waypoints.length === 0) {
      throw new Error(
        "GPX-filen innehåller inga spår, rutter eller waypoints."
      );
    }

    if (totalPointCount > MAX_IMPORT_POINTS) {
      throw new Error(
        `GPX-filen innehåller ${totalPointCount.toLocaleString("sv-SE")} ` +
        `punkter. Maxgränsen är ${MAX_IMPORT_POINTS.toLocaleString("sv-SE")}.`
      );
    }

    return {
      filename,
      tracks,
      waypoints
    };
  }

  function readPointElements(elements) {
    const points = [];

    for (const element of elements) {
      const point = readPoint(element);

      if (point) {
        points.push(point);
      }
    }

    return points;
  }

  function readPoint(element) {
    const latitude = Number(element.getAttribute("lat"));
    const longitude = Number(element.getAttribute("lon"));

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }

    const elevationText = directChildText(element, "ele");
    const elevation =
      elevationText === "" ? null : Number(elevationText);

    if (Number.isFinite(elevation)) {
      return [longitude, latitude, elevation];
    }

    return [longitude, latitude];
  }

  function elementsByName(parent, localName) {
    return Array.from(
      parent.getElementsByTagNameNS("*", localName)
    );
  }

  function directChildrenByName(parent, localName) {
    return Array.from(parent.children).filter(
      child => child.localName === localName
    );
  }

  function directChildText(parent, localName) {
    const child = Array.from(parent.children).find(
      element => element.localName === localName
    );

    return child?.textContent?.trim() || "";
  }

  function sendImportCommand(action, extraData = {}) {
    requestCounter++;

    const requestId = `gpx-import-${requestCounter}`;

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

  function listenForImportResults() {
    window.addEventListener(RESULT_EVENT, event => {
      let result;

      try {
        result =
          typeof event.detail === "string"
            ? JSON.parse(event.detail)
            : event.detail;
      } catch (error) {
        console.error(
          "[Min karta GPX] Kunde inte läsa importsvar:",
          error
        );
        return;
      }

      if (!result || typeof result !== "object") {
        return;
      }

      if (
        activeRequestId &&
        result.requestId &&
        result.requestId !== activeRequestId
      ) {
        return;
      }

      switch (result.action) {
        case "GPX_IMPORTED": {
          activeRequestId = null;
          importIsVisible = true;
          setImportBusy(false);
          updateClearButton();

          const parts = [];

          if (result.trackCount > 0) {
            parts.push(
              `${result.trackCount} spår/rutter`
            );
          }

          if (result.waypointCount > 0) {
            parts.push(
              `${result.waypointCount} waypoints`
            );
          }

          setImportStatus(
            `Visar ${parts.join(" och ")} · ` +
            `${Number(result.pointCount || 0).toLocaleString("sv-SE")} punkter.`
          );
          break;
        }

        case "GPX_IMPORT_CLEARED":
          activeRequestId = null;
          importIsVisible = false;
          setImportBusy(false);
          updateClearButton();
          setImportStatus("Importerad GPX borttagen.");
          break;

        case "GPX_IMPORT_ERROR":
          activeRequestId = null;
          setImportBusy(false);
          updateClearButton();
          setImportStatus(
            result.message || "Kunde inte importera GPX-filen.",
            true
          );
          break;
      }
    });
  }

  function setImportBusy(isBusy, message = null) {
    const importButton =
      document.getElementById("mkgpx-import-button");

    const clearButton =
      document.getElementById("mkgpx-clear-import-button");

    if (importButton) {
      importButton.disabled = isBusy;
      importButton.textContent = isBusy
        ? "Arbetar..."
        : "Välj GPX-fil";
    }

    if (clearButton) {
      clearButton.disabled = isBusy || !importIsVisible;
    }

    if (message) {
      setImportStatus(message);
    }
  }

  function updateClearButton() {
    const clearButton =
      document.getElementById("mkgpx-clear-import-button");

    if (clearButton) {
      clearButton.disabled =
        Boolean(activeRequestId) || !importIsVisible;
    }
  }

  function setImportStatus(message, isError = false) {
    const status =
      document.getElementById("mkgpx-import-status");

    if (!status) {
      return;
    }

    status.textContent = message;
    status.classList.toggle(
      "mkgpx-import-error",
      isError
    );
  }
})();
