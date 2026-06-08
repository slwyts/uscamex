/**
 * OperatorDO: the stateful core. Replaces the Rust run_forever() loop + runtime.rs orchestration.
 *
 * Owns ProtocolState + ExecutionJournal (serialized DO storage). Mirrors events/blocks/config/node
 * history to D1. The scan loop runs on a self-rescheduling alarm; cron triggers the scheduled ticks.
 */
import { DurableObject } from "cloudflare:workers";
import { BscTransactionClient, type ChainExecutionContext } from "./chain";
import { defaultProtocolConfig, type ProtocolConfig } from "./config";
import { Engine } from "./engine";
import { loadSettings, type Env, type OperatorSettings } from "./env";
import { ExecutionJournal } from "./journal";
import {
  classifySystemLog,
  decodeProtocolLog,
  type RawLog,
  type SystemEvent,
} from "./indexer";
import { BscRpcClient } from "./rpc";
import {
  OperatorService,
  type ChainClient,
  type ServiceDatabase,
} from "./service";
import {
  deserializeState,
  ProtocolState,
  serializeState,
  type SerializedState,
  type UserAccount,
} from "./state";
import { D1Storage } from "./storage";

const SECS_PER_DAY = 86_400n;
const UTC8_OFFSET_SECS = 8n * 3600n;
const SCAN_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

/** In-memory event cache backing the synchronous OperatorService.database. Flushed to D1 by the DO. */
class EventCache implements ServiceDatabase {
  known = new Set<string>();
  pending: { id: string; event: import("./indexer").IndexedEvent }[] = [];

  constructor(known: Set<string>) {
    this.known = known;
  }

  containsEvent(id: string): boolean {
    return this.known.has(id);
  }
  insertEvent(event: import("./indexer").IndexedEvent): void {
    this.known.add(event.event.id);
    this.pending.push({ id: event.event.id, event });
  }
}

