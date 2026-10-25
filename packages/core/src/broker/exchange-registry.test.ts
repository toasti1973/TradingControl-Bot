import { describe, it, expect } from 'vitest';
import {
  listExchanges,
  listMicaExchanges,
  getExchange,
  isMicaCompliant,
  checkMarketSupport,
} from './exchange-registry.js';

describe('Boersen-Verzeichnis', () => {
  it('fuehrt jede Boerse nur einmal', () => {
    const ids = listExchanges().map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nennt zu jeder zugelassenen Boerse die Aufsicht', () => {
    // Ohne die Aufsichtsbehoerde laesst sich der Vermerk nicht nachpruefen —
    // und ein unpruefbarer Zulassungsvermerk ist wertlos.
    for (const boerse of listMicaExchanges()) {
      expect(boerse.micaAufsicht, `${boerse.id} nennt keine Aufsicht`).toBeTruthy();
    }
  });

  it('gibt als zugelassen nur aus, was auch so vermerkt ist', () => {
    for (const boerse of listExchanges()) {
      expect(isMicaCompliant(boerse.id)).toBe(boerse.mica === 'zugelassen');
    }
  });

  it('kennt Phemex, fuehrt es aber nicht als zugelassen', () => {
    // Bis zum Umbau war Phemex der einzige Live-Zugang des Bots.
    expect(getExchange('phemex')).toBeDefined();
    expect(isMicaCompliant('phemex')).toBe(false);
  });

  it('findet Boersen unabhaengig von der Gross-/Kleinschreibung', () => {
    expect(getExchange('KRAKEN')?.id).toBe('kraken');
    expect(isMicaCompliant('Kraken')).toBe(true);
  });

  it('gibt jeder Boerse mindestens eine Marktart', () => {
    for (const boerse of listExchanges()) {
      expect(
        boerse.supportsSpot || boerse.supportsFutures,
        `${boerse.id} bedient weder Kasse noch Termin`,
      ).toBe(true);
    }
  });
});

describe('checkMarketSupport', () => {
  it('lehnt Termingeschaefte auf einer reinen Kassa-Boerse mit Begruendung ab', () => {
    const ergebnis = checkMarketSupport('bitpanda', 'futures');
    expect(ergebnis.ok).toBe(false);
    if (!ergebnis.ok) {
      expect(ergebnis.grund).toContain('Bitpanda');
    }
  });

  it('laesst Kassahandel auf einer Kassa-Boerse zu', () => {
    expect(checkMarketSupport('bitpanda', 'spot')).toEqual({ ok: true });
  });

  it('meldet eine unbekannte Boerse, statt sie stillschweigend zuzulassen', () => {
    const ergebnis = checkMarketSupport('gibtesnicht', 'spot');
    expect(ergebnis.ok).toBe(false);
  });

  it('laesst beide Marktarten zu, wo die Boerse beide bedient', () => {
    expect(checkMarketSupport('okx', 'futures')).toEqual({ ok: true });
    expect(checkMarketSupport('okx', 'spot')).toEqual({ ok: true });
  });
});
