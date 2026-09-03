const state = {
  connected: false,
  commanding: false,
  motion: { linear: 0, yaw: 0 },
  pressed: new Set(),
  commandTimer: undefined,
  commandInFlight: undefined,
  cameraTimer: undefined,
  cameraUrl: undefined,
  cameraGeneration: 0,
};
const $ = (selector) => document.querySelector(selector);

$("#speed-scale").addEventListener("input", () => {
  $("#speed-output").textContent = `${$("#speed-scale").value}%`;
});
$("#reconnect").addEventListener("click", () => void connect());
$("#stop").addEventListener("click", () => void stopMotion("Operator pressed STOP."));
$("#release").addEventListener("click", () => void releaseSession());

for (const button of document.querySelectorAll(".drive[data-linear]")) {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !state.connected) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add("active");
    state.motion = { linear: Number(button.dataset.linear), yaw: Number(button.dataset.yaw) };
    startMotion();
  });
  const release = (event) => {
    button.classList.remove("active");
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    void stopMotion("Pointer deadman released.");
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", () => {
    button.classList.remove("active");
    if (state.commanding) void stopMotion("Pointer capture was lost.");
  });
}

document.addEventListener("keydown", (event) => {
  if (!["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code) || !state.connected) return;
  event.preventDefault();
  state.pressed.add(event.code);
  updateKeyboardMotion();
  if (!state.commanding) startMotion();
});
document.addEventListener("keyup", (event) => {
  if (!["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) return;
  state.pressed.delete(event.code);
  updateKeyboardMotion();
  if (state.motion.linear === 0 && state.motion.yaw === 0) void stopMotion("Keyboard deadman released.");
});
window.addEventListener("blur", () => void stopMotion("Window focus was lost."));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    void stopMotion("Direct console was backgrounded.");
  } else if (state.connected) {
    startCamera();
  }
});
window.addEventListener("pagehide", () => {
  stopCamera();
  void fetch("/api/hold", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true });
});

setInterval(() => {
  if (state.connected && !state.commanding && !document.hidden) void refreshState();
}, 300);

async function connect() {
  await stopMotion("Reconnecting direct console.");
  setNotice("Requesting simulation lease and robot-local ownership…");
  try {
    const body = await api("/api/connect", {});
    state.connected = Boolean(body.state.connected);
    renderState(body.state);
    setNotice("Ready. Hold a direction button or W/A/S/D to move the Gazebo B2W.");
    startCamera();
  } catch (error) {
    state.connected = false;
    renderConnection();
    setNotice(error.message, true);
  }
}

function startMotion() {
  if (!state.connected || document.hidden || (state.motion.linear === 0 && state.motion.yaw === 0)) return;
  state.commanding = true;
  renderDriveState();
  scheduleCommand(0);
}

function scheduleCommand(delayMs) {
  clearTimeout(state.commandTimer);
  if (!state.commanding) return;
  state.commandTimer = setTimeout(() => void sendCommand(), delayMs);
}

async function sendCommand() {
  if (!state.connected || !state.commanding) return;
  const operation = api("/api/command", {
    linear: state.motion.linear,
    yaw: state.motion.yaw,
    speedScale: Number($("#speed-scale").value) / 100,
    deadman: true,
  });
  state.commandInFlight = operation;
  try {
    const body = await operation;
    renderState(body.state);
    if (state.commanding) scheduleCommand(50);
  } catch (error) {
    state.commanding = false;
    state.motion = { linear: 0, yaw: 0 };
    setNotice(error.message, true);
    renderDriveState();
  } finally {
    if (state.commandInFlight === operation) state.commandInFlight = undefined;
  }
}

async function stopMotion(reason) {
  const wasCommanding = state.commanding;
  state.commanding = false;
  state.motion = { linear: 0, yaw: 0 };
  state.pressed.clear();
  clearTimeout(state.commandTimer);
  state.commandTimer = undefined;
  for (const button of document.querySelectorAll(".drive.active")) button.classList.remove("active");
  renderDriveState();
  if (!state.connected || !wasCommanding) return;
  try {
    await state.commandInFlight;
    const body = await api("/api/hold", {});
    renderState(body.state);
  } catch (error) {
    setNotice(`Command stream ended; the robot-local watchdog owns the stop. ${error.message}`, true);
  }
}

async function releaseSession() {
  await stopMotion("Direct session ending.");
  if (!state.connected) return;
  try {
    const body = await api("/api/release", {});
    state.connected = false;
    renderState(body.state);
    stopCamera();
    setNotice("Direct session released after stopped acknowledgement.");
  } catch (error) {
    setNotice(error.message, true);
  }
}

