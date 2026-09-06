// Shared, cached access to the browser-local `herdr-web-options` settings.
//
// Every module used to JSON.parse the localStorage blob on each access, and
// several readers run inside render loops (git status per tree render,
// content-search options per search). This module parses once per change:
// the parsed object is cached, `read()` hands out shallow copies so callers
// cannot mutate the cache, and both in-page writes and cross-tab `storage`
// events invalidate it.
(function () {
  var STORAGE_KEY = "herdr-web-options";
  var cachedRaw = null;
  var cachedOptions = null;

  function storage() {
    try {
      return globalThis.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function parse(raw) {
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function read() {
    var store = storage();
    if (!store) return {};
    var raw = store.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) raw = "{}";
    if (raw === cachedRaw && cachedOptions) return shallowCopy(cachedOptions);
    cachedRaw = raw;
    cachedOptions = parse(raw);
    return shallowCopy(cachedOptions);
  }

  function shallowCopy(value) {
    var copy = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) copy[key] = value[key];
    }
    return copy;
  }

  function write(options) {
    var store = storage();
    if (!store) return;
    var next = options && typeof options === "object" ? options : {};
    var raw = JSON.stringify(next);
    store.setItem(STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedOptions = shallowCopy(next);
  }

  function update(mutator) {
    var next = read();
    if (typeof mutator === "function") mutator(next);
    write(next);
    return next;
  }

  function invalidate() {
    cachedRaw = null;
    cachedOptions = null;
  }

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("storage", function (event) {
      if (event && event.key !== STORAGE_KEY && event.key !== null) return;
      invalidate();
    });
  }

  globalThis.HerdrOptions = {
    read: read,
    write: write,
    update: update,
    invalidate: invalidate,
  };
})();