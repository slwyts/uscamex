use uscamex_operator::chain::{submit_pending, RecordedClient};
use uscamex_operator::config::{ProtocolConfig, BNB};
use uscamex_operator::engine::Engine;
use uscamex_operator::executor::{commands_for_deposit, commands_for_settlement, OperatorCommand};
use uscamex_operator::indexer::{apply_event, ChainEvent};
use uscamex_operator::state::{Node, ProtocolState};
use uscamex_operator::ExecutionJournal;

#[test]
fn field_sale_full_flow_simulation() {
    let config = ProtocolConfig {
        daily_static_bps: 10_000,
        exit_multiple_bps: 10_000,
        ..ProtocolConfig::default()
    };
    let engine = Engine::new(config);
    let mut state = ProtocolState::new("root");
    state.nodes.push(Node {
        address: "node-a".into(),
        weight: 1,
    });
    state.nodes.push(Node {
        address: "node-b".into(),
        weight: 3,
    });
    state.pair.token_reserve = 1_000_000_000 * BNB;
    state.pair.bnb_reserve = 100 * BNB;

    apply_event(
        &engine,
        &mut state,
        ChainEvent::RefBound {
            id: "bind-alice".into(),
            user: "alice".into(),
            referrer: "root".into(),
        },
    )
    .unwrap();
    apply_event(
        &engine,
        &mut state,
        ChainEvent::RefBound {
            id: "bind-bob".into(),
            user: "bob".into(),
            referrer: "alice".into(),
        },
    )
    .unwrap();

    let alice_deposit = engine.deposit(&mut state, "alice", BNB).unwrap();
    let bob_deposit = engine.deposit(&mut state, "bob", BNB).unwrap();
    let deposit_commands = commands_for_deposit(&bob_deposit);
    let mut journal = ExecutionJournal::default();
    let command_ids = journal.plan_batch("deposit:bob:1", deposit_commands.clone());
    journal
        .mark_submitted(&command_ids[0], "0xconfirmed")
        .unwrap();
    journal.mark_confirmed(&command_ids[0]).unwrap();
    let mut chain = RecordedClient::default();
    let hashes = submit_pending(&mut chain, &mut journal).unwrap();
    assert_eq!(hashes.len(), deposit_commands.len() - 1);
    assert!(deposit_commands.contains(&OperatorCommand::AddLiquidity {
        bnb_amount: 3 * BNB / 10,
        token_value_bnb: 3 * BNB / 10,
    }));
    assert_eq!(alice_deposit.direct_referrer.as_deref(), Some("root"));
    assert_eq!(state.balances.direct_paid_bnb["alice"], BNB / 10);
    assert!(deposit_commands.contains(&OperatorCommand::TransferBnb {
        to: "node-a".into(),
        amount: BNB / 40,
        reason: "node".into(),
    }));
    assert_eq!(state.balances.node_paid_bnb["node-a"], BNB / 20);
    assert_eq!(state.balances.node_paid_bnb["node-b"], 3 * BNB / 20);

    let settlement = engine.settle_static_period(&mut state, "bob").unwrap();
    assert_eq!(settlement.static_bnb, BNB / 4);
    assert_eq!(settlement.team_rewards[0].user, "alice");
    assert_eq!(settlement.team_rewards[0].amount, BNB / 40);
    let reward_commands = commands_for_settlement(&settlement);
    assert!(
        reward_commands.contains(&OperatorCommand::PayRewardTokenByBnbValue {
            to: "bob".into(),
            amount: BNB / 4,
        })
    );

    let pulled = engine.apply_deflation(&mut state, 0).unwrap();
    assert!(pulled > 0);
    assert_eq!(state.deflation_used_bps, 10);

    let vault_before = state.balances.vault_bnb;
    let burned = engine.buyback_tick(&mut state).unwrap();
    assert!(burned > 0);
    assert!(state.balances.vault_bnb < vault_before);

    for _ in 0..3 {
        let final_settlement = engine.settle_static_period(&mut state, "bob").unwrap();
        if final_settlement.exited {
            let exit_commands = commands_for_settlement(&final_settlement);
            assert!(exit_commands.iter().any(|command| matches!(
                command,
                OperatorCommand::RedeemUserLp { user, lp_bnb_share, .. }
                    if user == "bob" && *lp_bnb_share > 0
            )));
        }
    }
    assert!(state.user("bob").unwrap().exited);

    let repeat = apply_event(
        &engine,
        &mut state,
        ChainEvent::RefBound {
            id: "bind-bob".into(),
            user: "bob".into(),
            referrer: "root".into(),
        },
    )
    .unwrap();
    assert!(!repeat);
}
