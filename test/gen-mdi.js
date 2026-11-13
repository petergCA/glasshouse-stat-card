// Builds test/mdi-paths.js (a small subset of Material Design Icons) for the offline harness.
// Usage, from a scratch dir OUTSIDE the repo:  npm i @mdi/js && node <repo>/test/gen-mdi.js <scratch>/node_modules/@mdi/js <repo>/test/mdi-paths.js
// mdi-paths.js is git-ignored; the harness falls back to labelled glyphs without it.
const [, , pkg, out] = process.argv;
const m = require(`${pkg}/commonjs/mdi.js`);
const names = ['home-lightning-bolt', 'thermometer', 'water-percent', 'flash', 'download-network', 'printer-3d-nozzle',
  'door-open', 'door-closed', 'solar-power-variant', 'water', 'alert-circle-outline', 'help-circle-outline', 'sine-wave',
  'gauge', 'finance', 'cash', 'battery-high', 'water-pump', 'home-thermometer'];
const map = {};
names.forEach((n) => {
  const k = `mdi${n.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`;
  if (m[k]) map[`mdi:${n}`] = m[k];
});
require('fs').writeFileSync(out, `window.__MDI = ${JSON.stringify(map)};\n`);
console.log(`${Object.keys(map).length} icons -> ${out}`);
