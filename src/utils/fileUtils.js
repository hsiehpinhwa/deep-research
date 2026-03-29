import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_TMP_DIR    = join(ROOT, process.env.TMP_DIR    || 'tmp');
const DEFAULT_OUTPUT_DIR = join(ROOT, process.env.OUTPUT_DIR || 'output');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveTmp(filename, data, dir = DEFAULT_TMP_DIR) {
  ensureDir(dir);
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

export function loadTmp(filename, dir = DEFAULT_TMP_DIR) {
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveOutput(filename, content, encoding = 'utf-8') {
  ensureDir(DEFAULT_OUTPUT_DIR);
  const path = join(DEFAULT_OUTPUT_DIR, filename);
  writeFileSync(path, content, encoding);
  return path;
}

export function tmpPath(filename, dir = DEFAULT_TMP_DIR) {
  ensureDir(dir);
  return join(dir, filename);
}

export function outputPath(filename, dir = DEFAULT_OUTPUT_DIR) {
  ensureDir(dir);
  return join(dir, filename);
}

export function rootPath(...parts) {
  return join(ROOT, ...parts);
}
