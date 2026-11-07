// ============================================================
// Handelsplätze — Börsen und Signalquellen
//
// Zwei Fragen, die beim Einrichten zusammengehören:
//
//   1. Übt diese Börse — oder geht ein Auftrag wirklich hinaus?
//   2. Welche Signalquelle landet auf welcher Börse?
//
// Die erste ist die gewichtigere. Seit jede Börse für sich
// entscheidet, gibt es keinen einzelnen Schalter mehr, der alles
// stilllegt. Deshalb ist echter Handel hier auffällig gekennzeichnet
// und verlangt eine Rückfrage — ein stiller Wechsel wäre keiner, den
// jemand bemerkt.
//
// Eigener Namensraum: Die Funktionen heißen durchweg `hp…`. Am
// 27.10.2026 kollidierte `kachel()` aus zwei Dateien, und die
// Oberfläche zeigte HTML als Text an (siehe namensraum.test.ts).
// ============================================================

/** Maskiert, was aus dem Netz kommt, bevor es in die Seite geht. */
function hpEsc(wert) {
  return String(wert ?? '').replace(/[&<>"']/g, z => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[z]));
}

async function hpLaden() {
  await Promise.all([hpBoersenLaden(), hpQuellenLaden()]);
}

// ============================================================
// Börsen
// ============================================================

async function hpBoersenLaden() {
  const ziel = document.getElementById('hp-boersen');
  if (!ziel) return;

  // apiFetch setzt den Anmeldeheader — siehe uebersicht.js.
  const daten = await apiFetch('/handelsplaetze/boersen');
  if (!daten) {
    ziel.innerHTML = '<p class="form-hint">Börsen nicht abrufbar.</p>';
    return;
  }

  const zeilen = (daten.boersen || []).map(b => {
    const echt = !b.uebungsbetrieb;

    // Der Zustand steht vorn und farbig. Wer die Seite überfliegt,
    // soll sehen, wo echtes Geld bewegt wird.
    const marke = echt
      ? '<span style="color:var(--danger,#e05260);font-weight:600">● echter Handel</span>'
      : '<span style="color:var(--text-muted,#888)">○ Übung</span>';

    const hinweise = [];
    if (!b.eingerichtet) hinweise.push('nicht eingerichtet');
    if (b.in_benutzung) hinweise.push('Pläne vorhanden');
    if (!b.zugangsdaten_hinterlegt && b.exchange !== 'paper') hinweise.push('keine Zugangsdaten');

    // 'paper' lässt sich nicht umstellen — die Schaltfläche entfällt.
    const schalter = b.exchange === 'paper'
      ? '<span class="form-hint">immer Übung</span>'
      : '<button class="btn btn-secondary" style="font-size:12px"' +
        ' onclick="hpBoerseUmstellen(\'' + hpEsc(b.exchange) + '\', ' + (echt ? 'true' : 'false') + ')">' +
        (echt ? 'auf Übung' : 'echt handeln') + '</button>';

    return '<tr>' +
      '<td style="padding:6px 10px"><code>' + hpEsc(b.exchange) + '</code></td>' +
      '<td style="padding:6px 10px">' + marke + '</td>' +
      '<td style="padding:6px 10px;color:var(--text-muted,#888);font-size:12px">' +
        hpEsc(hinweise.join(' · ') || '–') + '</td>' +
      '<td style="padding:6px 10px;text-align:right">' + schalter + '</td>' +
    '</tr>';
  }).join('');

  ziel.innerHTML = zeilen
    ? '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr style="color:var(--text-muted,#888);text-align:left">' +
      '<th style="padding:6px 10px">Börse</th><th style="padding:6px 10px">Zustand</th>' +
      '<th style="padding:6px 10px">Hinweis</th><th></th></tr></thead>' +
      '<tbody>' + zeilen + '</tbody></table>'
    : '<p class="form-hint">Keine Börsen bekannt.</p>';
}

async function hpBoerseUmstellen(exchange, istEcht) {
  const aufUebung = istEcht;

  // Der Weg zu echtem Handel verlangt eine ausdrückliche Zusage. Der
  // Weg zurück zur Übung nicht — er verkleinert das Risiko.
  if (!aufUebung) {
    const sicher = confirm(
      'Ab jetzt gehen Aufträge auf ' + exchange + ' WIRKLICH an die Börse.\n\n' +
      'Pläne auf dieser Börse bewegen dann echtes Geld. Fortfahren?',
    );
    if (!sicher) return;
  }

  const ergebnis = await apiFetch(
    '/handelsplaetze/boersen/' + encodeURIComponent(exchange),
    {
      method: 'PUT',
      body: JSON.stringify({ uebungsbetrieb: aufUebung, bestaetigung: !aufUebung }),
    },
  );

  if (ergebnis && ergebnis.error) {
    alert('Nicht übernommen: ' + ergebnis.error +
          (ergebnis.hinweis ? '\n\n' + ergebnis.hinweis : ''));
  }
  await hpBoersenLaden();
}

// ============================================================
// Signalquellen
// ============================================================

async function hpQuellenLaden() {
  const ziel = document.getElementById('hp-quellen');
  if (!ziel) return;

  const daten = await apiFetch('/handelsplaetze/quellen');
  if (!daten) {
    ziel.innerHTML = '<p class="form-hint">Quellen nicht abrufbar.</p>';
    return;
  }

  const ARTEN = { strategie: 'Strategiename', pfad: 'Webhook-Pfad', quelle: 'Herkunft' };

  const zeilen = (daten.quellen || []).map(q => {
    const aus = q.aktiv === 0;
    return '<tr' + (aus ? ' style="opacity:.45"' : '') + '>' +
      '<td style="padding:6px 10px">' + hpEsc(q.rang) + '</td>' +
      '<td style="padding:6px 10px">' + hpEsc(q.name) + '</td>' +
      '<td style="padding:6px 10px;color:var(--text-muted,#888);font-size:12px">' +
        hpEsc(ARTEN[q.art] || q.art) + '</td>' +
      '<td style="padding:6px 10px"><code>' + hpEsc(q.erkennung) + '</code></td>' +
      '<td style="padding:6px 10px">→ <code>' + hpEsc(q.exchange) + '</code></td>' +
      '<td style="padding:6px 10px;text-align:right">' +
        '<button class="btn btn-secondary" style="font-size:12px"' +
        ' onclick="hpQuelleLoeschen(\'' + hpEsc(q.id) + '\')">Entfernen</button></td>' +
    '</tr>';
  }).join('');

  ziel.innerHTML =
    (zeilen
      ? '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="color:var(--text-muted,#888);text-align:left">' +
        '<th style="padding:6px 10px">Rang</th><th style="padding:6px 10px">Name</th>' +
        '<th style="padding:6px 10px">Vergleich mit</th><th style="padding:6px 10px">Muster</th>' +
        '<th style="padding:6px 10px">Börse</th><th></th></tr></thead>' +
        '<tbody>' + zeilen + '</tbody></table>'
      : '<p class="form-hint">Noch keine Zuordnung &mdash; es gilt die Börse aus dem Signal, ' +
        'sonst die Vorgabe.</p>') +
    hpQuelleFormular();
}

function hpQuelleFormular() {
  return '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">' +
    '<input type="text" id="hp-q-name" placeholder="Name, z. B. Synaptrix"' +
    ' style="flex:1;min-width:140px;padding:6px 10px;font-size:13px">' +
    '<select id="hp-q-art" style="padding:6px 10px;font-size:13px">' +
      '<option value="strategie">Strategiename</option>' +
      '<option value="pfad">Webhook-Pfad</option>' +
      '<option value="quelle">Herkunft (tc/local)</option>' +
    '</select>' +
    '<input type="text" id="hp-q-muster" placeholder="Muster, z. B. MBCMA*"' +
    ' style="flex:1;min-width:140px;padding:6px 10px;font-size:13px">' +
    '<input type="text" id="hp-q-boerse" placeholder="Börse, z. B. phemex"' +
    ' style="min-width:120px;padding:6px 10px;font-size:13px">' +
    '<input type="number" id="hp-q-rang" value="100" title="Rang — kleiner gewinnt"' +
    ' style="width:72px;padding:6px 10px;font-size:13px">' +
    '<button class="btn btn-secondary" style="font-size:12px" onclick="hpQuelleAnlegen()">' +
    'Hinzufügen</button></div>';
}

async function hpQuelleAnlegen() {
  const wert = id => (document.getElementById(id)?.value ?? '').trim();
  const muster = wert('hp-q-muster');
  const boerse = wert('hp-q-boerse');

  if (!muster || !boerse) {
    alert('Muster und Börse sind nötig.');
    return;
  }

  const ergebnis = await apiFetch('/handelsplaetze/quellen/neu-' + Date.now(), {
    method: 'PUT',
    body: JSON.stringify({
      name: wert('hp-q-name') || muster,
      art: document.getElementById('hp-q-art')?.value || 'strategie',
      erkennung: muster,
      exchange: boerse,
      rang: Number(wert('hp-q-rang')) || 100,
    }),
  });

  if (ergebnis && ergebnis.error) alert('Nicht angelegt: ' + ergebnis.error);
  await hpQuellenLaden();
}

async function hpQuelleLoeschen(id) {
  await apiFetch('/handelsplaetze/quellen/' + encodeURIComponent(id), { method: 'DELETE' });
  await hpQuellenLaden();
}

/**
 * Probelauf — wo landet ein Signal mit diesem Strategienamen?
 *
 * Eine Zuordnung, die man erst am gehandelten Plan bemerkt, ist eine
 * schlechte Zuordnung.
 */
async function hpProbe() {
  const ziel = document.getElementById('hp-probe-ergebnis');
  const wert = (document.getElementById('hp-probe-wert')?.value ?? '').trim();
  if (!ziel) return;

  if (!wert) {
    ziel.textContent = 'Bitte einen Strategienamen eingeben.';
    return;
  }

  try {
    const e = await apiFetch('/handelsplaetze/probe', {
      method: 'POST',
      body: JSON.stringify({ strategie: wert }),
    });
    if (!e) { ziel.textContent = 'Probelauf nicht möglich.'; return; }

    if (!e.treffer) {
      ziel.innerHTML = '<span style="color:var(--text-muted,#888)">' + hpEsc(e.hinweis) + '</span>';
      return;
    }

    ziel.innerHTML = 'Regel <strong>' + hpEsc(e.treffer.quelle) + '</strong> → Börse <code>' +
      hpEsc(e.boerse) + '</code> · ' +
      (e.uebt
        ? '<span style="color:var(--text-muted,#888)">Übung</span>'
        : '<span style="color:var(--danger,#e05260);font-weight:600">echter Handel</span>');
  } catch (err) {
    ziel.textContent = 'Probelauf fehlgeschlagen: ' + err.message;
  }
}
