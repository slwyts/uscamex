use std::fmt;

use crate::engine::{Engine, EngineError};
use crate::state::{Address, ProtocolState};
use crate::storage::StoredEvent;
use ethers_core::utils::keccak256;

pub const REF_BOUND_SIGNATURE: &str = "RefBound(address,address)";
pub const DEPOSIT_SIGNATURE: &str = "Deposit(address,uint256,address)";
pub const PROTOCOL_CONFIG_UPDATED_SIGNATURE: &str = "ProtocolConfigUpdated(address)";
pub const NODE_UPDATED_SIGNATURE: &str = "NodeUpdated(address,uint32)";

/// Logs that don't represent business events but signal that on-chain admin
/// state has changed and the offchain mirror should refresh & persist a
/// history entry with full provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemEvent {
    ProtocolConfigUpdated {
        block_number: u64,
        tx_hash: String,
    },
    NodeUpdated {
        block_number: u64,
        tx_hash: String,
        node: Address,
        weight: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainEvent {
    RefBound {
        id: String,
        user: Address,
        referrer: Address,
    },
    Deposit {
        id: String,
        user: Address,
        amount: u128,
    },
}

impl ChainEvent {
    pub fn id(&self) -> &str {
        match self {
            Self::RefBound { id, .. } | Self::Deposit { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedEvent {
    pub block_number: u64,
    pub block_hash: String,
    pub tx_hash: String,
    pub log_index: u32,
    pub event: ChainEvent,
}

impl IndexedEvent {
    pub fn id(&self) -> String {
        self.event.id().to_owned()
    }

    fn kind(&self) -> &'static str {
        match self.event {
            ChainEvent::RefBound { .. } => "RefBound",
            ChainEvent::Deposit { .. } => "Deposit",
        }
    }

    fn payload(&self) -> String {
        match &self.event {
            ChainEvent::RefBound { user, referrer, .. } => serde_json::json!({
                "user": user,
                "referrer": referrer,
            })
            .to_string(),
            ChainEvent::Deposit { user, amount, .. } => serde_json::json!({
                "user": user,
                "amount": amount.to_string(),
            })
            .to_string(),
        }
    }

    pub fn stored(&self) -> StoredEvent {
        StoredEvent {
            id: self.id(),
            block_number: self.block_number,
            block_hash: self.block_hash.clone(),
            tx_hash: self.tx_hash.clone(),
            log_index: self.log_index,
            kind: self.kind().to_owned(),
            payload: self.payload(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLog {
    pub block_number: u64,
    pub block_hash: String,
    pub tx_hash: String,
    pub log_index: u32,
    pub topics: Vec<String>,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    MissingTopic,
    InvalidTopic,
    InvalidData,
    UintOverflow,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for DecodeError {}

pub fn event_topic(signature: &str) -> String {
    format!("0x{}", hex_encode(&keccak256(signature.as_bytes())))
}

pub fn ref_bound_topic() -> String {
    event_topic(REF_BOUND_SIGNATURE)
}

pub fn deposit_topic() -> String {
    event_topic(DEPOSIT_SIGNATURE)
}

pub fn protocol_config_updated_topic() -> String {
    event_topic(PROTOCOL_CONFIG_UPDATED_SIGNATURE)
}

pub fn node_updated_topic() -> String {
    event_topic(NODE_UPDATED_SIGNATURE)
}

/// Recognise admin-state log topics that should not flow through the regular
/// `apply_event` path but instead trigger an immediate chain re-sync.
pub fn classify_system_log(log: &RawLog) -> Result<Option<SystemEvent>, DecodeError> {
    let Some(topic) = log.topics.first() else {
        return Ok(None);
    };
    let topic = topic.to_ascii_lowercase();
    if topic == protocol_config_updated_topic() {
        return Ok(Some(SystemEvent::ProtocolConfigUpdated {
            block_number: log.block_number,
            tx_hash: log.tx_hash.to_ascii_lowercase(),
        }));
    }
    if topic == node_updated_topic() {
        let node = decode_topic_address(log.topics.get(1).ok_or(DecodeError::MissingTopic)?)?;
        let weight = decode_u32_word(&log.data)?;
        return Ok(Some(SystemEvent::NodeUpdated {
            block_number: log.block_number,
            tx_hash: log.tx_hash.to_ascii_lowercase(),
            node,
            weight,
        }));
    }
    Ok(None)
}

pub fn decode_protocol_log(log: RawLog) -> Result<Option<IndexedEvent>, DecodeError> {
    let topic = log
        .topics
        .first()
        .ok_or(DecodeError::MissingTopic)?
        .to_ascii_lowercase();
    if topic == ref_bound_topic() {
        return Ok(Some(decode_ref_bound(log)?));
    }
    if topic == deposit_topic() {
        return Ok(Some(decode_deposit(log)?));
    }
    Ok(None)
}

fn decode_ref_bound(log: RawLog) -> Result<IndexedEvent, DecodeError> {
    let user = decode_topic_address(log.topics.get(1).ok_or(DecodeError::MissingTopic)?)?;
    let referrer = decode_topic_address(log.topics.get(2).ok_or(DecodeError::MissingTopic)?)?;
    let id = event_id(&log);
    Ok(IndexedEvent {
        block_number: log.block_number,
        block_hash: log.block_hash,
        tx_hash: log.tx_hash,
        log_index: log.log_index,
        event: ChainEvent::RefBound { id, user, referrer },
    })
}

fn decode_deposit(log: RawLog) -> Result<IndexedEvent, DecodeError> {
    let user = decode_topic_address(log.topics.get(1).ok_or(DecodeError::MissingTopic)?)?;
    let amount = decode_u128_word(&log.data)?;
    let id = event_id(&log);
    Ok(IndexedEvent {
        block_number: log.block_number,
        block_hash: log.block_hash,
        tx_hash: log.tx_hash,
        log_index: log.log_index,
        event: ChainEvent::Deposit { id, user, amount },
    })
}

fn event_id(log: &RawLog) -> String {
    format!("{}:{}", log.tx_hash.to_ascii_lowercase(), log.log_index)
}

fn decode_topic_address(topic: &str) -> Result<Address, DecodeError> {
    let word = strip_0x(topic).ok_or(DecodeError::InvalidTopic)?;
    if word.len() != 64 || !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(DecodeError::InvalidTopic);
    }
    Ok(format!("0x{}", word[24..].to_ascii_lowercase()))
}

fn decode_u128_word(data: &str) -> Result<u128, DecodeError> {
    let word = strip_0x(data).ok_or(DecodeError::InvalidData)?;
    if word.len() != 64 || !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(DecodeError::InvalidData);
    }
    if word[..32].chars().any(|char| char != '0') {
        return Err(DecodeError::UintOverflow);
    }
    u128::from_str_radix(&word[32..], 16).map_err(|_| DecodeError::InvalidData)
}

fn decode_u32_word(data: &str) -> Result<u32, DecodeError> {
    let word = strip_0x(data).ok_or(DecodeError::InvalidData)?;
    if word.len() != 64 || !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(DecodeError::InvalidData);
    }
    if word[..56].chars().any(|char| char != '0') {
        return Err(DecodeError::UintOverflow);
    }
    u32::from_str_radix(&word[56..], 16).map_err(|_| DecodeError::InvalidData)
}

fn strip_0x(value: &str) -> Option<&str> {
    value.trim().strip_prefix("0x")
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub fn apply_event(
    engine: &Engine,
    state: &mut ProtocolState,
    event: ChainEvent,
) -> Result<bool, EngineError> {
    let id = event.id().to_owned();
    if state.processed_events.contains(&id) {
        return Ok(false);
    }

    match event {
        ChainEvent::RefBound { user, referrer, .. } => {
            // Tolerate the bootstrap RefBound(root, root) emitted by the on-chain
            // constructor — the offchain state already pre-binds the root address.
            if user == referrer && state.is_bound(&user) {
                state.processed_events.insert(id);
                return Ok(false);
            }
            engine.bind(state, user, referrer)?;
        }
        ChainEvent::Deposit { user, amount, .. } => {
            engine.deposit(state, user, amount)?;
        }
    }

    state.processed_events.insert(id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProtocolConfig, BNB};

    #[test]
    fn replay_is_idempotent() {
        let engine = Engine::new(ProtocolConfig::default());
        let mut state = ProtocolState::new("root");
        let event = ChainEvent::RefBound {
            id: "tx1:0".into(),
            user: "alice".into(),
            referrer: "root".into(),
        };
        assert_eq!(apply_event(&engine, &mut state, event.clone()), Ok(true));
        assert_eq!(apply_event(&engine, &mut state, event), Ok(false));

        let deposit = ChainEvent::Deposit {
            id: "tx2:0".into(),
            user: "alice".into(),
            amount: BNB,
        };
        assert_eq!(apply_event(&engine, &mut state, deposit.clone()), Ok(true));
        assert_eq!(apply_event(&engine, &mut state, deposit), Ok(false));
        assert_eq!(state.user("alice").unwrap().principal_bnb, BNB);
    }

    #[test]
    fn decodes_ref_bound_and_deposit_logs() {
        let user = "0000000000000000000000001111111111111111111111111111111111111111";
        let referrer = "0000000000000000000000002222222222222222222222222222222222222222";
        let ref_bound = decode_protocol_log(RawLog {
            block_number: 10,
            block_hash: "0xblock".into(),
            tx_hash: "0xABC".into(),
            log_index: 2,
            topics: vec![
                ref_bound_topic(),
                format!("0x{user}"),
                format!("0x{referrer}"),
            ],
            data: "0x".into(),
        })
        .unwrap()
        .unwrap();
        assert_eq!(ref_bound.id(), "0xabc:2");
        assert!(matches!(ref_bound.event, ChainEvent::RefBound { .. }));

        let deposit = decode_protocol_log(RawLog {
            block_number: 11,
            block_hash: "0xblock2".into(),
            tx_hash: "0xDEF".into(),
            log_index: 0,
            topics: vec![
                deposit_topic(),
                format!("0x{user}"),
                format!("0x{referrer}"),
            ],
            data: format!("0x{:064x}", BNB),
        })
        .unwrap()
        .unwrap();
        assert_eq!(deposit.id(), "0xdef:0");
        assert!(matches!(deposit.event, ChainEvent::Deposit { amount, .. } if amount == BNB));
    }
}
