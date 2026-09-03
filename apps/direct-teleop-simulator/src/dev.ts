import { DirectTeleopRuntime } from "./runtime.ts";
import { startDirectTeleopServer } from "./server.ts";

const runtime = new DirectTeleopRuntime({
  controlUrl: process.env.BRASH_TELEOP_CONTROL_URL?.trim() || "http://127.0.0.1:4310",
  edgeUrl: process.env.BRASH_TELEOP_EDGE_URL?.trim() || "http://127.0.0.1:4311",
  mediaUrl: process.env.BRASH_TELEOP_MEDIA_URL?.trim() || "http://127.0.0.1:4312",
  controlToken: process.env.BRASH_TELEOP_CONTROL_TOKEN ?? "",
  edgeToken: process.env.BRASH_TELEOP_EDGE_TOKEN ?? "",
  operatorId: process.env.BRASH_TELEOP_OPERATOR_ID?.trim() || "operator-001",
  robotId: process.env.BRASH_TELEOP_ROBOT_ID?.trim() || "b2-unit-001",
});
const running = await startDirectTeleopServer({
  runtime,
  host: process.env.BRASH_DIRECT_TELEOP_HOST?.trim() || "127.0.0.1",
  port: Number.parseInt(process.env.BRASH_DIRECT_TELEOP_PORT || "4313", 10),
});

console.log(`BRASH tokenless direct B2W simulator ready at ${running.url}`);
console.log("This loopback-only console can command only the output-enabled Gazebo profile; physical output remains disabled.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    try {
      await runtime.release();
    } catch {
      // Edge watchdog and lease expiry remain authoritative during shutdown.
    }
    await running.close();
    process.exit(0);
  });
}
