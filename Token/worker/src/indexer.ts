/**
 * Event decoding. Port of Token/offchain/src/indexer.rs.
 * Topic = keccak256(signature). Decoders mirror the manual ABI word parsing in Rust
 * (validating word width + rejecting high-bit overflow) rather than relying on viem decoders,
 * to keep byte-for-byte parity with the original.
 */
import { keccak256, toHex } from "viem";

export const REF_BOUND_SIGNATURE = "RefBound(address,address)";
export const DEPOSIT_SIGNATURE = "Deposit(address,uint256,address)";
export const TAX_COLLECTED_SIGNATURE = "TaxCollected(address,address,uint256,uint8)";
export const PROTOCOL_CONFIG_UPDATED_SIGNATURE = "ProtocolConfigUpdated(address)";
export const NODE_UPDATED_SIGNATURE = "NodeUpdated(address,uint32)";

function topic(signature: string): string {
  return keccak256(toHex(signature)).toLowerCase();
}

export const REF_BOUND_TOPIC = topic(REF_BOUND_SIGNATURE);
export const DEPOSIT_TOPIC = topic(DEPOSIT_SIGNATURE);
export const TAX_COLLECTED_TOPIC = topic(TAX_COLLECTED_SIGNATURE);
export const PROTOCOL_CONFIG_UPDATED_TOPIC = topic(PROTOCOL_CONFIG_UPDATED_SIGNATURE);
export const NODE_UPDATED_TOPIC = topic(NODE_UPDATED_SIGNATURE);

/** Topic OR-group for eth_getLogs (same set used by ws subscribe in the Rust original). */
export const ALL_TOPICS = [
  REF_BOUND_TOPIC,
  DEPOSIT_TOPIC,
  TAX_COLLECTED_TOPIC,
  PROTOCOL_CONFIG_UPDATED_TOPIC,
  NODE_UPDATED_TOPIC,
];

export interface RawLog {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  topics: string[];
  data: string;
}

export type TaxSide = "Buy" | "Sell";

export type ChainEvent =
  | { kind: "RefBound"; id: string; user: string; referrer: string }
  | { kind: "Deposit"; id: string; user: string; amount: bigint }
  | { kind: "TaxCollected"; id: string; from: string; to: string; amount: bigint; side: TaxSide };

export interface IndexedEvent {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  event: ChainEvent;
}

export type SystemEvent =
  | { kind: "ProtocolConfigUpdated"; blockNumber: bigint; txHash: string }
  | { kind: "NodeUpdated"; blockNumber: bigint; txHash: string; node: string; weight: number };

export class DecodeError extends Error {}

/** event id = "{txHash.lower}:{logIndex}" (indexer.rs:274). */
export function eventId(log: RawLog): string {
  return `${log.txHash.toLowerCase()}:${log.logIndex}`;
}

export function eventKind(event: ChainEvent): "RefBound" | "Deposit" | "TaxCollected" {
  return event.kind;
}

/** JSON payload stored in chain_events.payload (mirrors indexer.rs payload()). */
export function eventPayload(event: ChainEvent): string {
  switch (event.kind) {
    case "RefBound":
      return JSON.stringify({ user: event.user, referrer: event.referrer });
    case "Deposit":
      return JSON.stringify({ user: event.user, amount: event.amount.toString() });
    case "TaxCollected":
      return JSON.stringify({
        from: event.from,
        to: event.to,
        amount: event.amount.toString(),
        side: event.side === "Buy" ? "buy" : "sell",
      });
  }
}

// ---- decoders ----

function strip0x(value: string): string {
  const v = value.trim();
  if (!v.startsWith("0x")) throw new DecodeError("InvalidData");
  return v.slice(2);
}

const HEX_RE = /^[0-9a-fA-F]*$/;

function decodeTopicAddress(topicHex: string): string {
  const word = strip0x(topicHex);
  if (word.length !== 64 || !HEX_RE.test(word)) throw new DecodeError("InvalidTopic");
  return `0x${word.slice(24).toLowerCase()}`;
}

