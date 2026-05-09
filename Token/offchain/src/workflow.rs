use crate::engine::{Engine, EngineError};
use crate::executor::{commands_for_deposit, commands_for_settlement, OperatorCommand};
use crate::state::{Address, ProtocolState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutomationTick {
    pub day: u64,
    pub run_static: bool,
    pub run_deflation: bool,
    pub run_buyback: bool,
}

#[derive(Debug, Clone)]
pub struct WorkflowEngine {
    pub engine: Engine,
}

impl WorkflowEngine {
    pub fn new(engine: Engine) -> Self {
        Self { engine }
    }

    pub fn on_deposit(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
        amount: u128,
    ) -> Result<Vec<OperatorCommand>, EngineError> {
        let allocation = self.engine.deposit(state, user, amount)?;
        Ok(commands_for_deposit(&allocation))
    }

    pub fn on_user_withdraw(
        &self,
        state: &mut ProtocolState,
        user: impl Into<Address>,
    ) -> Result<Vec<OperatorCommand>, EngineError> {
        let user = user.into();
        let amount = self.engine.withdraw_lp(state, user.clone())?;
        Ok(vec![
            OperatorCommand::BurnTokenByBnbValue {
                amount,
                reason: "exit-burn".to_owned(),
            },
            OperatorCommand::TransferBnb {
                to: user,
                amount,
                reason: "exit-refund".to_owned(),
            },
        ])
    }

    pub fn on_tick(
        &self,
        state: &mut ProtocolState,
        active_users: &[Address],
        tick: AutomationTick,
    ) -> Result<Vec<OperatorCommand>, EngineError> {
        let mut commands = Vec::new();
        if tick.run_static {
            for user in active_users {
                if state
                    .user(user)
                    .map(|account| account.active)
                    .unwrap_or(false)
                {
                    commands.extend(commands_for_settlement(
                        &self.engine.settle_static_period(state, user)?,
                    ));
                }
            }
        }
        if tick.run_deflation && self.engine.apply_deflation(state, tick.day)? != 0 {
            commands.push(OperatorCommand::PullPairTokens {
                bps: self.engine.config.deflation_hourly_bps,
            });
        }
        if tick.run_buyback {
            let before = state.balances.vault_bnb;
            if self.engine.buyback_tick(state)? != 0 {
                commands.push(OperatorCommand::Buyback {
                    bnb_amount: before - state.balances.vault_bnb,
                });
            }
        }
        Ok(commands)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProtocolConfig, BNB};
    use crate::state::{Node, ProtocolState};

    #[test]
    fn workflow_emits_chain_commands_for_deposit_and_cron() {
        let workflow = WorkflowEngine::new(Engine::new(ProtocolConfig::default()));
        let mut state = ProtocolState::new("root");
        state.nodes.push(Node {
            address: "node".into(),
            weight: 1,
        });
        state.pair.token_reserve = 1_000_000 * BNB;
        state.pair.bnb_reserve = 100 * BNB;
        workflow.engine.bind(&mut state, "alice", "root").unwrap();

        let deposit_commands = workflow.on_deposit(&mut state, "alice", BNB).unwrap();
        assert!(deposit_commands
            .iter()
            .any(|command| matches!(command, OperatorCommand::AddLiquidity { .. })));
        assert!(deposit_commands
            .iter()
            .any(|command| matches!(command, OperatorCommand::TransferBnb { reason, .. } if reason == "node")));

        let tick_commands = workflow
            .on_tick(
                &mut state,
                &["alice".into()],
                AutomationTick {
                    day: 0,
                    run_static: true,
                    run_deflation: true,
                    run_buyback: true,
                },
            )
            .unwrap();
        assert!(tick_commands
            .iter()
            .any(|command| matches!(command, OperatorCommand::PayRewardTokenByBnbValue { .. })));
        assert!(tick_commands
            .iter()
            .any(|command| matches!(command, OperatorCommand::PullPairTokens { .. })));
        assert!(tick_commands
            .iter()
            .any(|command| matches!(command, OperatorCommand::Buyback { .. })));
    }

    #[test]
    fn workflow_emits_exit_position_when_cap_is_reached() {
        let config = ProtocolConfig {
            daily_static_bps: 10_000,
            exit_multiple_bps: 10_000,
            ..ProtocolConfig::default()
        };
        let workflow = WorkflowEngine::new(Engine::new(config));
        let mut state = ProtocolState::new("root");
        workflow.engine.bind(&mut state, "alice", "root").unwrap();
        workflow.on_deposit(&mut state, "alice", BNB).unwrap();

        let mut commands = Vec::new();
        for _ in 0..4 {
            commands.extend(
                workflow
                    .on_tick(
                        &mut state,
                        &["alice".into()],
                        AutomationTick {
                            day: 0,
                            run_static: true,
                            run_deflation: false,
                            run_buyback: false,
                        },
                    )
                    .unwrap(),
            );
        }
        assert!(commands.iter().any(|command| matches!(command, OperatorCommand::BurnTokenByBnbValue { amount, reason } if *amount == BNB && reason == "exit-burn")));
        assert!(commands.iter().any(|command| matches!(command, OperatorCommand::TransferBnb { to, amount, reason } if to == "alice" && *amount == BNB && reason == "exit-refund")));
    }
}
