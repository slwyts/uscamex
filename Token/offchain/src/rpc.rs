use std::fmt;

use crate::config::ProtocolConfig;
use crate::indexer::{
    deposit_topic, node_updated_topic, protocol_config_updated_topic, ref_bound_topic, RawLog,
};
use crate::state::Node;
use ethers_core::types::Address;
use serde::{Deserialize, Serialize};

const OWNER_SELECTOR: &str = "0x8da5cb5b";

#[derive(Debug, Clone)]
pub struct BscRpcClient {
    client: reqwest::Client,
    rpc_url: String,
    token_address: Address,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairReserves {
    pub pair: String,
    pub token_reserve: u128,
    pub bnb_reserve: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainProtocolConfig {
    pub operator: String,
    pub buy_enabled: bool,
    pub config: ProtocolConfig,
}

#[derive(Debug)]
pub enum RpcError {
    Http(reqwest::Error),
    Rpc(String),
    InvalidAddress,
    InvalidHex,
    MissingResult,
}

impl fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for RpcError {}

impl From<reqwest::Error> for RpcError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl BscRpcClient {
    pub fn new(rpc_url: impl Into<String>, token_address: &str) -> Result<Self, RpcError> {
        let token_address = parse_address(token_address)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(RpcError::Http)?;
        Ok(Self {
            client,
            rpc_url: rpc_url.into(),
            token_address,
        })
    }

    pub fn token_address(&self) -> Address {
        self.token_address
    }

    pub async fn owner(&self) -> Result<Address, RpcError> {
        let output = self.eth_call(OWNER_SELECTOR).await?;
        parse_address_word(&output)
    }

    pub async fn vault(&self) -> Result<Address, RpcError> {
        let data = function_selector("vault()");
        let output = self.eth_call(&data).await?;
        parse_address_word(&output)
    }

    pub async fn pair(&self) -> Result<Address, RpcError> {
        let data = function_selector("pair()");
        let output = self.eth_call(&data).await?;
        parse_address_word(&output)
    }

    pub async fn protocol_config(&self) -> Result<ChainProtocolConfig, RpcError> {
        let output = self
            .eth_call(&function_selector("getProtocolConfig()"))
            .await?;
        let mut team_reward_bps = [0u16; 10];
        for (index, rate) in team_reward_bps.iter_mut().enumerate() {
            *rate = parse_u16_word(&output, 15 + index)?;
        }
        let config = ProtocolConfig {
            min_deposit: parse_u128_word(&output, 3)?,
            max_deposit: parse_u128_word(&output, 4)?,
            lp_build_bps: parse_u16_word(&output, 6)?,
            node_bps: parse_u16_word(&output, 7)?,
            builder_buy_bps: parse_u16_word(&output, 8)?,
            vault_bps: parse_u16_word(&output, 9)?,
            direct_pool_bps: parse_u16_word(&output, 10)?,
            direct_reward_bps: parse_u16_word(&output, 11)?,
            daily_static_bps: parse_u16_word(&output, 12)?,
            settlement_periods_per_day: parse_u8_word(&output, 13)?,
            exit_multiple_bps: parse_u32_word(&output, 14)?,
            team_reward_bps,
            deflation_enabled: parse_bool_word(&output, 25)?,
            deflation_hourly_bps: parse_u16_word(&output, 26)?,
            deflation_daily_cap_bps: parse_u16_word(&output, 27)?,
            buyback_enabled: parse_bool_word(&output, 28)?,
            buyback_per_minute: parse_u128_word(&output, 29)?,
            buy_tax_bps: parse_u16_word(&output, 1)?,
            buy_tax_builder_bps: parse_u16_word(&output, 30)?,
            buy_tax_vault_bps: parse_u16_word(&output, 31)?,
            sell_tax_bps: parse_u16_word(&output, 2)?,
            sell_tax_builder_bps: parse_u16_word(&output, 32)?,
            sell_tax_owner_bps: parse_u16_word(&output, 33)?,
            sell_tax_vault_bps: parse_u16_word(&output, 34)?,
        };
        config
            .validate()
            .map_err(|error| RpcError::Rpc(format!("invalid protocol config: {error}")))?;
        Ok(ChainProtocolConfig {
            operator: format_address(parse_address_word_at(&output, 0)?),
            buy_enabled: parse_bool_word(&output, 5)?,
            config,
        })
    }

    pub async fn nodes(&self) -> Result<Vec<Node>, RpcError> {
        let count_output = self.eth_call(&function_selector("nodeCount()")).await?;
        let count = usize::try_from(parse_u128_word(&count_output, 0)?)
            .map_err(|_| RpcError::InvalidHex)?;
        let mut nodes = Vec::with_capacity(count);
        for index in 0..count {
            let data = format!(
                "{}{}",
                function_selector("nodeAt(uint256)"),
                u256_word(index as u128)
            );
            let output = self.eth_call(&data).await?;
            let address = format_address(parse_address_word_at(&output, 0)?);
            let weight = parse_u32_word(&output, 1)?;
            if weight != 0 {
                nodes.push(Node { address, weight });
            }
        }
        Ok(nodes)
    }

    pub async fn pair_reserves(&self) -> Result<Option<PairReserves>, RpcError> {
        let pair = self.pair().await?;
        if pair == Address::zero() {
            return Ok(None);
        }
        let token0 = parse_address_word(
            &self
                .eth_call_to(pair, &function_selector("token0()"))
                .await?,
        )?;
        let reserves = self
            .eth_call_to(pair, &function_selector("getReserves()"))
            .await?;
        let reserve0 = parse_u128_word(&reserves, 0)?;
        let reserve1 = parse_u128_word(&reserves, 1)?;
        let (token_reserve, bnb_reserve) = if token0 == self.token_address {
            (reserve0, reserve1)
        } else {
            (reserve1, reserve0)
        };
        Ok(Some(PairReserves {
            pair: format_address(pair),
            token_reserve,
            bnb_reserve,
        }))
    }

    pub async fn block_number(&self) -> Result<u64, RpcError> {
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method: "eth_blockNumber",
                params: Vec::<serde_json::Value>::new(),
            })
            .send()
            .await?
            .error_for_status()?
            .json::<JsonRpcResponse<String>>()
            .await?;
        if let Some(error) = response.error {
            return Err(RpcError::Rpc(error.message));
        }
        let result = response.result.ok_or(RpcError::MissingResult)?;
        parse_hex_u64(&result)
    }

