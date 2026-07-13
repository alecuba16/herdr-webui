use std::sync::{mpsc, Arc, Mutex};

use serde_json::{json, Value};

#[derive(Clone)]
pub(crate) struct BuiltinEventHub {
    subscribers: Arc<Mutex<Vec<mpsc::SyncSender<Value>>>>,
}

impl BuiltinEventHub {
    pub(crate) fn new() -> Self {
        Self {
            subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(crate) fn subscribe(&self) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::sync_channel(256);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(tx);
        }
        rx
    }

    pub(crate) fn publish(&self, event: &str, data: Value) {
        let payload = json!({ "event": event, "type": event, "data": data });
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|tx| match tx.try_send(payload.clone()) {
                Ok(()) => true,
                Err(mpsc::TrySendError::Full(_)) => false,
                Err(mpsc::TrySendError::Disconnected(_)) => false,
            });
        }
    }
}

#[derive(Clone)]
pub(crate) struct PaneEventContext {
    pub(crate) workspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) pane_id: String,
    pub(crate) terminal_id: String,
}
