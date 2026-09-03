# API

[`openapi.yaml`](openapi.yaml) documents the low-rate development control API.
[`edge-openapi.yaml`](edge-openapi.yaml) documents the loopback robot-agent test
transport, including stopped evidence and independent base/Z1 safety routes.
[`fleet-teleoperation-openapi.yaml`](fleet-teleoperation-openapi.yaml) defines
the dedicated low-rate hold contract that BRASH Fleet Control must implement;
the teleoperation stack already supplies its bounded client adapter.
[`media-openapi.yaml`](media-openapi.yaml) documents the loopback immutable
observation-preview adapter, including short-lived scoped grants and provenance
headers used by the object-declaration interface.
The control API includes short-lived WebRTC offer/answer/ICE signaling, while
intentionally excluding high-rate commands and video payloads: those use the
edge real-time and media boundaries after negotiation. Machine-readable
canonical wire schemas and golden examples live under `packages/contracts/`.

The development bearer is connection authentication only. Production must put
the API behind TLS, identity-aware authorization, robot identity, and audited
role policy before it can leave loopback.
