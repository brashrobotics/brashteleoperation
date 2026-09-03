const state = {
  token: sessionStorage.getItem("brash.controlToken") || "",
  mediaApiUrl: sessionStorage.getItem("brash.mediaApiUrl") || "",
  operatorId: "operator-001",
  requests: [],
  sessions: [],
  registry: [],
  selectedId: undefined,
  previewUrl: undefined,
  previewRequest: 0,
  refreshPromise: undefined,
};
const $ = (selector) => document.querySelector(selector);
const notice = $("#notice");
$("#bearer-token").value = state.token;
$("#media-api-url").value = state.mediaApiUrl;

$("#connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.token = $("#bearer-token").value;
    state.mediaApiUrl = normalizeMediaApiUrl($("#media-api-url").value);
    state.operatorId = $("#operator-id").value;
    sessionStorage.setItem("brash.controlToken", state.token);
    if (state.mediaApiUrl) sessionStorage.setItem("brash.mediaApiUrl", state.mediaApiUrl);
    else sessionStorage.removeItem("brash.mediaApiUrl");
    await refreshAll();
  } catch (error) {
    setConnected(false);
    showNotice(error.message, true);
  }
});
$("#refresh").addEventListener("click", () => void refreshAll());
$("#direct-session-form").addEventListener("submit", requestDirectSession);
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    handleClientInterruption("Application backgrounded. Any command input is cleared; robot-local watchdog owns the stop.");
  } else {
    showNotice("Foreground restored in observe-only mode. Refresh state and explicitly reacquire control; motion never resumes automatically.");
    if (state.token) void refreshAll({ quiet: true });
  }
});
window.addEventListener("pagehide", () => {
  clearPreview();
  handleClientInterruption("Application page closed or suspended.");
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/operator/sw.js", { scope: "/operator/" })
    .catch(() => showNotice("Installable application support is unavailable; online assistance still works.", true)));
}
setInterval(() => {
  if (state.token && !document.hidden) void refreshAll({ quiet: true });
}, 1_000);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.code || "REQUEST_FAILED"}: ${body.message || response.statusText}`);
  return body;
}

async function refreshAll({ quiet = false } = {}) {
  if (state.refreshPromise) return state.refreshPromise;
  const operation = (async () => {
    const previousSelected = state.requests.find((item) => item.request.requestId === state.selectedId);
    const [assistance, sessions, registry] = await Promise.all([api("/assistance/v1/requests"), api("/control/v1/sessions"), api("/registry/v1/versions")]);
    state.requests = assistance.requests;
    state.sessions = sessions.sessions;
    state.registry = registry.versions;
    setConnected(true);
    renderSummary(); renderRequests(); renderSessions(); renderRegistry();
    const selected = state.requests.find((item) => item.request.requestId === state.selectedId);
    if (state.selectedId && (!quiet || !previousSelected || previousSelected.revision !== selected?.revision)) renderDetail(selected);
    if (!quiet) showNotice(`Loaded ${state.requests.length} assistance request(s), ${state.sessions.length} session(s), and ${state.registry.length} registry version(s).`);
  })();
  state.refreshPromise = operation;
  try {
    await operation;
  } catch (error) {
    setConnected(false);
    showNotice(error.message, true);
  } finally {
    if (state.refreshPromise === operation) state.refreshPromise = undefined;
  }
}

function renderSummary() {
  const terminal = new Set(["RESOLVED", "CANCELLED", "EXPIRED", "FAILED", "DIRECT_TELEOP_REQUIRED"]);
  $("#open-count").textContent = state.requests.filter((item) => !terminal.has(item.status)).length;
  $("#active-count").textContent = state.sessions.filter((item) => item.status === "ACTIVE").length;
}

function renderRequests() {
  const root = $("#request-list"); root.replaceChildren();
  if (!state.requests.length) { root.innerHTML = '<p class="empty">No assistance requests.</p>'; return; }
  for (const item of state.requests) {
    const node = $("#request-template").content.cloneNode(true);
    const button = node.querySelector("button");
    button.classList.toggle("selected", item.request.requestId === state.selectedId);
    node.querySelector(".request-reason").textContent = format(item.request.reason);
    node.querySelector(".request-status").dataset.status = item.status;
    node.querySelector(".request-meta").textContent = `${item.request.robotId} · ${item.status} · r${item.revision}`;
    button.addEventListener("click", () => { state.selectedId = item.request.requestId; $("#selected-robot").textContent = item.request.robotId; renderRequests(); renderDetail(item); });
    root.append(node);
  }
}

function renderDetail(item) {
  clearPreview();
  const root = $("#request-detail");
  if (!item) { root.innerHTML = '<div class="empty-state"><h2>Request no longer available</h2></div>'; return; }
  const observation = item.request.observations[0];
  root.className = "";
  root.innerHTML = `<div class="detail-header"><div><p class="eyebrow">${escapeText(item.request.requestId)}</p><h2>${escapeText(format(item.request.reason))}</h2></div><span class="pill">${escapeText(item.status)} · r${item.revision}</span></div>
    <div class="meta-grid"><div><span>Robot</span><strong>${escapeText(item.request.robotId)}</strong></div><div><span>Task</span><strong>${escapeText(item.request.taskId)}</strong></div><div><span>Scene revision</span><strong>${escapeText(observation.sceneRevision)}</strong></div><div><span>Observation</span><strong>${escapeText(observation.observationId)}</strong></div><div><span>Calibration</span><strong>${escapeText(observation.calibrationVersion)}</strong></div><div><span>Expires</span><strong>${new Date(item.request.expiresAtUnixMs).toLocaleTimeString()}</strong></div></div>
    <div id="observation-preview" class="observation"><div><strong>Immutable RGB-D observation</strong><br>${escapeText(observation.frameIds.join(" · "))}<br><small>${state.mediaApiUrl ? "Loading the exact retained RGB frame…" : "Configure the optional media API to load the exact retained RGB frame."}</small></div></div><div id="media-provenance" class="media-provenance">Observation ${escapeText(observation.observationId)} · calibration ${escapeText(observation.calibrationVersion)}</div>
    <div class="action-grid"><div class="action-card" id="primary-action"></div><div class="action-card"><h3>Escalation</h3><p>Stop this autonomy attempt and request a separately authorized direct-control handoff.</p><button id="escalate" class="danger">Require direct teleop</button></div></div>`;
  renderPrimaryAction(item, observation, $("#primary-action"));
  $("#escalate").addEventListener("click", () => mutateRequest(item, "direct-teleop", { reason: "Operator requested direct control from assistance console." }));
  void loadObservationPreview(item, observation);
}

function renderPrimaryAction(item, observation, root) {
  if (item.status === "OPEN") {
    root.innerHTML = '<h3>Claim request</h3><p>Assign this request before declaring the object.</p><button id="claim">Assign to me</button>';
    $("#claim").addEventListener("click", () => mutateRequest(item, "assign", { operatorId: state.operatorId })); return;
  }
  if (item.status === "DECLARATION_PENDING") {
    root.innerHTML = `<h3>Declare target box</h3><p>Coordinates refer to the frozen observation, not the live stream.</p><form id="declare-form" class="stack-form"><label>Semantic label<input id="semantic-label" placeholder="e.g. blue tote" required></label><div class="coords"><label>X<input id="box-x" type="number" min="0" value="10" required></label><label>Y<input id="box-y" type="number" min="0" value="10" required></label><label>Width<input id="box-width" type="number" min="1" value="100" required></label><label>Height<input id="box-height" type="number" min="1" value="100" required></label></div><label>Persistence<select id="persistence"><option value="ATTEMPT_ONLY">This attempt only</option><option value="CURRENT_SCENE">Current scene</option><option value="SITE_ENROLLMENT_CANDIDATE">Site learning candidate</option></select></label><button>Submit declaration</button></form>`;
    $("#declare-form").addEventListener("submit", (event) => { event.preventDefault(); mutateRequest(item, "declarations", { declaration: { contractVersion: { major:1, minor:0 }, declarationId:item.declaration?.declarationId || crypto.randomUUID(), requestId:item.request.requestId, observationId:observation.observationId, revision:(item.declaration?.revision || 0)+1, declaredBy:state.operatorId, declaredAtUnixMs:Date.now(), selection:{ kind:"BOX", frameId:$("#observation-preview")?.dataset.sensorFrameId || observation.frameIds[0], x:Number($("#box-x").value), y:Number($("#box-y").value), width:Number($("#box-width").value), height:Number($("#box-height").value) }, semanticLabel:$("#semantic-label").value, manipulationIntent:"PICK", persistenceScope:$("#persistence").value } }); }); return;
  }
  if (item.status === "APPROVAL_PENDING") {
    root.innerHTML = `<h3>Approve exact plan</h3><p>${escapeText(item.plan?.phases?.join(" → ") || "Plan unavailable")}</p><button id="approve">Approve r${item.plan?.planRevision}</button>`;
    $("#approve").addEventListener("click", () => mutateRequest(item, "approvals", { approval: { contractVersion:{major:1,minor:0}, approvalId:crypto.randomUUID(), requestId:item.request.requestId, planId:item.plan.planId, planRevision:item.plan.planRevision, objectRevision:item.groundedObject.revision, sceneRevision:item.plan.sceneRevision, approvedBy:state.operatorId, approvedAtUnixMs:Date.now() } })); return;
  }
  root.innerHTML = `<h3>Workflow state</h3><p>${escapeText(format(item.status))}. Robot-side grounding, planning, execution, or verification owns the next transition.</p><button class="secondary" id="reload-one">Reload state</button>`;
  $("#reload-one").addEventListener("click", () => void refreshAll());
}

async function mutateRequest(item, action, fields) {
  try { const body = await api(`/assistance/v1/requests/${encodeURIComponent(item.request.requestId)}/${action}`, { method:"POST", body:JSON.stringify({ expectedRevision:item.revision, ...fields }) }); state.selectedId = item.request.requestId; showNotice(`${format(action)} accepted at revision ${body.assistance.revision}.`); await refreshAll(); }
  catch (error) { showNotice(error.message, true); }
}

async function requestDirectSession(event) {
  event.preventDefault();
  try {
    const robotId = $("#direct-robot-id").value; const sessionId = crypto.randomUUID();
    let body = await api("/control/v1/sessions", { method:"POST", body:JSON.stringify({ sessionId, robotId, operatorId:state.operatorId, scopes:["OBSERVE","CONTROL_BASE"] }) });
    body = await api(`/control/v1/sessions/${sessionId}/grant`, { method:"POST", body:JSON.stringify({ expectedRevision:body.session.revision, leaseDurationMs:Number($("#lease-seconds").value)*1000 }) });
    const signing = body.signedLease
      ? `Signed ${body.signedLease.algorithm} · key ${body.signedLease.keyId}`
      : "Unsigned simulation lease";
    $("#direct-result").textContent = `Session ${sessionId}\nStatus ${body.session.status}\nLease r${body.session.lease.revision}\n${signing}\nExpires ${new Date(body.session.lease.expiresAtUnixMs).toLocaleTimeString()}\n\nNext: edge installs lease and performs stopped ownership handoff.`;
    showNotice("Control-plane lease granted. Edge ownership is still required before motion."); await refreshAll();
  } catch (error) { showNotice(error.message, true); }
}

async function loadObservationPreview(item, observation) {
  if (!state.mediaApiUrl) return;
  const generation = state.previewRequest;
  const root = $("#observation-preview");
  const provenance = $("#media-provenance");
  try {
    const grantResponse = await fetch(`${state.mediaApiUrl}/media/v1/observations/${encodeURIComponent(observation.observationId)}/access`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ lifetimeMs: 30_000 }),
    });
    const grantBody = await readBoundedJson(grantResponse, 32 * 1024);
    if (!grantResponse.ok) throw new Error(`${grantBody.code || "MEDIA_ACCESS_FAILED"}: ${grantBody.message || grantResponse.statusText}`);
    if (typeof grantBody.accessToken !== "string" || grantBody.accessToken.length < 1 || grantBody.accessToken.length > 8_000) {
      throw new Error("MEDIA_ACCESS_INVALID: media gateway returned an invalid access grant.");
    }
    const previewResponse = await fetch(`${state.mediaApiUrl}/media/v1/observations/${encodeURIComponent(observation.observationId)}/preview`, {
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${grantBody.accessToken}` },
    });
    if (!previewResponse.ok) {
      const body = await readBoundedJson(previewResponse, 32 * 1024);
      throw new Error(`${body.code || "MEDIA_PREVIEW_FAILED"}: ${body.message || previewResponse.statusText}`);
    }
    const returnedObservationId = previewResponse.headers.get("x-brash-observation-id");
    const sensorFrameId = previewResponse.headers.get("x-brash-sensor-frame-id");
    const sha256 = previewResponse.headers.get("x-brash-frame-sha256");
    const mediaType = previewResponse.headers.get("content-type")?.split(";", 1)[0];
    if (returnedObservationId !== observation.observationId || !sensorFrameId || !observation.frameIds.includes(sensorFrameId)) {
      throw new Error("MEDIA_PREVIEW_PROVENANCE_INVALID: preview does not match the selected immutable observation.");
    }
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mediaType)) {
      throw new Error("MEDIA_PREVIEW_PROVENANCE_INVALID: preview headers are incomplete or unsafe.");
    }
    const bytes = await readBoundedBytes(previewResponse, 8 * 1024 * 1024);
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== sha256) throw new Error("MEDIA_PREVIEW_INTEGRITY_INVALID: preview hash does not match its observation reference.");
    if (generation !== state.previewRequest || state.selectedId !== item.request.requestId) return;

    const image = new Image();
    image.alt = `Immutable observation ${observation.observationId}`;
    image.draggable = false;
    const previewUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    state.previewUrl = previewUrl;
    image.src = previewUrl;
    await image.decode();
    if (generation !== state.previewRequest || state.selectedId !== item.request.requestId) {
      URL.revokeObjectURL(previewUrl);
      if (state.previewUrl === previewUrl) state.previewUrl = undefined;
      return;
    }
    root.replaceChildren(image);
    root.classList.add("has-preview");
    root.dataset.sensorFrameId = sensorFrameId;
    provenance.textContent = `Observation ${observation.observationId} · frame ${sensorFrameId} · sha256 ${sha256.slice(0, 16)}… · frozen ${new Date(Number(previewResponse.headers.get("x-brash-source-timestamp-unix-ms"))).toLocaleTimeString()}`;
    if (item.status === "DECLARATION_PENDING") enableBoxSelection(root, image);
  } catch (error) {
    if (generation !== state.previewRequest) return;
    clearPreview();
    root.innerHTML = `<div><strong>Immutable preview unavailable</strong><br><small>${escapeText(error.message)}</small></div>`;
    showNotice("The frozen image could not be verified. Object coordinates may be entered manually, but no newer frame was substituted.", true);
  }
}

