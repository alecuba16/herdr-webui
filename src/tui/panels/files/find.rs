//! Editor find bar (webui `HerdrEditor` Ctrl+F): incremental search
//! over the open preview buffer, match-case `A` and regex `X` toggles,
//! Enter next / Shift+Enter previous, Esc closes keeping the query.
//! Replace runs through the shared prompt flow (Ctrl+H opens the
//! "replace with" prompt; Enter replaces the next match, Ctrl+Enter
//! would be replace-all but terminals vary, so `!` in the prompt
//! replaces all — documented deviation, see `ReplaceInFile`).

use regex::RegexBuilder;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::FileExplorer;

/// Cap on collected match ranges (webui caps at 10000).
const MAX_FIND_MATCHES: usize = 10000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EditorFind {
    pub active: bool,
    pub query: String,
    pub match_case: bool,
    pub regex: bool,
    /// Byte-offset ranges of the current query in `preview.content`.
    pub ranges: Vec<(usize, usize)>,
    /// Index into `ranges` of the current match (wraps like the webui).
    pub selected: usize,
}

impl EditorFind {
    pub fn clear(&mut self) {
        self.active = false;
        self.ranges.clear();
        self.selected = 0;
    }
}

/// Build the search regex the same way the webui editor does: literal
/// query escaped unless `regex` is on, case-insensitive unless
/// `match_case` is on.
fn build_regex(query: &str, match_case: bool, regex: bool) -> Result<regex::Regex, String> {
    if query.is_empty() {
        return Err("empty query".to_string());
    }
    let source = if regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let mut builder = RegexBuilder::new(&source);
    builder.case_insensitive(!match_case);
    builder.build().map_err(|err| err.to_string())
}

/// Recompute match ranges for `query` in `text`.
pub fn find_ranges(text: &str, query: &str, match_case: bool, regex: bool) -> Vec<(usize, usize)> {
    let Ok(re) = build_regex(query, match_case, regex) else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    for m in re.find_iter(text) {
        if m.end() > m.start() {
            ranges.push((m.start(), m.end()));
            if ranges.len() >= MAX_FIND_MATCHES {
                break;
            }
        }
    }
    ranges
}

impl FileExplorer {
    /// Ctrl+F in edit mode: open the find bar. Keeps the last query so
    /// re-opening resumes where the user left off (webui does the same
    /// via stored options).
    pub fn editor_find_open(&mut self) {
        self.editor_find.active = true;
        self.refresh_find();
    }

    pub fn editor_find_close(&mut self) {
        self.editor_find.active = false;
    }

    /// Recompute ranges after query/toggle/content changes and keep
    /// the current selection clamped.
    pub fn refresh_find(&mut self) {
        let query = self.editor_find.query.clone();
        if query.is_empty() {
            self.editor_find.ranges.clear();
            self.editor_find.selected = 0;
            return;
        }
        let match_case = self.editor_find.match_case;
        let regex = self.editor_find.regex;
        self.editor_find.ranges = find_ranges(&self.preview.content, &query, match_case, regex);
        self.editor_find.selected = self
            .editor_find
            .selected
            .min(self.editor_find.ranges.len().saturating_sub(1));
    }

    pub fn push_find_char(&mut self, ch: char) {
        self.editor_find.query.push(ch);
        self.refresh_find();
    }

    pub fn pop_find_char(&mut self) {
        self.editor_find.query.pop();
        self.refresh_find();
    }

    /// Move to the next/previous match, wrapping (webui ↑/↓ buttons).
    pub fn editor_find_next(&mut self, forward: bool) {
        if self.editor_find.ranges.is_empty() {
            return;
        }
        let len = self.editor_find.ranges.len();
        let delta: isize = if forward { 1 } else { -1 };
        let next = (self.editor_find.selected as isize + delta).rem_euclid(len as isize) as usize;
        self.editor_find.selected = next;
        // Follow the match with the edit cursor so the preview scrolls.
        let (start, _) = self.editor_find.ranges[next];
        self.edit_cursor = start.min(self.preview.content.len());
    }

