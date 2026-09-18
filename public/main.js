"use strict";

const CONFIG = Object.freeze({
  arrivalHour: 17,
  arrivalMinute: 30,

  commuteApiUrl: "/api/commute",

  requestTimeoutMs: 12000,

  nearCheckMs: 5 * 60 * 1000,
  farCheckMs: 15 * 60 * 1000,

  storageKey: "commute-monitor-fixed-v2",
  notificationKey: "commute-monitor-notified-date-v2"
});

/**
 * @typedef {Object} Coordinate
 * @property {number} lat
 * @property {number} lon
 * @property {string} label
 */

/**
 * @typedef {Object} RouteSummary
 * @property {number} lengthInMeters
 * @property {number} travelTimeInSeconds
 * @property {number} trafficDelayInSeconds
 * @property {number} trafficLengthInMeters
 * @property {number} noTrafficTravelTimeInSeconds
 */

/**
 * @typedef {Object} TrafficStatus
 * @property {"normal"|"moderate"|"heavy"|"severe"} level
 * @property {string} label
 */

const el = {
  form: /** @type {HTMLFormElement} */ (
    document.querySelector("#commuteForm")
  ),

  buffer: /** @type {HTMLInputElement} */ (
    document.querySelector("#bufferMinutes")
  ),

  button: /** @type {HTMLButtonElement} */ (
    document.querySelector("#checkButton")
  ),

  notificationButton: /** @type {HTMLButtonElement} */ (
    document.querySelector("#notificationButton")
  ),

  originStatus: /** @type {HTMLElement} */ (
    document.querySelector("#originStatus")
  ),

  error: /** @type {HTMLParagraphElement} */ (
    document.querySelector("#errorMessage")
  ),

  sourceState: /** @type {HTMLDivElement} */ (
    document.querySelector("#sourceState")
  ),

  leaveBy: /** @type {HTMLParagraphElement} */ (
    document.querySelector("#leaveBy")
  ),

  statusPill: /** @type {HTMLDivElement} */ (
    document.querySelector("#statusPill")
  ),

  currentDrive: /** @type {HTMLElement} */ (
    document.querySelector("#currentDrive")
  ),

  trafficDelay: /** @type {HTMLElement} */ (
    document.querySelector("#trafficDelay")
  ),

  distance: /** @type {HTMLElement} */ (
    document.querySelector("#distance")
  ),

  effectiveArrival: /** @type {HTMLElement} */ (
    document.querySelector("#effectiveArrival")
  ),

  lastUpdated: /** @type {HTMLElement} */ (
    document.querySelector("#lastUpdated")
  ),

  routeDetails: /** @type {HTMLElement} */ (
    document.querySelector("#routeDetails")
  ),

  freeFlowTime: /** @type {HTMLElement} */ (
    document.querySelector("#freeFlowTime")
  ),

  liveTime: /** @type {HTMLElement} */ (
    document.querySelector("#liveTime")
  ),

  trafficLength: /** @type {HTMLElement} */ (
    document.querySelector("#trafficLength")
  ),

  expectedArrival: /** @type {HTMLElement} */ (
    document.querySelector("#expectedArrival")
  ),

  routeUpdated: /** @type {HTMLElement} */ (
    document.querySelector("#routeUpdated")
  )
};

/** @type {number|null} */
let monitorTimer = null;

/** @type {boolean} */
let monitoring = false;

/** @type {Date|null} */
let currentLeaveBy = null;

document.addEventListener(
  "DOMContentLoaded",
  init
);

/**
 * Initializes the commute monitor.
 *
 * @returns {void}
 */
function init() {
  restoreSettings();

  el.form.addEventListener(
    "submit",
    handleMonitorToggle
  );

  el.notificationButton.addEventListener(
    "click",
    requestNotifications
  );

  el.buffer.addEventListener(
    "input",
    saveSettings
  );

  updateNotificationButton();
}

/**
 * Starts or stops commute monitoring.
 *
 * @param {SubmitEvent} event
 * @returns {Promise<void>}
 */
