import type { Request, Response, NextFunction } from 'express';

/** Rate-Limiter: max N Fehlversuche pro IP innerhalb eines Zeitfensters */
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>();
const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 Minuten

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return true;
  if (now - entry.firstAttempt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return true;
  }
  return entry.count < MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

function recordSuccess(ip: string): void {
  failedAttempts.delete(ip);
}

export function createAuthMiddleware(validatePassword: (password: string) => Promise<boolean>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="TradingControl Bot"');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    // split on first ':' only — passwords may contain colons
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const pass = decoded.substring(colonIdx + 1);

    const valid = await validatePassword(pass);
    if (!valid) {
      recordFailedAttempt(ip);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    recordSuccess(ip);
    next();
  };
}
