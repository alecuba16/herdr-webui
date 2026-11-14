use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub fn key_to_terminal_bytes(key: KeyEvent) -> Option<Vec<u8>> {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if let KeyCode::Char(ch) = key.code {
            let lower = ch.to_ascii_lowercase();
            if lower.is_ascii_lowercase() {
                return Some(vec![(lower as u8) - b'a' + 1]);
            }
        }
    }
    match key.code {
        KeyCode::Char(ch) => Some(ch.to_string().into_bytes()),
        KeyCode::Enter => Some(b"\r".to_vec()),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(b"\t".to_vec()),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Home => Some(b"\x1b[H".to_vec()),
        KeyCode::End => Some(b"\x1b[F".to_vec()),
        KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
        _ => None,
    }
}

pub fn is_menu_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b')
}

#[cfg(test)]
mod coverage_tests {
    use super::key_to_terminal_bytes;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    #[test]
    fn control_keys_only_map_ascii_letters_and_digits() {
        // Ctrl with a non-letter char falls through to the plain-key map.
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::new(KeyCode::Char('1'), KeyModifiers::CONTROL)),
            Some(b"1".to_vec())
        );
        // Ctrl with a non-char key falls through to the plain-key map:
        // Ctrl+Home serializes like plain Home.
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)),
            Some(b"\x1b[H".to_vec())
        );
        // Media keys have no terminal encoding.
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::from(KeyCode::Media(
                crossterm::event::MediaKeyCode::Play
            ))),
            None
        );
        // Uppercase letters normalize to the lowercase control byte.
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::new(KeyCode::Char('Z'), KeyModifiers::CONTROL)),
            Some(vec![26])
        );
    }
}
