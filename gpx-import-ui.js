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
  const IMPORT_TIMEOUT_MS = 120_000;

  let requestCounter = 0;
  let activeRequestId = null;
  let requestTimeoutId = null;

  listenForImportResults();
  initializeWhenPanelExists();

  function initializeWhenPanelExists() {
    const initialize = () => {
      const panel =
        document.getElementById("minkarta-gpx-panel");

      if (!panel) {
        return false;
      }

      document
        .getElementById("mkgpx-import-section")
        ?.remove();

      if (document.getElementById("mkgpx-import-button")) {
        return true;
      }

      createImportButton(panel);
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

  function createImportButton(panel) {
    const actions = panel.querySelector(".mkgpx-actions");

    if (!actions) {
      return;
    }

    const importButton = document.createElement("button");
    importButton.id = "mkgpx-import-button";
    importButton.type = "button";
    importButton.textContent = "Importera GPX";

    const fileInput = document.createElement("input");
    fileInput.id = "mkgpx-import-file";
    fileInput.type = "file";
    fileInput.accept =
      ".gpx,application/gpx+xml,application/xml,text/xml";
    fileInput.hidden = true;

    actions.prepend(importButton);
    panel.appendChild(fileInput);

    importButton.addEventListener("click", () => {
      if (activeRequestId) {
        return;
      }

      fileInput.value = "";
      fileInput.click();
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
      setMainStatus(
        "GPX-filen är större än 25 MB.",
        true
      );
      return;
    }

    setImportBusy(true);
    setMainStatus(`Läser ${file.name}...`);

    try {
      const xmlText = await file.text();
      const parsed = parseGpx(xmlText);

      /*
       * Event skickas synkront mellan ISOLATED och MAIN.
       * Därför måste activeRequestId sättas före dispatchEvent,
       * annars kan ett snabbt svar lämna importknappen låst.
       */
      const requestId = createRequestId();
      activeRequestId = requestId;

      startRequestTimeout(requestId);

      setMainStatus("Förbereder GPX-spåret...");

      sendImportCommand(
        "IMPORT_GPX_AS_LINES",
        {
          ...parsed,
          sourceFilename: file.name
        },
        requestId
      );
    } catch (error) {
      finishRequest();

      setMainStatus(
        error instanceof Error
          ? error.message
          : "Kunde inte läsa GPX-filen.",
        true
      );
    }
  }

  function parseGpx(xmlText) {
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
          /* null betyder att importbryggan ska skapa Linje N. */
          name:
            directChildText(trackElement, "name") || null,
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
            directChildText(routeElement, "name") || null,
          segments: [route]
        });

        totalPointCount += route.length;
      }
    }

    if (tracks.length === 0) {
      throw new Error(
        "GPX-filen innehåller inga spår eller rutter."
      );
    }

    if (totalPointCount > MAX_IMPORT_POINTS) {
      throw new Error(
        `GPX-filen innehåller ${totalPointCount.toLocaleString("sv-SE")} ` +
        `punkter. Maxgränsen är ${MAX_IMPORT_POINTS.toLocaleString("sv-SE")}.`
      );
    }

    return { tracks };
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

  function createRequestId() {
    requestCounter++;
    return `gpx-import-${requestCounter}`;
  }

  function sendImportCommand(
    action,
    extraData,
    requestId
  ) {
    window.dispatchEvent(
      new CustomEvent(COMMAND_EVENT, {
        detail: JSON.stringify({
          action,
          requestId,
          ...extraData
        })
      })
    );
  }

  function startRequestTimeout(requestId) {
    clearRequestTimeout();

    requestTimeoutId = window.setTimeout(() => {
      if (activeRequestId !== requestId) {
        return;
      }

      finishRequest();
      setMainStatus(
        "Importen tog för lång tid. Prova en mindre GPX-fil eller ladda om Min karta.",
        true
      );
    }, IMPORT_TIMEOUT_MS);
  }

  function clearRequestTimeout() {
    if (requestTimeoutId !== null) {
      window.clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  }

  function finishRequest() {
    clearRequestTimeout();
    activeRequestId = null;
    setImportBusy(false);
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
        !activeRequestId ||
        result.requestId !== activeRequestId
      ) {
        return;
      }

      switch (result.action) {
        case "GPX_IMPORT_PROGRESS":
          setMainStatus(
            result.message || "Importerar GPX-spåret..."
          );
          break;

        case "GPX_IMPORTED_AS_LINES":
          finishRequest();
          setMainStatus(
            `Importerade ${result.lineCount} linjer · ` +
            `${Number(result.pointCount || 0).toLocaleString("sv-SE")} punkter.`
          );

          /*
           * Min karta kan färdigbehandla drawend asynkront.
           * Två uppdateringar gör att listan och namnen hinner med.
           */
          refreshLineListAfter(120);
          refreshLineListAfter(650);
          break;

        case "GPX_IMPORT_ERROR":
          finishRequest();
          setMainStatus(
            result.message ||
              "Kunde inte importera GPX-filen.",
            true
          );
          break;
      }
    });
  }

  function refreshLineListAfter(delay) {
    window.setTimeout(() => {
      document
        .getElementById("mkgpx-refresh")
        ?.click();
    }, delay);
  }

  function setImportBusy(isBusy) {
    const button =
      document.getElementById("mkgpx-import-button");

    if (!button) {
      return;
    }

    button.disabled = isBusy;
    button.textContent = isBusy
      ? "Importerar..."
      : "Importera GPX";
  }

  function setMainStatus(message, isError = false) {
    const status =
      document.getElementById("mkgpx-status");

    if (!status) {
      return;
    }

    status.textContent = message;
    status.classList.toggle("mkgpx-error", isError);
  }
})();
