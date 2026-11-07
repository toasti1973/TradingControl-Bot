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
 * Wieviele Teil-Einstiege sind tatsaechlich ausgefuehrt?
 *
 * Die Gegenfrage zum Take-Profit-Fortschritt und in der Einstiegsphase
 * die wichtigere: Ein Plan mit vier gestaffelten Limits steht nach dem
 * ersten Fill mit einem Viertel im Markt — das Dashboard zeigte davon
 * bisher nichts und liess einen angefangenen Trade aussehen wie einen,
 * bei dem noch gar nichts geschah.
 *
 * Gezaehlt wird aus den abgeschickten Orders (p.ergebnis), nicht aus
 * dem Plan: Nur sie wissen, was wirklich gefuellt wurde.
 */
function einstiegZelle(p) {
  var e = p.ergebnis;
  if (!e) return '<span style="color:var(--text-muted)">–</span>';

  var gefuellt = e.einstiegeGefuellt || 0;
  // Was der Plan vorsah, ist die ehrlichere Bezugsgroesse: Nach einem
  // Take-Profit werden offene Kauf-Limits zurueckgenommen, die Zahl der
  // abgeschickten Orders saenke sonst nachtraeglich.
  var gesamt = p.entries_geplant || e.einstiegeAbgeschickt || 0;
  if (!gesamt) return '<span style="color:var(--text-muted)">–</span>';

  var farbe = gefuellt === 0 ? 'var(--text-muted)'
    : gefuellt >= gesamt ? 'var(--green)' : 'var(--accent)';

  var punkte = '';
  for (var i = 0; i < gesamt; i++) {
    punkte += '<span style="color:' + (i < gefuellt ? farbe : 'var(--border)') + '">▮</span>';
  }

  var hinweis = gefuellt + ' von ' + gesamt + ' Einstiegen ausgefuehrt';
  if (e.einstiegsPreis != null && gefuellt > 0) {
    hinweis += ' — ø ' + Number(e.einstiegsPreis).toFixed(4) +
      ', ' + mengeKurz(e.eingestiegen) + ' gekauft';
  }

  return '<span title="' + esc(hinweis) + '">' + punkte +
    ' <span style="color:' + farbe + ';font-size:12px">E ' + gefuellt + '/' + gesamt +
    '</span></span>';
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
  offenerPlan = null;

  // Die Schaltflaechen leeren: Sie gehoeren zu dem Plan, der eben offen
  // war. Blieben sie stehen, traefe der naechste Klick einen anderen.
  var aktionen = document.getElementById('pd-aktionen');
  if (aktionen) aktionen.innerHTML = '';

  // Den Chart abbauen, sonst bleibt seine Zeichenflaeche im Speicher
  // liegen — bei jedem Oeffnen eine weitere. Und die Plan-Kennung
  // mit, sonst fuehrte der naechste Durchlauf den Chart eines
  // geschlossenen Fensters nach.
  if (typeof chartVergessen === 'function') chartVergessen();
  else if (typeof chartAufraeumen === 'function') chartAufraeumen();
}

/**
 * Welcher Plan gerade in der Detailansicht steht.
 *
 * Daran haengt das Nachladen: Alle zehn Sekunden werden die Zahlen
 * dieses Plans erneuert — ohne den Chart anzuruehren, der sonst im
 * Sekundentakt neu zeichnete.
 */
var offenerPlan = null;

