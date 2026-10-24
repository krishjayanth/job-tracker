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
    if (e.target.matches('.stats')) countUp(e.target);
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

// Numbers count up from zero the first time they're seen.
function countUp(root) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    if (reduceMotion) return;
    const start = performance.now();
    const duration = 1400;
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = Math.round(target * eased) + suffix;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

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
