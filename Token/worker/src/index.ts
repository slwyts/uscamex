/**
 * Worker entry point. Routes HTTP to the admin API and cron to the OperatorDO.
 * Replaces the Rust main.rs tokio::select! { runtime, admin_api }.
 */
import { handleAdmin, type AdminContext } from "./admin";
import { loadSettings, type Env } from "./env";
import { BscRpcClient } from "./rpc";

export { OperatorDO } from "./do";

function operatorStub(env: Env): DurableObjectStub {
  return env.OPERATOR.get(env.OPERATOR.idFromName("operator"));
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

    // Kick the scan loop on traffic (idempotent).
    const stub = operatorStub(env);
    // @ts-expect-error DO RPC
    await stub.ensureRunning();

    const rpc = new BscRpcClient(settings.bscRpcUrl, settings.tokenAddress);
    let owner = "0x0000000000000000000000000000000000000000";
    let chainHead: number | null = null;
    try {
      [owner, chainHead] = await Promise.all([resolveOwner(rpc), resolveHead(rpc)]);
    } catch {
      // owner resolution failure → owner routes will 403; public routes still work
    }

    const ctx: AdminContext = { env, settings, owner, chainHead };
    const adminResponse = await handleAdmin(req, ctx);
    return adminResponse ?? new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const stub = operatorStub(env);
    // @ts-expect-error DO RPC
    await stub.ensureRunning();
    // @ts-expect-error DO RPC
    await stub.runScheduledTicks();
  },
} satisfies ExportedHandler<Env>;
