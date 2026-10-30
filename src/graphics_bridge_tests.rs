//! Graphics bridge frame conversion tests.
use super::*;

fn test_frame() -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot-1".to_string(),
        projection_revision: 1,
        surface_revision: 7,
        frame: FrameData {
            cells: Vec::new(),
            width: 100,
            height: 30,
            cursor: None,
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        },
        panes: vec![PaneSurfacePane {
            pane_id: "ws-1:p1".to_string(),
            content_revision: 3,
            rect: SurfaceRect {
                x: 0,
                y: 0,
                width: 100,
                height: 30,
            },
            inner_rect: SurfaceRect {
                x: 1,
                y: 1,
                width: 98,
                height: 28,
            },
            scrollbar_rect: None,
            scroll: Some(PaneSurfaceScrollMetrics {
                offset_from_bottom: 12,
                max_offset_from_bottom: 50,
                viewport_rows: 28,
            }),
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 900,
            pixel_height: 500,
        }],
        splits: Vec::new(),
        popup: None,
        graphics: SurfaceGraphicsScene {
            assets: vec![SurfaceGraphicsAsset {
                key: SurfaceGraphicsAssetKey {
                    source: SurfaceGraphicsSource::Terminal {
                        target: SurfaceGraphicsTarget::Pane {
                            pane_id: "ws-1:p1".to_string(),
                        },
                        image_id: 42,
                    },
                    image_width: 4,
                    image_height: 2,
                    format: SurfaceGraphicsFormat::Rgba,
                    data_len: 32,
                    data_fingerprint: 99,
                },
                data: vec![1, 2, 3, 4, 5, 6, 7],
            }],
            placements: vec![SurfaceGraphicsPlacement {
                asset: SurfaceGraphicsAssetKey {
                    source: SurfaceGraphicsSource::Terminal {
                        target: SurfaceGraphicsTarget::Pane {
                            pane_id: "ws-1:p1".to_string(),
                        },
                        image_id: 42,
                    },
                    image_width: 4,
                    image_height: 2,
                    format: SurfaceGraphicsFormat::Rgba,
                    data_len: 32,
                    data_fingerprint: 99,
                },
                logical_placement_id: 1,
                x: 1,
                y: 1,
                cols: 4,
                rows: 2,
                source_x: 0,
                source_y: 0,
                source_width: 4,
                source_height: 2,
                x_offset: 3,
                y_offset: 5,
                z: 0,
                scrollback_offset: 0,
            }],
            retained_assets: Vec::new(),
        },
    }
}

#[test]
fn base64_encode_matches_standard_alphabet() {
    // RFC 4648 test vectors.
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    assert_eq!(base64_encode(&[251, 255, 190]), "+/++");
}

#[test]
fn graphics_bridge_payload_serializes_browser_contract() {
    let frame = test_frame();
    let payload = graphics_bridge_payload(&frame);
    let json = serde_json::to_value(&payload).expect("payload serializes");
    assert_eq!(json["type"], "graphics_scene");
    assert_eq!(json["surface_revision"], 7);
    assert_eq!(json["cols"], 100);
    assert_eq!(json["rows"], 30);
    assert_eq!(json["panes"][0]["pane_id"], "ws-1:p1");
    assert_eq!(json["panes"][0]["inner_x"], 1);
    assert_eq!(json["panes"][0]["inner_y"], 1);
    assert_eq!(json["panes"][0]["inner_width"], 98);
    assert_eq!(json["panes"][0]["inner_height"], 28);
    assert_eq!(json["panes"][0]["focused"], true);
    assert_eq!(json["panes"][0]["scrollback_offset"], 12);
    // serde externally-tagged enums must match what the browser parses.
    assert_eq!(
        json["placements"][0]["asset"]["source"]["Terminal"]["image_id"],
        42
    );
    assert_eq!(
        json["placements"][0]["asset"]["source"]["Terminal"]["target"]["Pane"]["pane_id"],
        "ws-1:p1"
    );
    assert_eq!(json["placements"][0]["x"], 1);
    assert_eq!(json["placements"][0]["cols"], 4);
    assert_eq!(json["placements"][0]["x_offset"], 3);
    assert_eq!(json["placements"][0]["y_offset"], 5);
    // Asset bytes ride as base64 with the same key shape.
    assert_eq!(
        json["assets"][0]["data"],
        base64_encode(&[1, 2, 3, 4, 5, 6, 7])
    );
    assert_eq!(json["assets"][0]["key"]["format"], "Rgba");
}

