import assert from "node:assert/strict";
import test from "node:test";
import { fail } from "../../packages/contracts/src/index.ts";
import { StaticBearerIdentityProvider } from "../../packages/identity/src/index.ts";
import { MediaGateway, startMediaGatewayTestServer } from "../../edge/media-gateway/src/index.ts";

const operatorToken = "media-operator-token-long";
const otherToken = "media-other-operator-token";

test("authorized operator receives only the exact immutable observation preview", async (context) => {
  let now = 10_000;
  const gateway = new MediaGateway({
    robotId: "robot-1",
    signingSecret: "media-api-signing-secret-at-least-32-bytes",
    now: () => now,
  });
  gateway.registerCamera({ cameraId: "rgb", robotId: "robot-1", frameId: "camera_rgb", calibrationVersion: "cal-1", kind: "RGB" });
  gateway.registerCamera({ cameraId: "depth", robotId: "robot-1", frameId: "camera_depth", calibrationVersion: "cal-1", kind: "DEPTH" });
  const rgb = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  gateway.ingest({ frameId: "rgb-1", cameraId: "rgb", robotId: "robot-1", sequence: 1, sourceTimestampUnixMs: now, receivedAtUnixMs: now, mediaType: "image/jpeg", bytes: rgb });
  gateway.ingest({ frameId: "depth-1", cameraId: "depth", robotId: "robot-1", sequence: 1, sourceTimestampUnixMs: now, receivedAtUnixMs: now, mediaType: "application/x-point-cloud", bytes: new Uint8Array([1, 2, 3]) });
  gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-1" });

  const identityProvider = new StaticBearerIdentityProvider([
    { token: operatorToken, principal: { subject: "operator:1", operatorId: "operator-1", roles: ["OPERATOR"] } },
    { token: otherToken, principal: { subject: "operator:2", operatorId: "operator-2", roles: ["OPERATOR"] } },
  ]);
  const server = await startMediaGatewayTestServer({
    gateway,
    identityProvider,
    allowedOrigins: ["http://127.0.0.1:4310"],
    authorizeObservationAccess: (principal, observation) => {
      if (principal.operatorId !== "operator-1" || observation.reference.observationId !== "observation-1") {
        fail("MEDIA_OBSERVATION_ACCESS_DENIED", "Operator is not assigned to this observation.");
      }
    },
  });
  context.after(() => server.close());

  let response = await fetch(`${server.url}/media/v1/observations/observation-1/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${otherToken}`,
      "content-type": "application/json",
      origin: "http://127.0.0.1:4310",
    },
    body: JSON.stringify({ lifetimeMs: 1_000 }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${server.url}/media/v1/observations/observation-1/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
      "content-type": "application/json",
      origin: "http://127.0.0.1:4310",
    },
    body: JSON.stringify({ lifetimeMs: 1_000 }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:4310");
  const access = await response.json() as { accessToken: string; grant: { operatorId: string; cameraIds: string[]; resource: string; observationIds: string[] } };
  assert.equal(access.grant.operatorId, "operator-1");
  assert.deepEqual(access.grant.cameraIds, ["depth", "rgb"]);
  assert.equal(access.grant.resource, "IMMUTABLE_OBSERVATION");
  assert.deepEqual(access.grant.observationIds, ["observation-1"]);

  response = await fetch(`${server.url}/media/v1/observations/observation-1/preview`, {
    headers: { authorization: `Bearer ${access.accessToken}`, origin: "http://127.0.0.1:4310" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-brash-observation-id"), "observation-1");
  assert.equal(response.headers.get("x-brash-frame-id"), "rgb-1");
  assert.equal(response.headers.get("x-brash-sensor-frame-id"), "camera_rgb");
  assert.equal(response.headers.get("x-brash-frame-sha256")?.length, 64);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), rgb);

  now += 1_001;
  response = await fetch(`${server.url}/media/v1/observations/observation-1/preview`, {
    headers: { authorization: `Bearer ${access.accessToken}` },
  });
  assert.equal(response.status, 401);
});

test("media preview API rejects unapproved origins and overlong grants", async (context) => {
  const now = 20_000;
  const gateway = new MediaGateway({ robotId: "robot-1", signingSecret: "media-origin-secret-at-least-32-bytes", now: () => now });
  gateway.registerCamera({ cameraId: "rgb", robotId: "robot-1", frameId: "camera_rgb", calibrationVersion: "cal-1", kind: "RGB" });
  gateway.registerCamera({ cameraId: "depth", robotId: "robot-1", frameId: "camera_depth", calibrationVersion: "cal-1", kind: "DEPTH" });
  gateway.ingest({ frameId: "rgb-1", cameraId: "rgb", robotId: "robot-1", sequence: 1, sourceTimestampUnixMs: now, receivedAtUnixMs: now, mediaType: "image/png", bytes: new Uint8Array([1]) });
  gateway.ingest({ frameId: "depth-1", cameraId: "depth", robotId: "robot-1", sequence: 1, sourceTimestampUnixMs: now, receivedAtUnixMs: now, mediaType: "application/x-point-cloud", bytes: new Uint8Array([2]) });
  gateway.createObservation({ rgbCameraId: "rgb", depthCameraId: "depth", sceneRevision: "scene-1", observationId: "observation-1" });
  const identityProvider = new StaticBearerIdentityProvider([
    { token: operatorToken, principal: { subject: "operator:1", operatorId: "operator-1", roles: ["OPERATOR"] } },
  ]);
  const server = await startMediaGatewayTestServer({
    gateway,
    identityProvider,
    allowedOrigins: ["http://127.0.0.1:4310"],
    maximumGrantLifetimeMs: 2_000,
    authorizeObservationAccess: () => undefined,
  });
  context.after(() => server.close());

  let response = await fetch(`${server.url}/media/v1/observations/observation-1/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json", origin: "https://untrusted.example" },
    body: JSON.stringify({ lifetimeMs: 1_000 }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);

  response = await fetch(`${server.url}/media/v1/observations/observation-1/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ lifetimeMs: 2_001 }),
  });
  assert.equal(response.status, 400);
});

