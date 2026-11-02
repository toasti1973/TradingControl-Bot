// ============================================================
// Auswertung — taugt der Signalgeber?
//
// Gemessen wird in R: dem Risiko, das ein Trade am Stop-Loss eingeht.
// Die Signale dieses Bots riskieren durchweg 1 % des Referenzkapitals,
// damit steht jeder Trade auf derselben Skala — BTCUSDT mit Hebel 20
// und XRPUSDT mit Hebel 7 lassen sich in USDT nicht vergleichen, in R
// schon.
//
// Gemeinsam genutzt aus app.js und signale.js: apiFetch, esc, setText,
// geld, mengeKurz, preis, zeitKurz, tabelleZeichnen, authHeader.
// ============================================================

/** Farbe der Verlaufslinie. Gegen die Kartenflaeche geprueft. */
var EQUITY_LINIE = '#388bfd';

var auswertungZuletzt = null;

async function updateAuswertung() {
  await auswertungLaden();
}

async function auswertungLaden() {
  var wahl = document.getElementById('aw-strategie');
  var strategie = wahl && wahl.value ? wahl.value : '';
  var pfad = '/kennzahlen' + (strategie ? '?strategie=' + encodeURIComponent(strategie) : '');

  try {
    var d = await apiFetch(pfad);
    if (!d) return;
    auswertungZuletzt = d;

    strategieAuswahlFuellen(d.strategien, strategie);
    kennzahlenZeichnen(d.kennzahlen);
    tradesZeichnen(d.trades || []);

    var v = await apiFetch('/kennzahlen/verlauf');
    if (v) equityZeichnen(v);
  } catch (e) {
    console.error('[Auswertung]', e);
  }
}

