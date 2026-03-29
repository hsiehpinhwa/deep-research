// server/config.js — single source of truth for shared path constants
import { resolve } from 'path';

export const BASE_TMP = resolve(process.env.TMP_DIR    || '/tmp/dolphin-tmp');
export const BASE_OUT = resolve(process.env.OUTPUT_DIR || '/tmp/dolphin-output');
