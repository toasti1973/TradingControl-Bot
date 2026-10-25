// ============================================================
// TcApiClient — ausschliesslich LESENDER Zugang zu TradingControl
//
// Der Bot meldet nichts an das Journal zurueck. Was tatsaechlich an der
// Boerse geschah, holt sich das Journal selbst ueber seinen API-Import
// direkt bei der Boerse — das ist die einzige Quelle, die auch das
// erfasst, was ausserhalb des Bots passiert ist (Teilfuellungen,
// Gebuehren, manuelle Eingriffe, Liquidationen).
//
// Diese Klasse bietet deshalb bewusst KEINE schreibenden Methoden. Wer
// eine ergaenzt, baut einen Rueckkanal, den es nicht geben soll.
// ============================================================

import { TcPlan } from '../types/plan.js';

export interface TcApiClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
}

interface HeartbeatResponse {
  status: string;
  server_time: string;
  api_version: string;
}

interface PlansResponse {
  status: string;
  plans: TcPlan[];
}

// Indicators-Catalog (TC Migration 077)
export interface IndicatorParam {
  name: string;
  type: 'integer' | 'number';
  default: number;
  min: number;
  max: number;
}

export interface IndicatorOperatorDef {
  name: string;
  label: string;
  valueArity: 0 | 1 | 2;
  description?: string;
}

export interface IndicatorDefinition {
  kind: string;
  label: string;
  description?: string;
  params: IndicatorParam[];
  operators: IndicatorOperatorDef[];
}

export interface IndicatorsCatalog {
  intervals: string[];
  indicators: IndicatorDefinition[];
}

interface IndicatorsCatalogResponse {
  status: string;
  data: IndicatorsCatalog;
}

export class TcApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: TcApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 10_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async heartbeat(): Promise<HeartbeatResponse> {
    return this.requestRaw<HeartbeatResponse>('GET', '/api/v1/bot/heartbeat');
  }

  async getPlans(): Promise<TcPlan[]> {
    const res = await this.requestRaw<PlansResponse>('GET', '/api/v1/bot/plans');
    return res.plans;
  }

  async getIndicatorsCatalog(): Promise<IndicatorsCatalog> {
    const res = await this.requestRaw<IndicatorsCatalogResponse>('GET', '/api/v1/bot/indicators-catalog');
    return res.data;
  }

  /**
   * Einziger erlaubter HTTP-Verkehr Richtung Journal: GET.
   *
   * `method` ist fest verdrahtet und nicht parametrisiert — damit laesst
   * sich hierueber auch versehentlich nichts schreiben.
   */
  private async requestRaw<T>(method: 'GET', path: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        await this.sleep(delay);
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'User-Agent': 'TradingControl-Bot/0.1.0',
        };

        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // 401/403: Sofortiger Abbruch, kein Retry
        if (res.status === 401 || res.status === 403) {
          throw new TcApiError(`Authentication failed (${res.status})`, res.status, false);
        }

        // 429: Rate-Limit, langer Backoff
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') ?? '120', 10);
          await this.sleep(retryAfter * 1000);
          continue;
        }

        if (!res.ok) {
          throw new TcApiError(`HTTP ${res.status}: ${res.statusText}`, res.status, true);
        }

        const data = await res.json() as T;
        return data;
      } catch (err) {
        if (err instanceof TcApiError && !err.retryable) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Request failed after retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class TcApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'TcApiError';
  }
}
