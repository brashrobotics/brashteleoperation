import assert from "node:assert/strict";
import test from "node:test";
import { TeleoperationError } from "../../packages/contracts/src/index.ts";
import {
  requireActorBinding,
  requirePermission,
  requireRobotBinding,
  StaticBearerIdentityProvider,
  requireSignalingExchangeBinding,
  requireSignalingPeerBinding,
  type OperatorPrincipal,
} from "../../packages/identity/src/index.ts";

test("role permissions and actor binding fail closed", () => {
  const operator: OperatorPrincipal = { subject: "oidc:123", operatorId: "operator-1", roles: ["OPERATOR"] };
  requirePermission(operator, "session:request");
  requirePermission(operator, "assistance:act");
  assert.throws(
    () => requirePermission(operator, "registry:activate"),
    (error) => error instanceof TeleoperationError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => requireActorBinding(operator, "operator-2"),
    (error) => error instanceof TeleoperationError && error.code === "ACTOR_IDENTITY_MISMATCH",
  );
});

test("static development identity provider selects exact principals without accepting malformed bearer input", () => {
  const provider = new StaticBearerIdentityProvider([
    {
      token: "operator-token-at-least-16",
      principal: { subject: "oidc:operator", operatorId: "operator-1", roles: ["OPERATOR"] },
    },
    {
      token: "robot-token-at-least-16",
      principal: { subject: "spiffe:robot", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] },
    },
  ]);
  assert.equal(provider.authenticateBearer("Bearer operator-token-at-least-16").operatorId, "operator-1");
  assert.equal(provider.authenticateBearer("Bearer robot-token-at-least-16").robotId, "robot-1");
  for (const header of [undefined, "Basic abc", "Bearer wrong-token-at-least-16", "Bearer "]) {
    assert.throws(
      () => provider.authenticateBearer(header),
      (error) => error instanceof TeleoperationError && error.code === "UNAUTHORIZED",
    );
  }
  assert.throws(
    () => new StaticBearerIdentityProvider([
      { token: "invalid-principal-token", principal: { subject: "bad", operatorId: "edge", roles: ["ROBOT"] } },
    ]),
    (error) => error instanceof TeleoperationError && error.code === "IDENTITY_INVALID",
  );
});

test("signaling binds offers to the operator and answers to the exact robot edge", () => {
  const operator: OperatorPrincipal = { subject: "oidc:operator", operatorId: "operator-1", roles: ["OPERATOR"] };
  const robot: OperatorPrincipal = { subject: "spiffe:robot-1", operatorId: "edge-service", robotId: "robot-1", roles: ["ROBOT"] };
  const binding = { operatorId: "operator-1", robotId: "robot-1" };
  requirePermission(operator, "signaling:create");
  requirePermission(robot, "signaling:write");
  requirePermission(robot, "session:robot-report");
  requirePermission(robot, "assistance:read");
  requirePermission(robot, "assistance:machine");
  requireRobotBinding(robot, "robot-1");
  requireSignalingPeerBinding(operator, "OPERATOR", binding);
  requireSignalingPeerBinding(robot, "ROBOT_EDGE", binding);
  assert.equal(requireSignalingExchangeBinding(operator, binding), "OPERATOR");
  assert.equal(requireSignalingExchangeBinding(robot, binding), "ROBOT_EDGE");
  assert.throws(
    () => requireSignalingPeerBinding(operator, "ROBOT_EDGE", binding),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => requireSignalingPeerBinding({ ...robot, robotId: "robot-2" }, "ROBOT_EDGE", binding),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => requirePermission(robot, "signaling:create"),
    (error) => error instanceof TeleoperationError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => requirePermission({ subject: "oidc:admin", operatorId: "admin-1", roles: ["ADMIN"] }, "assistance:machine"),
    (error) => error instanceof TeleoperationError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => requireRobotBinding({ ...robot, robotId: "robot-2" }, "robot-1"),
    (error) => error instanceof TeleoperationError && error.code === "ROBOT_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => requireSignalingExchangeBinding({ ...robot, operatorId: "operator-1", robotId: "robot-2" }, binding),
    (error) => error instanceof TeleoperationError && error.code === "SIGNALING_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => requirePermission({ ...robot, roles: ["ROBOT", "ADMIN"] }, "signaling:write"),
    (error) => error instanceof TeleoperationError && error.code === "IDENTITY_INVALID",
  );
});
