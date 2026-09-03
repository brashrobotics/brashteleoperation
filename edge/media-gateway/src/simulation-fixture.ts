import { deflateSync } from "node:zlib";

/** Creates a dependency-free RGB PNG with a high-contrast simulated target. */
export function createSimulationObservationPng(width = 640, height = 360): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 64 || height < 64 || width > 1_920 || height > 1_080) {
    throw new Error("Simulation observation dimensions are invalid.");
  }
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  const targetLeft = Math.floor(width * 0.34);
  const targetRight = Math.floor(width * 0.68);
  const targetTop = Math.floor(height * 0.30);
  const targetBottom = Math.floor(height * 0.78);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const target = x >= targetLeft && x < targetRight && y >= targetTop && y < targetBottom;
      const grid = x % 64 < 2 || y % 64 < 2;
      pixels[offset] = target ? 40 : grid ? 48 : 24;
      pixels[offset + 1] = target ? 116 : grid ? 58 : 34;
      pixels[offset + 2] = target ? 228 : grid ? 54 : 42;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.byteLength);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
