// ============================================================
// Kursverlauf in der Detailansicht
//
// Nutzt KLineChart (v10, Apache 2.0), oertlich abgelegt unter
// /vendor/klinecharts.min.js. Bewusst kein CDN: Die Sicherheitsregeln
// dieser Seite lassen nur eigene Skripte zu (script-src 'self'), und
// ein Handelswerkzeug sollte ohnehin nicht von fremden Servern laden.
//
// Gezeigt werden die Kerzen DER BOERSE, gegen die gehandelt wurde —
// nicht die eines beliebigen anderen Hauses. Zwischen zwei Boersen
// liegen bei denselben Dochten mitunter mehrere Promille, und genau
// daran entscheidet sich, ob ein Stop lag oder knapp darueber drehte.
// ============================================================

var chartInstanz = null;
var chartPlanId = null;
var chartIntervall = '15m';

/**
 * Wann der Chart zuletzt nachgefuehrt wurde.
 *
 * Die uebrige Detailansicht frischt alle zehn Sekunden auf; der Chart
 * braucht das nicht so oft, denn der Dienst haelt die Kerzen 30 s lang
 * vor (KerzenService.haltbarkeitMs). Haeufiger zu fragen lieferte
 * dieselben Kerzen zurueck.
 */
var chartZuletztGeholt = 0;
var CHART_TAKT_MS = 30000;

/** Einmal registriert reicht — ein zweiter Aufruf wuerde meckern. */
var pfeilRegistriert = false;

/**
 * Ein Pfeil, der auf eine Fuellung zeigt.
 *
 * Die mitgelieferte `simpleAnnotation` kann nur nach oben zeigen. Hier
 * entscheidet die Richtung: Ein Kauf bekommt einen Pfeil von UNTEN
 * (er zeigt hinauf auf die Kerze), ein Verkauf einen von OBEN. So
 * liest sich der Chart ohne Beschriftung richtig herum, und die
 * Marken liegen nicht alle uebereinander.
 *
 * Gezeichnet wird mit den Figuren, die die Bibliothek selbst benutzt —
 * `line`, `polygon`, `text`. Nachgeprueft an der ausgelieferten Datei,
 * nicht aus dem Gedaechtnis.
 */
function pfeilTypRegistrieren() {
  if (pfeilRegistriert) return;
  if (typeof klinecharts === 'undefined' ||
      typeof klinecharts.registerOverlay !== 'function') return;

  try {
    klinecharts.registerOverlay({
      name: 'tcFuellung',
      totalStep: 2,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,

      createPointFigures: function (args) {
        var daten = (args.overlay && args.overlay.extendData) || {};
        var punkt = args.coordinates && args.coordinates[0];
        if (!punkt) return [];

        var hoch = daten.richtung !== 'ab';     // Kauf zeigt hinauf
        var farbe = daten.farbe || '#58a6ff';
        var x = punkt.x;

        // Abstand zur Kerze, Laenge des Stiels, Groesse der Spitze.
        var lueckeY = hoch ? 8 : -8;
        var stiel = hoch ? 22 : -22;
        var spitze = 6;

        var fuss = punkt.y + lueckeY + stiel;   // Ende des Stiels
        var kopf = punkt.y + lueckeY;           // Spitze, an der Kerze

        return [
          {
            type: 'line',
            attrs: { coordinates: [{ x: x, y: fuss }, { x: x, y: kopf }] },
            styles: { color: farbe, size: 1 },
            ignoreEvent: true,
          },
          {
            // Das Dreieck zeigt zur Kerze hin.
            type: 'polygon',
            attrs: {
              coordinates: [
                { x: x, y: kopf },
                { x: x - spitze / 2, y: kopf + (hoch ? spitze : -spitze) },
                { x: x + spitze / 2, y: kopf + (hoch ? spitze : -spitze) },
              ],
            },
            styles: { style: 'fill', color: farbe },
            ignoreEvent: true,
          },
          {
            type: 'text',
            attrs: {
              x: x,
              y: fuss + (hoch ? 2 : -2),
              text: daten.text || '',
              align: 'center',
              baseline: hoch ? 'top' : 'bottom',
            },
            styles: { color: farbe, size: 10 },
            ignoreEvent: true,
          },
        ];
      },
    });
    pfeilRegistriert = true;
  } catch (e) {
    // Ohne eigenen Typ bleibt der Chart brauchbar — nur ohne Pfeile.
    console.warn('[Chart] Pfeil-Typ nicht registrierbar:', e);
  }
}

