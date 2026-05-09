use std::fmt;

use crate::config::{bps, ProtocolConfig, Wei, BPS_DENOMINATOR};
use crate::state::{Address, ProtocolState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    SelfReferral,
    ReferrerNotBound,
    UserNotBound,
    DepositOutOfRange,
    InactivePosition,
    InvalidConfig,
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for EngineError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositAllocation {
    pub user: Address,
    pub amount: Wei,
    pub lp_bnb: Wei,
    pub lp_token_value_bnb: Wei,
    pub node_payouts: Vec<BnbPayout>,
    pub node_bnb: Wei,
    pub builder_bnb: Wei,
    pub vault_bnb: Wei,
    pub direct_bnb: Wei,
    pub direct_referrer: Option<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BnbPayout {
    pub to: Address,
    pub amount: Wei,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewardPayout {
    pub user: Address,
    pub amount: Wei,
    pub generation: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticSettlement {
    pub user: Address,
    pub static_bnb: Wei,
    pub team_rewards: Vec<RewardPayout>,
    pub exited: bool,
    pub exit_refund_bnb: Option<Wei>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxAllocation {
    pub side: TaxSide,
    pub gross_bnb_value: Wei,
    pub total_tax_bnb: Wei,
    pub builder_token_value_bnb: Wei,
    pub vault_bnb: Wei,
    pub owner_bnb: Wei,
    pub burned_token_value_bnb: Wei,
}

#[derive(Debug, Clone)]
pub struct Engine {
    pub config: ProtocolConfig,
}

impl Engine {
    pub fn new(config: ProtocolConfig) -> Self {
        Self { config }
    }

    pub fn bind(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
        referrer: impl Into<Address>,
    ) -> Result<bool, EngineError> {
        let user = user.into();
        let referrer = referrer.into();
        if user == referrer {
            return Err(EngineError::SelfReferral);
        }
        if state.is_bound(&user) {
            return Ok(false);
        }
        if !state.is_bound(&referrer) {
            return Err(EngineError::ReferrerNotBound);
        }
        state.ensure_user_mut(&user).referrer = Some(referrer.clone());
        state.ensure_user_mut(&referrer).direct_count += 1;
        Ok(true)
    }

    pub fn deposit(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
        amount: Wei,
    ) -> Result<DepositAllocation, EngineError> {
        let user = user.into();
        if amount < self.config.min_deposit || amount > self.config.max_deposit {
            return Err(EngineError::DepositOutOfRange);
        }
        if !state.is_bound(&user) {
            return Err(EngineError::UserNotBound);
        }
        self.validate_distribution()?;

        let lp_total = bps(amount, self.config.lp_build_bps);
        let lp_bnb = lp_total / 2;
        let lp_token_value_bnb = lp_total - lp_bnb;
        let node_payouts = self.distribute_nodes(state, bps(amount, self.config.node_bps));
        let node_bnb = node_payouts.iter().map(|payout| payout.amount).sum();
        let builder_bnb = bps(amount, self.config.builder_buy_bps);
        let vault_base = bps(amount, self.config.vault_bps);
        let direct_pool = bps(amount, self.config.direct_pool_bps);
        let direct_referrer = state
            .user(&user)
            .and_then(|account| account.referrer.clone());
        let direct_bnb = direct_referrer
            .as_ref()
            .filter(|referrer| *referrer != &user)
            .map(|_| bps(amount, self.config.direct_reward_bps))
            .unwrap_or(0);
        let direct_remainder = direct_pool.saturating_sub(direct_bnb);

        state.pair.bnb_reserve = state.pair.bnb_reserve.saturating_add(lp_bnb);
        state.balances.builder_token_value_bnb = state
            .balances
            .builder_token_value_bnb
            .saturating_add(builder_bnb);
        state.balances.vault_bnb = state
            .balances
            .vault_bnb
            .saturating_add(vault_base + direct_remainder);
        if let Some(referrer) = direct_referrer.as_ref() {
            if direct_bnb != 0 {
                *state
                    .balances
                    .direct_paid_bnb
                    .entry(referrer.clone())
                    .or_default() += direct_bnb;
            }
        }

        let account = state.ensure_user_mut(&user);
        if account.exited && !account.active {
            account.position_id += 1;
            account.principal_bnb = 0;
            account.static_paid_bnb = 0;
            account.dynamic_paid_bnb = 0;
        }
        account.principal_bnb = account.principal_bnb.saturating_add(amount);
        account.active = true;
        account.exited = false;

        Ok(DepositAllocation {
            user,
            amount,
            lp_bnb,
            lp_token_value_bnb,
            node_payouts,
            node_bnb,
            builder_bnb,
            vault_bnb: vault_base + direct_remainder,
            direct_bnb,
            direct_referrer,
        })
    }

    pub fn settle_static_period_once(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
        period_key: impl Into<String>,
    ) -> Result<Option<StaticSettlement>, EngineError> {
        let user = user.into();
        let period_key = period_key.into();
        let id = format!("static:{user}:{period_key}");
        if state.processed_settlements.contains(&id) {
            return Ok(None);
        }
        let settlement = self.settle_static_period(state, user)?;
        state.processed_settlements.insert(id);
        Ok(Some(settlement))
    }

    pub fn settle_static_period(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
    ) -> Result<StaticSettlement, EngineError> {
        let user = user.into();
        let account = state.user(&user).ok_or(EngineError::UserNotBound)?;
        if !account.active || account.principal_bnb == 0 {
            return Err(EngineError::InactivePosition);
        }
        if self.config.settlement_periods_per_day == 0 {
            return Err(EngineError::InvalidConfig);
        }

        let static_bnb = bps(account.principal_bnb, self.config.daily_static_bps)
            / Wei::from(self.config.settlement_periods_per_day);
        let ancestors = self.ancestors(state, &user, 10);
        let mut team_rewards = Vec::new();

        state.ensure_user_mut(&user).static_paid_bnb += static_bnb;
        for (index, ancestor) in ancestors.iter().enumerate() {
            let generation = (index + 1) as u8;
            let reward_rate = self.config.team_reward_bps[index];
            let eligible = state
                .user(ancestor)
                .map(|account| account.active && account.direct_count >= u32::from(generation))
                .unwrap_or(false);
            if eligible {
                let amount = bps(static_bnb, reward_rate);
                state.ensure_user_mut(ancestor).dynamic_paid_bnb += amount;
                team_rewards.push(RewardPayout {
                    user: ancestor.clone(),
                    amount,
                    generation,
                });
            }
        }

        let account = state.ensure_user_mut(&user);
        let exit_target = account
            .principal_bnb
            .saturating_mul(Wei::from(self.config.exit_multiple_bps))
            / BPS_DENOMINATOR;
        let total_paid = account.static_paid_bnb + account.dynamic_paid_bnb;
        let exited = total_paid >= exit_target;
        if exited {
            account.active = false;
            account.exited = true;
        }
        let exit_refund_bnb = exited.then_some(account.principal_bnb);

        Ok(StaticSettlement {
            user,
            static_bnb,
            team_rewards,
            exited,
            exit_refund_bnb,
        })
    }

    pub fn withdraw_lp(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
    ) -> Result<Wei, EngineError> {
        let user = user.into();
        let account = state.ensure_user_mut(&user);
        if !account.active || account.principal_bnb == 0 {
            return Err(EngineError::InactivePosition);
        }
        account.active = false;
        account.exited = true;
        Ok(account.principal_bnb)
    }

    pub fn apply_deflation(&self, state: &mut ProtocolState, day: u64) -> Result<Wei, EngineError> {
        if day != state.current_day {
            state.current_day = day;
            state.deflation_used_bps = 0;
        }
        if !self.config.deflation_enabled {
            return Ok(0);
        }
        let remaining = self
            .config
            .deflation_daily_cap_bps
            .saturating_sub(state.deflation_used_bps);
        let bps_to_use = remaining.min(self.config.deflation_hourly_bps);
        if bps_to_use == 0 {
            return Ok(0);
        }
        let amount = bps(state.pair.token_reserve, bps_to_use);
        state.pair.token_reserve = state.pair.token_reserve.saturating_sub(amount);
        state.balances.builder_token_amount =
            state.balances.builder_token_amount.saturating_add(amount);
        state.deflation_used_bps += bps_to_use;
        Ok(amount)
    }

    pub fn buyback_tick(&self, state: &mut ProtocolState) -> Result<Wei, EngineError> {
        if !self.config.buyback_enabled
            || state.balances.vault_bnb == 0
            || state.pair.bnb_reserve == 0
            || state.pair.token_reserve == 0
        {
            return Ok(0);
        }
        let spend = state.balances.vault_bnb.min(self.config.buyback_per_minute);
        let tokens = spend
            .saturating_mul(state.pair.token_reserve)
            .checked_div(state.pair.bnb_reserve)
            .unwrap_or(0)
            .min(state.pair.token_reserve);
        state.balances.vault_bnb -= spend;
        state.pair.bnb_reserve = state.pair.bnb_reserve.saturating_add(spend);
        state.pair.token_reserve = state.pair.token_reserve.saturating_sub(tokens);
        state.balances.burned_tokens = state.balances.burned_tokens.saturating_add(tokens);
        Ok(tokens)
    }

    pub fn apply_trade_tax(
        &self,
        state: &mut ProtocolState,
        side: TaxSide,
        gross_bnb_value: Wei,
    ) -> Result<TaxAllocation, EngineError> {
        let allocation = match side {
            TaxSide::Buy => {
                let total_tax_bnb = bps(gross_bnb_value, self.config.buy_tax_bps);
                let builder_token_value_bnb = bps(gross_bnb_value, self.config.buy_tax_builder_bps);
                let vault_bnb = bps(gross_bnb_value, self.config.buy_tax_vault_bps);
                let burned_token_value_bnb =
                    total_tax_bnb.saturating_sub(builder_token_value_bnb + vault_bnb);
                TaxAllocation {
                    side,
                    gross_bnb_value,
                    total_tax_bnb,
                    builder_token_value_bnb,
                    vault_bnb,
                    owner_bnb: 0,
                    burned_token_value_bnb,
                }
            }
            TaxSide::Sell => {
                let total_tax_bnb = bps(gross_bnb_value, self.config.sell_tax_bps);
                let builder_token_value_bnb =
                    bps(gross_bnb_value, self.config.sell_tax_builder_bps);
                let owner_bnb = bps(gross_bnb_value, self.config.sell_tax_owner_bps);
                let vault_bnb = bps(gross_bnb_value, self.config.sell_tax_vault_bps);
                let burned_token_value_bnb =
                    total_tax_bnb.saturating_sub(builder_token_value_bnb + owner_bnb + vault_bnb);
                TaxAllocation {
                    side,
                    gross_bnb_value,
                    total_tax_bnb,
                    builder_token_value_bnb,
                    vault_bnb,
                    owner_bnb,
                    burned_token_value_bnb,
                }
            }
        };

        if allocation.total_tax_bnb
            != allocation.builder_token_value_bnb
                + allocation.vault_bnb
                + allocation.owner_bnb
                + allocation.burned_token_value_bnb
        {
            return Err(EngineError::InvalidConfig);
        }
        state.balances.builder_token_value_bnb = state
            .balances
            .builder_token_value_bnb
            .saturating_add(allocation.builder_token_value_bnb);
        state.balances.vault_bnb = state
            .balances
            .vault_bnb
            .saturating_add(allocation.vault_bnb);
        state.balances.owner_bnb = state
            .balances
            .owner_bnb
            .saturating_add(allocation.owner_bnb);
        state.balances.tax_burned_token_value_bnb = state
            .balances
            .tax_burned_token_value_bnb
            .saturating_add(allocation.burned_token_value_bnb);
        Ok(allocation)
    }

    fn distribute_nodes(&self, state: &mut ProtocolState, amount: Wei) -> Vec<BnbPayout> {
        let total_weight: u32 = state.nodes.iter().map(|node| node.weight).sum();
        if amount == 0 || total_weight == 0 {
            state.balances.vault_bnb += amount;
            return Vec::new();
        }
        let mut paid = 0;
        let mut payouts = Vec::new();
        for node in &state.nodes {
            let share = amount.saturating_mul(Wei::from(node.weight)) / Wei::from(total_weight);
            paid += share;
            *state
                .balances
                .node_paid_bnb
                .entry(node.address.clone())
                .or_default() += share;
            if share != 0 {
                payouts.push(BnbPayout {
                    to: node.address.clone(),
                    amount: share,
                    reason: "node",
                });
            }
        }
        let dust = amount.saturating_sub(paid);
        state.balances.vault_bnb += dust;
        payouts
    }

    fn validate_distribution(&self) -> Result<(), EngineError> {
        let total_bps = u32::from(self.config.lp_build_bps)
            + u32::from(self.config.node_bps)
            + u32::from(self.config.builder_buy_bps)
            + u32::from(self.config.vault_bps)
            + u32::from(self.config.direct_pool_bps);
        if total_bps > BPS_DENOMINATOR as u32
            || self.config.direct_reward_bps > self.config.direct_pool_bps
        {
            return Err(EngineError::InvalidConfig);
        }
        Ok(())
    }

    fn ancestors(&self, state: &ProtocolState, user: &str, depth: usize) -> Vec<Address> {
        let mut result = Vec::new();
        let mut cursor = user.to_owned();
        while result.len() < depth {
            let Some(next) = state
                .user(&cursor)
                .and_then(|account| account.referrer.clone())
            else {
                break;
            };
            if next == cursor || next.is_empty() {
                break;
            }
            result.push(next.clone());
            cursor = next;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BNB;
    use crate::state::Node;

    fn engine() -> Engine {
        Engine::new(ProtocolConfig::default())
    }

    #[test]
    fn zero_transfer_binding_model_requires_bound_referrer() {
        let engine = engine();
        let mut state = ProtocolState::new("root");
        assert_eq!(engine.bind(&mut state, "alice", "root"), Ok(true));
        assert_eq!(engine.bind(&mut state, "bob", "alice"), Ok(true));
        assert_eq!(engine.bind(&mut state, "bob", "root"), Ok(false));
        assert_eq!(
            engine.bind(&mut state, "carol", "dave"),
            Err(EngineError::ReferrerNotBound)
        );
        assert_eq!(state.user("alice").unwrap().direct_count, 1);
    }

    #[test]
    fn deposit_allocates_bnb_by_origin_rules() {
        let engine = engine();
        let mut state = ProtocolState::new("root");
        state.nodes.push(Node {
            address: "node-a".into(),
            weight: 1,
        });
        state.nodes.push(Node {
            address: "node-b".into(),
            weight: 1,
        });
        engine.bind(&mut state, "alice", "root").unwrap();

        let allocation = engine.deposit(&mut state, "alice", BNB).unwrap();
        assert_eq!(allocation.lp_bnb, 3 * BNB / 10);
        assert_eq!(allocation.lp_token_value_bnb, 3 * BNB / 10);
        assert_eq!(allocation.node_bnb, BNB / 10);
        assert_eq!(allocation.node_payouts.len(), 2);
        assert_eq!(allocation.builder_bnb, BNB / 10);
        assert_eq!(allocation.vault_bnb, BNB / 10);
        assert_eq!(allocation.direct_bnb, BNB / 10);
        assert_eq!(state.balances.node_paid_bnb["node-a"], BNB / 20);
        assert_eq!(state.balances.direct_paid_bnb["root"], BNB / 10);
    }

    #[test]
    fn static_settlement_pays_team_and_exits_at_cap() {
        let config = ProtocolConfig {
            daily_static_bps: 10_000,
            exit_multiple_bps: 10_000,
            ..ProtocolConfig::default()
        };
        let engine = Engine::new(config);
        let mut state = ProtocolState::new("root");
        engine.bind(&mut state, "alice", "root").unwrap();
        engine.bind(&mut state, "bob", "alice").unwrap();
        engine.deposit(&mut state, "alice", BNB).unwrap();
        engine.deposit(&mut state, "bob", BNB).unwrap();

        let settlement = engine.settle_static_period(&mut state, "bob").unwrap();
        assert_eq!(settlement.static_bnb, BNB / 4);
        assert_eq!(settlement.team_rewards[0].user, "alice");
        assert_eq!(settlement.team_rewards[0].amount, BNB / 40);
        assert_eq!(settlement.exit_refund_bnb, None);

        for _ in 0..3 {
            engine.settle_static_period(&mut state, "bob").unwrap();
        }
        assert!(state.user("bob").unwrap().exited);
    }

    #[test]
    fn deflation_and_buyback_move_pair_reserves() {
        let engine = engine();
        let mut state = ProtocolState::new("root");
        state.pair.token_reserve = 1_000_000 * BNB;
        state.pair.bnb_reserve = 100 * BNB;
        state.balances.vault_bnb = BNB / 5;

        let pulled = engine.apply_deflation(&mut state, 0).unwrap();
        assert_eq!(pulled, 1_000 * BNB);
        assert_eq!(state.deflation_used_bps, 10);

        let burned = engine.buyback_tick(&mut state).unwrap();
        assert!(burned > 0);
        assert_eq!(state.balances.vault_bnb, BNB / 10);
        assert_eq!(state.balances.burned_tokens, burned);
    }

    #[test]
    fn ten_generation_team_rewards_obey_direct_count_gates() {
        let config = ProtocolConfig {
            daily_static_bps: 10_000,
            exit_multiple_bps: 1_000_000,
            ..ProtocolConfig::default()
        };
        let engine = Engine::new(config);
        let mut state = ProtocolState::new("root");

        let mut previous = "root".to_owned();
        for index in 1..=10 {
            let user = format!("u{index}");
            engine.bind(&mut state, &user, &previous).unwrap();
            engine.deposit(&mut state, &user, BNB).unwrap();
            previous = user;
        }
        engine.bind(&mut state, "leaf", "u10").unwrap();
        engine.deposit(&mut state, "leaf", BNB).unwrap();

        for generation in 1..=10 {
            let ancestor = format!("u{}", 11 - generation);
            for extra in 1..generation {
                let dummy = format!("{ancestor}-dummy-{extra}");
                engine.bind(&mut state, dummy, &ancestor).unwrap();
            }
        }

        let settlement = engine.settle_static_period(&mut state, "leaf").unwrap();
        assert_eq!(settlement.team_rewards.len(), 10);
        for (index, reward) in settlement.team_rewards.iter().enumerate() {
            let generation = (index + 1) as u8;
            assert_eq!(reward.generation, generation);
            assert_eq!(reward.user, format!("u{}", 10 - index));
            assert_eq!(
                reward.amount,
                bps(BNB / 4, engine.config.team_reward_bps[index])
            );
        }
    }

    #[test]
    fn settlement_period_key_prevents_duplicate_rewards() {
        let config = ProtocolConfig {
            daily_static_bps: 10_000,
            exit_multiple_bps: 1_000_000,
            ..ProtocolConfig::default()
        };
        let engine = Engine::new(config);
        let mut state = ProtocolState::new("root");
        engine.bind(&mut state, "alice", "root").unwrap();
        engine.deposit(&mut state, "alice", BNB).unwrap();

        let first = engine
            .settle_static_period_once(&mut state, "alice", "period-1")
            .unwrap();
        assert!(first.is_some());
        assert_eq!(state.user("alice").unwrap().static_paid_bnb, BNB / 4);
        let duplicate = engine
            .settle_static_period_once(&mut state, "alice", "period-1")
            .unwrap();
        assert_eq!(duplicate, None);
        assert_eq!(state.user("alice").unwrap().static_paid_bnb, BNB / 4);
        let next = engine
            .settle_static_period_once(&mut state, "alice", "period-2")
            .unwrap();
        assert!(next.is_some());
        assert_eq!(state.user("alice").unwrap().static_paid_bnb, BNB / 2);
    }

    #[test]
    fn exited_user_can_reenter_with_fresh_position_accounting() {
        let config = ProtocolConfig {
            daily_static_bps: 10_000,
            exit_multiple_bps: 10_000,
            ..ProtocolConfig::default()
        };
        let engine = Engine::new(config);
        let mut state = ProtocolState::new("root");
        engine.bind(&mut state, "alice", "root").unwrap();
        engine.deposit(&mut state, "alice", BNB).unwrap();
        for _ in 0..4 {
            engine.settle_static_period(&mut state, "alice").unwrap();
        }
        assert!(state.user("alice").unwrap().exited);
        assert_eq!(state.user("alice").unwrap().position_id, 0);

        engine.deposit(&mut state, "alice", BNB).unwrap();
        let account = state.user("alice").unwrap();
        assert_eq!(account.position_id, 1);
        assert_eq!(account.principal_bnb, BNB);
        assert_eq!(account.static_paid_bnb, 0);
        assert_eq!(account.dynamic_paid_bnb, 0);
        assert!(account.active);
        assert!(!account.exited);
    }

    #[test]
    fn trade_tax_allocation_matches_origin_rules() {
        let engine = engine();
        let mut state = ProtocolState::new("root");
        let buy = engine
            .apply_trade_tax(&mut state, TaxSide::Buy, BNB)
            .unwrap();
        assert_eq!(buy.total_tax_bnb, 3 * BNB / 100);
        assert_eq!(buy.builder_token_value_bnb, BNB / 100);
        assert_eq!(buy.vault_bnb, 2 * BNB / 100);
        assert_eq!(buy.owner_bnb, 0);

        let sell = engine
            .apply_trade_tax(&mut state, TaxSide::Sell, BNB)
            .unwrap();
        assert_eq!(sell.total_tax_bnb, BNB / 10);
        assert_eq!(sell.builder_token_value_bnb, 3 * BNB / 100);
        assert_eq!(sell.owner_bnb, 3 * BNB / 100);
        assert_eq!(sell.vault_bnb, 4 * BNB / 100);
        assert_eq!(state.balances.builder_token_value_bnb, 4 * BNB / 100);
        assert_eq!(state.balances.owner_bnb, 3 * BNB / 100);
        assert_eq!(state.balances.vault_bnb, 6 * BNB / 100);
    }

    #[test]
    fn deflation_respects_daily_cap_disable_and_day_reset() {
        let config = ProtocolConfig {
            deflation_hourly_bps: 150,
            deflation_daily_cap_bps: 200,
            ..ProtocolConfig::default()
        };
        let engine = Engine::new(config);
        let mut state = ProtocolState::new("root");
        state.pair.token_reserve = 1_000_000 * BNB;

        assert!(engine.apply_deflation(&mut state, 0).unwrap() > 0);
        assert_eq!(state.deflation_used_bps, 150);
        assert!(engine.apply_deflation(&mut state, 0).unwrap() > 0);
        assert_eq!(state.deflation_used_bps, 200);
        assert_eq!(engine.apply_deflation(&mut state, 0), Ok(0));
        assert!(engine.apply_deflation(&mut state, 1).unwrap() > 0);
        assert_eq!(state.deflation_used_bps, 150);

        let disabled = Engine::new(ProtocolConfig {
            deflation_enabled: false,
            ..ProtocolConfig::default()
        });
        assert_eq!(disabled.apply_deflation(&mut state, 1), Ok(0));
    }

    #[test]
    fn buyback_respects_disable_empty_reserves_and_small_vault() {
        let disabled = Engine::new(ProtocolConfig {
            buyback_enabled: false,
            ..ProtocolConfig::default()
        });
        let mut state = ProtocolState::new("root");
        state.balances.vault_bnb = BNB;
        state.pair.token_reserve = 1_000 * BNB;
        state.pair.bnb_reserve = 10 * BNB;
        assert_eq!(disabled.buyback_tick(&mut state), Ok(0));
        assert_eq!(state.balances.vault_bnb, BNB);

        let engine = engine();
        state.pair.bnb_reserve = 0;
        assert_eq!(engine.buyback_tick(&mut state), Ok(0));
        assert_eq!(state.balances.vault_bnb, BNB);

        state.pair.bnb_reserve = 10 * BNB;
        state.balances.vault_bnb = BNB / 20;
        let burned = engine.buyback_tick(&mut state).unwrap();
        assert!(burned > 0);
        assert_eq!(state.balances.vault_bnb, 0);
    }
}