function enableBoxSelection(root, image) {
  root.classList.add("selectable");
  let start;
  let box;
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !image.naturalWidth || !image.naturalHeight) return;
    const rect = image.getBoundingClientRect();
    start = pointInRect(event, rect);
    box = document.createElement("div");
    box.className = "selection-box";
    root.querySelector(".selection-box")?.remove();
    root.append(box);
    root.setPointerCapture(event.pointerId);
    updateSelectionBox(box, start, start, rect, image);
  });
  root.addEventListener("pointermove", (event) => {
    if (!start || !box) return;
    updateSelectionBox(box, start, pointInRect(event, image.getBoundingClientRect()), image.getBoundingClientRect(), image);
  });
  const finish = (event) => {
    if (!start || !box) return;
    updateSelectionBox(box, start, pointInRect(event, image.getBoundingClientRect()), image.getBoundingClientRect(), image);
    start = undefined;
    box = undefined;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);
}

function updateSelectionBox(box, first, second, rect, image) {
  const left = Math.min(first.x, second.x); const top = Math.min(first.y, second.y);
  const width = Math.max(1, Math.abs(second.x - first.x)); const height = Math.max(1, Math.abs(second.y - first.y));
  Object.assign(box.style, { left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px` });
  const scaleX = image.naturalWidth / rect.width; const scaleY = image.naturalHeight / rect.height;
  $("#box-x").value = String(Math.round(left * scaleX));
  $("#box-y").value = String(Math.round(top * scaleY));
  $("#box-width").value = String(Math.max(1, Math.round(width * scaleX)));
  $("#box-height").value = String(Math.max(1, Math.round(height * scaleY)));
}

function pointInRect(event, rect) {
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
  };
}

async function readBoundedJson(response, maximumBytes) {
  const bytes = await readBoundedBytes(response, maximumBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("HTTP_JSON_INVALID: endpoint returned invalid JSON."); }
}

async function readBoundedBytes(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("HTTP_BODY_TOO_LARGE: endpoint response is oversized.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error("HTTP_BODY_TOO_LARGE: endpoint response is oversized."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function sha256Hex(bytes) {
  if (!crypto.subtle) throw new Error("MEDIA_PREVIEW_INTEGRITY_UNAVAILABLE: this client cannot verify observation hashes.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeMediaApiUrl(value) {
  if (!value.trim()) return "";
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Media API must be an HTTPS origin, or an HTTP loopback origin for development.");
  }
  return url.origin;
}

function clearPreview() {
  state.previewRequest += 1;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = undefined;
}

function renderSessions() {
  const root = $("#session-list"); if (!state.sessions.length) { root.innerHTML='<p class="empty">No sessions.</p>'; return; }
  root.innerHTML = `<table><thead><tr><th>Session</th><th>Robot</th><th>Operator</th><th>Scopes</th><th>Status</th><th>Revision</th></tr></thead><tbody>${state.sessions.map((item) => `<tr><td>${escapeText(item.sessionId)}</td><td>${escapeText(item.robotId)}</td><td>${escapeText(item.operatorId)}</td><td>${escapeText(item.scopes.join(", "))}</td><td>${escapeText(item.status)}</td><td>${item.revision}</td></tr>`).join("")}</tbody></table>`;
}
function renderRegistry() {
  const root = $("#registry-list"); if (!state.registry.length) { root.innerHTML='<p class="empty">No reviewed object knowledge.</p>'; return; }
  root.innerHTML = `<table><thead><tr><th>Label</th><th>Class</th><th>Version</th><th>Scope</th><th>Status</th><th>Artifact</th></tr></thead><tbody>${state.registry.map((item) => `<tr><td>${escapeText(item.semanticLabel)}</td><td>${escapeText(item.objectClassId)}</td><td>v${item.version} · r${item.revision}</td><td>${escapeText(item.siteIds.join(", "))}<br>${escapeText(item.robotCapabilities.join(", "))}</td><td>${escapeText(item.status)}</td><td>${escapeText(item.validation?.artifactSha256?.slice(0, 12) || "not evaluated")}</td></tr>`).join("")}</tbody></table>`;
}
function selectTab(name) { for (const tab of document.querySelectorAll(".tab")) { const active=tab.dataset.tab===name; tab.classList.toggle("active",active); tab.setAttribute("aria-selected",String(active)); } for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.add("hidden"); $(`#${name}-panel`).classList.remove("hidden"); }
function setConnected(online) { $("#connection-dot").className=`dot ${online?"online":"offline"}`; $("#connection-label").textContent=online?"Control plane online":"Disconnected"; }
function handleClientInterruption(message) { setConnected(false); showNotice(message); }
function showNotice(message,error=false) { notice.textContent=message; notice.classList.toggle("error",error); }
function format(value) { return String(value).toLowerCase().replaceAll("_"," ").replace(/^./,(letter)=>letter.toUpperCase()); }
function escapeText(value) { const node=document.createElement("span"); node.textContent=String(value); return node.innerHTML; }
