import pino from 'pino';
import { addLogEntry } from '../web/routes/logs.js';

const isDev = process.env['NODE_ENV'] !== 'production';

// Pfade, deren Werte im Protokoll unkenntlich gemacht werden. Die
// Zugangsdaten der Boersen liegen verschachtelt unter `exchanges.<id>` —
// pino ersetzt mit `*` genau eine Ebene, die Feldnamen darunter deckt
// bereits die allgemeine Liste ab.
const REDACT_PATHS = [
  'tcApiKey', 'telegramBotToken', 'claudeApiKey',
  'password', 'apiKey', 'apiSecret', 'authorization',
  'exchanges.*.apiKey', 'exchanges.*.apiSecret', 'exchanges.*.password',
  '*.apiKey', '*.apiSecret',
];

export function createLogger(level: string = 'info') {
  const logger = pino({
    level,
    ...(isDev ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    } : {}),
    redact: {
      paths: REDACT_PATHS,
      censor: '***REDACTED***',
    },
    hooks: {
      logMethod(inputArgs, method) {
        // Capture log entry into ring buffer for the UI
        try {
          const ts = new Date().toISOString().slice(11, 23);
          const lvl = (this as any).level ?? '';
          const levelName = typeof lvl === 'number' ? pino.levels.labels[lvl] ?? 'info' : 'info';
          // inputArgs can be [msg] or [obj, msg]
          const msg = typeof inputArgs[0] === 'string' ? inputArgs[0] : (inputArgs[1] ?? '');
          const logLine = `[${ts}] ${(levelName as string).toUpperCase()}: ${msg}`;
          addLogEntry(logLine);
        } catch {
          // Never let log capture break the actual logger
        }
        return method.apply(this, inputArgs as any);
      },
    },
  });

  return logger;
}

export type Logger = ReturnType<typeof createLogger>;