/** u128 word: top 128 bits must be zero (indexer.rs decode_u128_hex_word). */
function decodeU128HexWord(word: string): bigint {
  if (word.length !== 64 || !HEX_RE.test(word)) throw new DecodeError("InvalidData");
  if (/[^0]/.test(word.slice(0, 32))) throw new DecodeError("UintOverflow");
  return BigInt(`0x${word.slice(32)}`);
}

function decodeU128Word(data: string): bigint {
  return decodeU128HexWord(strip0x(data));
}

/** u8 word: top 62 bytes-of-nibbles must be zero (indexer.rs decode_u8_hex_word). */
function decodeU8HexWord(word: string): number {
  if (word.length !== 64 || !HEX_RE.test(word)) throw new DecodeError("InvalidData");
  if (/[^0]/.test(word.slice(0, 62))) throw new DecodeError("UintOverflow");
  return parseInt(word.slice(62), 16);
}

/** u32 word: top 56 nibbles must be zero (indexer.rs decode_u32_word). */
function decodeU32Word(data: string): number {
  const word = strip0x(data);
  if (word.length !== 64 || !HEX_RE.test(word)) throw new DecodeError("InvalidData");
  if (/[^0]/.test(word.slice(0, 56))) throw new DecodeError("UintOverflow");
  return parseInt(word.slice(56), 16);
}

function decodeDataWords(data: string, expected: number): string[] {
  const d = strip0x(data);
  if (d.length !== expected * 64 || !HEX_RE.test(d)) throw new DecodeError("InvalidData");
  const out: string[] = [];
  for (let i = 0; i < expected; i++) out.push(d.slice(i * 64, (i + 1) * 64));
  return out;
}

/** indexer.rs:180 — admin-state logs that trigger a re-sync. Returns null if not a system log. */
export function classifySystemLog(log: RawLog): SystemEvent | null {
  const t = log.topics[0]?.toLowerCase();
  if (!t) return null;
  if (t === PROTOCOL_CONFIG_UPDATED_TOPIC) {
    return { kind: "ProtocolConfigUpdated", blockNumber: log.blockNumber, txHash: log.txHash.toLowerCase() };
  }
  if (t === NODE_UPDATED_TOPIC) {
    const node = decodeTopicAddress(log.topics[1] ?? throwMissing());
    const weight = decodeU32Word(log.data);
    return { kind: "NodeUpdated", blockNumber: log.blockNumber, txHash: log.txHash.toLowerCase(), node, weight };
  }
  return null;
}

function throwMissing(): never {
  throw new DecodeError("MissingTopic");
}

/** indexer.rs:204 — business event decode. Returns null if topic isn't a known business event. */
export function decodeProtocolLog(log: RawLog): IndexedEvent | null {
  const t = log.topics[0]?.toLowerCase();
  if (!t) throw new DecodeError("MissingTopic");

  if (t === REF_BOUND_TOPIC) {
    const user = decodeTopicAddress(log.topics[1] ?? throwMissing());
    const referrer = decodeTopicAddress(log.topics[2] ?? throwMissing());
    return wrap(log, { kind: "RefBound", id: eventId(log), user, referrer });
  }
  if (t === DEPOSIT_TOPIC) {
    const user = decodeTopicAddress(log.topics[1] ?? throwMissing());
    const amount = decodeU128Word(log.data);
    return wrap(log, { kind: "Deposit", id: eventId(log), user, amount });
  }
  if (t === TAX_COLLECTED_TOPIC) {
    const from = decodeTopicAddress(log.topics[1] ?? throwMissing());
    const to = decodeTopicAddress(log.topics[2] ?? throwMissing());
    const words = decodeDataWords(log.data, 2);
    const amount = decodeU128HexWord(words[0]);
    const sideRaw = decodeU8HexWord(words[1]);
    const side: TaxSide = sideRaw === 1 ? "Buy" : sideRaw === 2 ? "Sell" : throwInvalid();
    return wrap(log, { kind: "TaxCollected", id: eventId(log), from, to, amount, side });
  }
  return null;
}

function throwInvalid(): never {
  throw new DecodeError("InvalidData");
}

function wrap(log: RawLog, event: ChainEvent): IndexedEvent {
  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.txHash,
    logIndex: log.logIndex,
    event,
  };
}
