// ============================================================
// ConvictionEngine — Claude AI analysiert Signale gegen Marktkontext
//
// Strategie:
//   analyze()      → Messages API (Echtzeit, fuer Trading-Signale)
//   analyzeBatch() → Batch API (50% guenstiger, fuer taegliches Wallet-Scoring)
// ============================================================

import type {
  ConvictionInput,
  ConvictionResult,
  CopyTradingConfig,
  ConfidenceLevel,
  MarketRegime,
} from '../types/index.js';

interface BatchResponse {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'ended' | 'canceling' | 'canceled' | 'expired';
  results_url: string | null;
}

interface BatchResultEntry {
  custom_id: string;
  result: {
    type: 'succeeded' | 'errored' | 'expired' | 'canceled';
    message?: {
      content: Array<{ type: string; text: string }>;
    };
    error?: { message: string };
  };
}

export class ConvictionEngine {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiBase = 'https://api.anthropic.com/v1';

  // Rate-Limiting: max 5 gleichzeitige Requests
  private activeRequests = 0;
  private readonly maxConcurrent = 5;
  private requestQueue: Array<() => void> = [];

  constructor(config: CopyTradingConfig) {
    this.apiKey = config.claude_api_key;
    this.model = config.claude_model;
  }

  // ============================================================
  // Echtzeit-Analyse (Messages API) — fuer Trading-Signale
  // ============================================================

  async analyze(input: ConvictionInput): Promise<ConvictionResult> {
    if (!this.apiKey) {
      return this.fallbackResult('Kein Claude API-Key konfiguriert');
    }

    // Rate-Limiting
    if (this.activeRequests >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.requestQueue.push(resolve));
    }

