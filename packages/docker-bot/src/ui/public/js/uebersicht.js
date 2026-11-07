// ============================================================
// Betriebszustand, Leistung je Börse/Quelle, Kalender
//
// Drei Dinge, die bisher fehlten:
//
// 1. **Der Betriebszustand.** Seit jede Börse für sich entscheidet,
//    ob sie übt (Regel 5a), gibt es keinen einzelnen Schalter mehr,
//    der alles stilllegt. Die Oberfläche ist damit die einzige
//    Stelle, an der ein versehentlich freigeschalteter Echthandel
//    auffällt, bevor er handelt.
//
// 2. **Leistung je Börse und Signalquelle.** Aus den Gesamtzahlen
//    ist nicht zu lesen, welche Quelle trägt — eine gute und eine
//    schlechte ergeben zusammen eine mittelmäßige.
//
// 3. **Der Kalender.** Tagesergebnisse ließen sich bisher nur aus der
//    Equity-Kurve ablesen.
//
// Eigener Namensraum (`zu…`, `lg…`, `kal…`).
// ============================================================

function ueEsc(wert) {
  return String(wert == null ? '' : wert).replace(/[&<>"']/g, function (z) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z];
  });
}

function ueGeld(wert, stellen) {
  var n = Number(wert);
  if (!isFinite(n)) return '–';
  return n.toLocaleString('de-DE', {
    minimumFractionDigits: stellen == null ? 2 : stellen,
    maximumFractionDigits: stellen == null ? 2 : stellen,
  });
}

/** Vorzeichenbehaftet, mit Farbklasse. */
function ueBetrag(wert, einheit) {
  var n = Number(wert);
  if (!isFinite(n)) return '<span class="wert-neutral">–</span>';
  var klasse = n > 0 ? 'wert-plus' : (n < 0 ? 'wert-minus' : 'wert-neutral');
  var zeichen = n > 0 ? '+' : '';
  return '<span class="' + klasse + '">' + zeichen + ueGeld(n) +
    (einheit ? ' ' + einheit : '') + '</span>';
}

// ============================================================
// 1. Betriebszustand — Kopfzeile und Statuszeile
// ============================================================

var zuLetzterStand = null;

async function zuLaden() {
  // apiFetch, nicht fetch: Es setzt den Anmeldeheader und zeigt bei
  // 401 das eigene Login-Fenster. Rohes fetch liefe ohne Header, der
  // Server antwortete mit `WWW-Authenticate: Basic`, und der Browser
  // oeffnete seinen EIGENEN Dialog — mit Benutzername, den es hier
  // gar nicht gibt.
  zuLetzterStand = await apiFetch('/handelsplaetze/zustand');
  zuZeichnen();
}

function zuZeichnen() {
  var kopf = document.getElementById('betriebsmodus');
  var leiste = document.getElementById('statusleiste');
  var s = zuLetzterStand;

  if (!s) {
    if (kopf) kopf.innerHTML = '<span class="modus-unbekannt">Zustand unbekannt</span>';
    if (leiste) leiste.innerHTML = '<span class="status-punkt grau"></span> keine Verbindung';
    return;
  }

  // --- Kopfzeile: nur der Betriebsmodus, deutlich ---
  if (kopf) {
    if (s.echtHandelAktiv) {
      var namen = (s.echteBoersen || []).map(function (b) {
        return boerseMitLogo(b, false, 15);
      }).join(' ');
      kopf.innerHTML =
        '<span class="modus-echt" title="Aufträge gehen wirklich an die Börse">' +
        '&#9888; ECHTHANDEL &middot; ' + s.echteBoersen.length +
        (s.echteBoersen.length === 1 ? ' Börse' : ' Börsen') + '</span>' +
        '<span class="modus-liste">' + namen + '</span>';
    } else {
      kopf.innerHTML = '<span class="modus-uebung" title="Kein Auftrag verlässt den Bot">' +
        '&#9679; Übungsbetrieb</span>';
    }
  }

  // --- Statuszeile unten: der Rest, unaufdringlich ---
  if (leiste) {
    var teile = [];
    teile.push('<span class="status-punkt ' + (s.echtHandelAktiv ? 'rot' : 'gruen') + '"></span>' +
      (s.echtHandelAktiv ? 'Echthandel' : 'Übungsbetrieb'));
    teile.push(s.aktivePlaene + (s.aktivePlaene === 1 ? ' Plan aktiv' : ' Pläne aktiv'));
    teile.push(ueGeld(s.gebundeneMargin) + ' gebunden');

    if (s.rueckkanal) {
      var offen = Number(s.rueckkanal.offen || 0);
      teile.push('Rückkanal ' + (offen > 0 ? offen + ' offen' : '&#10003;'));
    }

    leiste.innerHTML = teile.join('<span class="status-trenner">&middot;</span>');
  }
}

