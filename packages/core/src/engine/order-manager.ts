import { EventEmitter } from 'node:events';
import { BrokerAdapter, OrderParams } from '../types/broker.js';
import { TcPlan } from '../types/plan.js';
import { ExecutionJournal, ExecutionReport, TrackedOrder } from '../types/execution.js';

export interface OrderManagerEvents {
  'order:placed': [order: TrackedOrder];
  'order:filled': [order: TrackedOrder];
  'order:cancelled': [order: TrackedOrder];
  'order:error': [planId: string, error: Error];
  'plan:completed': [planId: string];
  'plan:error': [planId: string, error: Error];
  'sl:adjusted': [planId: string, oldPrice: number, newPrice: number];
  'trailing:activated': [planId: string, pct: number];
  'trailing:updated': [planId: string, newStopPrice: number];
}

interface TrailingState {
  active: boolean;
  pct: number;
  bestPrice: number;
  currentStop: number;
}

interface PlanState {
  plan: TcPlan;
  leverageSet: boolean;
  entryOrders: TrackedOrder[];
  tpOrders: TrackedOrder[];
  slOrder: TrackedOrder | null;
  errorCount: number;
  status: 'pending' | 'entering' | 'monitoring' | 'completed' | 'error';
  trailing: TrailingState | null;
}

export interface OrderManagerConfig {
  maxOrdersPerHour?: number;
  maxOrdersPerDay?: number;
  maxPriceDeviationPct?: number;
  maxErrorsPerPlan?: number;
}

export class OrderManager extends EventEmitter<OrderManagerEvents> {
  private planStates = new Map<string, PlanState>();
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private ordersPlacedLastHour = 0;
  private ordersPlacedLastDay = 0;
  private hourlyResetTimer: ReturnType<typeof setInterval> | null = null;
  private dailyResetTimer: ReturnType<typeof setInterval> | null = null;