    /// Replace the current match (or all matches) with `replacement`
    /// and re-run the search (webui replace-one / replace-all buttons).
    pub fn editor_replace(&mut self, replacement: &str, all: bool) -> Result<(), WebApiError> {
        if self.editor_find.ranges.is_empty() {
            return Err(WebApiError::Io("no find matches to replace".to_string()));
        }
        if all {
            // Replace from the end so earlier offsets stay valid.
            for (start, end) in self.editor_find.ranges.iter().rev() {
                self.preview.content.replace_range(start..end, replacement);
            }
        } else {
            let (start, end) = self.editor_find.ranges[self.editor_find.selected];
            self.preview.content.replace_range(start..end, replacement);
        }
        self.preview.dirty = true;
        self.refresh_find();
        Ok(())
    }

    /// Save after a replace ran through the prompt (Ctrl+S parity is
    /// handled in edit_key; the prompt close re-enters edit mode).
    pub fn editor_save(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        self.save_preview(api)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_ranges_plain_and_case() {
        let ranges = find_ranges("Hello hello", "hello", false, false);
        assert_eq!(ranges, vec![(0, 5), (6, 11)]);
        let case = find_ranges("Hello hello", "hello", true, false);
        assert_eq!(case, vec![(6, 11)]);
    }

    #[test]
    fn find_ranges_regex_and_invalid() {
        let ranges = find_ranges("abc123", "\\d+", false, true);
        assert_eq!(ranges, vec![(3, 6)]);
        assert!(find_ranges("abc", "(", false, true).is_empty());
        // Empty query: no matches, no panic.
        assert!(find_ranges("abc", "", false, false).is_empty());
    }

    #[test]
    fn next_wraps_both_directions() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview.content = "a b a b".to_string();
        explorer.editor_find.query = "a".to_string();
        explorer.refresh_find();
        assert_eq!(explorer.editor_find.ranges.len(), 2);
        explorer.editor_find_next(true);
        assert_eq!(explorer.editor_find.selected, 1);
        explorer.editor_find_next(true);
        assert_eq!(explorer.editor_find.selected, 0);
        explorer.editor_find_next(false);
        assert_eq!(explorer.editor_find.selected, 1);
    }

    #[test]
    fn replace_one_and_all() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview.content = "one two one".to_string();
        explorer.editor_find.query = "one".to_string();
        explorer.refresh_find();
        explorer.editor_replace("X", false).unwrap();
        assert_eq!(explorer.preview.content, "X two one");
        assert!(explorer.preview.dirty);
        explorer.editor_replace("Y", true).unwrap();
        assert_eq!(explorer.preview.content, "X two Y");
        assert!(explorer.editor_find.ranges.is_empty());
    }

    #[test]
    fn clear_and_limit_edges_are_covered() {
        let mut find = EditorFind {
            active: true,
            query: "x".to_string(),
            match_case: true,
            regex: false,
            ranges: vec![(0, 1)],
            selected: 5,
        };
        find.clear();
        assert!(!find.active);
        assert!(find.ranges.is_empty());
        assert_eq!(find.selected, 0);

        let haystack = "a".repeat(MAX_FIND_MATCHES + 5);
        let ranges = find_ranges(&haystack, "a", false, false);
        assert_eq!(ranges.len(), MAX_FIND_MATCHES);
    }

    #[test]
    fn file_explorer_find_mutators_and_replace_errors() {
        let mut explorer = FileExplorer::new("/repo");
        explorer.preview.content = "abc abc".to_string();
        explorer.editor_find_open();
        assert!(explorer.editor_find.active);
        explorer.push_find_char('a');
        explorer.push_find_char('b');
        assert_eq!(explorer.editor_find.ranges, vec![(0, 2), (4, 6)]);
        explorer.pop_find_char();
        assert_eq!(explorer.editor_find.query, "a");
        explorer.editor_find_next(true);
        assert_eq!(explorer.edit_cursor, 4);
        explorer.editor_find.query = "missing".to_string();
        explorer.refresh_find();
        explorer.editor_find_next(true);
        let err = explorer.editor_replace("x", false).unwrap_err();
        assert!(err.to_string().contains("no find matches"));
        explorer.editor_find_close();
        assert!(!explorer.editor_find.active);
    }
}
