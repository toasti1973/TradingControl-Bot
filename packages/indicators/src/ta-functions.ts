// ============================================================
// Technische Indikatoren — kompatibel zu TC INDICATORS_CATALOG
// Alle Funktionen liefern arrays gleicher Laenge wie input (NaN bis genug Daten).
// ============================================================

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================
// SMA / EMA
// ============================================================
export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = emaVal;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i]! * k + emaVal * (1 - k);
    out[i] = emaVal;
  }
  return out;
}

// ============================================================
// RSI (Wilder)
// ============================================================
export function rsi(values: number[], period: number = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ============================================================
// MACD (12, 26, 9)
// ============================================================
export interface MACDResult {
  macd: number[];        // EMA(fast) - EMA(slow)
  signal: number[];      // EMA des MACD
  histogram: number[];   // MACD - Signal
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MACDResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    Number.isFinite(emaFast[i]!) && Number.isFinite(emaSlow[i]!) ? emaFast[i]! - emaSlow[i]! : NaN
  );
  // Signal = EMA von MACD-Line (nur ueber gueltige Werte)
  const validStart = macdLine.findIndex(v => Number.isFinite(v));
  const validValues = validStart >= 0 ? macdLine.slice(validStart) : [];
  const signalRaw = ema(validValues, signalPeriod);
  const signalLine: number[] = new Array(values.length).fill(NaN);
  if (validStart >= 0) {
    for (let i = 0; i < signalRaw.length; i++) {
      signalLine[validStart + i] = signalRaw[i]!;
    }
  }
  const histogram = macdLine.map((m, i) =>
    Number.isFinite(m) && Number.isFinite(signalLine[i]!) ? m - signalLine[i]! : NaN
  );
  return { macd: macdLine, signal: signalLine, histogram };
}

// ============================================================
// Bollinger Bands
// ============================================================
export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];   // (upper - lower) / middle
}

export function bollinger(values: number[], period: number = 20, stdDev: number = 2): BollingerResult {
  const middle = sma(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);
  const bandwidth: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = middle[i]!;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
    bandwidth[i] = mean !== 0 ? (upper[i]! - lower[i]!) / mean : NaN;
  }
  return { upper, middle, lower, bandwidth };
}

// ============================================================
// Stochastic Oscillator (%K, %D)
// ============================================================
export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3, smooth = 3): StochasticResult {
  const len = closes.length;
  const rawK: number[] = new Array(len).fill(NaN);
  for (let i = kPeriod - 1; i < len; i++) {
    let high = -Infinity, low = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j]! > high) high = highs[j]!;
      if (lows[j]! < low) low = lows[j]!;
    }
    const range = high - low;
    rawK[i] = range > 0 ? ((closes[i]! - low) / range) * 100 : 50;
  }
  const k = sma(rawK.map(v => Number.isFinite(v) ? v : 0), smooth).map((v, i) =>
    Number.isFinite(rawK[i]!) ? v : NaN
  );
  const d = sma(k.map(v => Number.isFinite(v) ? v : 0), dPeriod).map((v, i) =>
    Number.isFinite(k[i]!) ? v : NaN
  );
  return { k, d };
}

// ============================================================
// ATR (Average True Range, Wilder)
// ============================================================
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const len = closes.length;
  const tr: number[] = new Array(len).fill(NaN);
  for (let i = 1; i < len; i++) {
    tr[i] = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!)
    );
  }
  const out: number[] = new Array(len).fill(NaN);
  if (len < period + 1) return out;
  // Erste ATR = SMA(TR, period)
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  out[period] = sum / period;
  // Wilder Smoothing
  for (let i = period + 1; i < len; i++) {
    out[i] = (out[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return out;
}

// ============================================================
// ADX (Average Directional Index)
// ============================================================
export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export function adx(highs: number[], lows: number[], closes: number[], period = 14): ADXResult {
  const len = closes.length;
  const plusDM: number[] = new Array(len).fill(0);
  const minusDM: number[] = new Array(len).fill(0);
  const tr: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove = highs[i]! - highs[i - 1]!;
    const downMove = lows[i - 1]! - lows[i]!;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!)
    );
  }

  // Wilder smoothing
  const smoothedTr: number[] = new Array(len).fill(NaN);
  const smoothedPlusDM: number[] = new Array(len).fill(NaN);
  const smoothedMinusDM: number[] = new Array(len).fill(NaN);

  if (len > period) {
    let sumTr = 0, sumP = 0, sumM = 0;
    for (let i = 1; i <= period; i++) { sumTr += tr[i]!; sumP += plusDM[i]!; sumM += minusDM[i]!; }
    smoothedTr[period] = sumTr;
    smoothedPlusDM[period] = sumP;
    smoothedMinusDM[period] = sumM;
    for (let i = period + 1; i < len; i++) {
      smoothedTr[i] = smoothedTr[i - 1]! - smoothedTr[i - 1]! / period + tr[i]!;
      smoothedPlusDM[i] = smoothedPlusDM[i - 1]! - smoothedPlusDM[i - 1]! / period + plusDM[i]!;
      smoothedMinusDM[i] = smoothedMinusDM[i - 1]! - smoothedMinusDM[i - 1]! / period + minusDM[i]!;
    }
  }

  const plusDI: number[] = smoothedPlusDM.map((v, i) =>
    Number.isFinite(v) && smoothedTr[i]! > 0 ? (v / smoothedTr[i]!) * 100 : NaN
  );
  const minusDI: number[] = smoothedMinusDM.map((v, i) =>
    Number.isFinite(v) && smoothedTr[i]! > 0 ? (v / smoothedTr[i]!) * 100 : NaN
  );
  const dx: number[] = plusDI.map((p, i) => {
    const m = minusDI[i]!;
    if (!Number.isFinite(p) || !Number.isFinite(m) || p + m === 0) return NaN;
    return (Math.abs(p - m) / (p + m)) * 100;
  });

  // ADX = SMA(DX, period)
  const adxOut: number[] = new Array(len).fill(NaN);
  if (len >= period * 2) {
    let sum = 0, count = 0;
    for (let i = period; i < period * 2 && i < len; i++) {
      if (Number.isFinite(dx[i]!)) { sum += dx[i]!; count++; }
    }
    if (count > 0) adxOut[period * 2 - 1] = sum / count;
    for (let i = period * 2; i < len; i++) {
      if (Number.isFinite(adxOut[i - 1]!) && Number.isFinite(dx[i]!)) {
        adxOut[i] = (adxOut[i - 1]! * (period - 1) + dx[i]!) / period;
      }
    }
  }
  return { adx: adxOut, plusDI, minusDI };
}

