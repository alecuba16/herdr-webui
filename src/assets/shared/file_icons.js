(function () {
  const FILE_ICON_BY_EXT = {
    c: ["c", "C"], cc: ["cpp", "C++"], cpp: ["cpp", "C++"], cxx: ["cpp", "C++"], h: ["c", "H"], hpp: ["cpp", "H++"],
    css: ["css", "CSS"], scss: ["css", "SC"], sass: ["css", "SA"], less: ["css", "LE"],
    go: ["go", "GO"], html: ["html", "HT"], htm: ["html", "HT"], java: ["java", "JV"], kt: ["kotlin", "KT"], kts: ["kotlin", "KT"],
    js: ["js", "JS"], jsx: ["react", "JSX"], mjs: ["js", "MJS"], cjs: ["js", "CJS"], ts: ["ts", "TS"], tsx: ["react", "TSX"],
    json: ["json", "{}"], jsonc: ["json", "{}"], lock: ["lock", "LK"],
    lua: ["lua", "LU"], md: ["md", "MD"], mdx: ["md", "MDX"],
    php: ["php", "PHP"], py: ["python", "PY"], pyw: ["python", "PY"], rb: ["ruby", "RB"], rs: ["rust", "RS"],
    sh: ["shell", "SH"], bash: ["shell", "SH"], zsh: ["shell", "ZH"], fish: ["shell", "FS"],
    sql: ["sql", "SQL"], sqlite: ["db", "DB"], db: ["db", "DB"],
    svg: ["image", "SVG"], png: ["image", "IMG"], jpg: ["image", "IMG"], jpeg: ["image", "IMG"], gif: ["image", "IMG"], webp: ["image", "IMG"], ico: ["image", "ICO"],
    toml: ["toml", "TM"], xml: ["xml", "XML"], yaml: ["yaml", "YML"], yml: ["yaml", "YML"],
  };

  const FILE_ICON_BY_NAME = {
    ".dockerignore": ["docker", "DK"], ".env": ["env", "ENV"], ".env.example": ["env", "ENV"], ".gitignore": ["git", "GIT"],
    "cargo.lock": ["rust", "RS"], "cargo.toml": ["rust", "RS"], "dockerfile": ["docker", "DK"], "go.mod": ["go", "GO"], "go.sum": ["go", "GO"],
    "license": ["license", "LIC"], "makefile": ["make", "MK"], "package.json": ["npm", "NPM"], "pnpm-lock.yaml": ["npm", "PN"],
    "pyproject.toml": ["python", "PY"], "readme": ["md", "MD"], "readme.md": ["md", "MD"], "tsconfig.json": ["ts", "TS"], "vite.config.js": ["js", "JS"], "vite.config.ts": ["ts", "TS"],
  };

  function basename(path) {
    const parts = String(path || "").replace(/\/+$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  function fileType(pathOrName) {
    const name = basename(pathOrName || "").toLowerCase();
    if (FILE_ICON_BY_NAME[name]) return iconInfo(FILE_ICON_BY_NAME[name]);
    if (name.startsWith("dockerfile")) return iconInfo(["docker", "DK"]);
    const parts = name.split(".");
    const ext = parts.length > 1 ? parts.pop() : "";
    if (FILE_ICON_BY_EXT[ext]) return iconInfo(FILE_ICON_BY_EXT[ext]);
    return null;
  }

  function iconInfo(value) {
    return { type: value[0], glyph: value[1] };
  }

  window.HerdrFileIcons = {
    fileType,
  };
})();
