use std::fmt;

use ethers_core::types::Address;
use serde::{Deserialize, Serialize};

const OWNER_SELECTOR: &str = "0x8da5cb5b";

#[derive(Debug, Clone)]
pub struct BscRpcClient {
    client: reqwest::Client,
    rpc_url: String,
    token_address: Address,
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
        Ok(Self {
            client: reqwest::Client::new(),
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
        u64::from_str_radix(result.trim_start_matches("0x"), 16).map_err(|_| RpcError::InvalidHex)
    }

    async fn eth_call(&self, data: &str) -> Result<String, RpcError> {
        let call = serde_json::json!({
            "to": format_address(self.token_address),
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
}
