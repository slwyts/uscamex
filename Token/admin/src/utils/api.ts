import axios, { AxiosError, type AxiosInstance } from "axios";
import { loadSettings } from "./settings";

export interface ApiClientOptions {
  message?: string;
  signature?: string;
}

const SHARED_AUTH: { message: string; signature: string } = { message: "", signature: "" };

export function setAdminAuth(message: string, signature: string) {
  SHARED_AUTH.message = message;
  SHARED_AUTH.signature = signature;
}

export function clearAdminAuth() {
  SHARED_AUTH.message = "";
  SHARED_AUTH.signature = "";
}

export function hasAdminAuth() {
  return SHARED_AUTH.message.length > 0 && SHARED_AUTH.signature.length > 0;
}

export function api(): AxiosInstance {
  const settings = loadSettings();
  const instance = axios.create({
    baseURL: settings.apiBase || "",
    timeout: 20_000,
  });
  instance.interceptors.request.use((config) => {
    if (SHARED_AUTH.message) {
      config.headers.set("x-uscamex-admin-message", SHARED_AUTH.message);
      config.headers.set("x-uscamex-admin-signature", SHARED_AUTH.signature);
    }
    return config;
  });
  return instance;
}

export interface OwnerInfo {
  owner: string;
  tokenAddress: string;
}

export async function fetchOwner(): Promise<OwnerInfo> {
  const res = await api().get<OwnerInfo>("/api/admin/owner");
  return res.data;
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data as { error?: string } | undefined;
    return data?.error || error.message || "请求失败";
  }
  return error instanceof Error ? error.message : String(error);
}

export interface PageQuery {
  limit?: number;
  offset?: number;
  sort?: string;
  filter?: string;
}

export interface UserSummary {
  address: string;
  referrer: string | null;
  direct_count: number;
  position_id: number;
  principal_bnb: string;
  static_paid_bnb: string;
  dynamic_paid_bnb: string;
  active: boolean;
  exited: boolean;
  is_node: boolean;
  node_weight: number | null;
  node_paid_bnb: string;
  direct_paid_bnb: string;
}

export interface GenerationGroup {
  generation: number;
  count: number;
  members: UserSummary[];
}

export interface TeamResponse {
  signer: string;
  root: UserSummary;
  direct_members: UserSummary[];
  generations: GenerationGroup[];
  total_descendants: number;
  truncated_at_depth: number;
}

export interface UserDetailResponse {
  signer: string;
  summary: UserSummary;
  referrer_summary: UserSummary | null;
  direct_members: UserSummary[];
}

export interface UsersListResponse {
  signer: string;
  total: number;
  limit: number;
  offset: number;
  items: UserSummary[];
}

export interface NodeSummary {
  address: string;
  weight: number;
  paid_bnb: string;
}

export interface NodesResponse {
  signer: string;
  items: NodeSummary[];
  total_paid_bnb: string;
}

export interface PositionItem {
  user: string;
  position_id: number;
  principal_bnb: string;
  static_paid_bnb: string;
  dynamic_paid_bnb: string;
  active: boolean;
  exited: boolean;
}

export interface PositionsResponse {
  signer: string;
  total: number;
  limit: number;
  offset: number;
  items: PositionItem[];
}

export interface JournalEntry {
  id: string;
  kind: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  tx_hash: string | null;
  error: string | null;
  attempts: number;
  payload: unknown;
}

export interface JournalListResponse {
  signer: string;
  total: number;
  limit: number;
  offset: number;
  items: JournalEntry[];
  counts: { pending: number; submitted: number; confirmed: number; failed: number };
}

export interface ConfigHistoryItem {
  id: number;
  payload: Record<string, unknown>;
  updated_by: string;
  created_at: string;
  block_number?: number | null;
  tx_hash?: string | null;
}

export interface ConfigHistoryResponse {
  signer: string;
  items: ConfigHistoryItem[];
}

export interface NodeHistoryItem {
  id: number;
  node_address: string;
  weight: number;
  block_number?: number | null;
  tx_hash?: string | null;
  updated_by: string;
  created_at: string;
}

export interface NodeHistoryResponse {
  signer: string;
  items: NodeHistoryItem[];
}

export interface GlobalStats {
  signer: string;
  chain_id: number;
  chain_head: number | null;
  token_address: string;
  root: string | null;
  current_day: number;
  deflation_used_bps: number;
  total_users: number;
  bound_users: number;
  active_users: number;
  exited_users: number;
  nodes_count: number;
  total_principal_bnb: string;
  total_static_paid_bnb: string;
  total_dynamic_paid_bnb: string;
  burned_tokens: string;
  tax_burned_token_value_bnb: string;
  vault_bnb: string;
  owner_bnb: string;
  builder_token_value_bnb: string;
  builder_token_amount: string;
  pair_token_reserve: string;
  pair_bnb_reserve: string;
  last_indexed_block: number | null;
  processed_events: number;
  processed_settlements: number;
  pending_commands: number;
  submitted_commands: number;
  confirmed_commands: number;
  failed_commands: number;
  protocol_config_initialized: boolean;
}

export interface PublicHealth {
  ok: boolean;
  chain_id: number;
  chain_head: number | null;
  token_address: string;
  pancake_v2_router: string;
  indexer_start_block: number;
  confirmations: number;
}