/**
 * Baut den Chart in den vorgesehenen Behaelter.
 *
 * Verlaeuft still im Sand, wenn die Bibliothek fehlt: Ein fehlender
 * Chart darf die Detailansicht nicht unbrauchbar machen.
 */
async function chartLaden(planId, intervall) {
  var behaelter = document.getElementById('pd-chart');
  if (!behaelter) return;

  if (typeof klinecharts === 'undefined') {
    behaelter.innerHTML = '<p class="form-hint">Die Chart-Bibliothek wurde nicht geladen.</p>';
    return;
  }

  chartPlanId = planId;
  chartIntervall = intervall || chartIntervall;
  chartZuletztGeholt = Date.now();

  try {
    var d = await apiFetch('/trade-plans/' + encodeURIComponent(planId) +
      '/kerzen?intervall=' + encodeURIComponent(chartIntervall) + '&anzahl=300');

    if (!d || !d.kerzen || !d.kerzen.length) {
      // Die alte Instanz muss mit weg, bevor ihre Zeichenflaeche
      // ueberschrieben wird — sonst zeigte `chartInstanz` auf eine
      // Flaeche, die es nicht mehr gibt, und das Nachfuehren liefe ins
      // Leere statt den Chart neu aufzubauen.
      chartAufraeumen();
      behaelter.innerHTML = '<p class="form-hint">Keine Kerzen verfuegbar' +
        (d && d.fehler ? ': ' + esc(d.fehler) : '') + '</p>';
      return;
    }

    chartZeichnen(behaelter, d);
    var quelle = document.getElementById('pd-chart-quelle');
    if (quelle) {
      // Den verwendeten Markt ausdruecklich nennen: Bei Phemex heissen
      // der SOL-Kontrakt und die OL-Kasse gross geschrieben gleich, und
      // ein Chart des falschen Marktes saehe voellig unauffaellig aus.
      quelle.textContent = d.kerzen.length + ' Kerzen von ' + d.quelle +
        (d.markt ? ' · ' + d.markt : '') +
        (d.fehler ? ' (zuletzt bekannter Stand)' : '');
    }
  } catch (e) {
    chartAufraeumen();
    behaelter.innerHTML = '<p class="form-hint">Chart nicht ladbar: ' +
      esc(String((e && e.message) || e)) + '</p>';
  }
}

/**
 * Haelt den Chart mit der uebrigen Detailansicht mit.
 *
 * Wird aus `planDetailAktualisieren()` gerufen, also alle zehn
 * Sekunden, und fragt davon hoechstens jedes dritte Mal wirklich ab.
 *
 * Vorher wurde der Chart ueberhaupt nicht mitgefuehrt: `chartNachfuehren`
 * gab es, aber niemand rief es auf. Die Kennzahlen daneben liefen
 * weiter, die Kerzen standen still — am 26.10. an einem laufenden
 * SOLUSDT-Short aufgefallen, dessen Chart bei 15:00 stehenblieb,
 * waehrend "Nicht realisiert" sich weiter bewegte. Ein stehender Chart
 * sieht aus wie ein ruhiger Markt.
 */
