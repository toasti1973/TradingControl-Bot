// ============================================================
// EntryStrategyCalculator — Wandelt Zonen + Strategien in flache entry_orders[]
// 1:1 kompatibel zu TradingControl frontend/components/common/TradePlanOverlay.tsx
// ============================================================

import { randomUUID } from 'node:crypto';
import type { EntryOrder, EntryZone, EntryStrategy, TriggerBlock } from '../types/plan.js';

export class EntryStrategyCalculator {

  /**
   * Berechnet Entry-Orders aus einer einzelnen Zone.
   * Strategien: single, equal, ascending, descending, custom
   */
  calculateZoneOrders(zone: EntryZone, totalSize: number): EntryOrder[] {
    const zoneSize = totalSize * (zone.percentageOfTotal / 100);

    if (zone.strategy === 'custom') {
      return (zone.customOrders ?? []).map(o => ({
        ...o,
        id: o.id ?? randomUUID(),
        zone_id: zone.id,
        trigger: o.trigger ?? zone.trigger ?? null,
      }));
    }

    if (zone.strategy === 'single' || !zone.priceTo || zone.steps <= 1) {
      return [{
        id: randomUUID(),
        zone_id: zone.id,
        price: zone.priceFrom,
        percentage: zone.percentageOfTotal,
        size: zoneSize,
        order_type: 'limit',
        status: 'pending',
        trigger: zone.trigger ?? null,
      }];
    }

    const steps = zone.steps;
    const priceFrom = zone.priceFrom;
    const priceTo = zone.priceTo;

    // Preise gleichmaessig verteilen
    const prices: number[] = [];
    if (steps === 1) {
      prices.push(priceFrom);
    } else {
      const step = (priceTo - priceFrom) / (steps - 1);
      for (let i = 0; i < steps; i++) {
        prices.push(priceFrom + step * i);
      }
    }

    // Gewichte je Strategie
    const weights = this.calculateWeights(zone.strategy, steps);

    return prices.map((price, i) => {
      const weight = weights[i] ?? 1 / steps;
      const orderSize = zoneSize * weight;
      const orderPct = zone.percentageOfTotal * weight;
      return {
        id: randomUUID(),
        zone_id: zone.id,
        price: this.roundPrice(price, priceFrom),
        percentage: Math.round(orderPct * 10000) / 10000,
        size: this.roundSize(orderSize),
        order_type: 'limit' as const,
        status: 'pending' as const,
        trigger: zone.trigger ?? null,
      };
    });
  }

  /**
   * Berechnet alle Entry-Orders aus mehreren Zonen.
   * Total-Percentage muss 100% ergeben (mit kleiner Toleranz).
   */
  calculateAllOrders(zones: EntryZone[], totalSize: number): EntryOrder[] {
    if (!zones || zones.length === 0) return [];
    const all: EntryOrder[] = [];
    for (const zone of zones) {
      if (zone.percentageOfTotal <= 0) continue;
      all.push(...this.calculateZoneOrders(zone, totalSize));
    }
    return all;
  }

  /**
   * Validierung: Summe aller Zonen-Prozente muss ca. 100% sein.
   */
  validateZones(zones: EntryZone[]): { valid: boolean; reason?: string } {
    if (!zones || zones.length === 0) return { valid: false, reason: 'Keine Zonen' };
    if (zones.length > 10) return { valid: false, reason: 'Max 10 Zonen erlaubt' };

    const sum = zones.reduce((s, z) => s + (z.percentageOfTotal ?? 0), 0);
    if (Math.abs(sum - 100) > 0.5) {
      return { valid: false, reason: `Zonen-Summe ${sum}% (erwartet 100%)` };
    }

    for (const zone of zones) {
      if (zone.priceFrom <= 0) return { valid: false, reason: `Zone ${zone.label ?? zone.id} hat ungueltigen priceFrom` };
      if (zone.priceTo !== undefined && zone.priceTo < zone.priceFrom) {
        return { valid: false, reason: `Zone ${zone.label ?? zone.id}: priceTo < priceFrom` };
      }
      if (zone.strategy !== 'single' && zone.steps < 1) {
        return { valid: false, reason: `Zone ${zone.label ?? zone.id}: steps < 1` };
      }
    }

    return { valid: true };
  }

  /**
   * Stellt sicher, dass alle EntryOrders + EntryZones eine UUID haben.
   * (TC Migration 077: Entry-Order-IDs muessen persistent sein)
   */
  ensureIds(orders: EntryOrder[], zones?: EntryZone[]): { orders: EntryOrder[]; zones?: EntryZone[] } {
    const newOrders = orders.map(o => ({ ...o, id: o.id ?? randomUUID() }));
    const newZones = zones?.map(z => ({ ...z, id: z.id || randomUUID() }));
    return { orders: newOrders, zones: newZones };
  }

  /**
   * Kopiert Zone-Trigger auf alle Orders der Zone (TC: expandZoneTriggersToOrders).
   */
  expandZoneTriggers(orders: EntryOrder[], zones?: EntryZone[]): EntryOrder[] {
    if (!zones || zones.length === 0) return orders;

    const triggerByZone = new Map<string, TriggerBlock | null>();
    for (const z of zones) {
      triggerByZone.set(z.id, z.trigger ?? null);
    }

    return orders.map(o => {
      if (o.trigger) return o; // bereits gesetzt — nicht ueberschreiben
      if (o.zone_id && triggerByZone.has(o.zone_id)) {
        return { ...o, trigger: triggerByZone.get(o.zone_id) };
      }
      return o;
    });
  }

  // ============================================================
  // Hilfsfunktionen
  // ============================================================

  private calculateWeights(strategy: EntryStrategy, steps: number): number[] {
    if (steps <= 0) return [];

    switch (strategy) {
      case 'equal':
        return Array(steps).fill(1 / steps);

      case 'ascending': {
        // Mehr Gewicht bei hoeheren Preisen (Pyramiding up)
        // weights[i] = 2 * (i + 1) / (steps * (steps + 1))
        const weights: number[] = [];
        const denominator = steps * (steps + 1);
        for (let i = 0; i < steps; i++) {
          weights.push(2 * (i + 1) / denominator);
        }
        return weights;
      }

      case 'descending': {
        // Mehr Gewicht bei niedrigeren Preisen (Averaging down)
        // weights[i] = 2 * (steps - i) / (steps * (steps + 1))
        const weights: number[] = [];
        const denominator = steps * (steps + 1);
        for (let i = 0; i < steps; i++) {
          weights.push(2 * (steps - i) / denominator);
        }
        return weights;
      }

      case 'single':
      case 'custom':
      default:
        return Array(steps).fill(1 / steps);
    }
  }

  private roundPrice(price: number, refPrice: number): number {
    // Heuristik: bei hohem Preis grobere Tickgroesse
    if (refPrice >= 10_000) return Math.round(price * 10) / 10;
    if (refPrice >= 1_000) return Math.round(price * 100) / 100;
    if (refPrice >= 100) return Math.round(price * 1000) / 1000;
    if (refPrice >= 1) return Math.round(price * 100000) / 100000;
    return Math.round(price * 100000000) / 100000000;
  }

  private roundSize(size: number): number {
    return Math.round(size * 100000000) / 100000000;
  }
}
