/**
 * build-firefox.mjs
 *
 * Buduje wersję Firefox rozszerzenia:
 *   1. Kopiuje extension/ → dist-firefox/
 *   2. Bundluje background.js (ES modules → jeden plik IIFE)
 *   3. Podmienia sekcję background w manifest.json
 *   4. Pakuje dist-firefox/ → ksef-monitor-{version}-firefox.zip
 *
 * Użycie: node build-firefox.mjs
 * Działa na Windows, macOS i Linux.
 */

import { build } from 'esbuild';
import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	readFileSync,
	writeFileSync,
	rmSync,
	createWriteStream,
} from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const SRC = 'extension';
const DIST = 'dist-firefox';

// ── 1. Wyczyść i skopiuj extension/ → dist-firefox/ ─────────────────────────

rmSync(DIST, { recursive: true, force: true });

function copyDir(src, dst) {
	mkdirSync(dst, { recursive: true });
	for (const entry of readdirSync(src)) {
		const s = join(src, entry);
		const d = join(dst, entry);
		statSync(s).isDirectory() ? copyDir(s, d) : copyFileSync(s, d);
	}
}
copyDir(SRC, DIST);

// ── 2. Bundluj background.js ─────────────────────────────────────────────────

await build({
	entryPoints: [`${SRC}/background.js`],
	bundle: true,
	format: 'iife',
	outfile: `${DIST}/background.js`,
	target: 'firefox128',
	platform: 'browser',
});

// ── 3. Popraw manifest.json ──────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'));

manifest.background = {
	scripts: ['background.js'],
};

writeFileSync(`${DIST}/manifest.json`, JSON.stringify(manifest, null, 2));

// ── 4. Pakuj ZIP (cross-platform, bez systemowego zip) ───────────────────────

const version = manifest.version;
const zipName = `ksef-monitor-${version}-firefox.zip`;

await new Promise((resolve, reject) => {
	const output = createWriteStream(zipName);
	const archive = archiver('zip', { zlib: { level: 9 } });

	output.on('close', () => {
		console.log(`\n✅ Zbudowano: ${zipName} (${archive.pointer()} bajtów)`);
		resolve();
	});
	archive.on('error', reject);

	archive.pipe(output);
	archive.glob('**/*', {
		cwd: DIST,
		ignore: ['**/.DS_Store'],
	});
	archive.finalize();
});