async function chartMitfuehren() {
  if (!chartPlanId) return;

  var behaelter = document.getElementById('pd-chart');
  // Das Fenster kann geschlossen oder noch nicht aufgebaut sein.
  if (!behaelter || !behaelter.offsetParent) return;

  var jetzt = Date.now();
  if (jetzt - chartZuletztGeholt < CHART_TAKT_MS) return;
  chartZuletztGeholt = jetzt;

  // Steht gar kein Chart — die erste Abfrage schlug fehl oder die
  // Boerse lieferte keine Kerzen —, wird neu aufgebaut statt
  // nachgefuehrt. Sonst bliebe die Flaeche bis zum Schliessen leer,
  // auch wenn die Boerse laengst wieder antwortet.
  if (!chartInstanz) {
    await chartLaden(chartPlanId, chartIntervall);
    return;
  }
  await chartNachfuehren();
}

/**
 * Zerlegt "15m" in die Form, die KLineChart v10 erwartet.
 *
 * Dort heisst es nicht mehr schlicht "15m", sondern
 * { span: 15, type: 'minute' }.
 */
/**
 * Wieviele Nachkommastellen braucht dieser Markt?
 *
 * Abgelesen an den Kursen selbst: BTC kommt mit zwei aus, HBAR braucht
 * fuenf. Ohne diese Angabe rundet die Bibliothek pauschal auf zwei, und
 * aus 0,07766 wird eine glatte 0,08 — womit der Chart einer
 * Niedrigpreis-Muenze unbrauchbar waere.
 */
function nachkomma(kerzen) {
  var meiste = 2;
  for (var i = 0; i < Math.min(kerzen.length, 50); i++) {
    var text = String(kerzen[i].close);
    var punkt = text.indexOf('.');
    if (punkt >= 0) meiste = Math.max(meiste, text.length - punkt - 1);
  }
  return Math.min(meiste, 8);
}

function periodeAus(intervall) {
  var m = String(intervall).match(/^(\d+)([mhd])$/);
  if (!m) return { span: 15, type: 'minute' };
  var typ = m[2] === 'm' ? 'minute' : m[2] === 'h' ? 'hour' : 'day';
  return { span: parseInt(m[1], 10), type: typ };
}

function chartZeichnen(behaelter, d) {
  // Eine frühere Instanz muss weg, sonst zeichnen zwei uebereinander.
  chartAufraeumen();
  behaelter.innerHTML = '';

  var chart = klinecharts.init(behaelter, {
    styles: {
      grid: { horizontal: { color: '#2a2e39' }, vertical: { color: '#2a2e39' } },
      candle: {
        bar: {
          upColor: '#26a69a', downColor: '#ef5350',
          upBorderColor: '#26a69a', downBorderColor: '#ef5350',
          upWickColor: '#26a69a', downWickColor: '#ef5350',
        },
        tooltip: { show: true },
      },
      xAxis: { axisLine: { color: '#2a2e39' }, tickText: { color: '#8f9299' } },
      yAxis: { axisLine: { color: '#2a2e39' }, tickText: { color: '#8f9299' } },
    },
  });
  if (!chart) return;
  chartInstanz = chart;

  var kerzen = d.kerzen.map(function (k) {
    return {
      timestamp: k.timestamp,
      open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
    };
  });

  // KLineChart v10 nimmt die Daten nicht mehr direkt entgegen.
  //
  // In Fassung 9 gab es `applyNewData(liste)`. Seit 10 beschreibt man
  // erst den Markt (setSymbol) und das Zeitraster (setPeriod) und
  // hinterlegt dann eine Bezugsquelle (setDataLoader), die die
  // Bibliothek selbst befragt — einmal beim Aufbau und erneut, wenn der
  // Nutzer nach links scrollt.
  //
  // Hier werden nur die bereits geholten Kerzen zurueckgegeben; aeltere
  // nachzuladen ist nicht vorgesehen, deshalb meldet `more: false`,
  // dass es nichts weiter gibt.
  // Die Nachkommastellen aus den Kursen ableiten — BTC braucht zwei,
  // HBAR fuenf. Ohne diese Angabe rundet die Bibliothek auf zwei und
  // macht aus 0,07766 eine glatte 0,08.
  chart.setSymbol({ ticker: d.symbol || 'Markt', pricePrecision: nachkomma(kerzen) });
  chart.setPeriod(periodeAus(d.intervall || chartIntervall));
  chart.setDataLoader({
    getBars: function (args) {
      if (!args || typeof args.callback !== 'function') return;
      if (args.type === 'init') args.callback(kerzen, false);
      else args.callback([], false);
    },
  });

  chartMarkenSetzen(chart, d.marken);
  chartFuellungenSetzen(chart, d.fuellungen, d.kerzen);
  chartSignalzeitSetzen(chart, d.signalzeit, d.kerzen);
}