async function handleMonitorToggle(event) {
  event.preventDefault();

  if (monitoring) {
    stopMonitoring();
    return;
  }

  await startMonitoring();
}

/**
 * Starts commute monitoring.
 *
 * @returns {Promise<void>}
 */
async function startMonitoring() {
  clearError();

  if (!window.isSecureContext) {
    showError(
      "Phone location and notifications require this " +
      "page to be opened through an HTTPS website."
    );

    return;
  }

  monitoring = true;

  setMonitorButton(true);
  setSourceState("Starting", "loading");

  try {
    await runMonitorCheck();
  } catch (error) {
    stopMonitoring();

    showError(
      toFriendlyError(error)
    );

    setSourceState(
      "Unavailable",
      "error"
    );
  }
}

/**
 * Stops commute monitoring.
 *
 * @returns {void}
 */
function stopMonitoring() {
  monitoring = false;

  if (monitorTimer !== null) {
    window.clearTimeout(monitorTimer);
    monitorTimer = null;
  }

  setMonitorButton(false);
  setSourceState("Paused", "idle");

  el.statusPill.textContent =
    currentLeaveBy
      ? "Monitoring paused"
      : "Waiting for route";

  el.statusPill.dataset.level = "idle";
}

/**
 * Gets the phone's current location and requests a route.
 *
 * @returns {Promise<void>}
 */
async function runMonitorCheck() {
  if (!monitoring) {
    return;
  }

  clearError();

  setSourceState(
    "Checking",
    "loading"
  );

  try {
    const origin =
      await getCurrentLocation();

    el.originStatus.textContent =
      "Current location acquired";

    const route =
      await fetchCommute(origin);

    renderRoute(route);
    scheduleNextCheck();
  } catch (error) {
    showError(
      toFriendlyError(error)
    );

    setSourceState(
      "Retrying",
      "error"
    );

    scheduleNextCheck(
      CONFIG.nearCheckMs
    );
  }
}

/**
 * Schedules the next traffic check.
 *
 * The monitor checks every 15 minutes when the departure
 * time is more than two hours away. It checks every five
 * minutes as the required departure approaches.
 *
 * @param {number=} forcedDelay
 * @returns {void}
 */
function scheduleNextCheck(forcedDelay) {
  if (!monitoring) {
    return;
  }

  if (monitorTimer !== null) {
    window.clearTimeout(monitorTimer);
  }

  const minutesUntilLeave =
    currentLeaveBy
      ? (
          currentLeaveBy.getTime() -
          Date.now()
        ) / 60000
      : 0;

  const delay =
    forcedDelay ||
    (
      minutesUntilLeave > 120
        ? CONFIG.farCheckMs
        : CONFIG.nearCheckMs
    );

  monitorTimer =
    window.setTimeout(
      runMonitorCheck,
      delay
    );
}

/**
 * Gets the phone's current location.
 *
 * @returns {Promise<Coordinate>}
 */
function getCurrentLocation() {
  return new Promise(
    (resolve, reject) => {
      if (!navigator.geolocation) {
        reject(
          new Error("NO_GEOLOCATION")
        );

        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat:
              position.coords.latitude,

            lon:
              position.coords.longitude,

            label:
              "Current location"
          });
        },

        (error) => {
          if (
            error.code ===
            error.PERMISSION_DENIED
          ) {
            reject(
              new Error(
                "LOCATION_DENIED"
              )
            );
          } else if (
            error.code ===
            error.TIMEOUT
          ) {
            reject(
              new Error(
                "LOCATION_TIMEOUT"
              )
            );
          } else {
            reject(
              new Error(
                "LOCATION_FAILED"
              )
            );
          }
        },

        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000
        }
      );
    }
  );
}

/**
 * Sends the phone coordinates to the secure server endpoint.
 *
 * The TomTom API key is not sent to the browser.
 *
 * @param {Coordinate} origin
 * @returns {Promise<RouteSummary>}
 */
