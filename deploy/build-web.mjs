import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PUBLIC_FILES = [
  'index.html',
  'app.js',
  'style.css',
  'favicon.svg',
  'aiyc.svg',
  'lib/archive.js',
  'lib/pinyin.js',
  'assets'
];

export async function buildWeb(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = path.join(root, 'dist-web');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  for (const name of PUBLIC_FILES) {
    const destination = path.join(output, name);
    const source = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await cp(source, destination, { recursive: true, dereference: false });
    } catch (e) {
      console.warn(`Optional public file ${name} skipped: ${e.message}`);
    }
  }

  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Public web output: ${await buildWeb()}`);
}
