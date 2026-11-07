// TradingControl Bot — Frontend App

const API_BASE = '/api';
let ws = null;
let authHeader = '';
let autoRefreshTimer = null;

// ========== Auth / Login ==========

function showLogin() {
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('app-container').style.display = 'none';
  document.getElementById('login-password').value = '';
  document.getElementById('login-password').focus();
  hideLoginError();
}

function showApp() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('app-container').style.display = 'flex';
  const page = (window.location.hash || '#dashboard').slice(1);
  navigate(allPages.includes(page) ? page : 'dashboard');
  connectWS();
  startAutoRefresh();
}

async function handleLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('login-password').value;
  const header = 'Basic ' + btoa('admin:' + pass);

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Anmelden...';

  try {
    const res = await fetch(API_BASE + '/dashboard', {
      headers: { 'Authorization': header },
    });
    if (res.ok) {
      authHeader = header;
      sessionStorage.setItem('tc-auth', header);
      showApp();
    } else {
      showLoginError('Falsches Passwort');
    }
  } catch {
    showLoginError('Verbindung fehlgeschlagen');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideLoginError() {
  document.getElementById('login-error').style.display = 'none';
}

function logout() {
  sessionStorage.removeItem('tc-auth');
  authHeader = '';
  if (ws) { ws.close(); ws = null; }
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  showLogin();
}

// ========== API ==========

async function apiFetch(path, options = {}) {
  if (!authHeader) {
    showLogin();
    return null;
  }
  try {
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        ...options.headers,
      },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('tc-auth');
      authHeader = '';
      showLogin();
      return null;
    }
    return res.json();
  } catch {
    return null;
  }
}

// ========== WebSocket ==========

function connectWS() {
  if (ws) return;
  // Auth-Token als query-Parameter (Base64-encoded credentials)
  var token = encodeURIComponent(authHeader.replace('Basic ', ''));
  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host + '/ws?token=' + token);

  ws.onmessage = function(event) {
    try {
      var msg = JSON.parse(event.data);
      handleWSMessage(msg);
    } catch (e) {
      // Malformed message ignorieren
    }
  };

  ws.onclose = function() {
    ws = null;
    if (authHeader) {
      setTimeout(connectWS, 3000);
    }
  };
}

function handleWSMessage(msg) {
  const type = msg.type;
  const data = msg.data;

  if (type === 'status' || type === 'bot:started' || type === 'bot:stopped' || type === 'bot:config-updated') {
    updateDashboard();
  }
  if (type === 'price:update') {
    updatePrice(data.symbol, data.price);
  }
  if (type === 'order:placed' || type === 'order:filled') {
    addLogEntry('[' + new Date().toLocaleTimeString() + '] ' + type + ': ' + JSON.stringify(data));
  }
  if (type === 'plan:activated' || type === 'plan:completed' || type === 'plan:error') {
    updateDashboard();
    addLogEntry('[' + new Date().toLocaleTimeString() + '] ' + type + ': ' + JSON.stringify(data));
  }
}

// ========== Routing ==========

var allPages = ['dashboard', 'plans', 'planning', 'tradeplans', 'signale', 'trades', 'auswertung', 'copytrading', 'settings', 'logs'];

function navigate(page) {
  allPages.forEach(function(p) {
    var el = document.getElementById('page-' + p);
    var nav = document.getElementById('nav-' + p);
    if (el) el.style.display = p === page ? 'block' : 'none';
    if (nav) nav.classList.toggle('active', p === page);
  });
  window.location.hash = page;
  loadPage(page);
}

function loadPage(page) {
  // Der Betriebsmodus haengt an keiner Seite — er gilt immer, und
  // eine veraltete Anzeige waere hier gefaehrlicher als anderswo.
  if (typeof zuLaden === 'function') zuLaden();

  switch (page) {
    case 'dashboard': updateDashboard(); break;
    case 'plans': updatePlans(); break;
    case 'planning': updateLocalPlans(); break;
    case 'trades': updateTrades(); break;
    case 'copytrading': updateCopyTrading(); break;
    case 'tradeplans': updateTradePlans(); break;
    case 'signale': updateSignale(); break;
    case 'auswertung': updateAuswertung(); lgLaden(); kalLaden(); break;
    case 'settings': updateSettings(); risikoprofilLaden(); uebungskontoLaden(); hpLaden(); break;
    case 'logs': updateLogs(); break;
  }
}

// ============================================================
// Selbsttaetiges Nachladen
//
// Alle zehn Sekunden holt die gerade sichtbare Seite ihre Daten neu.
// Nachgezeichnet wird nur, was sich geaendert hat (tabelleZeichnen) —
// ein vollstaendiges Ersetzen des Tabelleninhalts liesse die Seite im
// Sekundentakt zucken und risse jede Textauswahl mit.
//
// Seiten, auf denen gerade etwas eingegeben wird, bleiben aussen vor:
// Die Einstellungen und das Planformular wuerden sonst beim Tippen
// unter den Haenden neu geladen.
// ============================================================

// Ueber Namen, nicht ueber Funktionsreferenzen: updateSignale steht in
// signale.js und waere hier je nach Ladereihenfolge noch unbekannt.
// loadPage() kennt die Zuordnung ohnehin.
var AKTUALISIERENDE_SEITEN = [
  'dashboard', 'plans', 'planning', 'tradeplans', 'signale', 'trades',
  'auswertung',
];

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(function() {
    // Ein unsichtbarer Reiter braucht keine Daten — und erzeugt sonst
    // beim Zurueckkommen einen Schwall nachgeholter Abfragen.
    if (document.hidden) return;

    // Die Detailansicht zuerst: Wer sie offen hat, sieht auf sie und
    // nicht auf die Liste dahinter.
    if (typeof planDetailAktualisieren === 'function') {
      try {
        planDetailAktualisieren();
      } catch (e) {
        console.error('[refresh:detail]', e);
      }
    }

    var current = (window.location.hash || '#dashboard').slice(1);
    if (AKTUALISIERENDE_SEITEN.indexOf(current) < 0) return;

    // Solange das Planformular offen ist, wird nicht unter den Haenden
    // nachgeladen.
    var formular = document.getElementById('plan-form-overlay');
    if (current === 'planning' && formular && formular.style.display !== 'none') return;

    try {
      loadPage(current);
    } catch (e) {
      console.error('[refresh]', e);
    }
  }, 10000);
}

// ============================================================
// Flimmerfreies Nachzeichnen
// ============================================================

var FLACK_KLASSEN = ['tc-flack-gruen', 'tc-flack-rot', 'tc-flack-neutral'];

/**
 * Zeichnet eine Tabelle neu, ohne sie neu aufzubauen.
 *
 * Die Zeilen werden ueber ihren Schluessel wiedererkannt (data-plan
 * oder data-key, sonst die Position). Eine wiedererkannte Zeile bleibt
 * stehen; ersetzt wird nur der Inhalt der Zellen, die sich tatsaechlich
 * geaendert haben. Genau diese Zellen leuchten kurz auf.
 *
 * Der Unterschied zu `tbody.innerHTML = html` ist fuer das Auge
 * erheblich: Dort entsteht die Tabelle in jedem Durchgang neu, mit
 * einem kurzen Leerzustand, verlorener Textauswahl und verlorenem
 * Hover.
 */
function tabelleZeichnen(tbody, html) {
  if (!tbody) return;

  var werkbank = document.createElement('tbody');
  werkbank.innerHTML = html;

  // Beim ersten Mal gibt es nichts abzugleichen — und nichts, dessen
  // Aenderung der Rede wert waere.
  if (!tbody.children.length) {
    tbody.innerHTML = html;
    return;
  }

  var alteNachSchluessel = {};
  for (var i = 0; i < tbody.children.length; i++) {
    alteNachSchluessel[zeilenSchluessel(tbody.children[i], i)] = tbody.children[i];
  }

  var neueZeilen = Array.prototype.slice.call(werkbank.children);
  var behalten = {};

  neueZeilen.forEach(function (neu, index) {
    var schluessel = zeilenSchluessel(neu, index);
    var alt = alteNachSchluessel[schluessel];

    if (alt) {
      zeilenAbgleichen(alt, neu);
      behalten[schluessel] = true;
      // appendChild verschiebt den bestehenden Knoten an das Ende —
      // damit stimmt am Schluss die Reihenfolge der neuen Liste.
      tbody.appendChild(alt);
    } else {
      tbody.appendChild(neu);
    }
  });

  // Was in der neuen Liste nicht mehr vorkommt, faellt weg.
  Object.keys(alteNachSchluessel).forEach(function (schluessel) {
    if (!behalten[schluessel]) {
      var el = alteNachSchluessel[schluessel];
      if (el.parentNode === tbody) tbody.removeChild(el);
    }
  });
}

function zeilenSchluessel(tr, index) {
  return tr.getAttribute('data-plan') || tr.getAttribute('data-key') || ('#' + index);
}

function zeilenAbgleichen(alt, neu) {
  // Unterschiedlich viele Zellen heisst: ein anderer Aufbau. Dann hilft
  // kein Abgleich, dann muss die Zeile neu.
  if (alt.children.length !== neu.children.length) {
    alt.innerHTML = neu.innerHTML;
    return;
  }

  if (alt.getAttribute('style') !== neu.getAttribute('style')) {
    var stil = neu.getAttribute('style');
    if (stil == null) alt.removeAttribute('style'); else alt.setAttribute('style', stil);
  }

  for (var i = 0; i < alt.children.length; i++) {
    var a = alt.children[i];
    var b = neu.children[i];
    if (a.innerHTML === b.innerHTML) continue;

    var vorher = zahlAus(a.textContent);
    var nachher = zahlAus(b.textContent);
    a.innerHTML = b.innerHTML;
    aufflackern(a, vorher, nachher, a.getAttribute('data-flack') || b.getAttribute('data-flack'));
  }
}

/**
 * Laesst ein Element kurz aufleuchten.
 *
 * Die Farbe richtet sich nach der Richtung der Zahl. `art="invers"`
 * dreht sie um — bei einem Short ist ein fallender Kurs die gute
 * Nachricht. `art="neutral"` verzichtet auf die Wertung: Eine
 * gestiegene gebundene Margin ist weder gut noch schlecht.
 */
function aufflackern(el, vorher, nachher, art) {
  var klasse = 'tc-flack-neutral';

  if (art !== 'neutral' && vorher != null && nachher != null && vorher !== nachher) {
    var besser = nachher > vorher;
    if (art === 'invers') besser = !besser;
    klasse = besser ? 'tc-flack-gruen' : 'tc-flack-rot';
  }

  FLACK_KLASSEN.forEach(function (k) { el.classList.remove(k); });
  // Erzwingt einen Umbruch, damit die Animation auch dann neu
  // anlaeuft, wenn dieselbe Klasse gleich wieder gesetzt wird.
  void el.offsetWidth;
  el.classList.add(klasse);

  setTimeout(function () { el.classList.remove(klasse); }, 1500);
}

/**
 * Die Zahl in einem Text — gleich welcher Schreibweise.
 *
 * "+8,07 USDT" ergibt 8.07, "1.030,59" ergibt 1030.59, "75.57" ergibt
 * 75.57. Entscheidend ist das Komma: Steht eines da, ist es der
 * Dezimaltrenner und Punkte sind Tausenderpunkte. Fehlt es, stammt die
 * Zahl aus einem toFixed und der Punkt trennt die Nachkommastellen.
 */
