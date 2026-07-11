(function () {
  function nextContextSize(current, opts) {
    const options = opts || {};
    const min = Math.max(0, Number(options.min) || 0);
    const max = Math.max(min, Number(options.max) || 200);
    const value = Math.max(0, Number(current) || 0);
    const next = value < min ? min : value * 2;
    return Math.min(max, Math.max(min, next || min));
  }

  function mergeChunk(target, source) {
    if (!target || !source || !Array.isArray(source.rows)) return target;
    const byLine = new Map((target.rows || []).map((row) => [row.line, row]));
    for (const row of source.rows) {
      const existing = byLine.get(row.line);
      if (!existing || (!existing.matched && row.matched)) byLine.set(row.line, row);
    }
    target.rows = [...byLine.values()].sort((a, b) => Number(a.line || 0) - Number(b.line || 0));
    target.start = target.rows.length ? target.rows[0].line : target.start;
    target.end = target.rows.length ? target.rows[target.rows.length - 1].line : target.end;
    target.matches = (target.matches || []).concat(source.matches || []);
    return target;
  }

  function pushMergedChunk(chunks, chunk) {
    if (!Array.isArray(chunks) || !chunk || !Array.isArray(chunk.rows) || !chunk.rows.length) return chunks;
    const last = chunks[chunks.length - 1];
    if (last && Number(chunk.start) <= Number(last.end) + 1) mergeChunk(last, chunk);
    else chunks.push(chunk);
    return chunks;
  }

  globalThis.HerdrLineContext = { nextContextSize, mergeChunk, pushMergedChunk };
})();
