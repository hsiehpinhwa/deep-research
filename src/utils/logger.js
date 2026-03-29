const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function fmt(module, symbol, color, msg) {
  const ts = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  return `${colors.dim}${ts}${colors.reset} ${color}[${module}] ${symbol}${colors.reset} ${msg}`;
}

export const logger = {
  debug: (module, msg) => {
    if (currentLevel <= 0) console.log(fmt(module, '·', colors.dim, msg));
  },
  info: (module, msg) => {
    if (currentLevel <= 1) console.log(fmt(module, '✓', colors.green, msg));
  },
  warn: (module, msg) => {
    if (currentLevel <= 2) console.warn(fmt(module, '⚠', colors.yellow, msg));
  },
  error: (module, msg) => {
    if (currentLevel <= 3) console.error(fmt(module, '✗', colors.red, msg));
  },
  step: (module, msg) => {
    console.log(fmt(module, '→', colors.cyan, msg));
  },
};
