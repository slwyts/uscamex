use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::indexer::{
    deposit_topic, node_updated_topic, protocol_config_updated_topic, ref_bound_topic,
    tax_collected_topic, RawLog,
};

const RECENT_HEAD_LIMIT: usize = 512;
const LOG_QUEUE_LIMIT: usize = 10_000;

#[derive(Debug, Clone)]
pub struct WsRpcConfig {
    pub url: String,
    pub token_address: String,
    pub reconnect_min: Duration,
    pub reconnect_max: Duration,
    pub stale_after: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct WsRuntimeState {
    inner: Arc<Mutex<WsRuntimeInner>>,
}

#[derive(Debug, Default)]
struct WsRuntimeInner {
    connected: bool,
    first_head: Option<u64>,
    last_message_at: Option<Instant>,
    last_head: Option<WsHead>,
    recent_heads: BTreeMap<u64, String>,
    logs: VecDeque<RawLog>,
    log_ids: HashSet<String>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsHead {
    pub number: u64,
    pub hash: String,
}

#[derive(Debug, Clone)]
pub struct WsSnapshot {
    pub connected: bool,
    pub stale: bool,
    pub first_head: Option<u64>,
    pub last_head: Option<WsHead>,
    pub queued_logs: usize,
    pub last_error: Option<String>,
}

#[derive(Debug)]
pub enum WsError {
    Json(serde_json::Error),
    InvalidHex,
}

impl fmt::Display for WsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for WsError {}

impl From<serde_json::Error> for WsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl WsRuntimeState {
    pub fn snapshot(&self, stale_after: Duration) -> WsSnapshot {
        let Ok(inner) = self.inner.lock() else {
            return WsSnapshot {
                connected: false,
                stale: true,
                first_head: None,
                last_head: None,
                queued_logs: 0,
                last_error: Some("ws state lock poisoned".to_owned()),
            };
        };
        let stale = inner
            .last_message_at
            .map(|last_message_at| last_message_at.elapsed() > stale_after)
            .unwrap_or(true);
        WsSnapshot {
            connected: inner.connected,
            stale,
            first_head: inner.first_head,
            last_head: inner.last_head.clone(),
            queued_logs: inner.logs.len(),
            last_error: inner.last_error.clone(),
        }
    }

    pub fn recent_head_hash(&self, block_number: u64) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.recent_heads.get(&block_number).cloned())
    }

    pub fn drain_logs(&self, from_block: u64, to_block: u64) -> Vec<RawLog> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut kept = VecDeque::with_capacity(inner.logs.len());
        let mut drained = Vec::new();
        while let Some(log) = inner.logs.pop_front() {
            let id = log_id(&log);
            if log.block_number < from_block {
                inner.log_ids.remove(&id);
                continue;
            }
            if log.block_number <= to_block {
                inner.log_ids.remove(&id);
                drained.push(log);
            } else {
                kept.push_back(log);
            }
        }
        inner.logs = kept;
        drained.sort_by_key(|log| (log.block_number, log.log_index));
        drained
    }

    fn mark_connected(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = true;
            inner.last_message_at = Some(Instant::now());
            inner.last_error = None;
        }
    }

    fn mark_disconnected(&self, error: impl Into<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = false;
            inner.last_error = Some(error.into());
        }
    }

    fn record_head(&self, head: WsHead) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = true;
            inner.last_message_at = Some(Instant::now());
            if inner.first_head.is_none() {
                inner.first_head = Some(head.number);
            }
            inner.recent_heads.insert(head.number, head.hash.clone());
            while inner.recent_heads.len() > RECENT_HEAD_LIMIT {
                if let Some(first) = inner.recent_heads.keys().next().copied() {
                    inner.recent_heads.remove(&first);
                }
            }
            inner.last_head = Some(head);
            inner.last_error = None;
        }
    }

    fn push_log(&self, log: RawLog) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connected = true;
            inner.last_message_at = Some(Instant::now());
            let id = log_id(&log);
            if inner.log_ids.insert(id.clone()) {
                inner.logs.push_back(log);
            }
            while inner.logs.len() > LOG_QUEUE_LIMIT {
                if let Some(old) = inner.logs.pop_front() {
                    inner.log_ids.remove(&log_id(&old));
                }
            }
            inner.last_error = None;
        }
    }
}

pub fn spawn_ws_listener(
    config: WsRpcConfig,
    state: WsRuntimeState,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut backoff = config.reconnect_min;
        loop {
            match run_ws_session(&config, &state).await {
                Ok(()) => state.mark_disconnected("websocket session ended"),
                Err(error) => state.mark_disconnected(error),
            }
            eprintln!("ws rpc reconnecting in {:?}", backoff);
            tokio::time::sleep(backoff).await;
            backoff = backoff.saturating_mul(2).min(config.reconnect_max);
        }
    })
}

