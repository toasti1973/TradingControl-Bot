// ============================================================
// Boersen-Verzeichnis
//
// Welche Boersen der Bot ansprechen kann und was bei jeder zu beachten
// ist. Aufgebaut wie das Gegenstueck im Journal
// (backend/src/modules/exchange-sync/adapters/ccxt-exchange-configs.ts),
// aber auf das Handeln zugeschnitten statt auf das Nachtragen von
// Geschaeften: Hier zaehlen Marktarten, Hebel und Order-Eigenheiten, nicht
// die Extraktion des realisierten Ergebnisses.
//
// Der MiCA-Vermerk ist eine Handreichung, keine Rechtsauskunft. Die
// Zulassung einer Boerse kann sich aendern und gilt oft nur fuer eine
// bestimmte Konzerneinheit — massgeblich sind das ESMA-Register und die
// Liste der BaFin. Der Vermerk gehoert deshalb regelmaessig geprueft.
// ============================================================

/** Rechtsraum-Hinweis zur Zulassung nach der EU-Verordnung 2023/1114 (MiCA). */
export type MicaStatus =
  /** Zulassung als Anbieter von Kryptowerte-Dienstleistungen im EWR erteilt. */
  | 'zugelassen'
  /** Antrag laufend oder Uebergangsregelung — vor dem Einsatz pruefen. */
  | 'in_pruefung'
  /** Keine EWR-Zulassung bekannt. Handel auf eigenes Risiko. */
  | 'keine';

export interface ExchangeDefinition {
  /** Schluessel in der Konfiguration und im Feld `exchange` eines Plans. */
  id: string;
  /** Klasse in der ccxt-Bibliothek. */
  ccxtId: string;
  /** Anzeigename fuer die Oberflaeche. */
  label: string;
  mica: MicaStatus;
  /** Aufsicht, die die Zulassung erteilt hat — fuer die Nachpruefung. */
  micaAufsicht?: string;
  supportsSpot: boolean;
  supportsFutures: boolean;
  /**
   * Zusaetzliche ccxt-Optionen. Wichtig bei Boersen, die den EWR ueber eine
   * eigene Domain bedienen: Ein dort erzeugter Schluessel wird auf der
   * globalen Domain abgewiesen.
   */
  ccxtOptions?: Record<string, unknown>;
  /** Ausweich-Domains, falls der Schluessel auf der voreingestellten unbekannt ist. */
  alternateHostnames?: string[];
  /** Testumgebung vorhanden (ccxt `setSandboxMode`). */
  supportsSandbox: boolean;
  /** Anmerkung zur Boerse, wird in der Oberflaeche angezeigt. */
  hinweis?: string;
}

// ── Zugelassen im EWR ──────────────────────────────────────────────────────

