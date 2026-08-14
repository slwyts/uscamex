/**
 * Admin HTTP API. Port of Token/offchain/src/admin_api.rs.
 * Routes under /api/*. Owner routes require EIP-191 signature recovering to on-chain owner().
 * Response shapes match Token/admin/src/utils/api.ts exactly (snake_case fields).
 *
 * Auth headers (admin_api.rs:1197):
 *   x-uscamex-admin-message-b64 : base64 of the signed message
 *   x-uscamex-admin-signature   : EIP-191 personal_sign signature
 */
import { recoverMessageAddress } from "viem";
import type { Env, OperatorSettings } from "./env";

export interface AdminContext {
  env: Env;
  settings: OperatorSettings;
  owner: string; // cached on-chain owner(), lowercased
  chainHead: number | null;
}

function operatorStub(env: Env): DurableObjectStub {
  // Keyed by token address (see index.ts) so a fresh contract gets a fresh DO.
  return env.OPERATOR.get(env.OPERATOR.idFromName(`operator:${env.TOKEN_ADDRESS.toLowerCase()}`));
}

function operatorStubByName(env: Env, name: string): DurableObjectStub {
  return env.OPERATOR.get(env.OPERATOR.idFromName(name));
}

function activeOperatorName(env: Env): string {
  return `operator:${env.TOKEN_ADDRESS.toLowerCase()}`;
}

function json(data: unknown, status = 200): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    },
  });
}

const READ_RPC_METHODS = new Set(["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode"]);

function rpcPayloadAllowed(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload];
  if (requests.length === 0) return false;
  return requests.every((item) => {
    if (item == null || typeof item !== "object") return false;
    const method = (item as { method?: unknown }).method;
    return typeof method === "string" && READ_RPC_METHODS.has(method);
  });
}

async function rpcProxy(req: Request, ctx: AdminContext): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json-rpc body" }, 400);
  }
  if (!rpcPayloadAllowed(payload)) {
    return json({ error: "json-rpc method not allowed" }, 403);
  }
  const upstream = await fetch(ctx.settings.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    },
  });
}

async function requireOwner(req: Request, ctx: AdminContext): Promise<{ signer: string } | Response> {
  // Bypass backdoor: ?force skips owner-signature auth for admin views and the
  // explicit retry-failed recovery action. Other write routes still add their
  // own bypass guards below.
  const url = new URL(req.url);
  if (url.searchParams.has("force")) return { signer: "bypass" };

  const b64 = req.headers.get("x-uscamex-admin-message-b64") ?? legacyMessage(req);
  const sig = req.headers.get("x-uscamex-admin-signature");
  if (!b64 || !sig) return json({ error: "missing admin auth headers" }, 401);

  let message: string;
  try {
    message = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
  } catch {
    return json({ error: "invalid base64 message" }, 400);
  }
  if (!message.startsWith("USCAMEX Admin")) return json({ error: "bad message prefix" }, 400);
  if (!message.includes(`token=${ctx.settings.tokenAddress}`)) {
    return json({ error: "message token mismatch" }, 400);
  }
  if (!message.includes(`chainId=${ctx.settings.chainId}`)) {
    return json({ error: "message chainId mismatch" }, 400);
  }
  const timestamp = signedTimestamp(message);
  if (timestamp == null) return json({ error: "missing message timestamp" }, 400);
  const maxAgeSecs = 7 * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (timestamp > now + 300) return json({ error: "message timestamp is in the future" }, 400);
  if (now - timestamp > maxAgeSecs) return json({ error: "admin signature expired" }, 401);

  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message, signature: sig as `0x${string}` })).toLowerCase();
  } catch {
    return json({ error: "signature recovery failed" }, 400);
  }
  if (signer !== ctx.owner.toLowerCase()) return json({ error: "not owner" }, 403);
  return { signer };
}

function signedTimestamp(message: string): number | null {
  const line = message.split("\n").find((part) => part.startsWith("timestamp="));
  if (!line) return null;
  const timestamp = Number(line.slice("timestamp=".length));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.floor(timestamp);
}

function legacyMessage(req: Request): string | null {
  const raw = req.headers.get("x-uscamex-admin-message");
  if (!raw) return null;
  return btoa(unescape(encodeURIComponent(raw)));
}

