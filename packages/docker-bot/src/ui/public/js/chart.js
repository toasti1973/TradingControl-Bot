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

  try {
    var d = await apiFetch('/trade-plans/' + encodeURIComponent(planId) +
      '/kerzen?intervall=' + encodeURIComponent(chartIntervall) + '&anzahl=300');

    if (!d || !d.kerzen || !d.kerzen.length) {
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
    behaelter.innerHTML = '<p class="form-hint">Chart nicht ladbar: ' +
      esc(String((e && e.message) || e)) + '</p>';
  }
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

  // --- Preismarken: Einstiege, Ziele, Stop ---
  //
  // Erst sie machen den Chart zur Aussage: Lag der Docht im Stop oder
  // drehte er knapp darueber?
  (d.marken || []).forEach(function (m) {
    var farbe = m.art === 'tp' ? '#26a69a'
      : m.art === 'sl' ? '#ef5350' : '#5b8def';
    try {
      chart.createOverlay({
        name: 'priceLine',
        points: [{ value: m.preis }],
        styles: {
          line: { color: farbe, style: m.art === 'sl' ? 'dashed' : 'solid', size: 1 },
          text: { color: farbe, backgroundColor: 'transparent' },
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

function chartAufraeumen() {
  if (chartInstanz) {
    try { klinecharts.dispose(document.getElementById('pd-chart')); } catch (e) { /* egal */ }
    chartInstanz = null;
  }
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
