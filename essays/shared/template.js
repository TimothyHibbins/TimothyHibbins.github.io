/* =========================================================================
   Paginated Essay Template — runtime
   Injects: settings gear, fullscreen icon, swap-panes icon, slide indicator,
            settings menu.
   Slide navigation: mouse wheel / trackpad (respecting text-pane scroll
                     boundaries) and Left/Right arrow keys.
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

  const BG_COLORS = [
    { id: 'colorWhite',    value: '#FFFFFF', label: 'White' },
    { id: 'colorOffwhite', value: '#F8F8F8', label: 'Off-white' },
    { id: 'colorSepia',    value: '#FDF6E3', label: 'Solarised' },
    { id: 'colorCream',    value: '#FFF1E5', label: 'Financial Times' },
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
      { id: 'themeDark',  title: 'Dark Mode',  label: 'Dark',  value: 'dark',  svg: MOON_SVG },
      { id: 'themeAuto',  title: 'Auto Mode',  label: 'Auto',  value: 'auto',  svg: AUTO_SVG },
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

    return menu;
  }

  // ----- Init -----------------------------------------------------------

  function init() {
    const slides = document.querySelectorAll('.slide');
    if (!slides.length) return;
    const totalSlides = slides.length;
    let currentSlide = 0;
    let panesSwapped = false;

    // Inject chrome
    const gear       = buildIconBtn('settingsGear',  'Settings',     GEAR_SVG, 'Settings');
    const fullscreen = buildIconBtn('fullscreenBtn', 'Toggle fullscreen', FULLSCREEN_SVG, 'Fullscreen');
    const swap       = buildIconBtn('swapPanesBtn',  'Swap panes',   SWAP_SVG, 'Swap panes');
    const indicator  = buildIndicator(totalSlides);
    const menu       = buildSettingsMenu();
    document.body.appendChild(gear);
    document.body.appendChild(fullscreen);
    document.body.appendChild(swap);
    document.body.appendChild(indicator);
    document.body.appendChild(menu);

    const slideNumberEl = document.getElementById('slideNumber');

    // --- Slide nav ---
    function showSlide(n, scrollToBottom = false) {
      slides.forEach((s, i) => {
        s.classList.remove('above', 'active', 'below');
        if (i < n) s.classList.add('above');
        else if (i > n) s.classList.add('below');
        else s.classList.add('active');
      });
      slideNumberEl.textContent = n + 1;

      // Reset (or jump to bottom of) the new slide's text pane.
      const textPane = slides[n].querySelector('.slide-right');
      if (textPane) {
        textPane.scrollTop = scrollToBottom ? textPane.scrollHeight : 0;
      }
    }

    function changeSlide(direction) {
      const next = Math.max(0, Math.min(totalSlides - 1, currentSlide + direction));
      if (next === currentSlide) return;
      currentSlide = next;
      // Going backwards lands you at the bottom of the prior slide so you
      // can keep reading without an awkward jump.
      showSlide(currentSlide, /*scrollToBottom=*/direction < 0);
    }

    // --- Wheel-driven slide nav ---
    // Scroll within the text pane until it hits the boundary, then one
    // more wheel "click" advances the slide. Throttled so a single
    // touchpad flick doesn't skip multiple slides.
    const NAV_THROTTLE_MS = 700;
    const NAV_DELTA_THRESHOLD = 6;
    let lastNavAt = 0;

    document.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) < NAV_DELTA_THRESHOLD) return;

      const activeSlide = document.querySelector('.slide.active');
      if (!activeSlide) return;
      const textPane = activeSlide.querySelector('.slide-right');
      const insideText = textPane && textPane.contains(e.target);

      if (insideText) {
        const atTop    = textPane.scrollTop <= 0;
        const atBottom = textPane.scrollTop + textPane.clientHeight >= textPane.scrollHeight - 1;
        if (e.deltaY < 0 && !atTop)    return; // let native scroll
        if (e.deltaY > 0 && !atBottom) return;
      }

      const now = Date.now();
      if (now - lastNavAt < NAV_THROTTLE_MS) return;
      lastNavAt = now;
      changeSlide(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });

    // --- Keyboard nav (Left/Right) ---
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') changeSlide(-1);
      if (e.key === 'ArrowRight') changeSlide(1);
    });

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
        const container = msg.closest('.slide-right');
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      });
    });

    // --- Boot ---
    showSlide(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
