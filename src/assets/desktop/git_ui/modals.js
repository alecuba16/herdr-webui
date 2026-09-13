(function () {
  function createGitUiModals({ state, active, esc, draftKey, cleanupItemLabel, compactPath, localStorage }) {
      function renderCommitModal() {
        const modal = state.commitModal;
        if (!modal) return "";
        const view = active() || {};
        const key = draftKey(view);
        let draft = { title: "", body: "" };
        try { draft = Object.assign(draft, JSON.parse(localStorage.getItem(key) || "{}")); } catch (_) {}
        const includeBody = !!modal.includeBody;
        const body = includeBody ? `<label>Details<textarea id="gitCommitBody" class="git-ui-textarea" placeholder="Optional body">${esc(draft.body)}</textarea></label>` : "";
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal git-ui-commit-modal"><div class="git-ui-modal-head"><strong>Commit staged changes</strong></div><label>Summary<input id="gitCommitTitle" class="git-ui-input" value="${esc(draft.title)}" placeholder="Short imperative summary"></label><label class="git-ui-check-row"><input id="gitCommitIncludeBody" type="checkbox" ${includeBody ? "checked" : ""} onchange="HerdrGitUi.toggleCommitBody(this.checked)"><span>Add commit body</span></label>${body}<label class="git-ui-check-row"><input id="gitCommitAmend" type="checkbox"><span>Amend previous commit</span></label><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeCommitModal()">Cancel</button><button class="git-ui-btn" onclick="HerdrGitUi.saveDraft()">Save draft</button><button class="git-ui-btn active" onclick="HerdrGitUi.commitFromModal(false)">Commit</button><button class="git-ui-btn primary" onclick="HerdrGitUi.commitFromModal(true)">Commit & Push</button></div></div></div>`;
      }

      function renderResetSelectedModal() {
        const modal = state.resetSelectedModal;
        if (!modal) return "";
        const label = esc((modal.ref || "").slice(0, 12));
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Reset to selected commit</strong></div><p class="git-ui-muted">Choose how to reset the current branch to <strong>${label}</strong>.</p><div class="git-ui-actions"><button class="git-ui-btn" onclick="HerdrGitUi.resetSelected('soft')">Soft reset</button><button class="git-ui-btn danger" onclick="HerdrGitUi.resetSelected('hard')">Hard reset</button></div><div class="git-ui-muted">Soft keeps your changes staged. Hard discards working tree changes and requires confirmation.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedResetModal()">Cancel</button></div></div></div>`;
      }

      function renderCompareSelectedModal() {
        const modal = state.compareSelectedModal;
        if (!modal) return "";
        const label = esc((modal.ref || "").slice(0, 12));
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Compare selected commit</strong></div><p class="git-ui-muted">Choose what to compare with <strong>${label}</strong>.</p><div class="git-ui-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.compareSelectedWithPrevious()">Previous version</button><button class="git-ui-btn" onclick="HerdrGitUi.compareSelectedWithCurrent()">Current changes</button></div><div class="git-ui-muted">Previous version shows the selected commit diff against its parent. Current changes compares the selected commit with your working tree.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedCompareModal()">Cancel</button></div></div></div>`;
      }

      function renderTagSelectedModal() {
        const modal = state.tagSelectedModal;
        if (!modal) return "";
        const label = esc((modal.ref || "").slice(0, 12));
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Tag selected commit</strong></div><p class="git-ui-muted">Create a lightweight tag at <strong>${label}</strong>.</p><label>Tag name<input id="gitTagName" class="git-ui-input" value="${esc(modal.tag || "")}" placeholder="v1.2.3"></label><div class="git-ui-modal-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.createSelectedTag()">Create tag</button><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedTagModal()">Cancel</button></div></div></div>`;
      }

      function renderBranchModal() {
        const modal = state.branchModal;
        if (!modal) return "";
        const cwd = esc(modal.cwd || "");
        const body = modal.loading
          ? `<div class="git-ui-loading"><span></span><strong>Loading branches</strong></div>`
          : modal.error
            ? `<div class="git-ui-error">${esc(modal.error)}</div>`
            : `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiBranchSelect">${branchOptions("Local branches", modal.local || [])}${branchOptions("Remote branches", modal.remote || [])}</select></label>`;
        const dir = `<label class="git-ui-branch-field"><span>Git directory</span><div class="git-ui-inline-field"><input id="gitUiBranchCwd" value="${cwd}" placeholder="/path/to/repo" data-directory-picker-after-select="HerdrGitUi.applyBranchModalCwd"><button type="button" class="mini directory-picker-trigger" onclick="HerdrDirectoryPicker.openInput('gitUiBranchCwd')">Browse</button></div></label>`;
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Switch branch</strong></div>${dir}${body}<div class="git-ui-muted">Choosing a folder moves the Git panel to that directory immediately. Use Switch branch only to checkout another branch in the current Git directory.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeBranchModal()">Cancel</button><button class="git-ui-btn primary" onclick="HerdrGitUi.switchBranchFromModal()" ${modal.loading || modal.error ? "disabled" : ""}>Switch branch</button></div></div></div>`;
      }

      function renderCleanupConfirm() {
        const modal = state.cleanupConfirm;
        if (!modal) return "";
        const items = modal.items || [];
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal git-ui-cleanup-modal"><div class="git-ui-modal-head"><strong>Delete ${items.length} Git cleanup item${items.length === 1 ? "" : "s"}?</strong></div><div class="git-ui-muted">Git will use safe delete first. If Git rejects that because force is required, Herdr retries with force. If deleting the current non-main branch in the primary repo, Herdr checks out main/master first.</div><pre class="git-ui-cleanup-confirm-list">${esc(items.map(cleanupItemLabel).join("\n"))}</pre><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.cancelCleanupDelete()">Cancel</button><button class="git-ui-btn danger" onclick="HerdrGitUi.confirmCleanupDelete()">Delete selected</button></div></div></div>`;
      }

      function renderGitOpModal() {
        const modal = state.gitOpModal;
        if (!modal) return "";
        const branchSelect = renderGitOpBranchSelect(modal);
        const error = modal.error ? `<div class="git-ui-error">${esc(modal.error)}</div>` : "";
        const loading = modal.loading ? `<div class="git-ui-muted">Loading branches...</div>` : "";
        const common = `${loading}${branchSelect}`;
        if (modal.type === "pull") {
          return renderGitOpModalShell("Pull changes", `${common}${renderGitOpModeSelect("Pull option", [["update", "Update (fetch + fast-forward)"], ["regular", "Regular pull"], ["rebase", "Pull with rebase"], ["ff-only", "Fast-forward only"], ["no-ff", "No fast-forward"], ["force", "Force pull"]], "update")}${error}`, "Pull", "primary", "runPullFromModal");
        }
        if (modal.type === "push" || modal.type === "force-push") {
          const force = modal.type === "force-push";
          const pushTags = `<label class="git-ui-check-row"><input id="gitUiPushTags" type="checkbox"><span>Push tags</span></label>`;
          const modeSelect = force
            ? renderGitOpModeSelect("Retry option", [["force-with-lease", "Force with lease"], ["force", "Force push"]], "force-with-lease")
            : "";
          const note = force ? `<div class="git-ui-muted">Regular push failed. Retry with force-with-lease unless you intentionally need --force.</div>` : "";
          const body = `${common}${modeSelect}${pushTags}${note}${error}`;
          return renderGitOpModalShell(force ? "Push failed" : "Push changes", body, force ? "Retry push" : "Push", force ? "danger" : "primary", "runPushFromModal");
        }
        if (modal.type === "fetch-from") {
          return renderGitOpModalShell("Fetch from", `${common}<div class="git-ui-muted">Fetches only the selected branch from origin.</div>${error}`, "Fetch", "primary", "runFetchFromFromModal");
        }
        if (modal.type === "push-to") {
          const pushTags = `<label class="git-ui-check-row"><input id="gitUiPushTags" type="checkbox"><span>Push tags</span></label>`;
          return renderGitOpModalShell("Push to branch", `${common}${pushTags}<div class="git-ui-muted">Pushes the current branch to the selected remote branch.</div>${error}`, "Push", "primary", "runPushToFromModal");
        }
        if (modal.type === "rebase") {
          const body = `${common}<label class="git-ui-branch-field"><span>Rebase commits after</span><input id="gitUiRebaseUpstream" value="HEAD" placeholder="HEAD"></label><label class="git-ui-check-row"><input id="gitUiRebasePullFirst" type="checkbox" checked><span>Fetch selected branch (and main/master) before rebasing onto origin</span></label>${error}`;
          return renderGitOpModalShell("Rebase branch", body, "Rebase", "primary", "runRebaseFromModal");
        }
        return "";
      }

      function renderGitOpBranchSelect(modal) {
        const status = ((active() || {}).status) || {};
        const currentBranch = status.branch || "";
        const branchNames = (modal.branches || []).map((branch) => branch.name || branch).concat([currentBranch, status.upstream || "", "main", "master"]);
        const branches = branchNames.filter((value, index, array) => value && array.indexOf(value) === index);
        const defaultBranch = modal.type === "rebase" ? (branches.find((branch) => branch === "main" || branch === "master") || "") : modal.type === "push-to" ? currentBranch : modal.type === "fetch-from" ? currentBranch : modal.type && modal.type.includes("push") ? currentBranch : "";
        const options = branches.map((branch) => `<option value="${esc(branch)}" ${branch === defaultBranch ? "selected" : ""}>${esc(branch)}${branch === currentBranch ? " (current)" : ""}</option>`).join("");
        return `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiOpBranch"><option value="" ${defaultBranch ? "" : "selected"}>Current upstream</option>${options}</select></label>`;
      }

      function renderGitOpModeSelect(label, options, selected = "regular") {
        return `<label class="git-ui-branch-field"><span>${esc(label)}</span><select id="gitUiOpMode">${options.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
      }

      function renderGitOpModalShell(title, body, actionLabel, actionClass, actionMethod) {
        return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>${esc(title)}</strong></div>${body}<div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeGitOpModal()">Cancel</button><button class="git-ui-btn ${esc(actionClass)}" onclick="HerdrGitUi.${actionMethod}()">${esc(actionLabel)}</button></div></div></div>`;
      }

      function branchOptions(label, branches) {
        if (!branches.length) return "";
        return `<optgroup label="${esc(label)}">${branches.map((branch) => {
          const worktreePath = String(branch.worktree_path || "");
          const worktreeAttrs = worktreePath ? ` data-worktree-path="${esc(worktreePath)}" title="Checked out at ${esc(worktreePath)}"` : "";
          const worktreeLabel = worktreePath ? ` (worktree: ${esc(compactPath(worktreePath))})` : "";
          return `<option value="${branch.remote ? "remote:" : "local:"}${esc(branch.name)}"${worktreeAttrs} ${branch.current ? "selected" : ""}>${esc(branch.name)}${branch.current ? " (current)" : ""}${worktreeLabel}</option>`;
        }).join("")}</optgroup>`;
      }

      function localNameForRemote(remote) {
        const parts = String(remote || "").split("/");
        return parts.length > 1 ? parts.slice(1).join("/") : remote;
      }

    return {
      renderCommitModal,
      renderResetSelectedModal,
      renderCompareSelectedModal,
      renderTagSelectedModal,
      renderBranchModal,
      renderCleanupConfirm,
      renderGitOpModal,
      renderGitOpBranchSelect,
      renderGitOpModeSelect,
      renderGitOpModalShell,
      branchOptions,
      localNameForRemote,
    };
  }

  globalThis.HerdrGitUiModalsModule = { create: createGitUiModals };
})();
