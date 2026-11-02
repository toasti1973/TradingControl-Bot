// ============================================================
// Pruefung und Vereinheitlichung eingehender Signale
//
// Was durch den Webhook kommt, ist zunaechst nur Text von aussen. Hier
// wird daraus entweder ein Signal mit belastbaren Werten oder eine Liste
// von Beanstandungen — nichts dazwischen.
//
// Beim Lesen ist die Pruefung nachsichtig: Ein Indikator schreibt
// "BTCUSDT.P", "BTC/USDT:USDT" oder "BTCUSDT" fuer denselben Markt, und
// "buy" meint dasselbe wie "long". Bei den Werten ist sie es nicht: Ein
// Stop-Loss auf der falschen Seite des Einstiegs ist ein Fehler, kein
// Sonderfall.
// ============================================================

import { randomUUID } from 'node:crypto';
import { EntryStrategyCalculator, getTpPercentage } from '@tradingcontrol/core';
import type {
  ActivationCondition, Direction, EntryOrder, EntryZone, EntryStrategy,
  ExecutionMode, MarketType, StopLossType, TakeProfit,
} from '@tradingcontrol/core';
import type {
  RawSignalPayload, SignalAction, TradeSignal, ValidationResult,
} from './types.js';

export interface SchemaOptions {
  /** Referenzkapital, wenn das Signal keines nennt. */
  defaultReferenceCapital?: number;
  /** Boerse, wenn das Signal keine nennt. */
  defaultExchange?: string;
  /** Hoechstalter eines Signals in Sekunden. 0 schaltet die Pruefung ab. */
  maxAgeSeconds?: number;
  /** Jetzt-Zeitpunkt; nur fuer Tests von aussen gesetzt. */
  now?: () => number;
}

const BEKANNTE_FELDER = new Set([
  'version', 'signal_id', 'id', 'strategy', 'emitted_at', 'timestamp', 'time',
  'action', 'side', 'reference_capital', 'exchange', 'symbol', 'ticker',
  'asset_symbol', 'quote_currency', 'market_type', 'direction', 'leverage',
  'total_size', 'size', 'quantity', 'total_margin', 'margin',
  'entry_strategy', 'entry_orders', 'entries', 'entry_zones', 'zones',
  'execution_mode', 'take_profits', 'tps', 'stop_loss_price', 'stop_loss',
  'sl', 'stop_loss_type', 'trailing_stop_pct', 'trailing_stop_activation',
  'trailing_stop_size_pct', 'activation_conditions', 'target_plan_id',
  'plan_id', 'tag', 'notes', 'signature', 'nonce',
]);

export class SignalSchema {
  private readonly defaultReferenceCapital: number;
  private readonly defaultExchange: string | undefined;
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;
  private readonly calc = new EntryStrategyCalculator();

  constructor(options: SchemaOptions = {}) {
    this.defaultReferenceCapital = options.defaultReferenceCapital ?? 10_000;
    this.defaultExchange = options.defaultExchange;
    this.maxAgeSeconds = options.maxAgeSeconds ?? 300;
    this.now = options.now ?? (() => Date.now());
  }

  parse(raw: RawSignalPayload): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const action = this.leseAction(raw, errors);
    const symbol = this.leseSymbol(raw, errors);
    const signalId = this.leseText(raw, ['signal_id', 'id']) ?? randomUUID();
    const strategy = this.leseText(raw, ['strategy']) ?? 'unbenannt';
    const emittedAt = this.leseZeitpunkt(raw, errors, warnings);