// ============================================================
// 2. Leistung je Börse und Signalquelle
// ============================================================

async function lgLaden() {
  var ziel = document.getElementById('lg-gruppen');
  if (!ziel) return;

  var wahl = document.getElementById('aw-strategie');
  var abfrage = wahl && wahl.value && wahl.value !== 'alle'
    ? '?strategie=' + encodeURIComponent(wahl.value) : '';

  var daten = await apiFetch('/kennzahlen/gruppen' + abfrage);
  if (!daten) {
    ziel.innerHTML = '<p class="form-hint">Kennzahlen nicht abrufbar.</p>';
    return;
  }

  var teile = [];

  // Echt und Übung getrennt — ihre Summe wäre eine Zahl ohne
  // Bedeutung. Nur zeigen, was es gibt.
  if (daten.gesamtEcht && daten.gesamtEcht.trades > 0) {
    teile.push(lgSummenzeile('Echthandel', daten.gesamtEcht, false));
  }
  if (daten.gesamtUebung && daten.gesamtUebung.trades > 0) {
    teile.push(lgSummenzeile('Übungsbetrieb', daten.gesamtUebung, true));
  }

  teile.push(lgTabelle('Nach Börse', daten.nachBoerse, 'boerse'));
  teile.push(lgTabelle('Nach Signalquelle', daten.nachStrategie, 'strategie'));

  ziel.innerHTML = teile.join('');
}

function lgSummenzeile(titel, k, istUebung) {
  return '<div class="lg-summe' + (istUebung ? ' lg-summe-uebung' : '') + '">' +
    '<span class="lg-summe-titel">' + ueEsc(titel) + '</span>' +
    '<span>' + k.trades + ' Trades</span>' +
    '<span>' + ueGeld(k.trefferquote, 1) + ' % Treffer</span>' +
    '<span>PF ' + (k.profitFactor == null ? '–' : ueGeld(k.profitFactor)) + '</span>' +
    '<span>' + (k.erwartungswertR == null ? '–' : ueBetrag(k.erwartungswertR, 'R')) + '</span>' +
    '<strong>' + ueBetrag(k.ergebnis) + '</strong>' +
    '</div>';
}

function lgTabelle(titel, gruppen, art) {
  if (!gruppen || gruppen.length === 0) {
    return '<h4 class="lg-titel">' + ueEsc(titel) + '</h4>' +
      '<p class="form-hint">Noch keine abgeschlossenen Trades.</p>';
  }

  var zeilen = gruppen.map(function (g) {
    var k = g.kennzahlen;
    var zeichen = art === 'boerse'
      ? boerseMitLogo(g.name, false, 16)
      : ueEsc(g.name);

    // Übungsgruppen bleiben erkennbar — sonst stünde eine Zahl aus
    // dem Übungsbetrieb neben einer aus echtem Handel, als wären sie
    // dasselbe.
    var marke = g.uebung
      ? '<span class="lg-marke-uebung" title="Übungsbetrieb">Übung</span>' : '';

    return '<tr>' +
      '<td>' + zeichen + ' ' + marke + '</td>' +
      '<td class="num">' + k.trades + '</td>' +
      '<td class="num">' + ueGeld(k.trefferquote, 1) + ' %</td>' +
      '<td class="num">' + (k.erwartungswertR == null ? '–' : ueBetrag(k.erwartungswertR)) + '</td>' +
      '<td class="num">' + (k.profitFactor == null ? '–' : ueGeld(k.profitFactor)) + '</td>' +
      '<td class="num">' + ueBetrag(k.ergebnis) + '</td>' +
      '<td class="num">' + lgDauer(k.schnittDauerMinuten) + '</td>' +
      '</tr>';
  }).join('');

  return '<h4 class="lg-titel">' + ueEsc(titel) + '</h4>' +
    '<div class="tabelle-scroll"><table class="tabelle-schlank">' +
    '<thead><tr>' +
    '<th>' + (art === 'boerse' ? 'Börse' : 'Quelle') + '</th>' +
    '<th class="num">Trades</th><th class="num">Treffer</th>' +
    '<th class="num" title="Erwartungswert je Trade in R">Ø R</th>' +
    '<th class="num" title="Bruttogewinn geteilt durch Bruttoverlust">PF</th>' +
    '<th class="num">Ergebnis</th><th class="num">Ø Dauer</th>' +
    '</tr></thead><tbody>' + zeilen + '</tbody></table></div>';
}

