# Observability

Provides a dependency-free Prometheus metric registry and structured JSON
logger. Metric names and labels are validated; callers use normalized route and
state labels rather than IDs. The logger recursively redacts credentials,
authorization headers, signatures, passwords, and private-key fields.

Observability is outside every safety decision: logging or scrape failure can
never delay command validation, watchdog evaluation, or stop output.
