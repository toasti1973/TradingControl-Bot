// ============================================================
// Ausfuehrungsprotokoll — rein lokal
//
// Diese Eintraege gehen nirgendwohin. Sie halten fest, was der Bot getan
// hat und warum. Die handelsrelevanten Zahlen (Fuellungen, Gebuehren,
// Ergebnis) holt sich das Journal ueber seinen eigenen API-Import bei der
// Boerse — dort stehen auch Teilfuellungen und Eingriffe von Hand drin,
// von denen der Bot nichts weiss.
// ============================================================

export type ExecutionAction =
  | 'entry_placed'
  | 'entry_filled'
  | 'tp_placed'
  | 'tp_filled'
  | 'sl_placed'
  | 'sl_triggered'
  | 'order_cancelled'
  | 'plan_activated'
  | 'plan_completed'
  | 'plan_error';

/**
 * Senke fuer das Ausfuehrungsprotokoll.
 *
 * Absichtlich schmal gehalten und ohne Rueckgabewert: Ein Protokolleintrag
 * darf den Handel nie aufhalten, und es gibt keine Gegenstelle, die eine
 * Bestaetigung schicken koennte.
 */
export interface ExecutionJournal {
  record(entry: ExecutionReport): void;
}

export interface ExecutionReport {
  plan_id: string;
  action: ExecutionAction;
  order_id?: string;
  entry_order_id?: string | null;     // UUID der Entry-Order (TC Migration 077)
  order_type?: 'limit' | 'market' | 'stop' | 'stop_limit';
  status?: 'placed' | 'filled' | 'cancelled' | 'rejected';
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  fill_price?: number;                // Alias zu avg_fill_price (TC-konform)
  quantity: number;
  fill_quantity?: number;
  filled_quantity?: number;
  avg_fill_price?: number;
  fee?: number;
  fees?: number;
  fee_currency?: string;
  pnl?: number;
  message?: string;
  broker?: string;
  broker_order_id?: string;
  bot_firmware?: string;            // Doku Section 5: 'docker-bot-v0.1.0'
  device_id?: string;
  metadata?: Record<string, unknown>;
  executed_at?: string;
  timestamp: string;
}

export type OrderStatus = 'pending' | 'placed' | 'partially_filled' | 'filled' | 'cancelled' | 'error';

export interface TrackedOrder {
  planId: string;
  orderId: string;
  clientOrderId: string;
  type: 'entry' | 'take_profit' | 'stop_loss' | 'trailing_stop';
  index: number;
  entryOrderId?: string | null;       // UUID der Entry-Order (Migration 077)
  status: OrderStatus;
  price: number;
  quantity: number;
  filledQuantity: number;
  avgFillPrice: number;
  lastChecked: number;
}
