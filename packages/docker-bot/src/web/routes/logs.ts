import { Router } from 'express';
import { Writable } from 'node:stream';

const LOG_BUFFER_SIZE = 500;
const logBuffer: string[] = [];

export function addLogEntry(entry: string): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/** Pino destination stream that captures log lines into the ring buffer */
export function createLogCapture(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line) addLogEntry(line);
      callback();
    },
  });
}

export function getLogBuffer(): string[] {
  return logBuffer;
}

export function createLogsRouter(): Router {
  const router = Router();

  router.get('/api/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query['limit'] as string) || 200, LOG_BUFFER_SIZE);
    const logs = logBuffer.slice(-limit);
    res.json({ logs, total: logBuffer.length });
  });

  return router;
}
