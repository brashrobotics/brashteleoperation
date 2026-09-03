import {
  assertGroundedObject,
  assertObservationBundle,
  clone,
  fail,
  type GroundedObject,
  type ObservationBundleReference,
} from "../../contracts/src/index.ts";

export class RuntimeSceneModel {
  private readonly observations = new Map<string, ObservationBundleReference>();
  private readonly objects = new Map<string, GroundedObject>();

  registerObservation(observation: ObservationBundleReference): ObservationBundleReference {
    assertObservationBundle(observation);
    const existing = this.observations.get(observation.observationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(observation)) {
        fail("OBSERVATION_ID_COLLISION", `${observation.observationId} already identifies different observation data.`);
      }
      return clone(existing);
    }
    this.observations.set(observation.observationId, clone(observation));
    return clone(observation);
  }

  getObservation(observationId: string): ObservationBundleReference {
    const observation = this.observations.get(observationId);
    if (!observation) fail("OBSERVATION_NOT_FOUND", `Observation ${observationId} is not registered.`);
    return clone(observation);
  }

  getObject(objectId: string): GroundedObject {
    const object = this.objects.get(objectId);
    if (!object) fail("GROUNDED_OBJECT_NOT_FOUND", `Grounded object ${objectId} was not found.`);
    return clone(object);
  }

  publishGroundedObject(object: GroundedObject): GroundedObject {
    assertGroundedObject(object);
    const observation = this.observations.get(object.observationId);
    if (!observation) fail("OBSERVATION_NOT_FOUND", `Observation ${object.observationId} is not registered.`);
    if (observation.robotId !== object.robotId) fail("ROBOT_ID_MISMATCH", "Object and observation target different robots.");
    if (observation.sceneRevision !== object.sceneRevision) {
      fail("SCENE_REVISION_MISMATCH", "Object grounding does not match its immutable observation scene revision.");
    }
    const previous = this.objects.get(object.objectId);
    if (previous && object.revision <= previous.revision) {
      fail("GROUNDED_OBJECT_REVISION_STALE", `Object revision must be newer than ${previous.revision}.`);
    }
    this.objects.set(object.objectId, clone(object));
    return clone(object);
  }

  requireUsableObject(objectId: string, expectedRevision: number, sceneRevision: string, nowUnixMs: number): GroundedObject {
    const object = this.objects.get(objectId);
    if (!object) fail("GROUNDED_OBJECT_NOT_FOUND", `Grounded object ${objectId} was not found.`);
    if (object.revision !== expectedRevision) {
      fail("GROUNDED_OBJECT_REVISION_MISMATCH", `Expected object revision ${expectedRevision}, received ${object.revision}.`);
    }
    if (object.sceneRevision !== sceneRevision) fail("SCENE_REVISION_MISMATCH", "Grounded object belongs to another scene revision.");
    if (nowUnixMs >= object.validUntilUnixMs) fail("GROUNDED_OBJECT_STALE", `Grounded object ${objectId} has expired.`);
    if (object.status !== "GROUNDED" && object.status !== "TRACKED") {
      fail("GROUNDED_OBJECT_UNUSABLE", `Grounded object ${objectId} is ${object.status}.`);
    }
    return clone(object);
  }

  invalidateObject(objectId: string, status: "LOST" | "STALE" | "INVALIDATED", nowUnixMs: number): GroundedObject {
    const existing = this.objects.get(objectId);
    if (!existing) fail("GROUNDED_OBJECT_NOT_FOUND", `Grounded object ${objectId} was not found.`);
    const next: GroundedObject = {
      ...existing,
      revision: existing.revision + 1,
      status,
      validUntilUnixMs: Math.min(existing.validUntilUnixMs, nowUnixMs),
    };
    this.objects.set(objectId, next);
    return clone(next);
  }
}