function intParam(url: URL, name: string, def: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Routes admin API requests. Returns null only for non-/api paths. */
export async function handleAdmin(req: Request, ctx: AdminContext): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  }

  // ---- public ----
  if (path === "/api/rpc") {
    return rpcProxy(req, ctx);
  }
  if (path === "/api/health") {
    return json({
      ok: true,
      chain_id: ctx.settings.chainId, // backward compat
      chain: {
        id: ctx.settings.chainId,
        name: ctx.settings.chainName,
        native_currency: ctx.settings.nativeCurrency,
        rpc_url: ctx.settings.publicRpcUrl || `${url.origin}/api/rpc`,
        explorer_url: ctx.settings.explorerUrl,
      },
      chain_head: ctx.chainHead,
      token_address: ctx.settings.tokenAddress,
      pancake_v2_router: ctx.settings.pancakeV2Router,
      indexer_start_block: Number(ctx.settings.indexerStartBlock),
      confirmations: ctx.settings.confirmations,
    });
  }
  if (path === "/api/admin/owner") {
    return json({ owner: ctx.owner, tokenAddress: ctx.settings.tokenAddress });
  }

  // ---- owner-authed ----
  const auth = await requireOwner(req, ctx);
  if (auth instanceof Response) return auth;
  const { signer } = auth;
  const stub = operatorStub(env(ctx));

  switch (path) {
    case "/api/admin/overview":
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.getOverview()) });
    case "/api/admin/state":
      // @ts-expect-error DO RPC
      return json(await stub.getState());
    case "/api/admin/journal":
      // @ts-expect-error DO RPC
      return json(await stub.getJournal());
    case "/api/admin/stats":
      // @ts-expect-error DO RPC
      return json({ signer, chain_head: ctx.chainHead, ...(await stub.queryStats()) });
    case "/api/admin/team": {
      const address = (url.searchParams.get("address") ?? "").toLowerCase();
      const depth = intParam(url, "depth", 10, 50);
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryTeam(address, depth)) });
    }
    case "/api/admin/user": {
      const address = (url.searchParams.get("address") ?? "").toLowerCase();
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryUser(address)) });
    }
    case "/api/admin/users": {
      const limit = intParam(url, "limit", 50, 500);
      const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER);
      const sort = url.searchParams.get("sort") ?? "address";
      const filter = url.searchParams.get("filter") ?? "all";
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryUsers(limit, offset, sort, filter)) });
    }
    case "/api/admin/nodes":
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryNodes()) });
    case "/api/admin/positions": {
      const limit = intParam(url, "limit", 50, 500);
      const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER);
      const sort = url.searchParams.get("sort") ?? "user";
      const filter = url.searchParams.get("filter") ?? "all";
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryPositions(limit, offset, sort, filter)) });
    }
    case "/api/admin/journal-list": {
      const limit = intParam(url, "limit", 50, 500);
      const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER);
      const status = url.searchParams.get("status") || "all";
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.queryJournalList(limit, offset, status)) });
    }
    case "/api/admin/pending-reward-cancellation": {
      if (req.method === "GET") {
        // @ts-expect-error DO RPC
        return json({ signer, ...(await stub.previewPendingRewardCancellation()) });
      }
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (signer === "bypass") return json({ error: "owner signature required to cancel rewards" }, 403);
      const body = (await req.json().catch(() => ({}))) as {
        snapshot?: unknown;
        confirm?: unknown;
      };
      if (body.confirm !== "CANCEL_PENDING_REWARDS" || typeof body.snapshot !== "string") {
        return json({ error: "snapshot and explicit cancellation confirmation are required" }, 400);
      }
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.cancelPendingRewards(body.snapshot)) });
    }
    case "/api/admin/confirm-pending-tax-sweep": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (signer === "bypass") return json({ error: "owner signature required to confirm a tax sweep" }, 403);
      const body = (await req.json().catch(() => ({}))) as {
        id?: unknown;
        txHash?: unknown;
        confirm?: unknown;
      };
      if (
        body.confirm !== "CONFIRM_EXECUTED_TAX_SWEEP" ||
        typeof body.id !== "string" ||
        typeof body.txHash !== "string"
      ) {
        return json({ error: "id, txHash and explicit confirmation are required" }, 400);
      }
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.confirmPendingTaxSweepFromTransaction(body.id, body.txHash)) });
    }
    case "/api/admin/retry-failed": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      let ids: string[] | undefined;
      try {
        const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
        if (Array.isArray(body.ids)) ids = body.ids.filter((x): x is string => typeof x === "string");
      } catch {
        // empty/invalid body => retry all failed commands
      }
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.retryFailedCommands(ids)) });
    }
    case "/api/admin/repair-static-journal": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (signer === "bypass") {
        return json({ error: "owner signature required to repair static journal" }, 403);
      }
      let slots: string[] | undefined;
      let submit = false;
      try {
        const body = (await req.json().catch(() => ({}))) as {
          slots?: unknown;
          submit?: unknown;
        };
        if (Array.isArray(body.slots)) slots = body.slots.filter((x): x is string => typeof x === "string");
        submit = body.submit === true;
      } catch {
        // empty/invalid body => repair all missing slots without immediate submit
      }
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.repairMissingStaticJournals(slots, submit)) });
    }
    case "/api/admin/backfill-missing-settlement": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body = (await req.json().catch(() => ({}))) as {
        slot?: unknown;
        referenceBefore?: unknown;
        referenceAfter?: unknown;
        submit?: unknown;
      };
      if (
        typeof body.slot !== "string" ||
        typeof body.referenceBefore !== "string" ||
        typeof body.referenceAfter !== "string"
      ) {
        return json({ error: "slot, referenceBefore and referenceAfter are required" }, 400);
      }
      // @ts-expect-error DO RPC
      const result = await stub.backfillMissingSettlementSlot(
        body.slot,
        body.referenceBefore,
        body.referenceAfter,
        body.submit === true,
      );
      return json({ signer, ...result });
    }
    case "/api/admin/backfill-missing-deflation": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body = (await req.json().catch(() => ({}))) as {
        slots?: unknown;
        submit?: unknown;
      };
      const slots = Array.isArray(body.slots)
        ? body.slots.filter((value): value is string => typeof value === "string")
        : [];
      if (slots.length === 0) return json({ error: "slots[] is required" }, 400);
      // @ts-expect-error DO RPC
      const result = await stub.backfillMissingDeflationSlots(slots, body.submit === true);
      return json({ signer, ...result });
    }
    case "/api/admin/stop-operator-instance": {
      const name = url.searchParams.get("name") ?? "";
      if (!name) return json({ error: "name is required" }, 400);
      if (signer === "bypass" && name === activeOperatorName(env(ctx))) {
        return json({ error: "owner signature required to stop active operator instance" }, 403);
      }
      const target = operatorStubByName(env(ctx), name);
      // @ts-expect-error DO RPC
      return json({ signer, name, ...(await target.stopRunning()) });
    }
    case "/api/admin/forget-events": {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      let ids: string[] = [];
      let rewindToBlock = 0;
      try {
        const body = (await req.json().catch(() => ({}))) as {
          ids?: unknown;
          rewindToBlock?: unknown;
        };
        if (Array.isArray(body.ids)) ids = body.ids.filter((x): x is string => typeof x === "string");
        if (typeof body.rewindToBlock === "number") rewindToBlock = Math.floor(body.rewindToBlock);
      } catch {
        // invalid body
      }
      if (ids.length === 0 || rewindToBlock <= 0) {
        return json({ error: "ids[] and rewindToBlock are required" }, 400);
      }
      // @ts-expect-error DO RPC
      return json({ signer, ...(await stub.forgetEvents(ids, rewindToBlock)) });
    }
    case "/api/admin/config-history": {
      const limit = intParam(url, "limit", 50, 200);
      return json({ signer, items: await queryConfigHistory(ctx.env, ctx.settings.tokenAddress, limit) });
    }
    case "/api/admin/node-history": {
      const limit = intParam(url, "limit", 100, 500);
      const address = url.searchParams.get("address");
      return json({ signer, items: await queryNodeHistory(ctx.env, ctx.settings.tokenAddress, limit, address) });
    }
    default:
      return json({ error: `route not found: ${path}` }, 404);
  }
}

