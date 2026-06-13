// Injected into every navigation via page.addInitScript(cursorKit).
// Exposes window.__demo with the synthetic cursor, camera-zoom, and DOM helpers.
export function cursorKit() {
  let cursor;
  const ensure = () => {
    if (cursor && document.documentElement.contains(cursor)) return;
    cursor = document.createElement('div');
    cursor.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
      'transform:translate(-80px,-80px);transition:transform .6s cubic-bezier(.22,.61,.36,1);' +
      'will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))';
    cursor.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path ' +
      'd="M5 2.5l15 7.2-6.7 1.6L9.3 20z" fill="#fff" stroke="#1b1d24" ' +
      'stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
  };

  // Resolve "host >>> inner >>> deeper" piercing N shadow roots; or a plain selector.
  const resolveEl = (sel) => {
    const parts = sel.split('>>>').map((s) => s.trim());
    let el = document.querySelector(parts[0]);
    for (let i = 1; i < parts.length && el; i++) {
      el = (el.shadowRoot || el).querySelector(parts[i]);
    }
    return el || null;
  };
  const rectOf = (sel) => {
    const el = resolveEl(sel);
    if (!el) throw new Error('element not found: ' + sel);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  window.__demo = {
    resolveEl, rectOf,
    move(x, y, ms = 600) {
      ensure();
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
      cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
      return wait(ms + 40);
    },
    pulse(x, y) {
      const rp = document.createElement('div');
      rp.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;z-index:2147483646;pointer-events:none;` +
        'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(108,92,231,.55)';
      document.documentElement.appendChild(rp);
      rp.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }],
        { duration: 420, easing: 'ease-out' });
      return wait(280);
    },
    async moveToSel(sel, ms = 600) { const { x, y } = rectOf(sel); await this.move(x, y, ms); return { x, y }; },
    async clickSel(sel, ms = 550) {
      const { x, y } = await this.moveToSel(sel, ms);
      await this.pulse(x, y);
      const el = resolveEl(sel); el.click();
    },
    async typeInto(sel, text, cps = 38) {
      const { rect } = rectOf(sel);
      await this.move(rect.left + rect.width * 0.25, rect.top + rect.height / 2, 600);
      const el = resolveEl(sel);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const delay = Math.round(1000 / cps);
      for (let i = 1; i <= text.length; i++) {
        set.call(el, text.slice(0, i));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(delay);
      }
    },
    zoom(scale, ox, oy, ms = 800) {
      const el = document.documentElement;
      el.style.transformOrigin = `${ox}px ${oy}px`;
      el.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      el.style.transform = `scale(${scale})`;
      return wait(ms + 40);
    },
    async zoomToSel(sel, scale = 1.3, ms = 850) { const { x, y } = rectOf(sel); await this.zoom(scale, x, y, ms); },
    // Auto-zoom (Screen Studio style): compute a scale + translation that frames an
    // element's bounding box, then animate the camera there. Scale is derived from the
    // element size (small elements get more zoom, capped at `max`); translation centers
    // the element but is clamped so the page never reveals empty edges. Pass an explicit
    // `scale` to override the auto value. Call from an un-zoomed state (like zoomToSel).
    frameTo(sel, { fill = 0.78, max = 2.2, pad = 24, ms = 850, scale } = {}) {
      const { rect } = rectOf(sel);
      const W = window.innerWidth, H = window.innerHeight;
      let s = scale || Math.min((W * fill) / (rect.width + 2 * pad), (H * fill) / (rect.height + 2 * pad));
      s = clamp(s, 1, max);
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const tx = clamp(W / 2 - s * cx, (1 - s) * W, 0);
      const ty = clamp(H / 2 - s * cy, (1 - s) * H, 0);
      const el = document.documentElement;
      el.style.transformOrigin = '0 0';
      el.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      return wait(ms + 40);
    },
    async zoomToFit(sel, opts) { return this.frameTo(sel, opts); },
    reset(ms = 700) {
      const el = document.documentElement;
      el.style.transformOrigin = '0 0';
      el.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
      el.style.transform = 'translate(0px, 0px) scale(1)';
      return wait(ms + 40);
    },
  };
}
