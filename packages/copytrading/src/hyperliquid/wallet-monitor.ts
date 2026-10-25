// ============================================================
// WalletMonitor — ueberwacht Hyperliquid-Wallets auf Positionsaenderungen
// Nutzt REST-Polling (zuverlaessiger als WS fuer Position-Snapshots)
// ============================================================

import { EventEmitter } from 'events';
import type { TrackedWallet, WalletSignal, SignalType } from '../types/index.js';
import { HyperliquidClient } from './hl-client.js';
import { randomUUID } from 'crypto';

interface PositionSnapshot {
  coin: string;
  size: number;         // Signed: positive = long, negative = short
  entryPrice: number;
  leverage: number;
}

export class WalletMonitor extends EventEmitter {
  private client: HyperliquidClient;
  private wallets: Map<string, TrackedWallet> = new Map();
  private snapshots: Map<string, Map<string, PositionSnapshot>> = new Map(); // wallet -> coin -> snapshot
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    client: HyperliquidClient,
    private readonly pollIntervalMs = 5000,
  ) {
    super();
    this.client = client;
  }

  addWallet(wallet: TrackedWallet): void {
    this.wallets.set(wallet.address, wallet);
    if (!this.snapshots.has(wallet.address)) {
      this.snapshots.set(wallet.address, new Map());
    }
  }

  removeWallet(address: string): void {
    this.wallets.delete(address);
    this.snapshots.delete(address);
  }

  getTrackedWallets(): TrackedWallet[] {
    return Array.from(this.wallets.values());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initialer Snapshot aller Wallets
    await this.takeInitialSnapshots();

    // Polling starten
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);

    this.emit('started', { wallets: this.wallets.size });
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.emit('stopped');
  }

  private async takeInitialSnapshots(): Promise<void> {
    const addresses = Array.from(this.wallets.keys());
    // Batch in Gruppen von 5 um Rate-Limits zu vermeiden
    for (let i = 0; i < addresses.length; i += 5) {
      const batch = addresses.slice(i, i + 5);
      await Promise.all(batch.map(addr => this.updateSnapshot(addr, true)));
    }
  }

  private async pollAll(): Promise<void> {
    if (!this.running) return;

    const addresses = Array.from(this.wallets.keys());
    // Sequentiell um API nicht zu ueberlasten
    for (const addr of addresses) {
      if (!this.running) break;
      try {
        await this.updateSnapshot(addr, false);
      } catch (err) {
        this.emit('error', { wallet: addr, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async updateSnapshot(address: string, isInitial: boolean): Promise<void> {
    const wallet = this.wallets.get(address);
    if (!wallet || !wallet.active) return;

    const positions = await this.client.getPositions(address);
    const oldSnapshot = this.snapshots.get(address) ?? new Map();
    const newSnapshot = new Map<string, PositionSnapshot>();

    // Aktuelle Positionen mappen
    for (const pos of positions) {
      const size = parseFloat(pos.szi);
      if (size === 0) continue;

      newSnapshot.set(pos.coin, {
        coin: pos.coin,
        size,
        entryPrice: parseFloat(pos.entryPx),
        leverage: pos.leverage.value,
      });
    }

    if (!isInitial) {
      // Vergleiche old vs new und emitte Signale
      this.detectChanges(wallet, oldSnapshot, newSnapshot);
    }

    this.snapshots.set(address, newSnapshot);
  }

  private detectChanges(
    wallet: TrackedWallet,
    oldSnap: Map<string, PositionSnapshot>,
    newSnap: Map<string, PositionSnapshot>,
  ): void {
    // Neue Positionen (open)
    for (const [coin, newPos] of newSnap) {
      const oldPos = oldSnap.get(coin);

      if (!oldPos) {
        // Position neu eroeffnet — immer signalisieren
        this.emitSignal(wallet, coin, newPos, 'open');
      } else if (Math.abs(newPos.size) > Math.abs(oldPos.size) * 1.25) {
        // Position signifikant vergroessert (>25% Aenderung)
        this.emitSignal(wallet, coin, newPos, 'increase');
      } else if (Math.abs(newPos.size) < Math.abs(oldPos.size) * 0.50) {
        // Position mindestens halbiert (>50% Reduktion)
        this.emitSignal(wallet, coin, newPos, 'decrease');
      }
    }

    // Geschlossene Positionen (close)
    for (const [coin, oldPos] of oldSnap) {
      if (!newSnap.has(coin)) {
        this.emitSignal(wallet, coin, oldPos, 'close');
      }
    }
  }

  private emitSignal(
    wallet: TrackedWallet,
    coin: string,
    pos: PositionSnapshot,
    signalType: SignalType,
  ): void {
    // Wallet pausiert?
    if (wallet.paused_until && new Date(wallet.paused_until) > new Date()) {
      return;
    }

    const signal: WalletSignal = {
      id: randomUUID(),
      wallet_address: wallet.address,
      wallet_tier: wallet.tier,
      wallet_score: wallet.score,
      signal_type: signalType,
      symbol: coin + 'USDT',
      direction: pos.size > 0 ? 'long' : 'short',
      size: Math.abs(pos.size),
      leverage: pos.leverage,
      entry_price: pos.entryPrice,
      detected_at: new Date().toISOString(),
      status: 'pending',
    };

    this.emit('signal', signal);
  }
}
