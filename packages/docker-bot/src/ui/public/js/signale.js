// ============================================================
// Signal-Eingang, Uebungskonto und Plan-Detailansicht
//
// Bewusst eine eigene Datei: app.js traegt schon 1700 Zeilen, und was
// hier steht, haengt an einem anderen Teil des Bots. Die Funktionen
// werden aus index.html und aus app.js heraus aufgerufen und liegen
// deshalb im globalen Namensraum — wie der Rest dieser Oberflaeche.
//
// Gemeinsam genutzt aus app.js: apiFetch, esc, setText, quellAbzeichen.
// ============================================================

// ============================================================
// Monitor-Stand fuer das Dashboard
//
// Die Dashboard-Abfrage liefert die Plaene, aber nicht ihren
// Ausfuehrungsstand. Der kommt aus einer zweiten Abfrage und wird hier
// zwischengehalten, damit die Zeilen ihn mit anzeigen koennen.
// ============================================================

var monitorStand = {};

async function monitorStandLaden() {
  try {
    var r = await apiFetch('/trade-plans/monitors/status');
    monitorStand = {};
    if (r && r.monitors) {
      r.monitors.forEach(function (m) { monitorStand[m.planId] = m; });
    }
  } catch (e) {
    // Das Dashboard soll auch ohne diese Zusatzangabe stehen.
  }
  return monitorStand;
}

/** Wieviele Take-Profits sind erreicht? */
function fortschritt(planId) {
  var m = monitorStand[planId];
  if (!m || !m.tpsTotal) return '<span style="color:var(--text-muted)">–</span>';

  var erreicht = m.tpsTriggered || 0;
  var gesamt = m.tpsTotal;
  var farbe = erreicht === 0 ? 'var(--text-muted)'
    : erreicht >= gesamt ? 'var(--green)' : 'var(--accent)';

  var punkte = '';
  for (var i = 0; i < gesamt; i++) {
    punkte += '<span style="color:' + (i < erreicht ? farbe : 'var(--border)') + '">●</span>';
  }
  return '<span title="' + erreicht + ' von ' + gesamt + ' Take-Profits erreicht">' + punkte +
    ' <span style="color:' + farbe + ';font-size:12px">TP ' + erreicht + '/' + gesamt + '</span></span>';
}

/**
 * Stop-Loss — der geltende, nicht der geplante.
 *
 * Er wandert: nach einem Take-Profit nachgezogen oder als Trailing-Stop
 * mitlaufend. Welcher Fall vorliegt, steht im Hinweistext.
 */
function slAnzeige(planId, geplant) {
  var m = monitorStand[planId];
  var aktuell = (m && m.slCurrent != null) ? m.slCurrent : geplant;
  if (aktuell == null) return '<span style="color:var(--text-muted)">keiner</span>';

  var text = Number(aktuell).toFixed(2);

  if (m && m.trailingActive) {
    return '<span style="color:var(--accent)" title="Trailing-Stop aktiv">' + text + ' ↗</span>';
  }
  var verschoben = m && m.slCurrent != null && geplant != null &&
    Math.abs(m.slCurrent - geplant) > 1e-9;
  if (verschoben) {
    return '<span style="color:var(--green)" title="Nachgezogen, geplant war ' +
      Number(geplant).toFixed(2) + '">' + text + ' ✓</span>';
  }
  return text;
}

function kursAnzeige(planId) {
  var m = monitorStand[planId];
  if (!m || m.lastPrice == null) return '<span style="color:var(--text-muted)">–</span>';
  return Number(m.lastPrice).toFixed(2);
}

/**
 * Nicht realisiertes Ergebnis der offenen Position.
 *
 * Als Schaetzung ausgewiesen, und das mit Absicht: Welche Teil-Einstiege
 * tatsaechlich gefuellt wurden, weiss die Oberflaeche nicht. Gerechnet
 * wird auf den Durchschnitt der geplanten Einstiege.
 */
