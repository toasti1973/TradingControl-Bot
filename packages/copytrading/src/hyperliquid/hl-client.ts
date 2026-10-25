// ============================================================
// Hyperliquid REST API Client
// ============================================================

import type {
  HLPosition,
  HLUserFill,
  HLLeaderboardEntry,
} from '../types/index.js';

const HL_API_BASE = 'https://api.hyperliquid.xyz';
const HL_STATS_BASE = 'https://stats-data.hyperliquid.xyz/Mainnet';

interface HLInfoRequest {
  type: string;
  user?: string;
  [key: string]: unknown;
}

// Leaderboard Response hat Tuple-Format fuer windowPerformances
interface HLLeaderboardRaw {
  leaderboardRows: Array<{
    ethAddress: string;
    accountValue: string;
    displayName?: string;
    windowPerformances: Array<[string, { pnl: string; roi: string; vlm: string }]>;
  }>;
}

export class HyperliquidClient {
  private readonly baseUrl: string;

  constructor(baseUrl = HL_API_BASE) {
    this.baseUrl = baseUrl;
  }

  // --- Leaderboard: Top-Trader abrufen (separater Endpoint!) ---
  async getLeaderboard(_window: 'day' | 'week' | 'month' | 'allTime' = 'month'): Promise<HLLeaderboardEntry[]> {
    const res = await fetch(`${HL_STATS_BASE}/leaderboard`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid Leaderboard API ${res.status}`);
    }

    const data = await res.json() as HLLeaderboardRaw;
    if (!data.leaderboardRows) return [];

    // Tuple-Format in Object-Format konvertieren
    return data.leaderboardRows.map(row => ({
      ethAddress: row.ethAddress,
      accountValue: row.accountValue,
      windowPerformances: row.windowPerformances.map(([window, perf]) => ({
        window,
        pnl: perf.pnl,
        roi: perf.roi,
        vlm: perf.vlm,
      })),
    }));
  }

  // --- Offene Positionen einer Wallet ---
  async getPositions(walletAddress: string): Promise<HLPosition[]> {
    const raw = await this.postInfo({
      type: 'clearinghouseState',
      user: walletAddress,
    });

    const state = raw as { assetPositions?: Array<{ position: HLPosition }> } | undefined;
    if (!state?.assetPositions) return [];

    return state.assetPositions
      .map(ap => ap.position)
      .filter(p => parseFloat(p.szi) !== 0);
  }

  // --- Trade-History einer Wallet ---
  async getUserFills(walletAddress: string, startTime?: number): Promise<HLUserFill[]> {
    const req: HLInfoRequest = startTime
      ? { type: 'userFillsByTime', user: walletAddress, startTime }
      : { type: 'userFills', user: walletAddress };

    const raw = await this.postInfo(req);
    if (!Array.isArray(raw)) return [];
    return raw as HLUserFill[];
  }

  // --- Aktuelle Mid-Prices aller Assets ---
  async getAllMidPrices(): Promise<Record<string, number>> {
    const raw = await this.postInfo({ type: 'allMids' });
    const mids: Record<string, number> = {};
    if (raw && typeof raw === 'object') {
      for (const [coin, price] of Object.entries(raw as Record<string, string>)) {
        mids[coin] = parseFloat(price);
      }
    }
    return mids;
  }

  // --- Account Summary (fuer PnL-Berechnung) ---
  async getAccountValue(walletAddress: string): Promise<{ accountValue: number; totalPnl: number }> {
    const raw = await this.postInfo({
      type: 'clearinghouseState',
      user: walletAddress,
    });

    const state = raw as {
      marginSummary?: { accountValue: string; totalRawUsd: string };
      crossMarginSummary?: { accountValue: string };
    } | undefined;

    const accountValue = parseFloat(state?.marginSummary?.accountValue ?? '0');
    const totalPnl = parseFloat(state?.marginSummary?.totalRawUsd ?? '0');

    return { accountValue, totalPnl };
  }

  // --- Wallet-Statistiken fuer Scoring ---
  async getWalletStats(walletAddress: string): Promise<{
    fills: HLUserFill[];
    positions: HLPosition[];
    accountValue: number;
  }> {
    // 90 Tage zurueck
    const startTime = Date.now() - 90 * 24 * 60 * 60 * 1000;

    const [fills, positions, account] = await Promise.all([
      this.getUserFills(walletAddress, startTime),
      this.getPositions(walletAddress),
      this.getAccountValue(walletAddress),
    ]);

    return {
      fills,
      positions,
      accountValue: account.accountValue,
    };
  }

  // --- Low-Level POST /info ---
  private async postInfo(body: HLInfoRequest): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hyperliquid API ${res.status}: ${text}`);
    }

    return res.json();
  }
}