    // Bei allem ausser `open` reichen Kennung, Symbol und Zielangabe —
    // ein Trigger traegt keine Positionsdaten mit sich.
    if (action !== 'open') {
      // `update` ist die Ausnahme: Es traegt genau eine Angabe, und
      // ohne sie hat es keinen Inhalt. Ein Update ohne Stop-Preis
      // wortlos durchzulassen hiesse, eine Absicht zu quittieren, die
      // nichts bewirkt — der Absender hielte den Stop danach fuer
      // verschoben.
      let stopLoss: number | null = null;
      if (action === 'update') {
        stopLoss = this.leseZahl(raw, ['stop_loss_price', 'sl_price', 'stop_loss', 'sl']) ?? null;
        if (stopLoss == null) {
          errors.push('update ohne stop_loss_price — es gaebe nichts zu aendern');
        } else if (stopLoss <= 0) {
          errors.push(`stop_loss_price muss groesser als 0 sein, war ${stopLoss}`);
        }
        // Ohne Zielangabe traefe das Update jeden laufenden Plan auf
        // diesem Symbol. Bei `close` ist das gewollt — "mach alles zu"
        // ist eindeutig. Ein Stop-Preis ist es nicht: Er gehoert zu
        // genau einer Position mit genau einem Einstand.
        if (!this.leseText(raw, ['target_plan_id', 'plan_id']) &&
            !this.leseText(raw, ['signal_id', 'id'])) {
          errors.push('update ohne target_plan_id oder signal_id — unklar, welcher Plan gemeint ist');
        }
      }

      if (errors.length > 0) return { valid: false, signal: null, errors, warnings };
      return {
        valid: true,
        errors,
        warnings,
        signal: this.leeresSignal({
          version: this.leseZahl(raw, ['version']) ?? 1,
          signal_id: signalId,
          strategy,
          emitted_at: emittedAt,
          action,
          symbol,
          exchange: this.leseText(raw, ['exchange']) ?? this.defaultExchange,
          target_plan_id: this.leseText(raw, ['target_plan_id', 'plan_id']) ?? null,
          stop_loss_price: stopLoss,
          tag: this.leseText(raw, ['tag']) ?? null,
          notes: this.leseText(raw, ['notes']) ?? null,
          extra: this.sammleUnbekannte(raw),
        }),
      };
    }

    const direction = this.leseDirection(raw, errors);
    const marketType = this.leseMarketType(raw, warnings);
    const leverage = this.leseLeverage(raw, marketType, errors, warnings);
    const quoteCurrency = this.leseText(raw, ['quote_currency'])?.toUpperCase()
      ?? this.rateQuoteWaehrung(symbol);

    const referenceCapital = this.leseZahl(raw, ['reference_capital'])
      ?? this.defaultReferenceCapital;
    if (referenceCapital <= 0) {
      errors.push('reference_capital muss groesser als 0 sein');
    }

    const zones = this.leseZonen(raw, errors);
    let entryOrders = this.leseEntryOrders(raw, errors);
    const totalSizeAngabe = this.leseZahl(raw, ['total_size', 'size', 'quantity']);

    // Ohne ausdrueckliche Einstiege werden sie aus den Zonen gerechnet —
    // dieselbe Rechnung, die auch das Journal anstellt.
    if (entryOrders.length === 0 && zones && zones.length > 0) {
      if (totalSizeAngabe == null || totalSizeAngabe <= 0) {
        errors.push('Zonen ohne total_size: Die Gesamtgroesse fehlt zur Aufteilung');
      } else {
        const pruefung = this.calc.validateZones(zones);
        if (!pruefung.valid) {
          errors.push(`Zonen nicht schluessig: ${pruefung.reason}`);
        } else {
          entryOrders = this.calc.calculateAllOrders(zones, totalSizeAngabe);
        }
      }
    }

    if (entryOrders.length === 0) {
      errors.push('Kein Einstieg angegeben — weder entry_orders noch entry_zones');
    }

    const summeEinstiege = entryOrders.reduce((s, o) => s + o.size, 0);
    const totalSize = totalSizeAngabe ?? summeEinstiege;
    if (totalSize <= 0) {
      errors.push('total_size muss groesser als 0 sein');
    } else if (summeEinstiege > 0 && Math.abs(summeEinstiege - totalSize) / totalSize > 0.02) {
      warnings.push(
        `Summe der Einstiege (${summeEinstiege}) weicht um mehr als 2 % von total_size (${totalSize}) ab — ` +
        `gerechnet wird mit der Summe der Einstiege`,
      );
    }

    const takeProfits = this.leseTakeProfits(raw, errors, warnings);
    const stopLossPrice = this.leseZahl(raw, ['stop_loss_price', 'stop_loss', 'sl']);
    const stopLossType = this.leseStopLossType(raw);