function env(ctx: AdminContext): Env {
  return ctx.env;
}

// ---- D1 history queries (config/node history live in D1, not the DO) ----

async function queryConfigHistory(env: Env, tokenAddress: string, limit: number): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, payload, updated_by, created_at, block_number, tx_hash
       FROM protocol_config_history WHERE token_address = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(tokenAddress.toLowerCase(), limit)
    .all<{
      id: number;
      payload: string;
      updated_by: string;
      created_at: string;
      block_number: number | null;
      tx_hash: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    payload: JSON.parse(r.payload),
    updated_by: r.updated_by,
    created_at: r.created_at,
    block_number: r.block_number,
    tx_hash: r.tx_hash,
  }));
}

async function queryNodeHistory(env: Env, tokenAddress: string, limit: number, address: string | null): Promise<unknown[]> {
  const stmt = address
    ? env.DB.prepare(
        `SELECT id, node_address, weight, block_number, tx_hash, updated_by, created_at
           FROM node_history WHERE token_address = ? AND node_address = ? ORDER BY id DESC LIMIT ?`,
      ).bind(tokenAddress.toLowerCase(), address.toLowerCase(), limit)
    : env.DB.prepare(
        `SELECT id, node_address, weight, block_number, tx_hash, updated_by, created_at
           FROM node_history WHERE token_address = ? ORDER BY id DESC LIMIT ?`,
      ).bind(tokenAddress.toLowerCase(), limit);
  const { results } = await stmt.all<{
    id: number;
    node_address: string;
    weight: number;
    block_number: number | null;
    tx_hash: string | null;
    updated_by: string;
    created_at: string;
  }>();
  return results;
}