/**
 * Setzt eine senkrechte Marke dorthin, wo das Signal eintraf.
 *
 * Ohne sie laesst sich aus den Kerzen nicht ablesen, ob der Kurs VOR
 * oder NACH dem Signal in den Einstiegen stand — und das ist der
 * Unterschied zwischen "der Bot hat es verschlafen" und "das Signal
 * kam zu spaet".
 *
 * Am 26.10. sah ein BTCUSDT-Short danach aus, als waeren vier
 * Einstiege uebergangen worden. Die Kerzen standen weit ueber dem
 * ersten Limit — aber dreizehn Minuten BEVOR das Signal eintraf.
 */
function chartSignalzeitSetzen(chart, signalzeit, kerzen) {
  if (!chart || !signalzeit || !signalzeit.zeitpunkt) return;

  var ms = Date.parse(signalzeit.zeitpunkt);
  if (!isFinite(ms)) return;

  var raster = kerzenRaster(kerzen);
  var erste = (kerzen && kerzen.length) ? kerzen[0].timestamp : null;
  var letzte = (kerzen && kerzen.length) ? kerzen[kerzen.length - 1].timestamp : null;

  // Ausserhalb des gezeigten Zeitraums gibt es nichts zu markieren.
  if (erste != null && ms < erste - raster) return;
  if (letzte != null && ms > letzte + raster) return;

  var aufKerze = raster > 0 ? Math.floor(ms / raster) * raster : ms;

  try {
    chart.createOverlay({
      name: 'verticalStraightLine',
      points: [{ timestamp: aufKerze, value: 0 }],
      styles: {
        line: { color: '#d29922', style: 'dashed', size: 1, dashedValue: [3, 3] },
      },
      lock: true,
    });
  } catch (e) {
    // Ohne Marke bleibt der Chart brauchbar.
  }
}

/**
 * Setzt Pfeile dorthin, wo tatsaechlich gehandelt wurde.
 *
 * Die Preismarken zeigen, wo etwas GEPLANT war — waagerechte Linien
 * ueber den ganzen Chart. Diese Pfeile zeigen, wo und WANN es wirklich
 * geschah. Erst zusammen ergibt sich die Geschichte: ein Einstieg, der
 * ueber seinem Limit fuellte, ein Stop, den ein Docht ausloeste.
 */
