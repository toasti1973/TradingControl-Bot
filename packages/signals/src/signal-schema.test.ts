import { describe, it, expect } from 'vitest';
import { SignalSchema } from './signal-schema.js';
import { SignalAuthenticator } from './authentication.js';

const JETZT = Date.parse('2026-10-24T08:00:00.000Z');

function schema(optionen: Partial<ConstructorParameters<typeof SignalSchema>[0]> = {}) {
  return new SignalSchema({ now: () => JETZT, ...optionen });
}

/** Ein vollstaendiges, fehlerfreies Signal. */
function payload(aenderungen: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal_id: 'ind-btc-001',
    strategy: 'MeinIndikator',
    emitted_at: '2026-10-24T07:59:30.000Z',
    action: 'open',
    reference_capital: 10_000,
    exchange: 'bybit',
    symbol: 'BTCUSDT',
    market_type: 'futures',
    direction: 'long',
    leverage: 10,
    total_size: 0.1,
    total_margin: 500,
    entry_orders: [{ price: 50_000, size: 0.1 }],
    take_profits: [{ price: 52_000, percentage: 100 }],
    stop_loss_price: 48_000,
    ...aenderungen,
  };
}

describe('SignalSchema — gueltige Signale', () => {
  it('liest ein vollstaendiges Signal', () => {
    const r = schema().parse(payload());

    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.signal!.symbol).toBe('BTCUSDT');
    expect(r.signal!.direction).toBe('long');
    expect(r.signal!.leverage).toBe(10);
    expect(r.signal!.reference_capital).toBe(10_000);
    expect(r.signal!.asset_symbol).toBe('BTC');
    expect(r.signal!.quote_currency).toBe('USDT');
  });

  it('nimmt Zahlen auch als Text an — TradingView setzt Platzhalter ein', () => {
    const r = schema().parse(payload({
      leverage: '10',
      total_size: '0.1',
      stop_loss_price: '48000',
      entry_orders: [{ price: '50000', size: '0.1' }],
    }));

    expect(r.valid).toBe(true);
    expect(r.signal!.leverage).toBe(10);
    expect(r.signal!.total_size).toBe(0.1);
    expect(r.signal!.stop_loss_price).toBe(48_000);
    expect(r.signal!.entry_orders[0]!.price).toBe(50_000);
  });

  it.each([
    ['BTCUSDT.P', 'BTCUSDT'],
    ['BTC/USDT', 'BTCUSDT'],
    ['BTC/USDT:USDT', 'BTCUSDT'],
    ['BYBIT:BTCUSDT', 'BTCUSDT'],
    ['btcusdt', 'BTCUSDT'],
    ['BTC-USDT', 'BTCUSDT'],
  ])('vereinheitlicht das Symbol %s zu %s', (eingabe, erwartet) => {
    const r = schema().parse(payload({ symbol: eingabe }));
    expect(r.signal!.symbol).toBe(erwartet);
  });

  it.each([
    ['long', 'long'], ['buy', 'long'], ['LONG', 'long'],
    ['short', 'short'], ['sell', 'short'],
  ])('liest die Richtung %s als %s', (eingabe, erwartet) => {
    const angepasst = erwartet === 'short'
      ? payload({ direction: eingabe, stop_loss_price: 52_000, take_profits: [{ price: 48_000, percentage: 100 }] })
      : payload({ direction: eingabe });
    const r = schema().parse(angepasst);
    expect(r.signal!.direction).toBe(erwartet);
  });

  it('rechnet Einstiege aus Zonen, wenn keine aufgezaehlt sind', () => {
    const r = schema().parse(payload({
      entry_orders: undefined,
      total_size: 0.3,
      entry_zones: [
        { priceFrom: 49_000, priceTo: 50_000, strategy: 'equal', steps: 3, percentageOfTotal: 100 },
      ],
    }));

    expect(r.valid).toBe(true);
    expect(r.signal!.entry_orders).toHaveLength(3);
    const summe = r.signal!.entry_orders.reduce((s, e) => s + e.size, 0);
    expect(summe).toBeCloseTo(0.3, 6);
  });

  it('dreht eine verkehrt herum notierte Zone bei gleichmaessiger Verteilung um', () => {
    const r = schema().parse(payload({
      entry_orders: undefined,
      total_size: 0.3,
      entry_zones: [
        // "von 50.000 herunter auf 49.000" — dieselbe Spanne, andere Schreibweise
        { priceFrom: 50_000, priceTo: 49_000, strategy: 'equal', steps: 3, percentageOfTotal: 100 },
      ],
    }));

    expect(r.valid).toBe(true);
    expect(r.signal!.entry_zones![0]!.priceFrom).toBe(49_000);
    expect(r.signal!.entry_zones![0]!.priceTo).toBe(50_000);
  });

  it('dreht sie NICHT um, wenn die Reihenfolge die Gewichtung bestimmt', () => {
    const r = schema().parse(payload({
      entry_orders: undefined,
      total_size: 0.3,
      entry_zones: [
        { priceFrom: 50_000, priceTo: 49_000, strategy: 'descending', steps: 3, percentageOfTotal: 100 },
      ],
    }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Gewichtung');
  });

  it('nimmt ein Trigger-Signal ohne Positionsdaten an', () => {
    const r = schema().parse({
      signal_id: 'trig-1',
      strategy: 'MeinIndikator',
      action: 'trigger',
      symbol: 'BTCUSDT',
      tag: 'ausbruch-bestaetigt',
      emitted_at: '2026-10-24T07:59:30.000Z',
    });

    expect(r.valid).toBe(true);
    expect(r.signal!.action).toBe('trigger');
    expect(r.signal!.tag).toBe('ausbruch-bestaetigt');
  });

  it('bewahrt unbekannte Felder auf', () => {
    const r = schema().parse(payload({ rsi_wert: 28.4, kommentar: 'ueberverkauft' }));
    expect(r.signal!.extra).toEqual({ rsi_wert: 28.4, kommentar: 'ueberverkauft' });
  });
});

describe('SignalSchema — was zurueckgewiesen wird', () => {
  it('weist einen Long mit Stop ueber dem Einstieg zurueck', () => {
    const r = schema().parse(payload({ stop_loss_price: 51_000 }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Stop-Loss');
  });

  it('weist einen Short mit Stop unter dem Einstieg zurueck', () => {
    const r = schema().parse(payload({
      direction: 'short',
      stop_loss_price: 49_000,
      take_profits: [{ price: 48_000, percentage: 100 }],
    }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Stop-Loss');
  });

  it('weist einen Take-Profit auf der falschen Seite zurueck', () => {
    const r = schema().parse(payload({ take_profits: [{ price: 47_000, percentage: 100 }] }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('take_profits[0]');
  });

  it('weist ein zu altes Signal zurueck', () => {
    const r = schema({ maxAgeSeconds: 300 }).parse(payload({
      emitted_at: '2026-10-24T07:50:00.000Z',   // 10 Minuten alt
    }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('alt');
  });

  it('weist Take-Profits zurueck, die zusammen mehr als 100 % schliessen', () => {
    const r = schema().parse(payload({
      take_profits: [
        { price: 52_000, percentage: 60 },
        { price: 55_000, percentage: 60 },
      ],
    }));

    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('mehr als vorhanden');
  });

  it('weist ein Signal ohne Einstieg zurueck', () => {
    const r = schema().parse(payload({ entry_orders: [], entry_zones: undefined }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('Einstieg');
  });

  it('weist eine fehlende Richtung zurueck', () => {
    const r = schema().parse(payload({ direction: undefined, action: 'open' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('direction');
  });

  it('weist trailing ohne Prozentangabe zurueck', () => {
    const r = schema().parse(payload({ stop_loss_type: 'trailing' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('trailing_stop_pct');
  });

  it('weist einen negativen Hebel zurueck', () => {
    const r = schema().parse(payload({ leverage: -5 }));
    expect(r.valid).toBe(false);
  });
});

describe('SignalSchema — Hinweise ohne Ablehnung', () => {
  it('merkt einen fehlenden Stop-Loss an', () => {
    const r = schema().parse(payload({ stop_loss_price: undefined }));
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toContain('Stop-Loss');
  });

  it('merkt an, wenn die Take-Profits die Position nicht ganz schliessen', () => {
    const r = schema().parse(payload({ take_profits: [{ price: 52_000, percentage: 60 }] }));
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toContain('Rest');
  });

  it('merkt an, wenn die Summe der Einstiege von total_size abweicht', () => {
    const r = schema().parse(payload({
      total_size: 0.2,
      entry_orders: [{ price: 50_000, size: 0.1 }],
    }));
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toContain('weicht');
  });

  it('nimmt das Referenzkapital aus der Voreinstellung, wenn es fehlt', () => {
    const r = schema({ defaultReferenceCapital: 10_000 })
      .parse(payload({ reference_capital: undefined }));
    expect(r.signal!.reference_capital).toBe(10_000);
  });
});

describe('SignalAuthenticator', () => {
  const geheimnis = 'ein-langes-geheimnis-fuer-den-webhook';

  it('nimmt das richtige Geheimnis aus dem Pfad an', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis });
    const r = auth.pruefeHerkunft({ geheimnisAusPfad: geheimnis, roherRumpf: '{}' });
    expect(r.ok).toBe(true);
  });

  it('weist ein falsches Geheimnis ab', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis });
    const r = auth.pruefeHerkunft({ geheimnisAusPfad: 'falsch', roherRumpf: '{}' });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('geheimnis_falsch');
  });

  it('weist alles ab, solange kein Geheimnis hinterlegt ist', () => {
    const auth = new SignalAuthenticator({ secret: '' });
    const r = auth.pruefeHerkunft({ geheimnisAusPfad: '', roherRumpf: '{}' });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('kein_geheimnis');
  });

  it('prueft die HMAC-Signatur ueber den unveraenderten Rumpf', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis, requireSignature: true });
    const rumpf = '{"signal_id":"a","symbol":"BTCUSDT"}';
    const signatur = auth.bildeSignatur(rumpf);

    expect(auth.pruefeHerkunft({ signatur, roherRumpf: rumpf }).ok).toBe(true);
    expect(auth.pruefeHerkunft({ signatur: `sha256=${signatur}`, roherRumpf: rumpf }).ok).toBe(true);
    // Ein einziges geaendertes Zeichen reicht
    expect(auth.pruefeHerkunft({ signatur, roherRumpf: rumpf.replace('BTC', 'ETH') }).ok).toBe(false);
  });

  it('verlangt die Signatur, wenn sie gefordert ist — das Geheimnis allein genuegt dann nicht', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis, requireSignature: true });
    const r = auth.pruefeHerkunft({ geheimnisAusPfad: geheimnis, roherRumpf: '{}' });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('signatur_fehlt');
  });

  it('laesst dieselbe Kennung kein zweites Mal durch', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis });

    expect(auth.pruefeWiedereinspielung('sig-1').ok).toBe(true);
    auth.merkeVor('sig-1');
    const zweiter = auth.pruefeWiedereinspielung('sig-1');

    expect(zweiter.ok).toBe(false);
    expect(zweiter.failure).toBe('bereits_gesehen');
  });

  it('uebernimmt bekannte Kennungen nach einem Neustart', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis });
    auth.ladeBekannte([{ signalId: 'sig-alt', empfangenMs: Date.now() - 1000 }]);
    expect(auth.pruefeWiedereinspielung('sig-alt').ok).toBe(false);
  });

  it('vergisst Kennungen nach Ablauf des Zeitfensters', () => {
    const auth = new SignalAuthenticator({ secret: geheimnis, replayWindowMs: 1000 });
    auth.ladeBekannte([{ signalId: 'sig-uralt', empfangenMs: Date.now() - 60_000 }]);
    expect(auth.pruefeWiedereinspielung('sig-uralt').ok).toBe(true);
  });
});
