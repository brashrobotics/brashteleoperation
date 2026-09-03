import {
  clone,
  fail,
  type CommandOwner,
  type CommandOwnershipRequest,
  type CommandOwnershipState,
  type ValidatedTeleopCommand,
} from "../../../packages/contracts/src/index.ts";

export class CommandArbiter {
  private state: CommandOwnershipState;

  constructor(robotId: string, createdAtUnixMs: number) {
    if (!robotId.trim()) fail("ROBOT_ID_REQUIRED", "robotId is required.");
    this.state = {
      robotId,
      revision: 1,
      status: "NO_OWNER",
      changedAtUnixMs: createdAtUnixMs,
      reason: "Arbiter initialized without an owner.",
    };
  }

  requestOwnership(request: CommandOwnershipRequest, expectedRevision: number): CommandOwnershipState {
    this.requireRevision(expectedRevision);
    if (request.robotId !== this.state.robotId) fail("ROBOT_ID_MISMATCH", "Ownership request targets another robot.");
    if (!request.requestId.trim() || !request.sourceId.trim()) fail("OWNERSHIP_ID_REQUIRED", "requestId and sourceId are required.");
    if (request.authority === "DIRECT_TELEOP" && !request.sessionId?.trim()) {
      fail("OWNERSHIP_SESSION_REQUIRED", "Direct teleoperation ownership requires a session ID.");
    }
    const requestedOwner: CommandOwner = {
      sourceId: request.sourceId,
      authority: request.authority,
      actuatorGroup: request.actuatorGroup,
      sessionId: request.sessionId,
    };
    if (this.state.status === "OWNED" && ownersEqual(this.state.owner, requestedOwner)) return this.snapshot();
    if (this.state.status === "HANDOFF") fail("OWNERSHIP_HANDOFF_IN_PROGRESS", "A stopped handoff is already in progress.");
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      status: "HANDOFF",
      pendingOwner: requestedOwner,
      changedAtUnixMs: request.requestedAtUnixMs,
      reason: this.state.owner ? `Handoff requested from ${this.state.owner.sourceId}.` : "Ownership requested; awaiting stopped acknowledgement.",
    };
    return this.snapshot();
  }

  releaseOwnership(sourceId: string, expectedRevision: number, atUnixMs: number, reason: string): CommandOwnershipState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "OWNED" || this.state.owner?.sourceId !== sourceId) {
      fail("OWNERSHIP_SOURCE_MISMATCH", `${sourceId} does not own the robot.`);
    }
    if (!reason.trim()) fail("OWNERSHIP_REASON_REQUIRED", "A release reason is required.");
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      status: "HANDOFF",
      pendingOwner: undefined,
      changedAtUnixMs: atUnixMs,
      reason,
    };
    return this.snapshot();
  }

  forceStop(expectedRevision: number, atUnixMs: number, reason: string): CommandOwnershipState {
    this.requireRevision(expectedRevision);
    if (!reason.trim()) fail("OWNERSHIP_REASON_REQUIRED", "A force-stop reason is required.");
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      status: "HANDOFF",
      pendingOwner: undefined,
      changedAtUnixMs: atUnixMs,
      reason,
    };
    return this.snapshot();
  }

  acknowledgeStopped(expectedRevision: number, atUnixMs: number): CommandOwnershipState {
    this.requireRevision(expectedRevision);
    if (this.state.status !== "HANDOFF") fail("OWNERSHIP_HANDOFF_REQUIRED", "No stopped handoff is awaiting acknowledgement.");
    const owner = this.state.pendingOwner;
    this.state = {
      robotId: this.state.robotId,
      revision: this.state.revision + 1,
      status: owner ? "OWNED" : "NO_OWNER",
      owner,
      changedAtUnixMs: atUnixMs,
      reason: owner ? `Ownership granted to ${owner.sourceId} after stopped acknowledgement.` : "Ownership cleared after stopped acknowledgement.",
    };
    return this.snapshot();
  }

  selectCommand(validated: ValidatedTeleopCommand): ValidatedTeleopCommand {
    const command = validated.command;
    if (command.robotId !== this.state.robotId) fail("ROBOT_ID_MISMATCH", "Command targets another robot.");
    if (this.state.status !== "OWNED" || !this.state.owner) fail("COMMAND_OWNER_REQUIRED", "No command source currently owns the robot.");
    if (this.state.owner.sourceId !== command.sourceId
      || this.state.owner.actuatorGroup !== command.actuatorGroup
      || this.state.owner.sessionId !== command.sessionId) {
      fail("COMMAND_OWNER_MISMATCH", "Command does not match current robot-local ownership.");
    }
    return clone(validated);
  }

  snapshot(): CommandOwnershipState {
    return clone(this.state);
  }

  private requireRevision(expectedRevision: number): void {
    if (this.state.revision !== expectedRevision) {
      fail("OWNERSHIP_REVISION_MISMATCH", `Expected ownership revision ${expectedRevision}, received ${this.state.revision}.`);
    }
  }
}

function ownersEqual(left: CommandOwner | undefined, right: CommandOwner): boolean {
  return left?.sourceId === right.sourceId
    && left.authority === right.authority
    && left.actuatorGroup === right.actuatorGroup
    && left.sessionId === right.sessionId;
}
