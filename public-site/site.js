const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Show the nav's bottom edge only once content is scrolling underneath it.
const nav = document.querySelector('.nav');
const updateNav = () => nav.classList.toggle('scrolled', scrollY > 4);
addEventListener('scroll', updateNav, { passive: true });
updateNav();

// Reveal sections as they scroll into view (once each).
const revealer = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    revealer.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -12% 0px', threshold: .12 });
document.querySelectorAll('[data-reveal]').forEach(el => revealer.observe(el));

// The product shot starts tipped back and flattens as the page scrolls, tied 1:1 to scroll.
const frame = document.querySelector('.frame');
if (frame && !reduceMotion) {
  let raf = 0;
  const tilt = () => {
    raf = 0;
    const p = Math.min(1, Math.max(0, scrollY / (innerHeight * .55)));
    frame.style.setProperty('--tilt', `${(1 - p) * 14}deg`);
    frame.style.setProperty('--lift', String(.94 + .06 * p));
  };
  addEventListener('scroll', () => { raf ||= requestAnimationFrame(tilt); }, { passive: true });
  tilt();
}

// Cards: a soft light follows the pointer.
document.querySelectorAll('.spot').forEach(card => {
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
});

// Live demo: each email is read, classified, and moves its application along.
const demo = document.querySelector('.demo');
if (demo) runDemo(demo);

async function runDemo(demo) {
  const mails = [...demo.querySelectorAll('.mail')];
  const json = demo.querySelector('.json');
  const START = {
    northwind: { label: 'Waiting', stage: '', due: false },
    lumen: { label: 'Applied', stage: 'applied' },
    halcyon: { label: 'Applied', stage: 'applied' },
  };

  // Only animate while the demo is on screen and the tab is visible.
  let visible = false;
  let wake = () => {};
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); }, { threshold: .25 }).observe(demo);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  const ready = () => (visible && !document.hidden) ? Promise.resolve() : new Promise(r => { wake = r; });

  const setStatus = (app, label, stage, animate) => {
    const row = demo.querySelector(`#app-${app}`);
    const pill = row.querySelector('.status');
    pill.className = `status${stage ? ` s-${stage}` : ''}`;
    pill.textContent = label;
    if (!animate) return row;
    void pill.offsetWidth; // restart the pop animation
    pill.classList.add('pop');
    row.style.setProperty('--c', `var(--${stage})`); // the row lights up in its new stage's colour
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 900);
    return row;
  };

  const reset = () => {
    for (const [app, s] of Object.entries(START)) {
      const row = setStatus(app, s.label, s.stage, false);
      const due = row.querySelector('.due');
      if (due) due.hidden = true;
    }
    mails.forEach(m => m.classList.remove('active', 'done'));
    json.innerHTML = '<span class="caret"></span>';
  };

  const highlight = text => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/"(\w+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>');

  const type = async text => {
    if (reduceMotion) { json.innerHTML = highlight(text); return; }
    for (let i = 0; i <= text.length; i += 3) {
      json.textContent = text.slice(0, i);
      json.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
      await sleep(16);
    }
    json.innerHTML = highlight(text);
  };

  reset();
  for (;;) {
    for (const mail of mails) {
      await ready();
      const { app, stage, label, role, company, due } = mail.dataset;
      mail.classList.add('active');
      demo.classList.add('thinking');
      const out = { stage, company, role, ...(due && { deadline: due }) };
      await Promise.all([type(JSON.stringify(out, null, 2)), sleep(1100)]);
      demo.classList.remove('thinking');
      mail.classList.remove('active');
      mail.classList.add('done');
      const row = setStatus(app, label, stage, true);
      if (due) row.querySelector('.due').hidden = false;
      await sleep(reduceMotion ? 2600 : 1700);
    }
    await sleep(2500);
    await ready();
    reset();
    await sleep(600);
  }
}

// "Request an invite": check as you go, send, then thank them in place of the form.
const joinForm = document.getElementById('join-form');
if (joinForm) {
  const msg = document.getElementById('join-msg');
  const say = (text, isError = false) => { msg.textContent = text; msg.classList.toggle('err', isError); };
  const email = joinForm.elements.email;
  const name = joinForm.elements.name;
  const emailOk = () => /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(email.value.trim());
  // Only flag the address once they've left the field, not while they're typing it.
  email.addEventListener('blur', () => { if (email.value) email.setAttribute('aria-invalid', String(!emailOk())); });
  email.addEventListener('input', () => { if (email.getAttribute('aria-invalid') === 'true' && emailOk()) email.removeAttribute('aria-invalid'); });

  joinForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!name.value.trim()) { say('Add your name.', true); return name.focus(); }
    if (!emailOk()) { email.setAttribute('aria-invalid', 'true'); say("That email address doesn't look right.", true); return email.focus(); }
    const button = joinForm.querySelector('button[type="submit"]');
    button.disabled = true;
    say('Sending…');
    try {
      const res = await fetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(joinForm))),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That didn't go through. Try again in a moment");
      document.getElementById('join-email').textContent = data.email;
      joinForm.hidden = true;
      const done = document.getElementById('join-done');
      done.hidden = false;
      done.focus();
    } catch (err) {
      say(`${err.message}.`.replace(/\.\.$/, '.'), true);
      button.disabled = false;
    }
  });
}

// "Updates itself": a new sync entry springs in at the top every few seconds and the rest slide
// down. A vanilla port of 21st.dev's Animated List (Magic UI), with the same critically damped feel.
const log = document.querySelector('.log');
if (log && !reduceMotion) runLog(log);

