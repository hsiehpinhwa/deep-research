import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TMP_DIR = join(ROOT, process.env.TMP_DIR || 'tmp');
const OUTPUT_DIR = join(ROOT, process.env.OUTPUT_DIR || 'output');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveTmp(filename, data) {
  ensureDir(TMP_DIR);
  const path = join(TMP_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

export function loadTmp(filename) {
  const path = join(TMP_DIR, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveOutput(filename, content, encoding = 'utf-8') {
  ensureDir(OUTPUT_DIR);
  const path = join(OUTPUT_DIR, filename);
  writeFileSync(path, content, encoding);
  return path;
}

export function tmpPath(filename) {
  ensureDir(TMP_DIR);
  return join(TMP_DIR, filename);
}

export function outputPath(filename) {
  ensureDir(OUTPUT_DIR);
  return join(OUTPUT_DIR, filename);
}

export function rootPath(...parts) {
  return join(ROOT, ...parts);
}
