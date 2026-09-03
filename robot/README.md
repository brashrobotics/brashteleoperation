# Robot-Local Runtime

## Purpose

Contains latency-sensitive perception, manipulation, arbitration, and safety
components that execute on or next to the robot.

## Components

- [Command arbiter](command-arbiter/README.md)
- [Safety supervisor](safety-supervisor/README.md)
- [Interactive perception](interactive-perception/README.md)
- [Manipulation executor](manipulation-executor/README.md)
- [Robot adapters](adapters/README.md)

## Dependency direction

```text
interactive perception -> scene facts -> manipulation executor
operator/autonomy sources -> command arbiter -> safety supervisor -> adapter
```

Perception and manipulation cannot bypass arbitration. The adapter cannot grant
ownership. The safety supervisor is the last software authority before the
vendor interface; physical/vendor safety remains authoritative beyond it.
