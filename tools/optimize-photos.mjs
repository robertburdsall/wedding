// Resizes photos for the web and strips their metadata (including GPS location).
// Usage: npm run photos -- "<folder with original photos>"
import sharp from 'sharp';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: npm run photos -- "<folder with original photos>"');
  process.exit(1);
}

const outDir = path.join(root, 'site', 'images', 'photos');
await mkdir(outDir, { recursive: true });

const files = (await readdir(srcDir))
  .filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f))
  .sort();

const manifest = [];
for (const [i, file] of files.entries()) {
  const name = String(i + 1).padStart(2, '0');
  // .rotate() applies the EXIF orientation; sharp drops all other metadata by default.
  const img = sharp(path.join(srcDir, file)).rotate();
  const large = await img.clone().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(outDir, `${name}.jpg`));
  await img.clone().resize({ width: 700, height: 700, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true }).toFile(path.join(outDir, `${name}-sm.jpg`));
  manifest.push({ src: `images/photos/${name}.jpg`, thumb: `images/photos/${name}-sm.jpg`, width: large.width, height: large.height});
  console.log(`${file} -> ${name}.jpg (${large.width}x${large.height})`);
}

await writeFile(path.join(outDir, 'photos.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Done: ${manifest.length} photos.`);