#[test]
fn terminal_graphics_text_messages_maps_browser_messages() {
    let query = TerminalGraphicsQuery {
        tab_id: "t1".to_string(),
        cols: Some(100),
        rows: Some(30),
        cell_width_px: Some(9),
        cell_height_px: Some(17),
        session: None,
        backend: None,
    };
    let resize = terminal_graphics_text_messages(
        r#"{"type":"resize","cols":80,"rows":24,"cell_width_px":10,"cell_height_px":20}"#,
        &query,
    );
    assert_eq!(
        resize,
        vec![ClientMessage::ClientShellResize {
            cell_width_px: 10,
            cell_height_px: 20,
            surface_size: ClientSurfaceSize { cols: 80, rows: 24 },
            pixel_mouse: false,
        }]
    );

    let focus = terminal_graphics_text_messages(r#"{"type":"focus","focused":false}"#, &query);
    assert_eq!(
        focus,
        vec![ClientMessage::ClientShellFocus { focused: false }]
    );

    // Garbage and unknown types map to nothing.
    assert!(terminal_graphics_text_messages("not json", &query).is_empty());
    assert!(terminal_graphics_text_messages(r#"{"type":"bogus"}"#, &query).is_empty());
}

#[test]
fn terminal_graphics_text_messages_clamps_to_protocol_limits() {
    // herdr 0.9.0's client transport disconnects shell clients whose
    // geometry exceeds its limits instead of ignoring the resize, so
    // the bridge must clamp before forwarding. (See the HELLO_MAX_*
    // checks in herdr's client_transport.rs.)
    let query = TerminalGraphicsQuery {
        tab_id: "t1".to_string(),
        cols: Some(100),
        rows: Some(30),
        cell_width_px: Some(9),
        cell_height_px: Some(17),
        session: None,
        backend: None,
    };

    // Dimensions beyond 4096 clamp to 4096.
    let oversized =
        terminal_graphics_text_messages(r#"{"type":"resize","cols":9999,"rows":24}"#, &query);
    let ClientMessage::ClientShellResize { surface_size, .. } = &oversized[0] else {
        panic!("expected resize");
    };
    assert_eq!(surface_size.cols, 4096);

    // cols*rows beyond 1_000_000 clamps cols to the budget for the rows.
    let huge =
        terminal_graphics_text_messages(r#"{"type":"resize","cols":6000,"rows":1000}"#, &query);
    let ClientMessage::ClientShellResize {
        surface_size,
        cell_width_px,
        cell_height_px,
        ..
    } = &huge[0]
    else {
        panic!("expected resize");
    };
    assert_eq!(surface_size.rows, 1000);
    assert_eq!(surface_size.cols, 1000); // 1_000_000 / 1000
    assert_eq!(cell_width_px, &query.cell_width_px.unwrap());
    assert_eq!(cell_height_px, &query.cell_height_px.unwrap());

    // Cell metrics clamp to 4096 px too.
    let cells = terminal_graphics_text_messages(
        r#"{"type":"resize","cols":80,"rows":24,"cell_width_px":9999,"cell_height_px":9999}"#,
        &query,
    );
    let ClientMessage::ClientShellResize {
        cell_width_px,
        cell_height_px,
        ..
    } = &cells[0]
    else {
        panic!("expected resize");
    };
    assert_eq!(cell_width_px, &4096);
    assert_eq!(cell_height_px, &4096);

    // Missing fields fall back to the query geometry (already clamped
    // at handshake time), and zero/negative-ish values clamp to 1.
    let fallback = terminal_graphics_text_messages(r#"{"type":"resize"}"#, &query);
    let ClientMessage::ClientShellResize { surface_size, .. } = &fallback[0] else {
        panic!("expected resize");
    };
    assert_eq!(surface_size.cols, 100);
    assert_eq!(surface_size.rows, 30);
}

#[test]
fn terminal_text_messages_resize_clamps_and_defaults() {
    let resize = terminal_text_messages(r#"{"type":"resize","cols":300,"rows":40}"#);
    match &resize[0] {
        ClientMessage::Resize {
            cols,
            rows,
            cell_width_px,
            cell_height_px,
            pixel_mouse,
        } => {
            assert_eq!(cols, &300);
            assert_eq!(rows, &40);
            assert_eq!(cell_width_px, &0);
            assert_eq!(cell_height_px, &0);
            assert!(!pixel_mouse);
        }
        other => panic!("expected Resize, got {other:?}"),
    }
    // Oversized geometry caps at u16::MAX instead of truncating.
    let capped = terminal_text_messages(r#"{"type":"resize","cols":99999,"rows":99999}"#);
    match &capped[0] {
        ClientMessage::Resize { cols, rows, .. } => {
            assert_eq!(cols, &u16::MAX);
            assert_eq!(rows, &u16::MAX);
        }
        other => panic!("expected Resize, got {other:?}"),
    }
    // Missing cols/rows fall back to the documented defaults.
    let defaults = terminal_text_messages(r#"{"type":"resize"}"#);
    match &defaults[0] {
        ClientMessage::Resize { cols, rows, .. } => {
            assert_eq!(cols, &100);
            assert_eq!(rows, &30);
        }
        other => panic!("expected Resize, got {other:?}"),
    }
    // Zero geometry clamps up to 1 instead of collapsing the terminal.
    let clamped = terminal_text_messages(r#"{"type":"resize","cols":0,"rows":0}"#);
    match &clamped[0] {
        ClientMessage::Resize { cols, rows, .. } => {
            assert_eq!(cols, &1);
            assert_eq!(rows, &1);
        }
        other => panic!("expected Resize, got {other:?}"),
    }
}

#[test]
fn terminal_text_messages_scroll_maps_direction_lines_and_position() {
    let scroll = terminal_text_messages(
        r#"{"type":"scroll","direction":"up","lines":5,"column":3,"row":9,"modifiers":2}"#,
    );
    match &scroll[0] {
        ClientMessage::AttachScroll {
            source,
            direction,
            lines,
            column,
            row,
            modifiers,
        } => {
            assert!(matches!(source, AttachScrollSource::Wheel));
            assert!(matches!(direction, AttachScrollDirection::Up));
            assert_eq!(lines, &5);
            assert_eq!(column, &Some(3));
            assert_eq!(row, &Some(9));
            assert_eq!(modifiers, &2);
        }
        other => panic!("expected AttachScroll, got {other:?}"),
    }
    // Unknown direction defaults to down; missing lines defaults to 3.
    let down = terminal_text_messages(r#"{"type":"scroll","direction":"sideways"}"#);
    match &down[0] {
        ClientMessage::AttachScroll {
            direction,
            lines,
            column,
            row,
            modifiers,
            ..
        } => {
            assert!(matches!(direction, AttachScrollDirection::Down));
            assert_eq!(lines, &3);
            assert_eq!(column, &None);
            assert_eq!(row, &None);
            assert_eq!(modifiers, &0);
        }
        other => panic!("expected AttachScroll, got {other:?}"),
    }
}

#[test]
fn terminal_text_messages_enter_key_shift_variant_and_paste() {
    let plain_enter = terminal_text_messages(r#"{"type":"key","code":"Enter"}"#);
    match &plain_enter[0] {
        ClientMessage::Input { data } => assert_eq!(data, b"\r"),
        other => panic!("expected Input, got {other:?}"),
    }
    // Shift+Enter is delivered as the Kitty-style CSI-u sequence so the
    // backend can distinguish it from a plain Enter.
    let shift_enter = terminal_text_messages(r#"{"type":"key","code":"Enter","modifiers":1}"#);
    match &shift_enter[0] {
        ClientMessage::Input { data } => assert_eq!(data, b"\x1b[13;2u"),
        other => panic!("expected Input, got {other:?}"),
    }
    // Other keys do not take the Enter shortcut: they fall through to the
    // input-type branch (no "input" field here, so no messages at all).
    let other_key = terminal_text_messages(r#"{"type":"key","code":"Tab"}"#);
    assert!(other_key.is_empty());

    let paste = terminal_text_messages(r#"{"type":"paste","text":"hi"}"#);
    match &paste[0] {
        ClientMessage::Input { data } => {
            assert_eq!(data, b"\x1b[200~hi\x1b[201~");
        }
        other => panic!("expected Input, got {other:?}"),
    }
    // Paste without a text field produces nothing.
    assert!(terminal_text_messages(r#"{"type":"paste"}"#).is_empty());
}

#[test]
fn terminal_text_messages_input_type_and_unknown_types() {
    let input = terminal_text_messages(r#"{"type":"input","input":"echo hi"}"#);
    match &input[0] {
        ClientMessage::Input { data } => assert_eq!(data, b"echo hi"),
        other => panic!("expected Input, got {other:?}"),
    }
    // An unknown JSON type without an input field is dropped, not
    // forwarded as raw JSON bytes.
    assert!(terminal_text_messages(r#"{"type":"mystery"}"#).is_empty());
}
