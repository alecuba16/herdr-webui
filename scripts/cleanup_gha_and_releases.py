#!/usr/bin/env python3
"""Clean up GitHub Actions runs and releases across all user repos."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime


OWNER = "alecuba16"
NON_DELETABLE_STATUSES = {
    "in_progress",
    "queued",
    "waiting",
    "requested",
    "pending",
}
DELETABLE_STATUSES = {
    "completed",
    "failure",
    "cancelled",
    "skipped",
    "stale",
    "timed_out",
    "action_required",
    "neutral",
    "startup_failure",
}


@dataclass
class RepoResult:
    repo: str
    runs_total: int = 0
    runs_kept: int = 0
    runs_deleted: int = 0
    runs_failed: int = 0
    releases_total: int = 0
    releases_kept: int = 0
    releases_deleted: int = 0
    releases_failed: int = 0
    errors: list[str] = field(default_factory=list)


def gh(*args: str, check: bool = True) -> str:
    cmd = ["gh", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "gh command failed")
    return result.stdout


def gh_json(*args: str) -> object:
    return json.loads(gh(*args))


def parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def list_repos() -> list[str]:
    repos = gh_json("repo", "list", OWNER, "--limit", "200", "--json", "nameWithOwner")
    return [item["nameWithOwner"] for item in repos]


def fetch_runs(repo: str) -> list[dict]:
    runs: list[dict] = []
    page = 1
    while True:
        payload = gh_json(
            "api",
            f"repos/{repo}/actions/runs?per_page=100&page={page}",
        )
        batch = payload.get("workflow_runs", [])
        if not batch:
            break
        runs.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return runs


def fetch_releases(repo: str) -> list[dict]:
    releases: list[dict] = []
    page = 1
    while True:
        try:
            batch = gh_json(
                "api",
                f"repos/{repo}/releases?per_page=100&page={page}",
            )
        except RuntimeError:
            break
        if not isinstance(batch, list) or not batch:
            break
        releases.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return releases


def delete_run(repo: str, run_id: int) -> None:
    result = subprocess.run(
        ["gh", "run", "delete", str(run_id), "-R", repo],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "run delete failed")


def delete_release(repo: str, tag: str) -> None:
    gh("release", "delete", tag, "-R", repo, "-y", check=True)


def cleanup_repo(repo: str) -> RepoResult:
    result = RepoResult(repo=repo)
    print(f"\n=== {repo} ===")

    runs = fetch_runs(repo)
    result.runs_total = len(runs)
    if runs:
        latest_by_workflow: dict[int, dict] = {}
        for run in runs:
            workflow_id = run["workflow_id"]
            current = latest_by_workflow.get(workflow_id)
            if current is None or parse_dt(run["created_at"]) > parse_dt(current["created_at"]):
                latest_by_workflow[workflow_id] = run

        keep_ids = {run["id"] for run in latest_by_workflow.values()}
        result.runs_kept = len(keep_ids)
        to_delete = [run for run in runs if run["id"] not in keep_ids]
        kept_names = ", ".join(sorted({run["name"] for run in latest_by_workflow.values()}))
        print(f"Runs: {result.runs_total} total, keeping {result.runs_kept} ({kept_names})")

        for run in sorted(to_delete, key=lambda item: parse_dt(item["created_at"])):
            status = run.get("status", "")
            if status in NON_DELETABLE_STATUSES or status not in DELETABLE_STATUSES:
                continue
            try:
                delete_run(repo, run["id"])
                result.runs_deleted += 1
                if result.runs_deleted % 25 == 0:
                    print(f"  deleted {result.runs_deleted}/{len(to_delete)} runs...")
                    time.sleep(0.5)
            except RuntimeError as exc:
                result.runs_failed += 1
                result.errors.append(f"run {run['id']}: {exc}")
    else:
        print("Runs: none")

    releases = fetch_releases(repo)
    result.releases_total = len(releases)
    if releases:
        releases_sorted = sorted(
            releases,
            key=lambda item: parse_dt(item.get("published_at") or item.get("created_at")),
            reverse=True,
        )
        keep = releases_sorted[0]
        keep_tag = keep["tag_name"]
        keep_date = keep.get("published_at") or keep.get("created_at")
        result.releases_kept = 1
        to_delete = releases_sorted[1:]
        print(f"Releases: {result.releases_total} total, keeping {keep_tag} ({keep_date})")

        for release in to_delete:
            tag = release["tag_name"]
            try:
                delete_release(repo, tag)
                result.releases_deleted += 1
            except RuntimeError as exc:
                result.releases_failed += 1
                result.errors.append(f"release {tag}: {exc}")
    else:
        print("Releases: none")

    print(
        f"Done: deleted {result.runs_deleted} runs, {result.releases_deleted} releases"
        + (
            f"; failures: {result.runs_failed} runs, {result.releases_failed} releases"
            if result.runs_failed or result.releases_failed
            else ""
        )
    )
    return result


def main() -> int:
    repos = list_repos()
    print(f"Processing {len(repos)} repositories for {OWNER}")

    results: list[RepoResult] = []
    for index, repo in enumerate(repos, start=1):
        print(f"\n[{index}/{len(repos)}]", end="")
        try:
            results.append(cleanup_repo(repo))
        except RuntimeError as exc:
            failure = RepoResult(repo=repo, errors=[str(exc)])
            results.append(failure)
            print(f"\n=== {repo} ===\nERROR: {exc}")

    with open(LOG_PATH, "w", encoding="utf-8") as handle:
        handle.write(json.dumps([result.__dict__ for result in results], indent=2))
        handle.write("\n")

    total_runs_deleted = sum(item.runs_deleted for item in results)
    total_releases_deleted = sum(item.releases_deleted for item in results)
    total_failures = sum(len(item.errors) for item in results)

    print("\n=== SUMMARY ===")
    print(f"Repos processed: {len(results)}")
    print(f"Runs deleted: {total_runs_deleted}")
    print(f"Releases deleted: {total_releases_deleted}")
    print(f"Failures: {total_failures}")
    print(f"Log written to: {LOG_PATH}")

    return 1 if total_failures else 0


if __name__ == "__main__":
    sys.exit(main())