    if (stopLossPrice == null) {
      warnings.push(
        'Kein Stop-Loss im Signal — die Grenze fuer den Hoechstverlust je Trade ' +
        'kann nicht angewandt werden',
      );
    }

    // Lage der Preise zueinander. Ein Stop-Loss oberhalb des Einstiegs bei
    // einem Long ist kein Grenzfall, sondern ein Vorzeichenfehler.
    if (entryOrders.length > 0 && direction) {
      this.pruefePreislage(direction, entryOrders, stopLossPrice, takeProfits, errors);
    }

    const signal: TradeSignal = {
      version: this.leseZahl(raw, ['version']) ?? 1,
      signal_id: signalId,
      strategy,
      emitted_at: emittedAt,
      action: 'open',
      reference_capital: referenceCapital,
      exchange: this.leseText(raw, ['exchange']) ?? this.defaultExchange,
      symbol,
      asset_symbol: this.leseText(raw, ['asset_symbol']) ?? this.rateAssetSymbol(symbol, quoteCurrency),
      quote_currency: quoteCurrency,
      market_type: marketType,
      direction: direction ?? 'long',
      leverage,
      total_size: totalSize,
      total_margin: this.leseZahl(raw, ['total_margin', 'margin']) ?? null,
      entry_strategy: this.leseEntryStrategy(raw, zones),
      entry_orders: entryOrders,
      entry_zones: zones,
      execution_mode: this.leseExecutionMode(raw),
      take_profits: takeProfits,
      stop_loss_price: stopLossPrice ?? null,
      stop_loss_type: stopLossType,
      trailing_stop_pct: this.leseZahl(raw, ['trailing_stop_pct']) ?? null,
      trailing_stop_activation: this.leseZahl(raw, ['trailing_stop_activation']) ?? null,
      trailing_stop_size_pct: this.leseZahl(raw, ['trailing_stop_size_pct']) ?? null,
      activation_conditions: this.leseActivationConditions(raw),
      target_plan_id: this.leseText(raw, ['target_plan_id', 'plan_id']) ?? null,
      tag: this.leseText(raw, ['tag']) ?? null,
      notes: this.leseText(raw, ['notes']) ?? null,
      extra: this.sammleUnbekannte(raw),
    };

    if (stopLossType === 'trailing' && signal.trailing_stop_pct == null) {
      errors.push('stop_loss_type ist "trailing", aber trailing_stop_pct fehlt');
    }