function zahlAus(text) {
  if (text == null) return null;
  var s = String(text).replace(/ /g, ' ');
  var treffer = s.match(/[-+]?\d[\d.,]*/);
  if (!treffer) return null;

  var roh = treffer[0];
  if (roh.indexOf(',') >= 0) {
    roh = roh.replace(/\./g, '').replace(',', '.');
  }
  var n = parseFloat(roh);
  return isFinite(n) ? n : null;
}

/**
 * Setzt einen Text und laesst ihn bei Aenderung aufleuchten.
 *
 * Fuer die Kennzahl-Kacheln: Sie stehen gross auf der Seite, und wer
 * nicht gerade hinsieht, bemerkte ihre Aenderung sonst nicht.
 */
function setTextLive(id, text, art) {
  var el = document.getElementById(id);
  if (!el) return;
  var alt = el.textContent;
  if (alt === text) return;

  var vorher = zahlAus(alt);
  var nachher = zahlAus(text);
  el.textContent = text;

  // Beim ersten Befuellen ist noch nichts geschehen, was aufleuchten
  // muesste.
  if (alt !== '' && alt !== '-' && alt !== '0') {
    aufflackern(el, vorher, nachher, art);
  }
}

// ========== Dashboard ==========

async function updateDashboard() {
  // Der Ausfuehrungsstand kommt aus einer zweiten Abfrage; ohne ihn
  // blieben Fortschritt, Stop-Loss und Ergebnis in den Zeilen leer.
  await monitorStandLaden();
  var data = await apiFetch('/dashboard');
  if (!data) return;

  setText('stat-status', data.status);
  setStatusBadge('stat-status', data.status);
  setText('stat-broker', data.broker);
  setTextLive('stat-plans', String(data.activePlans), 'neutral');
  setTextLive('stat-trades', String(data.totalTrades), 'neutral');
  setText('stat-uptime', formatUptime(data.uptime));

  // KPIs
  if (data.kpi) {
    // Die gebundene Margin steigt und faellt mit dem Einstieg — das ist
    // keine gute und keine schlechte Nachricht, nur eine Tatsache.
    setTextLive('kpi-margin', data.kpi.margin.toFixed(2) + ' USDT', 'neutral');

    var pnl = data.kpi.realizedPnl;
    setTextLive('kpi-pnl', (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' USDT');
    document.getElementById('kpi-pnl').style.color =
      pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : '';

    setTextLive('kpi-roi', (data.kpi.roi >= 0 ? '+' : '') + data.kpi.roi.toFixed(2) + '%');
    // Wozu die Prozentzahl ins Verhaeltnis gesetzt ist. Ohne diese
    // Angabe laesst sich eine Rendite nicht einordnen — und die Zahl
    // bezog sich frueher auf die gerade gebundene Margin, was bei fast
    // geschlossenen Positionen absurde Werte ergab.
    setText('kpi-roi-basis', data.kpi.roiBasis
      ? 'bezogen auf ' + data.kpi.roiBasis.toFixed(2) + ' USDT' : '');
    document.getElementById('kpi-roi').style.color =
      data.kpi.roi > 0 ? 'var(--green)' : data.kpi.roi < 0 ? 'var(--red)' : '';

    var upnl = data.kpi.unrealizedPnl;
    setTextLive('kpi-upnl', (upnl >= 0 ? '+' : '') + upnl.toFixed(2) + ' USDT');
    document.getElementById('kpi-upnl').style.color =
      upnl > 0 ? 'var(--green)' : upnl < 0 ? 'var(--red)' : '';
  }

  if (data.lastError) {
    setText('stat-error', data.lastError);
    show('error-card');
  } else {
    hide('error-card');
  }

  var tbody = document.getElementById('active-plans-body');
  if (tbody) {
    if (data.plans.length === 0) {
      tabelleZeichnen(tbody, '<tr data-key="leer"><td colspan="13" class="empty-state">Keine aktiven Plaene</td></tr>');
    } else {
      tabelleZeichnen(tbody, data.plans.map(function(p) {
        // Bei einem Short ist der fallende Kurs die gute Nachricht —
        // das Aufleuchten muss sich danach richten, sonst leuchtet
        // ausgerechnet der Gewinn rot.
        var kursFlack = p.direction === 'short' ? ' data-flack="invers"' : '';
        var srcBadge = quellAbzeichen(p.source);
        var size = groesseZelle(p);
        var start = p.created_at ? new Date(p.created_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '-';

        // Nur Vollplaene haben eine Detailansicht — die Engine- und
        // local_plans laufen ueber einen anderen Pfad und haben unter
        // /trade-plans/:id keinen Eintrag.
        var vollplan = p.source === 'tc' || p.source === 'local' || p.source === 'signal';
        vollplan = vollplan && p.ergebnis != null;

        return '<tr data-key="' + esc(p.id) + '"' + (vollplan
            ? ' style="cursor:pointer" title="Einzelheiten anzeigen"'
              + ' data-plan="' + esc(p.id) + '"'
              + ' onclick="planDetailOeffnen(this.dataset.plan)"'
            : '') + '>' +
          '<td><strong>' + esc(p.symbol) + '</strong></td>' +
          '<td><span class="badge ' + (p.direction === 'long' ? 'badge-green' : 'badge-red') + '">' + esc(p.direction) + '</span></td>' +
          '<td data-flack="neutral">' + size + '</td>' +
          '<td>' + einstiegZelle(p) + '</td>' +
          '<td>' + fortschritt(p.id) + aufsichtHinweis(p) + '</td>' +
          '<td' + kursFlack + '>' + slAnzeige(p.id, p.stop_loss_price) + '</td>' +
          '<td' + kursFlack + '>' + kursAnzeige(p.id) + '</td>' +
          '<td>' + ergebnisZelle(p) + '</td>' +
          '<td>' + renditeZelle(p) + '</td>' +
          '<td data-flack="neutral"><span class="badge badge-default">' + esc(p.status) + '</span></td>' +
          '<td data-flack="neutral">' + srcBadge + '</td>' +
          '<td data-flack="neutral">' + start + '</td>' +
          '<td data-flack="neutral">' + beendenKnopf(p, vollplan) + '</td>' +
          '</tr>';
      }).join(''));
    }
  }

  dashboardBeendetZeichnen(data.beendet || [], data.beendetGesamt || 0);

  var startBtn = document.getElementById('btn-start');
  var stopBtn = document.getElementById('btn-stop');
  if (startBtn && stopBtn) {
    startBtn.style.display = data.status === 'running' ? 'none' : 'inline-flex';
    stopBtn.style.display = data.status === 'running' ? 'inline-flex' : 'none';
  }

  // RiskGuard
  var riskCard = document.getElementById('risk-card');
  if (data.risk && riskCard) {
    riskCard.style.display = 'block';

    // Ein steigender Verlust ist die schlechte Richtung — deshalb
    // invers: groessere Zahl, rotes Aufleuchten.
    setTextLive('risk-daily', data.risk.dailyLossPct + '%', 'invers');
    setTextLive('risk-weekly', data.risk.weeklyLossPct + '%', 'invers');
    setTextLive('risk-drawdown', data.risk.drawdownPct + '%', 'invers');

    // Worauf sich die Prozente beziehen — ohne diese Angabe sagt
    // "0,9 %" wenig.
    var bezug = document.getElementById('risk-bezug');
    if (bezug && data.risk.kapital) {
      var heute = data.risk.realisiertHeute;
      bezug.textContent = 'bezogen auf ' + Number(data.risk.kapital).toLocaleString('de-DE',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT' +
        (heute != null ? ' · heute realisiert ' + (heute >= 0 ? '+' : '') +
          Number(heute).toFixed(2) + ' USDT' : '');
    }

    var badge = document.getElementById('risk-badge');
    if (data.risk.halted) {
      badge.textContent = 'GESTOPPT';
      badge.className = 'badge badge-red';
      riskCard.style.borderColor = 'var(--red)';
      var haltEl = document.getElementById('risk-halt-reason');
      haltEl.textContent = data.risk.haltReason;
      haltEl.style.display = 'block';
    } else {
      var warn = parseFloat(data.risk.dailyLossPct) > 3 || parseFloat(data.risk.drawdownPct) > 10;
      badge.textContent = warn ? 'WARNUNG' : 'OK';
      badge.className = warn ? 'badge badge-yellow' : 'badge badge-green';
      riskCard.style.borderColor = warn ? 'var(--yellow)' : 'var(--border)';
      document.getElementById('risk-halt-reason').style.display = 'none';
    }

    var cooldownEl = document.getElementById('risk-cooldowns');
    var cooldownEntries = Object.entries(data.risk.cooldowns || {});
    if (cooldownEntries.length > 0) {
      cooldownEl.textContent = 'Cooldown: ' + cooldownEntries.map(function(e) { return e[0] + ' (' + e[1] + ' Min.)'; }).join(', ');
      cooldownEl.style.display = 'block';
    } else {
      cooldownEl.style.display = 'none';
    }
  }

  // Volatility
  var volCard = document.getElementById('vol-card');
  var volSymbols = document.getElementById('vol-symbols');
  if (data.volatility && volCard && volSymbols) {
    var entries = Object.entries(data.volatility);
    if (entries.length > 0) {
      volCard.style.display = 'block';
      volSymbols.innerHTML = entries.map(function(e) {
        var sym = e[0];
        var v = e[1];
        if (!v || v.atr === null) return '<div style="margin-bottom:4px;">' + esc(sym) + ': <span style="color:var(--text-muted)">Berechnung...</span></div>';
        var ratio = v.volatilityRatio ? v.volatilityRatio.toFixed(2) : '-';
        var color = v.highVolatility ? 'var(--red)' : (v.volatilityRatio > 1.3 ? 'var(--yellow)' : 'var(--green)');
        var label = v.highVolatility ? 'HOCH' : (v.volatilityRatio > 1.3 ? 'Erhoht' : 'Normal');
        return '<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px;">' +
          '<strong>' + esc(sym) + '</strong>' +
          '<span>ATR: ' + v.atr.toFixed(2) + '</span>' +
          '<span style="color:var(--text-muted)">Avg: ' + v.avgAtr.toFixed(2) + '</span>' +
          '<span style="color:var(--text-muted)">Ratio: ' + ratio + 'x</span>' +
          '<span class="badge" style="background:' + color + '22;color:' + color + '">' + label + '</span>' +
          (v.lowLiquidity ? '<span class="badge badge-yellow">Low Liquidity</span>' : '') +
          '</div>';
      }).join('');
    } else {
      volCard.style.display = 'none';
    }
  }

  // Connection ping (fire-and-forget, nicht blockierend)
  apiFetch('/ping').then(function(ping) {
    if (!ping) return;
    var tcDot = document.getElementById('conn-tc-dot');
    var tcPing = document.getElementById('conn-tc-ping');
    if (ping.tc) {
      tcDot.className = ping.tc.connected ? 'dot dot-green' : 'dot dot-red';
      tcPing.textContent = ping.tc.connected ? ping.tc.pingMs + 'ms' : (ping.tc.error || 'Offline');
      tcPing.style.color = ping.tc.connected ? 'var(--green)' : 'var(--red)';
    }
    var brDot = document.getElementById('conn-broker-dot');
    var brPing = document.getElementById('conn-broker-ping');
    var brName = document.getElementById('conn-broker-name');
    if (ping.broker) {
      brDot.className = ping.broker.connected ? 'dot dot-green' : 'dot dot-red';
      brPing.textContent = ping.broker.connected ? ping.broker.pingMs + 'ms' : (ping.broker.error || 'Offline');
      brPing.style.color = ping.broker.connected ? 'var(--green)' : 'var(--red)';
      if (ping.broker.broker) brName.textContent = ping.broker.broker;
    }
  });
}

/**
 * Die erledigten Plaene, unter den aktiven und von ihnen getrennt.
 *
 * Getrennt, weil beides verschiedene Fragen beantwortet: Oben steht,
 * was Aufsicht braucht, unten, wie es ausging. Gemischt verliert die
 * obere Liste ihren Zweck — ein Dutzend abgeschlossener Trades
 * verdeckt den einen, bei dem der Stop gleich greift.
 */
function dashboardBeendetZeichnen(beendet, gesamt) {
  var block = document.getElementById('dash-beendet-block');
  var body = document.getElementById('dash-beendet-body');
  if (!block || !body) return;

  if (!beendet.length) {
    block.style.display = 'none';
    body.innerHTML = '';
    return;
  }
  block.style.display = 'block';

  var zahl = document.getElementById('dash-beendet-zahl');
  if (zahl) {
    // Die Liste ist gekuerzt, die Zahl ist es nicht — sonst sieht ein
    // Konto mit 80 abgeschlossenen Trades aus wie eines mit 25.
    zahl.textContent = beendet.length < gesamt
      ? beendet.length + ' von ' + gesamt
      : String(gesamt);
  }

  tabelleZeichnen(body, beendet.map(function(p) {
    var beendetAm = p.updated_at
      ? new Date(p.updated_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})
      : '-';

    return '<tr style="cursor:pointer" title="Einzelheiten anzeigen"' +
      ' data-plan="' + esc(p.id) + '"' +
      ' onclick="planDetailOeffnen(this.dataset.plan)">' +
      '<td><strong>' + esc(p.symbol) + '</strong></td>' +
      '<td><span class="badge ' + (p.direction === 'long' ? 'badge-green' : 'badge-red') + '">' + esc(p.direction) + '</span></td>' +
      '<td>' + groesseZelle(p) + '</td>' +
      '<td>' + einstiegZelle(p) + '</td>' +
      '<td>' + ausgangZelle(p) + '</td>' +
      '<td>' + ergebnisZelle(p) + '</td>' +
      '<td>' + renditeZelle(p) + '</td>' +
      '<td data-flack="neutral"><span class="badge badge-default">' + esc(p.status) + '</span></td>' +
      '<td data-flack="neutral">' + quellAbzeichen(p.source) + '</td>' +
      '<td data-flack="neutral">' + beendetAm + '</td>' +
      '</tr>';
  }).join(''));
}

/**
 * Wie ein Plan ausging — in einem Wort.
 *
 * Der Status allein sagt es nicht: 'completed' steht sowohl ueber dem
 * Trade, der alle Take-Profits mitnahm, als auch ueber dem, den der
 * Stop erwischte.
 */
function ausgangZelle(p) {
  var e = p.ergebnis;
  if (!e || !e.eingestiegen) {
    return '<span style="color:var(--text-muted)" title="Es wurde nie eingestiegen">nicht gehandelt</span>';
  }

  // Erst gefragt, ob ueberhaupt etwas geschlossen wurde.
  //
  // `realisiert` enthaelt auch die Gebuehren. Ein Plan, der nur
  // einstieg und dann abgebrochen wurde, hat dadurch ein Minus — und
  // galt hier als "im Verlust", obwohl nie eine Position geschlossen
  // wurde. Das verzerrt die Beurteilung des Signalgebers: Der Trade
  // ging nicht schlecht aus, er ging gar nicht aus.
  if (!e.geschlossen) {
    return '<span style="color:var(--text-muted)" ' +
      'title="Eingestiegen, aber nie geschlossen — nur Gebuehren gebucht">' +
      'ohne Abschluss</span>';
  }

  if (e.realisiert > 0) {
    return '<span style="color:var(--green)">im Gewinn</span>';
  }
  if (e.realisiert < 0) {
    return '<span style="color:var(--red)">im Verlust</span>';
  }
  return '<span style="color:var(--text-muted)">ohne Ergebnis</span>';
}

/**
 * Gilt ein Plan als erledigt?
 *
 * Gleiche Einteilung wie im Dashboard-Dienst (dashboard.ts): 'error'
 * zaehlt dazu, denn der Plan handelt nicht mehr — auch wenn er nicht
 * planmaessig endete.
 */
function istBeendeterStatus(status) {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

async function startBot() {
  await apiFetch('/bot/start', { method: 'POST' });
  updateDashboard();
}

async function stopBot() {
  if (!confirm('Bot wirklich stoppen?')) return;
  await apiFetch('/bot/stop', { method: 'POST' });
  updateDashboard();
}

// ========== Plans ==========

async function updatePlans() {
  var data = await apiFetch('/plans');
  if (!data) return;

  var tbody = document.getElementById('plans-body');
  if (!tbody) return;

  // Erledigte gehoeren nach unten, nicht zwischen die laufenden.
  var aktiv = data.plans.filter(function(p) { return !istBeendeterStatus(p.status); });
  var beendet = data.plans.filter(function(p) { return istBeendeterStatus(p.status); });

  tabelleZeichnen(tbody, aktiv.length
    ? aktiv.map(planZeile).join('')
    : '<tr data-key="leer"><td colspan="12" class="empty-state">Keine aktiven Plaene</td></tr>');

  var block = document.getElementById('plans-beendet-block');
  var beendetBody = document.getElementById('plans-beendet-body');
  if (block && beendetBody) {
    block.style.display = beendet.length ? 'block' : 'none';
    tabelleZeichnen(beendetBody, beendet.map(planZeile).join(''));
    var zahl = document.getElementById('plans-beendet-zahl');
    if (zahl) zahl.textContent = String(beendet.length);
  }
}

function planZeile(p) {
  var srcBadge = quellAbzeichen(p.source);
  // Nur Vollplaene tragen eine Ergebnisrechnung und damit eine
  // Detailansicht unter /trade-plans/:id.
  var vollplan = p.ergebnis != null;

  // Die Uebersicht liefert die Zahl der geplanten Einstiege unter
  // `entry_orders` — einstiegZelle() erwartet sie unter
  // `entries_geplant` wie im Dashboard.
  var fuerZelle = {
    ergebnis: p.ergebnis,
    entries_geplant: typeof p.entry_orders === 'number' ? p.entry_orders : null,
  };

  return '<tr data-key="' + esc(p.id) + '"' + (vollplan
      ? ' style="cursor:pointer" title="Einzelheiten anzeigen"'
        + ' data-plan="' + esc(p.id) + '"'
        + ' onclick="planDetailOeffnen(this.dataset.plan)"'
      : '') + '>' +
    '<td><strong>' + esc(p.symbol) + '</strong></td>' +
    '<td><span class="badge ' + (p.direction === 'long' ? 'badge-green' : 'badge-red') + '">' + esc(p.direction) + '</span></td>' +
    '<td data-flack="neutral">' + esc(p.market_type) + '</td>' +
    '<td data-flack="neutral">' + p.leverage + 'x</td>' +
    '<td>' + einstiegZelle(fuerZelle) + '</td>' +
    '<td data-flack="neutral"><span class="badge badge-default">' + esc(p.status) + '</span>' + aufsichtHinweis(p) + '</td>' +
    '<td data-flack="neutral">' + (p.bot_enabled ? '<span class="dot dot-green"></span>' : '<span class="dot dot-red"></span>') + '</td>' +
    '<td>' + ergebnisZelle(p) + '</td>' +
    '<td>' + renditeZelle(p) + '</td>' +
    '<td data-flack="neutral">' + srcBadge + '</td>' +
    '<td data-flack="neutral">' + new Date(p.created_at).toLocaleDateString('de-DE') + '</td>' +
    '<td data-flack="neutral">' + beendenKnopf(p, vollplan) + '</td>' +
    '</tr>';
}

// ========== Trades ==========

async function updateTrades() {
  var data = await apiFetch('/trades?limit=100');
  if (!data) return;

  var tbody = document.getElementById('trades-body');
  if (!tbody) return;

  if (data.trades.length === 0) {
    tabelleZeichnen(tbody, '<tr data-key="leer"><td colspan="11" class="empty-state">Keine Trades vorhanden</td></tr>');
    return;
  }

  tabelleZeichnen(tbody, data.trades.map(tradeZeile).join(''));
}

/**
 * Eine Zeile der Trade-Historie.
 *
 * PnL und ROI kommen vom Server, nicht aus einer Rechnung hier: Er
 * kennt den Durchschnittseinstieg des Plans und die Richtung. Eine
 * Oberflaeche, die das selbst schaetzt, weicht frueher oder spaeter
 * von der Ergebnisrechnung ab — und dann stimmt keine der beiden
 * Zahlen mehr.
 */
function tradeZeile(t) {
  var pnl = Number(t.pnl) || 0;
  var farbe = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--text-muted)';
  var istEinstieg = t.role === 'entry' || t.side === 'entry';

  var schluessel = t.id != null ? String(t.id) : (String(t.plan_id) + '-' + String(t.timestamp));
  var plan = t.plan_id ? String(t.plan_id) : '';

  return '<tr data-key="' + esc(schluessel) + '"' +
    (plan ? ' style="cursor:pointer" title="Plan anzeigen" data-plan="' + esc(plan) +
      '" onclick="planDetailOeffnen(this.dataset.plan)"' : '') + '>' +
    '<td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">' +
      esc(zeitKurz(t.timestamp)) + '</td>' +
    '<td><strong>' + esc(t.symbol || '-') + '</strong></td>' +
    '<td>' + (t.direction
      ? '<span class="badge ' + (t.direction === 'long' ? 'badge-green' : 'badge-red') + '">' +
        esc(t.direction) + '</span>'
      : '<span style="color:var(--text-muted)">–</span>') + '</td>' +
    '<td><span class="badge ' + (istEinstieg ? 'badge-blue' :
      (t.role === 'take_profit' ? 'badge-green' : 'badge-red')) + '">' +
      esc(t.action || '-') + '</span></td>' +
    '<td style="text-align:right">' + mengeKurz(t.filled_quantity) + '</td>' +
    '<td style="text-align:right">' + preis(t.avg_fill_price) + '</td>' +
    '<td style="text-align:right">' + (t.entry_price != null
      ? preis(t.entry_price) : '<span style="color:var(--text-muted)">–</span>') + '</td>' +
    '<td style="text-align:right;color:var(--text-muted)">' +
      (t.fees ? geld(t.fees) : '–') + '</td>' +
    '<td style="text-align:right;color:' + farbe + ';font-weight:600">' +
      (pnl !== 0 ? (pnl > 0 ? '+' : '') + geld(pnl) : '–') + '</td>' +
    '<td style="text-align:right;color:' + farbe + '">' +
      (t.roi != null && t.roi !== 0
        ? (t.roi > 0 ? '+' : '') + Number(t.roi).toFixed(2) + ' %'
        : '<span style="color:var(--text-muted)">–</span>') + '</td>' +
    '<td>' + quellAbzeichen(t.source || t.quelle) + '</td>' +
    '</tr>';
}

// ========== Settings ==========

// Zuletzt geladene Einstellungen. Beim Speichern brauchen wir die Liste der
// Boersen wieder, um deren Felder gezielt einzusammeln.
var lastSettingsData = null;

async function updateSettings() {
  var data = await apiFetch('/settings');
  if (!data) return;
  lastSettingsData = data;

  document.getElementById('cfg-tc-url').value = data.tcApiUrl || '';

  var tcKeyEl = document.getElementById('cfg-tc-key');
  tcKeyEl.value = '';
  tcKeyEl.placeholder = data.tcApiKeyConfigured ? 'Konfiguriert (leer lassen um beizubehalten)' : 'tc_bot_...';
  document.getElementById('cfg-tc-key-hint').innerHTML = data.tcApiKeyConfigured ? 'Aktuell konfiguriert. <a href="#" onclick="clearSensitiveKey(\'cfg-tc-key\',\'tcApiKey\');return false;" style="color:var(--red);">Loeschen</a>' : '';

  document.getElementById('cfg-nur-mica').checked = data.nurMicaBoersen !== false;
  renderExchangeSettings(data);

  document.getElementById('cfg-plan-poll').value = data.planPollInterval;
  document.getElementById('cfg-price-poll').value = data.pricePollInterval;
  document.getElementById('cfg-order-check').value = data.orderCheckInterval;
  document.getElementById('cfg-log-level').value = data.logLevel;

  // Telegram
  document.getElementById('cfg-telegram-enabled').checked = !!data.telegramEnabled;

  var tgToken = document.getElementById('cfg-telegram-token');
  tgToken.value = '';
  tgToken.placeholder = data.telegramBotTokenConfigured ? 'Konfiguriert (leer lassen um beizubehalten)' : '123456:ABC-DEF...';
  document.getElementById('cfg-telegram-token-hint').textContent = data.telegramBotTokenConfigured ? 'Aktuell konfiguriert.' : '';

  document.getElementById('cfg-telegram-chatid').value = data.telegramChatId || '';

  document.getElementById('cfg-tg-order-placed').checked = data.telegramNotify_order_placed !== false;
  document.getElementById('cfg-tg-order-filled').checked = data.telegramNotify_order_filled !== false;
  document.getElementById('cfg-tg-plan-activated').checked = data.telegramNotify_plan_activated !== false;
  document.getElementById('cfg-tg-plan-completed').checked = data.telegramNotify_plan_completed !== false;
  document.getElementById('cfg-tg-plan-error').checked = data.telegramNotify_plan_error !== false;
  document.getElementById('cfg-tg-engine-error').checked = data.telegramNotify_engine_error !== false;

  toggleTelegramSettings();

  // Risk Management
  if (data.riskMaxDailyLossPct !== undefined) document.getElementById('cfg-risk-daily').value = data.riskMaxDailyLossPct;
  if (data.riskMaxWeeklyLossPct !== undefined) document.getElementById('cfg-risk-weekly').value = data.riskMaxWeeklyLossPct;
  if (data.riskMaxDrawdownPct !== undefined) document.getElementById('cfg-risk-drawdown').value = data.riskMaxDrawdownPct;
  if (data.riskSlCooldownMin !== undefined) document.getElementById('cfg-risk-cooldown').value = data.riskSlCooldownMin;
  if (data.riskMaxConcurrentPlans !== undefined) document.getElementById('cfg-risk-max-plans').value = data.riskMaxConcurrentPlans;

  // CopyTrading
  document.getElementById('set-ct-enabled').checked = !!data.ctEnabled;

  var claudeKey = document.getElementById('set-claude-api-key');
  claudeKey.value = '';
  claudeKey.placeholder = data.claudeApiKeyConfigured ? 'Konfiguriert (leer lassen)' : 'sk-ant-...';

  if (data.ctClaudeModel) document.getElementById('set-ct-claude-model').value = data.ctClaudeModel;
  if (data.ctPortfolioSize) document.getElementById('set-ct-portfolio').value = data.ctPortfolioSize;
  if (data.ctMinCombinedScore) document.getElementById('set-ct-min-combined').value = data.ctMinCombinedScore;
  if (data.ctMinConvictionScore) document.getElementById('set-ct-min-conviction').value = data.ctMinConvictionScore;

  // Passwort-Felder leeren
  document.getElementById('pw-old').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
}

function toggleTelegramSettings() {
  var enabled = document.getElementById('cfg-telegram-enabled').checked;
  document.getElementById('telegram-settings').style.display = enabled ? 'block' : 'none';
}

// ============================================================
// Boersen-Einstellungen
// ============================================================

var MICA_TEXT = {
  zugelassen: { label: 'EWR-Zulassung', farbe: 'var(--green)' },
  in_pruefung: { label: 'Zulassung offen', farbe: 'var(--yellow)' },
  keine: { label: 'Keine EWR-Zulassung', farbe: 'var(--red)' },
};

/**
 * Baut die Boersenliste aus der Antwort des Servers auf.
 *
 * Fest verdrahtete Felder je Boerse gingen nicht mehr: Welche Boersen es
 * gibt, steht im Verzeichnis des Bots — die Oberflaeche folgt ihm.
 */
function renderExchangeSettings(data) {
  var boersen = data.exchanges || [];

  // Auswahlliste fuer die Voreinstellung
  var select = document.getElementById('cfg-default-exchange');
  select.innerHTML = '<option value="paper">Uebungsbetrieb (kein echter Handel)</option>';
  boersen.forEach(function (b) {
    var opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.label + (b.mica === 'zugelassen' ? '' : ' — ' + MICA_TEXT[b.mica].label);
    select.appendChild(opt);
  });
  select.value = data.defaultExchange || 'paper';

  // Zugangsdaten je Boerse
  var liste = document.getElementById('exchange-list');
  liste.innerHTML = '';

  boersen.forEach(function (b) {
    var block = document.createElement('div');
    block.className = 'exchange-block';
    block.style.cssText = 'border-top:1px solid var(--border);padding-top:12px;margin-top:12px;';

    var mica = MICA_TEXT[b.mica] || MICA_TEXT.keine;
    var maerkte = [];
    if (b.supportsSpot) maerkte.push('Kasse');
    if (b.supportsFutures) maerkte.push('Termin');

    var kopf =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
      '<strong>' + escapeHtml(b.label) + '</strong>' +
      '<span style="color:' + mica.farbe + ';font-size:12px;">' + mica.label + '</span>' +
      (b.micaAufsicht ? '<span class="form-hint" style="font-size:11px;">' + escapeHtml(b.micaAufsicht) + '</span>' : '') +
      '<span class="form-hint" style="font-size:11px;">' + maerkte.join(' + ') + '</span>' +
      (b.eingerichtet ? '<span style="color:var(--green);font-size:12px;">eingerichtet</span>' : '') +
      '</div>' +
      (b.hinweis ? '<div class="form-hint" style="margin-top:4px;">' + escapeHtml(b.hinweis) + '</div>' : '');

    var felder =
      '<div class="form-row" style="margin-top:8px;">' +
      '<div class="form-group"><label>API Key</label>' +
      '<input type="password" id="ex-' + b.id + '-key" placeholder="' +
      (b.eingerichtet ? 'Hinterlegt (leer lassen)' : 'API Key') + '"></div>' +
      '<div class="form-group"><label>API Secret</label>' +
      '<input type="password" id="ex-' + b.id + '-secret" placeholder="' +
      (b.eingerichtet ? 'Hinterlegt (leer lassen)' : 'API Secret') + '"></div>' +
      (b.benoetigtPasswort
        ? '<div class="form-group"><label>Passphrase</label>' +
          '<input type="password" id="ex-' + b.id + '-password" placeholder="' +
          (b.eingerichtet ? 'Hinterlegt (leer lassen)' : 'Passphrase') + '"></div>'
        : '') +
      '</div>' +
      '<div class="form-row">' +
      (b.supportsSpot && b.supportsFutures
        ? '<div class="form-group"><label>Marktart</label>' +
          '<select id="ex-' + b.id + '-market">' +
          '<option value="futures"' + (b.marketType === 'futures' ? ' selected' : '') + '>Termin (Perpetual)</option>' +
          '<option value="spot"' + (b.marketType === 'spot' ? ' selected' : '') + '>Kasse</option>' +
          '</select></div>'
        : '') +
      (b.supportsSandbox
        ? '<div class="form-group"><label class="checkbox-label">' +
          '<input type="checkbox" id="ex-' + b.id + '-testnet"' + (b.testnet ? ' checked' : '') + '>' +
          '<span>Testumgebung</span></label></div>'
        : '') +
      '</div>';

    block.innerHTML = kopf + felder;
    liste.appendChild(block);
  });
}

/** Sammelt die ausgefuellten Boersen-Felder fuer das Speichern ein. */
function collectExchangeSettings(payload, boersen) {
  (boersen || []).forEach(function (b) {
    var key = document.getElementById('ex-' + b.id + '-key');
    var secret = document.getElementById('ex-' + b.id + '-secret');
    var password = document.getElementById('ex-' + b.id + '-password');
    var market = document.getElementById('ex-' + b.id + '-market');
    var testnet = document.getElementById('ex-' + b.id + '-testnet');

    // Leere Geheimfelder heissen "unveraendert lassen", nicht "loeschen".
    if (key && key.value) payload['exchange.' + b.id + '.apiKey'] = key.value;
    if (secret && secret.value) payload['exchange.' + b.id + '.apiSecret'] = secret.value;
    if (password && password.value) payload['exchange.' + b.id + '.password'] = password.value;
    if (market) payload['exchange.' + b.id + '.marketType'] = market.value;
    if (testnet) payload['exchange.' + b.id + '.testnet'] = testnet.checked;
  });
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function toggleVisibility(inputId, btn) {
  var input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Verbergen';
  } else {
    input.type = 'password';
    btn.textContent = 'Zeigen';
  }
}

async function saveSettings() {
  var btn = document.getElementById('btn-save-settings');
  btn.disabled = true;
  btn.textContent = 'Speichern...';

  var payload = {
    tcApiUrl: document.getElementById('cfg-tc-url').value,
    defaultExchange: document.getElementById('cfg-default-exchange').value,
    nurMicaBoersen: document.getElementById('cfg-nur-mica').checked,
    planPollInterval: parseInt(document.getElementById('cfg-plan-poll').value),
    pricePollInterval: parseInt(document.getElementById('cfg-price-poll').value),
    orderCheckInterval: parseInt(document.getElementById('cfg-order-check').value),
    logLevel: document.getElementById('cfg-log-level').value,
    riskMaxDailyLossPct: parseFloat(document.getElementById('cfg-risk-daily').value),
    riskMaxWeeklyLossPct: parseFloat(document.getElementById('cfg-risk-weekly').value),
    riskMaxDrawdownPct: parseFloat(document.getElementById('cfg-risk-drawdown').value),
    riskSlCooldownMin: parseInt(document.getElementById('cfg-risk-cooldown').value),
    riskMaxConcurrentPlans: parseInt(document.getElementById('cfg-risk-max-plans').value),
  };

  // Secrets: senden wenn ausgefuellt, oder '__DELETE__' wenn markiert
  var tcKey = document.getElementById('cfg-tc-key').value;
  if (tcKey) payload.tcApiKey = tcKey;
  else if (document.getElementById('cfg-tc-key').dataset.delete === 'true') payload.tcApiKey = '';

  collectExchangeSettings(payload, lastSettingsData && lastSettingsData.exchanges);

  // Telegram
  payload.telegramEnabled = document.getElementById('cfg-telegram-enabled').checked;
  payload.telegramChatId = document.getElementById('cfg-telegram-chatid').value;
  payload.telegramNotify_order_placed = document.getElementById('cfg-tg-order-placed').checked;
  payload.telegramNotify_order_filled = document.getElementById('cfg-tg-order-filled').checked;
  payload.telegramNotify_plan_activated = document.getElementById('cfg-tg-plan-activated').checked;
  payload.telegramNotify_plan_completed = document.getElementById('cfg-tg-plan-completed').checked;
  payload.telegramNotify_plan_error = document.getElementById('cfg-tg-plan-error').checked;
  payload.telegramNotify_engine_error = document.getElementById('cfg-tg-engine-error').checked;

  var tgToken = document.getElementById('cfg-telegram-token').value;
  if (tgToken) payload.telegramBotToken = tgToken;

  // CopyTrading
  payload.ctEnabled = document.getElementById('set-ct-enabled').checked;
  payload.ctClaudeModel = document.getElementById('set-ct-claude-model').value;
  payload.ctPortfolioSize = parseFloat(document.getElementById('set-ct-portfolio').value);
  payload.ctMinCombinedScore = parseInt(document.getElementById('set-ct-min-combined').value);
  payload.ctMinConvictionScore = parseInt(document.getElementById('set-ct-min-conviction').value);

  var claudeKey = document.getElementById('set-claude-api-key').value;
  if (claudeKey) payload.claudeApiKey = claudeKey;

  try {
    var res = await apiFetch('/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res && res.success) {
      showSettingsAlert(res.message || 'Einstellungen gespeichert.', 'success');
      setTimeout(updateSettings, 2000);
    } else {
      showSettingsAlert(res ? res.error : 'Fehler beim Speichern', 'error');
    }
  } catch {
    showSettingsAlert('Netzwerkfehler', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  }
}

async function testTcApi() {
  var btn = document.getElementById('btn-test-api');
  btn.disabled = true;
  btn.textContent = 'Teste...';

  try {
    var res = await apiFetch('/settings/test-connection', { method: 'POST' });
    if (!res) {
      showSettingsAlert('Keine Antwort vom Bot. Bitte warten und erneut versuchen.', 'error');
    } else if (res.success) {
      showSettingsAlert('Verbindung erfolgreich! ' + (res.message || ''), 'success');
    } else {
      showSettingsAlert('Verbindung fehlgeschlagen: ' + (res.error || 'Unbekannt'), 'error');
    }
  } catch {
    showSettingsAlert('Netzwerkfehler beim Testen', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'API testen';
  }
}

async function testTelegram() {
  var btn = document.getElementById('btn-test-telegram');
  btn.disabled = true;
  btn.textContent = 'Sende...';

  try {
    var res = await apiFetch('/settings/test-telegram', { method: 'POST' });
    if (res && res.success) {
      showSettingsAlert('Testnachricht gesendet! Pruefe deinen Telegram-Chat.', 'success');
    } else {
      showSettingsAlert('Telegram-Test fehlgeschlagen: ' + (res ? res.error : 'Unbekannt'), 'error');
    }
  } catch {
    showSettingsAlert('Netzwerkfehler beim Telegram-Test', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Testnachricht senden';
  }
}

async function changePassword() {
  var oldPw = document.getElementById('pw-old').value;
  var newPw = document.getElementById('pw-new').value;
  var confirmPw = document.getElementById('pw-confirm').value;

  if (!oldPw || !newPw) {
    showSettingsAlert('Bitte alle Passwort-Felder ausfuellen.', 'error');
    return;
  }

  if (newPw !== confirmPw) {
    showSettingsAlert('Neue Passwoerter stimmen nicht ueberein.', 'error');
    return;
  }

  if (newPw.length < 4) {
    showSettingsAlert('Neues Passwort muss mindestens 4 Zeichen lang sein.', 'error');
    return;
  }

  var btn = document.getElementById('btn-change-pw');
  btn.disabled = true;
  btn.textContent = 'Aendere...';

  try {
    var res = await apiFetch('/settings/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    });
    if (res && res.success) {
      showSettingsAlert('Passwort geaendert. Bitte neu anmelden.', 'success');
      setTimeout(function() {
        logout();
      }, 2000);
    } else {
      showSettingsAlert(res ? res.error : 'Passwort-Aenderung fehlgeschlagen', 'error');
    }
  } catch {
    showSettingsAlert('Netzwerkfehler', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Passwort aendern';
  }
}

function showSettingsAlert(msg, type) {
  var el = document.getElementById('settings-alert');
  el.textContent = msg;
  el.className = 'settings-alert ' + type;
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 8000);
}

// ========== Logs ==========

async function updateLogs() {
  var data = await apiFetch('/logs?limit=200');
  if (!data) return;

  var container = document.getElementById('log-output');
  if (!container) return;

  container.innerHTML = data.logs.map(function(log) {
    return '<div class="log-entry">' + esc(log) + '</div>';
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function addLogEntry(text) {
  var container = document.getElementById('log-output');
  if (!container) return;
  var entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = text;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ========== Price ==========

var priceElements = {};
function updatePrice(symbol, price) {
  var el = priceElements[symbol] || document.getElementById('price-' + symbol);
  if (el) {
    el.textContent = price.toFixed(2);
    priceElements[symbol] = el;
  }
}

// ========== Helpers ==========

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function setStatusBadge(id, status) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'badge ' + (
    status === 'running' ? 'badge-green' :
    status === 'error' ? 'badge-red' :
    status === 'starting' || status === 'stopping' ? 'badge-yellow' :
    'badge-default'
  );
}

function show(id) { var el = document.getElementById(id); if (el) el.style.display = 'block'; }
function hide(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; }

function formatUptime(ms) {
  if (!ms) return '--';
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}

function esc(text) {
  var div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// ============================================================
// Herkunft eines Plans
//
// Der Bot fuehrt drei Bestaende: aus dem Journal gespiegelt ('tc'),
// hier angelegt ('local') und aus einem externen Handelssignal
// ('signal'). Fruehere Fassungen kannten nur zwei und entschieden per
// Umkehrschluss — "nicht lokal, also TC". Ein Signal-Plan bekam
// dadurch je nach Ansicht ein anderes, in beiden Faellen falsches
// Abzeichen.
//
// Deshalb hier an einer Stelle und ausdruecklich.
// ============================================================
function quellAbzeichen(source) {
  if (source === 'tc') return '<span class="badge badge-accent">TC</span>';
  if (source === 'local') return '<span class="badge badge-yellow">Lokal</span>';
  if (source === 'signal') return '<span class="badge badge-blue">Signal</span>';
  return '<span class="badge badge-default">' + esc(source || 'unbekannt') + '</span>';
}

// ========== Tradeplanung (Local Plans) ==========

var tpCounter = 0;
var activationCounter = 0;

function showPlanForm() {
  // Reset form
  document.getElementById('pf-symbol').value = '';
  document.getElementById('pf-direction').value = 'long';
  document.getElementById('pf-market').value = 'futures';
  document.getElementById('pf-leverage').value = '1';
  document.getElementById('pf-total-size').value = '';
  document.getElementById('pf-entry-strategy').value = 'single';
  document.getElementById('pf-entry-price').value = '';
  document.getElementById('pf-entry-from').value = '';
  document.getElementById('pf-entry-to').value = '';
  document.getElementById('pf-entry-steps').value = '3';
  document.getElementById('pf-sl-price').value = '';
  document.getElementById('pf-sl-type').value = 'fixed';
  document.getElementById('pf-trailing-pct').value = '';
  document.getElementById('pf-trailing-activation').value = '';
  document.getElementById('pf-notes').value = '';
  document.getElementById('pf-tp-list').innerHTML = '';
  document.getElementById('pf-tp-header').style.display = 'none';
  document.getElementById('pf-activations-list').innerHTML = '';
  tpCounter = 0;
  activationCounter = 0;

  // Reset toggles
  document.querySelectorAll('[data-field="pf-direction"]').forEach(function(b) { b.classList.toggle('active', b.dataset.value === 'long'); });
  document.querySelectorAll('[data-field="pf-market"]').forEach(function(b) { b.classList.toggle('active', b.dataset.value === 'futures'); });

  onEntryStrategyChange();
  onSlTypeChange();

  document.getElementById('plan-form-overlay').style.display = 'flex';
}

function hidePlanForm() {
  document.getElementById('plan-form-overlay').style.display = 'none';
}

function setToggle(btn) {
  var field = btn.dataset.field;
  var value = btn.dataset.value;
  document.getElementById(field).value = value;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(function(b) {
    b.classList.remove('active');
  });
  btn.classList.add('active');
}

function onEntryStrategyChange() {
  var strategy = document.getElementById('pf-entry-strategy').value;
  document.getElementById('pf-entry-single-group').style.display = strategy === 'single' ? 'block' : 'none';
  document.getElementById('pf-entry-range-group').style.display = strategy !== 'single' ? 'block' : 'none';
}

function onSlTypeChange() {
  var type = document.getElementById('pf-sl-type').value;
  document.getElementById('pf-trailing-group').style.display = type === 'trailing' ? 'block' : 'none';
}

function addTakeProfit() {
  tpCounter++;
  var list = document.getElementById('pf-tp-list');
  document.getElementById('pf-tp-header').style.display = 'grid';
  var row = document.createElement('div');
  row.className = 'tp-row';
  row.id = 'tp-row-' + tpCounter;
  var n = tpCounter;
  row.innerHTML =
    '<input type="number" step="any" min="0" placeholder="z.B. 105000" data-tp="price" oninput="updateTpSize(' + n + ')">' +
    '<input type="number" step="1" min="1" max="100" placeholder="%" data-tp="pct" oninput="updateTpSize(' + n + ')">' +
    '<span class="tp-size" data-tp="size">&ndash;</span>' +
    '<button type="button" class="btn-sl-adj" data-tp="sladj" onclick="toggleSlAdj(' + n + ')">SL adj</button>' +
    '<button class="btn-remove" onclick="removeTpRow(' + n + ')">&times;</button>';
  list.appendChild(row);
}

function removeTpRow(id) {
  var row = document.getElementById('tp-row-' + id);
  if (row) row.remove();
  if (document.getElementById('pf-tp-list').children.length === 0) {
    document.getElementById('pf-tp-header').style.display = 'none';
  }
}

function updateTpSize(id) {
  var row = document.getElementById('tp-row-' + id);
  if (!row) return;
  var pct = parseFloat(row.querySelector('[data-tp="pct"]').value) || 0;
  var totalSize = parseFloat(document.getElementById('pf-total-size').value) || 0;
  var sizeEl = row.querySelector('[data-tp="size"]');
  if (pct > 0 && totalSize > 0) {
    sizeEl.textContent = (totalSize * pct / 100).toFixed(6).replace(/\.?0+$/, '');
  } else {
    sizeEl.innerHTML = '&ndash;';
  }
}

function toggleSlAdj(id) {
  var row = document.getElementById('tp-row-' + id);
  if (!row) return;
  var btn = row.querySelector('[data-tp="sladj"]');
  var existing = row.querySelector('.tp-sl-adjust');

  if (existing) {
    existing.remove();
    btn.classList.remove('active');
  } else {
    btn.classList.add('active');
    var adjRow = document.createElement('div');
    adjRow.className = 'tp-sl-adjust';
    adjRow.innerHTML =
      '<span>&rarr; SL auf:</span>' +
      '<input type="number" step="any" min="0" placeholder="Neues SL-Niveau" data-tp="sl_new_price">' +
      '<span class="tp-sl-unit">USDT</span>' +
      '<label class="tp-trailing-toggle">' +
        '<input type="checkbox" data-tp="activate_trailing" onchange="toggleTpTrailing(' + id + ')">' +
        '<span>Ab hier Trailing-Stop</span>' +
      '</label>';
    row.appendChild(adjRow);
  }
}

function toggleTpTrailing(id) {
  var row = document.getElementById('tp-row-' + id);
  if (!row) return;
  var cb = row.querySelector('[data-tp="activate_trailing"]');
  var existing = row.querySelector('.tp-trailing-config');

  if (cb && cb.checked) {
    if (!existing) {
      var trailRow = document.createElement('div');
      trailRow.className = 'tp-trailing-config';
      trailRow.innerHTML =
        '<span>Trailing-Abstand:</span>' +
        '<input type="number" step="0.1" min="0.1" max="50" placeholder="z.B. 2.0" data-tp="trailing_pct">' +
        '<span class="tp-sl-unit">%</span>' +
        '<input type="number" step="any" min="0" placeholder="$" data-tp="trailing_dollar" oninput="syncTrailingDollar(' + id + ')">' +
        '<span class="tp-sl-unit">$</span>';
      row.appendChild(trailRow);
      // Sync %-Feld → Dollar bei Eingabe
      var pctInput = trailRow.querySelector('[data-tp="trailing_pct"]');
      pctInput.addEventListener('input', function() { syncTrailingPct(id); });
    }
  } else if (existing) {
    existing.remove();
  }
}

function syncTrailingPct(id) {
  var row = document.getElementById('tp-row-' + id);
  if (!row) return;
  var pct = parseFloat(row.querySelector('[data-tp="trailing_pct"]').value) || 0;
  var tpPrice = parseFloat(row.querySelector('[data-tp="price"]').value) || 0;
  var dollarInput = row.querySelector('[data-tp="trailing_dollar"]');
  if (pct > 0 && tpPrice > 0 && dollarInput) {
    dollarInput.value = (tpPrice * pct / 100).toFixed(2);
  }
}

function syncTrailingDollar(id) {
  var row = document.getElementById('tp-row-' + id);
  if (!row) return;
  var dollar = parseFloat(row.querySelector('[data-tp="trailing_dollar"]').value) || 0;
  var tpPrice = parseFloat(row.querySelector('[data-tp="price"]').value) || 0;
  var pctInput = row.querySelector('[data-tp="trailing_pct"]');
  if (dollar > 0 && tpPrice > 0 && pctInput) {
    pctInput.value = (dollar / tpPrice * 100).toFixed(2);
  }
}

function addActivationCondition() {
  if (activationCounter >= 2) return;
  activationCounter++;
  var list = document.getElementById('pf-activations-list');
  var row = document.createElement('div');
  row.className = 'activation-row';
  row.id = 'act-row-' + activationCounter;
  var num = activationCounter;
  row.innerHTML = '<span>' + num + '.</span>' +
    '<input type="number" step="any" min="0" placeholder="' + (num === 1 ? 'Zuerst diesen Preis erreichen' : 'Dann diesen Preis erreichen') + '" data-act="price">' +
    '<button class="btn-remove" onclick="removeActivation(' + num + ')">&times;</button>';
  list.appendChild(row);
  if (activationCounter >= 2) document.getElementById('btn-add-activation').disabled = true;
}

function removeActivation(id) {
  var row = document.getElementById('act-row-' + id);
  if (row) row.remove();
  activationCounter--;
  // Re-number remaining
  var list = document.getElementById('pf-activations-list');
  var rows = list.querySelectorAll('.activation-row');
  activationCounter = 0;
  rows.forEach(function(r, i) {
    activationCounter = i + 1;
    r.id = 'act-row-' + activationCounter;
    r.querySelector('span').textContent = activationCounter + '.';
    r.querySelector('.btn-remove').setAttribute('onclick', 'removeActivation(' + activationCounter + ')');
  });
  document.getElementById('btn-add-activation').disabled = false;
}

function buildEntryOrders() {
  var strategy = document.getElementById('pf-entry-strategy').value;
  var totalSize = parseFloat(document.getElementById('pf-total-size').value) || 0;

  if (strategy === 'single') {
    var price = parseFloat(document.getElementById('pf-entry-price').value) || 0;
    return [{ price: price, size: totalSize, order_type: 'limit', status: 'pending' }];
  }

  var from = parseFloat(document.getElementById('pf-entry-from').value) || 0;
  var to = parseFloat(document.getElementById('pf-entry-to').value) || 0;
  var steps = parseInt(document.getElementById('pf-entry-steps').value) || 3;
  if (steps < 2) steps = 2;

  var orders = [];
  for (var i = 0; i < steps; i++) {
    var stepPrice = steps === 1 ? from : from + (to - from) * i / (steps - 1);
    var weight;
    if (strategy === 'equal') {
      weight = 1 / steps;
    } else if (strategy === 'ascending') {
      weight = 2 * (i + 1) / (steps * (steps + 1));
    } else { // descending
      weight = 2 * (steps - i) / (steps * (steps + 1));
    }
    orders.push({ price: Math.round(stepPrice * 100000000) / 100000000, size: Math.round(totalSize * weight * 100000000) / 100000000, order_type: 'limit', status: 'pending' });
  }
  return orders;
}

function collectTakeProfits() {
  var rows = document.querySelectorAll('#pf-tp-list .tp-row');
  var tps = [];
  rows.forEach(function(row) {
    var price = parseFloat(row.querySelector('[data-tp="price"]').value);
    var pct = parseFloat(row.querySelector('[data-tp="pct"]').value);
    if (price > 0 && pct > 0) {
      var tp = { price: price, size_pct: pct, order_type: 'limit', status: 'pending', sl_adjust: false, sl_new_price: null, activate_trailing: false, trailing_pct: null };
      var adjRow = row.querySelector('.tp-sl-adjust');
      if (adjRow) {
        tp.sl_adjust = true;
        var slPrice = parseFloat(adjRow.querySelector('[data-tp="sl_new_price"]').value);
        if (slPrice > 0) tp.sl_new_price = slPrice;

        var trailCb = adjRow.querySelector('[data-tp="activate_trailing"]');
        if (trailCb && trailCb.checked) {
          tp.activate_trailing = true;
          var trailConfig = row.querySelector('.tp-trailing-config');
          if (trailConfig) {
            var trailPct = parseFloat(trailConfig.querySelector('[data-tp="trailing_pct"]').value);
            if (trailPct > 0) tp.trailing_pct = trailPct;
          }
        }
      }
      tps.push(tp);
    }
  });
  return tps;
}

function collectActivations() {
  var rows = document.querySelectorAll('#pf-activations-list .activation-row');
  var conds = [];
  rows.forEach(function(row) {
    var price = parseFloat(row.querySelector('[data-act="price"]').value);
    if (price > 0) {
      conds.push({ type: 'price_above', value: price, met: false });
    }
  });
  return conds;
}

async function savePlan() {
  var symbol = document.getElementById('pf-symbol').value.trim().toUpperCase();
  var direction = document.getElementById('pf-direction').value;
  var market = document.getElementById('pf-market').value;
  var leverage = parseFloat(document.getElementById('pf-leverage').value) || 1;
  var totalSize = parseFloat(document.getElementById('pf-total-size').value);
  var slPrice = parseFloat(document.getElementById('pf-sl-price').value) || null;
  var slType = document.getElementById('pf-sl-type').value;
  var trailingPct = parseFloat(document.getElementById('pf-trailing-pct').value) || null;
  var trailingActivation = parseFloat(document.getElementById('pf-trailing-activation').value) || null;
  var notes = document.getElementById('pf-notes').value.trim() || null;

  if (!symbol) { showPlanningAlert('Symbol eingeben', 'error'); return; }
  if (!totalSize || totalSize <= 0) { showPlanningAlert('Gesamtgroesse muss > 0 sein', 'error'); return; }

  var entryOrders = buildEntryOrders();
  if (entryOrders.length === 0 || entryOrders[0].price <= 0) {
    showPlanningAlert('Entry-Preis eingeben', 'error');
    return;
  }

  var btn = document.getElementById('btn-save-plan');
  btn.disabled = true;
  btn.textContent = 'Speichern...';

  try {
    var res = await apiFetch('/local-plans', {
      method: 'POST',
      body: JSON.stringify({
        symbol: symbol,
        direction: direction,
        market_type: market,
        leverage: leverage,
        total_size: totalSize,
        entry_strategy: document.getElementById('pf-entry-strategy').value,
        entry_orders: entryOrders,
        take_profits: collectTakeProfits(),
        stop_loss_price: slPrice,
        stop_loss_type: slType,
        trailing_stop_pct: trailingPct,
        trailing_stop_activation: trailingActivation,
        activation_conditions: collectActivations(),
        notes: notes,
      }),
    });
    if (res && res.success) {
      hidePlanForm();
      showPlanningAlert('Plan gespeichert', 'success');
      updateLocalPlans();
    } else {
      showPlanningAlert(res ? res.error : 'Fehler', 'error');
    }
  } catch {
    showPlanningAlert('Netzwerkfehler', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Plan speichern';
  }
}

async function updateLocalPlans() {
  var data = await apiFetch('/local-plans');
  if (!data) return;

  var tbody = document.getElementById('local-plans-body');
  if (!tbody) return;

  var aktiv = data.plans.filter(function(p) { return !istBeendeterStatus(p.status); });
  var beendet = data.plans.filter(function(p) { return istBeendeterStatus(p.status); });

  tabelleZeichnen(tbody, aktiv.length
    ? aktiv.map(lokaleZeile).join('')
    : '<tr data-key="leer"><td colspan="10" class="empty-state">Keine aktiven lokalen Plaene</td></tr>');

  var block = document.getElementById('local-beendet-block');
  var beendetBody = document.getElementById('local-beendet-body');
  if (block && beendetBody) {
    block.style.display = beendet.length ? 'block' : 'none';
    tabelleZeichnen(beendetBody, beendet.map(lokaleZeile).join(''));
    var zahl = document.getElementById('local-beendet-zahl');
    if (zahl) zahl.textContent = String(beendet.length);
  }
}

function lokaleZeile(p) {
  var slText = p.stop_loss_price ? (p.stop_loss_type === 'trailing' ? 'TS ' + (p.trailing_stop_pct || '-') + '%' : p.stop_loss_price.toFixed(2)) : '-';
  var statusClass = p.status === 'planned' ? 'badge-yellow' : p.status === 'active' ? 'badge-green' : 'badge-default';
  return '<tr data-key="' + esc(p.id) + '">' +
    '<td><strong>' + esc(p.symbol) + '</strong></td>' +
    '<td><span class="badge ' + (p.direction === 'long' ? 'badge-green' : 'badge-red') + '">' + esc(p.direction) + '</span></td>' +
    '<td>' + esc(p.market_type) + '</td>' +
    '<td>' + p.leverage + 'x</td>' +
    '<td>' + p.total_size + '</td>' +
    '<td>' + p.entry_orders.length + '</td>' +
    '<td>' + p.take_profits.length + '</td>' +
    '<td>' + slText + '</td>' +
    '<td><span class="badge ' + statusClass + '">' + esc(p.status) + '</span></td>' +
    '<td>' +
      (p.status === 'planned' || p.status === 'active' ? '<button class="btn btn-danger" style="font-size:11px;padding:2px 8px;" onclick="cancelLocalPlan(\'' + esc(p.id) + '\')">Abbrechen</button> ' : '') +
      (p.status === 'cancelled' ? '<button class="btn" style="font-size:11px;padding:2px 8px;" onclick="deleteLocalPlan(\'' + esc(p.id) + '\')">Loeschen</button>' : '') +
    '</td>' +
    '</tr>';
}

async function cancelLocalPlan(id) {
  if (!confirm('Plan wirklich abbrechen?')) return;
  await apiFetch('/local-plans/' + id + '/status', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled' }),
  });
  updateLocalPlans();
}

async function deleteLocalPlan(id) {
  await apiFetch('/local-plans/' + id, { method: 'DELETE' });
  updateLocalPlans();
}

function showPlanningAlert(msg, type) {
  var el = document.getElementById('planning-alert');
  el.textContent = msg;
  el.className = 'settings-alert ' + type;
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 5000);
}

function clearSensitiveKey(inputId, keyName) {
  if (!confirm('Key "' + keyName + '" wirklich loeschen?')) return;
  var el = document.getElementById(inputId);
  el.value = '';
  el.dataset.delete = 'true';
  el.placeholder = 'Wird beim Speichern geloescht';
  el.style.borderColor = 'var(--red)';
  var hint = document.getElementById(inputId + '-hint');
  if (hint) hint.innerHTML = '<span style="color:var(--red);">Wird beim Speichern geloescht</span>';
}

async function toggleCtMonitoring() {
  var btn = document.getElementById('ct-start-btn');
  var statusEl = document.getElementById('ct-monitor-status');

  if (btn.textContent.indexOf('stoppen') >= 0) {
    btn.disabled = true;
    await apiFetch('/copytrading/stop', { method: 'POST' });
    btn.textContent = 'Monitoring starten';
    btn.disabled = false;
    statusEl.textContent = 'Inaktiv';
    statusEl.className = 'badge badge-default';
    return;
  }

  // Settings laden um Claude API-Key zu prüfen
  var settings = await apiFetch('/settings');
  if (!settings || !settings.claudeApiKeyConfigured) {
    alert('Bitte zuerst einen Claude API-Key in den Einstellungen eingeben!');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Starte...';

  var data = await apiFetch('/copytrading/start', {
    method: 'POST',
    body: JSON.stringify({
      claudeApiKey: '__from_keystore__',
      claudeModel: settings.ctClaudeModel || 'claude-sonnet-4-20250514',
      portfolioSize: settings.ctPortfolioSize || 1000,
      minCombinedScore: settings.ctMinCombinedScore || 60,
      minConvictionScore: settings.ctMinConvictionScore || 55,
    }),
  });

  if (data && data.success) {
    btn.textContent = 'Monitoring stoppen';
    statusEl.textContent = 'Aktiv';
    statusEl.className = 'badge badge-green';
  } else {
    btn.textContent = 'Monitoring starten';
    alert('Start fehlgeschlagen: ' + ((data && data.error) || 'Unbekannt'));
  }
  btn.disabled = false;
}

// ========== Init ==========

document.addEventListener('DOMContentLoaded', async function() {
  var stored = sessionStorage.getItem('tc-auth');
  if (stored) {
    authHeader = stored;
    try {
      var res = await fetch(API_BASE + '/dashboard', {
        headers: { 'Authorization': authHeader },
      });
      if (res.ok) {
        showApp();
        return;
      }
    } catch { /* fall through */ }
    sessionStorage.removeItem('tc-auth');
    authHeader = '';
  }
  showLogin();
});

// ========== CopyTrading ==========

async function updateCopyTrading() {
  try {
    var stats = await apiFetch('/copytrading/stats');
    if (stats) {
      setText('ct-stat-wallets', stats.total_wallets);
      setText('ct-stat-signals', stats.signals.total);
      setText('ct-stat-executed', stats.signals.executed || 0);
      setText('ct-stat-skipped', (stats.signals.skipped || 0) + (stats.signals.rejected || 0));

      // Monitor-Status aktualisieren
      var statusEl = document.getElementById('ct-monitor-status');
      var btn = document.getElementById('ct-start-btn');
      if (stats.monitor && stats.monitor.monitoring) {
        statusEl.textContent = 'Aktiv (' + stats.monitor.tracked_wallets + ' Wallets)';
        statusEl.className = 'badge badge-green';
        btn.textContent = 'Monitoring stoppen';
      } else {
        statusEl.textContent = 'Inaktiv';
        statusEl.className = 'badge badge-default';
        btn.textContent = 'Monitoring starten';
      }
    }
  } catch (e) { console.error('[CT] stats error:', e); }

  try {
    var data = await apiFetch('/copytrading/wallets');
    if (data && data.wallets) {
      renderCtWallets(data.wallets);
    }
  } catch (e) { console.error('[CT] wallets error:', e); }

  try {
    var sigData = await apiFetch('/copytrading/signals?limit=50');
    if (sigData && sigData.signals) {
      renderCtSignals(sigData.signals);
    }
  } catch (e) { console.error('[CT] signals error:', e); }

  try {
    var posData = await apiFetch('/copytrading/positions');
    if (posData) {
      renderCtPositions(posData.open, posData.closed);
    }
  } catch (e) { console.error('[CT] positions error:', e); }
}

function renderCtPositions(openPositions, closedPositions) {
  var body = document.getElementById('ct-positions-body');
  var all = (openPositions || []).concat(closedPositions || []);

  if (all.length === 0) {
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);">Keine Positionen</td></tr>';
    return;
  }

  body.innerHTML = all.map(function(p) {
    var dirClass = p.direction === 'long' ? 'color:var(--green)' : 'color:var(--red)';
    var pnlColor = p.realized_pnl > 0 ? 'color:var(--green)' : p.realized_pnl < 0 ? 'color:var(--red)' : '';
    var statusBadge = p.status === 'open'
      ? '<span class="badge badge-green">Offen</span>'
      : p.status === 'closed'
        ? '<span class="badge badge-default">Geschlossen</span>'
        : '<span class="badge badge-yellow">' + p.status + '</span>';
    var tps = (p.tp_prices || []).map(function(t) { return '$' + t; }).join(', ') || '-';
    var time = new Date(p.opened_at).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    var pnlText = p.status === 'closed'
      ? (p.realized_pnl >= 0 ? '+' : '') + p.realized_pnl.toFixed(2) + ' USDT'
      : '-';
    var exitInfo = p.exit_reason ? ' (' + p.exit_reason + ')' : '';

    return '<tr>' +
      '<td><strong>' + p.symbol + '</strong></td>' +
      '<td style="' + dirClass + '">' + p.direction.toUpperCase() + '</td>' +
      '<td>$' + p.entry_price + '</td>' +
      '<td>' + p.size.toFixed(6) + '</td>' +
      '<td>$' + p.margin_usd.toFixed(2) + '</td>' +
      '<td>$' + p.sl_price + '</td>' +
      '<td style="font-size:11px;">' + tps + '</td>' +
      '<td>' + (p.trailing_active ? '<span class="badge badge-accent">Aktiv</span>' : '-') + '</td>' +
      '<td style="' + pnlColor + '">' + pnlText + exitInfo + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td style="font-size:11px;">' + time + '</td>' +
      '</tr>';
  }).join('');
}

function renderCtWallets(wallets) {
  var body = document.getElementById('ct-wallet-body');
  if (!wallets || wallets.length === 0) {
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);">Keine Wallets getrackt</td></tr>';
    return;
  }

  body.innerHTML = wallets.map(function(w) {
    var tierBadge = getTierBadge(w.tier);
    var statusBadge = w.active ?
      '<span class="badge badge-green">Aktiv</span>' :
      '<span class="badge badge-default">Pausiert</span>';
    var sourceBadge = w.added_by === 'manual' ?
      '<span class="badge badge-blue">Manuell</span>' :
      '<span class="badge badge-default">Auto</span>';
    var streakText = w.streak > 0 ? '<span style="color:var(--green)">+' + w.streak + '</span>' :
      w.streak < 0 ? '<span style="color:var(--red)">' + w.streak + '</span>' : '0';

    return '<tr>' +
      '<td style="font-family:var(--font-mono);font-size:12px;"><a href="https://app.hyperliquid.xyz/leaderboard/' + w.address + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;" title="' + w.address + '">' + w.address.slice(0, 6) + '...' + w.address.slice(-4) + '</a></td>' +
      '<td>' + (w.label || '-') + '</td>' +
      '<td><strong>' + w.score + '</strong></td>' +
      '<td>' + tierBadge + '</td>' +
      '<td>' + (w.win_rate ? w.win_rate.toFixed(1) + '%' : '-') + '</td>' +
      '<td>' + (w.sharpe_ratio ? w.sharpe_ratio.toFixed(2) : '-') + '</td>' +
      '<td>' + (w.avg_leverage ? w.avg_leverage.toFixed(1) + 'x' : '-') + '</td>' +
      '<td>' + streakText + '</td>' +
      '<td>' + sourceBadge + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td><button class="btn-remove" onclick="deleteCtWallet(\'' + w.address + '\')">&times;</button></td>' +
      '</tr>';
  }).join('');
}

function getTierBadge(tier) {
  switch (tier) {
    case 'tier1': return '<span class="badge badge-green">Tier 1</span>';
    case 'tier2': return '<span class="badge badge-blue">Tier 2</span>';
    case 'tier3': return '<span class="badge badge-yellow">Tier 3</span>';
    case 'watchlist': return '<span class="badge badge-default">Watch</span>';
    case 'blacklist': return '<span class="badge badge-red">Blocked</span>';
    default: return '<span class="badge badge-default">' + tier + '</span>';
  }
}

function renderCtSignals(signals) {
  var body = document.getElementById('ct-signal-body');
  if (!signals || signals.length === 0) {
    body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);">Keine Signale</td></tr>';
    return;
  }

  body.innerHTML = signals.map(function(s) {
    var time = new Date(s.detected_at).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
    var dirClass = s.direction === 'long' ? 'color:var(--green)' : 'color:var(--red)';
    var statusBadge = getSignalStatusBadge(s.status);
    var conviction = '-';
    if (s.conviction_json) {
      try {
        var cv = JSON.parse(s.conviction_json);
        conviction = '<strong>' + cv.conviction_score + '</strong>/100';
      } catch { conviction = '-'; }
    }

    return '<tr>' +
      '<td style="font-size:12px;">' + time + '</td>' +
      '<td style="font-family:var(--font-mono);font-size:11px;">' + s.wallet_address.slice(0, 6) + '...</td>' +
      '<td>' + s.signal_type + '</td>' +
      '<td><strong>' + s.symbol + '</strong></td>' +
      '<td style="' + dirClass + '">' + s.direction.toUpperCase() + '</td>' +
      '<td>' + s.leverage + 'x</td>' +
      '<td>' + conviction + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td style="font-size:11px;color:var(--text-muted);">' + (s.rejection_reason || '') + '</td>' +
      '</tr>';
  }).join('');
}

function getSignalStatusBadge(status) {
  switch (status) {
    case 'executed': return '<span class="badge badge-green">Trade eroeffnet</span>';
    case 'analyzed': return '<span class="badge badge-blue">Analysiert</span>';
    case 'validated': return '<span class="badge badge-yellow">Warte auf KI</span>';
    case 'rejected': return '<span class="badge badge-default">Gefiltert</span>';
    case 'skipped': return '<span class="badge badge-yellow">KI: Skip</span>';
    case 'pending': return '<span class="badge badge-default">Empfangen</span>';
    default: return '<span class="badge badge-default">' + status + '</span>';
  }
}

function showAddWalletDialog() {
  document.getElementById('ct-add-wallet').style.display = 'block';
  document.getElementById('ct-wallet-address').focus();
}

function hideAddWalletDialog() {
  document.getElementById('ct-add-wallet').style.display = 'none';
  document.getElementById('ct-wallet-address').value = '';
  document.getElementById('ct-wallet-label').value = '';
}

async function addCtWallet() {
  var address = document.getElementById('ct-wallet-address').value.trim();
  var label = document.getElementById('ct-wallet-label').value.trim();

  if (!address || !address.startsWith('0x') || address.length !== 42) {
    alert('Bitte gueltige Ethereum-Adresse eingeben (0x...)');
    return;
  }

  try {
    var data = await apiFetch('/copytrading/wallets', {
      method: 'POST',
      body: JSON.stringify({ address: address, label: label || undefined })
    });
    if (data && data.success) {
      hideAddWalletDialog();
      updateCopyTrading();
    } else {
      alert((data && data.error) || 'Fehler beim Hinzufuegen');
    }
  } catch (err) {
    alert('Netzwerkfehler: ' + err.message);
  }
}

async function scanLeaderboard() {
  var btn = document.getElementById('ct-scan-btn');
  btn.textContent = 'Scanne...';
  btn.disabled = true;

  try {
    var data = await apiFetch('/copytrading/scan', { method: 'POST' });
    if (data && data.success) {
      btn.textContent = data.added + ' neu, ' + data.total + ' gesamt';
      updateCopyTrading();
      setTimeout(function() {
        btn.textContent = 'Leaderboard scannen';
        btn.disabled = false;
      }, 3000);
    } else if (data) {
      btn.textContent = 'Fehler: ' + (data.error || 'Unbekannt');
      setTimeout(function() {
        btn.textContent = 'Leaderboard scannen';
        btn.disabled = false;
      }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Netzwerkfehler';
    setTimeout(function() {
      btn.textContent = 'Leaderboard scannen';
      btn.disabled = false;
    }, 3000);
  }
}

async function deleteCtWallet(address) {
  if (!confirm('Wallet ' + address.slice(0, 8) + '... wirklich entfernen?')) return;

  try {
    await apiFetch('/copytrading/wallets/' + address, { method: 'DELETE' });
    updateCopyTrading();
  } catch { /* ignore */ }
}

// ============================================================
// Trade Plans (TC-Sync + lokale Plaene)
// ============================================================

async function updateTradePlans() {
  try {
    var data = await apiFetch('/trade-plans');
    var monitorsResp = await apiFetch('/trade-plans/monitors/status');
    var monitorsByPlanId = {};
    if (monitorsResp && monitorsResp.monitors) {
      monitorsResp.monitors.forEach(function(m) { monitorsByPlanId[m.planId] = m; });
    }

    if (data && data.plans) {
      renderTradePlans(data.plans, monitorsByPlanId);
      var tcCount = data.plans.filter(function(p) { return p.source === 'tc'; }).length;
      var signalCount = data.plans.filter(function(p) { return p.source === 'signal'; }).length;
      // Nicht per Umkehrschluss rechnen: Alles, was nicht 'tc' ist, war
      // frueher automatisch 'lokal' — seit es Signal-Plaene gibt, stimmt das nicht mehr.
      var localCount = data.plans.filter(function(p) { return p.source === 'local'; }).length;
      var monitoringCount = (monitorsResp && monitorsResp.monitors) ?
        monitorsResp.monitors.filter(function(m) { return m.status === 'monitoring' || m.status === 'waiting_activation'; }).length : 0;
      setText('tp-stat-total', data.plans.length);
      setText('tp-stat-tc', tcCount);
      setText('tp-stat-local', localCount);
      setText('tp-stat-signal', signalCount);
      setText('tp-stat-monitoring', monitoringCount);
    }
  } catch (e) { console.error('[TP]', e); }
}

function renderTradePlans(plans, monitors) {
  var body = document.getElementById('tp-body');
  if (!plans || plans.length === 0) {
    tabelleZeichnen(body, '<tr data-key="leer"><td colspan="11" style="text-align:center;color:var(--text-muted);">Keine Plaene vorhanden</td></tr>');
    tradePlansBeendetZeichnen([], monitors);
    return;
  }

  var aktiv = plans.filter(function(p) { return !istBeendeterStatus(p.status); });
  var beendet = plans.filter(function(p) { return istBeendeterStatus(p.status); });

  tabelleZeichnen(body, aktiv.length
    ? aktiv.map(function(p) { return tradePlanZeile(p, monitors); }).join('')
    : '<tr data-key="leer"><td colspan="11" style="text-align:center;color:var(--text-muted);">Keine aktiven Plaene</td></tr>');

  tradePlansBeendetZeichnen(beendet, monitors);
}

function tradePlansBeendetZeichnen(beendet, monitors) {
  var block = document.getElementById('tp-beendet-block');
  var body = document.getElementById('tp-beendet-body');
  if (!block || !body) return;

  block.style.display = beendet.length ? 'block' : 'none';
  tabelleZeichnen(body, beendet.map(function(p) { return tradePlanZeile(p, monitors); }).join(''));

  var zahl = document.getElementById('tp-beendet-zahl');
  if (zahl) zahl.textContent = String(beendet.length);
}

function tradePlanZeile(p, monitors) {
    var sourceBadge = quellAbzeichen(p.source);
    var klickbar = ' style="cursor:pointer" title="Einzelheiten anzeigen"'
      + ' data-plan="' + esc(p.id) + '"'
      + ' onclick="planDetailOeffnen(this.dataset.plan)"';
    var dirClass = p.direction === 'long' ? 'color:var(--green)' : 'color:var(--red)';

    var entryOrders = [];
    var entryZones = [];
    try { entryOrders = JSON.parse(p.entry_orders || '[]'); } catch (_) { /* ignore */ }
    try { entryZones = p.entry_zones ? JSON.parse(p.entry_zones) : []; } catch (_) { /* ignore */ }

    var tps = [];
    try { tps = JSON.parse(p.take_profits || '[]'); } catch (_) { /* ignore */ }

    var activations = [];
    try { activations = JSON.parse(p.activation_conditions || '[]'); } catch (_) { /* ignore */ }

    // Trigger-Detection
    var hasTrigger = entryOrders.some(function(o) { return o.trigger; }) ||
                     entryZones.some(function(z) { return z.trigger; });
    var triggerBadge = hasTrigger
      ? '<span class="badge badge-yellow" title="Indicator-Trigger aktiv">📊 Trigger</span>'
      : '<span style="color:var(--text-muted)">-</span>';

    var statusBadge = getPlanStatusBadge(p.status);

    var monitor = monitors[p.id];
    var monitorInfo = '-';
    if (monitor) {
      var actStr = monitor.activationTotal > 0
        ? ' ' + monitor.activationStep + '/' + monitor.activationTotal
        : '';
      var monitorClass = monitor.status === 'monitoring' ? 'badge-green'
        : monitor.status === 'waiting_activation' ? 'badge-yellow'
        : 'badge-default';
      monitorInfo = '<span class="badge ' + monitorClass + '">' + monitor.status + actStr + '</span>';
      if (monitor.tpsTotal > 0) {
        monitorInfo += ' <span style="color:var(--text-muted);font-size:11px;">TP ' + monitor.tpsTriggered + '/' + monitor.tpsTotal + '</span>';
      }
    }

    var sl = p.stop_loss_price ? ('$' + p.stop_loss_price) : '-';
    if (p.stop_loss_type === 'trailing') sl += ' (T)';

    return '<tr data-key="' + esc(p.id) + '"' + klickbar + '>' +
      '<td>' + sourceBadge + '</td>' +
      '<td><strong>' + p.symbol + '</strong></td>' +
      '<td style="' + dirClass + '">' + p.direction.toUpperCase() + '</td>' +
      '<td>' + p.entry_strategy + (entryZones.length > 0 ? ' (' + entryZones.length + 'z)' : '') + '</td>' +
      '<td>' + entryOrders.length + '</td>' +
      '<td>' + tps.length + '</td>' +
      '<td>' + sl + '</td>' +
      '<td>' + activations.length + '</td>' +
      '<td>' + triggerBadge + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' + monitorInfo + '</td>' +
      '</tr>';
}

function getPlanStatusBadge(status) {
  switch (status) {
    case 'planned': return '<span class="badge badge-default">Geplant</span>';
    case 'active': return '<span class="badge badge-yellow">Aktiv</span>';
    case 'monitoring': return '<span class="badge badge-blue">Monitoring</span>';
    case 'executing': return '<span class="badge badge-green">Executing</span>';
    case 'completed': return '<span class="badge badge-default">Abgeschlossen</span>';
    case 'cancelled': return '<span class="badge badge-default">Gecancelt</span>';
    case 'error': return '<span class="badge badge-red">Fehler</span>';
    default: return '<span class="badge badge-default">' + status + '</span>';
  }
}

async function syncTradePlans() {
  try {
    var data = await apiFetch('/trade-plans/sync', { method: 'POST' });
    if (data && data.success) {
      alert('Sync erfolgreich: ' + (data.added || 0) + ' neu, ' + (data.updated || 0) + ' aktualisiert, ' + (data.removed || 0) + ' entfernt');
      updateTradePlans();
    } else {
      alert('Sync fehlgeschlagen: ' + ((data && data.error) || 'Unbekannt'));
    }
  } catch (e) {
    alert('Netzwerkfehler: ' + e.message);
  }
}
