(function () {
  const languages = new Map();
  const aliases = new Map();
  const common = {
    strings: /(&quot;(?:\\.|[^&])*?&quot;|'(?:\\.|[^'])*?')/g,
    number: /\b\d+(?:\.\d+)?\b/g,
    fn: /\b([A-Za-z_$][\w$]*)(?=\s*\()/g,
    typeDecl: /\b(class|interface|struct|enum|trait|type|data class)\s+([A-Za-z_$][\w$]*)/g,
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function register(name, config) {
    languages.set(name, Object.assign({ keywords: "", comments: null }, config));
  }

  function alias(names, language) {
    names.forEach((name) => aliases.set(name, language));
  }

  function words(value) {
    return value.split(/\s+/).filter(Boolean).join("|");
  }

  register("css", { keywords: words("align-items animation background border bottom color content display flex font gap grid height justify-content left margin opacity overflow padding position right text-align top transform width z-index"), comments: /(\/\*.*?\*\/)/g });
  register("html", { keywords: words("body button code div head html input label link meta script section span style table tbody td textarea th thead tr") });
  register("json", { keywords: "true|false|null" });
  register("kotlin", { keywords: words("as break class continue data do else false for fun if in interface is null object package return sealed super this throw true try typealias val var when while"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("make", { keywords: words("include override define endef ifdef ifndef ifeq ifneq else endif export unexport"), comments: /(#.*$)/g });
  register("python", { keywords: words("and as assert async await break class continue def elif else except False finally for from if import in is lambda None not or pass raise return True try while with yield"), comments: /(#.*$)/g });
  register("js", { keywords: words("async await break case catch class const continue default else export extends false finally for from function if import let new null return switch throw true try typeof undefined while yield"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("ts", { keywords: words("abstract any as async await boolean break case catch class const continue declare default else enum export extends false finally for from function if implements import interface keyof let namespace new null number private protected public readonly return string switch throw true try type typeof undefined while yield"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("go", { keywords: words("break case chan const continue defer else fallthrough for func go if import interface map package range return select struct switch type var"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("rust", { keywords: words("as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("java", { keywords: words("abstract assert boolean break case catch class const continue default else enum extends false final finally for if implements import instanceof interface new null package private protected public return static super switch this throw true try void while"), comments: /(\/\/.*$|\/\*.*?\*\/)/g });
  register("yaml", { keywords: "true|false|null", comments: /(#.*$)/g });
  register("shell", { keywords: words("case do done elif else esac export fi for function if in local return then while"), comments: /(#.*$)/g });

  alias(["py", "pyw"], "python");
  alias(["js", "jsx", "mjs", "cjs"], "js");
  alias(["ts", "tsx"], "ts");
  alias(["yml", "yaml"], "yaml");
  alias(["go"], "go");
  alias(["rs"], "rust");
  alias(["java"], "java");
  alias(["kt", "kts"], "kotlin");
  alias(["json", "css", "html", "htm"], (ext) => ext === "htm" ? "html" : ext);
  alias(["sh", "bash", "zsh"], "shell");
  alias(["mk", "mak"], "make");

  function languageFor(path) {
    const name = String(path || "").split("/").pop().toLowerCase();
    if (["makefile", "gnumakefile", "bsdmakefile"].includes(name)) return "make";
    const ext = name.split(".").pop().toLowerCase();
    const lang = aliases.get(ext);
    return typeof lang === "function" ? lang(ext) : lang || "text";
  }

  function highlight(code, path) {
    const config = languages.get(languageFor(path));
    if (!config) return esc(code);
    let html = esc(code);
    const stash = [];
    const tokenId = (index) => {
      let value = index + 1;
      let out = "";
      while (value > 0) {
        value--;
        out = String.fromCharCode(97 + (value % 26)) + out;
        value = Math.floor(value / 26);
      }
      return out;
    };
    const tokenIndex = (id) => id.split("").reduce((value, char) => value * 26 + char.charCodeAt(0) - 96, 0) - 1;
    const hold = (cls, value) => {
      const key = `\uE000${tokenId(stash.length)}\uE001`;
      stash.push(`<span class="${cls}">${value}</span>`);
      return key;
    };
    html = html.replace(common.strings, (value) => hold("git-ui-syn-str", value));
    if (config.comments) html = html.replace(config.comments, (value) => hold("git-ui-syn-com", value));
    html = html.replace(common.typeDecl, (_m, kw, type) => `${hold("git-ui-syn-kw", kw)} ${hold("git-ui-syn-type", type)}`);
    html = html.replace(common.fn, (_m, fn) => hold("git-ui-syn-fn", fn));
    html = html.replace(common.number, (value) => hold("git-ui-syn-num", value));
    if (config.keywords) html = html.replace(new RegExp(`\\b(${config.keywords})\\b`, "g"), (value) => hold("git-ui-syn-kw", value));
    return html.replace(/\uE000([a-z]+)\uE001/g, (_, index) => stash[tokenIndex(index)] || "");
  }

  window.HerdrGitSyntax = { highlight, languageFor, register };
})();
