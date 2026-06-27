/* =========================================================================
   Essay Template — runtime
   Injects: settings gear, fullscreen icon, swap-panes icon, section indicator,
            settings menu.
   Reading model: one continuous text column that scrolls line-by-line —
                  smoothly animated but snapped to the line grid so the current
                  line keeps a constant on-screen position (mouse wheel /
                  trackpad and Up/Down/PgUp/PgDn/Space/Home/End keys).
   Sketch panel: each <section data-sketch="..."> names a sketch; the active
                 section (the one at the reading position) owns the left pane,
                 which crossfades between mounted sketches.
   Other features: theme + bg-color persistence, fullscreen, postMessage
                   reveal bus for iframe-driven narrative reveals.
   ========================================================================= */

(function () {
  'use strict';

  // ----- Icon SVGs ------------------------------------------------------

  const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path fill="currentColor" d="M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z"></path>
  </svg>`;

  const FULLSCREEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 9V4h5"></path><path d="M20 9V4h-5"></path>
    <path d="M4 15v5h5"></path><path d="M20 15v5h-5"></path>
  </svg>`;

  const EXIT_FULLSCREEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 4v5H4"></path><path d="M15 4v5h5"></path>
    <path d="M9 20v-5H4"></path><path d="M15 20v-5h5"></path>
  </svg>`;

  const SWAP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 8h15"></path><path d="M14 4l4 4-4 4"></path>
    <path d="M21 16H6"></path><path d="M10 20l-4-4 4-4"></path>
  </svg>`;

  const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-svg">
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
  </svg>`;

  const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>`;

  const AUTO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-svg">
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    <path d="M17 12.79A5 5 0 1 1 11.21 7 3.5 3.5 0 0 0 17 12.79z"></path>
  </svg>`;

  const LINES_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="icon-svg">
    <line x1="4" y1="6" x2="20" y2="6"></line>
    <line x1="4" y1="12" x2="20" y2="12"></line>
    <line x1="4" y1="18" x2="20" y2="18"></line>
  </svg>`;

  const BG_COLORS = [
    { id: 'colorWhite', value: '#FFFFFF', label: 'White' },
    { id: 'colorOffwhite', value: '#F8F8F8', label: 'Off-white' },
    { id: 'colorSepia', value: '#FDF6E3', label: 'Solarised' },
    { id: 'colorCream', value: '#FFF1E5', label: 'Financial Times' },
  ];

  // ----- Builders -------------------------------------------------------

  function buildIconBtn(id, ariaLabel, svg, title) {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'chrome-icon-btn';
    b.setAttribute('aria-label', ariaLabel);
    if (title) b.title = title;
    b.innerHTML = svg;
    return b;
  }

  function buildIndicator(total) {
    const el = document.createElement('div');
    el.className = 'slide-indicator';
    el.innerHTML = `<span id="slideNumber">1</span> / <span id="totalSlides">${total}</span>`;
    return el;
  }

  function buildSettingsMenu() {
    const menu = document.createElement('div');
    menu.id = 'settingsMenu';

    const themeButtons = [
      { id: 'themeLight', title: 'Light Mode', label: 'Light', value: 'light', svg: SUN_SVG },
      { id: 'themeDark', title: 'Dark Mode', label: 'Dark', value: 'dark', svg: MOON_SVG },
      { id: 'themeAuto', title: 'Auto Mode', label: 'Auto', value: 'auto', svg: AUTO_SVG },
    ];

    themeButtons.forEach(t => {
      const b = document.createElement('button');
      b.className = 'theme-btn';
      b.id = t.id;
      b.title = t.title;
      b.dataset.theme = t.value;
      b.innerHTML = `<span class="theme-btn-label">${t.label}</span>${t.svg}`;
      menu.appendChild(b);
    });

    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    menu.appendChild(sep);

    BG_COLORS.forEach(c => {
      const b = document.createElement('button');
      b.className = 'color-btn';
      b.id = c.id;
      b.title = `${c.label} Background`;
      b.dataset.bgcolor = c.value;
      b.innerHTML = `<span class="color-btn-label">Light mode background color: ${c.label}</span>
        <div class="color-swatch" style="background-color: ${c.value};"></div>`;
      menu.appendChild(b);
    });

    const sep2 = document.createElement('div');
    sep2.className = 'menu-separator';
    menu.appendChild(sep2);

    const snapBtn = document.createElement('button');
    snapBtn.className = 'scroll-btn';
    snapBtn.id = 'lineSnapToggle';
    snapBtn.title = 'Line-by-line scrolling';
    snapBtn.innerHTML = `<span class="scroll-btn-label">Line-by-line scrolling</span>${LINES_SVG}`;
    menu.appendChild(snapBtn);

    return menu;
  }

  // ----- Init -----------------------------------------------------------

  function init() {
    const textPane = document.getElementById('textPane');
    const sketchPane = document.getElementById('sketchPane');
    if (!textPane || !sketchPane) return;

    const sections = Array.from(textPane.querySelectorAll('section'));
    if (!sections.length) return;
    const totalSlides = sections.length;
    let panesSwapped = false;

    // Inject chrome
    const gear = buildIconBtn('settingsGear', 'Settings', GEAR_SVG, 'Settings');
    const fullscreen = buildIconBtn('fullscreenBtn', 'Toggle fullscreen', FULLSCREEN_SVG, 'Fullscreen');
    const swap = buildIconBtn('swapPanesBtn', 'Swap panes', SWAP_SVG, 'Swap panes');
    const indicator = buildIndicator(totalSlides);
    const menu = buildSettingsMenu();
    document.body.appendChild(gear);
    document.body.appendChild(fullscreen);
    document.body.appendChild(swap);
    document.body.appendChild(indicator);
    document.body.appendChild(menu);

    const slideNumberEl = document.getElementById('slideNumber');

    // --- Sketch panel: mount one frame per section, crossfade the active one ---
    // Distinct sketch sources are mounted once and reused, so a sketch keeps its
    // state even if two sections point at the same file.
    const frameBySrc = new Map();

    // Sections whose sketch isn't built yet (empty data-sketch) share a single
    // placeholder panel so the sketch pane is never just blank.
    let placeholderFrame = null;
    function getPlaceholderFrame() {
      if (!placeholderFrame) {
        placeholderFrame = document.createElement('div');
        placeholderFrame.className = 'sketch-frame sketch-placeholder';
        const inner = document.createElement('div');
        inner.className = 'sketch-placeholder-inner';
        inner.textContent = 'Explorable interactive simulation for this section will go here';
        placeholderFrame.appendChild(inner);
        sketchPane.appendChild(placeholderFrame);
      }
      return placeholderFrame;
    }

    const sketchForSection = sections.map((sec) => {
      const src = (sec.dataset.sketch || '').trim();
      if (!src) return getPlaceholderFrame();
      if (!frameBySrc.has(src)) {
        const f = document.createElement('iframe');
        f.className = 'sketch-frame';
        f.src = src;
        f.setAttribute('title', sec.querySelector('h1, h2')?.textContent || 'Sketch');
        sketchPane.appendChild(f);
        frameBySrc.set(src, f);
      }
      return frameBySrc.get(src);
    });

    let activeFrame = null;
    function showSketch(frame) {
      if (frame === activeFrame) return;
      if (activeFrame) activeFrame.classList.remove('active');
      if (frame) frame.classList.add('active');
      activeFrame = frame;
    }

    // --- Active-section tracking -----------------------------------------
    // The "reading line" sits a third of the way down the text pane; whichever
    // section spans that point owns the sketch panel and the indicator.
    const READING_ANCHOR = 0.33;
    let activeIndex = -1;

    function updateActiveSection() {
      const paneRect = textPane.getBoundingClientRect();
      const anchorY = paneRect.top + paneRect.height * READING_ANCHOR;

      let idx = 0;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= anchorY) idx = i;
        else break;
      }
      if (idx === activeIndex) return;
      activeIndex = idx;
      showSketch(sketchForSection[idx]);
      if (slideNumberEl) slideNumberEl.textContent = idx + 1;
    }

    // --- Discrete-but-smooth line scrolling ------------------------------
    // Wheel/key input accumulates into a raw target; the animation eases the
    // scroll position toward that target snapped to the line grid, so the line
    // you are reading always settles at the same on-screen height.
    function lineStep() {
      const probe = textPane.querySelector('p') || textPane.querySelector('section');
      const lh = probe ? parseFloat(getComputedStyle(probe).lineHeight) : 32;
      return (Number.isFinite(lh) && lh > 0) ? lh : 32;
    }

    const maxScroll = () => Math.max(0, textPane.scrollHeight - textPane.clientHeight);
    const clamp = (v) => Math.max(0, Math.min(v, maxScroll()));
    const snap = (v) => {
      const step = lineStep();
      return clamp(Math.round(v / step) * step);
    };

    let rawTarget = textPane.scrollTop;
    let snapTarget = rawTarget;
    let animating = false;

    // Line-snap scrolling is opt-in (toggled in the settings menu). When off,
    // the text pane scrolls natively and we just track the active section.
    let lineSnapEnabled = localStorage.getItem('lineSnapScroll') === 'true';

    function animateTo(target) {
      snapTarget = target;
      if (animating) return;
      animating = true;
      requestAnimationFrame(tick);
    }

    function tick() {
      const cur = textPane.scrollTop;
      const diff = snapTarget - cur;
      if (Math.abs(diff) < 0.5) {
        textPane.scrollTop = snapTarget;
        animating = false;
        updateActiveSection();
        return;
      }
      textPane.scrollTop = cur + diff * 0.22;
      updateActiveSection();
      requestAnimationFrame(tick);
    }

    function scrollByPixels(px) {
      rawTarget = clamp(rawTarget + px);
      animateTo(snap(rawTarget));
    }
    // Advance a whole number of lines from the current (snapped) target, so
    // every line move lands crisply on the grid regardless of any sub-line
    // remainder left over from pixel-precise trackpad scrolling.
    function scrollByLines(n) {
      const step = lineStep();
      const baseLine = Math.round(snapTarget / step);
      const target = clamp((baseLine + n) * step);
      rawTarget = target;
      animateTo(target);
    }

    // Wheel handling. A notched mouse fires isolated events whose deltaY can be
    // far smaller than a line — so per discrete notch we move exactly one line.
    // Trackpads emit a rapid stream of small pixel deltas; those we accumulate
    // so the gesture still scrolls multiple lines smoothly.
    const WHEEL_GAP_MS = 60; // gap above which a wheel event counts as a fresh notch
    let wheelAccum = 0;
    let lastWheelAt = 0;

    textPane.addEventListener('wheel', (e) => {
      if (!lineSnapEnabled) return; // native scroll
      e.preventDefault();
      const step = lineStep();

      // Normalise to pixels (some mice/OSes report lines or pages).
      let px = e.deltaY;
      if (e.deltaMode === 1) px *= step;
      else if (e.deltaMode === 2) px *= textPane.clientHeight;
      if (!px) return;

      const now = performance.now();
      const discrete = (now - lastWheelAt) > WHEEL_GAP_MS;
      lastWheelAt = now;
      if (discrete) wheelAccum = 0; // drop stale remainder between deliberate notches

      wheelAccum += px;
      let lines = Math.trunc(wheelAccum / step);
      if (lines === 0 && discrete) {
        // Isolated notch too small to fill a line: still advance one line.
        lines = Math.sign(px);
        wheelAccum = 0;
      } else {
        wheelAccum -= lines * step;
      }
      if (lines) scrollByLines(lines);
    }, { passive: false });

    // --- Keyboard nav ----------------------------------------------------
    document.addEventListener('keydown', (e) => {
      if (!lineSnapEnabled) return; // let the browser handle scroll keys
      if (e.target.matches('input, textarea, [contenteditable]')) return;
      const page = () => Math.max(1, Math.floor(textPane.clientHeight / lineStep()) - 1);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); scrollByLines(1); break;
        case 'ArrowUp': e.preventDefault(); scrollByLines(-1); break;
        case 'PageDown': e.preventDefault(); scrollByLines(page()); break;
        case 'PageUp': e.preventDefault(); scrollByLines(-page()); break;
        case ' ': e.preventDefault(); scrollByLines(e.shiftKey ? -page() : page()); break;
        case 'Home': e.preventDefault(); rawTarget = 0; animateTo(0); break;
        case 'End': e.preventDefault(); rawTarget = maxScroll(); animateTo(snap(rawTarget)); break;
      }
    });

    // Keep targets sane when the viewport (and therefore line grid) changes.
    window.addEventListener('resize', () => {
      rawTarget = clamp(textPane.scrollTop);
      snapTarget = rawTarget;
      updateActiveSection();
    });

    // Native scrolling (line-snap disabled) still needs the sketch panel to
    // follow the reading position. Also keep the snap targets in sync so that
    // re-enabling line-snap picks up from wherever native scrolling left off.
    textPane.addEventListener('scroll', () => {
      if (!animating) {
        rawTarget = textPane.scrollTop;
        snapTarget = rawTarget;
      }
      updateActiveSection();
    }, { passive: true });

    function setLineSnap(enabled) {
      lineSnapEnabled = enabled;
      localStorage.setItem('lineSnapScroll', String(enabled));
      rawTarget = clamp(textPane.scrollTop);
      snapTarget = rawTarget;
      updateScrollButtons();
    }

    // --- Swap panes ---
    swap.addEventListener('click', () => {
      panesSwapped = !panesSwapped;
      document.body.classList.toggle('panes-swapped', panesSwapped);
    });

    // --- Fullscreen ---
    fullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.error('Fullscreen error:', err.message);
        });
      } else {
        document.exitFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', () => {
      fullscreen.innerHTML = document.fullscreenElement ? EXIT_FULLSCREEN_SVG : FULLSCREEN_SVG;
    });

    // --- Settings menu open/close ---
    function openMenu() {
      if (menu.classList.contains('show')) return;
      menu.classList.add('show');
      gear.classList.add('menu-open');
      gear.classList.add('spin');
      setTimeout(() => gear.classList.remove('spin'), 600);
    }
    function closeMenu() {
      if (!menu.classList.contains('show')) return;
      menu.classList.remove('show');
      gear.classList.remove('menu-open');
      gear.classList.add('spin-reverse');
      setTimeout(() => gear.classList.remove('spin-reverse'), 600);
    }
    function toggleMenu() {
      menu.classList.contains('show') ? closeMenu() : openMenu();
    }

    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    let hoverTimeout;
    let isHoveringMenuArea = false;
    gear.addEventListener('mouseenter', () => {
      isHoveringMenuArea = true;
      hoverTimeout = setTimeout(openMenu, 500);
    });
    gear.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimeout);
      isHoveringMenuArea = false;
      setTimeout(() => { if (!isHoveringMenuArea) closeMenu(); }, 100);
    });
    menu.addEventListener('mouseenter', () => { isHoveringMenuArea = true; });
    menu.addEventListener('mouseleave', () => {
      isHoveringMenuArea = false;
      setTimeout(() => { if (!isHoveringMenuArea) closeMenu(); }, 100);
    });
    document.addEventListener('click', (e) => {
      if (!gear.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });

    // --- Theme + background color ---
    // Light-mode bg color is propagated by setting --text-bg on <body> inline.
    // The .dark-mode CSS rule overrides --text-bg with #161616, so dark mode
    // wins as long as no inline --text-bg is set (i.e. we remove it on dark).
    function applyTheme(theme) {
      const body = document.body;
      const useDark = theme === 'dark'
        || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      body.classList.toggle('dark-mode', useDark);
      localStorage.setItem('theme', theme);

      if (useDark) {
        body.style.removeProperty('--text-bg');
      } else {
        const savedBg = localStorage.getItem('bgColor') || '#FFFFFF';
        body.style.setProperty('--text-bg', savedBg);
      }
      updateThemeButtons();
    }

    function applyBgColor(color, persist = true) {
      const inDark = document.body.classList.contains('dark-mode');
      if (!inDark) {
        document.body.style.setProperty('--text-bg', color);
      }
      if (persist) localStorage.setItem('bgColor', color);
      updateColorButtons();
    }

    function updateThemeButtons() {
      const theme = localStorage.getItem('theme') || 'auto';
      menu.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === theme);
      });
    }
    function updateColorButtons() {
      const saved = localStorage.getItem('bgColor') || '#FFFFFF';
      menu.querySelectorAll('.color-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.bgcolor.toUpperCase() === saved.toUpperCase());
      });
    }

    menu.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
    menu.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => applyBgColor(btn.dataset.bgcolor));
    });

    // --- Scroll mode toggle ---
    const snapToggle = document.getElementById('lineSnapToggle');
    function updateScrollButtons() {
      if (snapToggle) snapToggle.classList.toggle('active', lineSnapEnabled);
    }
    if (snapToggle) {
      snapToggle.addEventListener('click', () => setLineSnap(!lineSnapEnabled));
    }
    updateScrollButtons();

    // --- Initial state ---
    applyTheme(localStorage.getItem('theme') || 'auto');
    applyBgColor(localStorage.getItem('bgColor') || '#FFFFFF', /*persist=*/false);

    // --- Reveal message bus (postMessage from iframes) ---
    window.addEventListener('message', (event) => {
      const type = event.data?.type;
      if (!type) return;
      const msg = document.querySelector(`.message[data-event="${type}"]:not([data-shown])`);
      if (!msg) return;
      msg.hidden = false;
      msg.dataset.shown = 'true';
      requestAnimationFrame(() => {
        const container = msg.closest('.text-pane');
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      });
    });

    // --- Boot ---
    updateActiveSection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