async function refreshState() {
  try {
    const body = await api("/api/state");
    state.connected = Boolean(body.state.connected);
    renderState(body.state);
    if (!state.connected) stopCamera();
  } catch (error) {
    state.connected = false;
    renderConnection();
    setNotice(error.message, true);
  }
}

function updateKeyboardMotion() {
  state.motion = {
    linear: (state.pressed.has("KeyW") ? 1 : 0) - (state.pressed.has("KeyS") ? 1 : 0),
    yaw: (state.pressed.has("KeyA") ? 1 : 0) - (state.pressed.has("KeyD") ? 1 : 0),
  };
}

function renderState(robot) {
  $("#session-state").textContent = robot.sessionStatus || "DISCONNECTED";
  $("#ownership-state").textContent = robot.ownership;
  $("#safety-state").textContent = robot.safety;
  $("#accepted-motion").textContent = `${Number(robot.acceptedLinearXMetersPerSecond).toFixed(2)} m/s · ${Number(robot.acceptedAngularZRadiansPerSecond).toFixed(2)} rad/s`;
  renderConnection();
  renderDriveState();
}

function renderConnection() {
  $(".connection").classList.toggle("online", state.connected);
  $("#connection-label").textContent = state.connected ? "Simulator connected" : "Simulator disconnected";
}

function renderDriveState() {
  const label = $("#drive-state");
  label.textContent = state.commanding ? "COMMANDING" : "HOLDING";
  label.classList.toggle("commanding", state.commanding);
}

function startCamera() {
  stopCamera();
  const generation = state.cameraGeneration;
  state.cameraTimer = setTimeout(() => void loadCamera(generation), 0);
}

function stopCamera() {
  state.cameraGeneration += 1;
  clearTimeout(state.cameraTimer);
  state.cameraTimer = undefined;
  if (state.cameraUrl) URL.revokeObjectURL(state.cameraUrl);
  state.cameraUrl = undefined;
  $("#camera-frame").hidden = true;
  $("#camera-frame").removeAttribute("src");
  $("#camera-placeholder").hidden = false;
  $("#camera-dot").classList.remove("online");
  $("#camera-label").textContent = "Offline";
  $("#camera-age").textContent = "—";
}

async function loadCamera(generation) {
  if (generation !== state.cameraGeneration || !state.connected || document.hidden) return;
  try {
    const response = await fetch(`/api/camera?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      const body = await readJson(response);
      throw new Error(`${body.code || "CAMERA_FAILED"}: ${body.message || response.statusText}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) throw new Error("Camera frame size is invalid.");
    const sourceTimestamp = Number(response.headers.get("x-brash-source-timestamp-unix-ms"));
    const sequence = response.headers.get("x-brash-frame-sequence");
    const sensorFrame = response.headers.get("x-brash-sensor-frame-id");
    if (!Number.isSafeInteger(sourceTimestamp) || !sequence || !sensorFrame) throw new Error("Camera provenance is incomplete.");
    const url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get("content-type") || "image/png" }));
    const image = $("#camera-frame");
    image.src = url;
    try {
      await image.decode();
    } catch (error) {
      URL.revokeObjectURL(url);
      image.removeAttribute("src");
      throw error;
    }
    if (generation !== state.cameraGeneration || !state.connected || document.hidden) {
      URL.revokeObjectURL(url);
      return;
    }
    if (state.cameraUrl) URL.revokeObjectURL(state.cameraUrl);
    state.cameraUrl = url;
    image.hidden = false;
    $("#camera-placeholder").hidden = true;
    $("#camera-dot").classList.add("online");
    $("#camera-label").textContent = "LIVE";
    $("#camera-frame-label").textContent = `${sensorFrame} · frame ${sequence}`;
    $("#camera-age").textContent = `${Math.max(0, Date.now() - sourceTimestamp)} ms old`;
    state.cameraTimer = setTimeout(() => void loadCamera(generation), 150);
  } catch (error) {
    if (generation !== state.cameraGeneration || !state.connected || document.hidden) return;
    $("#camera-dot").classList.remove("online");
    $("#camera-label").textContent = "RETRYING";
    $("#camera-age").textContent = error.message;
    state.cameraTimer = setTimeout(() => void loadCamera(generation), 1_000);
  }
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`DIRECT_SERVER_UNAVAILABLE: ${error.message}`);
  }
  const result = await readJson(response);
  if (!response.ok) throw new Error(`${result.code || "DIRECT_REQUEST_FAILED"}: ${result.message || response.statusText}`);
  return result;
}

async function readJson(response) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > 64 * 1024) throw new Error("Direct response is oversized.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error("Direct response is oversized.");
  return JSON.parse(text);
}

function setNotice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
}

void connect();
