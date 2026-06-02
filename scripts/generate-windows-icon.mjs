import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "packaging", "windows", "DemucsSeperater.svg");
const outDir = path.join(root, "dist");
const sizes = [16, 24, 32, 48, 64, 128, 256];

mkdirSync(outDir, { recursive: true });

const svg = readFileSync(source);
const pngBuffers = await Promise.all(
  sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()),
);
const ico = await pngToIco(pngBuffers);

writeFileSync(path.join(outDir, "DemucsSeperater.ico"), ico);
writeFileSync(path.join(outDir, "DemucsSeperater-256.png"), pngBuffers[pngBuffers.length - 1]);
