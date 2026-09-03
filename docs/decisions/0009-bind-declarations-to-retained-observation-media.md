# ADR 0009: Bind declarations to retained observation media

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

An object declaration must refer to the image the robot used when it requested
help. Rendering a newer live frame under an old observation ID can cause the
operator's point or box to select a different physical object. A browser image
URL also cannot safely carry a long-lived operator credential in its query.

## Decision

The media gateway retains the RGB and depth bytes selected for an immutable
observation under explicit count and byte budgets. It records content hashes
in the observation bundle and rechecks the retained bytes before retrieval.

An authenticated operator first requests a short-lived, observation-scoped
media grant after an application policy callback confirms access. The preview
endpoint accepts that grant as a bearer credential and returns the exact RGB
bytes with observation, frame, sensor-frame, timestamp, and SHA-256 headers.
The operator client bounds the response, verifies those headers and the hash,
and binds drawn coordinates to the source image dimensions.

The current HTTP adapter is loopback simulation infrastructure. Production
live video remains an encrypted low-latency media path, but frozen declaration
frames retain the same identity, authorization, integrity, and no-cache rules.

## Consequences

- The interface fails visibly if the immutable image is unavailable; it never
  substitutes a newer camera frame.
- Observation media consumes bounded edge memory and older observations can be
  evicted. Durable evidence retention remains a separate policy-controlled
  service.
- Media grants stay in client memory and expire quickly. They are not placed in
  URLs, persistent browser storage, logs, or domain events.
- Image observation permission still does not grant command authority.

## Alternatives considered

- Draw on the latest live frame: rejected because selection provenance would
  no longer match the immutable observation contract.
- Put an access token in the image URL: rejected because URLs leak through
  histories, logs, diagnostics, and referrers.
- Store unbounded frames in the control plane: rejected because high-rate media
  is not a control-plane responsibility and unbounded storage is unsafe.