const definitions: ExchangeDefinition[] = [
  {
    id: 'bitpanda',
    ccxtId: 'bitpanda',
    label: 'Bitpanda',
    mica: 'zugelassen',
    micaAufsicht: 'BaFin (DE) / FMA (AT)',
    supportsSpot: true,
    supportsFutures: false,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'spot' } },
    hinweis: 'Nur Kassahandel. Plaene mit Hebel laufen hier nicht.',
  },
  {
    id: 'kraken',
    ccxtId: 'kraken',
    label: 'Kraken',
    mica: 'zugelassen',
    micaAufsicht: 'Zentralbank Irland / CSSF Luxemburg',
    supportsSpot: true,
    supportsFutures: false,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'spot' } },
    hinweis: 'Termingeschaefte laufen ueber die eigene Einheit "krakenfutures".',
  },
  {
    id: 'krakenfutures',
    ccxtId: 'krakenfutures',
    label: 'Kraken Futures',
    mica: 'zugelassen',
    micaAufsicht: 'Zentralbank Irland / CSSF Luxemburg',
    supportsSpot: false,
    supportsFutures: true,
    supportsSandbox: true,
    ccxtOptions: { options: { defaultType: 'swap' } },
  },
  {
    id: 'coinbase',
    ccxtId: 'coinbase',
    label: 'Coinbase',
    mica: 'zugelassen',
    micaAufsicht: 'Zentralbank Irland',
    supportsSpot: true,
    supportsFutures: false,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'spot' } },
  },
  {
    id: 'bitstamp',
    ccxtId: 'bitstamp',
    label: 'Bitstamp',
    mica: 'zugelassen',
    micaAufsicht: 'CSSF Luxemburg',
    supportsSpot: true,
    supportsFutures: false,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'spot' } },
  },
  {
    id: 'okx',
    ccxtId: 'okx',
    label: 'OKX (Europa)',
    mica: 'zugelassen',
    micaAufsicht: 'MFSA Malta',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: true,
    // Kunden im EWR werden seit der Zulassung ueber die maltesische Einheit
    // gefuehrt, die eine eigene Domain betreibt. Ein dort erzeugter
    // Schluessel wird auf der globalen Domain mit Fehler 50119 abgewiesen.
    ccxtOptions: { hostname: 'eea.okx.com', options: { defaultType: 'swap' } },
    alternateHostnames: ['www.okx.com'],
  },
  {
    id: 'bybit',
    ccxtId: 'bybit',
    label: 'Bybit',
    mica: 'zugelassen',
    micaAufsicht: 'FSC Bulgarien / AFM Niederlande',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: true,
    ccxtOptions: { options: { defaultType: 'linear' } },
  },
  {
    id: 'cryptocom',
    ccxtId: 'cryptocom',
    label: 'Crypto.com',
    mica: 'zugelassen',
    micaAufsicht: 'MFSA Malta',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'swap' } },
  },

  // ── Zulassung noch offen ─────────────────────────────────────────────────

  {
    id: 'kucoin',
    ccxtId: 'kucoinfutures',
    label: 'KuCoin Futures',
    mica: 'in_pruefung',
    supportsSpot: false,
    supportsFutures: true,
    supportsSandbox: true,
    ccxtOptions: { options: { defaultType: 'swap' } },
    hinweis: 'Zulassungsantrag laufend. Vor dem Einsatz den aktuellen Stand pruefen.',
  },

  // ── Ohne EWR-Zulassung ───────────────────────────────────────────────────

  {
    id: 'phemex',
    ccxtId: 'phemex',
    label: 'Phemex',
    mica: 'keine',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: true,
    ccxtOptions: { options: { defaultType: 'swap' } },
    hinweis: 'Keine EWR-Zulassung bekannt. Handel auf eigenes Risiko.',
  },
  {
    id: 'binance',
    ccxtId: 'binance',
    label: 'Binance',
    mica: 'keine',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: true,
    ccxtOptions: { options: { defaultType: 'swap' } },
    hinweis: 'Keine EWR-Zulassung bekannt. Handel auf eigenes Risiko.',
  },
  {
    id: 'bingx',
    ccxtId: 'bingx',
    label: 'BingX',
    mica: 'keine',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'swap' } },
    hinweis: 'Keine EWR-Zulassung bekannt. Handel auf eigenes Risiko.',
  },
  {
    id: 'gateio',
    ccxtId: 'gate',
    label: 'Gate.io',
    mica: 'keine',
    supportsSpot: true,
    supportsFutures: true,
    supportsSandbox: false,
    ccxtOptions: { options: { defaultType: 'swap' } },
    hinweis: 'Keine EWR-Zulassung bekannt. Handel auf eigenes Risiko.',
  },
];

const byId = new Map(definitions.map(d => [d.id, d]));

/** Alle bekannten Boersen. */
export function listExchanges(): ExchangeDefinition[] {
  return [...definitions];
}

/** Nur die im EWR zugelassenen. */
export function listMicaExchanges(): ExchangeDefinition[] {
  return definitions.filter(d => d.mica === 'zugelassen');
}

export function getExchange(id: string): ExchangeDefinition | undefined {
  return byId.get(id.toLowerCase());
}

export function isMicaCompliant(id: string): boolean {
  return getExchange(id)?.mica === 'zugelassen';
}

/**
 * Kann diese Boerse den Plan ueberhaupt bedienen?
 *
 * Antwortet mit einem Grund statt nur mit ja/nein, damit die Oberflaeche
 * dem Nutzer sagen kann, woran es liegt — ein Hebel-Plan auf einer reinen
 * Kassa-Boerse scheitert sonst erst bei der Order.
 */
export function checkMarketSupport(
  exchangeId: string,
  marketType: 'spot' | 'futures',
): { ok: true } | { ok: false; grund: string } {
  const def = getExchange(exchangeId);
  if (!def) {
    return { ok: false, grund: `Boerse "${exchangeId}" ist dem Bot nicht bekannt.` };
  }
  if (marketType === 'futures' && !def.supportsFutures) {
    return { ok: false, grund: `${def.label} bietet keine Termingeschaefte.` };
  }
  if (marketType === 'spot' && !def.supportsSpot) {
    return { ok: false, grund: `${def.label} bietet keinen Kassahandel.` };
  }
  return { ok: true };
}
