#!/usr/bin/env bash
# Build a rich example repo for TUI screenshots. Safe to re-run.
set -euo pipefail

ROOT="${1:?usage: make_example_repo.sh <target-dir>}"
rm -rf "$ROOT"
mkdir -p "$ROOT/src" "$ROOT/docs" "$ROOT/scripts" "$ROOT/config"
cd "$ROOT"

git init -q -b main
git config user.name "Ada Example"
git config user.email "ada@example.com"

cat > README.md <<'EOF'
# Aurora Demo

Example repository used to showcase the Herdr WebUI TUI.
It has code, docs, a small history, branches, and a stash.
EOF

cat > src/main.rs <<'EOF'
fn main() {
    let repo = aurora::Repository::open(".");
    let total = repo.entries().iter().map(|e| e.size).sum::<u64>();
    println!("scanned {} entries, {} bytes", repo.entries().len(), total);
    aurora::report::print_summary(&repo);
}
EOF

cat > src/lib.rs <<'EOF'
pub mod report;
pub mod repository;

pub const VERSION: &str = "0.3.1";
EOF

cat > src/repository.rs <<'EOF'
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug)]
pub struct Repository {
    pub root: std::path::PathBuf,
    entries: Vec<Entry>,
}

impl Repository {
    pub fn open(root: impl AsRef<std::path::Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        let entries = Self::walk(&root).unwrap_or_default();
        Self { root, entries }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn walk(root: &std::path::Path) -> std::io::Result<Vec<Entry>> {
        let mut out = Vec::new();
        Self::walk_dir(root, &mut out)?;
        Ok(out)
    }

    fn walk_dir(dir: &std::path::Path, out: &mut Vec<Entry>) -> std::io::Result<()> {
        for item in std::fs::read_dir(dir)? {
            let path = item?.path();
            let meta = std::fs::metadata(&path)?;
            if meta.is_dir() {
                Self::walk_dir(&path, out)?;
            } else {
                let size = meta.len();
                let p = path.display().to_string();
                out.push(Entry { path: p, size });
            }
        }
        Ok(())
    }
}
EOF

cat > src/report.rs <<'EOF'
use crate::repository::Repository;

pub fn print_summary(repo: &Repository) {
    println!("Aurora summary for {}", repo.root.display());
    for entry in repo.entries() {
        println!("  {:>8}  {}", entry.size, entry.path);
    }
}
EOF

cat > docs/architecture.md <<'EOF'
# Architecture

## Overview

Aurora scans a directory tree and prints a size summary.

## Modules

- `repository`: tree walking and entry collection
- `report`: summary printing
- `main`: wiring

## Sequence

1. Open the repository at the given path
2. Walk the tree collecting entries
3. Print the summary

## Notes

The scanner skips nothing yet; filters land in 0.4.
EOF

cat > scripts/run.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cargo run --release -- "$@"
EOF
chmod +x scripts/run.sh

cat > config/settings.toml <<'EOF'
name = "aurora-demo"
theme = "dark"
max_depth = 8

[report]
format = "table"
colors = true
EOF

cat > .gitignore <<'EOF'
/target
.DS_Store
EOF

git add -A
git commit -qm "initial aurora demo"

# Second commit so the log has graph history
cat >> src/lib.rs <<'EOF'

pub fn version_line() -> String {
    format!("aurora {VERSION}")
}
EOF
git add -A
git commit -qm "add version_line helper"

# Branch off main
git checkout -q -b feature/scanner-filters
cat > src/filters.rs <<'EOF'
pub struct Filters {
    pub max_size: Option<u64>,
    pub include_hidden: bool,
}

impl Default for Filters {
    fn default() -> Self {
        Self { max_size: None, include_hidden: false }
    }
}
EOF
sed -i '' 's/pub mod report;/pub mod filters;\npub mod report;/' src/lib.rs
git add -A
git commit -qm "add size filters module"

# Stash entry from a small WIP (needs a tracked change: add, then stash)
git checkout -q main
printf 'TODO: wire filters into walk\n' > src/TODO.md
git add src/TODO.md
git stash push -q -m "wip: filter wiring"
printf 'ignored build dir\n' > debug.log
printf 'scratch notes\n' > scratch.txt

# Uncommitted working-tree changes for the Changes view (staged + unstaged mix)
sed -i '' 's/Aurora scans a directory tree and prints a size summary./Aurora scans a directory tree, applies filters, and prints a size summary./' docs/architecture.md
git add docs/architecture.md
sed -i '' 's/theme = "dark"/theme = "aurora-dark"/' config/settings.toml

# Branches to list
git branch feature/api-refactor
git branch experiment/v2-scanner

echo "example repo ready at $ROOT"
git -C "$ROOT" log --oneline --all | head -8