async fn run_ws_session(config: &WsRpcConfig, state: &WsRuntimeState) -> Result<(), String> {
    let (socket, _) = connect_async(&config.url)
        .await
        .map_err(|error| format!("ws connect failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();
    writer
        .send(Message::Text(subscribe_new_heads_request()))
        .await
        .map_err(|error| format!("ws subscribe newHeads failed: {error}"))?;
    writer
        .send(Message::Text(subscribe_logs_request(&config.token_address)))
        .await
        .map_err(|error| format!("ws subscribe logs failed: {error}"))?;
    state.mark_connected();
    println!("ws rpc connected: {}", redact_ws_url(&config.url));

    while let Some(message) = reader.next().await {
        match message.map_err(|error| format!("ws read failed: {error}"))? {
            Message::Text(text) => {
                handle_ws_text(&text, state).map_err(|error| error.to_string())?
            }
            Message::Binary(bytes) => {
                if let Ok(text) = String::from_utf8(bytes) {
                    handle_ws_text(&text, state).map_err(|error| error.to_string())?;
                }
            }
            Message::Ping(payload) => writer
                .send(Message::Pong(payload))
                .await
                .map_err(|error| format!("ws pong failed: {error}"))?,
            Message::Close(frame) => return Err(format!("ws closed: {frame:?}")),
            _ => {}
        }
    }
    Ok(())
}

fn handle_ws_text(text: &str, state: &WsRuntimeState) -> Result<(), WsError> {
    if let Ok(notification) = serde_json::from_str::<WsNotification>(text) {
        match notification.params.result {
            WsNotificationResult::Header(header) => {
                state.record_head(WsHead {
                    number: parse_hex_u64(&header.number)?,
                    hash: header.hash.to_ascii_lowercase(),
                });
            }
            WsNotificationResult::Log(log) => {
                if !log.removed.unwrap_or(false) {
                    state.push_log(raw_log_from_ws(log)?);
                }
            }
        }
    }
    Ok(())
}

fn subscribe_new_heads_request() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_subscribe",
        "params": ["newHeads"],
    })
    .to_string()
}

fn subscribe_logs_request(token_address: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "eth_subscribe",
        "params": ["logs", protocol_log_filter(token_address)],
    })
    .to_string()
}

pub fn protocol_log_filter(token_address: &str) -> serde_json::Value {
    serde_json::json!({
        "address": token_address.to_ascii_lowercase(),
        "topics": [[
            ref_bound_topic(),
            deposit_topic(),
            tax_collected_topic(),
            protocol_config_updated_topic(),
            node_updated_topic(),
        ]],
    })
}

fn raw_log_from_ws(log: WsLog) -> Result<RawLog, WsError> {
    let log_index = parse_hex_u64(&log.log_index)?;
    Ok(RawLog {
        block_number: parse_hex_u64(&log.block_number)?,
        block_hash: log.block_hash.to_ascii_lowercase(),
        tx_hash: log.transaction_hash.to_ascii_lowercase(),
        log_index: u32::try_from(log_index).map_err(|_| WsError::InvalidHex)?,
        topics: log
            .topics
            .into_iter()
            .map(|topic| topic.to_ascii_lowercase())
            .collect(),
        data: log.data,
    })
}

fn parse_hex_u64(value: &str) -> Result<u64, WsError> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16).map_err(|_| WsError::InvalidHex)
}

fn log_id(log: &RawLog) -> String {
    format!("{}:{}", log.tx_hash, log.log_index)
}

fn redact_ws_url(url: &str) -> String {
    let Some((prefix, rest)) = url.split_once("://") else {
        return "<redacted>".to_owned();
    };
    let host = rest.split('/').next().unwrap_or("<redacted>");
    format!("{prefix}://{host}/...")
}

#[derive(Debug, Deserialize)]
struct WsNotification {
    params: WsNotificationParams,
}

#[derive(Debug, Deserialize)]
struct WsNotificationParams {
    result: WsNotificationResult,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum WsNotificationResult {
    Header(WsHeader),
    Log(WsLog),
}

#[derive(Debug, Deserialize)]
struct WsHeader {
    number: String,
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsLog {
    block_number: String,
    block_hash: String,
    transaction_hash: String,
    log_index: String,
    topics: Vec<String>,
    data: String,
    removed: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_new_head_notification() {
        let state = WsRuntimeState::default();
        handle_ws_text(
            r#"{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x1","result":{"number":"0x2a","hash":"0xABC"}}}"#,
            &state,
        )
        .unwrap();
        let snapshot = state.snapshot(Duration::from_secs(30));
        assert!(snapshot.connected);
        assert_eq!(snapshot.first_head, Some(42));
        assert_eq!(snapshot.last_head.unwrap().hash, "0xabc");
    }

    #[test]
    fn parses_and_dedupes_log_notification() {
        let state = WsRuntimeState::default();
        let text = r#"{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x2","result":{"blockNumber":"0x2a","blockHash":"0xdef","transactionHash":"0xaaa","logIndex":"0x1","topics":["0x111"],"data":"0x","removed":false}}}"#;
        handle_ws_text(text, &state).unwrap();
        handle_ws_text(text, &state).unwrap();
        let logs = state.drain_logs(1, 100);
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].block_number, 42);
        assert_eq!(logs[0].log_index, 1);
    }

    #[test]
    fn protocol_filter_contains_topic_group() {
        let filter = protocol_log_filter("0x1111111111111111111111111111111111111111");
        assert!(filter.get("topics").is_some());
        assert_eq!(
            filter.get("address").and_then(|value| value.as_str()),
            Some("0x1111111111111111111111111111111111111111")
        );
    }
}
