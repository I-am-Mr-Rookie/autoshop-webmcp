// AutoShop Home motion layer. Self-hosted, no dependencies, Home only.
// Contract: the HTML is complete and static without this file. Motion is added only here,
// only with transform/opacity, and never under prefers-reduced-motion: reduce.
// Myfront: mo.enter.stagger-rise (slowed: rated "a little fast"), mo.enter.char-stagger (per word),
// mo.ease.standard-120 (ease-out family). mo.pointer.etch-trail deliberately not used ("needs improvement").

const EASE = 'cubic-bezier(.22, 1, .36, 1)';
const RISE_MS = 820; // specimen 650 ms
const RISE_STEP = 90; // specimen 70 ms child delay
const WORD_MS = 620;
const WORD_STEP = 70;
const PACKET_MS = 9000;

export const riseFrames = (y = 16) => [
  { opacity: 0, transform: 'translateY(' + y + 'px)' },
  { opacity: 1, transform: 'none' }
];

export const ambientFrames = dir => [
  { transform: 'translate3d(0, 0, 0) scale(1)' },
  { transform: 'translate3d(' + 6 * dir + 'rem, ' + 2.5 * dir + 'rem, 0) scale(1.08)' }
];

// Stops are {x, y, human, jump} in figure coordinates. The packet dwells at each stop,
// travels between neighbours, and fades out/in when it jumps to the lifecycle list.
export function packetFrames(stops) {
  const dot = [];
  const human = [];
  const slot = 1 / stops.length;
  const at = (s, offset, opacity) => {
    const transform = 'translate(' + s.x + 'px, ' + s.y + 'px)';
    dot.push({ offset, opacity, transform });
    human.push({ offset, opacity: s.human ? 1 : 0 });
  };
  stops.forEach((s, i) => {
    const start = i * slot;
    if (i === 0 || s.jump) {
      at(s, start, 0);
      at(s, start + slot * 0.15, 1);
    } else {
      at(s, start + slot * 0.15, 1);
    }
    at(s, start + slot * 0.7, 1);
    const next = stops[i + 1];
    if (!next || next.jump) at(s, start + slot * 0.95, 0);
  });
  const last = dot.at(-1);
  dot.push({ ...last, offset: 1 });
  human.push({ ...human.at(-1), offset: 1 });
  dot[0].offset = 0;
  human[0].offset = 0;
  return { dot, human };
}

const loops = new Set();
let paused = false;
const ambientState = { visible: false };

function headline(hero) {
  const h1 = hero.querySelector('h1');
  if (!h1) return [];
  const words = [];
  h1.setAttribute('aria-label', [...h1.childNodes].map(n => n.textContent.trim()).filter(Boolean).join(' '));
  for (const node of [...h1.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const frag = document.createDocumentFragment();
    for (const part of node.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.append(part); continue; }
      const span = document.createElement('span');
      span.className = 'w';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = part;
      frag.append(span);
      words.push(span);
    }
    node.replaceWith(frag);
  }
  return words;
}

function hero() {
  const root = document.querySelector('.hero');
  if (!root) return;
  const copy = root.querySelector('.hero-copy');
  const words = headline(root);
  let delay = 0;
  for (const el of copy ? copy.children : []) {
    if (el.tagName === 'H1') {
      words.forEach((w, i) => w.animate(riseFrames(18), { duration: WORD_MS, delay: delay + i * WORD_STEP, easing: EASE, fill: 'backwards' }));
      delay += words.length * WORD_STEP;
    } else {
      el.animate(riseFrames(), { duration: RISE_MS, delay, easing: EASE, fill: 'backwards' });
      delay += RISE_STEP;
    }
  }
  const art = root.querySelector('.hero-art');
  if (art) art.animate(riseFrames(), { duration: RISE_MS, delay: 2 * RISE_STEP, easing: EASE, fill: 'backwards' });
  ambient(root);
}

