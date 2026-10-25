// ============================================================
// CopyTrading API Routes
// ============================================================

import { Router } from 'express';
import type { SqliteStore } from '../../store/sqlite-store.js';
import type { CopyTradingService } from '../../services/copytrading-service.js';
import type { SettingsService } from '../../services/settings-service.js';

export function copytradingRoutes(store: SqliteStore, ctService: CopyTradingService, settingsService?: SettingsService): Router {
  const router = Router();

  // --- Wallets ---

  // Alle getrackten Wallets abrufen
  router.get('/api/copytrading/wallets', (_req, res) => {
    const wallets = store.getCtWallets();
    res.json({ wallets });
  });

  // Wallet manuell hinzufuegen
  router.post('/api/copytrading/wallets', (req, res) => {
    const { address, label } = req.body as { address?: string; label?: string };
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Ungueltige Ethereum-Adresse' });
      return;
    }

    const existing = store.getCtWallet(address);
    if (existing) {
      res.status(409).json({ error: 'Wallet bereits vorhanden' });
      return;
    }

    store.upsertCtWallet({
      address,
      label: label || undefined,
      tier: 'watchlist',
      score: 0,
      added_by: 'manual',
      active: true,
      sharpe_ratio: 0,
      max_drawdown_pct: 0,
      win_rate: 0,
      profit_factor: 0,
      total_trades: 0,
      track_record_days: 0,
      avg_leverage: 0,
      streak: 0,
    });

    res.json({ success: true, message: `Wallet ${address.slice(0, 8)}... hinzugefuegt` });
  });

  // Wallet aktualisieren (Label, Active-Status)
  router.put('/api/copytrading/wallets/:address', (req, res) => {
    const { address } = req.params;
    const existing = store.getCtWallet(address!);
    if (!existing) {
      res.status(404).json({ error: 'Wallet nicht gefunden' });
      return;
    }

    const { label, active } = req.body as { label?: string; active?: boolean };
    store.upsertCtWallet({
      ...(existing as { address: string; tier: string; score: number; added_by: string; active: boolean;
        sharpe_ratio: number; max_drawdown_pct: number; win_rate: number; profit_factor: number;
        total_trades: number; track_record_days: number; avg_leverage: number; streak: number }),
      active: active !== undefined ? active : !!existing.active,
      label: label !== undefined ? label : existing.label as string | undefined,
    });

    res.json({ success: true });
  });

  // Wallet entfernen
  router.delete('/api/copytrading/wallets/:address', (req, res) => {
    const { address } = req.params;
    store.deleteCtWallet(address!);
    res.json({ success: true });
  });

  // --- Signals ---

  // Letzte Signale abrufen
  router.get('/api/copytrading/signals', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const signals = store.getCtSignals(limit, offset);
    const stats = store.getCtSignalStats();
    res.json({ signals, stats });
  });

  // --- Actions ---

  // Leaderboard scannen (manuell triggern)
  router.post('/api/copytrading/scan', async (_req, res) => {
    try {
      const result = await ctService.scanLeaderboard();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan fehlgeschlagen' });
    }
  });

  // Monitoring starten
  router.post('/api/copytrading/start', async (req, res) => {
    try {
      // Claude API-Key aus KeyStore holen
      let claudeApiKey = '';
      if (settingsService) {
        const cfg = await settingsService.getEffectiveConfig();
        claudeApiKey = (cfg as unknown as Record<string, unknown>).claudeApiKey as string ?? '';
      }
      if (!claudeApiKey) {
        res.status(400).json({ error: 'Kein Claude API-Key konfiguriert. Bitte in Einstellungen eingeben.' });
        return;
      }

      const { claudeModel, portfolioSize, minCombinedScore, minConvictionScore } = req.body as Record<string, unknown>;
      await ctService.startMonitoring({
        claudeApiKey,
        claudeModel: String(claudeModel || 'claude-sonnet-4-20250514'),
        portfolioSize: Number(portfolioSize) || 1000,
        minCombinedScore: Number(minCombinedScore) || 60,
        minConvictionScore: Number(minConvictionScore) || 55,
      });
      res.json({ success: true, message: 'CopyTrading Monitoring gestartet' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Start fehlgeschlagen' });
    }
  });

  // Monitoring stoppen
  router.post('/api/copytrading/stop', (_req, res) => {
    ctService.stopMonitoring();
    res.json({ success: true, message: 'CopyTrading Monitoring gestoppt' });
  });

  // Alle Scores aktualisieren
  router.post('/api/copytrading/update-scores', async (_req, res) => {
    try {
      await ctService.updateAllScores();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Score-Update fehlgeschlagen' });
    }
  });

  // --- Positionen ---

  router.get('/api/copytrading/positions', (_req, res) => {
    // Executor hat laufende Positionen
    const executor = ctService.getExecutor();
    const liveOpen = executor?.getOpenPositions() ?? [];
    const liveClosed = executor?.getClosedPositions() ?? [];

    // DB hat persistierte Trades (auch nach Neustart)
    const dbOpen: Record<string, unknown>[] = store.getCtTrades('open').map(t => ({
      ...t,
      tp_prices: JSON.parse((t.tp_prices as string) || '[]'),
      trailing_active: !!t.trailing_active,
    }));
    const dbClosed: Record<string, unknown>[] = store.getCtTrades('closed').map(t => ({
      ...t,
      tp_prices: JSON.parse((t.tp_prices as string) || '[]'),
      trailing_active: !!t.trailing_active,
    }));

    // Merge: Live-Daten bevorzugen, DB als Fallback
    const openIds = new Set(liveOpen.map(p => p.id));
    const closedIds = new Set(liveClosed.map(p => p.id));
    const allOpen = [...liveOpen, ...dbOpen.filter(t => !openIds.has(t['id'] as string) && !closedIds.has(t['id'] as string))];
    const allClosed = [...liveClosed, ...dbClosed.filter(t => !closedIds.has(t['id'] as string))];

    const dbStats = store.getCtTradeStats();

    res.json({
      open: allOpen,
      closed: allClosed,
      totalPnl: dbStats.totalPnl ?? 0,
      marginInUse: executor?.getTotalMarginInUse() ?? 0,
      tradeStats: dbStats,
    });
  });

  // --- Stats ---

  router.get('/api/copytrading/stats', (_req, res) => {
    const wallets = store.getCtWallets();
    const signalStats = store.getCtSignalStats();

    const tierCounts = { tier1: 0, tier2: 0, tier3: 0, watchlist: 0, blacklist: 0 };
    for (const w of wallets) {
      const tier = w.tier as keyof typeof tierCounts;
      if (tier in tierCounts) tierCounts[tier]++;
    }

    res.json({
      total_wallets: wallets.length,
      active_wallets: wallets.filter(w => w.active).length,
      tiers: tierCounts,
      signals: signalStats,
      monitor: ctService.getMonitorStats(),
    });
  });

  return router;
}