async function fetchCommute(origin) {
  const controller =
    new AbortController();

  const timer =
    window.setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeoutMs
    );

  try {
    const response =
      await fetch(
        CONFIG.commuteApiUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify({
              lat: origin.lat,
              lon: origin.lon
            }),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      if (response.status === 503) {
        throw new Error(
          "SERVER_CONFIGURATION"
        );
      }

      if (response.status === 429) {
        throw new Error(
          "RATE_LIMIT"
        );
      }

      const errorData =
        await response
          .json()
          .catch(() => null);

      throw new Error(
        errorData &&
        typeof errorData.error === "string"
          ? errorData.error
          : `HTTP_${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      typeof data.lengthInMeters !== "number" ||
      typeof data.travelTimeInSeconds !== "number"
    ) {
      throw new Error(
        "INVALID_ROUTE_DATA"
      );
    }

    return {
      lengthInMeters:
        data.lengthInMeters,

      travelTimeInSeconds:
        data.travelTimeInSeconds,

      trafficDelayInSeconds:
        typeof data.trafficDelayInSeconds === "number"
          ? data.trafficDelayInSeconds
          : 0,

      trafficLengthInMeters:
        typeof data.trafficLengthInMeters === "number"
          ? data.trafficLengthInMeters
          : 0,

      noTrafficTravelTimeInSeconds:
        typeof data.noTrafficTravelTimeInSeconds ===
        "number"
          ? data.noTrafficTravelTimeInSeconds
          : Math.max(
              0,
              data.travelTimeInSeconds -
                (
                  data.trafficDelayInSeconds ||
                  0
                )
            )
    };
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      throw new Error("TIMEOUT");
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Calculates and displays the live commute information.
 *
 * @param {RouteSummary} route
 * @returns {void}
 */
function renderRoute(route) {
  const travelMinutes =
    Math.max(
      1,
      Math.ceil(
        route.travelTimeInSeconds / 60
      )
    );

  const noTrafficSeconds =
    route.noTrafficTravelTimeInSeconds ||
    (
      route.travelTimeInSeconds -
      (
        route.trafficDelayInSeconds ||
        0
      )
    );

  const freeFlowMinutes =
    Math.max(
      1,
      Math.ceil(
        noTrafficSeconds / 60
      )
    );

  const delayMinutes =
    Math.max(
      0,
      Math.ceil(
        (
          route.trafficDelayInSeconds ||
          0
        ) / 60
      )
    );

  const bufferMinutes =
    clamp(
      Number(el.buffer.value),
      0,
      120
    );

  const now = new Date();

  const targetArrival =
    nextWeekdayArrival(now);

  const leaveBy =
    new Date(
      targetArrival.getTime() -
      (
        travelMinutes +
        bufferMinutes
      ) *
      60 *
      1000
    );

  const arrivalWithBuffer =
    new Date(
      targetArrival.getTime() -
      bufferMinutes *
      60 *
      1000
    );

  const expectedArrival =
    new Date(
      leaveBy.getTime() +
      travelMinutes *
      60 *
      1000
    );

  const trafficStatus =
    getTrafficStatus(
      delayMinutes,
      freeFlowMinutes
    );

  currentLeaveBy = leaveBy;

  el.leaveBy.textContent =
    formatTime(leaveBy);

  el.currentDrive.textContent =
    formatMinutes(
      travelMinutes
    );

  el.trafficDelay.textContent =
    delayMinutes > 0
      ? `+${formatMinutes(delayMinutes)}`
      : "None";

  el.distance.textContent =
    formatDistance(
      route.lengthInMeters
    );

  el.effectiveArrival.textContent =
    formatTime(
      arrivalWithBuffer
    );

  el.statusPill.textContent =
    trafficStatus.label;

  el.statusPill.dataset.level =
    trafficStatus.level;

  el.freeFlowTime.textContent =
    formatMinutes(
      freeFlowMinutes
    );

  el.liveTime.textContent =
    formatMinutes(
      travelMinutes
    );

  el.trafficLength.textContent =
    route.trafficLengthInMeters > 0
      ? formatDistance(
          route.trafficLengthInMeters
        )
      : "None reported";

  el.expectedArrival.textContent =
    formatTime(
      expectedArrival
    );

  el.lastUpdated.textContent =
    `Updated ${formatTime(now)}`;

  el.routeUpdated.textContent =
    targetArrival.toLocaleDateString(
      undefined,
      {
        weekday: "long",
        month: "short",
        day: "numeric"
      }
    );

  el.routeDetails.hidden = false;

  setSourceState(
    "Monitoring",
    "live"
  );

  maybeNotifyLeaveTime(
    now,
    leaveBy,
    travelMinutes,
    targetArrival
  );
}

/**
 * Returns the next Monday-through-Friday
 * arrival time at 5:30 PM.
 *
 * @param {Date} from
 * @returns {Date}
 */
function nextWeekdayArrival(from) {
  const target =
    new Date(from);

  target.setHours(
    CONFIG.arrivalHour,
    CONFIG.arrivalMinute,
    0,
    0
  );

  if (
    target.getTime() <=
    from.getTime()
  ) {
    target.setDate(
      target.getDate() + 1
    );
  }

  while (
    target.getDay() === 0 ||
    target.getDay() === 6
  ) {
    target.setDate(
      target.getDate() + 1
    );
  }

  return target;
}

/**
 * Sends one leave-now notification for the commute day.
 *
 * @param {Date} now
 * @param {Date} leaveBy
 * @param {number} travelMinutes
 * @param {Date} targetArrival
 * @returns {void}
 */
function maybeNotifyLeaveTime(
  now,
  leaveBy,
  travelMinutes,
  targetArrival
) {
  if (
    now.getTime() <
      leaveBy.getTime() ||
    now.getTime() >=
      targetArrival.getTime()
  ) {
    return;
  }

  const dateKey =
    createLocalDateKey(
      targetArrival
    );

  try {
    const notifiedDate =
      localStorage.getItem(
        CONFIG.notificationKey
      );

    if (
      notifiedDate === dateKey
    ) {
      return;
    }
  } catch (error) {
    // Continue if local storage is unavailable.
  }

  if (
    !("Notification" in window) ||
    Notification.permission !==
      "granted"
  ) {
    return;
  }

  new Notification(
    "Time to leave",
    {
      body:
        "Leave now for Spanish Fork. " +
        `Current drive: ${
          formatMinutes(
            travelMinutes
          )
        }. ` +
        "Arrival target: 5:30 PM.",

      tag:
        "commute-leave-now",

      requireInteraction:
        true
    }
  );

  try {
    localStorage.setItem(
      CONFIG.notificationKey,
      dateKey
    );
  } catch (error) {
    // The notification has already been sent.
  }
}

/**
 * Requests notification permission.
 *
 * @returns {Promise<void>}
 */
async function requestNotifications() {
  clearError();

  if (
    !("Notification" in window)
  ) {
    showError(
      "This browser does not support " +
      "browser notifications."
    );

    return;
  }

  if (!window.isSecureContext) {
    showError(
      "Notifications require the page " +
      "to be hosted over HTTPS."
    );

    return;
  }

  const permission =
    await Notification.requestPermission();

  updateNotificationButton();

  if (
    permission !== "granted"
  ) {
    showError(
      "Notifications were not enabled. " +
      "Change this website's notification " +
      "permission in your browser settings."
    );
  }
}

/**
 * Updates the notification button.
 *
 * @returns {void}
 */
function updateNotificationButton() {
  if (
    !("Notification" in window)
  ) {
    el.notificationButton.textContent =
      "Not supported";

    el.notificationButton.disabled =
      true;

    return;
  }

  if (
    Notification.permission ===
    "granted"
  ) {
    el.notificationButton.textContent =
      "Notifications enabled";

    el.notificationButton.disabled =
      true;

    return;
  }

  if (
    Notification.permission ===
    "denied"
  ) {
    el.notificationButton.textContent =
      "Notifications blocked";

    el.notificationButton.disabled =
      false;

    return;
  }

  el.notificationButton.textContent =
    "Enable notifications";

  el.notificationButton.disabled =
    false;
}

/**
 * Classifies current traffic.
 *
 * @param {number} delayMinutes
 * @param {number} baselineMinutes
 * @returns {TrafficStatus}
 */
function getTrafficStatus(
  delayMinutes,
  baselineMinutes
) {
  const delayRatio =
    baselineMinutes > 0
      ? delayMinutes /
        baselineMinutes
      : 0;

  if (
    delayMinutes >= 20 ||
    delayRatio >= 0.4
  ) {
    return {
      level: "severe",
      label: "Severe traffic"
    };
  }

  if (
    delayMinutes >= 12 ||
    delayRatio >= 0.25
  ) {
    return {
      level: "heavy",
      label: "Heavy traffic"
    };
  }

  if (
    delayMinutes >= 6 ||
    delayRatio >= 0.12
  ) {
    return {
      level: "moderate",
      label: "Moderate traffic"
    };
  }

  return {
    level: "normal",

    label:
      delayMinutes > 0
        ? "Normal traffic"
        : "Clear route"
  };
}

/**
 * Saves the arrival-buffer setting.
 *
 * @returns {void}
 */
function saveSettings() {
  try {
    localStorage.setItem(
      CONFIG.storageKey,

      JSON.stringify({
        buffer:
          el.buffer.value
      })
    );
  } catch (error) {
    // Local storage is optional.
  }
}

/**
 * Restores the arrival-buffer setting.
 *
 * @returns {void}
 */
function restoreSettings() {
  try {
    const savedText =
      localStorage.getItem(
        CONFIG.storageKey
      );

    if (!savedText) {
      return;
    }

    const saved =
      JSON.parse(savedText);

    if (
      saved &&
      saved.buffer !== undefined
    ) {
      el.buffer.value =
        String(saved.buffer);
    }
  } catch (error) {
    // Ignore unavailable or corrupted storage.
  }
}

/**
 * Updates the main monitoring button.
 *
 * @param {boolean} active
 * @returns {void}
 */
function setMonitorButton(active) {
  const label =
    /** @type {HTMLElement|null} */ (
      el.button.querySelector("span")
    );

  if (label) {
    label.textContent =
      active
        ? "Stop monitoring"
        : "Start monitoring";
  }
}

/**
 * Displays an error.
 *
 * @param {string} message
 * @returns {void}
 */
function showError(message) {
  el.error.textContent =
    message;

  el.error.hidden =
    false;
}

/**
 * Removes the displayed error.
 *
 * @returns {void}
 */
function clearError() {
  el.error.hidden = true;
  el.error.textContent = "";
}

/**
 * Updates the connection indicator.
 *
 * @param {string} label
 * @param {"live"|"loading"|"error"|"idle"} mode
 * @returns {void}
 */
function setSourceState(
  label,
  mode
) {
  const labelElement =
    /** @type {HTMLElement|null} */ (
      el.sourceState.lastElementChild
    );

  const dot =
    /** @type {HTMLElement|null} */ (
      el.sourceState.querySelector(
        ".dot"
      )
    );

  if (labelElement) {
    labelElement.textContent =
      label;
  }

  if (!dot) {
    return;
  }

  if (mode === "error") {
    dot.style.background =
      "var(--red)";

    dot.style.boxShadow =
      "0 0 14px var(--red)";
  } else if (
    mode === "loading"
  ) {
    dot.style.background =
      "var(--amber)";

    dot.style.boxShadow =
      "0 0 14px var(--amber)";
  } else if (
    mode === "idle"
  ) {
    dot.style.background =
      "var(--muted)";

    dot.style.boxShadow =
      "none";
  } else {
    dot.style.background =
      "var(--cyan)";

    dot.style.boxShadow =
      "0 0 14px var(--cyan)";
  }
}

/**
 * Converts a technical error into a readable message.
 *
 * @param {unknown} error
 * @returns {string}
 */
function toFriendlyError(error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  if (
    message ===
    "SERVER_CONFIGURATION"
  ) {
    return (
      "The secure server is missing its private " +
      "TomTom API key."
    );
  }

  if (
    message ===
    "TOMTOM_AUTH"
  ) {
    return (
      "TomTom rejected the private server key. " +
      "Replace the secret in the hosting settings."
    );
  }

  if (
    message ===
    "TOMTOM_UNAVAILABLE"
  ) {
    return (
      "TomTom is temporarily unavailable. " +
      "Try again in a few minutes."
    );
  }

  if (
    message ===
    "INVALID_LOCATION"
  ) {
    return (
      "The phone returned an invalid location. " +
      "Turn precise location on and try again."
    );
  }

  if (
    message ===
    "RATE_LIMIT"
  ) {
    return (
      "The TomTom request limit has been reached. " +
      "Try again later."
    );
  }

  if (
    message ===
    "NO_ROUTE"
  ) {
    return (
      "TomTom could not find a drivable route " +
      "from your current location."
    );
  }

  if (
    message ===
    "INVALID_ROUTE_DATA"
  ) {
    return (
      "The secure server returned incomplete route data."
    );
  }

  if (
    message ===
    "TIMEOUT"
  ) {
    return (
      "The traffic request took too long. " +
      "Check your connection and try again."
    );
  }

  if (
    message ===
    "NO_GEOLOCATION"
  ) {
    return (
      "This browser does not support phone location."
    );
  }

  if (
    message ===
    "LOCATION_DENIED"
  ) {
    return (
      "Location permission was denied. " +
      "Allow precise location for this website " +
      "and try again."
    );
  }

  if (
    message ===
    "LOCATION_TIMEOUT"
  ) {
    return (
      "Your phone took too long to determine its " +
      "location. Try again somewhere with a clearer " +
      "GPS signal."
    );
  }

  if (
    message ===
    "LOCATION_FAILED"
  ) {
    return (
      "Your phone's current location could not " +
      "be determined."
    );
  }

  if (
    message ===
    "DESTINATION_NOT_FOUND"
  ) {
    return (
      "TomTom could not find the fixed " +
      "Spanish Fork destination."
    );
  }

  if (
    error instanceof TypeError
  ) {
    return (
      "The secure commute server could not be reached. " +
      "Check your connection and hosting configuration."
    );
  }

  return (
    "The commute could not be checked. Try again."
  );
}

/**
 * Formats a local time.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  return date.toLocaleTimeString(
    [],
    {
      hour: "numeric",
      minute: "2-digit"
    }
  );
}

/**
 * Formats a number of minutes.
 *
 * @param {number} minutes
 * @returns {string}
 */
function formatMinutes(minutes) {
  const roundedMinutes =
    Math.max(
      0,
      Math.round(minutes)
    );

  if (roundedMinutes < 60) {
    return `${roundedMinutes} min`;
  }

  const hours =
    Math.floor(
      roundedMinutes / 60
    );

  const remainder =
    roundedMinutes % 60;

  if (remainder === 0) {
    return `${hours} hr`;
  }

  return (
    `${hours} hr ` +
    `${remainder} min`
  );
}

/**
 * Formats a distance using miles and feet.
 *
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
  if (
    !Number.isFinite(meters) ||
    meters <= 0
  ) {
    return "0 mi";
  }

  const miles =
    meters / 1609.344;

  if (miles < 0.1) {
    const feet =
      Math.round(
        meters * 3.28084
      );

    return `${feet} ft`;
  }

  const decimalPlaces =
    miles < 10 ? 1 : 0;

  return (
    `${miles.toFixed(decimalPlaces)} mi`
  );
}

/**
 * Creates a local YYYY-MM-DD date key.
 *
 * @param {Date} date
 * @returns {string}
 */
function createLocalDateKey(date) {
  const year =
    String(date.getFullYear());

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Restricts a number to a specified range.
 *
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function clamp(
  value,
  minimum,
  maximum
) {
  const safeValue =
    Number.isFinite(value)
      ? value
      : minimum;

  return Math.min(
    maximum,
    Math.max(
      minimum,
      safeValue
    )
  );
}