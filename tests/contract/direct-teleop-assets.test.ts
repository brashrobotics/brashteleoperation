import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("direct simulator is focused, tokenless in-browser, and held-deadman only", async () => {
  const publicRoot = new URL("../../apps/direct-teleop-simulator/public/", import.meta.url);
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const application = await readFile(new URL("app.js", publicRoot), "utf8");
  const compose = await readFile(new URL("../../deployment/compose.simulation.yaml", import.meta.url), "utf8");

  assert.match(html, /Direct B2W simulator/);
  assert.match(html, /Tokenless local development console/);
  assert.match(html, /Press and hold/);
  assert.doesNotMatch(
    html,
    /type="password"|id="[^"]*token|name="[^"]*token|\bBearer\b/i
  );
  assert.doesNotMatch(html, /Assistance inbox|Object knowledge|Declare target|manipulation/i);
  assert.match(application, /deadman: true/);
  assert.match(application, /\/api\/command/);
  assert.match(application, /\/api\/hold/);
  assert.match(application, /visibilitychange/);
  assert.match(application, /window\.addEventListener\("blur"/);
  assert.doesNotMatch(application, /4310|4311|4312|authorization|bearer/i);
  assert.match(compose, /direct-teleop-simulator:/);
  assert.match(compose, /BRASH_DIRECT_TELEOP_PORT: "4313"/);
  assert.match(compose, /BRASH_TELEOP_EDGE_TOKEN:/);
});
