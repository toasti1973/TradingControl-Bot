// ============================================================
// Uebungskonto — Anbindung an die Datenbank
//
// Haelt genau ein Konto vor und sorgt dafuer, dass sein Stand einen
// Neustart ueberlebt. Die Rechnerei selbst steckt in `PaperAccount`
// (core) und kennt keine Datenbank; hier kommt die Dauerhaftigkeit
// dazu.
//
// Gespeichert wird nach JEDER Buchung, nicht beim Herunterfahren: Ein
// Absturz zwischen Trade und Speichern liesse den Bot sonst mit einem
// Kontostand weiterrechnen, den es nicht mehr gibt — und auf genau
// diesen Stand rechnet er die Groesse des naechsten Signals um.
// ============================================================

import { PaperAccount, PHEMEX_FUTURES_GEBUEHREN } from '@tradingcontrol/core';
import type { Buchung, FeeModel, KontoStand } from '@tradingcontrol/core';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Logger } from './log-service.js';

export class PaperAccountService {
  private readonly konto: PaperAccount;

  constructor(
    private readonly store: SqliteStore,
    private readonly logger: Logger,
    startkapital: number,
    private readonly waehrung: string = 'USDT',
  ) {
    const gespeichert = this.store.getPaperAccount(waehrung);

    const gebuehren: FeeModel = gespeichert
      ? { taker: gespeichert.taker_satz, maker: gespeichert.maker_satz }
      : PHEMEX_FUTURES_GEBUEHREN;

    this.konto = new PaperAccount(startkapital, waehrung, gebuehren);

    if (gespeichert) {
      const positionen = this.store.getPaperPositionen();
      this.konto.wiederherstellen({
        startkapital: gespeichert.startkapital,
        realisiert: gespeichert.realisiert,
        gebuehren: gespeichert.gebuehren,
        trades: gespeichert.trades,
        gewinne: gespeichert.gewinne,
        verluste: gespeichert.verluste,
        positionen,
      });
      this.logger.info({
        waehrung,
        equity: this.konto.stand().equity.toFixed(2),
        gebunden: this.konto.stand().gebunden.toFixed(2),
        offenePositionen: positionen.length,
        trades: gespeichert.trades,
      }, 'Uebungskonto fortgefuehrt');
    } else {
      this.speichern();
      this.logger.info({ waehrung, startkapital }, 'Uebungskonto angelegt');
    }

    // Jede Buchung wandert ins Kontoblatt, und der Stand wird sofort
    // festgeschrieben.
    this.konto.onBuchung((b: Buchung) => {
      try {
        // Buchung und Kontostand in einem Zug: Getrennt ausgefuehrt
        // koennte das Kontoblatt eine Zeile bekommen, die der
        // gespeicherte Stand nicht kennt — und nach dem naechsten
        // Neustart rechnete der Bot mit veraltetem Kapital weiter.
        const s = this.konto.stand();
        const g = this.konto.getGebuehren();
        this.store.schreibePaperBuchung(
          {
            art: b.art,
            betrag: b.betrag,
            waehrung: b.waehrung,
            symbol: b.symbol ?? null,
            menge: b.menge ?? null,
            preis: b.preis ?? null,
            notiz: b.notiz ?? null,
            zeitpunkt: b.zeitpunkt,
          },
          {
            waehrung: s.waehrung,
            startkapital: s.startkapital,
            realisiert: s.realisiert,
            gebuehren: s.gebuehren,
            trades: s.trades,
            gewinne: s.gewinne,
            verluste: s.verluste,
            taker_satz: g.taker,
            maker_satz: g.maker,
          },
          this.konto.offenePositionen(),
        );
      } catch (err) {
        // Ein misslungener Eintrag darf den Handel nicht anhalten, aber
        // er muss auffallen: Ab hier weicht der gespeicherte Stand vom
        // gerechneten ab, und nach einem Neustart rechnet der Bot mit
        // dem gespeicherten.
        this.logger.error(
          { err, buchung: b.art, betrag: b.betrag },
          'Buchung liess sich nicht speichern — gespeicherter Kontostand ist ab jetzt veraltet',
        );
      }
    });
  }

  /** Das Konto selbst — wird dem PaperBroker gereicht. */
  getKonto(): PaperAccount {
    return this.konto;
  }

  stand(): KontoStand {
    return this.konto.stand();
  }

  positionen(): ReturnType<PaperAccount['offenePositionen']> {
    return this.konto.offenePositionen();
  }

  buchungen(limit = 100, art?: string): Array<Record<string, unknown>> {
    return this.store.getPaperLedger(limit, art);
  }

  /**
   * Setzt das Konto auf ein neues Startkapital zurueck.
   *
   * Das Kontoblatt wird dabei geleert — ein Neuanfang soll einer sein,
   * und ein Blatt, dessen Summe nicht mehr zum Stand passt, waere
   * schlimmer als keins.
   */
  zuruecksetzen(startkapital: number): KontoStand {
    this.store.clearPaperLedger();
    this.konto.zuruecksetzen(startkapital);
    this.speichern();
    this.logger.warn({ startkapital, waehrung: this.waehrung }, 'Uebungskonto zurueckgesetzt');
    return this.konto.stand();
  }

  /** Ein- oder Auszahlung, ohne die Handelsgeschichte zu verwerfen. */
  einzahlen(betrag: number, notiz?: string): KontoStand {
    this.konto.einzahlen(betrag, notiz);
    this.speichern();
    return this.konto.stand();
  }

  setGebuehren(modell: FeeModel): void {
    this.konto.setGebuehren(modell);
    this.speichern();
    this.logger.info({
      taker: `${(modell.taker * 100).toFixed(4)} %`,
      maker: `${(modell.maker * 100).toFixed(4)} %`,
    }, 'Gebuehrensaetze des Uebungskontos geaendert');
  }

  getGebuehren(): FeeModel {
    return this.konto.getGebuehren();
  }

  private speichern(): void {
    const s = this.konto.stand();
    const g = this.konto.getGebuehren();
    this.store.upsertPaperAccount({
      waehrung: s.waehrung,
      startkapital: s.startkapital,
      realisiert: s.realisiert,
      gebuehren: s.gebuehren,
      trades: s.trades,
      gewinne: s.gewinne,
      verluste: s.verluste,
      taker_satz: g.taker,
      maker_satz: g.maker,
    });
    // Zusammen mit dem Stand, nicht getrennt davon: Beides gehoert zum
    // selben Zeitpunkt. Ein Stand ohne die zugehoerigen Positionen
    // ergaebe eine falsche gebundene Margin.
    this.store.setPaperPositionen(this.konto.offenePositionen());
  }
}
