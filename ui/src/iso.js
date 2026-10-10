// Isometric login scene: an edge-to-edge field of cubes whose top faces change color in a
// diagonal wave (.iso in app.css). The SVG uses "slice" so the field bleeds off every edge.
// Plain SVG string, no deps.

const N = 36; // cubes per side
const W = 56; // top-face width
const H = 28; // top-face height
const D = 26; // cube depth

// Deterministic pseudo-random per cube, so the relief is stable between renders.
function rand(i, j) {
  const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function cube(i, j) {
  const r = rand(i, j);
  const sunk = r < 0.07;
  const raised = r > 0.9;
  const black = r > 0.985;
  const cx = (i - j) * W / 2;
  const cy = (i + j) * H / 2 + (sunk ? 10 : raised ? -14 : 0);
  const hw = W / 2, hh = H / 2;
  const top = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`;
  const left = `${cx - hw},${cy} ${cx},${cy + hh} ${cx},${cy + hh + D} ${cx - hw},${cy + D}`;
  const right = `${cx + hw},${cy} ${cx},${cy + hh} ${cx},${cy + hh + D} ${cx + hw},${cy + D}`;
  const cls = black ? "t black" : sunk ? "t sunk" : "t";
  const delay = ((i + j) * 0.22).toFixed(2);
  return `<polygon class="l" points="${left}"/><polygon class="r" points="${right}"/>` +
    `<polygon class="${cls}" style="animation-delay:${delay}s" points="${top}"/>`;
}

export function isoScene() {
  const cubes = [];
  for (let s = 0; s <= 2 * (N - 1); s++) {
    for (let i = 0; i < N; i++) {
      const j = s - i;
      if (j >= 0 && j < N) cubes.push(cube(i, j));
    }
  }
  // The field is a diamond of half-width N*W/2 and half-height N*H/2 centered at (0, N*H/2).
  // The viewBox is a square inside it (|x|/(N*W/2) + |y|/(N*H/2) <= 1), so "slice" scaling
  // never shows an empty corner in a portrait or landscape panel.
  const half = 0.95 / (2 / (N * W) + 2 / (N * H));
  const vw = 2 * half, vh = 2 * half;
  const svg = `<svg class="iso" viewBox="${-vw / 2} ${N * H / 2 - vh / 2} ${vw} ${vh}" ` +
    `preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<g class="cubes">${cubes.join("")}</g></svg>`;
  const el = document.createElement("div");
  el.className = "iso-wrap";
  el.innerHTML = svg;
  return el;
}
