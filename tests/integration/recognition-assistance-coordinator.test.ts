import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type GroundedObject, type ObservationBundleReference } from "../../packages/contracts/src/index.ts";
import {
  RecognitionAssistanceCoordinator,
  RuntimeExemplarRecognizer,
} from "../../robot/interactive-perception/src/index.ts";
import { InMemoryAssistanceOrchestrator } from "../../services/assistance-orchestrator/src/index.ts";

test("a recognition miss automatically opens a human object-declaration request", () => {
  let eventId = 0;
  const assistance = new InMemoryAssistanceOrchestrator({ now: () => 1_000, idGenerator: () => `event-${++eventId}` });
  const coordinator = new RecognitionAssistanceCoordinator({
    recognizer: new RuntimeExemplarRecognizer(),
    assistance,
    now: () => 1_000,
    idGenerator: () => "request-generated",
  });
  const observation = reference();
  const decision = coordinator.recognizeOrRequest({
    robotId: "robot-1",
    taskId: "task-pick-1",
    siteId: "site-1",
    robotCapability: "unitree-b2-z1",
    observations: [observation],
    candidates: [{ candidateId: "proposal-1", object: object(), featureVector: [1, 0] }],
  });
  assert.equal(decision.status, "ASSISTANCE_OPENED");
  if (decision.status === "ASSISTANCE_OPENED") {
    assert.equal(decision.recognition.reason, "OBJECT_NOT_RECOGNIZED");
    assert.equal(decision.assistance.request.requestedInput, "SELECT_TARGET");
    assert.equal(decision.assistance.request.observations[0]?.observationId, observation.observationId);
  }
  assert.equal(assistance.listRequests().length, 1);
});

function reference(): ObservationBundleReference {
  return {
    observationId: "observation-1",
    robotId: "robot-1",
    capturedAtUnixMs: 900,
    sceneRevision: "scene-1",
    calibrationVersion: "calibration-1",
    frameIds: ["camera_color", "camera_depth"],
  };
}

function object(): GroundedObject {
  return {
    contractVersion: CONTRACT_VERSION,
    objectId: "object-1",
    requestId: "autonomy-attempt-1",
    declarationId: "proposal-1",
    declarationRevision: 1,
    observationId: "observation-1",
    robotId: "robot-1",
    sceneRevision: "scene-1",
    revision: 1,
    status: "TRACKED",
    pose: { frameId: "base_link", positionMeters: [0.5, 0, 0.3], orientationXyzw: [0, 0, 0, 1] },
    dimensionsMeters: [0.1, 0.1, 0.2],
    positionStdDevMeters: [0.01, 0.01, 0.01],
    groundedAtUnixMs: 900,
    validUntilUnixMs: 2_000,
    algorithm: { name: "generic-proposer", version: "1" },
  };
}
