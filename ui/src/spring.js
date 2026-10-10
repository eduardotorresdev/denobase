/**
 * Tiny spring store modeled on Svelte's `spring` (svelte/motion).
 * Numbers only. Honors prefers-reduced-motion by jumping to the target.
 */

const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * @param {number} initial
 * @param {{stiffness?: number, damping?: number, precision?: number}} [opts]
 */
export function spring(initial, { stiffness = 0.15, damping = 0.8, precision = 0.01 } = {}) {
  let value = initial, last = initial, target = initial;
  let frame = 0, lastTime = 0;
  /** @type {Set<(v: number) => void>} */
  const subs = new Set();
  const emit = () => subs.forEach((fn) => fn(value));

  const s = {
    stiffness,
    damping,
    precision,
    /** @returns {number} */
    get: () => value,
    /**
     * @param {number} next
     * @param {{hard?: boolean}} [o] hard: jump without animating.
     */
    set(next, { hard = false } = {}) {
      target = next;
      if (hard || reduced()) {
        cancelAnimationFrame(frame);
        frame = 0;
        value = last = target;
        emit();
        return;
      }
      if (!frame) {
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
      }
    },
    /**
     * @param {(v: number) => void} fn Called now and on every change.
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };

  /** @param {number} now */
  function tick(now) {
    const dt = ((now - lastTime) * 60) / 1000; // 1 = one frame at 60fps
    lastTime = now;
    const delta = target - value;
    const velocity = (value - last) / (dt || 1 / 60);
    const accel = s.stiffness * delta - s.damping * velocity;
    const d = (velocity + accel) * dt;
    last = value;
    if (Math.abs(d) < s.precision && Math.abs(delta) < s.precision) {
      value = last = target;
      frame = 0;
    } else {
      value += d;
      frame = requestAnimationFrame(tick);
    }
    emit();
  }

  return s;
}
