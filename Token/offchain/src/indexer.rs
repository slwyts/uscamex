use crate::engine::{Engine, EngineError};
use crate::state::{Address, ProtocolState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainEvent {
    RefBound {
        id: String,
        user: Address,
        referrer: Address,
    },
    Deposit {
        id: String,
        user: Address,
        amount: u128,
    },
}

impl ChainEvent {
    pub fn id(&self) -> &str {
        match self {
            Self::RefBound { id, .. } | Self::Deposit { id, .. } => id,
        }
    }
}

pub fn apply_event(
    engine: &Engine,
    state: &mut ProtocolState,
    event: ChainEvent,
) -> Result<bool, EngineError> {
    let id = event.id().to_owned();
    if state.processed_events.contains(&id) {
        return Ok(false);
    }

    match event {
        ChainEvent::RefBound { user, referrer, .. } => {
            engine.bind(state, user, referrer)?;
        }
        ChainEvent::Deposit { user, amount, .. } => {
            engine.deposit(state, user, amount)?;
        }
    }

    state.processed_events.insert(id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProtocolConfig, BNB};

    #[test]
    fn replay_is_idempotent() {
        let engine = Engine::new(ProtocolConfig::default());
        let mut state = ProtocolState::new("root");
        let event = ChainEvent::RefBound {
            id: "tx1:0".into(),
            user: "alice".into(),
            referrer: "root".into(),
        };
        assert_eq!(apply_event(&engine, &mut state, event.clone()), Ok(true));
        assert_eq!(apply_event(&engine, &mut state, event), Ok(false));

        let deposit = ChainEvent::Deposit {
            id: "tx2:0".into(),
            user: "alice".into(),
            amount: BNB,
        };
        assert_eq!(apply_event(&engine, &mut state, deposit.clone()), Ok(true));
        assert_eq!(apply_event(&engine, &mut state, deposit), Ok(false));
        assert_eq!(state.user("alice").unwrap().principal_bnb, BNB);
    }
}
