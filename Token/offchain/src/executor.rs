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
    ExitPosition {
        user: Address,
        refund_bnb: u128,
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
            Self::ExitPosition { .. } => "exit-position",
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
    commands
}

pub fn commands_for_settlement(settlement: &StaticSettlement) -> Vec<OperatorCommand> {
    let mut commands = vec![OperatorCommand::PayRewardTokenByBnbValue {
        to: settlement.user.clone(),
        amount: settlement.static_bnb,
    }];
    commands.extend(settlement.team_rewards.iter().map(command_for_team_reward));
    if let Some(refund_bnb) = settlement.exit_refund_bnb {
        commands.push(OperatorCommand::ExitPosition {
            user: settlement.user.clone(),
            refund_bnb,
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
        };
        let commands = commands_for_deposit(&allocation);
        assert!(commands.contains(&OperatorCommand::TransferBnb {
            to: "root".into(),
            amount: 10,
            reason: "direct-referral".into(),
        }));
    }
}