async function planDetailOeffnen(planId) {
  var overlay = document.getElementById('plan-detail-overlay');
  var body = document.getElementById('pd-body');
  if (!overlay || !body) return;

  overlay.style.display = 'flex';
  body.innerHTML = '<div class="empty-state">Wird geladen …</div>';
  offenerPlan = planId;

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

/**
 * Frischt die offene Detailansicht auf.
 *
 * Neu gezeichnet wird nur, was sich aendert: die Kennzahlen, die drei
 * Tabellen und der Stop-Loss-Abschnitt. Der Chart bleibt unberuehrt —
 * ihn mitzuzeichnen hiesse, ihn alle zehn Sekunden neu zu laden, samt
 * verlorener Zoomstufe und sichtbarem Aufblitzen.
 */
async function planDetailAktualisieren() {
  if (!offenerPlan) return;
  var overlay = document.getElementById('plan-detail-overlay');
  if (!overlay || overlay.style.display === 'none') return;

  // Noch im Aufbau? Dann gibt es nichts aufzufrischen.
  if (!document.getElementById('pd-einstiege-body')) return;

  var d;
  try {
    d = await apiFetch('/trade-plans/' + encodeURIComponent(offenerPlan));
  } catch (e) {
    return;   // Eine misslungene Abfrage darf die Ansicht nicht leeren.
  }
  if (!d || !d.plan) return;

  // Zwischen Abfrage und Antwort kann der Nutzer geschlossen oder einen
  // anderen Plan geoeffnet haben.
  if (!offenerPlan || d.plan.id !== offenerPlan) return;

  var p = d.plan;
  var m = d.monitor;
  var orders = d.orders || [];

  tabelleZeichnen(document.getElementById('pd-einstiege-body'),
    einstiegsZeilen(sicherJson(p.entry_orders, []), orders));
  tabelleZeichnen(document.getElementById('pd-tps-body'),
    tpZeilen(sicherJson(p.take_profits, []), orders, m));
  tabelleZeichnen(document.getElementById('pd-orders-body'),
    ordersZeilen(orders, p));

  abschnittErsetzen('pd-sl', slAbschnitt(p, m, orders));
  abschnittErsetzen('pd-tp-hinweis', tpHinweis(orders));
  abschnittErsetzen('pd-kennzahlen', kennzahlenKacheln(p, d.ergebnis));
  abschnittErsetzen('pd-ergebnis', ergebnisAbschnitt(d.ergebnis, p));
  abschnittErsetzen('pd-stand', ausfuehrungsstand(m));
  abschnittErsetzen('pd-verlauf', verlaufAbschnitt(d.verlauf));

  // Die Schaltflaechen im Kopf richten sich nach dem Stand: Aus
  // "Position schliessen" wird "Abbrechen", sobald nichts mehr offen
  // ist — und bei einem beendeten Plan verschwinden sie.
  planAktionenAufbauen(d);

  // Und zuletzt der Chart. Er wird seltener geholt als der Rest (der
  // Dienst haelt die Kerzen 30 s vor) und behaelt dabei Zoomstufe und
  // Bildausschnitt — awaited, damit ein Fehler darin nicht als
  // unbeobachtete Promise verschwindet.
  if (typeof chartMitfuehren === 'function') {
    try {
      await chartMitfuehren();
    } catch (e) {
      console.error('[refresh:chart]', e);
    }
  }
}

/**
 * Tauscht den Inhalt eines Bereichs aus, wenn er sich geaendert hat.
 *
 * Unveraendert heisst: nichts anfassen. Sonst verlöre man bei jedem
 * Durchlauf die Textauswahl und saehe die Seite zucken.
 */
function abschnittErsetzen(id, html) {
  var el = document.getElementById(id);
  if (!el || el.innerHTML === html) return;
  el.innerHTML = html;
}

/**
 * Die Kacheln ueber dem Ergebnis.
 *
 * Groesse und Margin nennen, was WIRKLICH im Markt steht — mit dem
 * geplanten Wert als Bezug daneben.
 *
 * Bis zum 26.10. zeigten beide den Planwert allein. Bei einem
 * SOLUSDT-Short mit vier gestaffelten Einstiegen, von denen drei
 * fuellten, stand oben "Margin 1.009,99" und unten in derselben
 * Ansicht "Einsatz (Margin) 756,49" — zwei Zahlen, beide "Margin"
 * genannt, um ein Viertel auseinander. Eine Ansicht, die den Plan
 * zeigt, wo nach dem Stand gefragt ist, meldet ein Ergebnis und misst
 * sich dabei selbst.
 */
function kennzahlenKacheln(p, ergebnis) {
  // Der Durchschnittseinstieg gehoert nach oben.
  //
  // Er stand bisher nur unten in der Ergebnistabelle — dabei ist er
  // die Zahl, gegen die man den Kurs im Chart liest: Steht er darueber
  // oder darunter, und wie weit? Bei einem gestaffelten Einstieg
  // wandert er zudem mit jedem gefuellten Teil.
  var hatEinstieg = ergebnis && ergebnis.einstiegsPreis != null;

  var einstieg = hatEinstieg
    ? preis(ergebnis.einstiegsPreis)
    : '<span style="color:var(--text-muted)">noch keiner</span>';

  return '<div class="cards" style="margin-bottom:16px">' +
    kachel('Groesse', groesseWert(p, ergebnis), groesseZusatz(p, ergebnis)) +
    kachel('ø Einstieg', einstieg, kursZeile(p, ergebnis)) +
    kachel('Margin', marginWert(p, ergebnis), marginZusatz(p, ergebnis)) +
    kachel('Hebel', (p.leverage || 1) + 'x') +
    kachel('Status', esc(p.status)) +
    '</div>';
}

/** Die Einheit der Menge — SOL, BTC … Ohne sie bleibt "88,69" zahllos. */
function einheit(p) {
  return (p && p.asset_symbol) ? ' <span style="font-size:12px;color:var(--text-muted)">' +
    esc(p.asset_symbol) + '</span>' : '';
}

/** Wieviele Teil-Einstiege sieht der Plan vor? */
function einstiegeGeplant(p) {
  var liste = sicherJson(p && p.entry_orders, []);
  return Array.isArray(liste) ? liste.length : 0;
}

/**
 * Die Groesse: eingestiegen, nicht geplant.
 *
 * Die Frage an dieser Kachel ist "wieviel liegt im Markt?" — und
 * darauf antwortet der Plan nicht. Er sagt nur, wieviel es werden
 * sollte.
 */
function groesseWert(p, e) {
  if (e && e.eingestiegen > 0) return mengeKurz(e.eingestiegen) + einheit(p);
  return '<span style="color:var(--text-muted)">noch nichts</span>';
}

function groesseZusatz(p, e) {
  var geplant = (p.total_size != null)
    ? 'von ' + mengeKurz(p.total_size) + ' geplant'
    : 'kein Planwert';

  if (!e || !e.eingestiegen) {
    return '<span style="color:var(--text-muted)">' + geplant + '</span>';
  }

  var teile = [geplant];
  if (e.offen > 0) teile.push(mengeKurz(e.offen) + ' noch offen');
  else teile.push('nichts mehr offen');

  return '<span style="color:var(--text-muted)">' + teile.join(' · ') + '</span>';
}

/**
 * Die Margin: eingesetzt, nicht geplant.
 *
 * Gezeigt wird `ergebnis.einsatz` — die Margin der tatsaechlich
 * gefuellten Einstiege. Sie ist dieselbe Zahl, die unten in der
 * Ergebnistabelle als "Einsatz (Margin)" steht und auf die sich die
 * Rendite bezieht.
 */
function marginWert(p, e) {
  if (e && e.einsatz != null) {
    return geld(e.einsatz) +
      '<span style="font-size:12px;color:var(--text-muted)"> ' + esc(waehrungVon(p)) + '</span>';
  }
  return '<span style="color:var(--text-muted)">noch keine</span>';
}

function marginZusatz(p, e) {
  var teile = [];

  teile.push(p.total_margin != null
    ? 'von ' + geld(p.total_margin) + ' geplant'
    : 'kein Planwert');

  // Woher die Luecke kommt: nicht jeder Einstieg wurde gefuellt.
  var geplant = einstiegeGeplant(p);
  if (geplant > 0 && e) {
    teile.push((e.einstiegeGefuellt || 0) + ' von ' + geplant + ' Einstiegen');
  }

  // Was davon gerade noch gebunden ist — nach einem Take-Profit ist
  // ein Teil wieder frei, und das ist nicht dieselbe Zahl.
  if (e && e.einsatzOffen != null && e.einsatz != null &&
      Math.abs(e.einsatzOffen - e.einsatz) > 0.01) {
    teile.push(geld(e.einsatzOffen) + ' noch gebunden');
  }

  return '<span style="color:var(--text-muted)">' + teile.join(' · ') + '</span>';
}

function waehrungVon(p) {
  return (p && p.quote_currency) ? p.quote_currency : 'USDT';
}

/**
 * Der aktuelle Kurs unter dem Durchschnittseinstieg.
 *
 * Der Abstand zwischen beiden IST das schwebende Ergebnis je Einheit —
 * ihn abzulesen erspart das Kopfrechnen. Die Farbe richtet sich nach
 * der Richtung: Beim Short ist ein Kurs UNTER dem Einstieg die gute
 * Nachricht.
 */
function kursZeile(p, ergebnis) {
  var kurs = ergebnis && ergebnis.kurs;
  var einstieg = ergebnis && ergebnis.einstiegsPreis;

  if (kurs == null || !isFinite(kurs)) {
    return '<span style="color:var(--text-muted)">kein Kurs</span>';
  }
  if (einstieg == null) {
    return '<span style="color:var(--text-muted)">Kurs ' + preis(kurs) + '</span>';
  }

  var abstand = kurs - einstieg;
  var guenstig = p.direction === 'short' ? abstand < 0 : abstand > 0;
  var farbe = Math.abs(abstand) < 1e-12
    ? 'var(--text-muted)'
    : (guenstig ? 'var(--green)' : 'var(--red)');

  var prozent = einstieg !== 0 ? (abstand / einstieg) * 100 : 0;

  return '<span style="color:var(--text-muted)">Kurs</span> ' +
    '<span style="color:var(--text-primary)">' + preis(kurs) + '</span> ' +
    '<span style="color:' + farbe + '">' +
    (abstand >= 0 ? '+' : '') + preis(abstand) +
    ' (' + (prozent >= 0 ? '+' : '') + prozent.toFixed(2) + ' %)</span>';
}

/**
 * Wie der Markt beim Signaleingang stand.
 *
 * Die Frage, die ein Signal beurteilt, BEVOR es gehandelt wurde: Lagen
 * die Einstiege ueberhaupt in Reichweite? Ein Indikator, der seine
 * Staffel auf einen Kurs rechnet, der beim Senden schon
 * Viertelstunden zurueckliegt, laesst sich an seinen Trades nicht
 * beurteilen — er hat gar keine.
 */
function signallageHinweis(herkunft) {
  var l = herkunft && herkunft.marktlage;
  if (!l || l.kurs == null) return '';

  var pct = Number(l.abstandPct);
  var zeit = l.gemessenAm ? zeitKurz(l.gemessenAm) : '';

  // Der Kurs ist durch die ganze Staffel hindurch — ohne Umkehr
  // kommt dieser Trade nicht mehr zustande.
  if (l.ausserhalb) {
    return '<p class="form-hint" style="color:var(--red)">' +
      'Beim Signaleingang (' + esc(zeit) + ') stand der Kurs bei ' + preis(l.kurs) +
      ' — <strong>jenseits aller Einstiege</strong>. Ohne Umkehr kommt dieser ' +
      'Trade nicht zustande.</p>';
  }

  var farbe = pct > 1 ? 'var(--yellow)' : 'var(--text-muted)';
  var wertung = pct > 1
    ? ' — das ist weit; der Kurs muss sich erst zurueckbewegen'
    : '';

  return '<p class="form-hint" style="color:' + farbe + '">' +
    'Beim Signaleingang (' + esc(zeit) + ') stand der Kurs bei ' + preis(l.kurs) +
    ', ' + pct.toFixed(2) + ' % vom naechsten Einstieg (' +
    preis(l.naechsterEinstieg) + ') entfernt' + wertung + '.</p>';
}

/** Was tatsaechlich geschah, als Kette und Zeitleiste. */
function verlaufAbschnitt(verlauf) {
  if (!verlauf) return '';
  return '<h4 style="margin:16px 0 8px">Verlauf</h4>' +
    '<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
    '<span style="font-size:16px">' + verlaufKette(verlauf) + '</span>' +
    ausgangAbzeichen(verlauf) +
    '</div>' +
    verlaufZeitleiste(verlauf);
}

/**
 * Wieviele Take-Profits kennt dieser Monitor, und wieviele griffen?
 *
 * Die Detailansicht bekommt den ROHEN Monitor-Zustand mit `tpState`
 * als Liste; die Uebersicht bekommt die aufbereitete Form mit
 * `tpsTriggered`/`tpsTotal`. Hier wird beides gelesen — sonst stand in
 * der Detailansicht "0 / 0", waehrend der Monitor vier Ziele fuehrte.
 */
function tpStand(m) {
  if (!m) return { erreicht: 0, gesamt: 0 };

  if (Array.isArray(m.tpState)) {
    return {
      erreicht: m.tpState.filter(function (t) { return t && t.triggered; }).length,
      gesamt: m.tpState.length,
    };
  }
  return { erreicht: m.tpsTriggered || 0, gesamt: m.tpsTotal || 0 };
}

/**
 * Wie alt ist der Kurs, auf dem das nicht realisierte Ergebnis steht?
 *
 * Antwortet die Boerse nicht mehr, ueberspringt der Monitor den
 * Durchlauf und `lastPrice` bleibt stehen. Das nicht realisierte
 * Ergebnis daneben rechnet weiter mit diesem Kurs — und sieht dabei
 * aus wie eine laufende Zahl. Ein eingefrorener Kurs und ein ruhiger
 * Markt sind in der Anzeige nicht zu unterscheiden; hier werden sie es.
 */
function kursAlterHinweis(m) {
  if (!m || m.lastPrice == null) return '';

  if (m.lastPriceAt == null) {
    return '<span style="color:var(--yellow)" title="Der Kurs stammt aus der ' +
      'Datenbank — wann er gemessen wurde, ist nicht festgehalten. Der naechste ' +
      'Durchlauf holt einen frischen.">Alter unbekannt</span>';
  }

  var sekunden = Math.round((Date.now() - Number(m.lastPriceAt)) / 1000);
  if (!isFinite(sekunden) || sekunden < 0) return '';

  // Der Monitor fragt im Sekundentakt; bis zu einer Minute ist normal.
  if (sekunden < 60) {
    return '<span style="color:var(--text-muted)">vor ' + sekunden + ' s</span>';
  }

  var minuten = Math.round(sekunden / 60);
  return '<span style="color:var(--yellow)" title="Seitdem kam kein neuer Kurs von ' +
    'der Boerse. Das nicht realisierte Ergebnis steht auf diesem Stand.">vor ' +
    minuten + ' min — steht still</span>';
}

/** Der Stand aus Sicht des Monitors. */
function ausfuehrungsstand(m) {
  if (!m) return '';

  var tp = tpStand(m);
  var h = '<h4 style="margin:16px 0 8px">Ausfuehrungsstand</h4>' +
    '<div class="cards" style="margin-bottom:8px">' +
    kachel('Take-Profits', tp.erreicht + ' / ' + tp.gesamt) +
    kachel('Offene Position', mengeKurz(m.remainingSize)) +
    kachel('Letzter Kurs', m.lastPrice != null ? preis(m.lastPrice) : '–',
      kursAlterHinweis(m)) +
    kachel('Stop-Loss', m.slCurrent != null
      ? preis(m.slCurrent) + (m.trailingActive ? ' (trailing)' : '')
      : '–') +
    '</div>';

  if (m.errorCount) {
    h += '<p class="form-hint" style="color:var(--red)">Fehler bisher: ' + m.errorCount + '</p>';
  }
  return h;
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

  // ============================================================
  // Zweispaltig: Chart links und groß, Kennzahlen rechts
  //
  // Vorher war die Ansicht eine Kachelwand mit einem kleinen Chart
  // obendrüber. Der Chart beantwortet aber die meisten Fragen
  // schneller als jede Tabelle — er bekommt den Platz.
  //
  // Die veränderlichen Teile behalten ihre Behälter-IDs
  // (`pd-kennzahlen`, `pd-ergebnis`, `pd-stand` …): Das Nachladen
  // tauscht ihren Inhalt aus, ohne das Gerüst anzurühren.
  // ============================================================

  h += '<div class="pd-raster">';

  // --- Linke Spalte: Chart und Tabellen ---
  h += '<div class="pd-haupt">';

  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<h4 style="margin:0">Kursverlauf</h4>' +
    '<div id="pd-chart-intervalle" style="display:flex;gap:4px">' +
    ['5m', '15m', '1h', '4h', '1d'].map(function (iv) {
      return '<button class="btn ' + (iv === '15m' ? 'btn-primary' : 'btn-secondary') +
        '" style="padding:2px 8px;font-size:11px" data-iv="' + iv +
        '" onclick="chartIntervallSetzen(this.dataset.iv)">' + iv + '</button>';
    }).join('') +
    '</div></div>' +
    '<div id="pd-chart" class="pd-chart"></div>' +
    '<p class="form-hint" id="pd-chart-quelle" style="margin:0"></p>' +
    '<div id="pd-signallage" style="margin-bottom:16px">' +
      signallageHinweis(herkunft) + '</div>';

  // --- Einstiege ---
  h += '<h4 style="margin:16px 0 8px">Einstiege</h4>' +
    '<div class="table-container"><table style="width:100%"><thead><tr>' +
    '<th>Preis</th><th>Menge</th><th>Anteil</th><th>Art</th><th>Zustand</th>' +
    '</tr></thead><tbody id="pd-einstiege-body">' +
    einstiegsZeilen(entries, orders) +
    '</tbody></table></div>';

  // --- Take-Profits ---
  h += '<h4 style="margin:16px 0 8px">Take-Profits</h4>' +
    '<div class="table-container"><table style="width:100%"><thead><tr>' +
    '<th>Preis</th><th>Anteil</th><th>Erreicht</th><th>Besonderheit</th>' +
    '</tr></thead><tbody id="pd-tps-body">' +
    tpZeilen(tps, orders, m) +
    '</tbody></table></div>' +
    '<p class="form-hint" id="pd-tp-hinweis">' + tpHinweis(orders) + '</p>';

  // --- Stop-Loss ---
  h += '<h4 style="margin:16px 0 8px">Stop-Loss</h4>' +
    '<div id="pd-sl">' + slAbschnitt(p, m, orders) + '</div>';

  // Linke Spalte zu, rechte Spalte auf.
  h += '</div><aside class="pd-seite">';

  // Kopf der Seitenleiste: Asset und Börse mit ihren Zeichen.
  h += '<div class="pd-kopf">' +
    (typeof symbolMitLogo === 'function'
      ? symbolMitLogo(p.symbol, 22)
      : esc(p.symbol)) +
    (typeof boerseMitLogo === 'function'
      ? '<span class="pd-boerse">' + boerseMitLogo(p.exchange || 'paper', false, 15) + '</span>'
      : '') +
    '</div>';

  h += '<div id="pd-kennzahlen">' + kennzahlenKacheln(p, d.ergebnis) + '</div>';
  h += '<div id="pd-ergebnis">' + ergebnisAbschnitt(d.ergebnis, p) + '</div>';
  h += '<div id="pd-stand">' + ausfuehrungsstand(m) + '</div>';

  h += '</aside></div>';

  // Alles Weitere steht unter beiden Spalten — es wird seltener
  // gebraucht und darf die volle Breite nutzen.

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
  h += ordersAbschnitt(orders, p);

  // --- Der Verlauf, ganz zum Schluss ---
  //
  // Er steht bewusst unten: Oben will man wissen, wie der Trade GERADE
  // steht — Einstieg, Kurs, Ergebnis. Was bisher geschah, liest man
  // danach, und die Zeitleiste braucht Platz.
  h += '<div id="pd-verlauf">' + verlaufAbschnitt(d.verlauf) + '</div>';

  if (p.notes) {
    h += '<h4 style="margin:16px 0 8px">Notiz</h4>' +
      '<pre class="code-block" style="white-space:pre-wrap">' + esc(p.notes) + '</pre>';
  }

  return h;
}

// ============================================================
// Plan und Wirklichkeit nebeneinander
//
// Die Abschnitte "Einstiege", "Take-Profits" und "Stop-Loss" zeigen,
// was vorgesehen war. Was davon eintrat, steht in den abgeschickten
// Orders — und gehoert daneben: Eine Tabelle mit vier Einstiegen, von
// denen zwei laengst gefuellt sind, sieht sonst aus wie ein Plan, bei
// dem noch nichts geschah.
//
// Gruen heisst eingetreten, rot heisst der Stop hat gegriffen.
// ============================================================

/** Gefuellte Menge einer Order, 0 wenn nichts. */
function gefuellt(o) {
  var n = Number(o && o.filled_quantity);
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * Ordnet jedem geplanten Einstieg seine abgeschickte Order zu.
 *
 * Ueber `entry_order_id` — die Kennung, die der Plan vergeben hat. Wo
 * sie fehlt (aeltere Orders), wird der Reihe nach zugeordnet.
 */
function einstiegsZeilen(entries, orders) {
  if (!entries || !entries.length) {
    return '<tr data-key="leer"><td colspan="5" class="empty-state">keine</td></tr>';
  }

  var einstiegsOrders = (orders || []).filter(function (o) { return o.role === 'entry'; });
  var nachKennung = {};
  einstiegsOrders.forEach(function (o) {
    if (o.entry_order_id) nachKennung[o.entry_order_id] = o;
  });

  return entries.map(function (e, i) {
    var o = (e.id && nachKennung[e.id]) || einstiegsOrders[i] || null;
    var menge = o ? gefuellt(o) : 0;
    var istGefuellt = menge > 0;

    var zustand;
    if (istGefuellt) {
      zustand = '<span style="color:var(--green);font-weight:600">✓ gefuellt</span>' +
        (o.avg_fill_price
          ? ' <span style="color:var(--text-muted);font-size:11px">zu ' + preis(o.avg_fill_price) + '</span>'
          : '');
    } else if (o && (o.status === 'cancelled' || o.status === 'rejected')) {
      zustand = '<span style="color:var(--text-muted)">' +
        (o.status === 'cancelled' ? 'zurueckgenommen' : 'abgewiesen') + '</span>';
    } else if (o) {
      zustand = '<span style="color:var(--accent)">liegt im Markt</span>';
    } else {
      zustand = '<span style="color:var(--text-muted)">nicht abgeschickt</span>';
    }

    // Der gruene Grund ist der eigentliche Hinweis — er laesst sich im
    // Vorbeisehen erfassen, ohne die Spalte zu lesen.
    var stil = istGefuellt
      ? ' style="background:rgba(34,197,94,.10)"'
      : (o && o.status === 'cancelled' ? ' style="opacity:.55"' : '');

    return '<tr data-key="e' + i + '"' + stil + '>' +
      '<td>' + preis(e.price) + '</td>' +
      '<td>' + mengeKurz(e.size) + '</td>' +
      '<td>' + (e.percentage != null ? Number(e.percentage).toFixed(1) + ' %' : '–') + '</td>' +
      '<td data-flack="neutral">' + esc(e.order_type || 'limit') + '</td>' +
      '<td>' + zustand + '</td></tr>';
  }).join('');
}

/**
 * Die Take-Profits mit dem, was aus ihnen wurde.
 *
 * Massgeblich sind die Orders, nicht der Monitor-Zustand: Nach dem
 * Abschluss eines Plans gibt es keinen Monitor mehr, die Orders aber
 * bleiben. Der Monitor dient nur als Rueckfall fuer Plaene, deren
 * Orders noch nicht geschrieben sind.
 */
function tpZeilen(tps, orders, m) {
  if (!tps || !tps.length) {
    return '<tr data-key="leer"><td colspan="4" class="empty-state">keine</td></tr>';
  }

  var tpOrders = (orders || []).filter(function (o) {
    return o.role === 'take_profit' && gefuellt(o) > 0;
  });

  var ausMonitor = tpStand(m);

  return tps.map(function (t, i) {
    var o = tpOrders[i] || null;
    var erreicht = !!o || ausMonitor.erreicht > i;

    var zustand = erreicht
      ? '<span style="color:var(--green);font-weight:600">✓ erreicht</span>' +
        (o && o.avg_fill_price
          ? ' <span style="color:var(--text-muted);font-size:11px">zu ' + preis(o.avg_fill_price) + '</span>'
          : '')
      : '<span style="color:var(--text-muted)">offen</span>';

    var extra = [];
    if (t.sl_adjust) {
      extra.push('SL → ' + (t.sl_new_price != null ? preis(t.sl_new_price) : '?'));
    }
    if (t.activate_trailing) {
      extra.push('Trailing' + (t.trailing_pct != null ? ' ' + t.trailing_pct + ' %' : ''));
    }

    return '<tr data-key="t' + i + '"' +
      (erreicht ? ' style="background:rgba(34,197,94,.10)"' : '') + '>' +
      '<td>' + preis(t.price) + '</td>' +
      '<td>' + (t.percentage != null ? Number(t.percentage).toFixed(1) + ' %'
        : (t.size != null ? mengeKurz(t.size) : '–')) + '</td>' +
      '<td>' + zustand + '</td>' +
      '<td data-flack="neutral">' + (extra.length ? esc(extra.join(', ')) : '–') + '</td></tr>';
  }).join('');
}

function tpHinweis(orders) {
  var getroffen = (orders || []).some(function (o) {
    return o.role === 'take_profit' && gefuellt(o) > 0;
  });
  return getroffen
    ? 'Nach dem ersten Take-Profit wird nicht mehr nachgekauft; offene Kauf-Limits wurden zurueckgenommen.'
    : '';
}

/**
 * Der Stop-Loss — und ob er gegriffen hat.
 *
 * Hat er, steht der Abschnitt in Rot: Das ist das Ende des Trades und
 * soll als solches ins Auge fallen.
 */
function slAbschnitt(p, m, orders) {
  var slOrder = (orders || []).filter(function (o) {
    return (o.role === 'stop_loss' || o.role === 'trailing_stop') && gefuellt(o) > 0;
  })[0];

  var geltend = (m && m.slCurrent != null) ? m.slCurrent : p.stop_loss_price;
  var verschoben = m && m.slCurrent != null && p.stop_loss_price != null &&
    Math.abs(m.slCurrent - p.stop_loss_price) > 1e-9;

  if (slOrder) {
    return '<div style="background:rgba(239,68,68,.12);border-left:3px solid var(--red);' +
      'padding:8px 12px;border-radius:4px">' +
      '<strong style="color:var(--red)">✗ ausgeloest zu ' + preis(slOrder.avg_fill_price) + '</strong>' +
      ' <span class="badge badge-default">' +
      esc(slOrder.role === 'trailing_stop' ? 'trailing' : (p.stop_loss_type || 'fixed')) + '</span>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' +
      mengeKurz(slOrder.filled_quantity) + ' geschlossen · geplant war ' +
      (p.stop_loss_price != null ? preis(p.stop_loss_price) : 'keiner') +
      '</div></div>';
  }

  var h = '<p>' + (geltend != null ? '<strong>' + preis(geltend) + '</strong>' : 'keiner') +
    ' <span class="badge badge-default">' +
    esc((m && m.trailingActive) ? 'trailing' : (p.stop_loss_type || 'fixed')) + '</span>';

  if (verschoben) {
    h += ' <span style="color:var(--green);font-size:12px">nachgezogen, geplant war ' +
      preis(p.stop_loss_price) + '</span>';
  }
  h += '</p>';

  if (p.trailing_stop_pct != null) {
    h += '<p class="form-hint">Trailing ' + p.trailing_stop_pct + ' %' +
      (p.trailing_stop_activation != null ? ' ab ' + preis(p.trailing_stop_activation) : '') + '</p>';
  }
  return h;
}

// ============================================================
// Die abgeschickten Orders
// ============================================================

/**
 * Was der Bot tatsaechlich zur Boerse geschickt hat — und was daraus
 * wurde.
 *
 * Die Tabelle fuehrt jede Order mit Fuellpreis, Gegenwert, gebundener
 * Margin und dem Bestand, der danach im Markt stand. Damit laesst sich
 * Zeile fuer Zeile nachvollziehen, wie die Position entstand: Die
 * Angabe "Position" ist die Summe aller bis dahin gefuellten Einstiege
 * abzueglich der Ausstiege.
 *
 * Sortiert wird nach dem WIRKSAMEN Zeitpunkt, nicht nach dem der
 * Platzierung: Vier Limits gehen gleichzeitig heraus, fuellen sich aber
 * nacheinander. Nach der Platzierungsfolge gerechnet ergaebe die Spalte
 * "Position" eine Reihenfolge, die es so nie gab.
 */
function ordersAbschnitt(orders, plan) {
  var summeGebuehren = (orders || []).reduce(function (s, o) {
    return s + (Number(o.fees) || 0);
  }, 0);
  var hebel = Number(plan && plan.leverage) || 1;
  if (hebel <= 0) hebel = 1;

  return '<h4 style="margin:16px 0 8px">Abgeschickte Orders</h4>' +
    '<div class="table-container"><table style="width:100%;font-size:12px">' +
    '<thead><tr>' +
    '<th>Zeit</th><th>Rolle</th><th>Seite</th>' +
    '<th style="text-align:right">Menge</th>' +
    '<th style="text-align:right">Preis</th>' +
    '<th style="text-align:right">Wert</th>' +
    '<th style="text-align:right">Margin</th>' +
    '<th style="text-align:right">Position</th>' +
    '<th>Status</th>' +
    '</tr></thead><tbody id="pd-orders-body">' +
    ordersZeilen(orders, plan) +
    '</tbody></table></div>' +
    '<p class="form-hint">' +
    'Wert = gefuellte Menge x Fuellpreis. Margin = Wert / Hebel ' + hebel + 'x — der Einsatz, ' +
    'den dieser Einstieg bindet; ein Ausstieg gibt ihn wieder frei. ' +
    '<strong>Position</strong> ist der Bestand nach dieser Order.' +
    (summeGebuehren > 0 ? ' Gebuehren bisher: ' + geld(summeGebuehren) + '.' : '') +
    '</p>';
}

/** Die Zeilen der Order-Tabelle, samt Summenzeile am Ende. */
function ordersZeilen(orders, plan) {
  if (!orders || !orders.length) {
    return '<tr data-key="leer"><td colspan="9" class="empty-state">noch keine</td></tr>';
  }

  var hebel = Number(plan && plan.leverage) || 1;
  if (hebel <= 0) hebel = 1;

  var sortiert = orders.slice().sort(function (a, b) {
    return String(wirkzeit(a)).localeCompare(String(wirkzeit(b)));
  });

  var position = 0;
  var summeEinstiegsWert = 0;
  var summeEinstiegsMenge = 0;
  var summeGebuehren = 0;

  var zeilen = '';
  sortiert.forEach(function (o) {
    var gefuellt = Number(o.filled_quantity) || 0;
    var fuellPreis = Number(o.avg_fill_price) || 0;
    var istEinstieg = o.role === 'entry';
    var wirksam = gefuellt > 0 && fuellPreis > 0;

    // Nur gefuellte Orders bewegen den Bestand. Eine offene oder
    // zurueckgenommene Order steht in der Tabelle, aber sie hat nie
    // etwas gekauft.
    if (wirksam) {
      position += istEinstieg ? gefuellt : -gefuellt;
      if (position < 1e-9) position = 0;
      if (istEinstieg) {
        summeEinstiegsWert += gefuellt * fuellPreis;
        summeEinstiegsMenge += gefuellt;
      }
    }
    summeGebuehren += Number(o.fees) || 0;

    var wert = wirksam ? gefuellt * fuellPreis : null;
    var margin = (wirksam && istEinstieg) ? wert / hebel : null;

    // Der Preis, der zaehlt: der tatsaechliche Fuellpreis. Solange die
    // Order offen ist, bleibt das Limit stehen — grau, weil es eine
    // Absicht ist und keine Tatsache.
    var preisZelle = wirksam
      ? '<strong>' + preis(fuellPreis) + '</strong>'
      : (o.price != null
        ? '<span style="color:var(--text-muted)" title="Limit — noch nicht gefuellt">' +
          preis(o.price) + '</span>'
        : '<span style="color:var(--text-muted)">Markt</span>');

    var mengeZelle = wirksam && Math.abs(gefuellt - Number(o.quantity)) > 1e-9
      ? mengeKurz(gefuellt) + ' <span style="color:var(--text-muted);font-size:11px">von ' +
        mengeKurz(o.quantity) + '</span>'
      : mengeKurz(o.quantity);

    // Gruen fuer einen vollzogenen Einstieg oder Take-Profit, rot fuer
    // einen Stop — dieselbe Sprache wie in den Tabellen darueber.
    var grund = '';
    if (wirksam) {
      grund = (o.role === 'stop_loss' || o.role === 'trailing_stop')
        ? ';background:rgba(239,68,68,.12)'
        : ';background:rgba(34,197,94,.10)';
    }

    zeilen += '<tr data-key="' + esc(String(o.id)) + '"' +
      ' style="' + (wirksam ? '' : 'opacity:.6') + grund + '">' +
      '<td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">' +
        zeitKurz(wirkzeit(o)) + '</td>' +
      '<td>' + rollenAbzeichen(o.role) + '</td>' +
      '<td style="color:' + (o.side === 'buy' ? 'var(--green)' : 'var(--red)') + '">' +
        esc(o.side) + '</td>' +
      '<td style="text-align:right">' + mengeZelle + '</td>' +
      '<td style="text-align:right">' + preisZelle + '</td>' +
      '<td style="text-align:right">' + (wert != null ? geld(wert) : '–') + '</td>' +
      '<td style="text-align:right">' + (margin != null
        ? geld(margin)
        : '<span style="color:var(--text-muted)">' + (wirksam ? 'frei' : '–') + '</span>') + '</td>' +
      '<td style="text-align:right">' + (wirksam
        ? mengeKurz(position)
        : '<span style="color:var(--text-muted)">–</span>') + '</td>' +
      '<td><span class="badge ' + statusKlasse(o.status) + '">' + esc(o.status) + '</span></td>' +
      '</tr>';
  });

  var oEinstieg = summeEinstiegsMenge > 0 ? summeEinstiegsWert / summeEinstiegsMenge : null;

  // Die Summenzeile steht im tbody, nicht im tfoot: So wird sie beim
  // Nachladen wie jede andere Zeile mitgepflegt.
  zeilen += '<tr data-key="summe" style="border-top:2px solid var(--border);font-weight:600">' +
    '<td colspan="3">Eingestiegen</td>' +
    '<td style="text-align:right">' + mengeKurz(summeEinstiegsMenge) + '</td>' +
    '<td style="text-align:right">' + (oEinstieg != null ? 'ø ' + preis(oEinstieg) : '–') + '</td>' +
    '<td style="text-align:right">' + geld(summeEinstiegsWert) + '</td>' +
    '<td style="text-align:right">' + geld(summeEinstiegsWert / hebel) + '</td>' +
    '<td style="text-align:right">' + mengeKurz(position) + '</td>' +
    '<td></td></tr>';

  return zeilen;
}

/**
 * Der Zeitpunkt, an dem eine Order wirksam wurde.
 *
 * Bei einer gefuellten ist das der Fuellzeitpunkt (updated_at), bei
 * einer offenen der der Platzierung.
 */
function wirkzeit(o) {
  var gefuellt = (Number(o.filled_quantity) || 0) > 0;
  return (gefuellt ? (o.updated_at || o.placed_at) : o.placed_at) || '';
}

function rollenAbzeichen(rolle) {
  var namen = {
    entry: 'Einstieg', take_profit: 'Take-Profit',
    stop_loss: 'Stop-Loss', trailing_stop: 'Trailing',
  };
  var farben = {
    entry: 'badge-blue', take_profit: 'badge-green',
    stop_loss: 'badge-red', trailing_stop: 'badge-yellow',
  };
  return '<span class="badge ' + (farben[rolle] || 'badge-default') + '">' +
    esc(namen[rolle] || rolle) + '</span>';
}

function statusKlasse(status) {
  if (status === 'filled') return 'badge-green';
  if (status === 'cancelled' || status === 'rejected') return 'badge-default';
  if (status === 'partially_filled') return 'badge-yellow';
  return 'badge-default';
}

/**
 * Ein Preis mit so vielen Stellen, wie er braucht.
 *
 * Zwei Nachkommastellen reichen fuer BNB, nicht fuer eine Muenze zu
 * 0,0043 — dort stuende sonst ueberall 0,00.
 */
function preis(wert) {
  if (wert == null || !isFinite(wert)) return '–';
  var n = Math.abs(Number(wert));
  var stellen = n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return Number(wert).toLocaleString('de-DE', {
    minimumFractionDigits: 2, maximumFractionDigits: stellen,
  });
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
 * Die Rendite eines Plans, bezogen auf seinen Einsatz.
 *
 * Die Zahl, die zwei Trades vergleichbar macht: 17 USDT auf 258
 * Einsatz sind etwas anderes als 17 USDT auf 1.030. Realisiert und
 * nicht realisiert zusammen — gefragt ist, was der Trade bisher
 * eingebracht hat.
 */
function renditeZelle(p) {
  var e = p.ergebnis;
  if (!e || !e.eingestiegen || e.renditePct == null) {
    return '<span style="color:var(--text-muted)">–</span>';
  }

  var r = Number(e.renditePct);
  var farbe = r > 0 ? 'var(--green)' : r < 0 ? 'var(--red)' : 'var(--text-muted)';
  var hinweis = 'Gesamt ' + geld(e.gesamt) + ' auf ' +
    (e.einsatz != null ? geld(e.einsatz) + ' Einsatz' : 'unbekanntem Einsatz');

  return '<span style="color:' + farbe + ';font-weight:600" title="' + esc(hinweis) + '">' +
    (r > 0 ? '+' : '') + r.toFixed(2) + ' %</span>';
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

function kachel(label, wert, zusatz) {
  return '<div class="card"><div class="card-label">' + esc(label) + '</div>' +
    '<div class="card-value" style="font-size:18px">' + wert + '</div>' +
    (zusatz
      ? '<div style="font-size:11px;margin-top:4px">' + zusatz + '</div>'
      : '') +
    '</div>';
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

  var waehrung = waehrungVon(plan);

  // Die Rendite braucht ihren Nenner daneben.
  //
  // "+20,51 %" allein laesst offen, worauf — auf den eingesetzten
  // Margin, auf das Konto, auf den Kurs? Gemeint ist der Einsatz ueber
  // die Lebensdauer des Trades, also einschliesslich des bereits
  // wieder geschlossenen Teils. Ohne diese Angabe ist die Zahl nicht
  // nachrechenbar und damit nicht pruefbar.
  var renditeBezug = e.einsatz != null
    ? '<span style="color:var(--text-muted)">auf ' + geld(e.einsatz) + ' ' +
      esc(waehrung) + ' Einsatz</span>'
    : '';

  var h = '<h4 style="margin:16px 0 8px">Ergebnis</h4>' +
    '<div class="cards" style="margin-bottom:8px">' +
    kachel('Realisiert', betragGefaerbt(e.realisiert, waehrung),
      '<span style="color:var(--text-muted)">' + mengeKurz(e.geschlossen) +
      ' geschlossen</span>') +
    kachel('Nicht realisiert', e.unrealisiert != null
      ? betragGefaerbt(e.unrealisiert, waehrung)
      : '<span style="color:var(--text-muted)">–</span>',
      e.offen > 0
        ? '<span style="color:var(--text-muted)">' + mengeKurz(e.offen) + ' offen zu ' +
          preis(e.kurs) + '</span>'
        : '') +
    kachel('Gesamt', betragGefaerbt(e.gesamt, waehrung)) +
    kachel('Rendite', e.renditePct != null
      ? betragGefaerbt(e.renditePct, '%')
      : '<span style="color:var(--text-muted)">–</span>', renditeBezug) +
    '</div>';

  h += '<table style="width:100%"><tbody>' +
    zeile('Eingestiegen', mengeKurz(e.eingestiegen) +
      (e.einstiegsPreis != null ? ' zu ⌀ ' + preis(e.einstiegsPreis) : '')) +
    zeile('Wieder geschlossen', mengeKurz(e.geschlossen)) +
    zeile('Noch offen', e.offen > 0
      ? mengeKurz(e.offen) + (e.kurs != null ? ' — Kurs ' + preis(e.kurs) : '')
      : 'nichts') +
    zeile('Einsatz (Margin)', e.einsatz != null ? geld(e.einsatz) + ' ' + esc(waehrung) : '–') +
    zeile('Davon Gebuehren', gebuehrenZeile(e)) +
    '</tbody></table>';

  h += '<p class="form-hint">Die Rechnung des Bots aus den abgeschickten Orders. ' +
    'Massgeblich fuer die Buchhaltung ist der Import des Journals direkt bei der Boerse — ' +
    'nur der kennt Teilfuellungen, Finanzierungskosten und den tatsaechlichen ' +
    'Ausfuehrungspreis.</p>';

  return h;
}

/**
 * Die Gebuehren — und ob sie vollstaendig sind.
 *
 * Eine Boerse, die ihre Gebuehr nicht zurueckmeldet, hinterlaesst eine
 * Null in der Spalte (sie steht auf DEFAULT 0). Die Summe darueber
 * sieht aus wie eine Gesamtsumme, ist aber eine Teilsumme — und der
 * Unterschied geht direkt in "Realisiert" ein, denn davon werden die
 * Gebuehren abgezogen.
 *
 * An einem SOLUSDT-Short standen so 0,22 USDT auf 9.078 USDT Umsatz:
 * 0,002 %, also ein Zehntel eines Taker-Satzes. Die Zahl war nicht
 * falsch gerechnet, sie war nur unvollstaendig erhoben — und daran
 * sah man ihr nichts an.
 */
function gebuehrenZeile(e) {
  var fehlend = (e.fuellungen || 0) - (e.fuellungenMitGebuehr || 0);

  if (!e.gebuehren) {
    return e.fuellungen
      ? '<span style="color:var(--yellow)">nicht erfasst — ' + e.fuellungen +
        ' Fuellung(en) ohne Gebuehrenangabe</span>'
      : '<span style="color:var(--text-muted)">keine erfasst</span>';
  }

  var text = '-' + geld(e.gebuehren) + (e.waehrung ? ' ' + esc(e.waehrung) : '');

  if (fehlend > 0) {
    return '<span style="color:var(--yellow)" title="Die Boerse hat zu ' + fehlend +
      ' von ' + e.fuellungen + ' Fuellungen keine Gebuehr gemeldet. Was hier steht, ist ' +
      'eine Teilsumme — der tatsaechliche Abzug ist groesser.">mindestens ' + text +
      ' <span style="font-size:11px">(' + fehlend + ' von ' + e.fuellungen +
      ' Fuellungen ohne Angabe)</span></span>';
  }
  return text;
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
  await Promise.all([signalBuchLaden(), uebungskontoLaden(), fehlschlaegeLaden()]);
}

// ============================================================
// Fehlschlaege — in den Stop, ohne je einen TP mitzunehmen
//
// Die Gruppe, an der sich die Guete eines Signalgebers entscheidet.
// Ein Trade, der TP1 mitnahm und dann gestoppt wurde, gehoert nicht
// dazu: Dort hat die Strategie funktioniert, nur nicht bis zum Ende.
// ============================================================

async function fehlschlaegeLaden() {
  var body = document.getElementById('fs-body');
  if (!body) return;

  try {
    var d = await apiFetch('/signals/auswertung?nur=fehlschlaege');
    if (!d) return;

    var k = d.kennzahlen || {};
    var zahl = document.getElementById('fs-zahl');
    if (zahl) zahl.textContent = String(k.fehlschlaege || 0);

    var kacheln = document.getElementById('fs-kennzahlen');
    if (kacheln) {
      kacheln.innerHTML =
        kachel('Gehandelte Signale', String(k.gehandelt || 0)) +
        kachel('Davon Fehlschlaege', String(k.fehlschlaege || 0)) +
        kachel('Fehlschlagquote', (k.fehlschlagQuote != null ? k.fehlschlagQuote.toFixed(1) : '0') + ' %') +
        kachel('Verlust daraus', betragGefaerbt(k.verlustDurchFehlschlaege, 'USDT')) +
        kachel('Ergebnis gesamt', betragGefaerbt(k.ergebnisGesamt, 'USDT')) +
        kachel('Nie in Reichweite',
          '<span style="color:' + (k.nieInReichweite ? 'var(--yellow)' : '') + '">' +
          String(k.nieInReichweite || 0) + '</span>',
          k.schnittAbstandBeiEingang != null
            ? 'ø ' + k.schnittAbstandBeiEingang.toFixed(2) + ' % Abstand bei Eingang'
            : '');
    }

    var zeilen = d.zeilen || [];
    if (!zeilen.length) {
      tabelleZeichnen(body, '<tr data-key="leer"><td colspan="11" class="empty-state">' +
        'Kein Signal ist bisher ohne Take-Profit in den Stop gelaufen.</td></tr>');
      return;
    }

    tabelleZeichnen(body, zeilen.map(function (z) {
      return '<tr data-key="' + esc(z.planId) + '" style="cursor:pointer"' +
        ' title="Plan anzeigen" data-plan="' + esc(z.planId) + '"' +
        ' onclick="planDetailOeffnen(this.dataset.plan)">' +
        '<td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">' +
          esc(zeitKurz(z.zeitpunkt)) + '</td>' +
        '<td>' + esc(z.strategie) + '</td>' +
        '<td><strong>' + esc(z.symbol) + '</strong></td>' +
        '<td><span class="badge ' + (z.richtung === 'long' ? 'badge-green' : 'badge-red') + '">' +
          esc(z.richtung) + '</span></td>' +
        '<td>' + z.einstiegeGefuellt + ' / ' + z.einstiegeGeplant + '</td>' +
        '<td style="text-align:right">' + mengeKurz(z.menge) + '</td>' +
        '<td style="text-align:right">' + preis(z.einstiegspreis) + '</td>' +
        '<td style="text-align:right">' + geld(z.einsatz) + '</td>' +
        '<td style="font-size:12px">' + esc(z.kette || '–') + '</td>' +
        '<td style="text-align:right;color:var(--red);font-weight:600">' +
          geld(z.realisiert) + '</td>' +
        '<td style="text-align:right;color:var(--red)">' +
          (z.renditePct != null ? z.renditePct.toFixed(2) + ' %' : '–') + '</td>' +
        '</tr>';
    }).join(''));
  } catch (e) {
    console.error('[Fehlschlaege]', e);
  }
}

/**
 * Laedt die Auswertung als CSV herunter.
 *
 * Der Umweg ueber einen Blob ist noetig, weil die Schnittstelle hinter
 * der Passwortabfrage liegt — ein schlichter Link truege den
 * Authorization-Kopf nicht mit.
 */
async function auswertungExportieren(nurFehlschlaege) {
  var pfad = '/api/signals/auswertung.csv' + (nurFehlschlaege ? '?nur=fehlschlaege' : '');

  try {
    var antwort = await fetch(pfad, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
    if (!antwort.ok) {
      alert('Export fehlgeschlagen: ' + antwort.status);
      return;
    }

    var text = await antwort.blob();
    var url = URL.createObjectURL(text);
    var a = document.createElement('a');
    a.href = url;
    a.download = nurFehlschlaege ? 'signale-fehlschlaege.csv' : 'signale-auswertung.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export fehlgeschlagen: ' + ((e && e.message) || e));
  }
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
      tabelleZeichnen(body, '<tr data-key="leer"><td colspan="11" class="empty-state">Noch kein Signal eingegangen</td></tr>');
      return;
    }

    tabelleZeichnen(body, d.signals.map(function (s) {
      var sc = s.scaling || {};
      var warnungen = Array.isArray(s.warnings) ? s.warnings : [];
      var grund = s.reason || (warnungen.length ? warnungen.join(' · ') : '');

      // Angelegte Plaene lassen sich von hier aus oeffnen.
      var klickbar = s.created_plan_id
        ? ' style="cursor:pointer" title="Plan anzeigen" data-plan="' + esc(s.created_plan_id) + '"' +
          ' onclick="planDetailOeffnen(this.dataset.plan)"'
        : '';

      var v = s.verlauf;

      return '<tr data-key="' + esc(String(s.id != null ? s.id : s.signal_id)) + '"' + klickbar + '>' +
        '<td data-flack="neutral">' + esc(zeitKurz(s.received_at)) + '</td>' +
        '<td data-flack="neutral">' + esc(s.strategy || '–') + '</td>' +
        '<td><strong>' + esc(s.symbol || '–') + '</strong></td>' +
        '<td data-flack="neutral">' + esc(s.action || '–') + '</td>' +
        '<td data-flack="neutral">' + signalStatusAbzeichen(s.status) + '</td>' +
        '<td data-flack="neutral">' + verlaufKette(v) + '</td>' +
        '<td data-flack="neutral">' + ausgangAbzeichen(v) + '</td>' +
        '<td data-flack="neutral">' + (sc.factor != null ? Number(sc.factor).toFixed(4) : '–') + '</td>' +
        '<td data-flack="neutral">' + (sc.scaledMargin != null ? geld(sc.scaledMargin) : '–') + '</td>' +
        '<td data-flack="neutral">' + (sc.scaledRisk != null ? geld(sc.scaledRisk) : '–') + '</td>' +
        '<td data-flack="neutral" style="max-width:280px;font-size:12px;color:var(--text-muted)">' + esc(grund) + '</td>' +
        '</tr>';
    }).join(''));
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

/**
 * Groesse einer Position in der Uebersicht.
 *
 * Gezeigt wird, was TATSAECHLICH offen ist — nicht, was geplant war.
 * Bei einem gestaffelten Einstieg, von dem erst ein Teil gefuellt
 * wurde, liegt dazwischen ein Vielfaches: 7,68 von 30,72 geplanten BNB.
 * Wer die geplante Zahl fuer die offene haelt, schaetzt sein Risiko um
 * das Vierfache falsch ein.
 *
 * Die geplante Groesse bleibt als blasser Zusatz daneben stehen, damit
 * der Unterschied sichtbar ist und nicht nur eine kleinere Zahl.
 */
function groesseZelle(p) {
  var e = p.ergebnis;
  var geplant = p.total_size != null ? Number(p.total_size) : null;

  // Ohne Ergebnisrechnung (Engine- und local_plans) bleibt es bei der
  // geplanten Groesse.
  if (!e || e.offen == null) {
    return geplant != null ? mengeKurz(geplant) : '–';
  }

  var offen = Number(e.offen);
  if (offen <= 0) {
    return '<span style="color:var(--text-muted)" title="Noch kein Einstieg gefuellt">' +
      '0 <span style="font-size:11px">von ' + mengeKurz(geplant) + '</span></span>';
  }

  var vollstaendig = geplant != null && Math.abs(offen - geplant) < 1e-9;
  if (vollstaendig) return mengeKurz(offen);

  return '<span title="Offen: ' + mengeKurz(offen) + ' von geplanten ' + mengeKurz(geplant) + '">' +
    mengeKurz(offen) +
    ' <span style="font-size:11px;color:var(--text-muted)">/ ' + mengeKurz(geplant) + '</span></span>';
}