    pub async fn block_hash(&self, block_number: u64) -> Result<String, RpcError> {
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getBlockByNumber",
                params: vec![
                    serde_json::Value::String(hex_quantity(block_number)),
                    serde_json::Value::Bool(false),
                ],
            })
            .send()
            .await?
            .error_for_status()?
            .json::<JsonRpcResponse<Option<JsonRpcBlock>>>()
            .await?;
        if let Some(error) = response.error {
            return Err(RpcError::Rpc(error.message));
        }
        response
            .result
            .flatten()
            .map(|block| block.hash.to_ascii_lowercase())
            .ok_or(RpcError::MissingResult)
    }

    pub async fn protocol_logs(
        &self,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<RawLog>, RpcError> {
        let filter = serde_json::json!({
            "address": format_address(self.token_address),
            "fromBlock": hex_quantity(from_block),
            "toBlock": hex_quantity(to_block),
            "topics": [[
                ref_bound_topic(),
                deposit_topic(),
                protocol_config_updated_topic(),
                node_updated_topic(),
            ]],
        });
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getLogs",
                params: vec![filter],
            })
            .send()
            .await?
            .error_for_status()?
            .json::<JsonRpcResponse<Vec<JsonRpcLog>>>()
            .await?;
        if let Some(error) = response.error {
            return Err(RpcError::Rpc(error.message));
        }
        response
            .result
            .ok_or(RpcError::MissingResult)?
            .into_iter()
            .filter(|log| !log.removed.unwrap_or(false))
            .map(raw_log_from_rpc)
            .collect()
    }

    async fn eth_call(&self, data: &str) -> Result<String, RpcError> {
        self.eth_call_to(self.token_address, data).await
    }

    async fn eth_call_to(&self, target: Address, data: &str) -> Result<String, RpcError> {
        let call = serde_json::json!({
            "to": format_address(target),
            "data": data,
        });
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&JsonRpcRequest {
                jsonrpc: "2.0",
                id: 1,
                method: "eth_call",
                params: vec![call, serde_json::Value::String("latest".to_owned())],
            })
            .send()
            .await?
            .error_for_status()?
            .json::<JsonRpcResponse<String>>()
            .await?;
        if let Some(error) = response.error {
            return Err(RpcError::Rpc(error.message));
        }
        response.result.ok_or(RpcError::MissingResult)
    }
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest<P> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: P,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct JsonRpcBlock {
    hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcLog {
    block_number: String,
    block_hash: String,
    transaction_hash: String,
    log_index: String,
    topics: Vec<String>,
    data: String,
    removed: Option<bool>,
}

fn raw_log_from_rpc(log: JsonRpcLog) -> Result<RawLog, RpcError> {
    let log_index = parse_hex_u64(&log.log_index)?;
    Ok(RawLog {
        block_number: parse_hex_u64(&log.block_number)?,
        block_hash: log.block_hash.to_ascii_lowercase(),
        tx_hash: log.transaction_hash.to_ascii_lowercase(),
        log_index: u32::try_from(log_index).map_err(|_| RpcError::InvalidHex)?,
        topics: log
            .topics
            .into_iter()
            .map(|topic| topic.to_ascii_lowercase())
            .collect(),
        data: log.data,
    })
}

fn parse_hex_u64(value: &str) -> Result<u64, RpcError> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16).map_err(|_| RpcError::InvalidHex)
}

