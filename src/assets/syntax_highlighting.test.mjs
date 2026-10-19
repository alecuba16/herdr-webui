import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const context = vm.createContext({ window: {}, console, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL("./vendor/codemirror.bundle.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("./desktop/git_ui/syntax.js", import.meta.url), "utf8"), context);
const editor = context.HerdrCodeMirror;
const preview = context.window.HerdrGitSyntax;

function tokensFor(path, content) {
  const language = editor.languageForPath(path);
  ok(language, `Missing editor parser for ${path}`);
  const parser = language.parser || language.language.parser;
  const tokens = [];
  parser.parse(content).iterate({
    enter(node) {
      if (!node.type.isTop) tokens.push({ type: node.name, text: content.slice(node.from, node.to) });
    },
  });
  return tokens;
}

describe("TOML and shell syntax highlighting", () => {
  for (const path of ["Cargo.toml", "config/settings.toml", "CONFIG.TOML"]) {
    it(`recognizes ${path} in the shipped editor and previews`, () => {
      ok(editor.languageForPath(path));
      equal(editor.languageNameForPath(path), "toml");
      equal(preview.languageFor(path), "toml");
    });
  }

  for (const path of ["scripts/run.sh", "scripts/run.bash", "run.zsh", "RUN.BASH", ".bashrc", "home/.bash_profile", ".bash_login", ".bash_logout", ".profile"]) {
    it(`recognizes ${path} as shell in the shipped editor and previews`, () => {
      ok(editor.languageForPath(path));
      equal(editor.languageNameForPath(path), "shell");
      equal(preview.languageFor(path), "shell");
    });
  }

  it("parses TOML tables, keys, strings, booleans, numbers and comments", () => {
    const tokens = tokensFor("Cargo.toml", '# Settings\n[package]\nname = "herdr"\nenabled = true\ncount = 42\n');
    for (const token of [
      { type: "comment", text: "# Settings" },
      { type: "atom", text: "[package]" },
      { type: "propertyName", text: "name" },
      { type: "string", text: '"herdr"' },
      { type: "atom", text: "true" },
      { type: "number", text: "42" },
    ]) {
      ok(tokens.some((actual) => actual.type === token.type && actual.text === token.text), JSON.stringify(token));
    }
  });

  it("keeps multiline TOML strings separate from comments", () => {
    const tokens = tokensFor("settings.toml", 'message = """\nhello # not a comment\nworld\n"""\n# comment\n');
    ok(tokens.some((token) => token.type === "string" && token.text === "hello # not a comment"));
    deepEqual(tokens.filter((token) => token.type === "comment"), [{ type: "comment", text: "# comment" }]);
  });

  it("parses Bash shebangs, comments, keywords, variables and strings", () => {
    const tokens = tokensFor("run.bash", '#!/usr/bin/env bash\n# greeting\nexport NAME="world"\nif [ "$NAME" ]; then\n  echo "hello ${NAME}"\nfi\n');
    for (const token of [
      { type: "meta", text: "#!/usr/bin/env bash" },
      { type: "comment", text: "# greeting" },
      { type: "keyword", text: "export" },
      { type: "keyword", text: "if" },
      { type: "keyword", text: "then" },
      { type: "keyword", text: "fi" },
      { type: "variableName.definition", text: "${NAME}" },
      { type: "string", text: '"world"' },
    ]) {
      ok(tokens.some((actual) => actual.type === token.type && actual.text === token.text), JSON.stringify(token));
    }
  });

  it("keeps quoted Bash heredoc content in the string token", () => {
    const tokens = tokensFor("run.sh", "cat <<'EOF'\nhello $NAME\nEOF\necho done\n");
    ok(tokens.some((token) => token.type === "string.special" && token.text === "hello $NAME"));
    ok(tokens.some((token) => token.type === "variableName.standard" && token.text === "echo"));
  });

  it("highlights TOML values and comments in read-only previews and diffs", () => {
    match(preview.highlight('name = "herdr"', "Cargo.toml"), /<span class="git-ui-syn-str">&quot;herdr&quot;<\/span>/);
    match(preview.highlight("enabled = true", "Cargo.toml"), /<span class="git-ui-syn-kw">true<\/span>/);
    match(preview.highlight("count = 42", "Cargo.toml"), /<span class="git-ui-syn-num">42<\/span>/);
    match(preview.highlight("# Settings", "Cargo.toml"), /<span class="git-ui-syn-com"># Settings<\/span>/);
  });

  it("preserves Bash preview highlighting for scripts and startup files", () => {
    for (const path of ["run.bash", "run.sh", ".bashrc"]) {
      match(preview.highlight('export NAME="world"', path), /<span class="git-ui-syn-kw">export<\/span>/);
      match(preview.highlight('export NAME="world"', path), /<span class="git-ui-syn-str">&quot;world&quot;<\/span>/);
      match(preview.highlight("# greeting", path), /<span class="git-ui-syn-com"># greeting<\/span>/);
    }
  });

  it("escapes markup in TOML and Bash previews without changing source text", () => {
    const source = 'value = "<script>alert(1)</script> & more"';
    for (const path of ["settings.toml", "run.bash"]) {
      const html = preview.highlight(source, path);
      ok(!html.includes("<script>"));
      equal(html.replace(/<\/?span\b[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), source);
    }
  });

  it("preserves unsupported and existing language behavior", () => {
    equal(editor.languageForPath("notes.txt"), null);
    equal(editor.languageForPath(""), null);
    equal(editor.languageNameForPath(""), "text");
    equal(preview.languageFor("notes.txt"), "text");
    equal(preview.highlight("<plain>", "notes.txt"), "&lt;plain&gt;");
    equal(preview.highlight("", "settings.toml"), "");
    ok(editor.languageForPath("app.js"));
    ok(editor.languageForPath("settings.json"));
    equal(editor.languageNameForPath("app.js"), "javascript");
    equal(preview.languageFor("app.js"), "js");
  });
});