// ============================================================
// WaveTrend (LazyBear)
// ============================================================
export interface WaveTrendResult {
  wt1: number[];
  wt2: number[];
}

export function wavetrend(highs: number[], lows: number[], closes: number[], n1 = 10, n2 = 21): WaveTrendResult {
  const ap = closes.map((c, i) => (highs[i]! + lows[i]! + c) / 3); // HLC3
  const esa = ema(ap, n1);
  const dArr = ap.map((v, i) => Math.abs(v - esa[i]!));
  const dEma = ema(dArr, n1);
  const ci = ap.map((v, i) => {
    const d = dEma[i]!;
    return d > 0 ? (v - esa[i]!) / (0.015 * d) : 0;
  });
  const wt1 = ema(ci, n2);
  const wt2 = sma(wt1.map(v => Number.isFinite(v) ? v : 0), 4).map((v, i) => Number.isFinite(wt1[i]!) ? v : NaN);
  return { wt1, wt2 };
}

// ============================================================
// Hilfsfunktionen
// ============================================================

export function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

export function isCrossAbove(values: number[], threshold: number, lookback = 1): boolean {
  if (values.length < 2 + (lookback - 1)) return false;
  const last = values[values.length - 1];
  // Crosses above wenn jetzt > threshold und vorher mindestens einmal <= threshold
  if (last === undefined || !Number.isFinite(last) || last <= threshold) return false;
  for (let i = 1; i <= lookback; i++) {
    const prev = values[values.length - 1 - i];
    if (prev === undefined || !Number.isFinite(prev)) continue;
    if (prev <= threshold) return true;
  }
  return false;
}

export function isCrossBelow(values: number[], threshold: number, lookback = 1): boolean {
  if (values.length < 2 + (lookback - 1)) return false;
  const last = values[values.length - 1];
  if (last === undefined || !Number.isFinite(last) || last >= threshold) return false;
  for (let i = 1; i <= lookback; i++) {
    const prev = values[values.length - 1 - i];
    if (prev === undefined || !Number.isFinite(prev)) continue;
    if (prev >= threshold) return true;
  }
  return false;
}

export function isCrossOver(seriesA: number[], seriesB: number[], lookback = 1): boolean {
  if (seriesA.length < 2 || seriesB.length < 2) return false;
  const aLast = seriesA[seriesA.length - 1];
  const bLast = seriesB[seriesB.length - 1];
  if (aLast === undefined || bLast === undefined) return false;
  if (!Number.isFinite(aLast) || !Number.isFinite(bLast) || aLast <= bLast) return false;
  for (let i = 1; i <= lookback; i++) {
    const aPrev = seriesA[seriesA.length - 1 - i];
    const bPrev = seriesB[seriesB.length - 1 - i];
    if (aPrev === undefined || bPrev === undefined) continue;
    if (Number.isFinite(aPrev) && Number.isFinite(bPrev) && aPrev <= bPrev) return true;
  }
  return false;
}

export function isCrossUnder(seriesA: number[], seriesB: number[], lookback = 1): boolean {
  if (seriesA.length < 2 || seriesB.length < 2) return false;
  const aLast = seriesA[seriesA.length - 1];
  const bLast = seriesB[seriesB.length - 1];
  if (aLast === undefined || bLast === undefined) return false;
  if (!Number.isFinite(aLast) || !Number.isFinite(bLast) || aLast >= bLast) return false;
  for (let i = 1; i <= lookback; i++) {
    const aPrev = seriesA[seriesA.length - 1 - i];
    const bPrev = seriesB[seriesB.length - 1 - i];
    if (aPrev === undefined || bPrev === undefined) continue;
    if (Number.isFinite(aPrev) && Number.isFinite(bPrev) && aPrev >= bPrev) return true;
  }
  return false;
}