function lgDauer(minuten) {
  var m = Number(minuten);
  if (!isFinite(m) || m <= 0) return '–';
  if (m < 90) return Math.round(m) + ' min';
  if (m < 60 * 36) return (m / 60).toFixed(1) + ' h';
  return (m / 1440).toFixed(1) + ' d';
}

// ============================================================
// 3. Kalender
// ============================================================

var kalMonat = null;          // Date auf den Monatsersten
var kalMassstab = 'pnl';      // 'pnl' | 'roi'
var kalDaten = null;

async function kalLaden() {
  var ziel = document.getElementById('kal-raster');
  if (!ziel) return;

  var wahl = document.getElementById('aw-strategie');
  var abfrage = wahl && wahl.value && wahl.value !== 'alle'
    ? '?strategie=' + encodeURIComponent(wahl.value) : '';

  kalDaten = await apiFetch('/kennzahlen/kalender' + abfrage);
  if (!kalDaten) {
    ziel.innerHTML = '<p class="form-hint">Kalender nicht abrufbar.</p>';
    return;
  }

  // Beim ersten Mal den Monat des letzten Trades zeigen — nicht den
  // aktuellen. Wer eine Woche nicht hinsah, will nicht auf ein leeres
  // Raster blicken.
  if (!kalMonat) {
    var tage = kalDaten.tage || [];
    var letzter = tage.length > 0 ? tage[tage.length - 1].tag : null;
    var d = letzter ? new Date(letzter + 'T00:00:00') : new Date();
    kalMonat = new Date(d.getFullYear(), d.getMonth(), 1);
  }

  kalZeichnen();
}

function kalUmschalten(massstab) {
  kalMassstab = massstab;
  kalZeichnen();
}

function kalMonatWechseln(schritt) {
  if (!kalMonat) return;
  kalMonat = new Date(kalMonat.getFullYear(), kalMonat.getMonth() + schritt, 1);
  kalZeichnen();
}

