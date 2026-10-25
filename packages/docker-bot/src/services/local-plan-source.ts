// ============================================================
// Planquelle und Protokoll-Senke fuer die bot-eigenen Handelsplaene
//
// Die TradingEngine bezieht ihre Plaene ausschliesslich von hier — aus
// der Tabelle `local_plans`, die der Nutzer ueber die Web-Oberflaeche des
// Bots pflegt. Kein Netzverkehr, keine Abhaengigkeit vom Journal: faellt
// TradingControl aus, laeuft dieser Pfad unveraendert weiter.
//
// Getrennt davon fuehrt der TradePlanMonitor die Plaene aus
// `bot_trade_plans` (aus dem Journal gespiegelt oder hier als Vollplan
// angelegt). Die beiden Bestaende ueberschneiden sich nicht — genau
// deshalb kann keine Order zweimal an die Boerse gehen.
// ============================================================

import type { ExecutionJournal, ExecutionReport, PlanSource, TradePlan } from '@tradingcontrol/core';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';

const BOT_FIRMWARE = 'docker-bot-v0.1.0';
const BOT_DEVICE_ID = process.env['HOSTNAME'] || 'docker-bot';

/** Liest die einfachen, im Bot angelegten Plaene aus der lokalen Datenbank. */
export class LocalPlanSource implements PlanSource {
  readonly name = 'local_plans';

  constructor(private readonly store: SqliteStore) {}

  async fetchPlans(): Promise<TradePlan[]> {
    return this.store.getActiveLocalPlans()
      .map(row => this.toTradePlan(row as unknown as Record<string, unknown>));
  }

  private toTradePlan(row: Record<string, unknown>): TradePlan {
    const parse = <T>(value: unknown, fallback: T): T => {
      if (typeof value !== 'string' || value.length === 0) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    };

    const symbol = row.symbol as string;

    return {
      id: row.id as string,
      source: 'local',
      symbol,
      // `local_plans` fuehrt kein getrenntes Basis-Symbol. Fuer die Anzeige
      // reicht die uebliche Abtrennung der Kurswaehrung.
      asset_symbol: splitAssetSymbol(symbol),
      quote_currency: splitQuoteCurrency(symbol),
      market_type: (row.market_type as 'spot' | 'futures') ?? 'futures',
      direction: row.direction as 'long' | 'short',
      leverage: Number(row.leverage) || 1,
      total_size: Number(row.total_size),
      total_margin: null,
      entry_strategy: (row.entry_strategy as TradePlan['entry_strategy']) ?? 'single',
      entry_orders: parse(row.entry_orders, []),
      entry_zones: parse(row.entry_zones, null),
      take_profits: parse(row.take_profits, []),
      stop_loss_price: row.stop_loss_price != null ? Number(row.stop_loss_price) : null,
      stop_loss_type: (row.stop_loss_type as 'fixed' | 'trailing') ?? 'fixed',
      trailing_stop_pct: row.trailing_stop_pct != null ? Number(row.trailing_stop_pct) : null,
      trailing_stop_activation: row.trailing_stop_activation != null ? Number(row.trailing_stop_activation) : null,
      trailing_stop_size_pct: row.trailing_stop_size_pct != null ? Number(row.trailing_stop_size_pct) : null,
      activation_conditions: parse(row.activation_conditions, []),
      executed_orders: [],
      status: row.status as TradePlan['status'],
      bot_enabled: !!row.bot_enabled,
      notes: (row.notes as string | null) ?? null,
      created_at: (row.created_at as string) ?? new Date().toISOString(),
      updated_at: (row.updated_at as string) ?? new Date().toISOString(),
    };
  }
}

/**
 * Schreibt die Eintraege der TradingEngine in dasselbe Ausfuehrungsprotokoll,
 * das auch der TradePlanMonitor fuehrt. Damit steht der Verlauf beider
 * Pfade an einer Stelle.
 */
export class SqliteExecutionJournal implements ExecutionJournal {
  constructor(
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  record(entry: ExecutionReport): void {
    try {
      this.store.insertExecutionReport({
        plan_id: entry.plan_id,
        entry_order_id: entry.entry_order_id ?? null,
        symbol: entry.symbol,
        side: entry.side,
        order_type: entry.order_type ?? 'limit',
        status: entry.status ?? statusFromAction(entry.action),
        fill_price: entry.avg_fill_price ?? entry.fill_price ?? null,
        fill_quantity: entry.filled_quantity ?? entry.fill_quantity ?? null,
        fees: entry.fees ?? entry.fee ?? null,
        fee_currency: entry.fee_currency ?? null,
        broker: entry.broker ?? 'unbekannt',
        broker_order_id: entry.broker_order_id ?? entry.order_id ?? null,
        bot_firmware: entry.bot_firmware ?? BOT_FIRMWARE,
        device_id: entry.device_id ?? BOT_DEVICE_ID,
        metadata: { action: entry.action, ...(entry.metadata ?? {}) },
        executed_at: entry.executed_at ?? entry.timestamp,
      });
    } catch (err) {
      // Ein misslungener Protokolleintrag darf den Handel nicht anhalten.
      this.logger.warn({ err, planId: entry.plan_id }, 'Protokolleintrag konnte nicht geschrieben werden');
    }
  }
}

/** Leitet den Order-Status aus der Aktion ab, wenn er nicht mitgegeben wurde. */
function statusFromAction(action: ExecutionReport['action']): string {
  if (action.endsWith('_filled')) return 'filled';
  if (action.endsWith('_placed')) return 'placed';
  if (action === 'order_cancelled') return 'cancelled';
  if (action === 'sl_triggered') return 'filled';
  if (action === 'plan_error') return 'error';
  return 'placed';
}

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'EUR', 'USD', 'BTC', 'ETH'];

function splitQuoteCurrency(symbol: string): string {
  const upper = symbol.toUpperCase();
  for (const quote of QUOTE_CURRENCIES) {
    if (upper.endsWith(quote)) return quote;
  }
  return 'USDT';
}

function splitAssetSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  for (const quote of QUOTE_CURRENCIES) {
    if (upper.endsWith(quote)) return upper.slice(0, -quote.length);
  }
  return upper;
}
