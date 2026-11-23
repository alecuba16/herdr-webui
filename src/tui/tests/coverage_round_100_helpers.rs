//! Coverage round tests.

use super::*;
use serde_json::json;

pub(crate) fn fixture_snapshot_value_two_panes_obj() -> TuiSnapshot {
    TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}
            ]
        }
    }))
}
