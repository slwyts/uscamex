/**
 * Worker entry point. Routes HTTP to the admin API and cron to the OperatorDO.
 * Replaces the Rust main.rs tokio::select! { runtime, admin_api }.
 */
import { handleAdmin, type AdminContext } from "./admin";
import { loadSettings, type Env } from "./env";
import { BscRpcClient } from "./rpc";

export { OperatorDO } from "./do";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function operatorStub(env: Env): DurableObjectStub {
  // DO instance is keyed by the token address so deploying a fresh contract
  // starts from clean DO state (state/journal/slots) instead of inheriting the
  // previous contract's accounting.
  return env.OPERATOR.get(env.OPERATOR.idFromName(`operator:${env.TOKEN_ADDRESS.toLowerCase()}`));
}

function activeOperatorName(env: Env): string {
  return `operator:${env.TOKEN_ADDRESS.toLowerCase()}`;
}

// owner() + chain head caches (admin_api.rs: owner 300s, head 10s)
let ownerCache: { value: string; at: number } | null = null;
let headCache: { value: number | null; at: number } | null = null;
const OWNER_TTL_MS = 300_000;
const HEAD_TTL_MS = 10_000;

async function resolveOwner(rpc: BscRpcClient): Promise<string> {
  const now = Date.now();
  if (ownerCache && now - ownerCache.at < OWNER_TTL_MS) return ownerCache.value;
  const owner = (await rpc.owner()).toLowerCase();
  ownerCache = { value: owner, at: now };
  return owner;
}

async function resolveHead(rpc: BscRpcClient): Promise<number | null> {
  const now = Date.now();
  if (headCache && now - headCache.at < HEAD_TTL_MS) return headCache.value;
  try {
    const head = Number(await rpc.blockNumber());
    headCache = { value: head, at: now };
    return head;
  } catch {
    return headCache?.value ?? null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let settings;
    try {
      settings = loadSettings(env);
    } catch (err) {
      return Response.json({ error: `settings: ${(err as Error).message}` }, { status: 500 });
    }

    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      // Non-API routes are normally served by Workers Static Assets before the
      // Worker runs (run_worker_first only matches /api/*). This is a safety
      // fallback that forwards anything that does reach here to the SPA assets.
      return env.ASSETS.fetch(req);
    }

    // The public JSON-RPC route is already restricted to a small read-only
    // method allowlist in handleAdmin. Forward it directly: resolving owner and
    // head first can add two unrelated upstream calls whenever an isolate cache
    // is cold or the head cache expires.
    if (url.pathname === "/api/rpc") {
      const ctx: AdminContext = {
        env,
        settings,
        owner: ZERO_ADDRESS,
        chainHead: null,
      };
      const response = await handleAdmin(req, ctx);
      return response ?? new Response("not found", { status: 404 });
    }

    // Kick the scan loop on traffic (idempotent).
    const stub = operatorStub(env);
    // @ts-expect-error DO RPC
    await stub.ensureRunning(activeOperatorName(env));

    const rpc = new BscRpcClient(settings.rpcUrl, settings.tokenAddress);
    const bypassed = url.searchParams.has("force");
    const needsOwner = url.pathname === "/api/admin/owner"
      || (url.pathname.startsWith("/api/admin/") && !bypassed);
    const needsChainHead = url.pathname === "/api/health" || url.pathname === "/api/admin/stats";
    const [owner, chainHead] = await Promise.all([
      needsOwner ? resolveOwner(rpc).catch(() => ZERO_ADDRESS) : Promise.resolve(ZERO_ADDRESS),
      needsChainHead ? resolveHead(rpc) : Promise.resolve(null),
    ]);

    const ctx: AdminContext = { env, settings, owner, chainHead };
    const adminResponse = await handleAdmin(req, ctx);
    return adminResponse ?? new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const stub = operatorStub(env);
    // @ts-expect-error DO RPC
    await stub.ensureRunning(activeOperatorName(env));
    // @ts-expect-error DO RPC
    await stub.runScheduledTicks();
  },
} satisfies ExportedHandler<Env>;
