import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TradeRecord {
  id?: number;
  plan_id: string;
  symbol: string;
  side: string;
  type: string;
  price: number;
  quantity: number;
  filled_quantity: number;
  avg_fill_price: number;
  fee: number;
  pnl: number;
  action: string;
  order_id: string;
  timestamp: string;
}

export interface PlanStateRecord {
  plan_id: string;
  status: string;
  activated: boolean;
  entry_orders_json: string;
  tp_orders_json: string;
  sl_order_json: string | null;
  error_count: number;
  updated_at: string;
}

export interface BotStateRecord {
  key: string;
  value: string;
  updated_at: string;
}

export interface LocalPlanRecord {
  id: string;
  symbol: string;
  direction: string;
  market_type: string;
  leverage: number;
  total_size: number;
  entry_strategy: string;
  entry_orders: string; // JSON
  take_profits: string; // JSON
  stop_loss_price: number | null;
  stop_loss_type: string | null;
  trailing_stop_pct: number | null;
  trailing_stop_activation: number | null;
  activation_conditions: string; // JSON
  status: string;
  bot_enabled: boolean | number;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        filled_quantity REAL NOT NULL DEFAULT 0,
        avg_fill_price REAL NOT NULL DEFAULT 0,
        fee REAL NOT NULL DEFAULT 0,
        pnl REAL NOT NULL DEFAULT 0,
        action TEXT NOT NULL,
        order_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_trades_plan_id ON trades(plan_id);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);

      CREATE TABLE IF NOT EXISTS plan_state (
        plan_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        activated INTEGER NOT NULL DEFAULT 0,
        entry_orders_json TEXT NOT NULL DEFAULT '[]',
        tp_orders_json TEXT NOT NULL DEFAULT '[]',
        sl_order_json TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- CopyTrading: Tracked Wallets
      CREATE TABLE IF NOT EXISTS ct_wallets (
        address TEXT PRIMARY KEY,
        label TEXT,
        tier TEXT NOT NULL DEFAULT 'watchlist',
        score REAL NOT NULL DEFAULT 0,
        added_by TEXT NOT NULL DEFAULT 'auto',
        active INTEGER NOT NULL DEFAULT 0,
        sharpe_ratio REAL NOT NULL DEFAULT 0,
        max_drawdown_pct REAL NOT NULL DEFAULT 0,
        win_rate REAL NOT NULL DEFAULT 0,
        profit_factor REAL NOT NULL DEFAULT 0,
        total_trades INTEGER NOT NULL DEFAULT 0,
        track_record_days INTEGER NOT NULL DEFAULT 0,
        avg_leverage REAL NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        paused_until TEXT,
        last_signal_at TEXT,
        last_score_update TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- CopyTrading: Signals
      CREATE TABLE IF NOT EXISTS ct_signals (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        wallet_tier TEXT NOT NULL,
        wallet_score REAL NOT NULL,
        signal_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        size REAL NOT NULL,
        leverage REAL NOT NULL,
        entry_price REAL NOT NULL,
        detected_at TEXT NOT NULL,
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        conviction_json TEXT,
        trade_id TEXT,
        trade_pnl REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ct_signals_wallet ON ct_signals(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_ct_signals_status ON ct_signals(status);
      CREATE INDEX IF NOT EXISTS idx_ct_signals_detected ON ct_signals(detected_at);

      -- CopyTrading: Trades (persistiert)
      CREATE TABLE IF NOT EXISTS ct_trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        size REAL NOT NULL,
        leverage REAL NOT NULL DEFAULT 1,
        margin_usd REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        sl_price REAL,
        tp_prices TEXT NOT NULL DEFAULT '[]',
        trailing_active INTEGER NOT NULL DEFAULT 0,
        trailing_stop_price REAL,
        exit_price REAL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        exit_reason TEXT,
        opened_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ct_trades_status ON ct_trades(status);

      CREATE TABLE IF NOT EXISTS local_plans (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('long','short')),
        market_type TEXT NOT NULL DEFAULT 'futures',
        leverage REAL NOT NULL DEFAULT 1,
        total_size REAL NOT NULL,
        entry_strategy TEXT NOT NULL DEFAULT 'single',
        entry_orders TEXT NOT NULL DEFAULT '[]',
        entry_zones TEXT,                         -- JSONB | null (Migration 075)
        take_profits TEXT NOT NULL DEFAULT '[]',
        stop_loss_price REAL,
        stop_loss_type TEXT DEFAULT 'fixed',
        trailing_stop_pct REAL,
        trailing_stop_activation REAL,
        trailing_stop_size_pct REAL,              -- Migration 074
        activation_conditions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'planned',
        bot_enabled INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Bot Trade Plans (TC-Plan Sync + lokale Pläne mit allen TC-Features)
      --
      -- Die Spalte source trennt die drei Bestaende, die sich NICHT
      -- ueberschneiden duerfen: 'tc' kommt aus dem Journal, 'local' wird
      -- hier angelegt, 'signal' entsteht aus einem externen Handelssignal.
      -- Nur weil jeder Bestand genau einen Ausfuehrer hat, kann keine Order
      -- zweimal an die Boerse gehen.
      CREATE TABLE IF NOT EXISTS bot_trade_plans (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('tc','local','signal')),
        tc_user_id TEXT,
        exchange TEXT,
        exchange_account_id TEXT,
        symbol TEXT NOT NULL,
        asset_symbol TEXT,
        quote_currency TEXT DEFAULT 'USDT',
        market_type TEXT NOT NULL DEFAULT 'futures' CHECK(market_type IN ('spot','futures')),
        direction TEXT NOT NULL CHECK(direction IN ('long','short')),
        leverage REAL NOT NULL DEFAULT 1,
        total_size REAL NOT NULL,
        total_margin REAL,
        entry_strategy TEXT NOT NULL DEFAULT 'single',
        entry_orders TEXT NOT NULL DEFAULT '[]',
        entry_zones TEXT,
        take_profits TEXT NOT NULL DEFAULT '[]',
        stop_loss_price REAL,
        stop_loss_type TEXT DEFAULT 'fixed' CHECK(stop_loss_type IN ('fixed','trailing')),
        trailing_stop_pct REAL,
        trailing_stop_activation REAL,
        trailing_stop_size_pct REAL,
        activation_conditions TEXT NOT NULL DEFAULT '[]',
        executed_orders TEXT NOT NULL DEFAULT '[]',
        execution_mode TEXT NOT NULL DEFAULT 'all_limit' CHECK(execution_mode IN ('all_limit','first_market_rest_limit')),
        status TEXT NOT NULL DEFAULT 'planned',
        bot_enabled INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_status ON bot_trade_plans(status);
      CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_source ON bot_trade_plans(source);
      CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_symbol ON bot_trade_plans(symbol);

      -- Trade Plan Monitor State (TC Migration 046)
      CREATE TABLE IF NOT EXISTS bot_trade_plan_monitors (
        trade_plan_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'waiting_activation',
        activation_step INTEGER NOT NULL DEFAULT 0,
        tp_state TEXT NOT NULL DEFAULT '[]',
        sl_current REAL,
        sl_type_current TEXT DEFAULT 'fixed',
        trailing_active INTEGER NOT NULL DEFAULT 0,
        trailing_best_price REAL,
        trailing_size_pct REAL,
        remaining_size REAL DEFAULT 0,
        last_price REAL,
        last_checked_at TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (trade_plan_id) REFERENCES bot_trade_plans(id) ON DELETE CASCADE
      );

      -- Trade Plan Orders (TC Migration 037 + 077: entry_order_id linkage)
      CREATE TABLE IF NOT EXISTS bot_trade_plan_orders (
        id TEXT PRIMARY KEY,
        trade_plan_id TEXT NOT NULL,
        entry_order_id TEXT,
        side TEXT NOT NULL CHECK(side IN ('buy','sell')),
        order_type TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('entry','take_profit','stop_loss','trailing_stop')),
        symbol TEXT NOT NULL,
        price REAL,
        stop_price REAL,
        quantity REAL NOT NULL,
        filled_quantity REAL NOT NULL DEFAULT 0,
        avg_fill_price REAL,
        status TEXT NOT NULL DEFAULT 'new',
        broker TEXT NOT NULL,
        broker_order_id TEXT,
        client_order_id TEXT,
        fees REAL DEFAULT 0,
        fee_currency TEXT,
        raw_response TEXT,
        placed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (trade_plan_id) REFERENCES bot_trade_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_btp_orders_plan ON bot_trade_plan_orders(trade_plan_id);
      CREATE INDEX IF NOT EXISTS idx_btp_orders_entry_id ON bot_trade_plan_orders(entry_order_id);
      CREATE INDEX IF NOT EXISTS idx_btp_orders_status ON bot_trade_plan_orders(status);

      -- Indicator-Cache (Klines pro Symbol+Interval)
      CREATE TABLE IF NOT EXISTS bot_indicator_cache (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        candles_json TEXT NOT NULL,
        last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (symbol, interval)
      );

      -- Ausfuehrungsprotokoll des Bots: was er wann warum getan hat.
      -- Bleibt hier und wird nirgendwohin gesendet. Die handelsrelevanten
      -- Daten (Fuellungen, Gebuehren, Ergebnis) holt sich das Journal ueber
      -- seinen eigenen API-Import bei der Boerse; dieses Protokoll dient der
      -- Nachvollziehbarkeit der Bot-Entscheidungen — auch der abgelehnten,
      -- die an der Boerse gar keine Spur hinterlassen.
      -- Die Spalten reported_at/report_status stammen aus der Zeit des
      -- Rueckkanals und bleiben nur, damit bestehende Datenbanken weiter
      -- lesbar sind.
      CREATE TABLE IF NOT EXISTS bot_execution_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        entry_order_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        status TEXT NOT NULL,
        fill_price REAL,
        fill_quantity REAL,
        fees REAL,
        fee_currency TEXT,
        broker TEXT NOT NULL,
        broker_order_id TEXT,
        bot_firmware TEXT,
        device_id TEXT,
        metadata_json TEXT,
        executed_at TEXT NOT NULL,
        reported_at TEXT,
        report_status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bot_exec_reports_plan ON bot_execution_reports(plan_id);

      -- Eingangsbuch fuer externe Handelssignale (TradingView u. ae.)
      --
      -- Jedes Signal wird festgehalten, auch das abgelehnte. Gerade das
      -- abgelehnte: An der Boerse hinterlaesst es keine Spur, und ohne
      -- diesen Eintrag liesse sich spaeter nicht sagen, warum ein Trade
      -- ausblieb. Die Spalte scaling_json haelt die vollstaendige Rechnung
      -- fest, mit der die Groesse zustande kam.
      CREATE TABLE IF NOT EXISTS signal_inbox (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        action TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT,
        source_ip TEXT,
        raw_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        scaling_json TEXT,
        created_plan_id TEXT,
        matched_plan_ids TEXT NOT NULL DEFAULT '[]',
        emitted_at TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        received_ms INTEGER NOT NULL DEFAULT 0,
        -- Nur bei action='trigger': Solange nicht verbraucht, kann ein
        -- wartender Plan sich darauf berufen.
        consumed INTEGER NOT NULL DEFAULT 0,
        consumed_at TEXT
      );
      -- Warteschlange des Rueckkanals an TC-Synaptrix.
      --
      -- Sie liegt auf der Platte und nicht im Arbeitsspeicher, weil sonst
      -- genau die Ereignisse verloren gingen, die waehrend einer Stoerung
      -- des Empfaengers anfielen — und zwar unbemerkt: Ein fehlendes
      -- Ereignis ist von einem nie entstandenen nicht zu unterscheiden.
      --
      -- ereignis_id ist eindeutig. Dieselbe Kennung zweimal einzureihen
      -- ist kein Fehler, sondern der Normalfall nach einem Neustart
      -- mitten im Senden; der Empfaenger verwirft, was er kennt.
      --
      -- Gesendetes bleibt mit gesendet_am stehen und wird erst spaeter
      -- aufgeraeumt. Sofort zu loeschen hiesse, nach einer Stoerung nicht
      -- mehr sagen zu koennen, was uebergeben wurde und was nicht.
      CREATE TABLE IF NOT EXISTS tc_rueckkanal_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ereignis_id TEXT NOT NULL UNIQUE,
        ereignis_json TEXT NOT NULL,
        angelegt_am TEXT NOT NULL DEFAULT (datetime('now')),
        gesendet_am TEXT,
        versuche INTEGER NOT NULL DEFAULT 0,
        letzter_versuch_am TEXT,
        letzter_fehler TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tc_rueckkanal_offen
        ON tc_rueckkanal_queue(id) WHERE gesendet_am IS NULL;

      -- Uebungskonto: ein Satz je Waehrung.
      --
      -- Der Stand muss einen Neustart ueberleben. Sonst begaenne das
      -- Uebungskonto jedesmal von vorn, und eine Verlustserie waere mit
      -- einem Neustart aus der Welt — womit die Uebung nichts mehr
      -- ueber das Verfahren aussagte.
      CREATE TABLE IF NOT EXISTS paper_account (
        waehrung TEXT PRIMARY KEY,
        startkapital REAL NOT NULL DEFAULT 0,
        realisiert REAL NOT NULL DEFAULT 0,
        gebuehren REAL NOT NULL DEFAULT 0,
        trades INTEGER NOT NULL DEFAULT 0,
        gewinne INTEGER NOT NULL DEFAULT 0,
        verluste INTEGER NOT NULL DEFAULT 0,
        taker_satz REAL NOT NULL DEFAULT 0.0006,
        maker_satz REAL NOT NULL DEFAULT 0.0001,
        erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
        geaendert_am TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Kontoblatt: jede einzelne Buchung, damit ein Kontostand
      -- nachvollziehbar bleibt und nicht nur behauptet wird.
      CREATE TABLE IF NOT EXISTS paper_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        art TEXT NOT NULL,
        betrag REAL NOT NULL,
        waehrung TEXT NOT NULL,
        symbol TEXT,
        menge REAL,
        preis REAL,
        notiz TEXT,
        zeitpunkt TEXT NOT NULL,
        erstellt_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_paper_ledger_zeit ON paper_ledger(erstellt_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_paper_ledger_art ON paper_ledger(art);

      -- Offene Positionen des Uebungskontos.
      --
      -- Muessen mitgespeichert werden, sonst faellt die gebundene
      -- Margin nach einem Neustart auf 0 — der gesamte Kontostand
      -- gaelte wieder als frei, und der naechste Trade wuerde bemessen,
      -- als sei nichts gebunden.
      -- Hedge-Modus: Long und Short auf demselben Symbol sind ZWEI
      -- Positionen. Der Schluessel umfasst deshalb beides.
      --
      -- Mit dem Symbol allein als Schluessel konnte nur eine Richtung
      -- je Symbol bestehen — ein Long-Einstieg knabberte an einem
      -- laufenden Short. Die Umstellung bestehender Datenbanken
      -- besorgt migrierePaperPositionen().
      CREATE TABLE IF NOT EXISTS paper_position (
        symbol TEXT NOT NULL,
        seite TEXT NOT NULL CHECK(seite IN ('buy','sell')),
        menge REAL NOT NULL,
        einstiegspreis REAL NOT NULL,
        hebel REAL NOT NULL DEFAULT 1,
        geaendert_am TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (symbol, seite)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_inbox_signal_id ON signal_inbox(signal_id);
      CREATE INDEX IF NOT EXISTS idx_signal_inbox_status ON signal_inbox(status);
      CREATE INDEX IF NOT EXISTS idx_signal_inbox_symbol ON signal_inbox(symbol);
      CREATE INDEX IF NOT EXISTS idx_signal_inbox_trigger
        ON signal_inbox(action, consumed, strategy, symbol);
    `);

    // Idempotente Migrationen fuer bestehende local_plans-Tabelle
    this.migrateLocalPlans();
    this.migrateExecutionReports();
    this.migrateBotTradePlans();
    this.migrierePaperPositionen();
  }

  /**
   * Idempotent: Bringt bot_trade_plans auf den Stand mit Signal-Quelle.
   *
   * Zwei Aenderungen:
   *   - `source` kennt zusaetzlich 'signal'
   *   - neue Spalten `signal_trigger` und `signal_origin`
   *
   * Die erste erfordert in SQLite einen Neubau der Tabelle, weil sich ein
   * CHECK nicht nachtraeglich lockern laesst. Das geschieht in einer
   * Transaktion mit abgeschalteten Fremdschluesseln: Monitor-Zustand und
   * Orders haengen per ON DELETE CASCADE an den Plaenen und wuerden sonst
   * mit der alten Tabelle verschwinden.
   */
  private migrateBotTradePlans(): void {
    const spalten = this.db.prepare('PRAGMA table_info(bot_trade_plans)').all() as Array<{ name: string }>;
    const namen = new Set(spalten.map(c => c.name));

    if (!namen.has('signal_trigger')) {
      this.db.exec('ALTER TABLE bot_trade_plans ADD COLUMN signal_trigger TEXT');
    }
    if (!namen.has('signal_origin')) {
      this.db.exec('ALTER TABLE bot_trade_plans ADD COLUMN signal_origin TEXT');
    }

    const schema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_trade_plans'",
    ).get() as { sql?: string } | undefined;

    const kenntSignalQuelle = schema?.sql?.includes("'signal'") ?? false;
    if (kenntSignalQuelle) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;

        CREATE TABLE bot_trade_plans_neu (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('tc','local','signal')),
          tc_user_id TEXT,
          exchange TEXT,
          exchange_account_id TEXT,
          symbol TEXT NOT NULL,
          asset_symbol TEXT,
          quote_currency TEXT DEFAULT 'USDT',
          market_type TEXT NOT NULL DEFAULT 'futures' CHECK(market_type IN ('spot','futures')),
          direction TEXT NOT NULL CHECK(direction IN ('long','short')),
          leverage REAL NOT NULL DEFAULT 1,
          total_size REAL NOT NULL,
          total_margin REAL,
          entry_strategy TEXT NOT NULL DEFAULT 'single',
          entry_orders TEXT NOT NULL DEFAULT '[]',
          entry_zones TEXT,
          take_profits TEXT NOT NULL DEFAULT '[]',
          stop_loss_price REAL,
          stop_loss_type TEXT DEFAULT 'fixed' CHECK(stop_loss_type IN ('fixed','trailing')),
          trailing_stop_pct REAL,
          trailing_stop_activation REAL,
          trailing_stop_size_pct REAL,
          activation_conditions TEXT NOT NULL DEFAULT '[]',
          executed_orders TEXT NOT NULL DEFAULT '[]',
          execution_mode TEXT NOT NULL DEFAULT 'all_limit' CHECK(execution_mode IN ('all_limit','first_market_rest_limit')),
          status TEXT NOT NULL DEFAULT 'planned',
          bot_enabled INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          signal_trigger TEXT,
          signal_origin TEXT,
          last_synced_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO bot_trade_plans_neu
          SELECT id, source, tc_user_id, exchange, exchange_account_id,
                 symbol, asset_symbol, quote_currency, market_type, direction,
                 leverage, total_size, total_margin, entry_strategy,
                 entry_orders, entry_zones, take_profits,
                 stop_loss_price, stop_loss_type, trailing_stop_pct,
                 trailing_stop_activation, trailing_stop_size_pct,
                 activation_conditions, executed_orders, execution_mode,
                 status, bot_enabled, notes, signal_trigger, signal_origin,
                 last_synced_at, created_at, updated_at
          FROM bot_trade_plans;

        DROP TABLE bot_trade_plans;
        ALTER TABLE bot_trade_plans_neu RENAME TO bot_trade_plans;

        CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_status ON bot_trade_plans(status);
        CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_source ON bot_trade_plans(source);
        CREATE INDEX IF NOT EXISTS idx_bot_trade_plans_symbol ON bot_trade_plans(symbol);

        COMMIT;
      `);
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch { /* war schon zurueckgerollt */ }
      throw err;
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Stellt `paper_position` auf den Hedge-Modus um.
   *
   * Frueher war `symbol` allein der Primaerschluessel — je Symbol
   * konnte nur EINE Richtung bestehen. Ein Long-Einstieg traf dann auf
   * einen laufenden Short und knabberte ihn an, statt eine eigene
   * Position zu eroeffnen.
   *
   * Idempotent: Steht der Schluessel schon richtig, geschieht nichts.
   * Bestehende Positionen werden uebernommen — sie sind je Symbol
   * eindeutig und passen deshalb ohne Weiteres in den neuen Schluessel.
   */
  private migrierePaperPositionen(): void {
    const cols = this.db.prepare('PRAGMA table_info(paper_position)')
      .all() as Array<{ name: string; pk: number }>;
    if (cols.length === 0) return;   // Tabelle gibt es noch nicht.

    // Teil des Primaerschluessels: pk > 0. Sind es zwei Spalten, ist
    // die Umstellung bereits geschehen.
    const imSchluessel = cols.filter(c => c.pk > 0).map(c => c.name);
    if (imSchluessel.length >= 2) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN;

        CREATE TABLE paper_position_neu (
          symbol TEXT NOT NULL,
          seite TEXT NOT NULL CHECK(seite IN ('buy','sell')),
          menge REAL NOT NULL,
          einstiegspreis REAL NOT NULL,
          hebel REAL NOT NULL DEFAULT 1,
          geaendert_am TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (symbol, seite)
        );

        INSERT INTO paper_position_neu
          SELECT symbol, seite, menge, einstiegspreis, hebel, geaendert_am
          FROM paper_position;

        DROP TABLE paper_position;
        ALTER TABLE paper_position_neu RENAME TO paper_position;

        COMMIT;
      `);
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch { /* war schon zurueckgerollt */ }
      throw err;
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /** Idempotent: Fuegt neue Spalten zu bot_execution_reports hinzu */
  private migrateExecutionReports(): void {
    const cols = this.db.prepare("PRAGMA table_info(bot_execution_reports)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    const additions: string[] = [];
    if (!colNames.has('fees')) additions.push('ALTER TABLE bot_execution_reports ADD COLUMN fees REAL');
    if (!colNames.has('fee_currency')) additions.push('ALTER TABLE bot_execution_reports ADD COLUMN fee_currency TEXT');
    if (!colNames.has('bot_firmware')) additions.push('ALTER TABLE bot_execution_reports ADD COLUMN bot_firmware TEXT');
    if (!colNames.has('device_id')) additions.push('ALTER TABLE bot_execution_reports ADD COLUMN device_id TEXT');
    if (!colNames.has('metadata_json')) additions.push('ALTER TABLE bot_execution_reports ADD COLUMN metadata_json TEXT');
    for (const sql of additions) this.db.exec(sql);
  }

  /** Idempotent: Fuegt neue Spalten zu local_plans hinzu wenn nicht vorhanden */
  private migrateLocalPlans(): void {
    const cols = this.db.prepare("PRAGMA table_info(local_plans)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    const additions: string[] = [];

    if (!colNames.has('entry_zones')) {
      additions.push('ALTER TABLE local_plans ADD COLUMN entry_zones TEXT');
    }
    if (!colNames.has('trailing_stop_size_pct')) {
      additions.push('ALTER TABLE local_plans ADD COLUMN trailing_stop_size_pct REAL');
    }
    if (!colNames.has('execution_mode')) {
      additions.push("ALTER TABLE local_plans ADD COLUMN execution_mode TEXT DEFAULT 'all_limit'");
    }
    if (!colNames.has('exchange_account_id')) {
      additions.push('ALTER TABLE local_plans ADD COLUMN exchange_account_id TEXT');
    }

    for (const sql of additions) {
      this.db.exec(sql);
    }
  }

  // --- Trades ---

  insertTrade(trade: TradeRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades (plan_id, symbol, side, type, price, quantity, filled_quantity, avg_fill_price, fee, pnl, action, order_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      trade.plan_id, trade.symbol, trade.side, trade.type,
      trade.price, trade.quantity, trade.filled_quantity, trade.avg_fill_price,
      trade.fee, trade.pnl, trade.action, trade.order_id, trade.timestamp
    );
    return result.lastInsertRowid as number;
  }

  getTrades(limit = 100, offset = 0): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as TradeRecord[];
  }

  getTradesByPlan(planId: string): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades WHERE plan_id = ? ORDER BY timestamp DESC'
    ).all(planId) as TradeRecord[];
  }

  getTradeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM trades').get() as { count: number };
    return row.count;
  }

  // --- Plan State ---

  savePlanState(state: PlanStateRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO plan_state (plan_id, status, activated, entry_orders_json, tp_orders_json, sl_order_json, error_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      state.plan_id, state.status, state.activated ? 1 : 0,
      state.entry_orders_json, state.tp_orders_json, state.sl_order_json, state.error_count
    );
  }

  getPlanState(planId: string): PlanStateRecord | undefined {
    return this.db.prepare(
      'SELECT * FROM plan_state WHERE plan_id = ?'
    ).get(planId) as PlanStateRecord | undefined;
  }

  getAllPlanStates(): PlanStateRecord[] {
    return this.db.prepare('SELECT * FROM plan_state').all() as PlanStateRecord[];
  }

  deletePlanState(planId: string): void {
    this.db.prepare('DELETE FROM plan_state WHERE plan_id = ?').run(planId);
  }

  // --- Bot State ---

  setBotState(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(key, value);
  }

  getBotState(key: string): string | undefined {
    const row = this.db.prepare(
      'SELECT value FROM bot_state WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  // --- Local Plans ---

  insertLocalPlan(plan: LocalPlanRecord): void {
    this.db.prepare(`
      INSERT INTO local_plans (id, symbol, direction, market_type, leverage, total_size, entry_strategy, entry_orders, take_profits, stop_loss_price, stop_loss_type, trailing_stop_pct, trailing_stop_activation, activation_conditions, status, bot_enabled, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id, plan.symbol, plan.direction, plan.market_type, plan.leverage, plan.total_size, plan.entry_strategy,
      plan.entry_orders, plan.take_profits, plan.stop_loss_price, plan.stop_loss_type,
      plan.trailing_stop_pct, plan.trailing_stop_activation, plan.activation_conditions,
      plan.status, plan.bot_enabled ? 1 : 0, plan.notes
    );
  }

  getLocalPlans(): LocalPlanRecord[] {
    return this.db.prepare('SELECT * FROM local_plans ORDER BY created_at DESC').all() as LocalPlanRecord[];
  }

  getLocalPlan(id: string): LocalPlanRecord | undefined {
    return this.db.prepare('SELECT * FROM local_plans WHERE id = ?').get(id) as LocalPlanRecord | undefined;
  }

  getActiveLocalPlans(): LocalPlanRecord[] {
    return this.db.prepare("SELECT * FROM local_plans WHERE bot_enabled = 1 AND status IN ('planned','active') ORDER BY created_at DESC").all() as LocalPlanRecord[];
  }

  updateLocalPlanStatus(id: string, status: string): void {
    this.db.prepare("UPDATE local_plans SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }

  deleteLocalPlan(id: string): void {
    this.db.prepare('DELETE FROM local_plans WHERE id = ?').run(id);
  }

  // --- CopyTrading: Wallets ---

  upsertCtWallet(wallet: {
    address: string; label?: string; tier: string; score: number;
    added_by: string; active: boolean; sharpe_ratio: number;
    max_drawdown_pct: number; win_rate: number; profit_factor: number;
    total_trades: number; track_record_days: number; avg_leverage: number;
    streak: number; paused_until?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ct_wallets (address, label, tier, score, added_by, active,
        sharpe_ratio, max_drawdown_pct, win_rate, profit_factor, total_trades,
        track_record_days, avg_leverage, streak, paused_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      wallet.address, wallet.label ?? null, wallet.tier, wallet.score,
      wallet.added_by, wallet.active ? 1 : 0, wallet.sharpe_ratio,
      wallet.max_drawdown_pct, wallet.win_rate, wallet.profit_factor,
      wallet.total_trades, wallet.track_record_days, wallet.avg_leverage,
      wallet.streak, wallet.paused_until ?? null
    );
  }

  getCtWallets(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM ct_wallets ORDER BY score DESC').all() as Array<Record<string, unknown>>;
  }

  getCtWallet(address: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM ct_wallets WHERE address = ?').get(address) as Record<string, unknown> | undefined;
  }

  deleteCtWallet(address: string): void {
    this.db.prepare('DELETE FROM ct_wallets WHERE address = ?').run(address);
  }

  // --- CopyTrading: Signals ---

  insertCtSignal(signal: {
    id: string; wallet_address: string; wallet_tier: string; wallet_score: number;
    signal_type: string; symbol: string; direction: string; size: number;
    leverage: number; entry_price: number; detected_at: string;
    status: string; rejection_reason?: string; conviction_json?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO ct_signals (id, wallet_address, wallet_tier, wallet_score,
        signal_type, symbol, direction, size, leverage, entry_price,
        detected_at, status, rejection_reason, conviction_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.id, signal.wallet_address, signal.wallet_tier, signal.wallet_score,
      signal.signal_type, signal.symbol, signal.direction, signal.size,
      signal.leverage, signal.entry_price, signal.detected_at,
      signal.status, signal.rejection_reason ?? null, signal.conviction_json ?? null
    );
  }

  updateCtSignalStatus(id: string, status: string, extra?: { rejection_reason?: string; conviction_json?: string; trade_id?: string; trade_pnl?: number }): void {
    let sql = "UPDATE ct_signals SET status = ?, processed_at = datetime('now')";
    const params: unknown[] = [status];

    if (extra?.rejection_reason) { sql += ', rejection_reason = ?'; params.push(extra.rejection_reason); }
    if (extra?.conviction_json) { sql += ', conviction_json = ?'; params.push(extra.conviction_json); }
    if (extra?.trade_id) { sql += ', trade_id = ?'; params.push(extra.trade_id); }
    if (extra?.trade_pnl !== undefined) { sql += ', trade_pnl = ?'; params.push(extra.trade_pnl); }

    sql += ' WHERE id = ?';
    params.push(id);
    this.db.prepare(sql).run(...params);
  }

  getCtSignals(limit = 100, offset = 0): Array<Record<string, unknown>> {
    return this.db.prepare(
      'SELECT * FROM ct_signals ORDER BY detected_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as Array<Record<string, unknown>>;
  }

  getCtSignalStats(): { total: number; executed: number; skipped: number; rejected: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END) as executed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM ct_signals
    `).get() as { total: number; executed: number; skipped: number; rejected: number };
    return row;
  }

  // --- CopyTrading: Trades ---

  insertCtTrade(trade: {
    id: string; signal_id: string; wallet_address: string; symbol: string;
    direction: string; entry_price: number; size: number; leverage: number;
    margin_usd: number; status: string; sl_price: number;
    tp_prices: number[]; opened_at: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ct_trades (id, signal_id, wallet_address, symbol, direction,
        entry_price, size, leverage, margin_usd, status, sl_price, tp_prices, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id, trade.signal_id, trade.wallet_address, trade.symbol, trade.direction,
      trade.entry_price, trade.size, trade.leverage, trade.margin_usd,
      trade.status, trade.sl_price, JSON.stringify(trade.tp_prices), trade.opened_at
    );
  }

  updateCtTrade(id: string, updates: {
    status?: string; sl_price?: number; trailing_active?: boolean;
    trailing_stop_price?: number; exit_price?: number;
    realized_pnl?: number; exit_reason?: string; closed_at?: string; size?: number;
  }): void {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (updates.status !== undefined) { parts.push('status = ?'); params.push(updates.status); }
    if (updates.sl_price !== undefined) { parts.push('sl_price = ?'); params.push(updates.sl_price); }
    if (updates.trailing_active !== undefined) { parts.push('trailing_active = ?'); params.push(updates.trailing_active ? 1 : 0); }
    if (updates.trailing_stop_price !== undefined) { parts.push('trailing_stop_price = ?'); params.push(updates.trailing_stop_price); }
    if (updates.exit_price !== undefined) { parts.push('exit_price = ?'); params.push(updates.exit_price); }
    if (updates.realized_pnl !== undefined) { parts.push('realized_pnl = ?'); params.push(updates.realized_pnl); }
    if (updates.exit_reason !== undefined) { parts.push('exit_reason = ?'); params.push(updates.exit_reason); }
    if (updates.closed_at !== undefined) { parts.push('closed_at = ?'); params.push(updates.closed_at); }
    if (updates.size !== undefined) { parts.push('size = ?'); params.push(updates.size); }
    if (parts.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE ct_trades SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  }

  getCtTrades(status?: string): Array<Record<string, unknown>> {
    if (status) {
      return this.db.prepare('SELECT * FROM ct_trades WHERE status = ? ORDER BY opened_at DESC').all(status) as Array<Record<string, unknown>>;
    }
    return this.db.prepare('SELECT * FROM ct_trades ORDER BY opened_at DESC').all() as Array<Record<string, unknown>>;
  }

  getCtTradeStats(): { total: number; open: number; closed: number; totalPnl: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END) as totalPnl
      FROM ct_trades
    `).get() as { total: number; open: number; closed: number; totalPnl: number };
    return row;
  }

  // ============================================================
  // Bot Trade Plans (TC-konform mit allen Features)
  // ============================================================

  upsertBotTradePlan(plan: {
    id: string; source: 'tc' | 'local' | 'signal'; tc_user_id?: string;
    exchange?: string | null; exchange_account_id?: string | null;
    symbol: string; asset_symbol?: string | null; quote_currency?: string | null;
    market_type: string; direction: string; leverage: number; total_size: number;
    total_margin?: number | null; entry_strategy: string;
    entry_orders: string; entry_zones?: string | null;
    take_profits: string;
    stop_loss_price?: number | null; stop_loss_type?: string | null;
    trailing_stop_pct?: number | null; trailing_stop_activation?: number | null;
    trailing_stop_size_pct?: number | null;
    activation_conditions: string; executed_orders: string;
    execution_mode: string; status: string; bot_enabled: boolean;
    notes?: string | null;
    /** Bedingung aus einem externen Signal (JSON), siehe Weg A. */
    signal_trigger?: string | null;
    /** Herkunftsnachweis aus dem Signal (JSON), siehe Weg B. */
    signal_origin?: string | null;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_trade_plans (
        id, source, tc_user_id, exchange, exchange_account_id,
        symbol, asset_symbol, quote_currency, market_type, direction,
        leverage, total_size, total_margin, entry_strategy,
        entry_orders, entry_zones, take_profits,
        stop_loss_price, stop_loss_type, trailing_stop_pct, trailing_stop_activation, trailing_stop_size_pct,
        activation_conditions, executed_orders, execution_mode, status, bot_enabled, notes,
        signal_trigger, signal_origin,
        last_synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        datetime('now'), datetime('now'))
    `).run(
      plan.id, plan.source, plan.tc_user_id ?? null, plan.exchange ?? null, plan.exchange_account_id ?? null,
      plan.symbol, plan.asset_symbol ?? null, plan.quote_currency ?? 'USDT',
      plan.market_type, plan.direction, plan.leverage, plan.total_size,
      plan.total_margin ?? null, plan.entry_strategy,
      plan.entry_orders, plan.entry_zones ?? null, plan.take_profits,
      plan.stop_loss_price ?? null, plan.stop_loss_type ?? 'fixed',
      plan.trailing_stop_pct ?? null, plan.trailing_stop_activation ?? null, plan.trailing_stop_size_pct ?? null,
      plan.activation_conditions, plan.executed_orders, plan.execution_mode,
      plan.status, plan.bot_enabled ? 1 : 0, plan.notes ?? null,
      plan.signal_trigger ?? null, plan.signal_origin ?? null
    );
  }

  getBotTradePlan(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM bot_trade_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  /** Setzt die Signal-Bedingung eines Plans (Weg A), ohne ihn sonst anzufassen. */
  setPlanSignalTrigger(id: string, trigger: string | null): void {
    this.db.prepare(
      "UPDATE bot_trade_plans SET signal_trigger = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(trigger, id);
  }

  getBotTradePlans(filter?: { source?: 'tc' | 'local' | 'signal'; status?: string; symbol?: string }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.source) { where.push('source = ?'); params.push(filter.source); }
    if (filter?.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter?.symbol) { where.push('symbol = ?'); params.push(filter.symbol); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM bot_trade_plans ${whereSql} ORDER BY created_at DESC`).all(...params) as Array<Record<string, unknown>>;
  }

  getActiveBotTradePlans(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM bot_trade_plans
      WHERE bot_enabled = 1 AND status IN ('planned','active','monitoring','executing')
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;
  }

  updateBotTradePlanStatus(id: string, status: string, executedOrders?: string): void {
    if (executedOrders !== undefined) {
      this.db.prepare(`UPDATE bot_trade_plans SET status = ?, executed_orders = ?, updated_at = datetime('now') WHERE id = ?`).run(status, executedOrders, id);
    } else {
      this.db.prepare(`UPDATE bot_trade_plans SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    }
  }

  deleteBotTradePlan(id: string): void {
    this.db.prepare('DELETE FROM bot_trade_plans WHERE id = ?').run(id);
  }

  // ============================================================
  // Bot Trade Plan Monitors
  // ============================================================

  upsertMonitor(m: {
    trade_plan_id: string; status: string; activation_step: number;
    tp_state: string; sl_current?: number | null; sl_type_current?: string;
    trailing_active: boolean; trailing_best_price?: number | null; trailing_size_pct?: number | null;
    remaining_size: number; last_price?: number | null;
    error_count?: number; last_error?: string | null;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_trade_plan_monitors (
        trade_plan_id, status, activation_step, tp_state, sl_current, sl_type_current,
        trailing_active, trailing_best_price, trailing_size_pct,
        remaining_size, last_price, last_checked_at,
        error_count, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now'))
    `).run(
      m.trade_plan_id, m.status, m.activation_step, m.tp_state,
      m.sl_current ?? null, m.sl_type_current ?? 'fixed',
      m.trailing_active ? 1 : 0, m.trailing_best_price ?? null, m.trailing_size_pct ?? null,
      m.remaining_size, m.last_price ?? null,
      m.error_count ?? 0, m.last_error ?? null
    );
  }

  getMonitor(planId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM bot_trade_plan_monitors WHERE trade_plan_id = ?').get(planId) as Record<string, unknown> | undefined;
  }

  getAllMonitors(): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM bot_trade_plan_monitors WHERE status IN ('waiting_activation','monitoring')`).all() as Array<Record<string, unknown>>;
  }

  deleteMonitor(planId: string): void {
    this.db.prepare('DELETE FROM bot_trade_plan_monitors WHERE trade_plan_id = ?').run(planId);
  }

  /**
   * Plaene, die laut Monitor fertig sind, laut Plan aber noch laufen.
   *
   * Ein Widerspruch, der die Oberflaeche in die Irre fuehrt: Die
   * Uebersichten fragen den Plan, nicht den Monitor. Solche Plaene
   * standen deshalb fuer immer unter den aktiven, mit offener Position
   * 0 und ohne dass noch etwas geschah.
   *
   * Bewusst eine eigene Abfrage: `getAllMonitors` laedt nur laufende
   * Monitore und sieht die abgeschlossenen gar nicht.
   */
  getAbgeschlosseneMitAktivemPlan(): Array<{ trade_plan_id: string; monitor_status: string }> {
    return this.db.prepare(`
      SELECT m.trade_plan_id AS trade_plan_id, m.status AS monitor_status
      FROM bot_trade_plan_monitors m
      JOIN bot_trade_plans p ON p.id = m.trade_plan_id
      WHERE m.status IN ('completed', 'cancelled')
        AND p.status NOT IN ('completed', 'cancelled')
    `).all() as Array<{ trade_plan_id: string; monitor_status: string }>;
  }

  // ============================================================
  // Bot Trade Plan Orders
  // ============================================================

  insertPlanOrder(o: {
    id: string; trade_plan_id: string; entry_order_id?: string | null;
    side: string; order_type: string; role: string; symbol: string;
    price?: number | null; stop_price?: number | null; quantity: number;
    status: string; broker: string;
    broker_order_id?: string | null; client_order_id?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO bot_trade_plan_orders (
        id, trade_plan_id, entry_order_id, side, order_type, role,
        symbol, price, stop_price, quantity, status, broker,
        broker_order_id, client_order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      o.id, o.trade_plan_id, o.entry_order_id ?? null,
      o.side, o.order_type, o.role, o.symbol,
      o.price ?? null, o.stop_price ?? null, o.quantity,
      o.status, o.broker, o.broker_order_id ?? null, o.client_order_id ?? null
    );
  }

  updatePlanOrder(id: string, updates: {
    status?: string; filled_quantity?: number; avg_fill_price?: number | null;
    fees?: number; fee_currency?: string | null; raw_response?: string | null;
    broker_order_id?: string | null;
  }): void {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (updates.status !== undefined) { parts.push('status = ?'); params.push(updates.status); }
    if (updates.filled_quantity !== undefined) { parts.push('filled_quantity = ?'); params.push(updates.filled_quantity); }
    if (updates.avg_fill_price !== undefined) { parts.push('avg_fill_price = ?'); params.push(updates.avg_fill_price); }
    if (updates.fees !== undefined) { parts.push('fees = ?'); params.push(updates.fees); }
    if (updates.fee_currency !== undefined) { parts.push('fee_currency = ?'); params.push(updates.fee_currency); }
    if (updates.raw_response !== undefined) { parts.push('raw_response = ?'); params.push(updates.raw_response); }
    if (updates.broker_order_id !== undefined) { parts.push('broker_order_id = ?'); params.push(updates.broker_order_id); }
    if (parts.length === 0) return;
    parts.push("updated_at = datetime('now')");
    params.push(id);
    this.db.prepare(`UPDATE bot_trade_plan_orders SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  }

  getPlanOrders(planId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM bot_trade_plan_orders WHERE trade_plan_id = ? ORDER BY placed_at ASC').all(planId) as Array<Record<string, unknown>>;
  }

  getPlanOrder(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM bot_trade_plan_orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  /**
   * Alle Orders, die noch an einer Boerse liegen sollten.
   *
   * Gebraucht beim Hochfahren: Der Uebungsbroker haelt seine Orders im
   * Arbeitsspeicher und kennt nach einem Neustart keine mehr. Ohne
   * diese Liste bliebe jede vor dem Neustart gelegte Order fuer immer
   * unbeachtet — sie stuende in der Datenbank, aber niemand wuerde
   * sie je fuellen.
   */
  getLiegendeOrders(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      -- Der Hebel des Plans kommt mit.
      --
      -- Ohne ihn wuerde die Fuellung einer vor dem Neustart gelegten
      -- Order mit Hebel 1 gebucht: Der Uebungsbroker hielt ihn in
      -- einer Map im Arbeitsspeicher, und zwischen dem Legen eines
      -- Limit-Einstiegs und seiner Fuellung liegen oft Stunden.
      SELECT o.*, p.leverage AS plan_leverage FROM bot_trade_plan_orders o
      JOIN bot_trade_plans p ON p.id = o.trade_plan_id
      WHERE o.status IN ('new', 'placed', 'partially_filled')
        AND o.broker_order_id IS NOT NULL
        AND p.status NOT IN ('completed', 'cancelled')
      ORDER BY o.placed_at ASC
    `).all() as Array<Record<string, unknown>>;
  }

  // ============================================================
  // Indicator-Cache
  // ============================================================

  setIndicatorCache(symbol: string, interval: string, candlesJson: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_indicator_cache (symbol, interval, candles_json, last_updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(symbol, interval, candlesJson);
  }

  getIndicatorCache(symbol: string, interval: string): { candles_json: string; last_updated_at: string } | undefined {
    return this.db.prepare('SELECT candles_json, last_updated_at FROM bot_indicator_cache WHERE symbol = ? AND interval = ?')
      .get(symbol, interval) as { candles_json: string; last_updated_at: string } | undefined;
  }

  // ============================================================
  // Ausfuehrungsprotokoll (rein lokal)
  // ============================================================

  insertExecutionReport(r: {
    plan_id: string; entry_order_id?: string | null;
    symbol: string; side: string; order_type: string; status: string;
    fill_price?: number | null; fill_quantity?: number | null;
    fees?: number | null; fee_currency?: string | null;
    broker: string; broker_order_id?: string | null;
    bot_firmware?: string | null; device_id?: string | null;
    metadata?: Record<string, unknown> | null;
    executed_at: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO bot_execution_reports (
        plan_id, entry_order_id, symbol, side, order_type, status,
        fill_price, fill_quantity, fees, fee_currency,
        broker, broker_order_id, bot_firmware, device_id, metadata_json, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.plan_id, r.entry_order_id ?? null, r.symbol, r.side, r.order_type, r.status,
      r.fill_price ?? null, r.fill_quantity ?? null,
      r.fees ?? null, r.fee_currency ?? null,
      r.broker, r.broker_order_id ?? null,
      r.bot_firmware ?? null, r.device_id ?? null,
      r.metadata ? JSON.stringify(r.metadata) : null,
      r.executed_at
    );
    return result.lastInsertRowid as number;
  }

  /** Protokolleintraege eines Plans, juengste zuerst. */
  getExecutionReports(planId: string, limit = 200): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT * FROM bot_execution_reports WHERE plan_id = ? ORDER BY executed_at DESC LIMIT ?`,
    ).all(planId, limit) as Array<Record<string, unknown>>;
  }

  /**
   * Protokolleintraege in der Reihenfolge des Geschehens.
   *
   * Sortiert nach `id`, nicht nach `executed_at`: Mehrere Ereignisse
   * desselben Durchlaufs tragen denselben Zeitstempel auf die
   * Millisekunde genau, und bei Gleichstand ist die Reihenfolge einer
   * Sortierung nach Zeit nicht bestimmt. Fuer einen Verlauf ist sie aber
   * genau das Entscheidende — "TP, dann Stop" heisst etwas anderes als
   * "Stop, dann TP".
   */
  getExecutionReportsChronologisch(planId: string, limit = 500): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT * FROM bot_execution_reports WHERE plan_id = ? ORDER BY id ASC LIMIT ?`,
    ).all(planId, limit) as Array<Record<string, unknown>>;
  }

  /** Protokoll ueber alle Plaene, fuer die Protokollansicht der Web-Oberflaeche. */
  getRecentExecutionReports(limit = 200, offset = 0): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT * FROM bot_execution_reports ORDER BY executed_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<Record<string, unknown>>;
  }

  // ============================================================
  // Eingangsbuch fuer externe Handelssignale
  // ============================================================

  /**
   * Haelt ein eingegangenes Signal fest — angenommenes wie abgelehntes.
   *
   * `signal_id` ist eindeutig indiziert. Das zweite Eintreffen desselben
   * Signals laeuft deshalb in einen Konflikt und wird verworfen statt
   * einen zweiten Trade zu erzeugen. Dieser Riegel haelt auch dann, wenn
   * zwei Anfragen gleichzeitig hereinkommen und das Gedaechtnis im
   * Arbeitsspeicher sie beide noch fuer neu haelt.
   *
   * Zurueck kommt `false`, wenn die Kennung schon bekannt war.
   */
  insertSignal(s: {
    id: string;
    signal_id: string;
    strategy: string;
    action: string;
    symbol: string;
    direction?: string | null;
    source_ip?: string | null;
    raw_payload: string;
    status: string;
    reason?: string | null;
    warnings?: string[];
    scaling?: unknown;
    created_plan_id?: string | null;
    matched_plan_ids?: string[];
    emitted_at?: string | null;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO signal_inbox (
          id, signal_id, strategy, action, symbol, direction, source_ip,
          raw_payload, status, reason, warnings_json, scaling_json,
          created_plan_id, matched_plan_ids, emitted_at, received_at, received_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(
        s.id, s.signal_id, s.strategy, s.action, s.symbol,
        s.direction ?? null, s.source_ip ?? null,
        s.raw_payload, s.status, s.reason ?? null,
        JSON.stringify(s.warnings ?? []),
        s.scaling ? JSON.stringify(s.scaling) : null,
        s.created_plan_id ?? null,
        JSON.stringify(s.matched_plan_ids ?? []),
        s.emitted_at ?? null,
        Date.now(),
      );
      return true;
    } catch (err) {
      const nachricht = err instanceof Error ? err.message : String(err);
      if (nachricht.includes('UNIQUE') && nachricht.includes('signal_id')) return false;
      throw err;
    }
  }

  getSignal(signalId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM signal_inbox WHERE signal_id = ?')
      .get(signalId) as Record<string, unknown> | undefined;
  }

  getSignals(filter?: {
    status?: string; action?: string; symbol?: string; strategy?: string; limit?: number;
  }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter?.action) { where.push('action = ?'); params.push(filter.action); }
    if (filter?.symbol) { where.push('symbol = ?'); params.push(filter.symbol); }
    if (filter?.strategy) { where.push('strategy = ?'); params.push(filter.strategy); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(filter?.limit ?? 100);
    return this.db.prepare(
      `SELECT * FROM signal_inbox ${whereSql} ORDER BY received_ms DESC LIMIT ?`,
    ).all(...params) as Array<Record<string, unknown>>;
  }

  /**
   * Offene Trigger-Signale, auf die sich ein wartender Plan berufen kann.
   *
   * Nur angenommene, noch nicht verbrauchte und nicht zu alte zaehlen:
   * Ein Trigger von gestern sagt ueber den heutigen Markt nichts aus.
   */
  getOffeneTriggerSignale(args: {
    strategy?: string; symbol?: string; tag?: string; nichtAelterAlsMs: number;
  }): Array<Record<string, unknown>> {
    const where = [
      "action = 'trigger'",
      "status = 'accepted'",
      'consumed = 0',
      'received_ms >= ?',
    ];
    const params: unknown[] = [Date.now() - args.nichtAelterAlsMs];

    if (args.strategy) { where.push('strategy = ?'); params.push(args.strategy); }
    if (args.symbol) { where.push('symbol = ?'); params.push(args.symbol); }

    const zeilen = this.db.prepare(
      `SELECT * FROM signal_inbox WHERE ${where.join(' AND ')} ORDER BY received_ms DESC`,
    ).all(...params) as Array<Record<string, unknown>>;

    if (!args.tag) return zeilen;

    // Die Marke steckt im urspruenglichen Datensatz, nicht in einer
    // eigenen Spalte — danach wird erst hier gefiltert.
    return zeilen.filter(z => {
      try {
        const roh = JSON.parse(z.raw_payload as string) as Record<string, unknown>;
        return roh.tag === args.tag;
      } catch {
        return false;
      }
    });
  }

  /**
   * Vermerkt einen Trigger als verbraucht.
   *
   * Nur die erste Abfrage bekommt `true`. Die Bedingung `consumed = 0`
   * steht im UPDATE selbst, damit zwei gleichzeitig laufende Plaene
   * denselben Trigger nicht beide fuer sich beanspruchen.
   */
  verbraucheTrigger(id: string): boolean {
    const ergebnis = this.db.prepare(
      "UPDATE signal_inbox SET consumed = 1, consumed_at = datetime('now') WHERE id = ? AND consumed = 0",
    ).run(id);
    return ergebnis.changes > 0;
  }

  /** Kennungen der letzten Zeit — fuer das Gedaechtnis nach einem Neustart. */
  getSignalKennungen(seitMs: number): Array<{ signalId: string; empfangenMs: number }> {
    const zeilen = this.db.prepare(
      'SELECT signal_id, received_ms FROM signal_inbox WHERE received_ms >= ?',
    ).all(seitMs) as Array<{ signal_id: string; received_ms: number }>;
    return zeilen.map(z => ({ signalId: z.signal_id, empfangenMs: z.received_ms }));
  }

  /** Entfernt alte Eintraege aus dem Eingangsbuch. */
  raeumeSignaleAuf(aelterAlsMs: number): number {
    const ergebnis = this.db.prepare('DELETE FROM signal_inbox WHERE received_ms < ?')
      .run(Date.now() - aelterAlsMs);
    return ergebnis.changes;
  }

  // ============================================================
  // Uebungskonto
  // ============================================================

  getPaperAccount(waehrung: string): {
    startkapital: number; realisiert: number; gebuehren: number;
    trades: number; gewinne: number; verluste: number;
    taker_satz: number; maker_satz: number;
  } | undefined {
    return this.db.prepare('SELECT * FROM paper_account WHERE waehrung = ?')
      .get(waehrung) as never;
  }

  /**
   * Schreibt den Kontostand fort.
   *
   * Wird nach jeder Buchung aufgerufen, nicht nur beim Herunterfahren:
   * Ein Absturz zwischen Trade und Speichern liesse den Bot sonst mit
   * einem Kontostand weiterrechnen, den es nicht mehr gibt.
   */
  upsertPaperAccount(k: {
    waehrung: string; startkapital: number; realisiert: number; gebuehren: number;
    trades: number; gewinne: number; verluste: number;
    taker_satz?: number; maker_satz?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO paper_account (
        waehrung, startkapital, realisiert, gebuehren, trades, gewinne, verluste,
        taker_satz, maker_satz, geaendert_am
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(waehrung) DO UPDATE SET
        startkapital = excluded.startkapital,
        realisiert   = excluded.realisiert,
        gebuehren    = excluded.gebuehren,
        trades       = excluded.trades,
        gewinne      = excluded.gewinne,
        verluste     = excluded.verluste,
        taker_satz   = excluded.taker_satz,
        maker_satz   = excluded.maker_satz,
        geaendert_am = datetime('now')
    `).run(
      k.waehrung, k.startkapital, k.realisiert, k.gebuehren,
      k.trades, k.gewinne, k.verluste,
      k.taker_satz ?? 0.0006, k.maker_satz ?? 0.0001,
    );
  }

  insertPaperLedger(b: {
    art: string; betrag: number; waehrung: string;
    symbol?: string | null; menge?: number | null; preis?: number | null;
    notiz?: string | null; zeitpunkt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO paper_ledger (art, betrag, waehrung, symbol, menge, preis, notiz, zeitpunkt, erstellt_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.art, b.betrag, b.waehrung,
      b.symbol ?? null, b.menge ?? null, b.preis ?? null,
      b.notiz ?? null, b.zeitpunkt, Date.now(),
    );
  }

  /**
   * Schreibt eine Buchung UND den daraus folgenden Kontostand — in
   * einem Zug oder gar nicht.
   *
   * Getrennt ausgefuehrt koennte das Kontoblatt eine Zeile bekommen,
   * die der gespeicherte Stand nicht kennt. Im laufenden Betrieb faellt
   * das nicht auf, weil das Konto im Arbeitsspeicher weiterrechnet —
   * erst nach einem Neustart laedt der Bot einen veralteten Stand und
   * rechnet von da an mit falschem Kapital.
   */
  schreibePaperBuchung(
    buchung: {
      art: string; betrag: number; waehrung: string;
      symbol?: string | null; menge?: number | null; preis?: number | null;
      notiz?: string | null; zeitpunkt: string;
    },
    konto: {
      waehrung: string; startkapital: number; realisiert: number; gebuehren: number;
      trades: number; gewinne: number; verluste: number;
      taker_satz?: number; maker_satz?: number;
    },
    positionen: Array<{ symbol: string; seite: string; menge: number; einstiegspreis: number; hebel: number }>,
  ): void {
    const alles = this.db.transaction(() => {
      this.insertPaperLedger(buchung);
      this.upsertPaperAccount(konto);
      this.setPaperPositionen(positionen);
    });
    alles();
  }

  getPaperLedger(limit = 100, art?: string): Array<Record<string, unknown>> {
    if (art) {
      return this.db.prepare(
        'SELECT * FROM paper_ledger WHERE art = ? ORDER BY erstellt_ms DESC, id DESC LIMIT ?',
      ).all(art, limit) as Array<Record<string, unknown>>;
    }
    return this.db.prepare(
      'SELECT * FROM paper_ledger ORDER BY erstellt_ms DESC, id DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>;
  }

  /** Leert das Kontoblatt — beim Zuruecksetzen des Uebungskontos. */
  clearPaperLedger(): void {
    this.db.exec('DELETE FROM paper_ledger');
  }

  getPaperPositionen(): Array<{
    symbol: string; seite: 'buy' | 'sell'; menge: number; einstiegspreis: number; hebel: number;
  }> {
    return this.db.prepare(
      'SELECT symbol, seite, menge, einstiegspreis, hebel FROM paper_position WHERE menge > 0',
    ).all() as never;
  }

  /**
   * Schreibt den Positionsbestand fort.
   *
   * Vollstaendig ersetzend statt einzeln nachgefuehrt: Eine geschlossene
   * Position muss verschwinden, und ein Rest, den ein vergessenes DELETE
   * stehen liesse, bliebe als gebundene Margin fuer immer haengen.
   */
  setPaperPositionen(positionen: Array<{
    symbol: string; seite: string; menge: number; einstiegspreis: number; hebel: number;
  }>): void {
    const ersetzen = this.db.transaction((liste: typeof positionen) => {
      this.db.prepare('DELETE FROM paper_position').run();
      const einfuegen = this.db.prepare(`
        INSERT INTO paper_position (symbol, seite, menge, einstiegspreis, hebel, geaendert_am)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const p of liste) {
        if (p.menge > 0) einfuegen.run(p.symbol, p.seite, p.menge, p.einstiegspreis, p.hebel);
      }
    });
    ersetzen(positionen);
  }

  // ============================================================
  // Rueckkanal an TC-Synaptrix
  // ============================================================
  //
  // Die Warteschlange liegt HIER und nicht im Arbeitsspeicher. Sonst
  // gingen genau die Ereignisse verloren, die waehrend einer Stoerung
  // anfielen — und zwar unbemerkt: Ein fehlendes Ereignis ist von einem
  // nie entstandenen nicht zu unterscheiden.

  /**
   * Die Signalkennung von TC-Synaptrix zu einem unserer Plaene.
   *
   * `null` heisst: Der Plan stammt nicht aus einem Signal (von Hand
   * angelegt, aus dem Journal gespiegelt). Solche Plaene gehoeren nicht
   * in den Rueckkanal — die Gegenstelle kennt sie nicht, und ein Ereignis
   * ohne Gegenstueck erzeugte dort einen Datensatz, der nie zugeordnet
   * wird.
   */
  getSignalKennungZuPlan(planId: string): string | null {
    const zeile = this.db.prepare(
      `SELECT signal_id FROM signal_inbox
        WHERE created_plan_id = ?
          AND status = 'accepted'
        ORDER BY received_at DESC
        LIMIT 1`,
    ).get(planId) as { signal_id?: string } | undefined;
    return zeile?.signal_id ?? null;
  }

  rueckkanalEinreihen(ereignis: Record<string, unknown>): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO tc_rueckkanal_queue (ereignis_id, ereignis_json)
       VALUES (?, ?)`,
    ).run(String(ereignis['ereignis_id']), JSON.stringify(ereignis));
  }

  /**
   * Was noch zu senden ist — aelteste zuerst.
   *
   * Aufgegebene bleiben STEHEN (`versuche >= hoechstversuche`), statt
   * geloescht zu werden: Die Zahl der Aufgegebenen ist die Antwort auf
   * "warum fehlt drueben etwas?", und geloescht gaebe es sie nicht.
   */
  rueckkanalOffene(
    grenze: number,
    hoechstversuche: number,
  ): Array<{ id: number; ereignis: unknown }> {
    const zeilen = this.db.prepare(
      `SELECT id, ereignis_json FROM tc_rueckkanal_queue
        WHERE gesendet_am IS NULL
          AND versuche < ?
        ORDER BY id
        LIMIT ?`,
    ).all(hoechstversuche, grenze) as Array<{ id: number; ereignis_json: string }>;

    return zeilen.map((z) => ({ id: z.id, ereignis: JSON.parse(z.ereignis_json) as unknown }));
  }

  rueckkanalErledigen(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE tc_rueckkanal_queue SET gesendet_am = datetime('now'), letzter_fehler = NULL
        WHERE id = ?`,
    );
    this.db.transaction((liste: number[]) => { for (const id of liste) stmt.run(id); })(ids);
  }

  /**
   * Fehlversuch festhalten.
   *
   * `endgueltig` setzt die Versuchszahl sofort ans Limit: Bei HTTP 400
   * oder 401 wird der zweite Versuch genauso scheitern wie der erste
   * (fehlerhafter Aufbau bleibt fehlerhaft, falsches Token bleibt
   * falsch), und eine Sendung, die nie durchgeht, blockierte sonst alles
   * dahinter.
   */
  rueckkanalFehlschlag(ids: number[], fehler: string, endgueltig: boolean): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE tc_rueckkanal_queue
          SET versuche = CASE WHEN ? = 1 THEN 9999 ELSE versuche + 1 END,
              letzter_fehler = ?,
              letzter_versuch_am = datetime('now')
        WHERE id = ?`,
    );
    this.db.transaction((liste: number[]) => {
      for (const id of liste) stmt.run(endgueltig ? 1 : 0, fehler, id);
    })(ids);
  }

  /** Netzfehler: alles Offene bekommt einen Versuch angerechnet. */
  rueckkanalFehlschlagAlle(fehler: string): void {
    this.db.prepare(
      `UPDATE tc_rueckkanal_queue
          SET versuche = versuche + 1, letzter_fehler = ?,
              letzter_versuch_am = datetime('now')
        WHERE gesendet_am IS NULL`,
    ).run(fehler);
  }

  rueckkanalZustand(hoechstversuche: number): {
    offen: number; aufgegeben: number; aeltestesIso: string | null;
  } {
    const z = this.db.prepare(
      `SELECT
         SUM(CASE WHEN gesendet_am IS NULL AND versuche <  ? THEN 1 ELSE 0 END) AS offen,
         SUM(CASE WHEN gesendet_am IS NULL AND versuche >= ? THEN 1 ELSE 0 END) AS aufgegeben,
         MIN(CASE WHEN gesendet_am IS NULL THEN angelegt_am END)                AS aeltestes
       FROM tc_rueckkanal_queue`,
    ).get(hoechstversuche, hoechstversuche) as {
      offen: number | null; aufgegeben: number | null; aeltestes: string | null;
    };
    return { offen: z.offen ?? 0, aufgegeben: z.aufgegeben ?? 0, aeltestesIso: z.aeltestes };
  }

  /**
   * Aufgegebene Ereignisse zurueck in die Warteschlange holen.
   *
   * **Nur solche mit einem behebbaren Fehler.** Ein 400 (Aufbau falsch)
   * oder 401 (Token falsch) wird beim einundzwanzigsten Versuch genauso
   * scheitern wie beim ersten; die bleiben liegen, sonst entstuende eine
   * Endlosschleife.
   *
   * Ein 500 oder ein Timeout ist etwas anderes: Dort liegt die Ursache
   * beim Empfaenger und kann behoben sein. Genau so war es am
   * 26.10.2026 — der Fremdschluessel auf `boerse` kannte den
   * Uebungsbroker nicht, 29 Ereignisse liefen in die Versuchsgrenze, und
   * nach dem Eintragen eines einzigen Stammdatensatzes waeren sie alle
   * durchgegangen. Ohne diese Funktion haette sie niemand je wieder
   * angefasst: dauerhaft verlorene Messdaten wegen eines behobenen
   * Fehlers.
   */
  rueckkanalWiederaufnehmen(hoechstversuche: number): number {
    const ergebnis = this.db.prepare(
      `UPDATE tc_rueckkanal_queue
          SET versuche = 0, letzter_fehler = NULL
        WHERE gesendet_am IS NULL
          AND versuche >= ?
          AND (letzter_fehler IS NULL
               OR letzter_fehler NOT LIKE 'HTTP 4%')`,
    ).run(hoechstversuche);
    return ergebnis.changes;
  }

  /** Gesendetes aufraeumen — der Vorrat waechst sonst unbegrenzt. */
  rueckkanalAufraeumen(aelterAlsTage: number): number {
    const ergebnis = this.db.prepare(
      `DELETE FROM tc_rueckkanal_queue
        WHERE gesendet_am IS NOT NULL
          AND gesendet_am < datetime('now', ?)`,
    ).run(`-${Math.max(1, Math.trunc(aelterAlsTage))} days`);
    return ergebnis.changes;
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
