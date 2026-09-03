import assert from "node:assert/strict";
import test from "node:test";
import { JsonLogger, MetricRegistry } from "../../packages/observability/src/index.ts";

test("metrics render deterministically and structured logs redact credentials", () => {
  const metrics = new MetricRegistry();
  metrics.increment("brash_test_total", "Test requests.", { route: "/items/:id", status: "200" });
  metrics.increment("brash_test_total", "Test requests.", { route: "/items/:id", status: "200" }, 2);
  metrics.setGauge("brash_test_ready", "Readiness.", {}, 1);
  const output = metrics.renderPrometheus();
  assert.match(output, /brash_test_total\{route="\/items\/:id",status="200"\} 3/);
  assert.equal(metrics.value("brash_test_ready"), 1);

  const lines: string[] = [];
  const logger = new JsonLogger("test", { sink: (line) => lines.push(line), now: () => new Date("2026-01-01T00:00:00Z") });
  logger.info("request", {
    authorization: "Bearer leaked",
    nested: { accessToken: "leaked", safe: "visible" },
    signature: "leaked",
  }, "correlation-1");
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(JSON.stringify(record).includes("leaked"), false);
  assert.equal(JSON.stringify(record).includes("visible"), true);
});
