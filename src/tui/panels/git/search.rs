//! Diff search in the Changes view (webui Ctrl+F in the diff):
//! incremental query, `n`/`N` cycling, highlight of the active match.

use super::GitPanel;

impl GitPanel {
    /// Open the incremental diff search over the loaded diff lines.
    pub fn start_diff_search(&mut self) {
        self.diff_search_active = true;
    }

    /// Close the search bar. Matches stay so `n`/`N` keep cycling after
    /// Enter (webui find keeps highlighting after the bar closes); Esc
    /// clears them. The query is kept so re-opening resumes.
    pub fn end_diff_search(&mut self) {
        self.diff_search_active = false;
    }

    /// Esc: close the bar and forget the matches and query.
    pub fn cancel_diff_search(&mut self) {
        self.end_diff_search();
        self.diff_search_query.clear();
        self.diff_search_matches.clear();
        self.diff_search_selected = 0;
    }

    /// Type into the incremental search: recompute the match set after
    /// every keystroke (webui find is incremental).
    pub fn push_diff_search_char(&mut self, ch: char) {
        if !self.diff_search_active {
            return;
        }
        self.diff_search_query.push(ch);
        self.refresh_diff_search_matches();
    }

    pub fn pop_diff_search_char(&mut self) {
        if !self.diff_search_active {
            return;
        }
        self.diff_search_query.pop();
        self.refresh_diff_search_matches();
    }

    /// Recompute the match indices for the current query. Matching is
    /// case-insensitive over the raw line text (prefix included).
    pub fn refresh_diff_search_matches(&mut self) {
        let query = self.diff_search_query.trim().to_lowercase();
        if query.is_empty() {
            self.diff_search_matches.clear();
            self.diff_search_selected = 0;
            return;
        }
        self.diff_search_matches = self
            .diff_lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.to_lowercase().contains(&query))
            .map(|(index, _)| index)
            .collect();
        self.diff_search_selected = 0;
    }

    /// `n`: next match, wrapping around (webui find next).
    pub fn diff_search_next(&mut self) -> bool {
        self.diff_search_advance(1)
    }

    /// `N`: previous match, wrapping around.
    pub fn diff_search_prev(&mut self) -> bool {
        self.diff_search_advance(-1)
    }

    fn diff_search_advance(&mut self, delta: isize) -> bool {
        if self.diff_search_matches.is_empty() {
            return false;
        }
        let len = self.diff_search_matches.len() as isize;
        let current = self.diff_search_selected as isize;
        self.diff_search_selected = ((current + delta).rem_euclid(len)) as usize;
        true
    }

    /// Index (into `diff_lines`) of the active match, for highlighting.
    /// Works with the bar open AND after Enter closed it (matches kept),
    /// mirroring the webui find highlight that outlives the bar.
    pub fn diff_search_active_line(&self) -> Option<usize> {
        self.diff_search_matches
            .get(self.diff_search_selected)
            .copied()
    }
}
