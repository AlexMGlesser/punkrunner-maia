// Builds dist/PunkRunner.exe — a standalone Windows executable (Node Single Executable Application).
// Usage: npm run build   (must be run on Windows; uses the node.exe you run it with as the base)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const exeName = 'PunkRunner.exe';

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Bundle the server + dependencies into one CommonJS file.
console.log('> bundling server');
await build({
  entryPoints: [path.join(root, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(dist, 'server.cjs'),
  external: ['bufferutil', 'utf-8-validate'], // optional native addons for ws
  logLevel: 'warning',
});

// 2. Collect UI files to embed as SEA assets.
const assets = {};
const publicDir = path.join(root, 'public');
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else assets[path.relative(publicDir, full).split(path.sep).join('/')] = full;
  }
})(publicDir);
assets['vendor/socket.io.min.js'] = path.join(root, 'node_modules/socket.io/client-dist/socket.io.min.js');
console.log(`> embedding ${Object.keys(assets).length} UI files`);

// 3. Generate the SEA blob.
const blob = path.join(dist, 'sea-prep.blob');
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(dist, 'server.cjs'),
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 4. Copy node.exe and inject the blob.
const exe = path.join(dist, exeName);
fs.copyFileSync(process.execPath, exe);
console.log('> injecting blob');
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules/postject/dist/cli.js'),
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' },
);

for (const f of ['server.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(dist, f));
const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
console.log(`\n✔ Built ${path.relative(root, exe)} (${mb} MB)\n`);
