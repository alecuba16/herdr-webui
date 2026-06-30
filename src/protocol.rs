use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

pub(crate) fn write_message<W: Write, M: Serialize>(writer: &mut W, msg: &M) -> Result<(), String> {
    let payload = bincode::serde::encode_to_vec(msg, bincode::config::standard())
        .map_err(|err| err.to_string())?;
    let len = u32::try_from(payload.len()).map_err(|_| "payload too large".to_string())?;
    writer
        .write_all(&len.to_le_bytes())
        .map_err(|err| err.to_string())?;
    writer.write_all(&payload).map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

pub(crate) fn read_message<R: Read, M: for<'de> Deserialize<'de>>(
    reader: &mut R,
    max_frame_size: usize,
) -> Result<M, String> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(|err| err.to_string())?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > max_frame_size {
        return Err(format!("frame size {len} exceeds maximum {max_frame_size}"));
    }
    let mut payload = vec![0u8; len];
    reader
        .read_exact(&mut payload)
        .map_err(|err| err.to_string())?;
    let (msg, consumed) = bincode::serde::decode_from_slice(&payload, bincode::config::standard())
        .map_err(|err| err.to_string())?;
    if consumed != len {
        return Err("trailing bytes in frame".into());
    }
    Ok(msg)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RenderEncoding {
    SemanticFrame,
    TerminalAnsi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientKeybindings {
    Server,
    Local { keys_toml: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientLaunchMode {
    App,
    TerminalAttach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientMessage {
    Hello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        requested_encoding: RenderEncoding,
        keybindings: ClientKeybindings,
        launch_mode: ClientLaunchMode,
    },
    Input {
        data: Vec<u8>,
    },
    ClipboardImage {
        extension: String,
        data: Vec<u8>,
    },
    Resize {
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    Detach,
    AttachTerminal {
        terminal_id: String,
        takeover: bool,
    },
    AttachScroll {
        source: AttachScrollSource,
        direction: AttachScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
    InputEvents {
        events: Vec<ClientInputEvent>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum AttachScrollDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum AttachScrollSource {
    Wheel,
    PageKey { input: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientInputEvent {
    Key {
        code: ClientKeyCode,
        modifiers: u8,
        kind: ClientKeyKind,
    },
    Mouse {
        kind: ClientMouseKind,
        column: u16,
        row: u16,
        modifiers: u8,
    },
    Paste {
        text: String,
    },
    FocusGained,
    FocusLost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientKeyKind {
    Press,
    Repeat,
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientKeyCode {
    Backspace,
    Enter,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Tab,
    BackTab,
    Delete,
    Insert,
    Esc,
    Char(char),
    F(u8),
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ClientMouseKind {
    Down(ClientMouseButton),
    Up(ClientMouseButton),
    Drag(ClientMouseButton),
    Moved,
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CellData {
    symbol: String,
    fg: u32,
    bg: u32,
    modifier: u16,
    skip: bool,
    hyperlink: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CursorState {
    x: u16,
    y: u16,
    visible: bool,
    #[serde(default)]
    shape: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FrameData {
    cells: Vec<CellData>,
    width: u16,
    height: u16,
    cursor: Option<CursorState>,
    hyperlinks: Vec<String>,
    graphics: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TerminalFrame {
    pub(crate) seq: u64,
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) full: bool,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum NotifyKind {
    Sound,
    Toast,
    SystemToast,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ServerMessage {
    Welcome {
        version: u32,
        encoding: RenderEncoding,
        error: Option<String>,
    },
    Frame(FrameData),
    Terminal(TerminalFrame),
    Graphics {
        bytes: Vec<u8>,
    },
    ServerShutdown {
        reason: Option<String>,
    },
    Notify {
        kind: NotifyKind,
        message: String,
        body: Option<String>,
    },
    Clipboard {
        data: String,
    },
    WindowTitle {
        title: Option<String>,
    },
    ReloadSoundConfig,
    MouseCapture {
        enabled: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("write failed"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn round_trips_client_and_server_message_variants() {
        let client = ClientMessage::Hello {
            version: 14,
            cols: 120,
            rows: 40,
            cell_width_px: 8,
            cell_height_px: 16,
            requested_encoding: RenderEncoding::SemanticFrame,
            keybindings: ClientKeybindings::Local {
                keys_toml: "[keys]".to_string(),
            },
            launch_mode: ClientLaunchMode::TerminalAttach,
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &client).unwrap();
        assert_eq!(
            read_message::<_, ClientMessage>(&mut bytes.as_slice(), 1024).unwrap(),
            client
        );

        let server = ServerMessage::Frame(FrameData {
            cells: vec![CellData {
                symbol: "x".to_string(),
                fg: 1,
                bg: 2,
                modifier: 3,
                skip: false,
                hyperlink: Some(0),
            }],
            width: 1,
            height: 1,
            cursor: Some(CursorState {
                x: 0,
                y: 0,
                visible: true,
                shape: 1,
            }),
            hyperlinks: vec!["https://example.test".to_string()],
            graphics: vec![1, 2, 3],
        });
        let mut bytes = Vec::new();
        write_message(&mut bytes, &server).unwrap();
        assert_eq!(
            read_message::<_, ServerMessage>(&mut bytes.as_slice(), 2048).unwrap(),
            server
        );
    }

    #[test]
    fn round_trips_input_event_and_notify_variants() {
        let client = ClientMessage::InputEvents {
            events: vec![
                ClientInputEvent::Key {
                    code: ClientKeyCode::F(5),
                    modifiers: 1,
                    kind: ClientKeyKind::Repeat,
                },
                ClientInputEvent::Mouse {
                    kind: ClientMouseKind::Drag(ClientMouseButton::Left),
                    column: 7,
                    row: 9,
                    modifiers: 2,
                },
                ClientInputEvent::Paste {
                    text: "hello".to_string(),
                },
                ClientInputEvent::FocusGained,
                ClientInputEvent::FocusLost,
            ],
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &client).unwrap();
        assert_eq!(
            read_message::<_, ClientMessage>(&mut bytes.as_slice(), 4096).unwrap(),
            client
        );

        for kind in [
            NotifyKind::Sound,
            NotifyKind::Toast,
            NotifyKind::SystemToast,
        ] {
            let server = ServerMessage::Notify {
                kind,
                message: "msg".to_string(),
                body: Some("body".to_string()),
            };
            let mut bytes = Vec::new();
            write_message(&mut bytes, &server).unwrap();
            assert_eq!(
                read_message::<_, ServerMessage>(&mut bytes.as_slice(), 1024).unwrap(),
                server
            );
        }
    }

    #[test]
    fn rejects_short_large_invalid_and_trailing_frames() {
        let err = read_message::<_, ClientMessage>(&mut [1, 0].as_slice(), 1024).unwrap_err();
        assert!(err.contains("failed to fill whole buffer"));

        let mut too_large = Vec::new();
        too_large.extend_from_slice(&10u32.to_le_bytes());
        let err = read_message::<_, ClientMessage>(&mut too_large.as_slice(), 2).unwrap_err();
        assert!(err.contains("frame size 10 exceeds maximum 2"));

        let mut invalid = Vec::new();
        invalid.extend_from_slice(&3u32.to_le_bytes());
        invalid.extend_from_slice(&[1, 2, 3]);
        assert!(read_message::<_, ClientMessage>(&mut invalid.as_slice(), 1024).is_err());

        let mut payload =
            bincode::serde::encode_to_vec(ClientMessage::Detach, bincode::config::standard())
                .unwrap();
        payload.push(0);
        let mut trailing = Vec::new();
        trailing.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        trailing.extend_from_slice(&payload);
        let err = read_message::<_, ClientMessage>(&mut trailing.as_slice(), 1024).unwrap_err();
        assert_eq!(err, "trailing bytes in frame");
    }

    #[test]
    fn write_message_reports_writer_failure() {
        let err = write_message(&mut FailingWriter, &ClientMessage::Detach).unwrap_err();
        assert_eq!(err, "write failed");
    }

    #[test]
    fn failing_writer_flush_is_noop() {
        let mut writer = FailingWriter;
        writer.flush().unwrap();
    }
}