function pnlAnzeige(p) {
  var m = monitorStand[p.id];
  if (!m || m.lastPrice == null || !m.remainingSize) {
    return '<span style="color:var(--text-muted)">–</span>';
  }

  var einstieg = (p.avg_entry != null) ? Number(p.avg_entry) : null;
  if (einstieg == null || !isFinite(einstieg) || einstieg <= 0) {
    return '<span style="color:var(--text-muted)">–</span>';
  }

  var richtung = p.direction === 'long' ? 1 : -1;
  var pnl = (Number(m.lastPrice) - einstieg) * Number(m.remainingSize) * richtung;
  var farbe = pnl >= 0 ? 'var(--green)' : 'var(--red)';

  return '<span style="color:' + farbe + '" title="Schaetzung auf Basis des durchschnittlichen Einstiegs">' +
    (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '</span>';
}

// ============================================================
// Detailansicht eines Plans
// ============================================================

function planDetailSchliessen(ereignis) {
  // Nur schliessen, wenn der Hintergrund getroffen wurde oder der
  // Schliessen-Knopf (der true uebergibt) — nicht bei jedem Klick
  // innerhalb des Fensters.
  if (ereignis !== true && ereignis && ereignis.target &&
      ereignis.target.id !== 'plan-detail-overlay') return;
  var el = document.getElementById('plan-detail-overlay');
  if (el) el.style.display = 'none';

  // Die Schaltflaechen leeren: Sie gehoeren zu dem Plan, der eben offen
  // war. Blieben sie stehen, traefe der naechste Klick einen anderen.
  var aktionen = document.getElementById('pd-aktionen');
  if (aktionen) aktionen.innerHTML = '';

  // Den Chart abbauen, sonst bleibt seine Zeichenflaeche im Speicher
  // liegen — bei jedem Oeffnen eine weitere.
  if (typeof chartAufraeumen === 'function') chartAufraeumen();
}

async function planDetailOeffnen(planId) {
  var overlay = document.getElementById('plan-detail-overlay');
  var body = document.getElementById('pd-body');
  if (!overlay || !body) return;

  overlay.style.display = 'flex';
  body.innerHTML = '<div class="empty-state">Wird geladen …</div>';

  try {
    var d = await apiFetch('/trade-plans/' + encodeURIComponent(planId));
    if (!d || !d.plan) {
      body.innerHTML = '<div class="empty-state">Plan nicht gefunden</div>';
      return;
    }
    body.innerHTML = planDetailAufbauen(d);

    var titel = document.getElementById('pd-titel');
    if (titel) {
      titel.innerHTML = esc(d.plan.symbol) +
        ' <span class="badge ' + (d.plan.direction === 'long' ? 'badge-green' : 'badge-red') + '">' +
        esc(d.plan.direction) + '</span> ' + quellAbzeichen(d.plan.source);
    }

    planAktionenAufbauen(d);

    // Der Chart kommt nach dem Aufbau: Er braucht den Behaelter, und
    // die Kerzen kommen ueber eine eigene Abfrage.
    if (typeof chartLaden === 'function') {
      chartLaden(planId, '15m');
    }
  } catch (e) {
    body.innerHTML = '<div class="empty-state">Fehler beim Laden: ' +
      esc(String((e && e.message) || e)) + '</div>';
  }
}

function planDetailAufbauen(d) {
  var p = d.plan;
  var m = d.monitor;
  var orders = d.orders || [];

  var entries = sicherJson(p.entry_orders, []);
  var tps = sicherJson(p.take_profits, []);
  var herkunft = sicherJson(p.signal_origin, null);
  var trigger = sicherJson(p.signal_trigger, null);

  var h = '';

  // --- Kursverlauf ---
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<h4 style="margin:0">Kursverlauf</h4>' +
    '<div id="pd-chart-intervalle" style="display:flex;gap:4px">' +
    ['5m', '15m', '1h', '4h', '1d'].map(function (iv) {
      return '<button class="btn ' + (iv === '15m' ? 'btn-primary' : 'btn-secondary') +
        '" style="padding:2px 8px;font-size:11px" data-iv="' + iv +
        '" onclick="chartIntervallSetzen(this.dataset.iv)">' + iv + '</button>';
    }).join('') +
    '</div></div>' +
    '<div id="pd-chart" style="height:320px;background:var(--bg-primary);' +
    'border:1px solid var(--border);border-radius:6px;margin-bottom:4px"></div>' +
    '<p class="form-hint" id="pd-chart-quelle" style="margin-bottom:16px"></p>';

  h += '<div class="cards" style="margin-bottom:16px">' +
    kachel('Groesse', mengeKurz(p.total_size)) +
    kachel('Margin', p.total_margin != null ? geld(p.total_margin) : '–') +
    kachel('Hebel', (p.leverage || 1) + 'x') +
    kachel('Status', esc(p.status)) +
    '</div>';

  // --- Ergebnis ---
  h += ergebnisAbschnitt(d.ergebnis, p);

  // --- Verlauf: was ist tatsaechlich geschehen? ---
  if (d.verlauf) {
    h += '<h4 style="margin:16px 0 8px">Verlauf</h4>' +
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
      '<span style="font-size:16px">' + verlaufKette(d.verlauf) + '</span>' +
      ausgangAbzeichen(d.verlauf) +
      '</div>' +
      verlaufZeitleiste(d.verlauf);
  }

  if (m) {
    h += '<h4 style="margin:16px 0 8px">Ausfuehrungsstand</h4>' +
      '<div class="cards" style="margin-bottom:8px">' +
      kachel('Take-Profits', (m.tpsTriggered || 0) + ' / ' + (m.tpsTotal || 0)) +
      kachel('Offene Position', mengeKurz(m.remainingSize)) +
      kachel('Letzter Kurs', m.lastPrice != null ? Number(m.lastPrice).toFixed(2) : '–') +
      kachel('Stop-Loss', m.slCurrent != null
        ? Number(m.slCurrent).toFixed(2) + (m.trailingActive ? ' (trailing)' : '')
        : '–') +
      '</div>';
    if (m.errorCount) {
      h += '<p class="form-hint" style="color:var(--red)">Fehler bisher: ' + m.errorCount + '</p>';
    }
  }

  // --- Einstiege ---
  h += '<h4 style="margin:16px 0 8px">Einstiege</h4>';
  if (!entries.length) {
    h += '<p class="form-hint">keine</p>';
  } else {
    h += '<table style="width:100%"><thead><tr>' +
      '<th>Preis</th><th>Menge</th><th>Anteil</th><th>Art</th></tr></thead><tbody>';
    entries.forEach(function (e) {
      h += '<tr><td>' + Number(e.price).toFixed(2) + '</td>' +
        '<td>' + mengeKurz(e.size) + '</td>' +
        '<td>' + (e.percentage != null ? Number(e.percentage).toFixed(1) + ' %' : '–') + '</td>' +
        '<td>' + esc(e.order_type || 'limit') + '</td></tr>';
    });
    h += '</tbody></table>';
  }

  // --- Take-Profits ---
  h += '<h4 style="margin:16px 0 8px">Take-Profits</h4>';
  if (!tps.length) {
    h += '<p class="form-hint">keine</p>';
  } else {
    h += '<table style="width:100%"><thead><tr>' +
      '<th>Preis</th><th>Anteil</th><th>Erreicht</th><th>Besonderheit</th></tr></thead><tbody>';
    tps.forEach(function (t, i) {
      var erreicht = m && (m.tpsTriggered || 0) > i;
      var zustand = erreicht
        ? '<span style="color:var(--green)">✓ erreicht</span>'
        : '<span style="color:var(--text-muted)">offen</span>';

      var extra = [];
      if (t.sl_adjust) {
        extra.push('SL → ' + (t.sl_new_price != null ? Number(t.sl_new_price).toFixed(2) : '?'));
      }
      if (t.activate_trailing) {
        extra.push('Trailing' + (t.trailing_pct != null ? ' ' + t.trailing_pct + ' %' : ''));
      }

      h += '<tr><td>' + Number(t.price).toFixed(2) + '</td>' +
        '<td>' + (t.percentage != null ? t.percentage + ' %'
          : (t.size != null ? mengeKurz(t.size) : '–')) + '</td>' +
        '<td>' + zustand + '</td>' +
        '<td>' + (extra.length ? esc(extra.join(', ')) : '–') + '</td></tr>';
    });
    h += '</tbody></table>';

    if (m && (m.tpsTriggered || 0) > 0) {
      h += '<p class="form-hint">Nach dem ersten Take-Profit wird nicht mehr nachgekauft; ' +
        'offene Kauf-Limits wurden zurueckgenommen.</p>';
    }
  }

  // --- Stop-Loss ---
  h += '<h4 style="margin:16px 0 8px">Stop-Loss</h4>' +
    '<p>' + (p.stop_loss_price != null ? Number(p.stop_loss_price).toFixed(2) : 'keiner') +
    ' <span class="badge badge-default">' + esc(p.stop_loss_type || 'fixed') + '</span></p>';
  if (p.trailing_stop_pct != null) {
    h += '<p class="form-hint">Trailing ' + p.trailing_stop_pct + ' %' +
      (p.trailing_stop_activation != null
        ? ' ab ' + Number(p.trailing_stop_activation).toFixed(2) : '') + '</p>';
  }

  // --- Freigabe durch ein Signal (Weg A) ---
  if (trigger) {
    h += '<h4 style="margin:16px 0 8px">Wartet auf ein Signal</h4>' +
      '<pre class="code-block">' + esc(JSON.stringify(trigger, null, 2)) + '</pre>';
  }

  // --- Herkunft aus einem Signal (Weg B) ---
  if (herkunft) {
    h += '<h4 style="margin:16px 0 8px">Herkunft und Umrechnung</h4>' +
      '<table style="width:100%"><tbody>' +
      zeile('Strategie', esc(herkunft.strategy)) +
      zeile('Signal-Kennung', esc(herkunft.signal_id)) +
      zeile('Umrechnungsfaktor', Number(herkunft.factor).toFixed(4)) +
      zeile('Begrenzt durch', esc(herkunft.limited_by)) +
      zeile('Referenzkapital', geld(herkunft.reference_capital)) +
      zeile('Kontostand damals', geld(herkunft.capital_equity)) +
      zeile('Margin', geld(herkunft.reference_margin) + ' → ' + geld(herkunft.scaled_margin)) +
      zeile('Risiko am Stop-Loss', herkunft.scaled_risk != null
        ? geld(herkunft.reference_risk) + ' → ' + geld(herkunft.scaled_risk)
        : 'nicht bezifferbar — kein Stop-Loss im Signal') +
      '</tbody></table>' +
      '<p class="form-hint">Hebel, Stop-Loss, Take-Profits und Trailing stammen ' +
      'unveraendert aus dem Signal — umgerechnet wurde nur die Groesse.</p>';

    if (herkunft.warnings && herkunft.warnings.length) {
      h += '<p class="form-hint" style="color:#d4a017">' +
        herkunft.warnings.map(esc).join('<br>') + '</p>';
    }
  }

  // --- Abgeschickte Orders ---
  h += '<h4 style="margin:16px 0 8px">Abgeschickte Orders</h4>';
  if (!orders.length) {
    h += '<p class="form-hint">noch keine</p>';
  } else {
    h += '<table style="width:100%"><thead><tr>' +
      '<th>Rolle</th><th>Seite</th><th>Menge</th><th>Preis</th><th>Status</th><th>Zugang</th>' +
      '</tr></thead><tbody>';
    orders.forEach(function (o) {
      h += '<tr><td>' + esc(o.role) + '</td>' +
        '<td>' + esc(o.side) + '</td>' +
        '<td>' + mengeKurz(o.quantity) + '</td>' +
        '<td>' + (o.price != null ? Number(o.price).toFixed(2) : '–') + '</td>' +
        '<td><span class="badge badge-default">' + esc(o.status) + '</span></td>' +
        '<td>' + esc(o.broker) + '</td></tr>';
    });
    h += '</tbody></table>';
  }

  if (p.notes) {
    h += '<h4 style="margin:16px 0 8px">Notiz</h4>' +
      '<pre class="code-block" style="white-space:pre-wrap">' + esc(p.notes) + '</pre>';
  }

  return h;
}

// ============================================================
// Zellen der Plan-Uebersicht
// ============================================================

/**
 * Ergebnis in einer Tabellenzeile.
 *
 * Steht noch etwas im Markt, wird das nicht realisierte danebengesetzt —
 * sonst saehe ein Plan mit mitgenommenem Gewinn und laufendem Verlust
 * aus wie ein reiner Gewinner.
 */
function ergebnisZelle(p) {
  var e = p.ergebnis;

  // Plaene ohne eigene Ergebnisrechnung (Engine, local_plans) behalten
  // die bisherige Schaetzung aus Kurs und Durchschnittseinstieg.
  if (!e) return pnlAnzeige(p);

  if (!e.eingestiegen) return '<span style="color:var(--text-muted)">–</span>';

  var teile = [];
  if (e.realisiert) {
    teile.push('<span title="realisiert" style="color:' +
      (e.realisiert >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
      (e.realisiert >= 0 ? '+' : '') + geld(e.realisiert) + '</span>');
  }
  if (e.unrealisiert != null && e.offen > 0) {
    teile.push('<span title="nicht realisiert, ' + mengeKurz(e.offen) + ' offen" ' +
      'style="color:' + (e.unrealisiert >= 0 ? 'var(--green)' : 'var(--red)') +
      ';opacity:.75">(' + (e.unrealisiert >= 0 ? '+' : '') + geld(e.unrealisiert) + ')</span>');
  }

  if (!teile.length) return '<span style="color:var(--text-muted)">0,00</span>';
  return teile.join(' ');
}

/**
 * Warnt, wenn ein laufender Plan nicht unter Aufsicht steht.
 *
 * Ohne diesen Hinweis sieht ein unbeaufsichtigter Plan genauso aus wie
 * einer, bei dem nur noch kein Take-Profit griff — und niemand zieht
 * den Stop nach.
 */
function aufsichtHinweis(p) {
  if (p.ueberwacht !== false) return '';
  if (p.status === 'completed' || p.status === 'cancelled') return '';

  return ' <span class="badge badge-yellow" ' +
    'title="Der Bot ueberwacht diesen Plan nicht — es wird kein Stop nachgezogen und ' +
    'kein Take-Profit mitgenommen.">ohne Aufsicht</span>';
}

/** Die Schaltflaeche zum Beenden in einer Tabellenzeile. */
function beendenKnopf(p, vollplan) {
  if (!vollplan) return '';
  if (p.status === 'completed' || p.status === 'cancelled') return '';

  var offen = (p.ergebnis && p.ergebnis.offen) || 0;
  var beschriftung = offen > 0 ? 'Schliessen' : 'Abbrechen';
  var art = offen > 0 ? 'btn-danger' : 'btn-secondary';

  // stopPropagation: Die Zeile selbst oeffnet die Detailansicht. Ohne
  // das ginge beim Beenden gleichzeitig das Fenster auf.
  return '<button class="btn ' + art + '" style="padding:2px 8px;font-size:11px"' +
    ' data-plan="' + esc(p.id) + '" data-offen="' + offen + '"' +
    ' data-symbol="' + esc(p.symbol) + '"' +
    ' onclick="event.stopPropagation();' +
    'planBeenden(this.dataset.plan, Number(this.dataset.offen), this.dataset.symbol)">' +
    beschriftung + '</button>';
}

// ============================================================
// Einen Plan beenden
// ============================================================

/**
 * Die Schaltflaechen im Kopf der Detailansicht.
 *
 * Die Beschriftung richtet sich danach, was das Beenden tatsaechlich
 * ausloest: Steht eine Position im Markt, wird sie geschlossen — das
 * muss draufstehen, bevor jemand darauf drueckt.
 */
function planAktionenAufbauen(d) {
  var ziel = document.getElementById('pd-aktionen');
  if (!ziel) return;

  var p = d.plan;
  var beendet = p.status === 'completed' || p.status === 'cancelled';
  if (beendet) {
    ziel.innerHTML = '<span class="badge badge-default">beendet</span>';
    return;
  }

  var offen = (d.ergebnis && d.ergebnis.offen) || 0;
  var beschriftung = offen > 0 ? 'Position schliessen' : 'Plan abbrechen';
  var art = offen > 0 ? 'btn-danger' : 'btn-secondary';
  var hinweis = offen > 0
    ? 'Schliesst ' + mengeKurz(offen) + ' zu Markt und nimmt alle offenen Orders zurueck'
    : 'Nimmt alle offenen Orders zurueck und beendet den Plan';

  ziel.innerHTML = '<button class="btn ' + art + '" title="' + esc(hinweis) + '"' +
    ' data-plan="' + esc(p.id) + '" data-offen="' + offen + '"' +
    ' data-symbol="' + esc(p.symbol) + '"' +
    ' onclick="planBeenden(this.dataset.plan, Number(this.dataset.offen), this.dataset.symbol)">' +
    esc(beschriftung) + '</button>';
}

/**
 * Beendet einen Plan — nach ausdruecklicher Rueckfrage.
 *
 * Die Rueckfrage ist nicht Zierde: Steht eine Position im Markt, kostet
 * dieser Knopf Geld. Was genau geschieht, steht deshalb in der Frage,
 * und zwar mit Menge und Symbol.
 */
async function planBeenden(planId, offen, symbol) {
  var frage = offen > 0
    ? 'Position in ' + symbol + ' wirklich schliessen?\n\n' +
      mengeKurz(offen) + ' werden zu Markt verkauft bzw. zurueckgekauft, ' +
      'alle offenen Orders werden zurueckgenommen. Das laesst sich nicht rueckgaengig machen.'
    : 'Plan ' + symbol + ' wirklich abbrechen?\n\n' +
      'Alle offenen Orders werden zurueckgenommen.';

  if (!confirm(frage)) return;

  var knopf = document.querySelector('#pd-aktionen button');
  if (knopf) { knopf.disabled = true; knopf.textContent = 'Wird beendet …'; }

  try {
    var r = await apiFetch('/trade-plans/' + encodeURIComponent(planId) + '/beenden', {
      method: 'POST',
    });

    // apiFetch liefert bei einem Fehler null oder ein Objekt mit
    // `error`. Beides darf nicht als Erfolg durchgehen — sonst staende
    // der Plan in der Oberflaeche als beendet da, waehrend die Position
    // weiterlaeuft.
    if (!r || r.error) {
      throw new Error((r && (r.hinweis ? r.error + ' — ' + r.hinweis : r.error)) ||
        'Das Beenden ist fehlgeschlagen. Der Plan bleibt unter Aufsicht.');
    }

    var meldung = r.status === 'completed'
      ? 'Plan beendet — Position geschlossen'
      : 'Plan abgebrochen';
    if (r.stornierteOrders) {
      meldung += ', ' + r.stornierteOrders + ' Order(s) zurueckgenommen';
    }
    if (r.ergebnis && r.ergebnis.eingestiegen) {
      meldung += '. Ergebnis: ' + (r.ergebnis.gesamt >= 0 ? '+' : '') + geld(r.ergebnis.gesamt);
    }
    alert(meldung);

    planDetailSchliessen(true);
    planListenAktualisieren();
  } catch (e) {
    alert('Fehler: ' + ((e && e.message) || e));
    if (knopf) { knopf.disabled = false; }
    // Neu aufbauen, damit die Beschriftung wieder zum Stand passt.
    planDetailOeffnen(planId);
  }
}

/** Alle Ansichten neu laden, in denen ein Plan vorkommen kann. */
function planListenAktualisieren() {
  if (typeof updateDashboard === 'function') updateDashboard();
  if (typeof updatePlans === 'function') updatePlans();
  if (typeof updateTradePlans === 'function') updateTradePlans();
  if (typeof updateSignale === 'function') updateSignale();
}

function kachel(label, wert) {
  return '<div class="card"><div class="card-label">' + esc(label) + '</div>' +
    '<div class="card-value" style="font-size:18px">' + wert + '</div></div>';
}

/** Ein Betrag mit Vorzeichen und Farbe — gruen im Plus, rot im Minus. */
function betragGefaerbt(wert, waehrung) {
  if (wert == null || !isFinite(wert)) return '<span style="color:var(--text-muted)">–</span>';
  var farbe = wert > 0 ? 'var(--green)' : wert < 0 ? 'var(--red)' : '';
  var text = (wert > 0 ? '+' : '') + geld(wert) + (waehrung ? ' ' + waehrung : '');
  return '<span style="color:' + farbe + '">' + text + '</span>';
}

/**
 * Was der Plan eingebracht hat.
 *
 * Realisiert und nicht realisiert bleiben getrennt stehen: Das eine ist
 * verbucht, das andere haengt am aktuellen Kurs und kann sich bis zum
 * naechsten Hinsehen gedreht haben. Beides in eine Zahl zu werfen
 * verwischt genau diesen Unterschied.
 */
function ergebnisAbschnitt(e, plan) {
  if (!e) return '';

  // Nie eingestiegen — dann gibt es nichts zu zeigen ausser dem Grund.
  if (!e.eingestiegen) {
    return '<h4 style="margin:16px 0 8px">Ergebnis</h4>' +
      '<p class="form-hint">Noch kein Einstieg gefuellt — es steht nichts im Markt.</p>';
  }

  var waehrung = plan && plan.quote_currency ? plan.quote_currency : 'USDT';

  var h = '<h4 style="margin:16px 0 8px">Ergebnis</h4>' +
    '<div class="cards" style="margin-bottom:8px">' +
    kachel('Realisiert', betragGefaerbt(e.realisiert, waehrung)) +
    kachel('Nicht realisiert', e.unrealisiert != null
      ? betragGefaerbt(e.unrealisiert, waehrung)
      : '<span style="color:var(--text-muted)">–</span>') +
    kachel('Gesamt', betragGefaerbt(e.gesamt, waehrung)) +
    kachel('Rendite', e.renditePct != null
      ? betragGefaerbt(e.renditePct, '%')
      : '<span style="color:var(--text-muted)">–</span>') +
    '</div>';

  h += '<table style="width:100%"><tbody>' +
    zeile('Eingestiegen', mengeKurz(e.eingestiegen) +
      (e.einstiegsPreis != null ? ' zu ⌀ ' + Number(e.einstiegsPreis).toFixed(2) : '')) +
    zeile('Wieder geschlossen', mengeKurz(e.geschlossen)) +
    zeile('Noch offen', e.offen > 0
      ? mengeKurz(e.offen) + (e.kurs != null ? ' — Kurs ' + Number(e.kurs).toFixed(2) : '')
      : 'nichts') +
    zeile('Einsatz (Margin)', e.einsatz != null ? geld(e.einsatz) + ' ' + waehrung : '–') +
    zeile('Davon Gebuehren', e.gebuehren ? '-' + geld(e.gebuehren) +
      (e.waehrung ? ' ' + esc(e.waehrung) : '') : 'keine erfasst') +
    '</tbody></table>';

  h += '<p class="form-hint">Die Rechnung des Bots aus den abgeschickten Orders. ' +
    'Massgeblich fuer die Buchhaltung ist der Import des Journals direkt bei der Boerse — ' +
    'nur der kennt Teilfuellungen, Finanzierungskosten und den tatsaechlichen ' +
    'Ausfuehrungspreis.</p>';

  return h;
}

function zeile(label, wert) {
  return '<tr><td style="color:var(--text-muted);width:42%">' + esc(label) + '</td>' +
    '<td>' + wert + '</td></tr>';
}

function sicherJson(wert, ersatz) {
  if (wert == null) return ersatz;
  if (typeof wert === 'object') return wert;
  try { return JSON.parse(wert); } catch (e) { return ersatz; }
}

/** Menge ohne nachlaufende Nullen — 0.02500000 liest sich schlecht. */
function mengeKurz(wert) {
  if (wert == null || !isFinite(wert)) return '–';
  return String(Number(Number(wert).toFixed(8)));
}

function geld(betrag) {
  if (betrag == null || !isFinite(betrag)) return '–';
  return Number(betrag).toLocaleString('de-DE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// ============================================================
// Signal-Eingang und Uebungskonto
// ============================================================

async function updateSignale() {
  await Promise.all([signalBuchLaden(), uebungskontoLaden()]);
}

async function signalBuchLaden() {
  var filter = document.getElementById('sig-filter');
  var pfad = '/signals?limit=100' +
    (filter && filter.value ? '&status=' + encodeURIComponent(filter.value) : '');

  try {
    var d = await apiFetch(pfad);
    var body = document.getElementById('sig-body');
    if (!body) return;

    if (!d || !d.signals || !d.signals.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty-state">Noch kein Signal eingegangen</td></tr>';
      return;
    }

    body.innerHTML = d.signals.map(function (s) {
      var sc = s.scaling || {};
      var warnungen = Array.isArray(s.warnings) ? s.warnings : [];
      var grund = s.reason || (warnungen.length ? warnungen.join(' · ') : '');

      // Angelegte Plaene lassen sich von hier aus oeffnen.
      var klickbar = s.created_plan_id
        ? ' style="cursor:pointer" title="Plan anzeigen" data-plan="' + esc(s.created_plan_id) + '"' +
          ' onclick="planDetailOeffnen(this.dataset.plan)"'
        : '';

      var v = s.verlauf;

      return '<tr' + klickbar + '>' +
        '<td>' + esc(zeitKurz(s.received_at)) + '</td>' +
        '<td>' + esc(s.strategy || '–') + '</td>' +
        '<td><strong>' + esc(s.symbol || '–') + '</strong></td>' +
        '<td>' + esc(s.action || '–') + '</td>' +
        '<td>' + signalStatusAbzeichen(s.status) + '</td>' +
        '<td>' + verlaufKette(v) + '</td>' +
        '<td>' + ausgangAbzeichen(v) + '</td>' +
        '<td>' + (sc.factor != null ? Number(sc.factor).toFixed(4) : '–') + '</td>' +
        '<td>' + (sc.scaledMargin != null ? geld(sc.scaledMargin) : '–') + '</td>' +
        '<td>' + (sc.scaledRisk != null ? geld(sc.scaledRisk) : '–') + '</td>' +
        '<td style="max-width:280px;font-size:12px;color:var(--text-muted)">' + esc(grund) + '</td>' +
        '</tr>';
    }).join('');
  } catch (e) {
    console.error('[Signale]', e);
  }
}

/**
 * Abzeichen je Ausgang.
 *
 * Die abgelehnten sind die interessanten: An der Boerse hinterlassen sie
 * keine Spur, und ohne diese Anzeige liesse sich nicht sagen, warum ein
 * Trade ausblieb.
 */
function signalStatusAbzeichen(status) {
  switch (status) {
    case 'accepted':         return '<span class="badge badge-green">angenommen</span>';
    case 'duplicate':        return '<span class="badge badge-default">Wiederholung</span>';
    case 'no_match':         return '<span class="badge badge-yellow">ohne Treffer</span>';
    case 'rejected_schema':  return '<span class="badge badge-red">inhaltlich</span>';
    case 'rejected_scaling': return '<span class="badge badge-red">Umrechnung</span>';
    case 'rejected_risk':    return '<span class="badge badge-red">Risikogrenze</span>';
    case 'rejected_auth':    return '<span class="badge badge-red">Herkunft</span>';
    default:                 return '<span class="badge badge-default">' + esc(status || '?') + '</span>';
  }
}

// ============================================================
// Verlauf eines Trades
//
// Die Kette "E1+E2 → TP1 → SL↑" beantwortet die Frage, auf die es bei
// der Beurteilung eines Signalgebers ankommt: Wurde der Gewinn
// mitgenommen, bevor der Stop kam?
// ============================================================

/** Die Kette, eingefaerbt nach dem, was zuletzt geschah. */
function verlaufKette(v) {
  if (!v || !v.kette || v.kette === '–') {
    return '<span style="color:var(--text-muted)">–</span>';
  }

  var teile = v.kette.split(' → ').map(function (schritt) {
    var farbe = 'var(--text-secondary)';
    if (schritt.indexOf('TP') === 0) farbe = 'var(--green)';
    else if (schritt === 'SL') farbe = 'var(--red)';
    else if (schritt === 'SL↑') farbe = 'var(--green)';
    else if (schritt === 'TS') farbe = 'var(--accent)';
    return '<span style="color:' + farbe + '">' + esc(schritt) + '</span>';
  });

  return '<span style="font-family:monospace;font-size:12px;white-space:nowrap">' +
    teile.join('<span style="color:var(--text-muted)"> → </span>') + '</span>';
}

/**
 * Der Ausgang in einem Wort.
 *
 * Die Unterscheidung, die zaehlt: Ein Stop NACH einem Take-Profit ist
 * ein guter Ausgang — der Gewinn war schon gesichert. Ein Stop ohne
 * vorherigen Take-Profit ist der schlechte Fall.
 */
function ausgangAbzeichen(v) {
  if (!v) return '<span style="color:var(--text-muted)">–</span>';

  switch (v.ausgang) {
    case 'vollstaendig':
      return '<span class="badge badge-green" title="Alle Take-Profits erreicht">vollstaendig</span>';
    case 'im_gewinn_beendet':
      return '<span class="badge badge-green" title="Take-Profit erreicht, danach beendet">im Gewinn</span>';
    case 'im_verlust_beendet':
      return '<span class="badge badge-red" title="Stop-Loss ohne vorherigen Take-Profit">im Verlust</span>';
    case 'laeuft':
      return '<span class="badge badge-blue">laeuft</span>';
    case 'storniert':
      return '<span class="badge badge-default">storniert</span>';
    case 'nichts_geschehen':
      return '<span class="badge badge-yellow" title="Kein Einstieg kam zustande">ohne Einstieg</span>';
    default:
      return '<span style="color:var(--text-muted)">–</span>';
  }
}

/** Zeitleiste fuer die Detailansicht. */
function verlaufZeitleiste(v) {
  if (!v || !v.ereignisse || !v.ereignisse.length) {
    return '<p class="form-hint">Noch ist nichts geschehen.</p>';
  }

  var zeichen = {
    einstieg: '▼', tp: '✓', sl_nachgezogen: '↑',
    trailing: '↗', sl: '■', storniert: '✂', abgelehnt: '✗',
  };
  var farben = {
    einstieg: 'var(--accent)', tp: 'var(--green)', sl_nachgezogen: 'var(--green)',
    trailing: 'var(--accent)', sl: 'var(--red)',
    storniert: 'var(--text-muted)', abgelehnt: 'var(--text-muted)',
  };

  var h = '<div style="border-left:2px solid var(--border);margin-left:8px;padding-left:16px">';
  v.ereignisse.forEach(function (e) {
    var farbe = farben[e.art] || 'var(--text-secondary)';
    h += '<div style="margin:0 0 12px -25px;display:flex;gap:10px;align-items:flex-start">' +
      '<span style="color:' + farbe + ';width:18px;text-align:center;flex-shrink:0">' +
      (zeichen[e.art] || '•') + '</span>' +
      '<div style="flex:1">' +
      '<div style="color:' + farbe + '">' + esc(e.text) + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted)">' + esc(zeitKurz(e.zeitpunkt)) + '</div>' +
      '</div></div>';
  });
  h += '</div>';
  return h;
}

function zeitKurz(wert) {
  if (!wert) return '–';
  // SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC, ohne Zonenangabe.
  var roh = String(wert).indexOf('T') >= 0 ? wert : String(wert).replace(' ', 'T') + 'Z';
  var d = new Date(roh);
  if (isNaN(d.getTime())) return String(wert);
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

async function uebungskontoLaden() {
  try {
    var d = await apiFetch('/uebungskonto');
    if (!d || !d.stand) return;

    var s = d.stand;
    var k = d.kennzahlen || {};

    var hinweis = document.getElementById('sig-uebungshinweis');
    if (hinweis) hinweis.style.display = d.uebungsbetrieb ? 'inline-flex' : 'none';

    setText('uk-equity', geld(s.equity) + ' ' + s.waehrung);
    setText('uk-equity-sub', 'Start: ' + geld(s.startkapital));

    var erg = k.ergebnis != null ? k.ergebnis : 0;
    var el = document.getElementById('uk-ergebnis');
    if (el) {
      el.textContent = (erg >= 0 ? '+' : '') + geld(erg);
      el.style.color = erg >= 0 ? 'var(--green)' : 'var(--red)';
    }
    setText('uk-ergebnis-sub', k.ergebnis_prozent != null
      ? (k.ergebnis_prozent >= 0 ? '+' : '') + k.ergebnis_prozent.toFixed(2) + ' %'
      : '');

    setText('uk-gebuehren', geld(s.gebuehren));
    setText('uk-gebuehren-sub', d.gebuehren
      ? 'Taker ' + d.gebuehren.taker_prozent.toFixed(3) + ' % · Maker ' +
        d.gebuehren.maker_prozent.toFixed(3) + ' %'
      : '');

    setText('uk-trades', String(s.trades));
    setText('uk-trefferquote', k.trefferquote != null
      ? k.trefferquote.toFixed(0) + ' % Treffer (' + s.gewinne + ' / ' + s.verluste + ')'
      : 'noch kein abgeschlossener Trade');

    setText('uk-gebunden', geld(s.gebunden) + ' / ' + geld(s.frei));

    // Einstellfelder vorbelegen, aber eine laufende Eingabe nicht ueberschreiben.
    var t = document.getElementById('uk-taker');
    var mk = document.getElementById('uk-maker');
    if (t && d.gebuehren && t.value === '') t.value = d.gebuehren.taker_prozent.toFixed(4);
    if (mk && d.gebuehren && mk.value === '') mk.value = d.gebuehren.maker_prozent.toFixed(4);

    await kontoblattLaden();
  } catch (e) {
    console.error('[Uebungskonto]', e);
  }
}

async function kontoblattLaden() {
  try {
    var d = await apiFetch('/uebungskonto/buchungen?limit=60');
    var body = document.getElementById('uk-ledger');
    if (!body) return;

    if (!d || !d.buchungen || !d.buchungen.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state">Keine Buchungen</td></tr>';
      return;
    }

    body.innerHTML = d.buchungen.map(function (b) {
      var farbe = b.betrag > 0 ? 'var(--green)'
        : b.betrag < 0 ? 'var(--red)' : 'var(--text-muted)';
      return '<tr>' +
        '<td>' + esc(zeitKurz(b.zeitpunkt)) + '</td>' +
        '<td>' + buchungsAbzeichen(b.art) + '</td>' +
        '<td>' + esc(b.symbol || '–') + '</td>' +
        '<td>' + mengeKurz(b.menge) + '</td>' +
        '<td>' + (b.preis != null ? Number(b.preis).toFixed(2) : '–') + '</td>' +
        '<td style="color:' + farbe + '">' + (b.betrag > 0 ? '+' : '') + geld(b.betrag) + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted)">' + esc(b.notiz || '') + '</td>' +
        '</tr>';
    }).join('');
  } catch (e) {
    console.error('[Kontoblatt]', e);
  }
}

function buchungsAbzeichen(art) {
  switch (art) {
    case 'gewinn':         return '<span class="badge badge-green">Gewinn</span>';
    case 'verlust':        return '<span class="badge badge-red">Verlust</span>';
    case 'gebuehr':        return '<span class="badge badge-default">Gebuehr</span>';
    case 'einzahlung':     return '<span class="badge badge-blue">Einzahlung</span>';
    case 'zuruecksetzung': return '<span class="badge badge-yellow">Zuruecksetzung</span>';
    case 'verworfen':      return '<span class="badge badge-red">verworfen</span>';
    default:               return '<span class="badge badge-default">' + esc(art) + '</span>';
  }
}

// ============================================================
// Einstellungen: Uebungskonto, Gebuehren, Risikoprofil
// ============================================================

async function uebungskontoZuruecksetzen() {
  var feld = document.getElementById('uk-neues-kapital');
  var betrag = feld ? Number(feld.value) : NaN;

  if (!isFinite(betrag) || betrag <= 0) {
    alert('Bitte ein Startkapital groesser als 0 eingeben.');
    return;
  }
  if (!confirm('Das Uebungskonto wird auf ' + geld(betrag) + ' zurueckgesetzt.\n\n' +
      'Handelsgeschichte und Kontoblatt werden dabei verworfen. Fortfahren?')) {
    return;
  }

  try {
    var r = await apiFetch('/uebungskonto/zuruecksetzen', {
      method: 'POST', body: JSON.stringify({ startkapital: betrag }),
    });
    if (r && r.success) {
      if (feld) feld.value = '';
      alert('Uebungskonto steht jetzt bei ' + geld(r.stand.equity) + ' ' + r.stand.waehrung + '.');
      await uebungskontoLaden();
    } else {
      alert('Fehlgeschlagen: ' + ((r && r.error) || 'unbekannter Grund'));
    }
  } catch (e) {
    alert('Fehlgeschlagen: ' + ((e && e.message) || e));
  }
}

async function uebungskontoEinzahlen() {
  var feld = document.getElementById('uk-einzahlung');
  var betrag = feld ? Number(feld.value) : NaN;

  if (!isFinite(betrag) || betrag === 0) {
    alert('Bitte einen Betrag ungleich 0 eingeben — negativ fuer eine Abhebung.');
    return;
  }

  try {
    var r = await apiFetch('/uebungskonto/einzahlung', {
      method: 'POST', body: JSON.stringify({ betrag: betrag }),
    });
    if (r && r.success) {
      if (feld) feld.value = '';
      await uebungskontoLaden();
    } else {
      alert('Fehlgeschlagen: ' + ((r && r.error) || 'unbekannter Grund'));
    }
  } catch (e) {
    alert('Fehlgeschlagen: ' + ((e && e.message) || e));
  }
}

async function gebuehrenSpeichern() {
  var t = document.getElementById('uk-taker');
  var m = document.getElementById('uk-maker');

  var nutzlast = {};
  if (t && t.value !== '') nutzlast.taker_prozent = Number(t.value);
  if (m && m.value !== '') nutzlast.maker_prozent = Number(m.value);

  if (!Object.keys(nutzlast).length) {
    alert('Nichts einzutragen.');
    return;
  }

  try {
    var r = await apiFetch('/uebungskonto/gebuehren', {
      method: 'PUT', body: JSON.stringify(nutzlast),
    });
    if (r && r.success) {
      alert('Gebuehren gesetzt: Taker ' + r.gebuehren.taker_prozent.toFixed(3) +
        ' %, Maker ' + r.gebuehren.maker_prozent.toFixed(3) + ' %.');
      await uebungskontoLaden();
    } else {
      alert('Fehlgeschlagen: ' + ((r && r.error) || '') +
        (r && r.details ? '\n' + r.details.join('\n') : ''));
    }
  } catch (e) {
    alert('Fehlgeschlagen: ' + ((e && e.message) || e));
  }
}

async function risikoprofilLaden() {
  try {
    var d = await apiFetch('/signals/einstellungen');
    if (!d || !d.risikoprofil) return;
    var p = d.risikoprofil;

    setzeWert('rp-capital-fraction', p.capitalFraction);
    setzeWert('rp-multiplier', p.multiplier);
    setzeWert('rp-max-risk', p.maxRiskPerTradePct * 100);
    setzeWert('rp-max-margin', p.maxMarginPerTradePct * 100);
    setzeWert('rp-free-margin', p.usableFreeMarginPct * 100);
    setzeWert('rp-min-remaining', p.minRemainingFraction * 100);

    var sel = document.getElementById('rp-below-min');
    if (sel) sel.value = p.belowMinimum || 'drop';
  } catch (e) {
    // Die uebrigen Einstellungen sollen trotzdem erscheinen.
  }
}

function setzeWert(id, wert) {
  var el = document.getElementById(id);
  if (el && wert != null && isFinite(wert)) {
    el.value = String(Number(Number(wert).toFixed(4)));
  }
}

async function risikoprofilSpeichern() {
  var lies = function (id, teiler) {
    var el = document.getElementById(id);
    if (!el || el.value === '') return undefined;
    var n = Number(el.value);
    return isFinite(n) ? n / (teiler || 1) : undefined;
  };

  var nutzlast = {};
  var felder = [
    ['capitalFraction', 'rp-capital-fraction', 1],
    ['multiplier', 'rp-multiplier', 1],
    ['maxRiskPerTradePct', 'rp-max-risk', 100],
    ['maxMarginPerTradePct', 'rp-max-margin', 100],
    ['usableFreeMarginPct', 'rp-free-margin', 100],
    ['minRemainingFraction', 'rp-min-remaining', 100],
  ];
  felder.forEach(function (f) {
    var w = lies(f[1], f[2]);
    if (w !== undefined) nutzlast[f[0]] = w;
  });

  var sel = document.getElementById('rp-below-min');
  if (sel) nutzlast.belowMinimum = sel.value;

  try {
    var r = await apiFetch('/signals/risikoprofil', {
      method: 'PUT', body: JSON.stringify(nutzlast),
    });
    if (r && r.success) {
      alert('Risikoprofil gespeichert. Es gilt ab dem naechsten Signal.');
    } else {
      alert('Fehlgeschlagen: ' + ((r && r.error) || '') +
        (r && r.details ? '\n' + r.details.join('\n') : ''));
    }
  } catch (e) {
    alert('Fehlgeschlagen: ' + ((e && e.message) || e));
  }
}
