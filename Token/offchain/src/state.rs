use std::collections::{BTreeMap, BTreeSet};

use crate::config::Wei;
use serde::{Deserialize, Serialize};

pub type Address = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub address: Address,
    pub weight: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserAccount {
    pub referrer: Option<Address>,
    pub direct_count: u32,
    pub position_id: u64,
    pub principal_bnb: Wei,
    pub static_paid_bnb: Wei,
    pub dynamic_paid_bnb: Wei,
    /// BNB-denominated share of LP this user has contributed and not yet
    /// redeemed. Used at exit time to compute the LP fraction to remove from
    /// the token contract's custody.
    #[serde(default)]
    pub lp_bnb_principal: Wei,
    pub active: bool,
    pub exited: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairState {
    pub token_reserve: Wei,
    pub bnb_reserve: Wei,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolBalances {
    pub vault_bnb: Wei,
    pub owner_bnb: Wei,
    pub builder_token_value_bnb: Wei,
    pub builder_token_amount: Wei,
    pub burned_tokens: Wei,
    pub tax_burned_token_value_bnb: Wei,
    pub node_paid_bnb: BTreeMap<Address, Wei>,
    pub direct_paid_bnb: BTreeMap<Address, Wei>,
    /// Sum of `lp_bnb_principal` across all currently active users. Used at
    /// LP-redeem time so the chain layer can compute the exact LP-token
    /// fraction this user owns against the token contract's self-custodied
    /// LP balance: `user_lp = pair_balance × user_share / total_share`.
    #[serde(default)]
    pub total_active_lp_principal_bnb: Wei,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolState {
    pub root: Address,
    pub users: BTreeMap<Address, UserAccount>,
    pub nodes: Vec<Node>,
    pub balances: ProtocolBalances,
    pub pair: PairState,
    pub current_day: u64,
    pub deflation_used_bps: u16,
    pub processed_events: BTreeSet<String>,
    pub processed_settlements: BTreeSet<String>,
}

impl ProtocolState {
    pub fn new(root: impl Into<Address>) -> Self {
        let root = root.into();
        let mut users = BTreeMap::new();
        users.insert(
            root.clone(),
            UserAccount {
                referrer: Some(root.clone()),
                active: true,
                ..UserAccount::default()
            },
        );
        Self {
            root,
            users,
            nodes: Vec::new(),
            balances: ProtocolBalances::default(),
            pair: PairState::default(),
            current_day: 0,
            deflation_used_bps: 0,
            processed_events: BTreeSet::new(),
            processed_settlements: BTreeSet::new(),
        }
    }

    pub fn is_bound(&self, address: &str) -> bool {
        address == self.root
            || self
                .users
                .get(address)
                .and_then(|user| user.referrer.as_ref())
                .is_some()
    }

    pub fn ensure_user_mut(&mut self, address: &str) -> &mut UserAccount {
        self.users.entry(address.to_owned()).or_default()
    }

    pub fn user(&self, address: &str) -> Option<&UserAccount> {
        self.users.get(address)
    }
}
