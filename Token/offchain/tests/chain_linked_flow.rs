use uscamex_operator::chain::RecordedClient;
use uscamex_operator::config::{ProtocolConfig, BNB};
use uscamex_operator::engine::Engine;
use uscamex_operator::executor::OperatorCommand;
use uscamex_operator::indexer::{deposit_topic, ref_bound_topic, RawLog};
use uscamex_operator::journal::CommandStatus;
use uscamex_operator::runtime::process_raw_logs;
use uscamex_operator::service::{EventOutcome, OperatorService};
use uscamex_operator::state::Node;
use uscamex_operator::storage::{MemoryDatabase, OperatorDatabase};

const ROOT: &str = "0x9999999999999999999999999999999999999999";
const ALICE: &str = "0x1111111111111111111111111111111111111111";
const BOB: &str = "0x2222222222222222222222222222222222222222";
const NODE_A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NODE_B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn raw_chain_logs_drive_operator_restart_rewards_and_exit_linkage() {
    let config = ProtocolConfig {
        daily_static_bps: 10_000,
        exit_multiple_bps: 10_000,
        ..ProtocolConfig::default()
    };
    let mut service = OperatorService::restore_or_new(
        Engine::new(config.clone()),
        MemoryDatabase::default(),
        RecordedClient::default(),
        ROOT,
    );
    service.state.nodes.push(Node {
        address: NODE_A.into(),
        weight: 1,
    });
    service.state.nodes.push(Node {
        address: NODE_B.into(),
        weight: 3,
    });
    service.state.pair.token_reserve = 1_000_000_000 * BNB;
    service.state.pair.bnb_reserve = 100 * BNB;

    let logs = vec![
        ref_bound_log(100, "0xbindalice", 0, ALICE, ROOT),
        deposit_log(101, "0xdepositalice", 0, ALICE, BNB),
        ref_bound_log(102, "0xbindbob", 0, BOB, ALICE),
        deposit_log(103, "0xdepositbob", 0, BOB, BNB),
    ];

    let summary = process_raw_logs(&mut service, 100, 103, logs.clone()).unwrap();
    assert_eq!(summary.raw_logs, 4);
    assert_eq!(summary.decoded_events, 4);
    assert_eq!(summary.applied_events, 4);
    assert_eq!(summary.planned_commands, 12);
    assert_eq!(service.state.user(ALICE).unwrap().principal_bnb, BNB);
    assert_eq!(service.state.user(BOB).unwrap().principal_bnb, BNB);
    assert_eq!(service.state.balances.direct_paid_bnb[ROOT], BNB / 10);
    assert_eq!(service.state.balances.direct_paid_bnb[ALICE], BNB / 10);
    assert_eq!(service.state.balances.node_paid_bnb[NODE_A], BNB / 20);
    assert_eq!(service.state.balances.node_paid_bnb[NODE_B], 3 * BNB / 20);
    assert!(service
        .journal
        .records
        .values()
        .any(|record| matches!(record.command, OperatorCommand::AddLiquidity { .. })));
    assert!(service
        .journal
        .records
        .values()
        .any(|record| matches!(record.command, OperatorCommand::BuilderBuy { .. })));
    assert!(service.journal.records.values().any(|record| {
        matches!(
            &record.command,
            OperatorCommand::TransferBnb { to, reason, .. } if to == ALICE && reason == "direct-referral"
        )
    }));

    let confirmed_id = service.journal.records.keys().next().unwrap().clone();
    service
        .journal
        .mark_submitted(&confirmed_id, "0xconfirmed")
        .unwrap();
    service.journal.mark_confirmed(&confirmed_id).unwrap();
    service.database.save_journal(&service.journal);
    let expected_pending = service.journal.pending_commands().len();
    let snapshot = service.database.snapshot();

    let mut restarted = OperatorService::restore_or_new(
        Engine::new(config),
        MemoryDatabase::from_snapshot(snapshot),
        RecordedClient::default(),
        ROOT,
    );
    let duplicate = process_raw_logs(&mut restarted, 100, 103, logs).unwrap();
    assert_eq!(duplicate.decoded_events, 4);
    assert_eq!(duplicate.applied_events, 0);
    assert_eq!(duplicate.duplicate_events, 4);
    assert_eq!(duplicate.planned_commands, 0);
    assert_eq!(restarted.state.user(BOB).unwrap().principal_bnb, BNB);

    let tx_hashes = restarted.submit_pending().unwrap();
    assert_eq!(tx_hashes.len(), expected_pending);
    assert_eq!(restarted.chain.submitted.len(), expected_pending);
    assert!(restarted
        .journal
        .records
        .get(&confirmed_id)
        .map(|record| matches!(record.status, CommandStatus::Confirmed { .. }))
        .unwrap_or(false));

    let first_settlement = restarted.settle_once(BOB, "period-0").unwrap().unwrap();
    assert!(first_settlement.iter().any(|command| {
        matches!(command, OperatorCommand::PayRewardTokenByBnbValue { to, amount } if to == BOB && *amount == BNB / 4)
    }));
    assert!(first_settlement.iter().any(|command| {
        matches!(command, OperatorCommand::PayRewardTokenByBnbValue { to, amount } if to == ALICE && *amount == BNB / 40)
    }));
    assert_eq!(restarted.settle_once(BOB, "period-0").unwrap(), None);

    for period in 1..4 {
        restarted
            .settle_once(BOB, format!("period-{period}"))
            .unwrap();
    }
    assert!(restarted.state.user(BOB).unwrap().exited);
    assert!(restarted.journal.records.values().any(|record| {
        matches!(
            &record.command,
            OperatorCommand::RedeemUserLp { user, lp_bnb_share, .. } if user == BOB && *lp_bnb_share > 0
        )
    }));
}