export class OperatorDO extends DurableObject<Env> {
  private settings!: OperatorSettings;
  private engine!: Engine;
  private state!: ProtocolState;
  private journal!: ExecutionJournal;
  private ready = false;
  private scanFailures = 0;
  private vaultAddress: string | null = null;
  private rootInitialized = false;
  private lastSettlementSlot: string | null = null;
  private lastDeflationSlot: string | null = null;
  private lastBuybackSlot: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.settings = loadSettings(env);
      this.engine = new Engine(await this.loadConfig());
      this.state = await this.loadState();
      this.journal = await this.loadJournal();
      this.lastSettlementSlot = (await this.ctx.storage.get<string>("slot:settlement")) ?? null;
      this.lastDeflationSlot = (await this.ctx.storage.get<string>("slot:deflation")) ?? null;
      this.lastBuybackSlot = (await this.ctx.storage.get<string>("slot:buyback")) ?? null;
      this.vaultAddress = (await this.ctx.storage.get<string>("vault")) ?? null;
      this.ready = true;
    });
  }

  // ---- persistence ----
  private async loadConfig(): Promise<ProtocolConfig> {
    const raw = await this.ctx.storage.get<string>("config");
    if (!raw) return defaultProtocolConfig();
    return reviveConfig(JSON.parse(raw));
  }
  private async loadState(): Promise<ProtocolState> {
    const raw = await this.ctx.storage.get<SerializedState>("state");
    return raw ? deserializeState(raw) : new ProtocolState(this.settings.tokenAddress);
  }
  private async loadJournal(): Promise<ExecutionJournal> {
    const raw = await this.ctx.storage.get<{ records: never[] }>("journal");
    return raw ? ExecutionJournal.fromJSON(raw) : new ExecutionJournal();
  }
  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", serializeState(this.state));
    await this.ctx.storage.put("journal", this.journal.toJSON());
    await this.ctx.storage.put(
      "config",
      JSON.stringify(this.engine.config, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  }

  private newService(cache: EventCache): OperatorService {
    const chain = this.newChain();
    return new OperatorService(this.engine, this.state, this.journal, cache, chain, () => this.persist());
  }

  private newChain(): ChainClient {
    const ctx: ChainExecutionContext = {
      tokenAddress: this.settings.tokenAddress,
      vaultAddress: this.vaultAddress ?? this.settings.tokenAddress,
      routerAddress: this.settings.pancakeV2Router,
      ownerAddress: this.state.root,
      burnAddress: this.settings.burnAddress,
      slippageBps: this.settings.executorSlippageBps,
      deadlineSeconds: this.settings.transactionDeadlineSeconds,
    };
    const client = new BscTransactionClient(
      this.settings.rpcUrl,
      this.settings.chainId,
      this.settings.operatorPrivateKey,
      ctx,
      this.settings.confirmations,
      this.settings.ammFeeBps,
    );
    return {
      submit: (command) => client.submit(command),
      findConfirmedCommand: (id, command) => client.findConfirmedCommand(id, command),
      afterConfirmed: async (id, command, txHash) => {
        if (command.kind !== "DepositBatch") return;
        const appliedKey = `lp-minted:${id}`;
        if (await this.ctx.storage.get(appliedKey)) return;
        const lpMinted = await client.depositBatchLpMinted(txHash, command);
        if (command.lpBnb !== 0n && lpMinted === 0n) throw new Error("deposit batch LP mint event missing");
        if (lpMinted === 0n) return;
        this.state.ensureUserMut(command.user).lpTokenPrincipal += lpMinted;
        await this.ctx.storage.put(appliedKey, lpMinted.toString());
      },
    };
  }

  // ---- public RPC (called from Worker) ----

  async ensureRunning(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  /** Scan tick. Port of runtime.rs scan_confirmed_logs_once + run_forever loop body. */
  async alarm(): Promise<void> {
    let nextDelay = SCAN_INTERVAL_MS;
    try {
      await this.scanOnce();
      this.scanFailures = 0;
    } catch (err) {
      this.scanFailures = Math.min(this.scanFailures + 1, 5);
      console.error(`operator scan failed (consecutive=${this.scanFailures}):`, err);
      const factor = 1 << Math.min(Math.max(this.scanFailures - 1, 0), 4);
      nextDelay = Math.min(SCAN_INTERVAL_MS * factor, MAX_BACKOFF_MS);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + nextDelay);
    }
  }

  /** Cron-driven scheduled ticks. Port of runtime.rs run_scheduled_ticks. */
  async runScheduledTicks(): Promise<void> {
    const cache = new EventCache(this.state.processedEvents);
    const service = this.newService(cache);
    const now = BigInt(Math.floor(Date.now() / 1000));

    const periodsPerDay = BigInt(Math.max(1, this.engine.config.settlementPeriodsPerDay));
    const periodSecs = SECS_PER_DAY / periodsPerDay;
    const settlementSlot = formatSettlementSlot(now, periodSecs, periodsPerDay);
    if (this.lastSettlementSlot !== settlementSlot) {
      service.tickSettlements(settlementSlot);
      this.lastSettlementSlot = settlementSlot;
      await this.ctx.storage.put("slot:settlement", settlementSlot);
    }

    const deflationSlot = formatHourSlot(now);
    if (this.lastDeflationSlot !== deflationSlot) {
      service.tickDeflation(now / SECS_PER_DAY, deflationSlot);
      this.lastDeflationSlot = deflationSlot;
      await this.ctx.storage.put("slot:deflation", deflationSlot);
    }

    const buybackSlot = formatMinuteSlot(now);
    if (this.lastBuybackSlot !== buybackSlot) {
      service.tickBuyback(buybackSlot);
      this.lastBuybackSlot = buybackSlot;
      await this.ctx.storage.put("slot:buyback", buybackSlot);
    }

    await this.persist();
    try {
      await service.submitPending();
    } catch (err) {
      console.error("scheduled submit_pending failed:", err);
    }
    await this.persist();
  }

  // ---- scan implementation ----
  private async scanOnce(): Promise<void> {
    const rpc = new BscRpcClient(this.settings.rpcUrl, this.settings.tokenAddress);
    const storage = new D1Storage(this.env.DB);

    await this.ensureRoot(rpc);

    const chainHead = await rpc.blockNumber();
    const safeHead = chainHead - BigInt(this.settings.confirmations);
    if (safeHead < 0n) return;

    const last = await storage.lastIndexedBlock();
    const fromBlock = last ? last.number + 1n : this.settings.indexerStartBlock;
    if (fromBlock > safeHead) return;

    // periodic resyncs (config/nodes/reserves/vault) every scan — cheap enough at cron cadence
    await this.syncProtocolConfig(rpc);
    await this.syncNodes(rpc, storage);
    await this.syncPairReserves(rpc);
    await this.syncBuilderTokenBalance(rpc);
    await this.syncVaultBalance(rpc);

    const maxScan = this.settings.rpcMaxBlocksPerScan;
    const toBlock = bigMin(fromBlock + (maxScan - 1n), safeHead);
    const toHash = await rpc.blockHash(toBlock);

    if (last && last.number === toBlock && last.hash !== toHash) {
      throw new Error(`ReorgDetected at ${toBlock}: ${last.hash} != ${toHash}`);
    }

    const logs = await rpc.protocolLogs(fromBlock, toBlock);

    // mirror system events (config/node updates) to D1 + refresh nodes
    const systemEvents: SystemEvent[] = [];
    for (const log of logs) {
      const sys = classifySystemLog(log);
      if (sys) systemEvents.push(sys);
    }
    await this.applySystemEvents(rpc, storage, systemEvents);

    // process business logs through the service (engine + journal)
    const cache = new EventCache(this.state.processedEvents);
    const service = this.newService(cache);
    for (const log of logs) {
      if (last && last.number === log.blockNumber && last.hash !== log.blockHash) {
        throw new Error(`ReorgDetected at ${log.blockNumber}`);
      }
      const indexed = decodeProtocolLog(log);
      if (!indexed) continue;
      service.processEvent(indexed);
    }

    // flush newly indexed events to D1, then record the block
    for (const { event } of cache.pending) await storage.insertEvent(event);
    await storage.recordBlock({ number: toBlock, hash: toHash });

    await this.persist();
    try {
      await service.submitPending();
    } catch (err) {
      console.error("scan submit_pending failed:", err);
    }
    await this.persist();
  }

  private async syncProtocolConfig(rpc: BscRpcClient): Promise<void> {
    const chainConfig = await rpc.protocolConfig();
    this.engine.config = chainConfig.config;
  }

  /**
   * The protocol root is the on-chain owner() (Rust main.rs seeds ProtocolState with owner).
   * Resolve it once and, if state is still empty (fresh DO created with a placeholder root),
   * rebuild state around the correct root before any events are processed.
   */
  private async ensureRoot(rpc: BscRpcClient): Promise<void> {
    if (this.rootInitialized) return;
    const owner = (await rpc.owner()).toLowerCase();
    if (owner !== this.state.root && this.state.users.size <= 1 && this.state.processedEvents.size === 0) {
      const rebuilt = new ProtocolState(owner);
      rebuilt.nodes = this.state.nodes;
      rebuilt.pair = this.state.pair;
      rebuilt.balances = this.state.balances;
      this.state = rebuilt;
      await this.ctx.storage.put("state", serializeState(this.state));
    }
    this.rootInitialized = true;
  }
  private async syncNodes(rpc: BscRpcClient, _storage: D1Storage): Promise<void> {
    this.state.nodes = await rpc.nodes();
  }
  private async syncPairReserves(rpc: BscRpcClient): Promise<void> {
    const reserves = await rpc.pairReserves();
    if (!reserves) return;
    this.state.pair.tokenReserve = reserves.tokenReserve;
    this.state.pair.bnbReserve = reserves.bnbReserve;
  }
  private async syncBuilderTokenBalance(rpc: BscRpcClient): Promise<void> {
    this.state.balances.builderTokenAmount = await rpc.tokenBalance(this.settings.tokenAddress);
  }
  private async syncVaultBalance(rpc: BscRpcClient): Promise<void> {
    const vault = await rpc.vault();
    if (vault !== this.vaultAddress) {
      this.vaultAddress = vault;
      await this.ctx.storage.put("vault", vault);
    }
    this.state.balances.vaultBnb = await rpc.nativeBalance(vault);
  }

  private async applySystemEvents(
    rpc: BscRpcClient,
    storage: D1Storage,
    events: SystemEvent[],
  ): Promise<void> {
    let changed = 0;
    for (const event of events) {
      if (event.kind === "ProtocolConfigUpdated") {
        const chainConfig = await rpc.protocolConfig();
        const updatedBy = `chain-event:${event.txHash}`;
        if (
          await storage.recordProtocolConfig(
            chainConfig.config,
            updatedBy,
            event.blockNumber,
            event.txHash,
          )
        ) {
          changed += 1;
        }
        this.engine.config = chainConfig.config;
      } else {
        const updatedBy = `chain-event:${event.txHash}`;
        if (
          await storage.recordNodeUpdate(
            event.node,
            event.weight,
            updatedBy,
            event.blockNumber,
            event.txHash,
          )
        ) {
          changed += 1;
        }
      }
    }
    if (changed > 0) {
      this.state.nodes = await rpc.nodes();
    }
  }

  // ---- admin query RPC (read-only) ----
  async getState(): Promise<SerializedState> {
    return serializeState(this.state);
  }
  async getJournal(): Promise<unknown> {
    return this.journal.toJSON();
  }
  async getConfig(): Promise<unknown> {
    return JSON.parse(
      JSON.stringify(this.engine.config, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  }
  async getOverview(): Promise<unknown> {
    return {
      ready: this.ready,
      root: this.state.root,
      users: this.state.users.size,
      nodes: this.state.nodes.length,
      pendingCommands: this.journal.pendingCommands().length,
      confirmedCommands: this.journal.confirmedCount(),
    };
  }

  // ---- admin query shapes (match Token/admin/src/utils/api.ts) ----

  private nodeWeightMap(): Map<string, number> {
    const m = new Map<string, number>();
    for (const n of this.state.nodes) m.set(n.address, n.weight);
    return m;
  }

  private userSummary(address: string, nodes: Map<string, number>): unknown {
    const u = this.state.user(address);
    const weight = nodes.get(address) ?? null;
    return {
      address,
      referrer: u?.referrer && u.referrer !== address ? u.referrer : null,
      direct_count: u?.directCount ?? 0,
      position_id: Number(u?.positionId ?? 0n),
      principal_bnb: (u?.principalBnb ?? 0n).toString(),
      static_paid_bnb: (u?.staticPaidBnb ?? 0n).toString(),
      dynamic_paid_bnb: (u?.dynamicPaidBnb ?? 0n).toString(),
      lp_token_principal: (u?.lpTokenPrincipal ?? 0n).toString(),
      active: u?.active ?? false,
      exited: u?.exited ?? false,
      is_node: weight != null,
      node_weight: weight,
      node_paid_bnb: (this.state.balances.nodePaidBnb.get(address) ?? 0n).toString(),
      direct_paid_bnb: (this.state.balances.directPaidBnb.get(address) ?? 0n).toString(),
    };
  }

  async queryStats(): Promise<unknown> {
    await this.syncBuilderTokenBalance(new BscRpcClient(this.settings.rpcUrl, this.settings.tokenAddress)).catch(
      () => undefined,
    );
    let bound = 0;
    let active = 0;
    let exited = 0;
    let totalPrincipal = 0n;
    let totalStatic = 0n;
    let totalDynamic = 0n;
    for (const [addr, u] of this.state.users) {
      if (this.state.isBound(addr)) bound += 1;
      if (u.active) active += 1;
      if (u.exited) exited += 1;
      totalPrincipal += u.principalBnb;
      totalStatic += u.staticPaidBnb;
      totalDynamic += u.dynamicPaidBnb;
    }
    const counts = this.statusCounts();
    const lastBlock = await new D1Storage(this.env.DB).lastIndexedBlock();
    return {
      chain_id: this.settings.chainId,
      token_address: this.settings.tokenAddress,
      root: this.state.root,
      current_day: Number(this.state.currentDay),
      deflation_used_bps: this.state.deflationUsedBps,
      total_users: this.state.users.size,
      bound_users: bound,
      active_users: active,
      exited_users: exited,
      nodes_count: this.state.nodes.length,
      total_principal_bnb: totalPrincipal.toString(),
      total_static_paid_bnb: totalStatic.toString(),
      total_dynamic_paid_bnb: totalDynamic.toString(),
      burned_tokens: this.state.balances.burnedTokens.toString(),
      tax_burned_token_value_bnb: this.state.balances.taxBurnedTokenValueBnb.toString(),
      vault_bnb: this.state.balances.vaultBnb.toString(),
      owner_bnb: this.state.balances.ownerBnb.toString(),
      builder_token_value_bnb: this.state.balances.builderTokenValueBnb.toString(),
      builder_token_amount: this.state.balances.builderTokenAmount.toString(),
      pair_token_reserve: this.state.pair.tokenReserve.toString(),
      pair_bnb_reserve: this.state.pair.bnbReserve.toString(),
      last_indexed_block: lastBlock ? Number(lastBlock.number) : null,
      processed_events: this.state.processedEvents.size,
      processed_settlements: this.state.processedSettlements.size,
      pending_commands: counts.pending,
      submitted_commands: counts.submitted,
      confirmed_commands: counts.confirmed,
      failed_commands: counts.failed,
      protocol_config_initialized: true,
    };
  }

  private statusCounts(): { pending: number; submitted: number; confirmed: number; failed: number } {
    const counts = { pending: 0, submitted: 0, confirmed: 0, failed: 0 };
    for (const r of this.journal.records.values()) {
      counts[r.status.state.toLowerCase() as keyof typeof counts] += 1;
    }
    return counts;
  }

  async queryUser(address: string): Promise<unknown> {
    const nodes = this.nodeWeightMap();
    const u = this.state.user(address);
    const referrer = u?.referrer && u.referrer !== address ? u.referrer : null;
    const directMembers = [...this.state.users.entries()]
      .filter(([, acct]) => acct.referrer === address && acct.referrer !== undefined)
      .map(([addr]) => addr)
      .filter((addr) => addr !== address)
      .sort()
      .map((addr) => this.userSummary(addr, nodes));
    return {
      summary: this.userSummary(address, nodes),
      referrer_summary: referrer ? this.userSummary(referrer, nodes) : null,
      direct_members: directMembers,
    };
  }

  async queryUsers(limit: number, offset: number, sort: string, filter: string): Promise<unknown> {
    const nodes = this.nodeWeightMap();
    let addrs = [...this.state.users.keys()];
    addrs = addrs.filter((a) => {
      const u = this.state.user(a)!;
      switch (filter) {
        case "active":
          return u.active;
        case "exited":
          return u.exited;
        case "bound":
          return this.state.isBound(a);
        default:
          return true;
      }
    });
    const valueOf = (a: string): bigint | number | string => {
      const u = this.state.user(a)!;
      switch (sort) {
        case "principal":
          return u.principalBnb;
        case "static":
          return u.staticPaidBnb;
        case "dynamic":
          return u.dynamicPaidBnb;
        case "direct":
          return u.directCount;
        default:
          return a;
      }
    };
    addrs.sort((l, r) => {
      const vl = valueOf(l);
      const vr = valueOf(r);
      if (typeof vl === "string" || typeof vr === "string") return l < r ? -1 : l > r ? 1 : 0;
      // descending for numeric sorts
      return vl < vr ? 1 : vl > vr ? -1 : l < r ? -1 : 1;
    });
    const total = addrs.length;
    const items = addrs.slice(offset, offset + limit).map((a) => this.userSummary(a, nodes));
    return { total, limit, offset, items };
  }

  async queryTeam(address: string, depth: number): Promise<unknown> {
    const nodes = this.nodeWeightMap();
    const childrenOf = (addr: string): string[] =>
      [...this.state.users.entries()]
        .filter(([k, acct]) => acct.referrer === addr && k !== addr)
        .map(([k]) => k)
        .sort();

    const root = this.userSummary(address, nodes);
    const directMembers = childrenOf(address).map((a) => this.userSummary(a, nodes));

    const generations: { generation: number; count: number; members: unknown[] }[] = [];
    let frontier = childrenOf(address);
    let total = 0;
    for (let gen = 1; gen <= depth && frontier.length > 0; gen++) {
      const members = frontier.map((a) => this.userSummary(a, nodes));
      generations.push({ generation: gen, count: frontier.length, members });
      total += frontier.length;
      const next: string[] = [];
      for (const a of frontier) next.push(...childrenOf(a));
      frontier = next;
    }
    return {
      root,
      direct_members: directMembers,
      generations,
      total_descendants: total,
      truncated_at_depth: depth,
    };
  }

  async queryNodes(): Promise<unknown> {
    let totalPaid = 0n;
    const items = this.state.nodes.map((n) => {
      const paid = this.state.balances.nodePaidBnb.get(n.address) ?? 0n;
      totalPaid += paid;
      return { address: n.address, weight: n.weight, paid_bnb: paid.toString() };
    });
    return { items, total_paid_bnb: totalPaid.toString() };
  }

  async queryPositions(limit: number, offset: number, sort: string, filter: string): Promise<unknown> {
    let entries = [...this.state.users.entries()].filter(([, u]) => u.principalBnb > 0n || u.exited);
    entries = entries.filter(([, u]) => {
      switch (filter) {
        case "active":
          return u.active;
        case "exited":
          return u.exited;
        default:
          return true;
      }
    });
    const valueOf = ([addr, u]: [string, UserAccount]): bigint | string => {
      switch (sort) {
        case "principal":
          return u.principalBnb;
        case "static":
          return u.staticPaidBnb;
        case "dynamic":
          return u.dynamicPaidBnb;
        default:
          return addr;
      }
    };
    entries.sort((l, r) => {
      const vl = valueOf(l);
      const vr = valueOf(r);
      if (typeof vl === "string" || typeof vr === "string")
        return l[0] < r[0] ? -1 : l[0] > r[0] ? 1 : 0;
      return vl < vr ? 1 : vl > vr ? -1 : l[0] < r[0] ? -1 : 1;
    });
    const total = entries.length;
    const items = entries.slice(offset, offset + limit).map(([addr, u]) => ({
      user: addr,
      position_id: Number(u.positionId),
      principal_bnb: u.principalBnb.toString(),
      static_paid_bnb: u.staticPaidBnb.toString(),
      dynamic_paid_bnb: u.dynamicPaidBnb.toString(),
      lp_token_principal: u.lpTokenPrincipal.toString(),
      active: u.active,
      exited: u.exited,
    }));
    return { total, limit, offset, items };
  }

  async queryJournalList(limit: number, offset: number, status: string): Promise<unknown> {
    const all = [...this.journal.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const mapStatus = (s: import("./journal").CommandStatus) => s.state.toLowerCase();
    const filtered =
      status === "all" ? all : all.filter((r) => mapStatus(r.status) === status.toLowerCase());
    const counts = this.statusCounts();
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit).map((r) => ({
      id: r.id,
      // id = "{batchKey}:{index}:{commandKind}"; batchKey itself contains colons
      // (e.g. "deposit:0xtx:0"), so the command kind is the last segment.
      kind: r.id.split(":").pop() ?? r.id,
      status: mapStatus(r.status),
      tx_hash:
        r.status.state === "Submitted" || r.status.state === "Confirmed" ? r.status.txHash : null,
      error: r.status.state === "Failed" ? r.status.error : null,
      attempts: r.attempts,
      payload: serializeCommandForApi(r.command),
    }));
    return { total, limit, offset, items, counts };
  }

  /**
   * Manually re-arm Failed commands and submit them immediately.
   * Unlike the automatic retryFailed (which is capped at MAX_ATTEMPTS), this resets the
   * attempt counter to 0 so commands that exhausted their retries (e.g. while buying was
   * disabled on-chain) can be driven again once the underlying condition is fixed.
   * Pass specific ids to retry a subset; omit to retry every Failed command.
   */
  async retryFailedCommands(ids?: string[]): Promise<{ retried: number; tx_hashes: string[] }> {
    const want = ids && ids.length > 0 ? new Set(ids) : null;
    let retried = 0;
    for (const r of this.journal.records.values()) {
      if (r.status.state !== "Failed") continue;
      if (want && !want.has(r.id)) continue;
      r.attempts = 0;
      r.status = { state: "Pending" };
      retried += 1;
    }
    if (retried === 0) return { retried: 0, tx_hashes: [] };

    await this.persist();
    const cache = new EventCache(this.state.processedEvents);
    const service = this.newService(cache);
    let txHashes: string[] = [];
    try {
      txHashes = await service.submitPending();
    } catch (err) {
      console.error("retryFailedCommands submit failed:", err);
    }
    await this.persist();
    return { retried, tx_hashes: txHashes };
  }
}

// ---- slot formatting (runtime.rs:345-391) ----

function formatSettlementSlot(nowUnix: bigint, periodSecs: bigint, periodsPerDay: bigint): string {
  const ps = periodSecs < 1n ? 1n : periodSecs;
  const shifted = nowUnix + UTC8_OFFSET_SECS;
  const slotStart = (shifted / ps) * ps;
  const [y, mo, d, h] = unixToYmdh(slotStart);
  const minute = (slotStart / 60n) % 60n;
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(minute, 2)}+08/${periodsPerDay}`;
}
function formatHourSlot(nowUnix: bigint): string {
  const slotStart = (nowUnix / 3600n) * 3600n;
  const [y, mo, d, h] = unixToYmdh(slotStart);
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}Z`;
}
function formatMinuteSlot(nowUnix: bigint): string {
  const slotStart = (nowUnix / 60n) * 60n;
  const [y, mo, d, h] = unixToYmdh(slotStart);
  const minute = (slotStart / 60n) % 60n;
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(minute, 2)}Z`;
}

/** Howard Hinnant civil-from-days (runtime.rs:371). */
function unixToYmdh(timestamp: bigint): [bigint, bigint, bigint, bigint] {
  const days = timestamp / SECS_PER_DAY;
  const secondsOfDay = timestamp % SECS_PER_DAY;
  const hour = secondsOfDay / 3600n;
  const z = days + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const year = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp < 10n ? mp + 3n : mp - 9n;
  const finalYear = month <= 2n ? year + 1n : year;
  return [finalYear, month, day, hour];
}

function pad(value: bigint, width: number): string {
  return value.toString().padStart(width, "0");
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function serializeCommandForApi(command: import("./executor").OperatorCommand): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(command)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

function reviveConfig(raw: Record<string, unknown>): ProtocolConfig {
  const base = defaultProtocolConfig();
  const out = { ...base } as unknown as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof baseRecord[k] === "bigint" && typeof v === "string") {
      out[k] = BigInt(v);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as ProtocolConfig;
}
