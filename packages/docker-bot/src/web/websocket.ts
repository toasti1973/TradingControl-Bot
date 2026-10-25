import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { BotService } from '../services/bot-service.js';
import { SettingsService } from '../services/settings-service.js';
import { Logger } from '../services/log-service.js';

export function setupWebSocket(
  server: Server,
  botService: BotService,
  settingsService: SettingsService,
  logger: Logger,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade-Request mit Auth prüfen
  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    // Auth aus query-Parameter oder Protokoll-Header extrahieren
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      const pass = colonIdx === -1 ? decoded : decoded.substring(colonIdx + 1);

      const valid = await settingsService.validatePassword(pass);
      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    logger.debug('WebSocket client connected (authenticated)');

    // Sofort aktuellen Status senden
    const stats = botService.getStats();
    safeSend(ws, { type: 'status', data: stats });

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
    });
  });

  // Bot-Events an alle WebSocket-Clients broadcasten
  botService.onEvent((event, data) => {
    const message = { type: event, data, timestamp: new Date().toISOString() };
    broadcast(wss, message);
  });

  return wss;
}

function broadcast(wss: WebSocketServer, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function safeSend(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