fn hex_quantity(value: u64) -> String {
    format!("0x{value:x}")
}

fn function_selector(signature: &str) -> String {
    let hash = ethers_core::utils::keccak256(signature.as_bytes());
    format!("0x{}", hex_encode(&hash[..4]))
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

pub fn parse_address(value: &str) -> Result<Address, RpcError> {
    let trimmed = value
        .trim()
        .strip_prefix("0x")
        .ok_or(RpcError::InvalidAddress)?;
    if trimmed.len() != 40 || !trimmed.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(RpcError::InvalidAddress);
    }
    let mut bytes = [0u8; 20];
    for index in 0..20 {
        bytes[index] = u8::from_str_radix(&trimmed[index * 2..index * 2 + 2], 16)
            .map_err(|_| RpcError::InvalidHex)?;
    }
    Ok(Address::from(bytes))
}

pub fn parse_address_word(value: &str) -> Result<Address, RpcError> {
    let trimmed = value
        .trim()
        .strip_prefix("0x")
        .ok_or(RpcError::InvalidHex)?;
    if trimmed.len() != 64 || !trimmed.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(RpcError::InvalidHex);
    }
    parse_address(&format!("0x{}", &trimmed[24..]))
}

fn parse_address_word_at(value: &str, index: usize) -> Result<Address, RpcError> {
    parse_address(&format!("0x{}", &word_at(value, index)?[24..]))
}

fn parse_u128_word(value: &str, index: usize) -> Result<u128, RpcError> {
    let word = word_at(value, index)?;
    if word[..32].chars().any(|char| char != '0') {
        return Err(RpcError::InvalidHex);
    }
    u128::from_str_radix(&word[32..], 16).map_err(|_| RpcError::InvalidHex)
}

fn parse_u32_word(value: &str, index: usize) -> Result<u32, RpcError> {
    let value = parse_u128_word(value, index)?;
    u32::try_from(value).map_err(|_| RpcError::InvalidHex)
}

fn parse_u16_word(value: &str, index: usize) -> Result<u16, RpcError> {
    let value = parse_u128_word(value, index)?;
    u16::try_from(value).map_err(|_| RpcError::InvalidHex)
}

fn parse_u8_word(value: &str, index: usize) -> Result<u8, RpcError> {
    let value = parse_u128_word(value, index)?;
    u8::try_from(value).map_err(|_| RpcError::InvalidHex)
}

fn parse_bool_word(value: &str, index: usize) -> Result<bool, RpcError> {
    match parse_u128_word(value, index)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(RpcError::InvalidHex),
    }
}

fn word_at(value: &str, index: usize) -> Result<&str, RpcError> {
    let trimmed = value
        .trim()
        .strip_prefix("0x")
        .ok_or(RpcError::InvalidHex)?;
    let start = index.checked_mul(64).ok_or(RpcError::InvalidHex)?;
    let end = start.checked_add(64).ok_or(RpcError::InvalidHex)?;
    let word = trimmed.get(start..end).ok_or(RpcError::InvalidHex)?;
    if !word.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(RpcError::InvalidHex);
    }
    Ok(word)
}

fn u256_word(value: u128) -> String {
    format!("{value:064x}")
}

pub fn format_address(address: Address) -> String {
    format!("{address:#x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_address_from_abi_word() {
        let word = "0x0000000000000000000000001111111111111111111111111111111111111111";
        assert_eq!(
            format_address(parse_address_word(word).unwrap()),
            "0x1111111111111111111111111111111111111111"
        );
    }

    #[test]
    fn rejects_bad_addresses() {
        assert_eq!(
            parse_address("0x123").unwrap_err().to_string(),
            "InvalidAddress"
        );
        assert_eq!(
            parse_address_word("0x123").unwrap_err().to_string(),
            "InvalidHex"
        );
    }

    #[test]
    fn parses_rpc_log_quantities() {
        assert_eq!(parse_hex_u64("0x2a").unwrap(), 42);
        assert_eq!(hex_quantity(42), "0x2a");
        assert_eq!(function_selector("owner()"), OWNER_SELECTOR);
        let output = format!("0x{:064x}{:064x}", 10u128, 20u128);
        assert_eq!(parse_u128_word(&output, 0).unwrap(), 10);
        assert_eq!(parse_u128_word(&output, 1).unwrap(), 20);
    }
}