#[test]
fn duplicate_indexed_event_does_not_plan_duplicate_payments() {
    let mut service = OperatorService::restore_or_new(
        Engine::new(ProtocolConfig::default()),
        MemoryDatabase::default(),
        RecordedClient::default(),
        ROOT,
    );
    let bind = ref_bound_log(1, "0xbind", 0, ALICE, ROOT);
    let deposit = deposit_log(2, "0xdeposit", 0, ALICE, BNB);
    process_raw_logs(&mut service, 1, 2, vec![bind.clone(), deposit.clone()]).unwrap();
    let planned = service.journal.records.len();

    let duplicate = process_raw_logs(&mut service, 1, 2, vec![bind, deposit]).unwrap();
    assert_eq!(duplicate.duplicate_events, 2);
    assert_eq!(service.journal.records.len(), planned);
}

#[test]
fn direct_service_event_path_matches_raw_log_path() {
    let mut service = OperatorService::restore_or_new(
        Engine::new(ProtocolConfig::default()),
        MemoryDatabase::default(),
        RecordedClient::default(),
        ROOT,
    );
    let raw = ref_bound_log(10, "0xbind", 0, ALICE, ROOT);
    let indexed = uscamex_operator::indexer::decode_protocol_log(raw)
        .unwrap()
        .unwrap();
    assert_eq!(
        service.process_event(indexed).unwrap(),
        EventOutcome::Applied {
            planned_commands: 0
        }
    );
    assert_eq!(
        service.state.user(ALICE).unwrap().referrer.as_deref(),
        Some(ROOT)
    );
}

fn ref_bound_log(
    block_number: u64,
    tx_hash: &str,
    log_index: u32,
    user: &str,
    referrer: &str,
) -> RawLog {
    RawLog {
        block_number,
        block_hash: format!("0xblock{block_number}"),
        tx_hash: tx_hash.into(),
        log_index,
        topics: vec![
            ref_bound_topic(),
            topic_address(user),
            topic_address(referrer),
        ],
        data: "0x".into(),
    }
}

fn deposit_log(
    block_number: u64,
    tx_hash: &str,
    log_index: u32,
    user: &str,
    amount: u128,
) -> RawLog {
    RawLog {
        block_number,
        block_hash: format!("0xblock{block_number}"),
        tx_hash: tx_hash.into(),
        log_index,
        topics: vec![deposit_topic(), topic_address(user), topic_address(ROOT)],
        data: format!("0x{amount:064x}"),
    }
}

fn topic_address(address: &str) -> String {
    format!("0x{:0>64}", address.trim_start_matches("0x"))
}
