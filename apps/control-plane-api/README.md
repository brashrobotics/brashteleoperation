# Control-Plane API

## Purpose

Exposes the implemented session-control and assistance-orchestrator domain cores
through an authenticated, bounded JSON HTTP API for local development and
integration testing.

## Current implementation

- Loopback-only HTTP binding.
- Per-request identity-provider abstraction with distinct static operator and
  robot bearers for loopback development.
- Session request, grant, connect, activate, renew, hold, release, revoke,
  lookup, and event endpoints.
- Assistance open, assign, declare, ground, plan, approve, record-outcome,
  correct, verify, direct-teleop escalation, lookup, and event endpoints.
- Robot-only grounding, correction, plan, outcome, and verification writes,
  with exact request robot-ID binding even for privileged human roles.
- Session-bound WebRTC signaling exchange, message, lookup, and payload-free
  event endpoints with separate operator/robot identity binding.
- Robot-only readiness reports that gate commanding activation and stopped
  release; operator-supplied readiness booleans are not trusted.
- Optional Ed25519 signing of every granted or renewed lease plus an
  operator-bound recovery endpoint for the current live signed lease.
- Reviewed object-registry candidate, review, evaluation, scoped activation,
  rollback, lookup, and event endpoints.
- Role-based permission checks and authenticated actor-ID binding.
- Prometheus-format metrics and a statically served, installable operator
  assistance console with a network-only service worker.
- Strict top-level field readers and canonical nested-contract decoders.
- Consistent typed error responses.
- Atomic checksummed file persistence and restart-time expiry reconciliation in
  the development entry point.

Start the development server:

```bash
BRASH_TELEOP_CONTROL_TOKEN='replace-with-a-long-development-token' \
  npm run dev:control
```

To let the robot edge publish readiness and signaling state to the same
listener, also set the distinct `BRASH_TELEOP_ROBOT_CONTROL_TOKEN` and
`BRASH_TELEOP_ROBOT_ID` values. Robot and human roles cannot be combined.

`BRASH_TELEOP_STATE_FILE` selects the snapshot path and defaults to
`.local/control-plane-state.json`.

`BRASH_TELEOP_OPERATOR_CONNECT_ORIGINS` is a comma-separated list of exact
HTTPS origins, or loopback HTTP origins in development, added to the operator
console's `connect-src` policy. The development default is
`http://127.0.0.1:4312` for the immutable media simulator. No wildcard source
is added; the browser image policy permits `blob:` only for locally verified
preview bytes.

Set `BRASH_TELEOP_LEASE_SIGNING_KEY_ID` and
`BRASH_TELEOP_LEASE_SIGNING_PRIVATE_KEY_FILE` together to sign command
authority. The file must contain the control plane's Ed25519 private key. The
private key is never serialized into runtime state or returned to a client.
If a grant was durably committed but its response was lost, the bound operator
can recover the current authority from
`GET /control/v1/sessions/{sessionId}/signed-lease`.

Set `BRASH_TELEOP_FLEET_URL` and `BRASH_TELEOP_FLEET_TOKEN` together to enable
the dedicated Fleet hold client. `BRASH_TELEOP_FLEET_TIMEOUT_MS` defaults to
2,000 ms. HTTPS is required except for loopback development. Command-session
grant retries inspect the same session-keyed hold until Fleet confirms
`ROBOT_STOPPED`; explicit stopped release persists the terminal session before
releasing the tracked hold. Revoke and expiry leave Fleet held pending durable
robot-cleared reconciliation.

Tracked reservation state survives a single-node process restart. Released
command sessions retry incomplete Fleet release with exponential backoff and
persist the confirmed reservation transition. Clustered delivery still needs a
transactional outbox and fencing.

Commanding lease grants fail closed unless an admitted Fleet reservation hook
is configured. Local simulation may opt in explicitly with
`BRASH_TELEOP_ALLOW_UNCOORDINATED_SIMULATION=true`; it must not be used for a
physical deployment.

## Boundaries

- File persistence targets one process. A replicated production deployment
  requires a transactional database and outbox.
- The static development identity provider is not token verification.
  Production still requires OIDC/device identity and independently
  authenticated workload or mTLS robot/service principals.
- The API coordinates sessions and assistance; it carries no high-rate motion
  command or video stream.
- Loopback HTTP is not a production deployment configuration.
- Physical deployment must configure lease signing and distribute only the
  matching public verification keys to robot edge. Unsigned compatibility mode
  exists for simulation only.

## Next milestone

Introduce a PostgreSQL repository/outbox adapter, real identity-token
verification, the Fleet-side hold endpoints, production WebRTC/TURN adapters,
and generated API conformance tests.
