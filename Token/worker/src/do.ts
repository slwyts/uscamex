/**
 * OperatorDO: the stateful core. Replaces the Rust run_forever() loop + runtime.rs orchestration.
 *
 * Owns ProtocolState + ExecutionJournal (serialized DO storage). Mirrors events/blocks/config/node
 * history to D1. The scan loop runs on a self-rescheduling alarm; cron triggers the scheduled ticks.
 */
import { DurableObject } from "cloudflare:workers";
import { BscTransactionClient, type ChainExecutionContext } from "./chain";
import { bps, defaultProtocolConfig, type ProtocolConfig } from "./config";
import { Engine } from "./engine";
import type { OperatorCommand } from "./executor";
import { loadSettings, type Env, type OperatorSettings } from "./env";
import {
  ExecutionJournal,
  type CommandRecord,
  type SerializedCommandRecord,
} from "./journal";
import {
  classifySystemLog,
  decodeProtocolLog,
  type RawLog,
  type SystemEvent,
} from "./indexer";
import { BscRpcClient } from "./rpc";
import {
  type BeforeCommandSubmit,
  depositAllocationFromCommand,
  OperatorService,
  type ChainClient,
  type FixedSettlementPayment,
  type ServiceDatabase,
} from "./service";
import {
  deserializeState,
  ProtocolState,
  rebuildInvestedDirectCounts,
  serializeState,
  serializeStateForStorage,
  type SerializedState,
  type UserAccount,
} from "./state";
import { D1Storage } from "./storage";

const SECS_PER_DAY = 86_400n;
const UTC8_OFFSET_SECS = 8n * 3600n;
const SCAN_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const SUBMIT_LOCK_KEY = "lock:submit-pending";
const SUBMIT_LOCK_TTL_MS = 15 * 60 * 1000;
const SLOT_CLAIM_TTL_MS = 2 * 60 * 1000;
const DEFLATION_SYNC_LOOKBACK_BLOCKS = 40_000n;
const JOURNAL_LEGACY_KEY = "journal";
const JOURNAL_CHUNK_INDEX_KEY = "journal:chunks";
const JOURNAL_CHUNK_PREFIX = "journal:chunk:";
const JOURNAL_CHUNK_RECORDS = 250;
const STATE_SET_CHUNK_MAX_BYTES = 96 * 1024;

type StateSetName = "processed-events" | "processed-settlements" | "applied-deposit-batches";

interface StateSetLayout {
  name: StateSetName;
  indexKey: string;
  chunkPrefix: string;
  chunkKeys: string[];
  chunkIds: Map<string, string[]>;
  persistedIds: Set<string>;
}

interface PreparedStateSetWrites {
  writes: Record<string, unknown>;
  commit: () => void;
}

interface SubmitLock {
  owner: string;
  reason: string;
  expiresAt: number;
}

interface SlotClaim {
  slot: string;
  status: "pending" | "completed";
  owner: string;
  expiresAt: number;
}