    this.activeRequests++;
    try {
      const prompt = this.buildPrompt(input);
      const res = await fetch(`${this.apiBase}/messages`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Rate-Limit? Warten und Retry
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') ?? '5');
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return this.analyze(input); // Retry
        }
        throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json() as { content: Array<{ type: string; text: string }> };
      const text = data.content.find(c => c.type === 'text')?.text ?? '';
      return this.parseResponse(text);
    } catch (err) {
      return this.fallbackResult(err instanceof Error ? err.message : 'Claude API error');
    } finally {
      this.activeRequests--;
      const next = this.requestQueue.shift();
      if (next) next();
    }
  }

  // ============================================================
  // Batch-Analyse (Batch API, 50% guenstiger) — fuer Bulk-Scoring
  // ============================================================

  async analyzeBatch(inputs: ConvictionInput[]): Promise<Map<string, ConvictionResult>> {
    const results = new Map<string, ConvictionResult>();

    if (!this.apiKey || inputs.length === 0) return results;

    try {
      // Batch erstellen
      const requests = inputs.map(input => ({
        custom_id: input.signal.id,
        params: {
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: 'user' as const, content: this.buildPrompt(input) }],
        },
      }));

      const createRes = await fetch(`${this.apiBase}/messages/batches`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!createRes.ok) {
        throw new Error(`Batch erstellen fehlgeschlagen (${createRes.status})`);
      }

      const batch = await createRes.json() as BatchResponse;

      // Polling (max 10 Min)
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10_000)); // 10s zwischen Polls

        const statusRes = await fetch(`${this.apiBase}/messages/batches/${batch.id}`, {
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(10_000),
        });

        if (!statusRes.ok) continue;
        const status = await statusRes.json() as BatchResponse;

        if (status.processing_status === 'ended' && status.results_url) {
          const resultsRes = await fetch(status.results_url, {
            headers: this.getHeaders(),
            signal: AbortSignal.timeout(30_000),
          });

          if (resultsRes.ok) {
            const text = await resultsRes.text();
            const entries = text.trim().split('\n')
              .filter(line => line.length > 0)
              .map(line => JSON.parse(line) as BatchResultEntry);

            for (const entry of entries) {
              if (entry.result.type === 'succeeded' && entry.result.message) {
                const respText = entry.result.message.content.find(c => c.type === 'text')?.text ?? '';
                try {
                  results.set(entry.custom_id, this.parseResponse(respText));
                } catch {
                  results.set(entry.custom_id, this.fallbackResult('Parse-Fehler'));
                }
              } else {
                results.set(entry.custom_id, this.fallbackResult(entry.result.error?.message ?? entry.result.type));
              }
            }
          }
          break;
        }

        if (status.processing_status === 'canceled' || status.processing_status === 'expired') {
          break;
        }
      }
    } catch (err) {
      // Alle mit Fehler
      for (const input of inputs) {
        results.set(input.signal.id, this.fallbackResult(err instanceof Error ? err.message : 'Batch-Fehler'));
      }
    }

    return results;
  }

  // ============================================================
  // Prompt
  // ============================================================

  buildPrompt(input: ConvictionInput): string {
    const { signal, wallet, market_data, sentiment, open_positions } = input;

    return `Du bist eine Trading-Conviction-Engine. Analysiere das folgende Wallet-Signal gegen den aktuellen Marktkontext und gib eine strukturierte Bewertung zurueck.

## Wallet-Signal
- Wallet-Score: ${wallet.score}/100 (Tier: ${wallet.tier})
- Sharpe Ratio: ${wallet.sharpe_ratio}
- Win Rate: ${wallet.win_rate}%
- Avg Leverage: ${wallet.avg_leverage}x
- Signal: ${signal.signal_type.toUpperCase()} ${signal.direction.toUpperCase()} ${signal.symbol}
- Entry-Preis: $${signal.entry_price}
- Positionsgroesse: ${signal.size} (Leverage: ${signal.leverage}x)
- Wallet-Streak: ${wallet.streak} (positiv=Gewinne, negativ=Verluste)

## Marktdaten (${signal.symbol})
- Aktueller Preis: $${market_data.price}
- RSI(14): ${market_data.rsi_14}
- EMA(200): $${market_data.ema_200}
- MACD: ${market_data.macd.value} (Signal: ${market_data.macd.signal}, Hist: ${market_data.macd.histogram})
- ATR(14): ${market_data.atr_14}
- Bollinger: Upper $${market_data.bollinger.upper} / Lower $${market_data.bollinger.lower}
- 24h Volumen: $${market_data.volume_24h}
- 24h Preisaenderung: ${market_data.price_change_24h_pct}%

## Sentiment
- Fear & Greed Index: ${sentiment.fear_greed_index}/100 (${sentiment.fear_greed_label})
- BTC Funding Rate: ${sentiment.btc_funding_rate}%
- ETH Funding Rate: ${sentiment.eth_funding_rate}%
- Open Interest 24h Aenderung: ${sentiment.total_oi_change_24h_pct}%
- BTC Dominance: ${sentiment.btc_dominance}%

## Offene Positionen (Portfolio)
${open_positions.length === 0 ? 'Keine offenen Positionen.' : open_positions.map(p =>
  `- ${p.symbol} ${p.direction} | $${p.size_usd} | PnL: ${p.pnl_pct}% | BTC-Korrelation: ${p.correlation_to_btc}`
).join('\n')}

## Portfolio
- Startkapital: Wir handeln mit begrenztem Kapital
- High-Leverage-Signal: ${signal.leverage > 20 ? 'JA — vorsichtig behandeln, Positionsgroesse reduzieren' : 'Nein'}

## Aufgabe
Bewerte dieses Signal und antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text drumherum):

{
  "conviction_score": <0-100>,
  "direction": "<long|short>",
  "confidence": "<very_high|high|medium|low|very_low>",
  "regime": "<bull_strong|bull_early|sideways|bear_early|bear_strong>",
  "signal_quality": "<strong|medium|weak|contradictory>",
  "reasoning": "<2-3 Saetze Begruendung>",
  "recommended_size_pct": <0.5-3.0>,
  "recommended_leverage": <1-5>,
  "stop_loss_pct": <ATR-basiert in %>,
  "take_profit_levels": [<Preis1>, <Preis2>],
  "execute": <true|false>,
  "flags": ["<warnung1>", "<warnung2>"]
}`;
  }

  // ============================================================
  // Response-Parsing + Helpers
  // ============================================================

  parseResponse(raw: string): ConvictionResult {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Kein JSON in Claude-Response gefunden');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      conviction_score: this.clamp(Number(parsed.conviction_score) || 0, 0, 100),
      direction: parsed.direction === 'short' ? 'short' : 'long',
      confidence: this.validConfidence(String(parsed.confidence)),
      regime: this.validRegime(String(parsed.regime)),
      signal_quality: this.validSignalQuality(String(parsed.signal_quality)),
      reasoning: String(parsed.reasoning ?? ''),
      recommended_size_pct: this.clamp(Number(parsed.recommended_size_pct) || 1, 0.5, 3),
      recommended_leverage: this.clamp(Number(parsed.recommended_leverage) || 1, 1, 5),
      stop_loss_pct: this.clamp(Number(parsed.stop_loss_pct) || 3, 0.5, 20),
      take_profit_levels: Array.isArray(parsed.take_profit_levels)
        ? (parsed.take_profit_levels as number[]).map(Number).filter(n => n > 0)
        : [],
      execute: parsed.execute === true,
      flags: Array.isArray(parsed.flags) ? (parsed.flags as string[]).map(String) : [],
    };
  }

  private fallbackResult(error: string): ConvictionResult {
    return {
      conviction_score: 0,
      direction: 'long',
      confidence: 'very_low',
      regime: 'sideways',
      signal_quality: 'weak',
      reasoning: `Conviction-Analyse fehlgeschlagen: ${error}`,
      recommended_size_pct: 0,
      recommended_leverage: 1,
      stop_loss_pct: 5,
      take_profit_levels: [],
      execute: false,
      flags: ['analysis_failed'],
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  private clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
  }

  private validConfidence(s: string): ConfidenceLevel {
    const valid: ConfidenceLevel[] = ['very_high', 'high', 'medium', 'low', 'very_low'];
    return valid.includes(s as ConfidenceLevel) ? s as ConfidenceLevel : 'low';
  }

  private validRegime(s: string): MarketRegime {
    const valid: MarketRegime[] = ['bull_strong', 'bull_early', 'sideways', 'bear_early', 'bear_strong'];
    return valid.includes(s as MarketRegime) ? s as MarketRegime : 'sideways';
  }

  private validSignalQuality(s: string): 'strong' | 'medium' | 'weak' | 'contradictory' {
    const valid = ['strong', 'medium', 'weak', 'contradictory'] as const;
    return valid.includes(s as typeof valid[number]) ? s as typeof valid[number] : 'weak';
  }

  async shutdown(): Promise<void> {
    // Nichts zu tun — keine Batch-Queue mehr
  }
}