test("active operator session receives fresh robot-authenticated simulation frames", async (context) => {
  let now = 30_000;
  const gateway = new MediaGateway({
    robotId: "robot-1",
    signingSecret: "media-live-signing-secret-at-least-32-bytes",
    now: () => now,
    maximumLiveFrameAgeMs: 500,
  });
  gateway.registerCamera({ cameraId: "front", robotId: "robot-1", frameId: "front_link", calibrationVersion: "cal-1", kind: "RGB" });
  const identityProvider = new StaticBearerIdentityProvider([
    { token: operatorToken, principal: { subject: "operator:1", operatorId: "operator-1", roles: ["OPERATOR"] } },
    { token: otherToken, principal: { subject: "operator:2", operatorId: "operator-2", roles: ["OPERATOR"] } },
  ]);
  const robotToken = "robot-media-ingest-token";
  const server = await startMediaGatewayTestServer({
    gateway,
    identityProvider,
    robotIngestBearerToken: robotToken,
    allowedOrigins: ["http://127.0.0.1:4310"],
    authorizeObservationAccess: () => undefined,
    authorizeLiveCameraAccess: (principal, camera, sessionId) => {
      if (principal.operatorId !== "operator-1" || camera.robotId !== "robot-1" || sessionId !== "active-session") {
        fail("MEDIA_ACCESS_DENIED", "A matching active session is required.");
      }
    },
  });
  context.after(() => server.close());

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let response = await fetch(`${server.url}/media/v1/cameras/front/frames`, {
    method: "POST",
    headers: { authorization: "Bearer invalid-robot-token", "content-type": "application/json" },
    body: JSON.stringify({
      frameId: "front-1",
      robotId: "robot-1",
      sequence: 1,
      sourceTimestampUnixMs: now,
      mediaType: "image/png",
      bytesBase64: Buffer.from(png).toString("base64"),
    }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${server.url}/media/v1/cameras/front/frames`, {
    method: "POST",
    headers: { authorization: `Bearer ${robotToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      frameId: "front-1",
      robotId: "robot-1",
      sequence: 1,
      sourceTimestampUnixMs: now,
      mediaType: "image/png",
      bytesBase64: Buffer.from(png).toString("base64"),
    }),
  });
  assert.equal(response.status, 202);

  response = await fetch(`${server.url}/media/v1/cameras/front/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "active-session", lifetimeMs: 1_000 }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${server.url}/media/v1/cameras/front/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json", origin: "http://127.0.0.1:4310" },
    body: JSON.stringify({ sessionId: "active-session", lifetimeMs: 1_000 }),
  });
  assert.equal(response.status, 201);
  const access = await response.json() as { accessToken: string; grant: { resource: string } };
  assert.equal(access.grant.resource, "LIVE_CAMERAS");

  response = await fetch(`${server.url}/media/v1/cameras/front/live`, {
    headers: { authorization: `Bearer ${access.accessToken}`, origin: "http://127.0.0.1:4310" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-brash-camera-id"), "front");
  assert.equal(response.headers.get("x-brash-sensor-frame-id"), "front_link");
  assert.equal(response.headers.get("x-brash-frame-sequence"), "1");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);

  now += 501;
  response = await fetch(`${server.url}/media/v1/cameras/front/live`, {
    headers: { authorization: `Bearer ${access.accessToken}` },
  });
  assert.equal(response.status, 400);
});
