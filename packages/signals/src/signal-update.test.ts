// ============================================================
// `update` — der Stop eines laufenden Plans
//
// Die einzige Absicht, die in einen Trade eingreift, der schon im
// Markt steht. Sie entstand aus einer konkreten Luecke: Ein Signal
// rechnet seinen Break-Even-Stop auf die GEPLANTE Einstiegsstaffel.
// Fuellt davon nur ein Teil, liegt er unter dem tatsaechlichen
// Einstand — und der Trade endet trotz Take-Profit im Minus.
//
// Mit dem Rueckkanal erfaehrt TC-Synaptrix den echten Einstand und
// kann nachsteuern.
// ============================================================

import { describe, it, expect } from 'vitest';
import { SignalSchema } from './signal-schema.js';

const schema = new SignalSchema({ defaultExchange: 'phemex', defaultReferenceCapital: 10_000 });

/** Ein brauchbares Update — Zielplan und neuer Stop. */
function update(zusatz: Record<string, unknown> = {}) {
  return {
    signal_id: 'mbcma-f23-11811710',
    strategy: 'MBCMA-f23',
    action: 'update',
    symbol: 'BNBUSDT',
    target_plan_id: 'plan-bnb',
    stop_loss_price: 739.96,
    ...zusatz,
  };
}

describe('Signal-Schema — action update', () => {
  it('erkennt update und seine Schreibweisen', () => {
    for (const wort of ['update', 'modify', 'adjust', 'sl_update', 'UPDATE']) {
      const ergebnis = schema.parse(update({ action: wort }));
      expect(ergebnis.valid, `action "${wort}"`).toBe(true);
      expect(ergebnis.signal?.action).toBe('update');
    }
  });

  it('nimmt den neuen Stop auf', () => {
    const ergebnis = schema.parse(update());
    expect(ergebnis.valid).toBe(true);
    expect(ergebnis.signal?.stop_loss_price).toBe(739.96);
    expect(ergebnis.signal?.target_plan_id).toBe('plan-bnb');
  });

  it('liest auch die kuerzeren Feldnamen', () => {
    for (const feld of ['sl_price', 'stop_loss', 'sl']) {
      const roh: Record<string, unknown> = update();
      delete roh.stop_loss_price;
      roh[feld] = 742.5;

      const ergebnis = schema.parse(roh);
      expect(ergebnis.valid, feld).toBe(true);
      expect(ergebnis.signal?.stop_loss_price, feld).toBe(742.5);
    }
  });

  // Ein Update ohne Stop-Preis wortlos durchzulassen hiesse, eine
  // Absicht zu quittieren, die nichts bewirkt. Der Absender hielte den
  // Stop danach fuer verschoben.
  it('weist ein update ohne Stop-Preis ab', () => {
    const roh: Record<string, unknown> = update();
    delete roh.stop_loss_price;

    const ergebnis = schema.parse(roh);
    expect(ergebnis.valid).toBe(false);
    expect(ergebnis.errors.join(' ')).toContain('stop_loss_price');
  });

  it('weist einen unsinnigen Stop-Preis ab', () => {
    for (const preis of [0, -1]) {
      const ergebnis = schema.parse(update({ stop_loss_price: preis }));
      expect(ergebnis.valid, String(preis)).toBe(false);
    }
  });

  // Bei `close` ist "alles auf diesem Symbol" eindeutig. Ein
  // Stop-Preis ist es nicht: Er gehoert zu genau einer Position mit
  // genau einem Einstand.
  it('verlangt eine Zielangabe', () => {
    const ergebnis = schema.parse({
      strategy: 'MBCMA-f23',
      action: 'update',
      symbol: 'BNBUSDT',
      stop_loss_price: 739.96,
    });

    expect(ergebnis.valid).toBe(false);
    expect(ergebnis.errors.join(' ')).toMatch(/target_plan_id|signal_id/);
  });

  it('laesst die signal_id als Zielangabe genuegen', () => {
    const roh: Record<string, unknown> = update();
    delete roh.target_plan_id;

    const ergebnis = schema.parse(roh);
    expect(ergebnis.valid).toBe(true);
    expect(ergebnis.signal?.signal_id).toBe('mbcma-f23-11811710');
  });

  // Ein Update traegt keine Positionsdaten. Wuerde es welche tragen,
  // liesse sich ein laufender Trade mitten im Lauf auf eine andere
  // Strategie umschreiben.
  it('bringt weder Groesse noch Ziele mit', () => {
    const ergebnis = schema.parse(update({
      total_size: 999,
      leverage: 50,
      take_profits: [{ price: 800, percentage: 100 }],
    }));

    expect(ergebnis.valid).toBe(true);
    expect(ergebnis.signal?.total_size).toBe(0);
    expect(ergebnis.signal?.leverage).toBe(1);
    expect(ergebnis.signal?.take_profits).toEqual([]);
  });

  it('laesst die anderen Absichten unveraendert', () => {
    expect(schema.parse({ action: 'close', symbol: 'BNBUSDT' }).signal?.action).toBe('close');
    expect(schema.parse({ action: 'cancel', symbol: 'BNBUSDT' }).signal?.action).toBe('cancel');
    expect(schema.parse({ action: 'trigger', symbol: 'BNBUSDT' }).signal?.action).toBe('trigger');

    // Und `close` braucht weiterhin keine Zielangabe.
    expect(schema.parse({ action: 'close', symbol: 'BNBUSDT' }).valid).toBe(true);
  });
});
