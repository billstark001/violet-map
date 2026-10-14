import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const brandDir = join(root, 'assets/branding');
const pngDir = join(brandDir, 'png');
const source = await readFile(join(brandDir, 'violet-map-logo.svg'), 'utf8');
const mark = source.match(/<g id="violet-map-mark">[\s\S]*?<\/g>/)?.[0];
if (!mark) throw new Error('The master SVG must contain the violet-map-mark group.');
const geometry = mark.replace(' id="violet-map-mark"', '');

// The background-free SVG is the geometry source for every variant and PNG.
const lightMark = geometry.replace(/#[0-9A-F]{6}/g, (color) => {
  const palette = {
    '#A78BE3': '#D8C8FF',
    '#7252D9': '#FAF8F2',
    '#5636AA': '#AE92E4',
    '#9BDCAE': '#9BDCAE',
  };
  if (!(color in palette)) throw new Error(`Missing light palette mapping for ${color}.`);
  return palette[color];
});

function svg(width, height, content, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img" aria-labelledby="title desc">\n  <title id="title">Violet Map</title>\n  <desc id="desc">${description}</desc>\n${content}\n</svg>\n`;
}

const iconMark = `<g transform="translate(144 248) scale(0.9583333333333333)">${lightMark}</g>`;
const tile =
  '<path fill="#7252D9" d="M286 24H738C912 24 1000 112 1000 286V738C1000 912 912 1000 738 1000H286C112 1000 24 912 24 738V286C24 112 112 24 286 24Z"/>';
const light = svg(768, 552, lightMark, 'A light folded map with a mint voxel landscape, for dark backgrounds.');
const icon = svg(
  1024,
  1024,
  `${tile}\n${iconMark}`,
  'A flat violet rounded-square app icon with a folded map and mint voxel landscape.',
);
const square = svg(
  1024,
  1024,
  `<path fill="#7252D9" d="M0 0H1024V1024H0Z"/>\n${iconMark}`,
  'An opaque full-bleed app icon for platforms that apply their own corner mask.',
);

await mkdir(pngDir, { recursive: true });
for (const [name, content] of [
  ['violet-map-logo-light.svg', light],
  ['violet-map-icon.svg', icon],
  ['violet-map-icon-square.svg', square],
]) {
  await writeFile(join(brandDir, name), content);
}

async function rasterize(content, width, height, filename) {
  await sharp(Buffer.from(content), { density: 144 }).resize(width, height).png().toFile(join(pngDir, filename));
}

for (const [name, content] of [
  ['violet-map-logo', source],
  ['violet-map-logo-light', light],
]) {
  await rasterize(content, 768, 552, `${name}.png`);
  await rasterize(content, 1536, 1104, `${name}@2x.png`);
}
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await rasterize(icon, size, size, `violet-map-icon-${size}.png`);
}
await rasterize(square, 180, 180, 'apple-touch-icon.png');
await rasterize(square, 512, 512, 'violet-map-icon-square-512.png');

const previewContent = `<rect width="1200" height="480" fill="#F5F3FA"/>
  <g font-family="Arial, sans-serif">
    <text x="32" y="48" fill="#30264D" font-size="28" font-weight="700">Violet Map</text>
    <text x="1168" y="46" fill="#7F738F" font-size="13" text-anchor="end">FLAT VECTOR IDENTITY</text>
    <rect x="24" y="80" width="372" height="312" rx="24" fill="#FFFFFF"/>
    <rect x="414" y="80" width="372" height="312" rx="24" fill="#181425"/>
    <rect x="804" y="80" width="372" height="312" rx="24" fill="#EBE5F6"/>
    <text x="48" y="112" fill="#8B7AA4" font-size="11" letter-spacing="1.5">MARK / LIGHT BACKGROUND</text>
    <text x="438" y="112" fill="#A598BA" font-size="11" letter-spacing="1.5">MARK / DARK BACKGROUND</text>
    <text x="828" y="112" fill="#8B7AA4" font-size="11" letter-spacing="1.5">APP ICON</text>
    <g transform="translate(66 142) scale(0.375)">${geometry}</g>
    <g transform="translate(456 142) scale(0.375)">${lightMark}</g>
    <g transform="translate(864 126) scale(0.24609375)">${tile}${iconMark}</g>
    <text x="32" y="450" fill="#8B7AA4" font-size="11" letter-spacing="1.5">SMALL SIZES</text>
    <g transform="translate(156 428) scale(0.015625)">${tile}${iconMark}</g>
    <g transform="translate(200 420) scale(0.03125)">${tile}${iconMark}</g>
    <g transform="translate(256 412) scale(0.046875)">${tile}${iconMark}</g>
    <text x="1168" y="450" fill="#8B7AA4" font-size="12" text-anchor="end">SVG master · solid fills · transparent marks</text>
  </g>`;
const preview = svg(
  1200,
  480,
  previewContent,
  'Violet Map logo on light and dark backgrounds, with its app icon and small-size samples.',
);
await writeFile(join(brandDir, 'preview.svg'), preview);
await rasterize(preview, 1200, 480, 'preview.png');

for (const app of ['web', 'admin']) {
  const destination = join(root, 'packages', app, 'public/brand');
  await mkdir(destination, { recursive: true });
  for (const filename of ['violet-map-logo.svg', 'violet-map-logo-light.svg', 'violet-map-icon.svg']) {
    await copyFile(join(brandDir, filename), join(destination, filename));
  }
  await copyFile(join(pngDir, 'violet-map-icon-32.png'), join(destination, 'favicon-32.png'));
  await copyFile(join(pngDir, 'apple-touch-icon.png'), join(destination, 'apple-touch-icon.png'));
}
console.log(`Exported SVG variants, PNG sizes, preview, and app assets to ${brandDir}`);