function chartFuellungenSetzen(chart, fuellungen, kerzen) {
  if (!chart || !fuellungen || !fuellungen.length) return;

  pfeilTypRegistrieren();
  if (!pfeilRegistriert) return;

  // Das Zeitraster der Kerzen. Eine Fuellung mitten in einer Kerze
  // muss auf deren Beginn gerundet werden — sonst findet die
  // Bibliothek keinen Platz fuer die Marke.
  var raster = kerzenRaster(kerzen);
  var erste = (kerzen && kerzen.length) ? kerzen[0].timestamp : null;
  var letzte = (kerzen && kerzen.length) ? kerzen[kerzen.length - 1].timestamp : null;

  fuellungen.forEach(function (f) {
    var ms = Date.parse(f.zeitpunkt);
    if (!isFinite(ms) || !isFinite(f.preis)) return;

    // Ausserhalb des gezeigten Zeitraums gibt es nichts zu markieren.
    if (erste != null && ms < erste - raster) return;
    if (letzte != null && ms > letzte + raster) return;

    var aufKerze = raster > 0 ? Math.floor(ms / raster) * raster : ms;

    // Ein Einstieg zeigt hinauf, ein Ausstieg herunter — so stehen
    // sie sich nicht im Weg.
    var einstieg = f.art === 'einstieg';
    var farbe = einstieg ? '#58a6ff' : (f.art === 'tp' ? '#26a69a' : '#ef5350');

    try {
      chart.createOverlay({
        name: 'tcFuellung',
        points: [{ timestamp: aufKerze, value: f.preis }],
        extendData: {
          text: f.beschriftung,
          richtung: einstieg ? 'auf' : 'ab',
          farbe: farbe,
        },
        lock: true,
      });
    } catch (e) {
      // Eine Marke, die sich nicht setzen laesst, soll den Chart nicht
      // verhindern.
    }
  });
}

/** Abstand zweier Kerzen in Millisekunden. */
function kerzenRaster(kerzen) {
  if (!kerzen || kerzen.length < 2) return 0;
  var a = kerzen[kerzen.length - 2].timestamp;
  var b = kerzen[kerzen.length - 1].timestamp;
  var d = b - a;
  return d > 0 ? d : 0;
}

/**
 * Setzt die Preismarken: Einstiege, Ziele, Stop.
 *
 * Erst sie machen den Chart zur Aussage: Lag der Docht im Stop oder
 * drehte er knapp darueber? Beim Auffrischen werden die alten zuerst
 * entfernt — ein nachgezogener Stop muss wandern, nicht sich
 * verdoppeln.
 */
function chartMarkenSetzen(chart, marken) {
  if (!chart) return;

  try {
    if (typeof chart.removeOverlay === 'function') chart.removeOverlay();
  } catch (e) {
    // Gibt es nichts zu entfernen, ist auch nichts verloren.
  }

  (marken || []).forEach(function (m) {
    // Der ueberholte Stop bleibt sichtbar, aber blass — er ist
    // Geschichte, keine geltende Grenze. Ein gleich kraeftiger Strich
    // liesse zwei Stops gleichwertig erscheinen.
    var alt = m.art === 'sl_alt';
    var farbe = m.art === 'tp' ? '#26a69a'
      : (m.art === 'sl' || alt) ? '#ef5350' : '#5b8def';
    var gestrichelt = m.art === 'sl' || alt;

    try {
      chart.createOverlay({
        name: 'priceLine',
        points: [{ value: m.preis }],
        styles: {
          line: {
            color: farbe,
            style: gestrichelt ? 'dashed' : 'solid',
            size: 1,
            dashedValue: alt ? [2, 6] : [4, 4],
          },
          text: {
            color: farbe,
            backgroundColor: 'transparent',
            size: alt ? 9 : 12,
          },
        },
        extendData: m.beschriftung,
        lock: true,
      });
    } catch (e) {
      // Eine Marke, die sich nicht setzen laesst, soll den Chart nicht
      // verhindern.
    }
  });
}

/**
 * Frischt den Chart auf, ohne ihn neu aufzubauen.
 *
 * Geholt werden dieselben Kerzen wie beim Aufbau; eingespielt werden
 * sie ueber `resetData()`, das die Bibliothek ihre Bezugsquelle erneut
 * befragen laesst. Der Chart selbst bleibt bestehen — Zoomstufe und
 * Bildausschnitt ueberleben damit, was bei einem Neuaufbau (dispose +
 * init) jedes Mal verloren ginge.
 *
 * Ein `updateData()` wie in anderen Chart-Bibliotheken gibt es in
 * dieser Fassung nicht; nachgeprueft an der ausgelieferten Datei, nicht
 * aus dem Gedaechtnis.
 *
 * Auch die Preismarken werden neu gesetzt: Ein nachgezogener Stop muss
 * dorthin wandern, wo er jetzt liegt.
 */
