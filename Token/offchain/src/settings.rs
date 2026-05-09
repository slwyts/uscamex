use std::env;
use std::fmt;

use crate::state::Address;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorSettings {
    pub database_url: String,
    pub admin_http_addr: String,
    pub bsc_rpc_url: String,
    pub chain_id: u64,
    pub token_address: Address,
    pub pancake_v2_router: Address,
    pub operator_private_key: String,
    pub confirmations: u64,
    pub indexer_start_block: u64,
    pub executor_slippage_bps: u16,
    pub transaction_deadline_seconds: u64,
    pub burn_address: Address,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    Missing(&'static str),
    InvalidNumber(&'static str),
    InvalidAddress(&'static str),
    InvalidPrivateKey,
    WrongChainId,
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for SettingsError {}

impl OperatorSettings {
    pub fn from_env() -> Result<Self, SettingsError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    pub fn from_lookup(
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, SettingsError> {
        let settings = Self {
            database_url: required(&mut lookup, "DATABASE_URL")?,
            admin_http_addr: lookup("ADMIN_HTTP_ADDR")
                .unwrap_or_else(|| "127.0.0.1:8787".to_owned()),
            bsc_rpc_url: required(&mut lookup, "BSC_RPC_URL")?,
            chain_id: parse_u64(&mut lookup, "BSC_CHAIN_ID")?,
            token_address: parse_address(&mut lookup, "TOKEN_ADDRESS")?,
            pancake_v2_router: parse_address(&mut lookup, "PANCAKE_V2_ROUTER")?,
            operator_private_key: required(&mut lookup, "OPERATOR_PRIVATE_KEY")?,
            confirmations: parse_u64(&mut lookup, "CONFIRMATIONS")?,
            indexer_start_block: parse_u64(&mut lookup, "INDEXER_START_BLOCK")?,
            executor_slippage_bps: optional_u16(&mut lookup, "EXECUTOR_SLIPPAGE_BPS", 500)?,
            transaction_deadline_seconds: optional_u64(
                &mut lookup,
                "TRANSACTION_DEADLINE_SECONDS",
                600,
            )?,
            burn_address: optional_address(
                &mut lookup,
                "BURN_ADDRESS",
                "0x000000000000000000000000000000000000dead",
            )?,
        };
        settings.validate()?;
        Ok(settings)
    }

    pub fn validate(&self) -> Result<(), SettingsError> {
        if self.chain_id != 56 {
            return Err(SettingsError::WrongChainId);
        }
        if !looks_like_private_key(&self.operator_private_key) {
            return Err(SettingsError::InvalidPrivateKey);
        }
        if self.executor_slippage_bps > 10_000 {
            return Err(SettingsError::InvalidNumber("EXECUTOR_SLIPPAGE_BPS"));
        }
        Ok(())
    }
}

fn required(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
) -> Result<String, SettingsError> {
    lookup(key)
        .filter(|value| !value.trim().is_empty())
        .ok_or(SettingsError::Missing(key))
}

fn parse_u64(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
) -> Result<u64, SettingsError> {
    required(lookup, key)?
        .parse()
        .map_err(|_| SettingsError::InvalidNumber(key))
}

fn parse_address(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
) -> Result<Address, SettingsError> {
    let value = required(lookup, key)?;
    if value.len() == 42
        && value.starts_with("0x")
        && value[2..].chars().all(|char| char.is_ascii_hexdigit())
    {
        Ok(value)
    } else {
        Err(SettingsError::InvalidAddress(key))
    }
}

fn optional_u64(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: u64,
) -> Result<u64, SettingsError> {
    match lookup(key) {
        Some(value) if !value.trim().is_empty() => {
            value.parse().map_err(|_| SettingsError::InvalidNumber(key))
        }
        _ => Ok(default),
    }
}

fn optional_u16(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: u16,
) -> Result<u16, SettingsError> {
    match lookup(key) {
        Some(value) if !value.trim().is_empty() => {
            value.parse().map_err(|_| SettingsError::InvalidNumber(key))
        }
        _ => Ok(default),
    }
}

fn optional_address(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: &str,
) -> Result<Address, SettingsError> {
    match lookup(key) {
        Some(value) if !value.trim().is_empty() => validate_address(value, key),
        _ => validate_address(default.to_owned(), key),
    }
}

fn validate_address(value: String, key: &'static str) -> Result<Address, SettingsError> {
    if value.len() == 42
        && value.starts_with("0x")
        && value[2..].chars().all(|char| char.is_ascii_hexdigit())
    {
        Ok(value)
    } else {
        Err(SettingsError::InvalidAddress(key))
    }
}

fn looks_like_private_key(value: &str) -> bool {
    let trimmed = value.strip_prefix("0x").unwrap_or(value);
    trimmed.len() == 64 && trimmed.chars().all(|char| char.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn lookup(values: BTreeMap<&'static str, &'static str>) -> impl FnMut(&str) -> Option<String> {
        move |key| values.get(key).map(|value| (*value).to_owned())
    }

    fn valid_values() -> BTreeMap<&'static str, &'static str> {
        BTreeMap::from([
            (
                "DATABASE_URL",
                "postgres://uscamex:uscamex@127.0.0.1:5432/uscamex_operator",
            ),
            ("BSC_RPC_URL", "https://bsc-dataseed.binance.org"),
            ("ADMIN_HTTP_ADDR", "127.0.0.1:8787"),
            ("BSC_CHAIN_ID", "56"),
            (
                "TOKEN_ADDRESS",
                "0x1111111111111111111111111111111111111111",
            ),
            (
                "PANCAKE_V2_ROUTER",
                "0x10ED43C718714eb63d5aA57B78B54704E256024E",
            ),
            (
                "OPERATOR_PRIVATE_KEY",
                "0x1111111111111111111111111111111111111111111111111111111111111111",
            ),
            ("CONFIRMATIONS", "6"),
            ("INDEXER_START_BLOCK", "123"),
        ])
    }

    #[test]
    fn settings_parse_and_validate_production_env() {
        let settings = OperatorSettings::from_lookup(lookup(valid_values())).unwrap();
        assert_eq!(settings.chain_id, 56);
        assert_eq!(settings.confirmations, 6);
        assert_eq!(settings.admin_http_addr, "127.0.0.1:8787");
        assert_eq!(settings.executor_slippage_bps, 500);
        assert_eq!(settings.transaction_deadline_seconds, 600);
        assert_eq!(
            settings.burn_address,
            "0x000000000000000000000000000000000000dead"
        );
    }

    #[test]
    fn settings_accept_executor_overrides() {
        let mut values = valid_values();
        values.insert("EXECUTOR_SLIPPAGE_BPS", "250");
        values.insert("TRANSACTION_DEADLINE_SECONDS", "1200");
        values.insert("BURN_ADDRESS", "0x000000000000000000000000000000000000dEaD");
        let settings = OperatorSettings::from_lookup(lookup(values)).unwrap();
        assert_eq!(settings.executor_slippage_bps, 250);
        assert_eq!(settings.transaction_deadline_seconds, 1200);
        assert_eq!(
            settings.burn_address,
            "0x000000000000000000000000000000000000dEaD"
        );
    }

    #[test]
    fn settings_reject_wrong_chain() {
        let mut values = valid_values();
        values.insert("BSC_CHAIN_ID", "97");
        assert_eq!(
            OperatorSettings::from_lookup(lookup(values)),
            Err(SettingsError::WrongChainId)
        );
    }

    #[test]
    fn settings_reject_placeholder_private_key() {
        let mut values = valid_values();
        values.insert("OPERATOR_PRIVATE_KEY", "replace-me");
        assert_eq!(
            OperatorSettings::from_lookup(lookup(values)),
            Err(SettingsError::InvalidPrivateKey)
        );
    }
}
