use std::fmt;

use serde::{Deserialize, Serialize};

pub type Wei = u128;
pub type Bps = u16;

pub const BNB: Wei = 1_000_000_000_000_000_000;
pub const BPS_DENOMINATOR: Wei = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolConfig {
    pub min_deposit: Wei,
    pub max_deposit: Wei,
    pub lp_build_bps: Bps,
    pub node_bps: Bps,
    pub builder_buy_bps: Bps,
    pub vault_bps: Bps,
    pub direct_pool_bps: Bps,
    pub direct_reward_bps: Bps,
    pub daily_static_bps: Bps,
    pub settlement_periods_per_day: u8,
    pub exit_multiple_bps: u32,
    pub team_reward_bps: [Bps; 10],
    pub deflation_enabled: bool,
    pub deflation_hourly_bps: Bps,
    pub deflation_daily_cap_bps: Bps,
    pub buyback_enabled: bool,
    pub buyback_per_minute: Wei,
    pub buy_tax_bps: Bps,
    pub buy_tax_builder_bps: Bps,
    pub buy_tax_vault_bps: Bps,
    pub sell_tax_bps: Bps,
    pub sell_tax_builder_bps: Bps,
    pub sell_tax_owner_bps: Bps,
    pub sell_tax_vault_bps: Bps,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidDepositRange,
    InvalidDistribution,
    InvalidSettlementPeriods,
    InvalidExitMultiple,
    InvalidDeflation,
    InvalidTaxSplit,
    InvalidBnbAmount,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ConfigError {}

impl Default for ProtocolConfig {
    fn default() -> Self {
        Self {
            min_deposit: BNB / 10,
            max_deposit: 5 * BNB,
            lp_build_bps: 6_000,
            node_bps: 1_000,
            builder_buy_bps: 1_000,
            vault_bps: 1_000,
            direct_pool_bps: 1_000,
            direct_reward_bps: 1_000,
            daily_static_bps: 80,
            settlement_periods_per_day: 4,
            exit_multiple_bps: 30_000,
            team_reward_bps: [1_000, 900, 800, 700, 600, 500, 500, 500, 500, 500],
            deflation_enabled: true,
            deflation_hourly_bps: 10,
            deflation_daily_cap_bps: 200,
            buyback_enabled: true,
            buyback_per_minute: BNB / 10,
            buy_tax_bps: 300,
            buy_tax_builder_bps: 100,
            buy_tax_vault_bps: 200,
            sell_tax_bps: 1_000,
            sell_tax_builder_bps: 300,
            sell_tax_owner_bps: 300,
            sell_tax_vault_bps: 400,
        }
    }
}

impl ProtocolConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.min_deposit > self.max_deposit {
            return Err(ConfigError::InvalidDepositRange);
        }
        let distribution_total = u32::from(self.lp_build_bps)
            + u32::from(self.node_bps)
            + u32::from(self.builder_buy_bps)
            + u32::from(self.vault_bps)
            + u32::from(self.direct_pool_bps);
        if distribution_total > BPS_DENOMINATOR as u32
            || self.direct_reward_bps > self.direct_pool_bps
        {
            return Err(ConfigError::InvalidDistribution);
        }
        if self.settlement_periods_per_day == 0 {
            return Err(ConfigError::InvalidSettlementPeriods);
        }
        if self.exit_multiple_bps == 0 {
            return Err(ConfigError::InvalidExitMultiple);
        }
        if self.deflation_hourly_bps > self.deflation_daily_cap_bps
            || self.deflation_daily_cap_bps > BPS_DENOMINATOR as Bps
        {
            return Err(ConfigError::InvalidDeflation);
        }
        if self
            .team_reward_bps
            .iter()
            .any(|rate| *rate > BPS_DENOMINATOR as Bps)
            || self.buy_tax_bps > 2_500
            || self.sell_tax_bps > 2_500
            || self.buy_tax_builder_bps + self.buy_tax_vault_bps > self.buy_tax_bps
            || self.sell_tax_builder_bps + self.sell_tax_owner_bps + self.sell_tax_vault_bps
                > self.sell_tax_bps
        {
            return Err(ConfigError::InvalidTaxSplit);
        }
        Ok(())
    }
}

pub fn bps(amount: Wei, rate: impl Into<Wei>) -> Wei {
    amount.saturating_mul(rate.into()) / BPS_DENOMINATOR
}

pub fn parse_bnb_amount(value: &str) -> Result<Wei, ConfigError> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty() || !whole.chars().all(|char| char.is_ascii_digit()) {
        return Err(ConfigError::InvalidBnbAmount);
    }
    if fraction.len() > 18 || !fraction.chars().all(|char| char.is_ascii_digit()) {
        return Err(ConfigError::InvalidBnbAmount);
    }
    let whole_wei = whole
        .parse::<Wei>()
        .map_err(|_| ConfigError::InvalidBnbAmount)?
        .checked_mul(BNB)
        .ok_or(ConfigError::InvalidBnbAmount)?;
    let mut fraction_text = fraction.to_owned();
    while fraction_text.len() < 18 {
        fraction_text.push('0');
    }
    let fraction_wei = if fraction_text.is_empty() {
        0
    } else {
        fraction_text
            .parse::<Wei>()
            .map_err(|_| ConfigError::InvalidBnbAmount)?
    };
    whole_wei
        .checked_add(fraction_wei)
        .ok_or(ConfigError::InvalidBnbAmount)
}

pub fn format_bnb_amount(wei: Wei) -> String {
    let whole = wei / BNB;
    let fraction = format!("{:018}", wei % BNB)
        .trim_end_matches('0')
        .to_owned();
    if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        assert_eq!(ProtocolConfig::default().validate(), Ok(()));
    }

    #[test]
    fn bnb_amount_roundtrips_decimal_text() {
        assert_eq!(parse_bnb_amount("0.1"), Ok(BNB / 10));
        assert_eq!(format_bnb_amount(5 * BNB), "5");
        assert_eq!(format_bnb_amount(BNB / 10), "0.1");
    }
}