async function chartNachfuehren() {
  if (!chartInstanz || !chartPlanId) return;

  var behaelter = document.getElementById('pd-chart');
  // Das Fenster kann zwischenzeitlich geschlossen worden sein.
  if (!behaelter || !behaelter.offsetParent) return;

  // Wonach gefragt wurde, wird festgehalten: Der Vergleich danach ist
  // sonst nicht moeglich, weil beide Veraenderlichen bis dahin schon
  // umgeschrieben sein koennen.
  var gefragtPlan = chartPlanId;
  var gefragtIntervall = chartIntervall;

  try {
    var d = await apiFetch('/trade-plans/' + encodeURIComponent(gefragtPlan) +
      '/kerzen?intervall=' + encodeURIComponent(gefragtIntervall) + '&anzahl=300');
    if (!d || !d.kerzen || !d.kerzen.length) return;

    // Zwischen Abfrage und Antwort kann der Nutzer einen anderen Plan
    // geoeffnet oder das Zeitraster umgestellt haben. Auf null zu
    // pruefen reichte dafuer nicht: Beim Wechsel sind beide gesetzt,
    // nur eben auf etwas anderes — und 15m-Kerzen in einem
    // 4h-Chart faellt niemandem auf.
    if (!chartInstanz) return;
    if (chartPlanId !== gefragtPlan || chartIntervall !== gefragtIntervall) return;

    var kerzen = d.kerzen.map(function (k) {
      return {
        timestamp: k.timestamp,
        open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
      };
    });

    chartInstanz.setDataLoader({
      getBars: function (args) {
        if (!args || typeof args.callback !== 'function') return;
        if (args.type === 'init') args.callback(kerzen, false);
        else args.callback([], false);
      },
    });
    if (typeof chartInstanz.resetData === 'function') chartInstanz.resetData();

    chartMarkenSetzen(chartInstanz, d.marken);
    chartFuellungenSetzen(chartInstanz, d.fuellungen, kerzen);
    chartSignalzeitSetzen(chartInstanz, d.signalzeit, kerzen);

    var quelle = document.getElementById('pd-chart-quelle');
    if (quelle) {
      quelle.textContent = kerzen.length + ' Kerzen von ' + d.quelle +
        (d.markt ? ' · ' + d.markt : '') +
        (d.fehler ? ' (zuletzt bekannter Stand)' : '');
    }
  } catch (e) {
    // Ein misslungener Durchgang darf den stehenden Chart nicht
    // wegwerfen — beim naechsten Mal klappt es vielleicht.
  }
}

function chartAufraeumen() {
  if (chartInstanz) {
    try { klinecharts.dispose(document.getElementById('pd-chart')); } catch (e) { /* egal */ }
    chartInstanz = null;
  }
}

/**
 * Vergisst den Plan — beim Schliessen der Detailansicht.
 *
 * Getrennt von `chartAufraeumen`, weil das auch beim Neuzeichnen
 * desselben Plans laeuft und die Kennung dann gebraucht wird.
 */
function chartVergessen() {
  chartAufraeumen();
  chartPlanId = null;
  chartZuletztGeholt = 0;
}

/** Zeitraster umschalten. */
function chartIntervallSetzen(intervall) {
  if (!chartPlanId) return;
  chartIntervall = intervall;

  var leiste = document.getElementById('pd-chart-intervalle');
  if (leiste) {
    Array.prototype.forEach.call(leiste.querySelectorAll('button'), function (b) {
      b.classList.toggle('btn-primary', b.dataset.iv === intervall);
      b.classList.toggle('btn-secondary', b.dataset.iv !== intervall);
    });
  }
  chartLaden(chartPlanId, intervall);
}