function runLog(log) {
  const events = [
    ['Lumen Labs moved to Interview', 'Interview', 'var(--interview)'],
    ['Synced · no changes', '0', 'var(--muted)'],
    ['Halcyon moved to Rejected', 'Rejected', 'var(--rejected)'],
    ['Synced · 3 new updates', '+3', 'var(--text)'],
    ['Lumen Labs moved to Offer', 'Offer', 'var(--offer)'],
    ['Northwind moved to Assessment', 'Assessment', 'var(--oa)'],
  ];
  let minutes = 9 * 60 + 41; // the newest entry already shown; inbox checks are 5 minutes apart
  let next = 0;
  let visible = false;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(log);

  setInterval(() => {
    if (!visible || document.hidden) return;
    const [text, tag, color] = events[next++ % events.length];
    minutes = (minutes + 5) % (24 * 60);
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const b = document.createElement('b');
    b.textContent = tag;
    b.style.color = color;
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;
    li.append(time, msg, b);

    // Slide each row from where it is on screen right now, so a new entry arriving mid-slide
    // never makes the list jump.
    const rows = [...log.children];
    const before = rows.map(r => r.getBoundingClientRect().top);
    rows.forEach(r => r.classList.remove('fresh'));
    li.classList.add('fresh');
    log.prepend(li);
    const spring = { duration: 550, easing: 'cubic-bezier(.16, 1, .3, 1)' };
    rows.forEach((r, i) => {
      const dy = before[i] - r.getBoundingClientRect().top;
      r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], spring);
    });
    li.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], spring);
    while (log.children.length > 4) log.lastElementChild.remove();
  }, 2600);
}

// "How it works": light runs from each hiring platform into nuj, then out to a stage in that
// stage's colour. A vanilla port of 21st.dev's Animated Beam (Magic UI): every curve gets a faint
// track, and a short gradient band slides along it.
const beams = document.querySelector('.beams');
if (beams) drawBeams(beams);

function drawBeams(fig) {
  const svg = fig.querySelector('.beam-paths');
  const hub = fig.querySelector('.beam-hub');
  const ins = [...fig.querySelectorAll('.beam-in .node')];
  const outs = [...fig.querySelectorAll('.beam-out .node')];
  const NS = 'http://www.w3.org/2000/svg';
  const make = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const CYCLE = 4.2; // seconds: platforms send, nuj sorts, stages receive, a short rest
  const TRAVEL = 1.1; // seconds a pulse takes along one curve

  const beam = (id, x1, y1, x2, y2, color, begin) => {
    const mid = (x1 + x2) / 2;
    const d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
    svg.append(make('path', { class: 'track', d }));
    if (reduceMotion) return null;

    // The band starts just before the curve and ends just past it; outside it the gradient is clear.
    const band = (x2 - x1) * .5;
    const grad = make('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x1 - band, x2: x1, y1: 0, y2: 0 });
    for (const [offset, opacity] of [[0, 0], [.75, 1], [1, 0]]) {
      grad.append(make('stop', { offset, style: `stop-color:${color};stop-opacity:${opacity}` }));
    }
    const f = (TRAVEL / CYCLE).toFixed(3);
    const slide = (attr, from, to) => grad.appendChild(make('animate', {
      attributeName: attr, values: `${from};${to};${to}`, keyTimes: `0;${f};1`,
      calcMode: 'spline', keySplines: '.45 0 .25 1;0 0 1 1',
      dur: `${CYCLE}s`, begin: `${begin}s`, repeatCount: 'indefinite',
    }));
    const anim = slide('x1', x1 - band, x2);
    slide('x2', x1, x2 + band);
    svg.querySelector('defs').append(grad);
    svg.append(make('path', { class: 'pulse', d, stroke: `url(#${id})` }));
    return anim;
  };

  let landings = [];
  const draw = () => {
    landings.forEach(clearTimeout);
    landings = [];
    svg.replaceChildren(make('defs', {}));
    const box = fig.getBoundingClientRect();
    const h = hub.getBoundingClientRect();
    const hubLeft = h.left - box.left;
    const hubRight = h.right - box.left;
    const hubY = h.top - box.top + h.height / 2;
    const fan = (i, n) => (i - (n - 1) / 2) * 7; // curves meet the hub slightly apart, not in one point

    ins.forEach((node, i) => {
      const r = node.getBoundingClientRect();
      const anim = beam(`beam-in-${i}`, r.right - box.left, r.top - box.top + r.height / 2, hubLeft, hubY + fan(i, ins.length), 'var(--text)', i * .18);
      // The hub lights up as each pulse arrives.
      const land = () => landings.push(setTimeout(() => {
        hub.classList.add('hit');
        landings.push(setTimeout(() => hub.classList.remove('hit'), 120));
      }, TRAVEL * 1000 * .9));
      anim?.addEventListener('beginEvent', land);
      anim?.addEventListener('repeatEvent', land);
    });
    outs.forEach((node, i) => {
      const r = node.getBoundingClientRect();
      beam(`beam-out-${i}`, hubRight, hubY + fan(i, outs.length), r.left - box.left, r.top - box.top + r.height / 2, getComputedStyle(node).color, 1.4 + i * .22);
    });
    svg.setCurrentTime?.(0);
  };

  new ResizeObserver(draw).observe(fig);
  document.fonts?.ready.then(draw);
  // Only run the light while the diagram is on screen.
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting) svg.unpauseAnimations?.(); else svg.pauseAnimations?.();
  }).observe(fig);
}
