import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("installable operator shell remains network-only and labels its mobile boundary", async () => {
  const publicRoot = new URL("../../apps/operator-station/public/", import.meta.url);
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", publicRoot), "utf8")) as {
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; purpose: string }>;
  };
  const worker = await readFile(new URL("sw.js", publicRoot), "utf8");
  const application = await readFile(new URL("app.js", publicRoot), "utf8");

  assert.match(html, /rel="manifest" href="\/operator\/manifest\.webmanifest"/);
  assert.match(html, /physical touch-to-motion remains disabled/);
  assert.match(html, /id="media-api-url"/);
  assert.match(html, /id="edge-api-url"/);
  assert.match(html, /B2W Gazebo only/);
  assert.equal(manifest.start_url, "/operator/");
  assert.equal(manifest.scope, "/operator/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes("maskable")));
  assert.match(worker, /cache: "no-store"/);
  assert.doesNotMatch(worker, /caches\.open/);
  assert.match(application, /x-brash-observation-id/);
  assert.match(application, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(application, /enableBoxSelection/);
  assert.match(application, /normalizeEdgeApiUrl/);
  assert.match(application, /deadman:true/);
  assert.match(application, /edge\/v1\/safety\/hold/);
  assert.doesNotMatch(application, /hardware\/cmd_vel/);
  assert.doesNotMatch(application, /sessionStorage\.setItem\([^\n]*accessToken/);
  assert.doesNotMatch(application, /sessionStorage\.setItem\([^\n]*edgeToken/);
});