function kalZeichnen() {
  var ziel = document.getElementById('kal-raster');
  var kopf = document.getElementById('kal-kopf');
  if (!ziel || !kalDaten || !kalMonat) return;

  var nachTag = {};
  (kalDaten.tage || []).forEach(function (t) { nachTag[t.tag] = t; });

  var jahr = kalMonat.getFullYear();
  var monat = kalMonat.getMonth();
  var MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
    'August', 'September', 'Oktober', 'November', 'Dezember'];

  // Montag als erster Tag — hierzulande üblich.
  var erster = new Date(jahr, monat, 1);
  var versatz = (erster.getDay() + 6) % 7;
  var tageImMonat = new Date(jahr, monat + 1, 0).getDate();

  // Maßstab für die Farbstärke: der größte Betrag DIESES Monats.
  // Über alle Monate zu skalieren ließe einen ruhigen Monat neben
  // einem wilden farblos erscheinen.
  var groesster = 0;
  var monatsSumme = 0;
  var monatsTrades = 0;
  for (var t = 1; t <= tageImMonat; t++) {
    var e = nachTag[kalSchluessel(jahr, monat, t)];
    if (!e) continue;
    var wert = kalMassstab === 'roi' ? (e.roiPct || 0) : e.ergebnis;
    groesster = Math.max(groesster, Math.abs(wert));
    monatsSumme += e.ergebnis;
    monatsTrades += e.trades;
  }

  var zellen = [];
  for (var v = 0; v < versatz; v++) zellen.push('<div class="kal-leer"></div>');

  for (var tag = 1; tag <= tageImMonat; tag++) {
    var schl = kalSchluessel(jahr, monat, tag);
    var d = nachTag[schl];

    if (!d) {
      zellen.push('<div class="kal-tag kal-tag-leer"><span class="kal-nr">' +
        tag + '</span></div>');
      continue;
    }

    var w = kalMassstab === 'roi' ? d.roiPct : d.ergebnis;
    var anteil = groesster > 0 ? Math.min(1, Math.abs(w || 0) / groesster) : 0;
    // Nie ganz durchsichtig: Ein Tag MIT Trades soll sich von einem
    // ohne unterscheiden, auch wenn er bei null herauskam.
    var deckung = 0.18 + anteil * 0.55;
    var farbe = (w || 0) >= 0
      ? 'rgba(34,180,110,' + deckung.toFixed(2) + ')'
      : 'rgba(224,82,96,' + deckung.toFixed(2) + ')';

    var anzeige = kalMassstab === 'roi'
      ? (d.roiPct == null ? '–' : (d.roiPct > 0 ? '+' : '') + ueGeld(d.roiPct, 1) + ' %')
      : (d.ergebnis > 0 ? '+' : '') + ueGeld(d.ergebnis);

    zellen.push(
      '<div class="kal-tag" style="background:' + farbe + '"' +
      ' title="' + ueEsc(schl) + ': ' + d.trades + ' Trades, ' +
      d.gewinner + ' davon positiv"' +
      ' onclick="kalTagOeffnen(\'' + schl + '\')">' +
      '<span class="kal-nr">' + tag + '</span>' +
      '<span class="kal-wert">' + anzeige + '</span>' +
      '<span class="kal-anzahl">' + d.trades + '</span>' +
      (d.uebung ? '<span class="kal-uebung" title="Übungsbetrieb"></span>' : '') +
      '</div>',
    );
  }

  if (kopf) {
    kopf.innerHTML =
      '<button class="btn btn-secondary kal-pfeil" onclick="kalMonatWechseln(-1)">&lsaquo;</button>' +
      '<span class="kal-monat">' + MONATE[monat] + ' ' + jahr + '</span>' +
      '<button class="btn btn-secondary kal-pfeil" onclick="kalMonatWechseln(1)">&rsaquo;</button>' +
      '<span class="kal-summe">' + ueBetrag(monatsSumme) + ' &middot; ' +
      monatsTrades + ' Trades</span>';
  }

  ziel.innerHTML =
    '<div class="kal-wochentage">' +
    ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
      .map(function (w) { return '<span>' + w + '</span>'; }).join('') +
    '</div><div class="kal-gitter">' + zellen.join('') + '</div>';
}

function kalSchluessel(jahr, monat, tag) {
  return jahr + '-' + String(monat + 1).padStart(2, '0') + '-' +
    String(tag).padStart(2, '0');
}

/** Klick auf einen Tag: die Trades dieses Tages darunter zeigen. */
function kalTagOeffnen(tag) {
  var ziel = document.getElementById('kal-tagesliste');
  if (!ziel || !kalDaten) return;

  var d = (kalDaten.tage || []).find(function (x) { return x.tag === tag; });
  if (!d) { ziel.innerHTML = ''; return; }

  ziel.innerHTML =
    '<div class="kal-tagkopf"><strong>' + ueEsc(tag) + '</strong>' +
    '<span>' + d.trades + ' Trades, ' + d.gewinner + ' positiv</span>' +
    '<span>' + ueBetrag(d.ergebnis) + '</span>' +
    '<span>' + (d.roiPct == null ? '' : ueBetrag(d.roiPct, '%')) + '</span>' +
    (d.summeR == null ? '' : '<span>' + ueBetrag(d.summeR, 'R') + '</span>') +
    '</div>';
}