function ambient(root) {
  const layer = document.createElement('div');
  layer.className = 'ambient';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<i class="a"></i><i class="h"></i>';
  root.prepend(layer);
  [...layer.children].forEach((blob, i) => {
    const a = blob.animate(ambientFrames(i ? -1 : 1), { duration: 26000 + i * 7000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
    a.pause();
    loops.add({ anim: a, gate: ambientState });
  });
  new IntersectionObserver(([e]) => { ambientState.visible = e.isIntersecting; sync(); }).observe(root);
}

const SCROLL = '.section-head, .circuit, .feature, .contracts > div, .arch-stack, .arch-flow, .part, .pick a, footer .wrap';

function scrollRise() {
  const targets = [...document.querySelectorAll(SCROLL)];
  const seen = new WeakSet();
  const io = new IntersectionObserver(entries => {
    let batch = 0;
    for (const e of entries) {
      const el = e.target;
      if (!e.isIntersecting) {
        if (!seen.has(el)) { seen.add(el); el.classList.add('pending'); }
        continue;
      }
      io.unobserve(el);
      if (!seen.has(el)) continue; // already on screen at load: leave it static
      el.classList.remove('pending');
      el.animate(riseFrames(), { duration: RISE_MS, delay: batch++ * RISE_STEP, easing: EASE, fill: 'backwards' });
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of targets) io.observe(el);
}

function packet() {
  const fig = document.querySelector('figure.arch');
  if (!fig) return;
  const el = document.createElement('i');
  el.className = 'packet';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<b></b>';
  fig.append(el);
  const state = { visible: false };
  let pair = null;
  const build = () => {
    if (pair) { pair.forEach(a => a.cancel()); pair.forEach(a => loops.forEach(l => l.anim === a && loops.delete(l))); }
    const box = fig.getBoundingClientRect();
    const stops = [];
    for (const list of fig.querySelectorAll('ol')) {
      const lb = list.getBoundingClientRect();
      [...list.children].forEach((li, i) => {
        const r = li.getBoundingClientRect();
        stops.push({ x: lb.left - box.left, y: r.top - box.top + Math.min(28, r.height / 2), human: li.classList.contains('boundary') || li.classList.contains('human'), jump: i === 0 && stops.length > 0 });
      });
    }
    const { dot, human } = packetFrames(stops);
    const opts = { duration: PACKET_MS, iterations: Infinity, easing: 'linear' };
    pair = [el.animate(dot, opts), el.firstChild.animate(human, opts)];
    pair.forEach(a => { a.pause(); loops.add({ anim: a, gate: state }); });
    sync();
  };
  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(build); };
  new IntersectionObserver(([e]) => {
    state.visible = e.isIntersecting;
    if (state.visible && !pair) schedule(); else sync();
  }).observe(fig);
  let width = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (pair && w !== width) schedule();
    width = w;
  }).observe(fig);
}

function sync() {
  const hidden = document.visibilityState === 'hidden';
  for (const { anim, gate } of loops) {
    if (!paused && !hidden && gate.visible) { if (anim.playState !== 'running') anim.play(); }
    else if (anim.playState === 'running') anim.pause();
  }
}

function stop() {
  document.querySelector('#motion-toggle').hidden = true;
  document.documentElement.classList.remove('motion');
  for (const a of document.getAnimations()) a.cancel();
  loops.clear();
  for (const el of document.querySelectorAll('.pending, .ambient, .packet')) el.classList.contains('pending') ? el.classList.remove('pending') : el.remove();
}

if (typeof document !== 'undefined' && typeof matchMedia === 'function') {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  if (!reduce.matches && 'IntersectionObserver' in window && 'animate' in Element.prototype) {
    document.documentElement.classList.add('motion');
    hero();
    scrollRise();
    packet();
    const toggle = document.querySelector('#motion-toggle');
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.textContent = paused ? 'Resume motion' : 'Pause motion';
      sync();
    });
    document.addEventListener('visibilitychange', sync);
    reduce.addEventListener('change', e => e.matches && stop(), { once: true });
  }
}
