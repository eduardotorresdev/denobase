// Animated gray dot grid (GitHub-contribution-heatmap look). Only DOM + CSS keyframes (.dots in app.css).

/** Deterministic 0..1 hash of (index, seed): same grid every render, no Math.random. */
export function unit(i, seed) {
  let x = (i + 1) * 374761393 + seed * 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * Grid of cols*rows squares in 5 gray tones, each pulsing with its own CSS delay.
 * size/gap in px. Returns an Element.
 */
export function dots({ cols = 24, rows = 8, seed = 1, size = 8, gap = 3 } = {}) {
  const cells = [];
  for (let i = 0; i < cols * rows; i++) {
    const tone = Math.floor(unit(i, seed) * 5) + 1;
    const delay = (unit(i, seed + 7) * 6).toFixed(2);
    cells.push(t.i({ className: `tone-${tone}`, style: `animation-delay:-${delay}s` }));
  }
  return t.div(
    {
      className: "dots",
      "html-aria-hidden": "true",
      style: `--dots-cols:${cols};--dots-size:${size}px;--dots-gap:${gap}px`,
    },
    ...cells,
  );
}
