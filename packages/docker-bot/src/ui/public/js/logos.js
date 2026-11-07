// ============================================================
// Logos für Börsen und Assets
//
// Alles inline. Die Seite läuft unter `script-src 'self'`, und ein
// Abruf von einem Logo-Dienst scheiterte daran — er wäre außerdem
// eine Abhängigkeit, die den Bot von einer fremden Erreichbarkeit
// abhängig machte.
//
// ## Zwei Stufen bei den Assets
//
// Börsen sind eine feste, kleine Menge — die bekommen echte Zeichen.
// Assets wachsen mit jedem neuen Markt, und ein fehlendes Logo darf
// keine leere Stelle hinterlassen. Deshalb erzeugt `assetLogo()` für
// Unbekanntes ein Monogramm: die ersten Zeichen des Symbols auf einem
// Kreis, dessen Farbe aus dem Namen abgeleitet wird. Gleicher Name,
// gleiche Farbe — auch über Neuladen hinweg.
//
// Eigener Namensraum (`logo…`, `asset…`, `boerse…`): Am 27.10.2026
// kollidierte `kachel()` aus zwei Dateien, und die Oberfläche zeigte
// HTML als Text an (siehe namensraum.test.ts).
// ============================================================

/** Farbe und Kurzzeichen je Börse. */
var LOGO_BOERSEN = {
  phemex:   { farbe: '#00c9a7', kurz: 'PX', voll: 'Phemex' },
  bybit:    { farbe: '#f7a600', kurz: 'BY', voll: 'Bybit' },
  binance:  { farbe: '#f0b90b', kurz: 'BN', voll: 'Binance' },
  okx:      { farbe: '#c0c0c8', kurz: 'OK', voll: 'OKX' },
  kraken:   { farbe: '#7132f5', kurz: 'KR', voll: 'Kraken' },
  kucoin:   { farbe: '#24ae8f', kurz: 'KU', voll: 'KuCoin' },
  bitget:   { farbe: '#00f0ff', kurz: 'BG', voll: 'Bitget' },
  coinbase: { farbe: '#0052ff', kurz: 'CB', voll: 'Coinbase' },
  // Der Übungsbroker ist keine Börse — er bekommt bewusst ein
  // graues, unauffälliges Zeichen. Wer die Liste überfliegt, soll
  // Übung und Echthandel auseinanderhalten können.
  paper:    { farbe: '#6b7280', kurz: 'Ü', voll: 'Übung' },
};

/** Farben für Assets, die häufig vorkommen. */
var LOGO_ASSETS = {
  BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195', BNB: '#f0b90b',
  XRP: '#23292f', ADA: '#0033ad', DOGE: '#c2a633', AVAX: '#e84142',
  DOT: '#e6007a', LINK: '#2a5ada', MATIC: '#8247e5', LTC: '#bfbbbb',
  HYPE: '#97fce4', HBAR: '#000000', ATOM: '#2e3148', NEAR: '#00ec97',
  SUI: '#4da2ff', APT: '#06f3bf', ARB: '#213147', OP: '#ff0420',
  TRX: '#ff060a', TON: '#0098ea', SHIB: '#ffa409', UNI: '#ff007a',
};

/** Maskiert, was in die Seite geschrieben wird. */
function logoEsc(wert) {
  return String(wert == null ? '' : wert).replace(/[&<>"']/g, function (z) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z];
  });
}

/**
 * Eine Farbe aus einem Namen.
 *
 * Damit bekommt auch ein unbekanntes Asset etwas Eigenes, und zwar
 * dauerhaft dasselbe. Der Farbton kommt aus einer einfachen
 * Quersumme; Sättigung und Helligkeit bleiben fest, damit nichts
 * entsteht, was auf dunklem Grund nicht lesbar wäre.
 */
function logoFarbeAus(name) {
  var summe = 0;
  for (var i = 0; i < name.length; i++) summe = (summe * 31 + name.charCodeAt(i)) % 360;
  return 'hsl(' + summe + ', 55%, 52%)';
}

/** Das Asset aus einem Handelspaar: BTCUSDT → BTC. */
function assetAusSymbol(symbol) {
  var s = String(symbol || '').toUpperCase();
  var quotes = ['USDT', 'USDC', 'BUSD', 'EUR', 'USD', 'BTC', 'ETH', 'DAI'];
  for (var i = 0; i < quotes.length; i++) {
    if (s.length > quotes[i].length && s.endsWith(quotes[i])) {
      return s.slice(0, -quotes[i].length);
    }
  }
  return s;
}

/**
 * Das Zeichen einer Börse.
 *
 * `groesse` in Pixeln. Unbekannte Börsen bekommen ein Monogramm aus
 * den ersten zwei Buchstaben — eine leere Stelle wäre schlechter als
 * ein schlichtes Zeichen.
 */
function boerseLogo(id, groesse) {
  var g = groesse || 18;
  var name = String(id || '').trim().toLowerCase();
  var b = LOGO_BOERSEN[name];
  var farbe = b ? b.farbe : logoFarbeAus(name);
  var kurz = b ? b.kurz : name.slice(0, 2).toUpperCase();
  var titel = b ? b.voll : (name || 'unbekannt');

  return '<span class="logo-kreis" title="' + logoEsc(titel) + '" style="' +
    'width:' + g + 'px;height:' + g + 'px;background:' + farbe + ';' +
    'font-size:' + Math.round(g * 0.44) + 'px">' + logoEsc(kurz) + '</span>';
}

/** Das Zeichen eines Assets, aus dem Handelspaar abgeleitet. */
function assetLogo(symbol, groesse) {
  var g = groesse || 18;
  var asset = assetAusSymbol(symbol);
  var farbe = LOGO_ASSETS[asset] || logoFarbeAus(asset);

  // Drei Zeichen passen bei dieser Größe gerade noch; alles darüber
  // würde überlaufen.
  var kurz = asset.slice(0, asset.length > 4 ? 3 : asset.length);

  return '<span class="logo-kreis" title="' + logoEsc(asset) + '" style="' +
    'width:' + g + 'px;height:' + g + 'px;background:' + farbe + ';' +
    'font-size:' + Math.round(g * (kurz.length > 2 ? 0.34 : 0.42)) + 'px">' +
    logoEsc(kurz) + '</span>';
}

/**
 * Asset-Zeichen und Symbolname nebeneinander — das übliche Paar in
 * Tabellen.
 */
function symbolMitLogo(symbol, groesse) {
  return '<span class="logo-zeile">' + assetLogo(symbol, groesse) +
    '<span>' + logoEsc(symbol) + '</span></span>';
}

/**
 * Börsen-Zeichen mit Namen. `nurZeichen` lässt den Text weg — für
 * schmale Tabellenspalten.
 */
function boerseMitLogo(id, nurZeichen, groesse) {
  var zeichen = boerseLogo(id, groesse);
  if (nurZeichen) return zeichen;
  var b = LOGO_BOERSEN[String(id || '').toLowerCase()];
  return '<span class="logo-zeile">' + zeichen +
    '<span>' + logoEsc(b ? b.voll : id) + '</span></span>';
}