interface ClaimedSlot {
  key: string;
  slot: string;
  owner: string;
}

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
  private lastTaxSweepSlot: string | null = null;
  private lastBuybackSlot: string | null = null;
  private stateHadAppliedDepositBatches = false;
  private storedEventsReconciled = false;
  private confirmedDepositCommandsReconciled = false;
  private disabled = false;
  private instanceName: string | null = null;
  private instanceTokenAddress: string | null = null;
  private journalChunkKeys: string[] = [];
  private journalChunkRecordIds = new Map<string, string[]>();
  private journalChunkByRecord = new Map<string, string>();
  private journalIndexDirty = false;
  private journalNeedsLegacyDelete = false;
  private stateSetLayouts = new Map<StateSetName, StateSetLayout>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.settings = loadSettings(env);
      this.engine = new Engine(await this.loadConfig());
      this.state = await this.loadState();
      this.journal = await this.loadJournal();
      await this.loadStateSetChunks();
      this.backfillLegacyAppliedDepositBatches();
      this.lastSettlementSlot = slotValue(await this.ctx.storage.get("slot:settlement"));
      this.lastDeflationSlot = slotValue(await this.ctx.storage.get("slot:deflation"));
      this.lastTaxSweepSlot = slotValue(await this.ctx.storage.get("slot:tax-sweep"));
      this.lastBuybackSlot = slotValue(await this.ctx.storage.get("slot:buyback"));
      this.vaultAddress = (await this.ctx.storage.get<string>("vault")) ?? null;
      this.disabled = (await this.ctx.storage.get<boolean>("disabled")) ?? false;
      this.instanceName = (await this.ctx.storage.get<string>("instance:name")) ?? null;
      this.instanceTokenAddress = (await this.ctx.storage.get<string>("instance:token")) ?? null;
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
    this.stateHadAppliedDepositBatches = raw?.appliedDepositBatches != null;
    return raw ? deserializeState(raw) : new ProtocolState(this.settings.tokenAddress);
  }
  private async loadJournal(): Promise<ExecutionJournal> {
    this.journalChunkKeys = [];
    this.journalChunkRecordIds.clear();
    this.journalChunkByRecord.clear();
    this.journalIndexDirty = false;
    this.journalNeedsLegacyDelete = false;

    const chunkKeys = await this.ctx.storage.get<string[]>(JOURNAL_CHUNK_INDEX_KEY);
    if (chunkKeys && chunkKeys.length > 0) {
      const records: SerializedCommandRecord[] = [];
      this.journalChunkKeys = [...chunkKeys];
      for (let offset = 0; offset < chunkKeys.length; offset += 128) {
        const keyBatch = chunkKeys.slice(offset, offset + 128);
        const chunks = await this.ctx.storage.get<{ records: SerializedCommandRecord[] }>(keyBatch);
        for (const key of keyBatch) {
          const chunk = chunks.get(key);
          if (!chunk) throw new Error(`missing journal chunk ${key}`);
          const ids = chunk.records.map((record) => record.id);
          this.journalChunkRecordIds.set(key, ids);
          for (const id of ids) this.journalChunkByRecord.set(id, key);
          records.push(...chunk.records);
        }
      }
      return ExecutionJournal.fromJSON({ records });
    }
    const raw = await this.ctx.storage.get<{ records: SerializedCommandRecord[] }>(JOURNAL_LEGACY_KEY);
    if (!raw) return new ExecutionJournal();

    const journal = ExecutionJournal.fromJSON(raw);
    journal.markAllDirty();
    this.journalNeedsLegacyDelete = true;
    return journal;
  }

  private async loadStateSetChunks(): Promise<void> {
    this.stateSetLayouts.clear();
    for (const name of stateSetNames()) {
      const indexKey = `state:set:${name}:chunks`;
      const chunkPrefix = `state:set:${name}:chunk:`;
      const chunkKeys = (await this.ctx.storage.get<string[]>(indexKey)) ?? [];
      const layout: StateSetLayout = {
        name,
        indexKey,
        chunkPrefix,
        chunkKeys: [...chunkKeys],
        chunkIds: new Map(),
        persistedIds: new Set(),
      };
      const target = this.stateSet(name);
      for (let offset = 0; offset < chunkKeys.length; offset += 128) {
        const keyBatch = chunkKeys.slice(offset, offset + 128);
        const chunks = await this.ctx.storage.get<{ ids: string[] }>(keyBatch);
        for (const key of keyBatch) {
          const chunk = chunks.get(key);
          if (!chunk) throw new Error(`missing state-set chunk ${key}`);
          const ids = [...chunk.ids];
          layout.chunkIds.set(key, ids);
          for (const id of ids) {
            layout.persistedIds.add(id);
            target.add(id);
          }
        }
      }
      this.stateSetLayouts.set(name, layout);
    }
  }

  private stateSet(name: StateSetName): Set<string> {
    switch (name) {
      case "processed-events":
        return this.state.processedEvents;
      case "processed-settlements":
        return this.state.processedSettlements;
      case "applied-deposit-batches":
        return this.state.appliedDepositBatches;
    }
  }

  private async persist(completedSlots: ClaimedSlot[] = []): Promise<void> {
    const dirtyIds = this.journal.dirtyRecordIds();
    const { writes: journalWrites, indexChanged } = this.prepareJournalWrites(dirtyIds);
    const stateSetWrites = this.prepareStateSetWrites();
    const writes: Record<string, unknown> = {
      state: serializeStateForStorage(this.state),
      config: JSON.stringify(this.engine.config, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ...journalWrites,
      ...stateSetWrites.writes,
    };
    if (indexChanged) writes[JOURNAL_CHUNK_INDEX_KEY] = [...this.journalChunkKeys];
    for (const claim of completedSlots) {
      writes[claim.key] = {
        slot: claim.slot,
        status: "completed",
        owner: claim.owner,
        expiresAt: 0,
      } satisfies SlotClaim;
    }

    await this.ctx.storage.transaction(async (txn) => {
      const entries = Object.entries(writes);
      for (let offset = 0; offset < entries.length; offset += 128) {
        await txn.put(Object.fromEntries(entries.slice(offset, offset + 128)));
      }
      if (this.journalNeedsLegacyDelete) await txn.delete(JOURNAL_LEGACY_KEY);
    });

    this.journal.markPersisted(dirtyIds);
    stateSetWrites.commit();
    this.journalIndexDirty = false;
    this.journalNeedsLegacyDelete = false;
  }

  private prepareJournalWrites(
    dirtyIds: string[],
  ): { writes: Record<string, unknown>; indexChanged: boolean } {
    const dirtyChunks = new Set<string>();
    for (const id of dirtyIds) {
      let key = this.journalChunkByRecord.get(id);
      if (!key) {
        key = this.journalChunkKeys[this.journalChunkKeys.length - 1];
        let ids = key ? this.journalChunkRecordIds.get(key) : undefined;
        if (!key || !ids || ids.length >= JOURNAL_CHUNK_RECORDS) {
          key = `${JOURNAL_CHUNK_PREFIX}${this.journalChunkKeys.length.toString().padStart(5, "0")}`;
          ids = [];
          this.journalChunkKeys.push(key);
          this.journalChunkRecordIds.set(key, ids);
          this.journalIndexDirty = true;
        }
        ids.push(id);
        this.journalChunkByRecord.set(id, key);
      }
      dirtyChunks.add(key);
    }

    const writes: Record<string, unknown> = {};
    for (const key of dirtyChunks) {
      const ids = this.journalChunkRecordIds.get(key);
      if (!ids) throw new Error(`missing journal chunk layout ${key}`);
      writes[key] = { records: this.journal.serializedRecords(ids) };
    }
    return { writes, indexChanged: this.journalIndexDirty };
  }

  private prepareStateSetWrites(): PreparedStateSetWrites {
    const writes: Record<string, unknown> = {};
    const commits: (() => void)[] = [];

    for (const name of stateSetNames()) {
      const layout = this.stateSetLayouts.get(name);
      if (!layout) throw new Error(`missing state-set layout ${name}`);
      const stateSet = this.stateSet(name);
      const nextChunkKeys = [...layout.chunkKeys];
      const nextChunkIds = new Map(layout.chunkIds);
      const nextPersistedIds = new Set(layout.persistedIds);
      const dirtyChunkKeys = new Set<string>();

      // Recovery can explicitly forget processed events. Keep the chunks in
      // sync so a restart cannot bring a forgotten id back into memory.
      for (const [key, ids] of nextChunkIds) {
        const retainedIds = ids.filter((id) => stateSet.has(id));
        if (retainedIds.length === ids.length) continue;
        nextChunkIds.set(key, retainedIds);
        for (const id of ids) {
          if (!stateSet.has(id)) nextPersistedIds.delete(id);
        }
        dirtyChunkKeys.add(key);
      }

      for (const id of stateSet) {
        if (nextPersistedIds.has(id)) continue;
        let key = nextChunkKeys[nextChunkKeys.length - 1];
        let ids = key ? nextChunkIds.get(key) : undefined;
        if (!key || !ids || serializedStateSetChunkSize([...ids, id]) > STATE_SET_CHUNK_MAX_BYTES) {
          key = `${layout.chunkPrefix}${nextChunkKeys.length.toString().padStart(5, "0")}`;
          ids = [];
          nextChunkKeys.push(key);
          nextChunkIds.set(key, ids);
        } else if (!dirtyChunkKeys.has(key)) {
          ids = [...ids];
          nextChunkIds.set(key, ids);
        }
        ids.push(id);
        nextPersistedIds.add(id);
        dirtyChunkKeys.add(key);
      }

      for (const key of dirtyChunkKeys) {
        const ids = nextChunkIds.get(key);
        if (!ids) throw new Error(`missing staged state-set chunk ${key}`);
        writes[key] = { ids };
      }
      if (nextChunkKeys.length !== layout.chunkKeys.length) writes[layout.indexKey] = nextChunkKeys;
      commits.push(() => {
        layout.chunkKeys = nextChunkKeys;
        layout.chunkIds = nextChunkIds;
        layout.persistedIds = nextPersistedIds;
      });
    }

    return { writes, commit: () => commits.forEach((commit) => commit()) };
  }

  private async reloadCoreState(): Promise<void> {
    this.engine = new Engine(await this.loadConfig());
    this.state = await this.loadState();
    this.journal = await this.loadJournal();
    await this.loadStateSetChunks();
    this.backfillLegacyAppliedDepositBatches();
  }

  private async claimSlots(requested: { key: string; slot: string }[]): Promise<ClaimedSlot[]> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const claimed: ClaimedSlot[] = [];
      for (const request of requested) {
        const current = await txn.get<string | SlotClaim>(request.key);
        if (typeof current === "string" && current === request.slot) continue;
        if (isSlotClaim(current) && current.slot === request.slot) {
          if (current.status === "completed") continue;
          if (current.expiresAt > now) continue;
        }
        if (isSlotClaim(current) && current.status === "pending" && current.expiresAt > now) continue;
        const slot =
          isSlotClaim(current) && current.status === "pending" && current.expiresAt <= now
            ? current.slot
            : request.slot;
        const owner = crypto.randomUUID();
        const claim: SlotClaim = {
          slot,
          status: "pending",
          owner,
          expiresAt: now + SLOT_CLAIM_TTL_MS,
        };
        await txn.put(request.key, claim);
        claimed.push({ key: request.key, slot, owner });
      }
      return claimed;
    });
  }

  private async releaseSlotClaims(claims: ClaimedSlot[]): Promise<void> {
    if (claims.length === 0) return;
    await this.ctx.storage.transaction(async (txn) => {
      for (const claim of claims) {
        const current = await txn.get<SlotClaim>(claim.key);
        if (
          isSlotClaim(current) &&
          current.status === "pending" &&
          current.slot === claim.slot &&
          current.owner === claim.owner
        ) {
          await txn.put(claim.key, { ...current, expiresAt: 0 });
        }
      }
    });
  }

  private async acquireSubmitLock(reason: string): Promise<string | null> {
    const owner = `${Date.now()}:${crypto.randomUUID()}:${reason}`;
    const now = Date.now();
    const lock: SubmitLock = { owner, reason, expiresAt: now + SUBMIT_LOCK_TTL_MS };
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<SubmitLock>(SUBMIT_LOCK_KEY);
      if (existing && existing.expiresAt > now) return null;
      await txn.put(SUBMIT_LOCK_KEY, lock);
      return owner;
    });
  }

  private async releaseSubmitLock(owner: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<SubmitLock>(SUBMIT_LOCK_KEY);
      if (existing?.owner === owner) await txn.delete(SUBMIT_LOCK_KEY);
    });
  }

  /**
   * Extend the submission lease while and only while this runner still owns it.
   * A full settlement contains hundreds of transactions and routinely takes
   * longer than SUBMIT_LOCK_TTL_MS. Without renewal, a second request can take
   * the expired lock while the first request continues draining its stale
   * pending snapshot, paying the same rewards twice.
   */
  private async renewSubmitLock(owner: string): Promise<boolean> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<SubmitLock>(SUBMIT_LOCK_KEY);
      if (existing?.owner !== owner) return false;
      await txn.put(SUBMIT_LOCK_KEY, {
        ...existing,
        expiresAt: now + SUBMIT_LOCK_TTL_MS,
      });
      return true;
    });
  }

  private async assertAndRenewSubmitLock(owner: string): Promise<void> {
    if (!(await this.renewSubmitLock(owner))) {
      throw new Error(`submission lease lost: ${owner}`);
    }
  }

  private async submitPendingLocked(reason: string): Promise<string[]> {
    if (!this.journal.hasSubmitWork()) return [];
    const lockOwner = await this.acquireSubmitLock(reason);
    if (!lockOwner) {
      console.warn(`submitPending skipped; another runner holds ${SUBMIT_LOCK_KEY} (${reason})`);
      return [];
    }
    try {
      // A deploy can leave two isolates briefly alive. Always reload before
      // submitting so a stale isolate cannot send a command already confirmed by
      // the isolate that acquired the lock first.
      await this.reloadCoreState();
      if (!this.journal.hasSubmitWork()) return [];
      const service = this.newService(
        new EventCache(this.state.processedEvents),
        async () => this.assertAndRenewSubmitLock(lockOwner),
      );
      const txHashes = await service.submitPending();
      await this.persist();
      return txHashes;
    } finally {
      await this.releaseSubmitLock(lockOwner);
    }
  }

  private backfillLegacyAppliedDepositBatches(): void {
    if (this.stateHadAppliedDepositBatches) return;
    for (const record of this.journal.records.values()) {
      if (record.command.kind === "DepositBatch") this.state.appliedDepositBatches.add(record.id);
    }
  }

  private newService(cache: EventCache, beforeCommandSubmit?: BeforeCommandSubmit): OperatorService {
    const chain = this.newChain();
    return new OperatorService(
      this.engine,
      this.state,
      this.journal,
      cache,
      chain,
      () => this.persist(),
      beforeCommandSubmit,
    );
  }

  private chainContext(): ChainExecutionContext {
    return {
      tokenAddress: this.settings.tokenAddress,
      vaultAddress: this.vaultAddress ?? this.settings.tokenAddress,
      routerAddress: this.settings.pancakeV2Router,
      ownerAddress: this.state.root,
      burnAddress: this.settings.burnAddress,
      indexerStartBlock: this.settings.indexerStartBlock,
      slippageBps: this.settings.executorSlippageBps,
      deadlineSeconds: this.settings.transactionDeadlineSeconds,
    };
  }

  private newTransactionClient(): BscTransactionClient {
    return new BscTransactionClient(
      this.settings.rpcUrl,
      this.settings.chainId,
      this.settings.operatorPrivateKey,
      this.chainContext(),
      this.settings.confirmations,
      this.settings.ammFeeBps,
    );
  }

  private newChain(): ChainClient {
    const client = this.newTransactionClient();
    return {
      submit: (command) => client.submit(command),
      findConfirmedCommand: (id, command, anchorTxHash) => client.findConfirmedCommand(id, command, anchorTxHash),
      afterConfirmed: async (id, command, txHash) => {
        if (command.kind === "RedeemUserLp") {
          const executed = await client.redeemExecution(txHash, command);
          if (!executed) throw new Error("LP redemption execution event missing");
          return;
        }
        if (command.kind !== "DepositBatch") return;
        if (this.state.appliedDepositBatches.has(id)) return;
        const executed = await client.depositBatchExecution(txHash, command);
        if (!executed) throw new Error("deposit batch execution event missing");
        if (command.lpBnb !== 0n && executed.lpMinted === 0n) throw new Error("deposit batch LP mint event missing");
        const nodeBnb = command.nodePayouts.reduce((sum, payout) => sum + payout.amount, 0n);
        if (executed.nodeBnb !== nodeBnb) throw new Error("deposit batch node payout mismatch");
        const actualCommand = {
          ...command,
          lpBnb: executed.lpBnb,
          lpTokenValueBnb: executed.lpTokenValueBnb,
          builderBnb: executed.builderBnb,
          vaultBnb: executed.vaultBnb,
          directReferrer: executed.directReferrer,
          directBnb: executed.directBnb,
        };
        const record = this.journal.records.get(id);
        if (record?.command.kind === "DepositBatch") {
          record.command = actualCommand;
          this.journal.touch(id);
        }
        this.engine.applyDeposit(
          this.state,
          depositAllocationFromCommand(actualCommand),
        );
        this.state.ensureUserMut(command.user).lpTokenPrincipal += executed.lpMinted;
        this.state.appliedDepositBatches.add(id);
      },
    };
  }

  // ---- public RPC (called from Worker) ----

  private activeInstanceName(): string {
    return `operator:${this.settings.tokenAddress.toLowerCase()}`;
  }

  private async disableStaleInstance(reason: string): Promise<void> {
    this.disabled = true;
    await this.ctx.storage.put("disabled", true);
    await this.ctx.storage.put("disabledReason", reason);
    await this.ctx.storage.deleteAlarm();
    console.error(`disabled stale OperatorDO: ${reason}`);
  }

  private async canRunScheduledWork(): Promise<boolean> {
    if (this.disabled) return false;
    const expectedName = this.activeInstanceName();
    const expectedToken = this.settings.tokenAddress.toLowerCase();
    if (!this.instanceName || !this.instanceTokenAddress) {
      // This instance predates the active-instance registration guard. Do not
      // mutate chain state from an unregistered alarm; the active Worker stub will
      // register and re-arm the current instance on the next fetch/cron tick.
      await this.ctx.storage.deleteAlarm();
      return false;
    }
    if (this.instanceName !== expectedName || this.instanceTokenAddress !== expectedToken) {
      await this.disableStaleInstance(
        `registered=${this.instanceName}/${this.instanceTokenAddress}, expected=${expectedName}/${expectedToken}`,
      );
      return false;
    }
    return true;
  }

  async ensureRunning(instanceName?: string): Promise<void> {
    if (this.disabled) return;
    const expectedName = this.activeInstanceName();
    if (instanceName !== expectedName) {
      await this.disableStaleInstance(`ensureRunning(${instanceName ?? "missing"}) expected ${expectedName}`);
      return;
    }
    this.instanceName = instanceName;
    this.instanceTokenAddress = this.settings.tokenAddress.toLowerCase();
    await this.ctx.storage.put("instance:name", this.instanceName);
    await this.ctx.storage.put("instance:token", this.instanceTokenAddress);
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async stopRunning(): Promise<{ disabled: boolean; clearedAlarm: boolean; records: number }> {
    this.disabled = true;
    await this.ctx.storage.put("disabled", true);
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null) await this.ctx.storage.deleteAlarm();
    return { disabled: true, clearedAlarm: existing != null, records: this.journal.records.size };
  }

  /** Scan tick. Port of runtime.rs scan_confirmed_logs_once + run_forever loop body. */
  async alarm(): Promise<void> {
    if (!(await this.canRunScheduledWork())) return;
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
      if (this.disabled) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(Date.now() + nextDelay);
      }
    }
  }

  /** Cron-driven scheduled ticks. Port of runtime.rs run_scheduled_ticks. */
  async runScheduledTicks(): Promise<void> {
    if (!(await this.canRunScheduledWork())) return;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const rpc = new BscRpcClient(this.settings.rpcUrl, this.settings.tokenAddress);
    let canDeflate = false;
    await this.syncDeflationUsageFromChain(rpc, now).then(() => {
      canDeflate = true;
    }).catch((err) => {
      console.error("sync deflation usage failed:", err);
    });
    let canBuyback = false;
    try {
      await this.syncVaultBalance(rpc);
      canBuyback = true;
    } catch (err) {
      console.error("sync vault before buyback failed:", err);
    }

    const cache = new EventCache(this.state.processedEvents);
    const service = this.newService(cache);

    const periodsPerDay = BigInt(Math.max(1, this.engine.config.settlementPeriodsPerDay));
    const periodSecs = SECS_PER_DAY / periodsPerDay;
    const settlementSlot = formatSettlementSlot(now, periodSecs, periodsPerDay);
    const deflationSlot = formatHourSlot(now);
    const taxSweepSlot = formatMinuteSlot(now);
    const buybackSlot = formatMinuteSlot(now);

    const requestedSlots = [
      { key: "slot:settlement", slot: settlementSlot },
      { key: "slot:tax-sweep", slot: taxSweepSlot },
    ];
    if (canDeflate) requestedSlots.push({ key: "slot:deflation", slot: deflationSlot });
    if (canBuyback) requestedSlots.push({ key: "slot:buyback", slot: buybackSlot });
    const claims = await this.claimSlots(requestedSlots);
    const claimsByKey = new Map(claims.map((claim) => [claim.key, claim]));

    try {
      const settlementClaim = claimsByKey.get("slot:settlement");
      const deflationClaim = claimsByKey.get("slot:deflation");
      const taxSweepClaim = claimsByKey.get("slot:tax-sweep");
      const buybackClaim = claimsByKey.get("slot:buyback");
      if (settlementClaim) service.tickSettlements(settlementClaim.slot);
      if (deflationClaim) service.tickDeflation(now / SECS_PER_DAY, deflationClaim.slot);
      if (taxSweepClaim) service.tickTaxSweep(taxSweepClaim.slot);
      if (buybackClaim && canBuyback) service.tickBuyback(buybackClaim.slot);
      await this.persist(claims);
    } catch (err) {
      await this.releaseSlotClaims(claims).catch((releaseErr) => {
        console.error("release scheduled slot claims failed:", releaseErr);
      });
      await this.reloadCoreState().catch((reloadErr) => {
        console.error("reload after scheduled tick failure failed:", reloadErr);
      });
      throw err;
    }

    this.lastSettlementSlot = claimsByKey.get("slot:settlement")?.slot ?? this.lastSettlementSlot;
    this.lastDeflationSlot = claimsByKey.get("slot:deflation")?.slot ?? this.lastDeflationSlot;
    this.lastTaxSweepSlot = claimsByKey.get("slot:tax-sweep")?.slot ?? this.lastTaxSweepSlot;
    this.lastBuybackSlot = claimsByKey.get("slot:buyback")?.slot ?? this.lastBuybackSlot;
    try {
      await this.submitPendingLocked("scheduled");
    } catch (err) {
      console.error("scheduled submit_pending failed:", err);
    }
  }

  // ---- scan implementation ----
  private async scanOnce(): Promise<void> {
    const rpc = new BscRpcClient(this.settings.rpcUrl, this.settings.tokenAddress);
    const storage = new D1Storage(this.env.DB, this.settings.tokenAddress);

    await this.ensureRoot(rpc);
    await this.reconcileStoredEvents(storage);
    await this.reconcileConfirmedDepositCommands();

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
    let hadProcessingFailure = false;
    const eventsToMirror: import("./indexer").IndexedEvent[] = [];
    for (const log of logs) {
      if (last && last.number === log.blockNumber && last.hash !== log.blockHash) {
        throw new Error(`ReorgDetected at ${log.blockNumber}`);
      }
      const indexed = decodeProtocolLog(log);
      if (!indexed) continue;
      try {
        service.processEvent(indexed);
        eventsToMirror.push(indexed);
      } catch (err) {
        // A single bad event must NOT abort the whole batch. Log it, keep
        // processing the rest, and remember that this range is not fully done so
        // we do NOT advance the indexed-block cursor past an unprocessed event.
        hadProcessingFailure = true;
        console.error(`processEvent failed for ${indexed.event.kind} ${indexed.event.id}:`, err);
      }
    }

    // Persist DO state/journal before advancing the D1 cursor. If DO storage has a
    // transient failure, replaying this range is safe; advancing D1 first can skip
    // a deposit forever after an eviction.
    await this.persist();

    // Mirror all successfully processed (including duplicate) events to D1. This
    // repairs the opposite split-brain case where DO state persisted but D1 history
    // did not; INSERT OR IGNORE keeps the retry idempotent.
    for (const event of eventsToMirror) await storage.insertEvent(event);
    if (!hadProcessingFailure) {
      await storage.recordBlock({ number: toBlock, hash: toHash });
    }

    try {
      await this.submitPendingLocked("scan");
    } catch (err) {
      console.error("scan submit_pending failed:", err);
    }
  }

  private async reconcileStoredEvents(storage: D1Storage): Promise<void> {
    if (this.storedEventsReconciled) return;

    const last = await storage.lastIndexedBlock();
    if (!last) {
      this.storedEventsReconciled = true;
      return;
    }

    const cache = new EventCache(this.state.processedEvents);
    const service = this.newService(cache);
    let replayed = 0;
    const pageSize = 500;

    for (let offset = 0; ; offset += pageSize) {
      const events = await storage.storedEvents(this.settings.indexerStartBlock, last.number, pageSize, offset);
      if (events.length === 0) break;
      for (const event of events) {
        if (this.state.processedEvents.has(event.event.id)) continue;
        try {
          service.processEvent(event);
          replayed += 1;
        } catch (err) {
          throw new Error(`replay stored event ${event.event.id} failed: ${(err as Error).message}`);
        }
      }
      if (events.length < pageSize) break;
    }

    this.storedEventsReconciled = true;
    if (replayed === 0) return;

    console.warn(`replayed ${replayed} stored chain_events into DO state`);
    await this.persist();
    try {
      await this.submitPendingLocked("reconcile");
    } catch (err) {
      console.error("reconcile submit_pending failed:", err);
    }
  }

  private async reconcileConfirmedDepositCommands(): Promise<void> {
    if (this.confirmedDepositCommandsReconciled) return;
    this.confirmedDepositCommandsReconciled = true;

    const client = this.newTransactionClient();
    let changed = 0;
    for (const record of this.journal.records.values()) {
      if (record.command.kind !== "DepositBatch") continue;
      if (record.status.state !== "Confirmed" || !record.status.txHash) continue;
      const executed = await client.depositBatchExecution(record.status.txHash, record.command).catch(() => null);
      if (!executed) continue;
      const actualCommand = {
        ...record.command,
        lpBnb: executed.lpBnb,
        lpTokenValueBnb: executed.lpTokenValueBnb,
        builderBnb: executed.builderBnb,
        vaultBnb: executed.vaultBnb,
        directReferrer: executed.directReferrer,
        directBnb: executed.directBnb,
      };
      if (
        record.command.lpBnb !== actualCommand.lpBnb ||
        record.command.lpTokenValueBnb !== actualCommand.lpTokenValueBnb ||
        record.command.builderBnb !== actualCommand.builderBnb ||
        record.command.vaultBnb !== actualCommand.vaultBnb ||
        record.command.directReferrer !== actualCommand.directReferrer ||
        record.command.directBnb !== actualCommand.directBnb
      ) {
        record.command = actualCommand;
        this.journal.touch(record.id);
        changed += 1;
      }
    }

    if (changed !== 0) await this.persist();
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
      rebuilt.pendingTaxSweep = this.state.pendingTaxSweep;
      this.state = rebuilt;
      await this.ctx.storage.put("state", serializeStateForStorage(this.state));
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
  private async syncDeflationUsageFromChain(rpc: BscRpcClient, now: bigint): Promise<void> {
    const currentDay = now / SECS_PER_DAY;
    if (currentDay !== this.state.currentDay) {
      this.state.currentDay = currentDay;
      this.state.deflationUsedBps = 0;
    }

    const head = await rpc.blockNumber();
    const fromBlock =
      head > DEFLATION_SYNC_LOOKBACK_BLOCKS
        ? bigMax(this.settings.indexerStartBlock, head - DEFLATION_SYNC_LOOKBACK_BLOCKS)
        : this.settings.indexerStartBlock;
    const dayStart = currentDay * SECS_PER_DAY;
    const dayEnd = dayStart + SECS_PER_DAY;
    const logs = await rpc.pairTokensPulledLogs(fromBlock, head);
    let actualUsedBps = 0;
    for (const log of logs) {
      if (log.bps === 0 || log.blockTimestamp == null) continue;
      if (log.blockTimestamp < dayStart || log.blockTimestamp >= dayEnd) continue;
      actualUsedBps += log.bps;
    }
    if (actualUsedBps > this.state.deflationUsedBps) {
      this.state.deflationUsedBps = actualUsedBps;
    }
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
    rebuildInvestedDirectCounts(this.state);
    return serializeState(this.state);
  }

  /**
   * Recovery tool: forget one or more processed event ids so they can be replayed,
   * and rewind the D1 block cursor so the indexer re-pulls their range. Used to
   * repair state when a DO storage reset left an event marked processed without its
   * side effects applied. All on-chain actions are idempotent, so replay is safe.
   */
  async forgetEvents(eventIds: string[], rewindToBlock: number): Promise<{ forgotten: number }> {
    let forgotten = 0;
    for (const id of eventIds) {
      if (this.state.processedEvents.delete(id)) forgotten += 1;
    }
    await this.persist();
    await this.env.DB.prepare("DELETE FROM chain_blocks WHERE block_number >= ?")
      .bind(rewindToBlock)
      .run();
    return { forgotten };
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
    rebuildInvestedDirectCounts(this.state);
    return {
      ready: this.ready,
      root: this.state.root,
      users: this.state.users.size,
      nodes: this.state.nodes.length,
      pendingCommands: this.journal.pendingCommands().length,
      confirmedCommands: this.journal.confirmedCount(),
      instanceName: this.instanceName,
      activeInstanceName: this.activeInstanceName(),
      disabled: this.disabled,
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
      invested_direct_count: u?.investedDirectCount ?? 0,
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
    rebuildInvestedDirectCounts(this.state);
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
    const lastBlock = await new D1Storage(this.env.DB, this.settings.tokenAddress).lastIndexedBlock();
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
    rebuildInvestedDirectCounts(this.state);
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
    rebuildInvestedDirectCounts(this.state);
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
    let subordinatePrincipalBnb = 0n;
    for (let gen = 1; gen <= depth && frontier.length > 0; gen++) {
      const members = frontier.map((a) => this.userSummary(a, nodes));
      generations.push({ generation: gen, count: frontier.length, members });
      total += frontier.length;
      for (const a of frontier) subordinatePrincipalBnb += this.state.user(a)?.principalBnb ?? 0n;
      const next: string[] = [];
      for (const a of frontier) next.push(...childrenOf(a));
      frontier = next;
    }
    return {
      root,
      direct_members: directMembers,
      generations,
      total_descendants: total,
      subordinate_principal_bnb: subordinatePrincipalBnb.toString(),
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
    const eventSortKeys = await this.journalEventSortKeys([...this.journal.records.values()]);
    const all = [...this.journal.records.values()].sort((a, b) => compareJournalRecordsNewestFirst(a, b, eventSortKeys));
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

  private async journalEventSortKeys(records: CommandRecord[]): Promise<Map<string, JournalEventSortKey>> {
    const ids = [...new Set(records.map((record) => eventIdFromJournalId(record.id)).filter((id): id is string => id != null))];
    const keys = new Map<string, JournalEventSortKey>();
    if (ids.length === 0) return keys;

    const chunkSize = 100;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const { results } = await this.env.DB
        .prepare(
          `SELECT id, block_number, log_index, created_at
             FROM chain_events
            WHERE id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ id: string; block_number: number; log_index: number; created_at: string }>();
      for (const row of results) {
        keys.set(row.id.toLowerCase(), {
          blockNumber: BigInt(row.block_number),
          logIndex: row.log_index,
          timestampMs: parseSqliteUtcMs(row.created_at),
        });
      }
    }
    return keys;
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
      this.journal.touch(r.id);
      retried += 1;
    }
    if (retried === 0) return { retried: 0, tx_hashes: [] };

    await this.persist();
    let txHashes: string[] = [];
    try {
      txHashes = await this.submitPendingLocked("retry-failed");
    } catch (err) {
      console.error("retryFailedCommands submit failed:", err);
    }
    return { retried, tx_hashes: txHashes };
  }

  async backfillMissingSettlementSlot(
    slot: string,
    referenceBefore: string,
    referenceAfter: string,
    submit = false,
  ): Promise<{
    reference_users: number;
    backfilled_settlements: number;
    skipped_inactive: number;
    planned_commands: number;
    tx_hashes: string[];
  }> {
    const targetMs = parseSlotMs(slot);
    const beforeMs = parseSlotMs(referenceBefore);
    const afterMs = parseSlotMs(referenceAfter);
    if (targetMs == null || beforeMs == null || afterMs == null || !(beforeMs < targetMs && targetMs < afterMs)) {
      throw new Error("invalid settlement slot/reference order");
    }

    const before = this.fixedSettlementBatches(referenceBefore);
    const after = this.fixedSettlementBatches(referenceAfter);
    if (before.size === 0 || after.size === 0) throw new Error("reference settlement slot is empty");
    if (before.size !== after.size) throw new Error("reference settlement user sets differ");

    for (const [user, payments] of before) {
      const comparison = after.get(user);
      if (!comparison || fixedPaymentsFingerprint(payments) !== fixedPaymentsFingerprint(comparison)) {
        throw new Error(`reference settlement mismatch for ${user}`);
      }
    }

    const users = [...before.keys()].sort((left, right) => {
      const depthDelta = staticReferralDepth(this.state, left) - staticReferralDepth(this.state, right);
      return depthDelta !== 0 ? depthDelta : left < right ? -1 : left > right ? 1 : 0;
    });
    const service = this.newService(new EventCache(this.state.processedEvents));
    let backfilledSettlements = 0;
    let skippedInactive = 0;
    let plannedCommands = 0;

    for (const user of users) {
      const batchKey = `static:${user}:${slot}`;
      if (this.state.processedSettlements.has(batchKey)) continue;
      if (this.journalHasBatch(batchKey)) {
        throw new Error(`target settlement has journal without state marker: ${batchKey}`);
      }
      const account = this.state.user(user);
      if (!account || !account.active || account.principalBnb === 0n) {
        skippedInactive += 1;
        continue;
      }
      const commands = service.settleFixedOnce(user, slot, before.get(user)!);
      if (!commands) continue;
      backfilledSettlements += 1;
      plannedCommands += commands.length;
    }

    if (plannedCommands === 0) {
      return {
        reference_users: users.length,
        backfilled_settlements: 0,
        skipped_inactive: skippedInactive,
        planned_commands: 0,
        tx_hashes: [],
      };
    }

    await this.persist();
    let txHashes: string[] = [];
    if (submit) {
      try {
        txHashes = await this.submitPendingLocked("backfill-missing-settlement");
      } catch (err) {
        console.error("backfillMissingSettlementSlot submit failed:", err);
      }
    }
    return {
      reference_users: users.length,
      backfilled_settlements: backfilledSettlements,
      skipped_inactive: skippedInactive,
      planned_commands: plannedCommands,
      tx_hashes: txHashes,
    };
  }

  async backfillMissingDeflationSlots(
    slots: string[],
    submit = false,
  ): Promise<{ requested: number; planned: number; skipped: string[]; tx_hashes: string[] }> {
    const uniqueSlots = [...new Set(slots)].sort();
    if (uniqueSlots.length === 0) throw new Error("at least one deflation slot is required");
    for (const slot of uniqueSlots) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}Z$/.test(slot)) throw new Error(`invalid deflation slot: ${slot}`);
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const rpc = new BscRpcClient(this.settings.rpcUrl, this.settings.tokenAddress);
    await this.syncDeflationUsageFromChain(rpc, now);
    await this.syncPairReserves(rpc);
    const service = this.newService(new EventCache(this.state.processedEvents));
    let planned = 0;
    const skipped: string[] = [];
    for (const slot of uniqueSlots) {
      if (this.journalHasBatch(`deflation:${slot}`)) {
        skipped.push(slot);
        continue;
      }
      if (service.tickDeflation(now / SECS_PER_DAY, slot) == null) {
        skipped.push(slot);
        continue;
      }
      planned += 1;
    }

    if (planned === 0) return { requested: uniqueSlots.length, planned: 0, skipped, tx_hashes: [] };
    await this.persist();
    let txHashes: string[] = [];
    if (submit) {
      try {
        txHashes = await this.submitPendingLocked("backfill-missing-deflation");
      } catch (err) {
        console.error("backfillMissingDeflationSlots submit failed:", err);
      }
    }
    return { requested: uniqueSlots.length, planned, skipped, tx_hashes: txHashes };
  }

  private fixedSettlementBatches(slot: string): Map<string, FixedSettlementPayment[]> {
    const records = new Map<string, { index: number; payment: FixedSettlementPayment }[]>();
    for (const record of this.journal.records.values()) {
      const parsed = parseStaticJournalRecordId(record.id);
      if (!parsed || parsed.slot !== slot) continue;
      if (record.status.state !== "Confirmed") throw new Error(`reference command is not confirmed: ${record.id}`);
      if (record.command.kind !== "PayRewardTokenByBnbValue") {
        throw new Error(`reference slot contains non-payment command: ${record.id}`);
      }
      let batch = records.get(parsed.user);
      if (!batch) {
        batch = [];
        records.set(parsed.user, batch);
      }
      batch.push({
        index: parsed.index,
        payment: { to: record.command.to, amount: record.command.amount },
      });
    }

    const result = new Map<string, FixedSettlementPayment[]>();
    for (const [user, batch] of records) {
      batch.sort((left, right) => left.index - right.index);
      for (let index = 0; index < batch.length; index += 1) {
        if (batch[index].index !== index) throw new Error(`reference settlement command gap for ${user}`);
      }
      if (batch[0]?.payment.to !== user) throw new Error(`reference settlement has invalid static payment for ${user}`);
      result.set(user, batch.map((entry) => entry.payment));
    }
    return result;
  }

  async repairMissingStaticJournals(
    slots?: string[],
    submit = false,
  ): Promise<{ repaired_settlements: number; planned_commands: number; tx_hashes: string[] }> {
    rebuildInvestedDirectCounts(this.state);
    const wantedSlots = slots && slots.length > 0 ? new Set(slots) : null;
    let repairedSettlements = 0;
    let plannedCommands = 0;

    const ids = [...this.state.processedSettlements].sort();
    for (const id of ids) {
      const parsed = parseStaticSettlementId(id);
      if (!parsed) continue;
      if (wantedSlots && !wantedSlots.has(parsed.slot)) continue;
      if (this.journalHasBatch(id)) continue;

      const commands = this.rebuildStaticCommands(parsed.user);
      if (commands.length === 0) continue;
      this.journal.planBatch(id, commands);
      repairedSettlements += 1;
      plannedCommands += commands.length;
    }

    if (plannedCommands === 0) {
      return { repaired_settlements: 0, planned_commands: 0, tx_hashes: [] };
    }

    await this.persist();
    let txHashes: string[] = [];
    if (submit) {
      try {
        txHashes = await this.submitPendingLocked("repair-static-journal");
      } catch (err) {
        console.error("repairMissingStaticJournals submit failed:", err);
      }
    }
    return { repaired_settlements: repairedSettlements, planned_commands: plannedCommands, tx_hashes: txHashes };
  }

  private journalHasBatch(batchKey: string): boolean {
    const prefix = `${batchKey}:`;
    for (const id of this.journal.records.keys()) {
      if (id.startsWith(prefix)) return true;
    }
    return false;
  }

  private rebuildStaticCommands(user: string): OperatorCommand[] {
    const account = this.state.user(user);
    if (!account || !account.active || account.principalBnb === 0n) return [];
    const periods = Math.max(1, this.engine.config.settlementPeriodsPerDay);
    const staticBnb = bps(account.principalBnb, this.engine.config.dailyStaticBps) / BigInt(periods);
    const commands: OperatorCommand[] = [];
    if (staticBnb !== 0n) {
      commands.push({ kind: "PayRewardTokenByBnbValue", to: user, amount: staticBnb });
    }

    const ancestors = staticAncestors(this.state, user, 10);
    ancestors.forEach((ancestor, index) => {
      const rewardRate = this.engine.config.teamRewardBps[index] ?? 0;
      if (rewardRate === 0) return;
      const acct = this.state.user(ancestor);
      const generation = index + 1;
      const eligible =
        !!acct && acct.active && acct.principalBnb > 0n && acct.investedDirectCount >= generation;
      if (!eligible) return;
      const amount = bps(staticBnb, rewardRate);
      if (amount !== 0n) {
        commands.push({ kind: "PayRewardTokenByBnbValue", to: ancestor, amount });
      }
    });

    return commands;
  }

}

interface JournalEventSortKey {
  timestampMs: number | null;
  blockNumber: bigint;
  logIndex: number;
}

function isSlotClaim(value: unknown): value is SlotClaim {
  if (value == null || typeof value !== "object") return false;
  const claim = value as Partial<SlotClaim>;
  return (
    typeof claim.slot === "string" &&
    (claim.status === "pending" || claim.status === "completed") &&
    typeof claim.owner === "string" &&
    typeof claim.expiresAt === "number"
  );
}

function slotValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  return isSlotClaim(value) ? value.slot : null;
}

interface JournalDisplaySortKey {
  timestampMs: number | null;
  blockNumber: bigint | null;
  logIndex: number;
  sequence: number;
  id: string;
}

function compareJournalRecordsNewestFirst(
  a: CommandRecord,
  b: CommandRecord,
  eventSortKeys: Map<string, JournalEventSortKey>,
): number {
  const ak = journalDisplaySortKey(a, eventSortKeys);
  const bk = journalDisplaySortKey(b, eventSortKeys);

  if (ak.timestampMs != null && bk.timestampMs != null && ak.timestampMs !== bk.timestampMs) {
    return bk.timestampMs - ak.timestampMs;
  }
  if (ak.timestampMs != null && bk.timestampMs == null) return -1;
  if (ak.timestampMs == null && bk.timestampMs != null) return 1;

  if (ak.blockNumber != null && bk.blockNumber != null && ak.blockNumber !== bk.blockNumber) {
    return ak.blockNumber < bk.blockNumber ? 1 : -1;
  }
  if (ak.blockNumber != null && bk.blockNumber == null) return -1;
  if (ak.blockNumber == null && bk.blockNumber != null) return 1;

  if (ak.logIndex !== bk.logIndex) return bk.logIndex - ak.logIndex;
  if (ak.sequence !== bk.sequence) return bk.sequence - ak.sequence;
  return ak.id < bk.id ? 1 : ak.id > bk.id ? -1 : 0;
}

function journalDisplaySortKey(
  record: CommandRecord,
  eventSortKeys: Map<string, JournalEventSortKey>,
): JournalDisplaySortKey {
  const eventId = eventIdFromJournalId(record.id);
  const eventKey = eventId ? eventSortKeys.get(eventId) : null;
  if (eventKey) {
    return {
      timestampMs: eventKey.timestampMs,
      blockNumber: eventKey.blockNumber,
      logIndex: eventKey.logIndex,
      sequence: record.order?.sequence ?? sequenceFromJournalId(record.id),
      id: record.id,
    };
  }

  const slotMs = slotTimestampMsFromJournalId(record.id);
  if (slotMs != null) {
    return {
      timestampMs: slotMs,
      blockNumber: null,
      logIndex: 0,
      sequence: sequenceFromJournalId(record.id),
      id: record.id,
    };
  }

  return {
    timestampMs: null,
    blockNumber: record.order?.blockNumber ?? null,
    logIndex: record.order?.logIndex ?? 0,
    sequence: record.order?.sequence ?? sequenceFromJournalId(record.id),
    id: record.id,
  };
}

function eventIdFromJournalId(id: string): string | null {
  const match = /^(?:deposit|tax):(0x[0-9a-fA-F]{64}):(\d+):\d+:[^:]+$/.exec(id);
  return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
}

function sequenceFromJournalId(id: string): number {
  const match = /:(\d+):[^:]+$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function slotTimestampMsFromJournalId(id: string): number | null {
  const prefixed = /^(?:buyback|deflation|tax):(.+):\d+:[^:]+$/.exec(id);
  if (prefixed) return parseSlotMs(prefixed[1]);

  const settlement = /^static:[^:]+:(.+):\d+:[^:]+$/.exec(id);
  return settlement ? parseSlotMs(settlement[1]) : null;
}

function parseSlotMs(slot: string): number | null {
  const utc = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::(\d{2}))?Z$/.exec(slot);
  if (utc) {
    return Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3]), Number(utc[4]), Number(utc[5] ?? 0));
  }

  const utc8 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\+08(?:\/\d+)?$/.exec(slot);
  if (utc8) {
    return Date.UTC(Number(utc8[1]), Number(utc8[2]) - 1, Number(utc8[3]), Number(utc8[4]) - 8, Number(utc8[5]));
  }
  return null;
}

function parseStaticSettlementId(id: string): { user: string; slot: string } | null {
  const match = /^static:(0x[0-9a-f]{40}):(.+)$/.exec(id);
  return match ? { user: match[1].toLowerCase(), slot: match[2] } : null;
}

function parseStaticJournalRecordId(
  id: string,
): { user: string; slot: string; index: number } | null {
  const match = /^static:(0x[0-9a-f]{40}):(.+):(\d+):[^:]+$/.exec(id);
  if (!match) return null;
  const index = Number(match[3]);
  if (!Number.isSafeInteger(index)) return null;
  return { user: match[1].toLowerCase(), slot: match[2], index };
}

function fixedPaymentsFingerprint(payments: FixedSettlementPayment[]): string {
  return JSON.stringify(payments, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function staticReferralDepth(state: ProtocolState, user: string): number {
  let depth = 0;
  let cursor = user;
  while (depth < 1024) {
    const next = state.user(cursor)?.referrer;
    if (!next || next === cursor) break;
    depth += 1;
    cursor = next;
  }
  return depth;
}

function staticAncestors(state: ProtocolState, user: string, maxDepth: number): string[] {
  const out: string[] = [];
  let cursor = user;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const referrer = state.user(cursor)?.referrer;
    if (!referrer || referrer === cursor) break;
    out.push(referrer);
    cursor = referrer;
  }
  return out;
}

function parseSqliteUtcMs(value: string): number | null {
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function stateSetNames(): StateSetName[] {
  return ["processed-events", "processed-settlements", "applied-deposit-batches"];
}

function serializedStateSetChunkSize(ids: string[]): number {
  return new TextEncoder().encode(JSON.stringify({ ids })).byteLength;
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

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
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