  private readonly maxOrdersPerHour: number;
  private readonly maxOrdersPerDay: number;
  private readonly maxErrorsPerPlan: number;

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly journal: ExecutionJournal | null,
    config: OrderManagerConfig = {}
  ) {
    super();
    this.maxOrdersPerHour = config.maxOrdersPerHour ?? 50;
    this.maxOrdersPerDay = config.maxOrdersPerDay ?? 200;
    this.maxErrorsPerPlan = config.maxErrorsPerPlan ?? 10;
  }

  start(checkInterval = 3000): void {
    this.checking = true;
    this.scheduleCheck(checkInterval);
    this.hourlyResetTimer = setInterval(() => { this.ordersPlacedLastHour = 0; }, 3_600_000);
    this.dailyResetTimer = setInterval(() => { this.ordersPlacedLastDay = 0; }, 86_400_000);
  }

  stop(): void {
    this.checking = false;
    if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }
    if (this.hourlyResetTimer) { clearInterval(this.hourlyResetTimer); this.hourlyResetTimer = null; }
    if (this.dailyResetTimer) { clearInterval(this.dailyResetTimer); this.dailyResetTimer = null; }
  }

  private scheduleCheck(interval: number): void {
    if (!this.checking) return;
    this.checkOrders().finally(() => {
      if (this.checking) {
        this.checkTimer = setTimeout(() => this.scheduleCheck(interval), interval);
      }
    });
  }

  async executePlan(plan: TcPlan): Promise<void> {
    if (this.planStates.has(plan.id)) return;

    const state: PlanState = {
      plan,
      leverageSet: false,
      entryOrders: [],
      tpOrders: [],
      slOrder: null,
      errorCount: 0,
      status: 'pending',
      trailing: null,
    };
    this.planStates.set(plan.id, state);

    try {
      // 1. Leverage setzen
      if (plan.market_type === 'futures' && plan.leverage > 0) {
        await this.broker.setLeverage(plan.symbol, plan.leverage);
        state.leverageSet = true;
      }

      // 2. Entry-Orders platzieren
      state.status = 'entering';
      for (let i = 0; i < plan.entry_orders.length; i++) {
        if (!this.checkOrderLimits()) {
          throw new Error('Order limit reached');
        }

        const entry = plan.entry_orders[i]!;
        const side = plan.direction === 'long' ? 'buy' : 'sell';
        const clientOrderId = `tc-bot-${plan.id.slice(0, 8)}-entry-${i}`;

        const orderType = entry.order_type ?? 'limit';
        const params: OrderParams = {
          symbol: plan.symbol,
          side: side as 'buy' | 'sell',
          type: orderType,
          quantity: entry.size,
          price: orderType === 'limit' ? entry.price : undefined,
          clientOrderId,
        };

        const result = await this.broker.placeOrder(params);
        this.ordersPlacedLastHour++;
        this.ordersPlacedLastDay++;

        const tracked: TrackedOrder = {
          planId: plan.id,
          orderId: result.orderId,
          clientOrderId,
          type: 'entry',
          index: i,
          status: result.status === 'filled' ? 'filled' : 'placed',
          price: entry.price,
          quantity: entry.size,
          filledQuantity: result.filledQuantity,
          avgFillPrice: result.avgFillPrice,
          lastChecked: Date.now(),
        };

        state.entryOrders.push(tracked);
        this.emit('order:placed', tracked);

        await this.reportExecution(plan, 'entry_placed', tracked);

        // Wenn Market-Order sofort gefüllt
        if (result.status === 'filled') {
          tracked.status = 'filled';
          this.emit('order:filled', tracked);
          await this.reportExecution(plan, 'entry_filled', tracked);
          await this.placeExitOrders(state, tracked);
        }
      }

      state.status = 'monitoring';
    } catch (err) {
      state.errorCount++;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('order:error', plan.id, error);

      if (state.errorCount >= this.maxErrorsPerPlan) {
        state.status = 'error';
        this.emit('plan:error', plan.id, new Error(`Max errors (${this.maxErrorsPerPlan}) reached`));
      }
    }
  }

  async cancelPlan(planId: string): Promise<void> {
    const state = this.planStates.get(planId);
    if (!state) return;

    // Alle offenen Orders stornieren
    const allOrders = [...state.entryOrders, ...state.tpOrders];
    if (state.slOrder) allOrders.push(state.slOrder);

    for (const order of allOrders) {
      if (order.status === 'placed') {
        try {
          await this.broker.cancelOrder(state.plan.symbol, order.orderId);
          order.status = 'cancelled';
          this.emit('order:cancelled', order);
        } catch {
          // Ignorieren — Order ist möglicherweise bereits gefüllt
        }
      }
    }

    state.status = 'completed';
    this.planStates.delete(planId);
  }

  getPlanState(planId: string): PlanState | undefined {
    return this.planStates.get(planId);
  }

  getActivePlanIds(): string[] {
    return [...this.planStates.keys()].filter(id => {
      const state = this.planStates.get(id);
      return state && state.status !== 'completed' && state.status !== 'error';
    });
  }

  private async checkOrders(): Promise<void> {
    // Trailing Stops aktualisieren
    await this.updateTrailingStops();

    for (const [_planId, state] of this.planStates) {
      if (state.status === 'completed' || state.status === 'error') continue;

      try {
        // Entry-Orders prüfen
        for (const order of state.entryOrders) {
          if (order.status !== 'placed') continue;
          await this.checkOrderStatus(state, order);
        }

        // TP-Orders prüfen
        for (const order of state.tpOrders) {
          if (order.status !== 'placed') continue;
          await this.checkOrderStatus(state, order);
        }

        // SL-Order prüfen
        if (state.slOrder && state.slOrder.status === 'placed') {
          await this.checkOrderStatus(state, state.slOrder);
        }

        // Plan-Completion prüfen
        this.checkPlanCompletion(state);
      } catch (err) {
        state.errorCount++;
        if (state.errorCount >= this.maxErrorsPerPlan) {
          state.status = 'error';
          this.emit('plan:error', state.plan.id, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  private async checkOrderStatus(state: PlanState, order: TrackedOrder): Promise<void> {
    const result = await this.broker.getOrder(state.plan.symbol, order.orderId);
    if (!result) return;

    order.lastChecked = Date.now();

    if (result.status === 'filled' && order.status !== 'filled') {
      order.status = 'filled';
      order.filledQuantity = result.filledQuantity;
      order.avgFillPrice = result.avgFillPrice;
      this.emit('order:filled', order);

      const action = order.type === 'entry' ? 'entry_filled'
        : order.type === 'take_profit' ? 'tp_filled'
        : 'sl_triggered';
      await this.reportExecution(state.plan, action, order);

      // Nach Entry-Fill: Exit-Orders platzieren
      if (order.type === 'entry') {
        await this.placeExitOrders(state, order);
      }

      // Nach TP-Fill: SL anpassen und/oder Trailing aktivieren
      if (order.type === 'take_profit') {
        await this.handleTpFill(state, order);
      }
    } else if (result.status === 'cancelled' && order.status !== 'cancelled') {
      order.status = 'cancelled';
      this.emit('order:cancelled', order);
    }
  }

  private async handleTpFill(state: PlanState, filledTp: TrackedOrder): Promise<void> {
    const plan = state.plan;
    const tp = plan.take_profits[filledTp.index];
    if (!tp) return;

    // 1. SL-Anpassung: alten SL canceln, neuen platzieren
    if (tp.sl_adjust && tp.sl_new_price != null && tp.sl_new_price > 0) {
      await this.adjustStopLoss(state, tp.sl_new_price);
    }

    // 2. Trailing-Stop aktivieren
    if (tp.activate_trailing && tp.trailing_pct != null && tp.trailing_pct > 0) {
      await this.activateTrailing(state, tp.trailing_pct, filledTp.avgFillPrice);
    }
  }

  private async adjustStopLoss(state: PlanState, newPrice: number): Promise<void> {
    const plan = state.plan;
    const exitSide = plan.direction === 'long' ? 'sell' : 'buy';
    const oldPrice = state.slOrder?.price ?? 0;

    // Alten SL canceln
    if (state.slOrder && state.slOrder.status === 'placed') {
      try {
        await this.broker.cancelOrder(plan.symbol, state.slOrder.orderId);
        state.slOrder.status = 'cancelled';
      } catch {
        // Order eventuell bereits gefuellt
        return;
      }
    }

    // Verbleibende Positionsgroesse berechnen
    const remainingQty = this.getRemainingQuantity(state);
    if (remainingQty <= 0) return;

    // Neuen SL platzieren
    const clientOrderId = `tc-bot-${plan.id.slice(0, 8)}-sl-adj-${Date.now()}`;
    try {
      const result = await this.broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide as 'buy' | 'sell',
        type: 'stop',
        quantity: remainingQty,
        stopPrice: newPrice,
        clientOrderId,
        reduceOnly: true,
      });

      this.ordersPlacedLastHour++;
      this.ordersPlacedLastDay++;

      state.slOrder = {
        planId: plan.id,
        orderId: result.orderId,
        clientOrderId,
        type: 'stop_loss',
        index: 0,
        status: 'placed',
        price: newPrice,
        quantity: remainingQty,
        filledQuantity: 0,
        avgFillPrice: 0,
        lastChecked: Date.now(),
      };

      this.emit('order:placed', state.slOrder);
      this.emit('sl:adjusted', plan.id, oldPrice, newPrice);
      await this.reportExecution(plan, 'sl_placed', state.slOrder);
    } catch (err) {
      state.errorCount++;
      this.emit('order:error', plan.id, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async activateTrailing(state: PlanState, pct: number, currentPrice: number): Promise<void> {
    // Alten SL canceln — Trailing uebernimmt
    if (state.slOrder && state.slOrder.status === 'placed') {
      try {
        await this.broker.cancelOrder(state.plan.symbol, state.slOrder.orderId);
        state.slOrder.status = 'cancelled';
      } catch {
        // Ignorieren
      }
    }

    const initialStop = state.plan.direction === 'long'
      ? currentPrice * (1 - pct / 100)
      : currentPrice * (1 + pct / 100);

    state.trailing = {
      active: true,
      pct,
      bestPrice: currentPrice,
      currentStop: initialStop,
    };

    this.emit('trailing:activated', state.plan.id, pct);

    // Sofort neuen SL auf initialStop setzen
    await this.placeTrailingStop(state, initialStop);
  }

  private async updateTrailingStops(): Promise<void> {
    for (const [_planId, state] of this.planStates) {
      if (!state.trailing?.active || state.status === 'completed' || state.status === 'error') continue;

      const currentPrice = await this.broker.getPrice(state.plan.symbol);
      if (currentPrice === null) continue;

      const t = state.trailing;
      const isLong = state.plan.direction === 'long';

      // Pruefen ob Preis sich verbessert hat
      const priceImproved = isLong
        ? currentPrice > t.bestPrice
        : currentPrice < t.bestPrice;

      if (!priceImproved) continue;

      t.bestPrice = currentPrice;
      const newStop = isLong
        ? currentPrice * (1 - t.pct / 100)
        : currentPrice * (1 + t.pct / 100);

      // Nur nachziehen wenn der neue Stop besser ist
      const stopImproved = isLong
        ? newStop > t.currentStop
        : newStop < t.currentStop;

      if (!stopImproved) continue;

      t.currentStop = newStop;

      // Alten SL canceln und neuen platzieren
      await this.placeTrailingStop(state, newStop);
      this.emit('trailing:updated', state.plan.id, newStop);
    }
  }

  private async placeTrailingStop(state: PlanState, stopPrice: number): Promise<void> {
    const plan = state.plan;
    const exitSide = plan.direction === 'long' ? 'sell' : 'buy';

    // Alten SL canceln
    if (state.slOrder && state.slOrder.status === 'placed') {
      try {
        await this.broker.cancelOrder(plan.symbol, state.slOrder.orderId);
        state.slOrder.status = 'cancelled';
      } catch {
        // Ignorieren
      }
    }

    const remainingQty = this.getRemainingQuantity(state);
    if (remainingQty <= 0) return;

    const clientOrderId = `tc-bot-${plan.id.slice(0, 8)}-ts-${Date.now()}`;
    try {
      const result = await this.broker.placeOrder({
        symbol: plan.symbol,
        side: exitSide as 'buy' | 'sell',
        type: 'stop',
        quantity: remainingQty,
        stopPrice,
        clientOrderId,
        reduceOnly: true,
      });

      this.ordersPlacedLastHour++;
      this.ordersPlacedLastDay++;

      state.slOrder = {
        planId: plan.id,
        orderId: result.orderId,
        clientOrderId,
        type: 'stop_loss',
        index: 0,
        status: 'placed',
        price: stopPrice,
        quantity: remainingQty,
        filledQuantity: 0,
        avgFillPrice: 0,
        lastChecked: Date.now(),
      };

      this.emit('order:placed', state.slOrder);
    } catch (err) {
      state.errorCount++;
      this.emit('order:error', plan.id, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private getRemainingQuantity(state: PlanState): number {
    const totalFilled = state.entryOrders
      .filter(o => o.status === 'filled')
      .reduce((sum, o) => sum + o.filledQuantity, 0);
    const tpFilled = state.tpOrders
      .filter(o => o.status === 'filled')
      .reduce((sum, o) => sum + o.filledQuantity, 0);
    return Math.max(0, totalFilled - tpFilled);
  }

  private async placeExitOrders(state: PlanState, filledEntry: TrackedOrder): Promise<void> {
    const plan = state.plan;
    const exitSide = plan.direction === 'long' ? 'sell' : 'buy';

    // Take-Profit Orders
    for (let i = 0; i < plan.take_profits.length; i++) {
      const tp = plan.take_profits[i]!;
      const tpPercentage = tp.percentage ?? tp.size_pct ?? 0;
      const tpQuantity = filledEntry.filledQuantity * (tpPercentage / 100);

      if (tpQuantity <= 0) continue;
      if (!this.checkOrderLimits()) break;

      const clientOrderId = `tc-bot-${plan.id.slice(0, 8)}-tp-${i}`;
      const tpType = tp.order_type ?? 'limit';
      try {
        const result = await this.broker.placeOrder({
          symbol: plan.symbol,
          side: exitSide as 'buy' | 'sell',
          type: tpType,
          quantity: tpQuantity,
          price: tp.price,
          clientOrderId,
          reduceOnly: true,
        });

        this.ordersPlacedLastHour++;
        this.ordersPlacedLastDay++;

        const tracked: TrackedOrder = {
          planId: plan.id,
          orderId: result.orderId,
          clientOrderId,
          type: 'take_profit',
          index: i,
          status: 'placed',
          price: tp.price,
          quantity: tpQuantity,
          filledQuantity: 0,
          avgFillPrice: 0,
          lastChecked: Date.now(),
        };

        state.tpOrders.push(tracked);
        this.emit('order:placed', tracked);
        await this.reportExecution(plan, 'tp_placed', tracked);
      } catch (err) {
        state.errorCount++;
        this.emit('order:error', plan.id, err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Stop-Loss Order
    if (plan.stop_loss_price !== null && !state.slOrder) {
      const slClientOrderId = `tc-bot-${plan.id.slice(0, 8)}-sl`;
      try {
        if (!this.checkOrderLimits()) return;

        const result = await this.broker.placeOrder({
          symbol: plan.symbol,
          side: exitSide as 'buy' | 'sell',
          type: 'stop',
          quantity: filledEntry.filledQuantity,
          stopPrice: plan.stop_loss_price,
          clientOrderId: slClientOrderId,
          reduceOnly: true,
        });

        this.ordersPlacedLastHour++;
        this.ordersPlacedLastDay++;

        state.slOrder = {
          planId: plan.id,
          orderId: result.orderId,
          clientOrderId: slClientOrderId,
          type: 'stop_loss',
          index: 0,
          status: 'placed',
          price: plan.stop_loss_price,
          quantity: filledEntry.filledQuantity,
          filledQuantity: 0,
          avgFillPrice: 0,
          lastChecked: Date.now(),
        };

        this.emit('order:placed', state.slOrder);
        await this.reportExecution(plan, 'sl_placed', state.slOrder);
      } catch (err) {
        state.errorCount++;
        this.emit('order:error', plan.id, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private checkPlanCompletion(state: PlanState): void {
    const allEntriesDone = state.entryOrders.every(
      o => o.status === 'filled' || o.status === 'cancelled'
    );
    if (!allEntriesDone) return;

    const allTpDone = state.tpOrders.every(
      o => o.status === 'filled' || o.status === 'cancelled'
    );
    const slDone = !state.slOrder || state.slOrder.status === 'filled' || state.slOrder.status === 'cancelled';

    // Plan ist abgeschlossen wenn alle TPs oder SL gefüllt sind
    if ((allTpDone || slDone) && (state.tpOrders.length > 0 || state.slOrder)) {
      const anyTpFilled = state.tpOrders.some(o => o.status === 'filled');
      const slFilled = state.slOrder?.status === 'filled';

      if (anyTpFilled || slFilled) {
        state.status = 'completed';
        this.emit('plan:completed', state.plan.id);
        this.planStates.delete(state.plan.id);
      }
    }
  }

  private checkOrderLimits(): boolean {
    return this.ordersPlacedLastHour < this.maxOrdersPerHour
      && this.ordersPlacedLastDay < this.maxOrdersPerDay;
  }

  /**
   * Schreibt einen Eintrag ins lokale Ausfuehrungsprotokoll.
   *
   * Bleibt bewusst asynchron, obwohl die Senke synchron ist: Die Aufrufer
   * warten ohnehin schon darauf, und ein spaeterer Wechsel auf eine
   * langsamere Senke soll die Aufrufstellen nicht anfassen muessen.
   */
  private async reportExecution(
    plan: TcPlan,
    action: ExecutionReport['action'],
    order: TrackedOrder
  ): Promise<void> {
    if (!this.journal) return;
    try {
      this.journal.record({
        plan_id: plan.id,
        action,
        order_id: order.orderId,
        entry_order_id: order.entryOrderId ?? null,
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'buy' : 'sell',
        price: order.price,
        quantity: order.quantity,
        filled_quantity: order.filledQuantity,
        avg_fill_price: order.avgFillPrice,
        broker: this.broker.name,
        broker_order_id: order.orderId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Ein misslungener Protokolleintrag darf den Handel nicht anhalten.
    }
  }
}
