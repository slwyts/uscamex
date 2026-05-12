use crate::engine::{DepositAllocation, RewardPayout, StaticSettlement};
use crate::state::Address;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OperatorCommand {
    AddLiquidity {
        bnb_amount: u128,
        token_value_bnb: u128,
    },
    TransferBnb {
        to: Address,
        amount: u128,
        reason: String,
    },
    BuilderBuy {
        bnb_amount: u128,
    },
    CreditVault {
        amount: u128,
    },
    PullPairTokens {
        bps: u16,
    },
    Buyback {
        bnb_amount: u128,
    },
    PayRewardTokenByBnbValue {
        to: Address,
        amount: u128,
    },
    BurnTokenByBnbValue {
        amount: u128,
        reason: String,
    },
    ExitPosition {
        user: Address,
        refund_bnb: u128,
    },
    /// Redeem the caller's LP custody share by invoking
    /// `operatorRedeemLp(user, lpAmount)` on the token contract. The chain
    /// layer computes `lpAmount = pair_balance_of_token × user_share /
    /// total_active_principal`, so the caller must supply the denominator
    /// snapshot taken at the moment of exit.
    RedeemUserLp {
        user: Address,
        lp_bnb_share: u128,
        total_active_principal: u128,
    },
    /// Convert `tax_token_amount` of project tokens accumulated in the
    /// token contract's self-custody (from buy/sell tax) into BNB and
    /// distribute it according to the spec section 4:
    ///   • `builder_token_amount` stays in the token contract as LP builder
    ///     dividend inventory;
    ///   • `burn_token_amount` of the tokens are burned to the zero
    ///     address ("剩余项目代币全部销毁至黑洞");
    ///   • the remaining token amount is swapped to BNB; the BNB output is forwarded
    ///     to `owner` and the buyback `vault` in proportion to
    ///     `owner_bnb_bps_of_sold` / `vault_bnb_bps_of_sold`.
    /// The chain layer expands this single command into the operatorCall
    /// sequence: approve → swap → burn → call{value} → call{value}.
    SweepTaxToBnb {
        tax_token_amount: u128,
        builder_token_amount: u128,
        burn_token_amount: u128,
        owner_bnb_bps_of_sold: u16,
        vault_bnb_bps_of_sold: u16,
    },
}

impl OperatorCommand {
    pub fn kind(&self) -> &str {
        match self {
            Self::AddLiquidity { .. } => "add-liquidity",
            Self::TransferBnb { reason, .. } => reason.as_str(),
            Self::BuilderBuy { .. } => "builder-buy",
            Self::CreditVault { .. } => "credit-vault",
            Self::PullPairTokens { .. } => "pull-pair-tokens",
            Self::Buyback { .. } => "buyback",
            Self::PayRewardTokenByBnbValue { .. } => "pay-reward-token",
            Self::BurnTokenByBnbValue { reason, .. } => reason.as_str(),
            Self::ExitPosition { .. } => "exit-position",
            Self::RedeemUserLp { .. } => "redeem-user-lp",
            Self::SweepTaxToBnb { .. } => "sweep-tax-to-bnb",
        }
    }
}

pub fn commands_for_deposit(allocation: &DepositAllocation) -> Vec<OperatorCommand> {
    let mut commands = vec![
        OperatorCommand::AddLiquidity {
            bnb_amount: allocation.lp_bnb,
            token_value_bnb: allocation.lp_token_value_bnb,
        },
        OperatorCommand::BuilderBuy {
            bnb_amount: allocation.builder_bnb,
        },
        OperatorCommand::CreditVault {
            amount: allocation.vault_bnb,
        },
    ];
    commands.extend(
        allocation
            .node_payouts
            .iter()
            .map(|payout| OperatorCommand::TransferBnb {
                to: payout.to.clone(),
                amount: payout.amount,
                reason: payout.reason.to_owned(),
            }),
    );
    if let Some(referrer) = allocation.direct_referrer.as_ref() {
        if allocation.direct_bnb != 0 {
            commands.push(OperatorCommand::TransferBnb {
                to: referrer.clone(),
                amount: allocation.direct_bnb,
                reason: "direct-referral".to_owned(),
            });
        }
    }
    for redeem in &allocation.lp_redeems {
        commands.push(OperatorCommand::RedeemUserLp {
            user: redeem.user.clone(),
            lp_bnb_share: redeem.lp_bnb_share,
            total_active_principal: redeem.total_active_principal,
        });
    }
    commands
}

pub fn commands_for_settlement(settlement: &StaticSettlement) -> Vec<OperatorCommand> {
    let mut commands = Vec::new();
    if settlement.static_bnb != 0 {
        commands.push(OperatorCommand::PayRewardTokenByBnbValue {
            to: settlement.user.clone(),
            amount: settlement.static_bnb,
        });
    }
    commands.extend(settlement.team_rewards.iter().map(command_for_team_reward));
    for redeem in &settlement.lp_redeems {
        commands.push(OperatorCommand::RedeemUserLp {
            user: redeem.user.clone(),
            lp_bnb_share: redeem.lp_bnb_share,
            total_active_principal: redeem.total_active_principal,
        });
    }
    commands
}

fn command_for_team_reward(reward: &RewardPayout) -> OperatorCommand {
    OperatorCommand::PayRewardTokenByBnbValue {
        to: reward.user.clone(),
        amount: reward.amount,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_commands_include_direct_referral_when_present() {
        let allocation = DepositAllocation {
            user: "alice".into(),
            amount: 100,
            lp_bnb: 30,
            lp_token_value_bnb: 30,
            node_bnb: 10,
            node_payouts: Vec::new(),
            builder_bnb: 10,
            vault_bnb: 10,
            direct_bnb: 10,
            direct_referrer: Some("root".into()),
            lp_redeems: Vec::new(),
        };
        let commands = commands_for_deposit(&allocation);
        assert!(commands.contains(&OperatorCommand::TransferBnb {
            to: "root".into(),
            amount: 10,
            reason: "direct-referral".into(),
        }));
    }
}