/** Die Auswahl der Signalgeber — erst damit lassen sich zwei vergleichen. */
function strategieAuswahlFuellen(strategien, gewaehlt) {
  var wahl = document.getElementById('aw-strategie');
  if (!wahl) return;

  var neu = '<option value="">alle Strategien</option>' +
    (strategien || []).map(function (s) {
      return '<option value="' + esc(s) + '"' +
        (s === gewaehlt ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');

  // Nur ersetzen, wenn sich etwas geaendert hat — sonst springt die
  // Auswahl bei jedem Durchlauf zurueck.
  if (wahl.innerHTML !== neu) wahl.innerHTML = neu;
}

// ============================================================
// Die Kennzahlen
// ============================================================

function kennzahlenZeichnen(k) {
  var ziel = document.getElementById('aw-kennzahlen');
  if (!ziel || !k) return;

  if (!k.trades) {
    ziel.innerHTML = '<div class="card"><div class="card-label">Noch keine Daten</div>' +
      '<div class="form-hint" style="margin-top:6px">' +
      'Sobald der erste Trade abgeschlossen ist, steht hier die Auswertung.</div></div>';
    return;
  }

  ziel.innerHTML =
    awKachel('Trades', String(k.trades)) +
    awKachel('Trefferquote', k.trefferquote.toFixed(1) + ' %',
      k.gewinner + ' von ' + k.trades) +
    awKachel('Profit Factor', k.profitFactor != null ? k.profitFactor.toFixed(2) : '–',
      profitFactorText(k.profitFactor), farbeAb(k.profitFactor, 1)) +
    awKachel('Erwartungswert', inR(k.erwartungswertR),
      'je Trade', farbeAb(k.erwartungswertR, 0)) +
    awKachel('Ergebnis gesamt', geld(k.ergebnis) + ' USDT',
      k.summeR != null ? inR(k.summeR) + ' insgesamt' : '',
      farbeAb(k.ergebnis, 0)) +
    awKachel('ø Gewinn / ø Verlust',
      inR(k.schnittGewinnR) + ' / ' + inR(k.schnittVerlustR),
      k.payoffRatio != null ? 'Verhaeltnis ' + k.payoffRatio.toFixed(2) : '') +
    awKachel('Bestes / Schlechtestes',
      inR(k.bestesR) + ' / ' + inR(k.schlechtestesR), '') +
    awKachel('ø Haltedauer',
      k.schnittDauerMinuten != null ? dauerText(k.schnittDauerMinuten) : '–',
      k.mitRisiko < k.trades
        ? (k.trades - k.mitRisiko) + ' ohne bezifferbares Risiko' : '');
}

/**
 * Eine Kennzahl-Kachel dieser Seite.
 *
 * Die Zahl traegt die Farbe, der Text darunter bleibt gedaempft — ein
 * eingefaerbter Beschreibungstext laese sich schlechter und truege
 * keine zusaetzliche Aussage.
 *
 * Bewusst NICHT `kachel` genannt: Die Oberflaeche teilt sich einen
 * globalen Namensraum, und signale.js fuehrt bereits eine Funktion
 * dieses Namens mit anderer Signatur. Da diese Datei spaeter geladen
 * wird, haette sie jene ueberschrieben — mit dem Ergebnis, dass die
 * Detailansicht ihren dritten Parameter durch esc() schickte und
 * HTML als Text anzeigte.
 */
function awKachel(label, wert, hinweis, farbe) {
  return '<div class="card">' +
    '<div class="card-label">' + esc(label) + '</div>' +
    '<div class="card-value" style="font-size:18px' +
      (farbe ? ';color:' + farbe : '') + '">' + wert + '</div>' +
    (hinweis
      ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' +
        esc(hinweis) + '</div>'
      : '') +
    '</div>';
}

/** Ein R-Wert mit Vorzeichen. */
function inR(wert) {
  if (wert == null || !isFinite(wert)) return '–';
  return (wert > 0 ? '+' : '') + Number(wert).toFixed(2) + ' R';
}

function farbeAb(wert, schwelle) {
  if (wert == null || !isFinite(wert)) return '';
  if (wert > schwelle) return 'var(--green)';
  if (wert < schwelle) return 'var(--red)';
  return '';
}

function profitFactorText(pf) {
  if (pf == null) return 'keine Verluste bisher';
  if (pf >= 1.5) return 'traegt deutlich';
  if (pf > 1) return 'traegt';
  if (pf === 1) return 'geht auf null auf';
  return 'traegt NICHT';
}

function dauerText(minuten) {
  if (minuten < 60) return minuten + ' Min';
  var h = Math.floor(minuten / 60);
  var m = minuten % 60;
  if (h < 24) return h + ' Std' + (m ? ' ' + m + ' Min' : '');
  return Math.floor(h / 24) + ' Tage ' + (h % 24) + ' Std';
}

// ============================================================
// Der Kontoverlauf
//
// Eine Linie, keine Legende — der Titel nennt sie. Das Raster bleibt
// zurueckgenommen, beschriftet werden nur die Endpunkte und der
// Tiefpunkt des groessten Rueckgangs; eine Zahl an jedem Punkt waere
// unlesbar.
// ============================================================

function equityZeichnen(v) {
  var ziel = document.getElementById('aw-equity');
  var zahlen = document.getElementById('aw-verlauf-zahlen');
  var hinweis = document.getElementById('aw-verlauf-hinweis');
  if (!ziel) return;

  if (zahlen) {
    zahlen.innerHTML =
      verlaufZahl('Stand', geld(v.endstand) + ' USDT',
        farbeAb(v.endstand - v.startkapital, 0)) +
      verlaufZahl('Max. Rueckgang', '−' + v.maxDrawdownPct.toFixed(2) + ' %',
        v.maxDrawdown > 0 ? 'var(--red)' : '') +
      verlaufZahl('Verlustserie', String(v.laengsteVerlustserie)) +
      verlaufZahl('Gewinnserie', String(v.laengsteGewinnserie));
  }
  if (hinweis) {
    hinweis.textContent = v.maxDrawdown > 0
      ? 'Groesster Rueckgang: ' + geld(v.drawdownVon) + ' auf ' + geld(v.drawdownBis) +
        ' USDT (−' + geld(v.maxDrawdown) + ')'
      : 'Noch kein Rueckgang vom Hoechststand.';
  }

  var punkte = v.punkte || [];
  if (punkte.length < 2) {
    ziel.innerHTML = '<p class="form-hint">Der Verlauf braucht mindestens zwei Buchungen.</p>';
    return;
  }

  ziel.innerHTML = equitySvg(punkte, v);
}

function verlaufZahl(label, wert, farbe) {
  return '<div><span style="color:var(--text-muted)">' + esc(label) + ':</span> ' +
    '<span style="font-weight:600' + (farbe ? ';color:' + farbe : '') + '">' +
    wert + '</span></div>';
}

/**
 * Die Kurve als SVG.
 *
 * Selbst gezeichnet statt mit einer Bibliothek: Es ist eine Linie, und
 * die Sicherheitsregeln dieser Seite lassen ohnehin nur eigene
 * Skripte zu.
 */
function equitySvg(punkte, v) {
  var B = 760, H = 220;
  var links = 64, rechts = 12, oben = 14, unten = 26;
  var pb = B - links - rechts;   // Plotbreite
  var ph = H - oben - unten;

  var staende = punkte.map(function (p) { return p.stand; });
  staende.push(v.startkapital);

  var min = Math.min.apply(null, staende);
  var max = Math.max.apply(null, staende);
  // Etwas Luft, damit die Linie nicht am Rand klebt.
  var spanne = (max - min) || Math.abs(max) * 0.01 || 1;
  min -= spanne * 0.08;
  max += spanne * 0.08;

  var x = function (i) { return links + (i / (punkte.length - 1)) * pb; };
  var y = function (w) { return oben + (1 - (w - min) / (max - min)) * ph; };

  // --- Raster, zurueckgenommen ---
  var raster = '';
  for (var i = 0; i <= 4; i++) {
    var wert = min + (max - min) * (i / 4);
    var yy = y(wert);
    raster += '<line x1="' + links + '" y1="' + yy.toFixed(1) +
      '" x2="' + (B - rechts) + '" y2="' + yy.toFixed(1) +
      '" stroke="var(--border)" stroke-width="1" opacity="0.5"/>' +
      '<text x="' + (links - 8) + '" y="' + (yy + 4).toFixed(1) +
      '" text-anchor="end" font-size="10" fill="var(--text-muted)">' +
      Math.round(wert).toLocaleString('de-DE') + '</text>';
  }

  // --- Startkapital als Bezugslinie ---
  var yStart = y(v.startkapital);
  raster += '<line x1="' + links + '" y1="' + yStart.toFixed(1) +
    '" x2="' + (B - rechts) + '" y2="' + yStart.toFixed(1) +
    '" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>' +
    '<text x="' + (B - rechts) + '" y="' + (yStart - 5).toFixed(1) +
    '" text-anchor="end" font-size="10" fill="var(--text-muted)">Start</text>';

  // --- Die Linie ---
  var d = punkte.map(function (p, i) {
    return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.stand).toFixed(1);
  }).join(' ');

  // Flaeche darunter, schwach — sie gibt der Linie Gewicht, ohne
  // eine zweite Aussage zu behaupten.
  var flaeche = d + ' L' + x(punkte.length - 1).toFixed(1) + ' ' + (oben + ph) +
    ' L' + x(0).toFixed(1) + ' ' + (oben + ph) + ' Z';

  // --- Tiefpunkt des groessten Rueckgangs ---
  var marke = '';
  if (v.maxDrawdown > 0) {
    var tief = -1, abstand = Infinity;
    for (var k = 0; k < punkte.length; k++) {
      var ab = Math.abs(punkte[k].stand - v.drawdownBis);
      if (ab < abstand) { abstand = ab; tief = k; }
    }
    if (tief >= 0) {
      marke = '<circle cx="' + x(tief).toFixed(1) + '" cy="' + y(punkte[tief].stand).toFixed(1) +
        '" r="4" fill="var(--red)" stroke="var(--bg-card)" stroke-width="2"/>';
    }
  }

  // --- Hover: Fadenkreuz und Werte ---
  var felder = punkte.map(function (p, i) {
    var breite = pb / punkte.length;
    return '<rect x="' + (x(i) - breite / 2).toFixed(1) + '" y="' + oben +
      '" width="' + Math.max(breite, 4).toFixed(1) + '" height="' + ph +
      '" fill="transparent"' +
      ' data-x="' + x(i).toFixed(1) + '" data-y="' + y(p.stand).toFixed(1) + '"' +
      ' data-stand="' + geld(p.stand) + '" data-aenderung="' + geld(p.veraenderung) + '"' +
      ' data-zeit="' + esc(zeitKurz(p.zeitpunkt)) + '"' +
      ' data-symbol="' + esc(p.symbol || '') + '" data-art="' + esc(p.art) + '"' +
      ' onmouseenter="equityZeigen(this)" onmouseleave="equityVerbergen()"/>';
  }).join('');

  return '<div style="position:relative">' +
    '<svg viewBox="0 0 ' + B + ' ' + H + '" style="width:100%;height:auto;display:block"' +
    ' role="img" aria-label="Kontoverlauf ueber die Zeit">' +
    raster +
    '<path d="' + flaeche + '" fill="' + EQUITY_LINIE + '" opacity="0.10"/>' +
    '<path d="' + d + '" fill="none" stroke="' + EQUITY_LINIE +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    marke +
    '<line id="aw-kreuz" x1="0" y1="' + oben + '" x2="0" y2="' + (oben + ph) +
      '" stroke="var(--text-muted)" stroke-width="1" opacity="0"/>' +
    '<circle id="aw-punkt" r="4" fill="' + EQUITY_LINIE +
      '" stroke="var(--bg-card)" stroke-width="2" opacity="0"/>' +
    felder +
    '</svg>' +
    '<div id="aw-tooltip" style="position:absolute;display:none;pointer-events:none;' +
      'background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;' +
      'padding:6px 10px;font-size:12px;white-space:nowrap;z-index:5"></div>' +
    '</div>';
}

function equityZeigen(feld) {
  var kreuz = document.getElementById('aw-kreuz');
  var punkt = document.getElementById('aw-punkt');
  var tip = document.getElementById('aw-tooltip');
  if (!kreuz || !punkt || !tip) return;

  var px = feld.getAttribute('data-x');
  var py = feld.getAttribute('data-y');

  kreuz.setAttribute('x1', px); kreuz.setAttribute('x2', px);
  kreuz.setAttribute('opacity', '0.6');
  punkt.setAttribute('cx', px); punkt.setAttribute('cy', py);
  punkt.setAttribute('opacity', '1');

  var aenderung = feld.getAttribute('data-aenderung');
  var positiv = parseFloat(String(aenderung).replace(/\./g, '').replace(',', '.')) > 0;
  var symbol = feld.getAttribute('data-symbol');

  tip.innerHTML =
    '<div style="color:var(--text-muted);font-size:11px">' +
      feld.getAttribute('data-zeit') + '</div>' +
    '<div style="font-weight:600">' + feld.getAttribute('data-stand') + ' USDT</div>' +
    '<div style="color:' + (positiv ? 'var(--green)' : 'var(--red)') + '">' +
      (positiv ? '+' : '') + aenderung +
      ' <span style="color:var(--text-muted)">' +
      esc(feld.getAttribute('data-art')) + (symbol ? ' · ' + esc(symbol) : '') +
      '</span></div>';

  // Am Prozentsatz der Plotbreite ausrichten, damit es bei jeder
  // Fenstergroesse sitzt — das SVG skaliert mit.
  tip.style.display = 'block';
  tip.style.left = ((parseFloat(px) / 760) * 100) + '%';
  tip.style.top = '8px';
  tip.style.transform = parseFloat(px) > 500 ? 'translateX(-100%)' : 'translateX(8px)';
}

function equityVerbergen() {
  var kreuz = document.getElementById('aw-kreuz');
  var punkt = document.getElementById('aw-punkt');
  var tip = document.getElementById('aw-tooltip');
  if (kreuz) kreuz.setAttribute('opacity', '0');
  if (punkt) punkt.setAttribute('opacity', '0');
  if (tip) tip.style.display = 'none';
}

// ============================================================
// Die Trades
// ============================================================

function tradesZeichnen(trades) {
  var body = document.getElementById('aw-trades');
  if (!body) return;

  if (!trades.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty-state">' +
      'Noch kein Trade abgeschlossen.</td></tr>';
    return;
  }

  body.innerHTML = trades.map(function (t) {
    var r = t.rVielfaches;
    var farbe = r == null ? 'var(--text-muted)'
      : r > 0 ? 'var(--green)' : r < 0 ? 'var(--red)' : 'var(--text-muted)';

    return '<tr style="cursor:pointer" title="Plan anzeigen"' +
      ' data-plan="' + esc(t.planId) + '"' +
      ' onclick="planDetailOeffnen(this.dataset.plan)">' +
      '<td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">' +
        esc(zeitKurz(t.beendet)) + '</td>' +
      '<td><strong>' + esc(t.symbol) + '</strong></td>' +
      '<td><span class="badge ' + (t.richtung === 'long' ? 'badge-green' : 'badge-red') +
        '">' + esc(t.richtung) + '</span></td>' +
      '<td style="font-size:12px">' + esc(t.strategie) + '</td>' +
      '<td style="text-align:right">' + mengeKurz(t.menge) + '</td>' +
      '<td style="text-align:right">' + preis(t.einstiegsPreis) + '</td>' +
      '<td style="text-align:right;color:var(--text-muted)">' +
        (t.risiko != null ? geld(t.risiko) : '–') + '</td>' +
      '<td style="text-align:right;color:' + farbe + '">' +
        (t.ergebnis >= 0 ? '+' : '') + geld(t.ergebnis) + '</td>' +
      '<td style="text-align:right;color:' + farbe + ';font-weight:600">' +
        inR(r) + '</td>' +
      '<td style="font-size:12px">' + verlaufKurz(t) + '</td>' +
      '<td style="text-align:right;font-size:12px;color:var(--text-muted)">' +
        (t.dauerMinuten != null ? dauerText(t.dauerMinuten) : '–') + '</td>' +
      '</tr>';
  }).join('');
}

/** Was mit dem Trade geschah, in zwei Zeichen. */
function verlaufKurz(t) {
  var teile = [];
  if (t.tpsErreicht > 0) {
    teile.push('<span style="color:var(--green)">TP' + t.tpsErreicht + '</span>');
  }
  if (t.slGetroffen) {
    teile.push('<span style="color:var(--red)">SL</span>');
  }
  return teile.length ? teile.join(' → ') : '<span style="color:var(--text-muted)">–</span>';
}

// ============================================================
// MAE und MFE
// ============================================================

async function ausschlaegeLaden() {
  var ziel = document.getElementById('aw-mae');
  var knopf = document.getElementById('aw-mae-knopf');
  if (!ziel) return;

  var wahl = document.getElementById('aw-strategie');
  var strategie = wahl && wahl.value ? wahl.value : '';

  ziel.innerHTML = '<p class="form-hint">Kerzen werden geholt &hellip;</p>';
  if (knopf) knopf.disabled = true;

  try {
    var d = await apiFetch('/kennzahlen/ausschlaege' +
      (strategie ? '?strategie=' + encodeURIComponent(strategie) : ''));
    if (!d) { ziel.innerHTML = '<p class="form-hint">Keine Antwort.</p>'; return; }

    ziel.innerHTML = ausschlaegeDarstellen(d);
  } catch (e) {
    ziel.innerHTML = '<p class="form-hint" style="color:var(--red)">' +
      'Nicht berechenbar: ' + esc(String((e && e.message) || e)) + '</p>';
  } finally {
    if (knopf) knopf.disabled = false;
  }
}

function ausschlaegeDarstellen(d) {
  if (!d.ausgewertet) {
    return '<p class="form-hint">Keine Kerzen zu den Trades gefunden. ' +
      'Das Zeitfenster der Boerse reicht nur eine begrenzte Zeit zurueck.</p>';
  }

  var h = '<div class="cards" style="margin-bottom:12px">' +
    awKachel('ø gegen uns (Verlierer)', inR(d.schnittMaeVerlierer),
      'tiefster Punkt vor dem Ende') +
    awKachel('ø gegen uns (Gewinner)', inR(d.schnittMaeGewinner),
      'so weit lagen sie zurueck') +
    awKachel('ø fuer uns (Gewinner)', inR(d.schnittMfeGewinner),
      'bester Punkt im Verlauf') +
    awKachel('Ausgewertet', d.ausgewertet + ' von ' + (d.ausgewertet + d.ohneDaten),
      d.ohneDaten ? d.ohneDaten + ' ohne Kerzen' : '') +
    '</div>';

  // --- Die beiden Schlussfolgerungen ---
  if (d.knappGestoppt > 0) {
    h += '<p class="form-hint" style="color:var(--yellow)">' +
      '<strong>' + d.knappGestoppt + '</strong> Verlierer wurden knapp gestoppt — ' +
      'ihr Tiefpunkt lag dicht am Stop. Etwas mehr Luft haette sie am Leben gelassen. ' +
      'Ob sie dann aufgegangen waeren, sagt diese Zahl nicht.</p>';
  }
  if (d.zuFruehGeschlossen > 0) {
    h += '<p class="form-hint" style="color:var(--yellow)">' +
      '<strong>' + d.zuFruehGeschlossen + '</strong> Gewinner liefen deutlich weiter, ' +
      'als am Ende herauskam — ein Hinweis auf zu nahe Ziele.</p>';
  }
  if (!d.knappGestoppt && !d.zuFruehGeschlossen) {
    h += '<p class="form-hint">Weder zu enge Stops noch zu nahe Ziele erkennbar.</p>';
  }

  // --- Je Trade ---
  var mitDaten = (d.trades || []).filter(function (t) { return t.maeR != null; });
  if (!mitDaten.length) return h;

  h += '<div class="table-container" style="margin-top:12px"><table>' +
    '<thead><tr><th>Symbol</th><th>Richtung</th>' +
    '<th style="text-align:right">Ergebnis</th>' +
    '<th style="text-align:right">gegen uns</th>' +
    '<th style="text-align:right">fuer uns</th>' +
    '<th>Deutung</th></tr></thead><tbody>';

  h += mitDaten.map(function (t) {
    return '<tr>' +
      '<td><strong>' + esc(t.symbol) + '</strong></td>' +
      '<td><span class="badge ' + (t.richtung === 'long' ? 'badge-green' : 'badge-red') +
        '">' + esc(t.richtung) + '</span></td>' +
      '<td style="text-align:right;color:' +
        (t.rVielfaches > 0 ? 'var(--green)' : 'var(--red)') + '">' +
        inR(t.rVielfaches) + '</td>' +
      '<td style="text-align:right;color:var(--red)">' + inR(t.maeR) + '</td>' +
      '<td style="text-align:right;color:var(--green)">' + inR(t.mfeR) + '</td>' +
      '<td style="font-size:12px;color:var(--text-muted)">' + deutung(t) + '</td>' +
      '</tr>';
  }).join('');

  return h + '</tbody></table></div>';
}

/** Was dieser eine Trade ueber Stop und Ziele sagt. */
function deutung(t) {
  if (t.slGetroffen && t.maeR != null && t.maeR <= -1 && t.maeR > -1.15) {
    return 'knapp gestoppt';
  }
  if (t.rVielfaches > 0 && t.mfeR != null && t.mfeR > t.rVielfaches * 2 &&
      t.mfeR - t.rVielfaches >= 1) {
    return 'lief deutlich weiter';
  }
  if (t.slGetroffen) return 'klar gestoppt';
  if (t.rVielfaches > 0) return 'planmaessig';
  return '';
}

/**
 * Laedt die Trades als CSV herunter.
 *
 * Der Umweg ueber einen Blob ist noetig, weil die Schnittstelle hinter
 * der Passwortabfrage liegt — ein schlichter Link truege den
 * Authorization-Kopf nicht mit.
 */
async function auswertungExportR() {
  var wahl = document.getElementById('aw-strategie');
  var strategie = wahl && wahl.value ? wahl.value : '';
  var pfad = '/api/kennzahlen.csv' +
    (strategie ? '?strategie=' + encodeURIComponent(strategie) : '');

  try {
    var antwort = await fetch(pfad, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
    if (!antwort.ok) { alert('Export fehlgeschlagen: ' + antwort.status); return; }

    var url = URL.createObjectURL(await antwort.blob());
    var a = document.createElement('a');
    a.href = url;
    a.download = 'trades-in-r.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export fehlgeschlagen: ' + ((e && e.message) || e));
  }
}