    return {
      valid: errors.length === 0,
      signal: errors.length === 0 ? signal : null,
      errors,
      warnings,
    };
  }

  // ============================================================
  // Einzelne Felder
  // ============================================================

  private leseAction(raw: RawSignalPayload, errors: string[]): SignalAction {
    const wert = (this.leseText(raw, ['action']) ?? this.leseText(raw, ['side']) ?? 'open').toLowerCase();
    switch (wert) {
      case 'open': case 'buy': case 'sell': case 'long': case 'short': case 'entry':
        return 'open';
      case 'trigger': case 'signal': case 'confirm':
        return 'trigger';
      case 'close': case 'exit': case 'flat':
        return 'close';
      case 'cancel': case 'abort':
        return 'cancel';
      case 'update': case 'modify': case 'adjust': case 'sl_update':
        return 'update';
      default:
        errors.push(`Unbekannte action: "${wert}"`);
        return 'open';
    }
  }

  /**
   * Vereinheitlicht die Schreibweise des Marktes.
   *
   * TradingView schreibt Dauerkontrakte als "BTCUSDT.P", ccxt als
   * "BTC/USDT:USDT", die Boersen-API meist als "BTCUSDT". Gemeint ist
   * jedesmal derselbe Markt.
   */
  private leseSymbol(raw: RawSignalPayload, errors: string[]): string {
    const roh = this.leseText(raw, ['symbol', 'ticker']);
    if (!roh) {
      errors.push('symbol fehlt');
      return '';
    }
    // Reihenfolge entscheidet: Der Boersen-Vorsatz muss weg, bevor der
    // Settlement-Zusatz abgeschnitten wird — sonst bliebe von
    // "BYBIT:BTCUSDT" nur "BYBIT" uebrig.
    const bereinigt = roh
      .toUpperCase()
      .replace(/^[A-Z0-9]+:/, '')   // Boersen-Vorsatz wie "BYBIT:"
      .replace(/:.*$/, '')          // ccxt-Settlement-Zusatz
      .replace(/\.P$/, '')          // TradingView-Dauerkontrakt
      .replace(/[/\-_]/g, '');      // Trennzeichen
    if (bereinigt.length < 4) {
      errors.push(`symbol "${roh}" ergibt keinen gueltigen Markt`);
    }
    return bereinigt;
  }

  private leseDirection(raw: RawSignalPayload, errors: string[]): Direction | null {
    const wert = (this.leseText(raw, ['direction']) ?? this.leseText(raw, ['side']) ?? '').toLowerCase();
    if (wert === 'long' || wert === 'buy') return 'long';
    if (wert === 'short' || wert === 'sell') return 'short';
    errors.push('direction fehlt oder ist unbekannt (erwartet: long/short)');
    return null;
  }

  private leseMarketType(raw: RawSignalPayload, warnings: string[]): MarketType {
    const wert = (this.leseText(raw, ['market_type']) ?? '').toLowerCase();
    if (wert === 'spot') return 'spot';
    if (wert === 'futures' || wert === 'swap' || wert === 'perp' || wert === 'perpetual') return 'futures';
    if (wert !== '') warnings.push(`market_type "${wert}" unbekannt — es wird "futures" angenommen`);
    return 'futures';
  }

  private leseLeverage(
    raw: RawSignalPayload, marketType: MarketType, errors: string[], warnings: string[],
  ): number {
    const wert = this.leseZahl(raw, ['leverage']);
    if (wert == null) {
      if (marketType === 'futures') warnings.push('leverage fehlt — es wird 1 angenommen');
      return 1;
    }
    if (wert <= 0) {
      errors.push('leverage muss groesser als 0 sein');
      return 1;
    }
    if (marketType === 'spot' && wert !== 1) {
      warnings.push(`leverage ${wert} bei Spot-Handel — der Wert bleibt unveraendert, wirkt dort aber nicht`);
    }
    return wert;
  }

  private leseEntryStrategy(raw: RawSignalPayload, zones: EntryZone[] | null): EntryStrategy {
    const wert = (this.leseText(raw, ['entry_strategy']) ?? '').toLowerCase();
    const erlaubt: EntryStrategy[] = ['single', 'equal', 'ascending', 'descending', 'custom'];
    if (erlaubt.includes(wert as EntryStrategy)) return wert as EntryStrategy;
    if (zones && zones.length > 0) return zones[0]!.strategy ?? 'equal';
    return 'single';
  }

  private leseExecutionMode(raw: RawSignalPayload): ExecutionMode {
    const wert = (this.leseText(raw, ['execution_mode']) ?? '').toLowerCase();
    return wert === 'first_market_rest_limit' ? 'first_market_rest_limit' : 'all_limit';
  }

  private leseStopLossType(raw: RawSignalPayload): StopLossType {
    const wert = (this.leseText(raw, ['stop_loss_type']) ?? '').toLowerCase();
    return wert === 'trailing' ? 'trailing' : 'fixed';
  }

  private leseEntryOrders(raw: RawSignalPayload, errors: string[]): EntryOrder[] {
    const liste = this.leseListe(raw, ['entry_orders', 'entries']);
    if (!liste) return [];

    const ergebnis: EntryOrder[] = [];
    liste.forEach((eintrag, i) => {
      if (typeof eintrag !== 'object' || eintrag === null) {
        errors.push(`entry_orders[${i}] ist kein Objekt`);
        return;
      }
      const o = eintrag as Record<string, unknown>;
      const price = this.zuZahl(o.price);
      const size = this.zuZahl(o.size ?? o.quantity ?? o.amount);

      if (price == null || price <= 0) {
        errors.push(`entry_orders[${i}]: price fehlt oder ist nicht positiv`);
        return;
      }
      if (size == null || size <= 0) {
        errors.push(`entry_orders[${i}]: size fehlt oder ist nicht positiv`);
        return;
      }

      ergebnis.push({
        id: typeof o.id === 'string' ? o.id : randomUUID(),
        zone_id: typeof o.zone_id === 'string' ? o.zone_id : undefined,
        price,
        size,
        percentage: this.zuZahl(o.percentage) ?? undefined,
        order_type: o.order_type === 'market' ? 'market' : 'limit',
        status: 'pending',
        trigger: (o.trigger ?? null) as EntryOrder['trigger'],
      });
    });
    return ergebnis;
  }

  private leseZonen(raw: RawSignalPayload, errors: string[]): EntryZone[] | null {
    const liste = this.leseListe(raw, ['entry_zones', 'zones']);
    if (!liste || liste.length === 0) return null;

    const ergebnis: EntryZone[] = [];
    liste.forEach((eintrag, i) => {
      if (typeof eintrag !== 'object' || eintrag === null) {
        errors.push(`entry_zones[${i}] ist kein Objekt`);
        return;
      }
      const z = eintrag as Record<string, unknown>;
      const priceFrom = this.zuZahl(z.priceFrom ?? z.price_from);
      if (priceFrom == null || priceFrom <= 0) {
        errors.push(`entry_zones[${i}]: priceFrom fehlt oder ist nicht positiv`);
        return;
      }
      const priceTo = this.zuZahl(z.priceTo ?? z.price_to);
      const strategy = ((z.strategy as EntryStrategy) ?? 'equal');

      // Eine Zone laeuft von unten nach oben. Bei einem Long schreibt man
      // sie aber gern "von 50.000 herunter auf 49.000" — dieselbe Spanne,
      // verkehrt herum notiert.
      let von = priceFrom;
      let bis = priceTo;
      if (bis != null && bis < von) {
        if (strategy === 'equal' || strategy === 'single') {
          // Gleichmaessige Verteilung ist seitenverkehrt identisch.
          [von, bis] = [bis, von];
        } else {
          // Bei ansteigender oder absteigender Gewichtung nicht: Dort
          // haengt am Ende der Spanne mehr Geld als am Anfang. Ein
          // stillschweigendes Umdrehen verschoebe das Gewicht auf den
          // anderen Preis — ein anderer Trade.
          errors.push(
            `entry_zones[${i}]: priceFrom (${priceFrom}) liegt ueber priceTo (${priceTo}). ` +
            `Bei strategy "${strategy}" bestimmt die Reihenfolge die Gewichtung, ` +
            `deshalb wird nicht selbsttaetig getauscht — priceFrom muss der niedrigere Preis sein.`,
          );
          return;
        }
      }

      ergebnis.push({
        id: typeof z.id === 'string' && z.id ? z.id : randomUUID(),
        label: typeof z.label === 'string' ? z.label : undefined,
        priceFrom: von,
        priceTo: bis ?? undefined,
        strategy,
        steps: this.zuZahl(z.steps) ?? 1,
        percentageOfTotal: this.zuZahl(z.percentageOfTotal ?? z.percentage_of_total) ?? 100,
        customOrders: Array.isArray(z.customOrders) ? (z.customOrders as EntryOrder[]) : undefined,
        trigger: (z.trigger ?? null) as EntryZone['trigger'],
      });
    });
    return ergebnis.length > 0 ? ergebnis : null;
  }

  private leseTakeProfits(raw: RawSignalPayload, errors: string[], warnings: string[]): TakeProfit[] {
    const liste = this.leseListe(raw, ['take_profits', 'tps']);
    if (!liste) return [];

    const ergebnis: TakeProfit[] = [];
    liste.forEach((eintrag, i) => {
      if (typeof eintrag !== 'object' || eintrag === null) {
        errors.push(`take_profits[${i}] ist kein Objekt`);
        return;
      }
      const t = eintrag as Record<string, unknown>;
      const price = this.zuZahl(t.price);
      if (price == null || price <= 0) {
        errors.push(`take_profits[${i}]: price fehlt oder ist nicht positiv`);
        return;
      }
      ergebnis.push({
        price,
        percentage: this.zuZahl(t.percentage ?? t.size_pct) ?? undefined,
        size: this.zuZahl(t.size) ?? undefined,
        order_type: t.order_type === 'market' ? 'market' : 'limit',
        status: 'pending',
        sl_adjust: t.sl_adjust === true,
        sl_new_price: this.zuZahl(t.sl_new_price),
        activate_trailing: t.activate_trailing === true,
        trailing_pct: this.zuZahl(t.trailing_pct) ?? undefined,
        trigger: (t.trigger ?? null) as TakeProfit['trigger'],
      });
    });

    const summe = ergebnis.reduce((s, t) => s + getTpPercentage(t), 0);
    if (ergebnis.length > 0 && summe > 100.5) {
      errors.push(`Take-Profits schliessen zusammen ${summe} % der Position — mehr als vorhanden ist`);
    } else if (ergebnis.length > 0 && summe > 0 && summe < 99.5) {
      warnings.push(`Take-Profits schliessen zusammen nur ${summe} % — der Rest bleibt am Stop-Loss haengen`);
    }

    return ergebnis;
  }

  private leseActivationConditions(raw: RawSignalPayload): ActivationCondition[] {
    const liste = this.leseListe(raw, ['activation_conditions']);
    if (!liste) return [];
    const ergebnis: ActivationCondition[] = [];
    for (const eintrag of liste) {
      if (typeof eintrag === 'number') {
        ergebnis.push({ price: eintrag });
        continue;
      }
      if (typeof eintrag === 'object' && eintrag !== null) {
        const c = eintrag as Record<string, unknown>;
        const price = this.zuZahl(c.price);
        if (price != null) {
          ergebnis.push({ price });
        } else if (typeof c.type === 'string') {
          ergebnis.push({
            type: c.type as ActivationCondition['type'],
            value: this.zuZahl(c.value),
          });
        }
      }
    }
    return ergebnis;
  }

  /**
   * Haelt den Zeitpunkt fest und prueft das Alter.
   *
   * Ein altes Signal ist gefaehrlicher als gar keines: Der Markt, auf den
   * es sich bezieht, gibt es so nicht mehr. Deshalb wird das Alter als
   * Fehler behandelt, nicht als Hinweis.
   */
  private leseZeitpunkt(raw: RawSignalPayload, errors: string[], warnings: string[]): string {
    const roh = raw.emitted_at ?? raw.timestamp ?? raw.time;
    const jetzt = this.now();

    if (roh == null) {
      warnings.push('Kein Zeitstempel im Signal — es gilt als soeben entstanden');
      return new Date(jetzt).toISOString();
    }

    let ms: number | null = null;
    if (typeof roh === 'number') {
      // Sekunden oder Millisekunden — unterscheidbar an der Groessenordnung.
      ms = roh > 1e11 ? roh : roh * 1000;
    } else if (typeof roh === 'string') {
      const geparst = Date.parse(roh);
      if (!Number.isNaN(geparst)) ms = geparst;
    }

    if (ms == null) {
      warnings.push(`Zeitstempel "${String(roh)}" nicht lesbar — es gilt als soeben entstanden`);
      return new Date(jetzt).toISOString();
    }

    const alterSek = (jetzt - ms) / 1000;
    if (this.maxAgeSeconds > 0 && alterSek > this.maxAgeSeconds) {
      errors.push(
        `Signal ist ${Math.round(alterSek)} s alt (erlaubt: ${this.maxAgeSeconds} s) — ` +
        `der Markt dazu ist nicht mehr derselbe`,
      );
    }
    if (alterSek < -60) {
      warnings.push(`Zeitstempel liegt ${Math.round(-alterSek)} s in der Zukunft — Uhren gehen auseinander`);
    }

    return new Date(ms).toISOString();
  }

  /**
   * Liegen Stop-Loss und Take-Profits auf der richtigen Seite?
   *
   * Ein Long mit Stop ueber dem Einstieg wuerde sofort ausgeloest. Dass so
   * ein Signal durchrutscht und erst die Boerse es bemerkt, soll nicht
   * vorkommen.
   */
  private pruefePreislage(
    direction: Direction,
    entries: EntryOrder[],
    stopLoss: number | null,
    tps: TakeProfit[],
    errors: string[],
  ): void {
    const preise = entries.map(e => e.price);
    const hoechster = Math.max(...preise);
    const niedrigster = Math.min(...preise);

    if (stopLoss != null) {
      if (direction === 'long' && stopLoss >= niedrigster) {
        errors.push(
          `Long: Stop-Loss (${stopLoss}) liegt nicht unter dem niedrigsten Einstieg (${niedrigster})`,
        );
      }
      if (direction === 'short' && stopLoss <= hoechster) {
        errors.push(
          `Short: Stop-Loss (${stopLoss}) liegt nicht ueber dem hoechsten Einstieg (${hoechster})`,
        );
      }
    }

    for (const [i, tp] of tps.entries()) {
      if (direction === 'long' && tp.price <= hoechster) {
        errors.push(`Long: take_profits[${i}] (${tp.price}) liegt nicht ueber dem hoechsten Einstieg (${hoechster})`);
      }
      if (direction === 'short' && tp.price >= niedrigster) {
        errors.push(`Short: take_profits[${i}] (${tp.price}) liegt nicht unter dem niedrigsten Einstieg (${niedrigster})`);
      }
    }
  }

  // ============================================================
  // Kleinwerkzeug
  // ============================================================

  private leseText(raw: RawSignalPayload, namen: string[]): string | undefined {
    for (const name of namen) {
      const wert = raw[name];
      if (typeof wert === 'string' && wert.trim() !== '') return wert.trim();
    }
    return undefined;
  }

  private leseZahl(raw: RawSignalPayload, namen: string[]): number | null {
    for (const name of namen) {
      const zahl = this.zuZahl(raw[name]);
      if (zahl != null) return zahl;
    }
    return null;
  }

  private leseListe(raw: RawSignalPayload, namen: string[]): unknown[] | null {
    for (const name of namen) {
      if (Array.isArray(raw[name])) return raw[name] as unknown[];
    }
    return null;
  }

  /**
   * Zahl aus einem unbekannten Wert.
   *
   * TradingView schickt Zahlen haeufig als Text ("49500.5"), weil die
   * Platzhalter in der Alert-Nachricht Text einsetzen.
   */
  private zuZahl(wert: unknown): number | null {
    if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
    if (typeof wert === 'string') {
      const bereinigt = wert.trim().replace(/,/g, '');
      if (bereinigt === '') return null;
      const zahl = Number(bereinigt);
      return Number.isFinite(zahl) ? zahl : null;
    }
    return null;
  }

  private rateQuoteWaehrung(symbol: string): string {
    for (const kandidat of ['USDT', 'USDC', 'EUR', 'USD', 'BTC', 'ETH']) {
      if (symbol.endsWith(kandidat)) return kandidat;
    }
    return 'USDT';
  }

  private rateAssetSymbol(symbol: string, quote: string): string {
    return symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol;
  }

  private sammleUnbekannte(raw: RawSignalPayload): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    for (const [schluessel, wert] of Object.entries(raw)) {
      if (!BEKANNTE_FELDER.has(schluessel)) extra[schluessel] = wert;
    }
    return extra;
  }

  private leeresSignal(teil: Partial<TradeSignal> & {
    signal_id: string; strategy: string; emitted_at: string;
    action: SignalAction; symbol: string;
  }): TradeSignal {
    return {
      version: 1,
      reference_capital: this.defaultReferenceCapital,
      quote_currency: this.rateQuoteWaehrung(teil.symbol),
      market_type: 'futures',
      direction: 'long',
      leverage: 1,
      total_size: 0,
      total_margin: null,
      entry_strategy: 'single',
      entry_orders: [],
      entry_zones: null,
      execution_mode: 'all_limit',
      take_profits: [],
      stop_loss_price: null,
      stop_loss_type: 'fixed',
      trailing_stop_pct: null,
      trailing_stop_activation: null,
      trailing_stop_size_pct: null,
      activation_conditions: [],
      target_plan_id: null,
      tag: null,
      notes: null,
      extra: {},
      ...teil,
    };
  }
}
