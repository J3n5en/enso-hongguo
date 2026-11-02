// Custom player chrome over a plain <video>; playback/MSE stays in index.html.
window.createPlayer = function createPlayer(root, video, opts) {
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  const icon = {
    play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
    pause: '<path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/>',
    next: '<path d="M6 6.2v11.6a.8.8 0 0 0 1.25.66L15.5 12.7v5.1h2.3V6.2h-2.3v5.1L7.25 5.54A.8.8 0 0 0 6 6.2z"/>',
    vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 8.2a5 5 0 0 1 0 7.6l-1.3-1.4a3.1 3.1 0 0 0 0-4.8zM17.8 5.6a8.5 8.5 0 0 1 0 12.8l-1.3-1.4a6.6 6.6 0 0 0 0-10z"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15 9.4l1.3-1.3 2.2 2.2 2.2-2.2 1.3 1.3-2.2 2.2 2.2 2.2-1.3 1.3-2.2-2.2-2.2 2.2-1.3-1.3 2.2-2.2z"/>',
    pip: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V12h-2V6H5v12h6v2H4.5A1.5 1.5 0 0 1 3 18.5z"/><rect x="13" y="13.5" width="9" height="6.5" rx="1"/>',
    full: '<path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/>',
    exit: '<path d="M8 4h2v6H4V8h4zM14 4h2v4h4v2h-6zM4 14h6v6H8v-4H4zM14 14h6v2h-4v4h-2z"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24">${icon[name]}</svg>`;
  const clock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  root.classList.add('hp', 'paused');
  root.tabIndex = 0;
  video.controls = false;
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="hp-center"><div class="hp-big">${svg('play')}</div><div class="hp-spin"></div></div>
     <div class="hp-flash"></div>
     <div class="hp-top"><span data-r="title"></span><small data-r="sub"></small></div>
     <div class="hp-bottom">
       <div class="hp-bar" data-r="bar"><div class="hp-track"><div class="hp-buf" data-r="buf"></div><div class="hp-played" data-r="played"></div><div class="hp-thumb" data-r="thumb"></div></div><div class="hp-tip" data-r="tip"></div></div>
       <div class="hp-row">
         <button data-r="play" title="播放 (空格)">${svg('play')}</button>
         <button data-r="next" title="下一集 (N)">${svg('next')}</button>
         <span class="hp-vol"><button data-r="mute" title="静音 (M)">${svg('vol')}</button><input data-r="vol" type="range" min="0" max="1" step="0.05" /></span>
         <span class="hp-time" data-r="time">0:00 / 0:00</span>
         <span class="sp"></span>
         <span class="hp-menu" data-r="speedMenu"><button data-r="speed" title="倍速">倍速</button><div class="hp-pop" data-r="speeds"></div></span>
         <span class="hp-menu" data-r="qualityMenu"><button data-r="quality" title="清晰度"></button><div class="hp-pop" data-r="qualities"></div></span>
         <button data-r="pip" title="画中画">${svg('pip')}</button>
         <button data-r="full" title="铺满 (F)">${svg('full')}</button>
       </div>
     </div>`
  );
  const r = {};
  for (const el of root.querySelectorAll('[data-r]')) r[el.dataset.r] = el;

  // controls auto-hide while playing
  let idleTimer = 0;
  const wake = () => {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !root.querySelector('.hp-menu.open') && !r.bar.classList.contains('drag')) root.classList.add('idle');
    }, 2500);
  };
  root.addEventListener('pointermove', wake);
  root.addEventListener('pointerleave', () => !video.paused && root.classList.add('idle'));

  let flashTimer = 0;
  const flash = (text) => {
    r.flash.textContent = text;
    r.flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => r.flash.classList.remove('show'), 900);
  };
  r.flash = root.querySelector('.hp-flash');

  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  const sync = () => {
    root.classList.toggle('paused', video.paused);
    r.play.innerHTML = svg(video.paused ? 'play' : 'pause');
    r.play.title = video.paused ? '播放 (空格)' : '暂停 (空格)';
    if (video.paused) root.classList.remove('idle');
    else wake();
  };
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  r.play.onclick = toggle;

  let lastTap = 0;
  video.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 280) {
      setFull(!root.classList.contains('full'));
      toggle();
    } else toggle();
    lastTap = now;
  });

  // progress
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : opts.duration?.() || 0);
  let dragging = false;
  const paint = (t = video.currentTime) => {
    const d = duration();
    const p = d ? Math.min(1, t / d) : 0;
    r.played.style.width = `${p * 100}%`;
    r.thumb.style.left = `${p * 100}%`;
    r.time.textContent = `${clock(t)} / ${clock(d)}`;
    const b = video.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5) end = Math.max(end, b.end(i));
    r.buf.style.width = `${d ? Math.min(1, end / d) * 100 : 0}%`;
  };
  for (const e of ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'emptied'])
    video.addEventListener(e, () => !dragging && paint());
  const at = (e) => {
    const box = r.bar.querySelector('.hp-track').getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  };
  r.bar.addEventListener('pointermove', (e) => {
    const p = at(e);
    r.tip.textContent = clock(p * duration());
    r.tip.style.left = `${Math.min(Math.max(p * r.bar.clientWidth, 20), r.bar.clientWidth - 20)}px`;
    if (dragging) paint(p * duration());
  });
  r.bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    r.bar.classList.add('drag');
    r.bar.setPointerCapture(e.pointerId);
    paint(at(e) * duration());
  });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    r.bar.classList.remove('drag');
    const d = duration();
    if (d) video.currentTime = Math.min(at(e) * d, d - 0.1);
    wake();
  };
  r.bar.addEventListener('pointerup', release);
  r.bar.addEventListener('pointercancel', release);

  // loading
  const loading = (on) => root.classList.toggle('loading', on);
  video.addEventListener('waiting', () => loading(true));
  video.addEventListener('seeking', () => loading(true));
  for (const e of ['playing', 'canplay', 'seeked', 'pause', 'error']) video.addEventListener(e, () => loading(false));

  // volume
  const vol = JSON.parse(localStorage.getItem('hp-volume') || '{"v":1,"m":false}');
  video.volume = vol.v;
  video.muted = vol.m;
  const syncVol = () => {
    r.vol.value = video.muted ? 0 : video.volume;
    r.mute.innerHTML = svg(video.muted || video.volume === 0 ? 'mute' : 'vol');
    localStorage.setItem('hp-volume', JSON.stringify({ v: video.volume, m: video.muted }));
  };
  video.addEventListener('volumechange', syncVol);
  r.mute.onclick = () => (video.muted = !video.muted);
  r.vol.oninput = () => {
    video.volume = Number(r.vol.value);
    video.muted = video.volume === 0;
  };
  syncVol();

  // menus
  const closeMenus = () => root.querySelectorAll('.hp-menu.open').forEach((m) => m.classList.remove('open'));
  const menu = (wrap, btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = !wrap.classList.contains('open');
      closeMenus();
      wrap.classList.toggle('open', open);
    };
  };
  document.addEventListener('click', closeMenus);
  menu(r.speedMenu, r.speed);
  menu(r.qualityMenu, r.quality);
  const fill = (pop, items, active, pick) => {
    pop.replaceChildren(
      ...items.map(([value, label]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.classList.toggle('on', value === active);
        b.onclick = (e) => {
          e.stopPropagation();
          closeMenus();
          pick(value);
        };
        return b;
      })
    );
  };
  let speed = Number(localStorage.getItem('hp-speed')) || 1;
  const setSpeed = (s, say = true) => {
    speed = s;
    video.playbackRate = s;
    localStorage.setItem('hp-speed', String(s));
    r.speed.textContent = s === 1 ? '倍速' : `${s}x`;
    fill(r.speeds, [...SPEEDS].reverse().map((v) => [v, `${v}x`]), s, setSpeed);
    if (say) flash(`${s}x 倍速`);
  };
  // MSE source swaps reset playbackRate
  video.addEventListener('loadedmetadata', () => (video.playbackRate = speed));
  setSpeed(speed, false);

  const renderQuality = () => {
    const q = opts.quality();
    r.quality.textContent = q;
    fill(r.qualities, [...opts.qualities].reverse().map((v) => [v, v]), q, (v) => {
      if (v === opts.quality()) return;
      opts.setQuality(v);
      renderQuality();
      flash(`切换到 ${v}`);
    });
  };
  renderQuality();

  // pip & fill
  if (!document.pictureInPictureEnabled) r.pip.hidden = true;
  r.pip.onclick = () =>
    (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => flash('画中画不可用'));
  const setFull = (on) => {
    root.classList.toggle('full', on);
    document.body.style.overflow = on ? 'hidden' : '';
    r.full.innerHTML = svg(on ? 'exit' : 'full');
    r.full.title = on ? '退出铺满 (F / Esc)' : '铺满 (F)';
  };
  r.full.onclick = () => setFull(!root.classList.contains('full'));

  r.next.onclick = () => opts.onNext();

  // keyboard
  root.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const k = e.key.toLowerCase();
    const seek = (d) => {
      const t = Math.min(Math.max(video.currentTime + d, 0), Math.max(duration() - 0.1, 0));
      video.currentTime = t;
      flash(`${d > 0 ? '快进' : '快退'} ${Math.abs(d)} 秒`);
    };
    const act = {
      ' ': toggle,
      k: toggle,
      arrowright: () => seek(5),
      arrowleft: () => seek(-5),
      arrowup: () => { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); flash(`音量 ${Math.round(video.volume * 100)}%`); },
      arrowdown: () => { video.volume = Math.max(0, video.volume - 0.1); flash(`音量 ${Math.round(video.volume * 100)}%`); },
      m: () => (video.muted = !video.muted),
      f: () => setFull(!root.classList.contains('full')),
      escape: () => setFull(false),
      n: () => opts.onNext(),
      '>': () => setSpeed(SPEEDS[Math.min(SPEEDS.indexOf(speed) + 1, SPEEDS.length - 1)]),
      '<': () => setSpeed(SPEEDS[Math.max(SPEEDS.indexOf(speed) - 1, 0)]),
    }[k];
    if (!act) return;
    e.preventDefault();
    act();
    wake();
  });
  video.addEventListener('play', () => root.focus({ preventScroll: true }), { once: true });

  return {
    setTitle(title, sub = '') {
      r.title.textContent = title;
      r.sub.textContent = sub;
    },
    setHasNext(on) {
      r.next.disabled = !on;
    },
    loading,
    flash,
    renderQuality,
    exitFull: () => setFull(false),
  };
};
