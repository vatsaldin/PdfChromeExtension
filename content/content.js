/**
 * PDF Page Snapper - Content Script
 * Handles DOM inspection, smart scrolling, page snapping, interactive element picking,
 * and real-time floating progress HUD overlay.
 */

(function () {
  // Prevent duplicate injection
  if (window.__pdfSnapperInjected) {
    return;
  }
  window.__pdfSnapperInjected = true;

  let captureState = {
    isRunning: false,
    isPaused: false,
    isAborted: false,
    sessionId: null,
    currentIndex: 0,
    totalItems: 0,
    container: null,
    elements: [],
    mode: 'pages',
    cropMode: 'page',
    renderDelay: 900,
    scrollStepPercent: 90
  };

  let hudElement = null;
  let pickerActive = false;

  // -------------------------------------------------------------
  // 1. DOM INSPECTION & PDF DETECTION
  // -------------------------------------------------------------

  function isElementScrollable(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const isScrollableType = overflowY === 'auto' || overflowY === 'scroll';
    return isScrollableType && el.scrollHeight > el.clientHeight + 40;
  }

  function findScrollableAncestor(el) {
    let current = el ? el.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isElementScrollable(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getUniqueSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    
    let path = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => !c.startsWith('pdf-snapper'));
        if (classes.length > 0) {
          selector += '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  const PAGE_SELECTORS = [
    // Standard PDF.js and web document viewers
    '.page[data-page-number]',
    '.pdfViewer .page',
    '[data-page-number]',
    '.pdf-page',
    '.page',
    '.page-container',
    '.page-view',
    '.page-wrapper',
    '.rendered-page',
    '.document-page',
    '.doc-page',
    '.preview-page',
    '.sheet',
    '.slide',
    '.pdfPage',
    // Custom viewer data attributes
    '[data-page]',
    '[data-page-index]',
    '[data-page-no]',
    '[data-page-id]',
    '[data-page-num]',
    // ID prefixes (pdf2htmlEX, etc.)
    'div[id^="pageContainer"]',
    'div[id^="page-"]',
    'div[id^="page_"]',
    'div[id^="pf"]',
    // ARIA roles
    'div[role="region"][aria-label*="page" i]',
    'div[aria-label*="page " i]',
    // Google Drive
    '.ndfHFb-c4YZDc-Wrql6b',
    // Canvas wrappers & canvases
    '.canvasWrapper',
    'canvas.pdf-canvas',
    'canvas[data-page-number]'
  ];

  function isCandidatePage(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.id === 'pdf-snapper-hud' || el.closest('#pdf-snapper-hud')) return false;

    // Filter out sidebar thumbnails to avoid selecting miniature previews instead of actual pages
    if (el.closest('#sidebarContainer, #thumbnailView, .thumbnail, .thumbnailView, .pdf-sidebar, [role="navigation"]')) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    const styleW = parseFloat(el.style.width) || 0;
    const styleH = parseFloat(el.style.height) || 0;
    const w = Math.max(rect.width, el.offsetWidth, styleW);
    const h = Math.max(rect.height, el.offsetHeight, styleH);

    return w >= 150 && h >= 150;
  }

  function resolvePageElement(el) {
    if (!el) return el;

    // If el is an oversized wrapper row (e.g. 100% width container), unwrap to the true page element
    const elRect = el.getBoundingClientRect();
    if (el.children && el.children.length > 0) {
      const candidateSelectors = ['.page', '[data-page-number]', '.canvasWrapper', 'canvas', '.pdf-page', '.sheet', 'img'];
      for (const sel of candidateSelectors) {
        const inner = el.querySelector(sel);
        if (inner && inner !== el && isCandidatePage(inner)) {
          const innerRect = inner.getBoundingClientRect();
          if (innerRect.width >= 150 && innerRect.height >= 150) {
            if (innerRect.width < elRect.width * 0.92) {
              return inner;
            }
          }
        }
      }
    }

    return el;
  }

  function getVisibleClippingBounds(container) {
    const isWindowScroll = !container || container === document.documentElement || container === document.body;

    let clipTop = 0;
    let clipLeft = 0;
    let clipRight = window.innerWidth;
    let clipBottom = window.innerHeight;

    // Detect fixed / sticky header at the top of the window (toolbars, navigation bars)
    const fixedHeaders = Array.from(document.querySelectorAll('header, nav, [role="banner"], [class*="header"], [class*="navbar"], [class*="toolbar"], [id*="header"], [id*="toolbar"], [id*="navbar"]'));
    let maxHeaderBottom = 0;

    for (const h of fixedHeaders) {
      if (h.id === 'pdf-snapper-hud' || h.closest('#pdf-snapper-hud')) continue;
      const style = window.getComputedStyle(h);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const r = h.getBoundingClientRect();
        if (r.top <= 5 && r.bottom > 15 && r.bottom < window.innerHeight * 0.45 && r.width > window.innerWidth * 0.3) {
          if (r.bottom > maxHeaderBottom) {
            maxHeaderBottom = r.bottom;
          }
        }
      }
    }

    if (maxHeaderBottom > 0) {
      clipTop = Math.max(clipTop, Math.ceil(maxHeaderBottom));
    }

    // Detect fixed footer at bottom of window
    const fixedFooters = Array.from(document.querySelectorAll('footer, [role="contentinfo"], [class*="footer"], [id*="footer"]'));
    let minFooterTop = window.innerHeight;

    for (const f of fixedFooters) {
      if (f.id === 'pdf-snapper-hud' || f.closest('#pdf-snapper-hud')) continue;
      const style = window.getComputedStyle(f);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const r = f.getBoundingClientRect();
        if (r.bottom >= window.innerHeight - 5 && r.top < window.innerHeight - 15 && r.top > window.innerHeight * 0.6) {
          if (r.top < minFooterTop) {
            minFooterTop = r.top;
          }
        }
      }
    }

    if (minFooterTop < window.innerHeight) {
      clipBottom = Math.min(clipBottom, Math.floor(minFooterTop));
    }

    // If container is a specific scrollable element, clip to container client area
    if (!isWindowScroll && container) {
      const cRect = container.getBoundingClientRect();
      clipTop = Math.max(clipTop, cRect.top + (container.clientTop || 0));
      clipLeft = Math.max(clipLeft, cRect.left + (container.clientLeft || 0));
      clipRight = Math.min(clipRight, cRect.left + (container.clientLeft || 0) + container.clientWidth);
      clipBottom = Math.min(clipBottom, cRect.top + (container.clientTop || 0) + container.clientHeight);
    }

    return {
      clipTop,
      clipLeft,
      clipRight,
      clipBottom,
      availWidth: Math.max(50, clipRight - clipLeft),
      availHeight: Math.max(50, clipBottom - clipTop)
    };
  }

  function findRepeatingPageSiblings(container) {
    if (!container || !container.children) return [];
    const children = Array.from(container.children).filter(c => isCandidatePage(c));
    if (children.length >= 1) {
      return children;
    }
    return [];
  }

  function detectPdfStructure(customSelector) {
    if (customSelector) {
      const customEl = document.querySelector(customSelector);
      if (customEl) {
        // If customEl is itself a page element, inspect parent container
        if (isCandidatePage(customEl) && customEl.parentElement) {
          const parent = customEl.parentElement;
          let siblingPages = [];
          for (const sel of PAGE_SELECTORS) {
            const matches = Array.from(parent.querySelectorAll(sel)).filter(isCandidatePage);
            if (matches.length >= 1) {
              siblingPages = matches;
              break;
            }
          }
          if (siblingPages.length === 0) {
            siblingPages = findRepeatingPageSiblings(parent);
          }
          if (siblingPages.length > 0) {
            return {
              detected: true,
              container: findScrollableAncestor(customEl),
              containerSelector: getUniqueSelector(parent),
              pages: siblingPages,
              mode: 'pages',
              pageCount: siblingPages.length,
              desc: `Custom Target (${siblingPages.length} pages found)`
            };
          }
        }

        // Check if custom container has page elements
        let foundPages = [];
        for (const sel of PAGE_SELECTORS) {
          const list = Array.from(customEl.querySelectorAll(sel)).filter(isCandidatePage);
          if (list.length >= 1) {
            foundPages = list;
            break;
          }
        }
        if (foundPages.length === 0) {
          foundPages = findRepeatingPageSiblings(customEl);
        }

        return {
          detected: true,
          container: customEl,
          containerSelector: customSelector,
          pages: foundPages,
          mode: foundPages.length >= 1 ? 'pages' : 'continuous',
          pageCount: foundPages.length,
          desc: foundPages.length >= 1
            ? `Custom Target (${foundPages.length} pages)`
            : `Custom Target Container (${customEl.tagName.toLowerCase()})`
        };
      }
    }

    // Auto-detect pages across document
    let detectedPages = [];
    for (const sel of PAGE_SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel)).filter(isCandidatePage);
      if (matches.length >= 1) {
        detectedPages = matches;
        break;
      }
    }

    // If no distinct page elements from selectors, check for standalone large canvases
    if (detectedPages.length === 0) {
      const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => {
        if (c.closest('#sidebarContainer, #thumbnailView, .thumbnail, nav')) return false;
        return (c.width >= 250 || c.clientWidth >= 250) && (c.height >= 250 || c.clientHeight >= 250);
      });
      if (canvases.length >= 1) {
        detectedPages = canvases;
      }
    }

    let container = null;
    let mode = 'continuous';

    if (detectedPages.length >= 1) {
      container = findScrollableAncestor(detectedPages[0]);
      mode = 'pages';
    } else {
      // Find largest scrollable container on the page
      const allElements = Array.from(document.querySelectorAll('*'));
      let bestContainer = null;
      let maxArea = 0;

      for (const el of allElements) {
        if (isElementScrollable(el)) {
          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > maxArea && rect.width > 250 && rect.height > 250) {
            maxArea = area;
            bestContainer = el;
          }
        }
      }

      container = bestContainer || document.scrollingElement || document.documentElement;

      // Check if container has repeating child elements that look like pages
      if (container) {
        const siblings = findRepeatingPageSiblings(container);
        if (siblings.length >= 1) {
          detectedPages = siblings;
          mode = 'pages';
        } else {
          mode = 'continuous';
        }
      }
    }

    const containerSelector = container ? getUniqueSelector(container) : 'window';

    return {
      detected: detectedPages.length >= 1 || (container && container !== document.documentElement),
      container: container,
      containerSelector: containerSelector,
      pages: detectedPages,
      mode: mode,
      pageCount: detectedPages.length,
      desc: detectedPages.length >= 1
        ? `${detectedPages.length} PDF page${detectedPages.length === 1 ? '' : 's'} detected`
        : (container === document.documentElement ? 'Full Window Viewport' : 'Scrollable Container')
    };
  }

  // -------------------------------------------------------------
  // 2. REAL-TIME FLOATING HUD
  // -------------------------------------------------------------

  function createOrShowHUD(total, initialIndex = 0) {
    if (hudElement) {
      hudElement.remove();
    }

    const hud = document.createElement('div');
    hud.id = 'pdf-snapper-hud';
    hud.innerHTML = `
      <div class="pdf-snapper-header">
        <div class="pdf-snapper-title-wrap">
          <div class="pdf-snapper-pulse" id="pdf-snapper-pulse-dot"></div>
          <span class="pdf-snapper-title">PDF Page Snapper</span>
        </div>
        <span class="pdf-snapper-badge" id="pdf-snapper-mode-badge">${captureState.mode === 'pages' ? 'Page Snap' : 'Continuous'}</span>
      </div>

      <div class="pdf-snapper-progress-container">
        <div class="pdf-snapper-progress-label">
          <span id="pdf-snapper-status-text">Capturing...</span>
          <span class="pdf-snapper-page-counter" id="pdf-snapper-counter">0 / ${total > 0 ? total : '?'}</span>
        </div>
        <div class="pdf-snapper-progress-bar-bg">
          <div class="pdf-snapper-progress-bar-fill" id="pdf-snapper-bar-fill"></div>
        </div>
      </div>

      <div class="pdf-snapper-preview-box" id="pdf-snapper-preview-box" style="display: none;">
        <img class="pdf-snapper-thumb-img" id="pdf-snapper-thumb-img" src="" alt="Latest Page Preview" />
        <div class="pdf-snapper-preview-info">
          <div class="pdf-snapper-preview-text" id="pdf-snapper-latest-label">Captured Page 1</div>
          <div class="pdf-snapper-preview-sub" id="pdf-snapper-latest-dim">Rendering...</div>
        </div>
      </div>

      <div class="pdf-snapper-actions">
        <button class="pdf-snapper-btn pdf-snapper-btn-pause" id="pdf-snapper-pause-btn">
          <span>⏸</span> Pause
        </button>
        <button class="pdf-snapper-btn pdf-snapper-btn-finish" id="pdf-snapper-finish-btn">
          <span>⏹</span> Finish & View
        </button>
        <button class="pdf-snapper-btn pdf-snapper-btn-cancel" id="pdf-snapper-cancel-btn">
          Cancel Capture
        </button>
      </div>
    `;

    document.body.appendChild(hud);
    hudElement = hud;

    // Attach HUD button listeners
    hud.querySelector('#pdf-snapper-pause-btn').addEventListener('click', togglePause);
    hud.querySelector('#pdf-snapper-finish-btn').addEventListener('click', finishCaptureEarly);
    hud.querySelector('#pdf-snapper-cancel-btn').addEventListener('click', cancelCapture);

    updateHUD(initialIndex, total);
  }

  function updateHUD(current, total, thumbnailDataUrl, width, height) {
    if (!hudElement) return;

    const counter = hudElement.querySelector('#pdf-snapper-counter');
    const barFill = hudElement.querySelector('#pdf-snapper-bar-fill');
    const thumbBox = hudElement.querySelector('#pdf-snapper-preview-box');
    const thumbImg = hudElement.querySelector('#pdf-snapper-thumb-img');
    const latestLabel = hudElement.querySelector('#pdf-snapper-latest-label');
    const latestDim = hudElement.querySelector('#pdf-snapper-latest-dim');

    if (counter) {
      counter.textContent = `${current} / ${total > 0 ? total : '?'}`;
    }

    if (barFill && total > 0) {
      const pct = Math.min(100, Math.round((current / total) * 100));
      barFill.style.width = `${pct}%`;
    }

    if (thumbnailDataUrl && thumbBox && thumbImg) {
      thumbBox.style.display = 'flex';
      thumbImg.src = thumbnailDataUrl;
      if (latestLabel) latestLabel.textContent = `Captured Page ${current}`;
      if (latestDim && width && height) latestDim.textContent = `${width} × ${height} px`;
    }
  }

  function togglePause() {
    captureState.isPaused = !captureState.isPaused;
    if (!hudElement) return;

    const pauseBtn = hudElement.querySelector('#pdf-snapper-pause-btn');
    const pulseDot = hudElement.querySelector('#pdf-snapper-pulse-dot');
    const statusText = hudElement.querySelector('#pdf-snapper-status-text');

    if (captureState.isPaused) {
      pauseBtn.innerHTML = '<span>▶</span> Resume';
      pauseBtn.classList.add('paused');
      pulseDot.classList.add('paused');
      statusText.textContent = 'Paused by user';
    } else {
      pauseBtn.innerHTML = '<span>⏸</span> Pause';
      pauseBtn.classList.remove('paused');
      pulseDot.classList.remove('paused');
      statusText.textContent = 'Capturing...';
    }
  }

  function finishCaptureEarly() {
    captureState.isAborted = true;
    captureState.isRunning = false;
    wrapUpCapture(true);
  }

  function cancelCapture() {
    captureState.isAborted = true;
    captureState.isRunning = false;

    if (captureState.sessionId) {
      chrome.runtime.sendMessage({
        action: 'CANCEL_SESSION',
        sessionId: captureState.sessionId
      });
    }

    removeHUD();
    cleanUpStyles();
  }

  function removeHUD() {
    if (hudElement) {
      hudElement.remove();
      hudElement = null;
    }
  }

  function cleanUpStyles() {
    document.querySelectorAll('.pdf-snapper-hide-scrollbar').forEach(el => {
      el.classList.remove('pdf-snapper-hide-scrollbar');
    });
  }

  async function hideHUDForCapture() {
    if (!hudElement) return;
    hudElement.classList.add('hidden-for-capture');
    hudElement.style.setProperty('display', 'none', 'important');
    hudElement.style.setProperty('visibility', 'hidden', 'important');
    hudElement.style.setProperty('opacity', '0', 'important');
    hudElement.style.setProperty('transition', 'none', 'important');

    // Force layout / reflow
    void hudElement.offsetHeight;

    // Ensure double requestAnimationFrame + safety buffer so the compositor commits a clean frame
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, 60);
        });
      });
    });
  }

  function restoreHUDAfterCapture() {
    if (!hudElement) return;
    hudElement.style.removeProperty('display');
    hudElement.style.removeProperty('visibility');
    hudElement.style.removeProperty('opacity');
    hudElement.style.removeProperty('transition');
    hudElement.classList.remove('hidden-for-capture');
  }

  // -------------------------------------------------------------
  // 3. CAPTURE EXECUTION ENGINE
  // -------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitWhilePaused() {
    while (captureState.isPaused && !captureState.isAborted) {
      await sleep(200);
    }
  }

  // Wait for canvas / lazy loaded images inside target element to finish rendering
  async function waitForPageContentReady(targetEl, maxWaitMs = 1400) {
    const startTime = Date.now();

    // Check if there are canvases or images still in loading state
    const images = Array.from(targetEl.querySelectorAll('img'));
    for (const img of images) {
      if (!img.complete && Date.now() - startTime < maxWaitMs) {
        await new Promise(r => {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', r, { once: true });
          setTimeout(r, Math.max(100, maxWaitMs - (Date.now() - startTime)));
        });
      }
    }

    // Wait for PDF.js page loading status (data-loaded="true" / class "loading")
    while (Date.now() - startTime < maxWaitMs) {
      const isPdfLoading = targetEl.classList.contains('loading') ||
        (targetEl.hasAttribute('data-loaded') && targetEl.getAttribute('data-loaded') === 'false');
      if (!isPdfLoading) break;
      await sleep(50);
    }

    // Give browser a short tick for layout, canvas render, and compositor paint
    await sleep(Math.min(200, maxWaitMs));
  }

  async function startCapture(options = {}) {
    if (captureState.isRunning) {
      console.warn('PDF Snapper is already running');
      return;
    }

    // Detect target structure
    const detected = detectPdfStructure(options.customSelector);
    let container = detected.container || document.documentElement;
    let mode = options.mode || detected.mode || 'pages';
    let elements = detected.pages || [];

    if (mode === 'pages' && elements.length === 0) {
      mode = 'continuous';
    }

    captureState.isRunning = true;
    captureState.isPaused = false;
    captureState.isAborted = false;
    captureState.container = container;
    captureState.elements = elements;
    captureState.mode = mode;
    captureState.cropMode = options.cropMode || 'page'; // 'page' | 'container' | 'full'
    captureState.renderDelay = options.renderDelay || 900;
    captureState.scrollStepPercent = options.scrollStepPercent || 90;
    captureState.currentIndex = 0;
    captureState.totalItems = mode === 'pages' ? elements.length : 0;

    // Apply scrollbar hiding for clean screenshots
    if (options.hideScrollbars !== false) {
      if (container && container !== document.documentElement) {
        container.classList.add('pdf-snapper-hide-scrollbar');
      }
      document.documentElement.classList.add('pdf-snapper-hide-scrollbar');
      document.body.classList.add('pdf-snapper-hide-scrollbar');
    }

    // Request new session from background
    const sessionRes = await chrome.runtime.sendMessage({
      action: 'START_SESSION',
      title: document.title || 'PDF Document',
      url: window.location.href,
      settings: {
        mode,
        cropMode: captureState.cropMode,
        renderDelay: captureState.renderDelay
      }
    });

    if (!sessionRes || !sessionRes.sessionId) {
      console.error('Failed to initialize capture session in background');
      captureState.isRunning = false;
      cleanUpStyles();
      return;
    }

    captureState.sessionId = sessionRes.sessionId;

    // Launch HUD
    createOrShowHUD(captureState.totalItems, 0);

    try {
      if (mode === 'pages') {
        await capturePageByPageLoop();
      } else {
        await captureContinuousLoop();
      }
    } catch (err) {
      console.error('Error during capture loop:', err);
    } finally {
      if (!captureState.isAborted) {
        await wrapUpCapture(false);
      }
    }
  }

  async function captureSinglePageElement(pageEl, pageIndex, totalPages) {
    const { container, renderDelay, cropMode } = captureState;
    const isWindowScroll = !container || container === document.documentElement || container === document.body;

    // Resolve true visual page element (unwrap row wrapper if needed)
    const targetEl = (cropMode === 'page') ? resolvePageElement(pageEl) : pageEl;

    // Scroll element cleanly into view
    if (isWindowScroll) {
      const rect = targetEl.getBoundingClientRect();
      window.scrollTo({ top: window.pageYOffset + rect.top, behavior: 'instant' });
    } else {
      targetEl.scrollIntoView({ block: 'start', behavior: 'instant' });
    }

    // Wait for canvas / images / PDF.js to finish rendering
    await sleep(renderDelay);
    await waitForPageContentReady(targetEl);

    // Get current unobstructed visible clipping bounds and page element dimensions
    const bounds = getVisibleClippingBounds(container);
    let pageRect = targetEl.getBoundingClientRect();

    const pageWidth = Math.max(50, Math.round(pageRect.width));
    const pageHeight = Math.max(50, Math.round(pageRect.height));

    // Case: Crop to PDF Container
    if (cropMode === 'container' && container && !isWindowScroll) {
      const cRect = container.getBoundingClientRect();
      await hideHUDForCapture();
      try {
        return await chrome.runtime.sendMessage({
          action: 'CAPTURE_PAGE',
          sessionId: captureState.sessionId,
          pageIndex: pageIndex,
          totalPages: totalPages,
          cropRect: {
            x: Math.max(0, cRect.left),
            y: Math.max(0, cRect.top),
            width: cRect.width,
            height: cRect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          },
          dpr: window.devicePixelRatio || 1
        });
      } finally {
        restoreHUDAfterCapture();
      }
    }

    // Case: Capture Full Viewport
    if (cropMode === 'full') {
      await hideHUDForCapture();
      try {
        return await chrome.runtime.sendMessage({
          action: 'CAPTURE_PAGE',
          sessionId: captureState.sessionId,
          pageIndex: pageIndex,
          totalPages: totalPages,
          cropRect: null,
          dpr: window.devicePixelRatio || 1
        });
      } finally {
        restoreHUDAfterCapture();
      }
    }

    // -------------------------------------------------------------
    // Page Crop Mode: Snap cleanly to the exact page boundaries
    // -------------------------------------------------------------
    const availH = bounds.availHeight;

    // Adjust horizontal scroll if page is clipped horizontally
    if (pageRect.left < bounds.clipLeft || pageRect.right > bounds.clipRight) {
      const hDelta = pageRect.left - bounds.clipLeft;
      if (isWindowScroll) {
        window.scrollBy({ left: hDelta, behavior: 'instant' });
      } else {
        container.scrollLeft += hDelta;
      }
      pageRect = targetEl.getBoundingClientRect();
    }

    // SUB-CASE 1: Page fits entirely within unobstructed visible height
    if (pageHeight <= availH + 2) {
      // Position top of page cleanly at bounds.clipTop (avoiding fixed headers)
      const vDelta = pageRect.top - bounds.clipTop;
      if (Math.abs(vDelta) > 1) {
        if (isWindowScroll) {
          window.scrollBy({ top: vDelta, behavior: 'instant' });
        } else {
          container.scrollTop += vDelta;
        }
        await sleep(50);
        pageRect = targetEl.getBoundingClientRect();
      }

      await hideHUDForCapture();
      try {
        return await chrome.runtime.sendMessage({
          action: 'CAPTURE_PAGE',
          sessionId: captureState.sessionId,
          pageIndex: pageIndex,
          totalPages: totalPages,
          cropRect: {
            x: Math.max(0, pageRect.left),
            y: Math.max(0, pageRect.top),
            width: pageRect.width,
            height: pageRect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          },
          dpr: window.devicePixelRatio || 1
        });
      } finally {
        restoreHUDAfterCapture();
      }
    }

    // SUB-CASE 2: Page is TALLER than available visible height
    // Multi-Segment Smart Stitching to capture 100% of the page without cutting
    const maxSliceH = Math.max(100, Math.floor(availH - 6));
    const totalSlices = Math.ceil(pageHeight / maxSliceH);

    let capturedY = 0;
    let lastRes = null;

    for (let sliceIdx = 0; sliceIdx < totalSlices; sliceIdx++) {
      if (captureState.isAborted) break;

      const remainingH = pageHeight - capturedY;
      const sliceH = Math.min(maxSliceH, remainingH);

      // Scroll so that the region [capturedY, capturedY + sliceH] is visible
      const currentRect = targetEl.getBoundingClientRect();
      const desiredTop = bounds.clipTop - capturedY;
      const scrollNeeded = currentRect.top - desiredTop;

      if (Math.abs(scrollNeeded) > 1) {
        if (isWindowScroll) {
          window.scrollBy({ top: scrollNeeded, behavior: 'instant' });
        } else {
          container.scrollTop += scrollNeeded;
        }
        await sleep(60);
      }

      // Re-read rect after scroll
      const activeRect = targetEl.getBoundingClientRect();
      let sliceViewportY = activeRect.top + capturedY;
      let actualSliceH = sliceH;

      // Handle container boundary clamping (e.g. at container bottom)
      if (sliceViewportY + actualSliceH > bounds.clipBottom) {
        actualSliceH = Math.max(10, bounds.clipBottom - sliceViewportY);
      }

      const cropRect = {
        x: Math.max(0, activeRect.left),
        y: Math.max(0, sliceViewportY),
        width: activeRect.width,
        height: actualSliceH,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };

      await hideHUDForCapture();
      try {
        lastRes = await chrome.runtime.sendMessage({
          action: 'CAPTURE_PAGE',
          sessionId: captureState.sessionId,
          pageIndex: pageIndex,
          totalPages: totalPages,
          sliceIndex: sliceIdx,
          totalSlices: totalSlices,
          destY: capturedY,
          fullWidth: pageWidth,
          fullHeight: pageHeight,
          cropRect: cropRect,
          dpr: window.devicePixelRatio || 1
        });
      } finally {
        restoreHUDAfterCapture();
      }

      capturedY += actualSliceH;
      if (capturedY >= pageHeight) {
        break;
      }
      await sleep(80);
    }

    return lastRes;
  }

  async function capturePageByPageLoop() {
    let { elements, renderDelay } = captureState;

    for (let i = 0; i < elements.length; i++) {
      if (captureState.isAborted) break;
      await waitWhilePaused();
      if (captureState.isAborted) break;

      const pageEl = elements[i];
      const captureRes = await captureSinglePageElement(pageEl, i, elements.length);

      captureState.currentIndex = i + 1;

      if (captureRes && captureRes.success) {
        updateHUD(
          captureState.currentIndex,
          elements.length,
          captureRes.thumbnailDataUrl,
          captureRes.width,
          captureRes.height
        );
      }

      // Check if scrolling revealed new lazy-loaded page elements (dynamic virtual DOM)
      if (i === elements.length - 1) {
        const recheck = detectPdfStructure();
        if (recheck.pages && recheck.pages.length > elements.length) {
          const newPages = recheck.pages.filter(p => !elements.includes(p));
          if (newPages.length > 0) {
            elements.push(...newPages);
            captureState.elements = elements;
            captureState.totalItems = elements.length;
            updateHUD(captureState.currentIndex, elements.length);
          }
        }
      }

      // Brief pause between pages
      await sleep(150);
    }
  }

  async function captureContinuousLoop() {
    const { container, renderDelay, scrollStepPercent, cropMode } = captureState;
    const isWindowScroll = !container || container === document.documentElement || container === document.body;

    const getScrollTop = () => isWindowScroll ? window.pageYOffset : container.scrollTop;
    const setScrollTop = (val) => {
      if (isWindowScroll) {
        window.scrollTo({ top: val, behavior: 'instant' });
      } else {
        container.scrollTop = val;
      }
    };
    const getClientHeight = () => isWindowScroll ? window.innerHeight : container.clientHeight;
    const getScrollHeight = () => isWindowScroll ? document.documentElement.scrollHeight : container.scrollHeight;

    // Start at top
    setScrollTop(0);
    await sleep(250);

    const bounds = getVisibleClippingBounds(container);
    const clientHeight = Math.min(bounds.availHeight, getClientHeight());
    const scrollStep = Math.max(100, Math.floor(clientHeight * (scrollStepPercent / 100)));
    const totalEstPages = Math.max(1, Math.ceil(getScrollHeight() / scrollStep));

    createOrShowHUD(totalEstPages, 0);

    let pageIdx = 0;
    let lastScrollPos = -1;

    while (!captureState.isAborted) {
      await waitWhilePaused();
      if (captureState.isAborted) break;

      const currentScroll = getScrollTop();
      const maxScroll = getScrollHeight() - getClientHeight();

      // Check if we hit the bottom or can't scroll further
      if (currentScroll === lastScrollPos && pageIdx > 0) {
        break;
      }
      lastScrollPos = currentScroll;

      // Render wait
      await sleep(renderDelay);

      let cropRect = null;
      if (cropMode !== 'full') {
        const currentBounds = getVisibleClippingBounds(container);
        cropRect = {
          x: currentBounds.clipLeft,
          y: currentBounds.clipTop,
          width: currentBounds.availWidth,
          height: currentBounds.availHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        };
      }

      // Hide HUD completely and wait for compositor frame commit
      await hideHUDForCapture();

      let captureRes = null;
      try {
        captureRes = await chrome.runtime.sendMessage({
          action: 'CAPTURE_PAGE',
          sessionId: captureState.sessionId,
          pageIndex: pageIdx,
          totalPages: totalEstPages,
          cropRect: cropRect,
          dpr: window.devicePixelRatio || 1
        });
      } finally {
        restoreHUDAfterCapture();
      }

      pageIdx++;
      captureState.currentIndex = pageIdx;

      if (captureRes && captureRes.success) {
        updateHUD(pageIdx, totalEstPages, captureRes.thumbnailDataUrl, captureRes.width, captureRes.height);
      }

      if (currentScroll >= maxScroll - 5) {
        // Reached end of scroll container
        break;
      }

      // Advance scroll
      const nextPos = Math.min(maxScroll, currentScroll + scrollStep);
      setScrollTop(nextPos);
      await sleep(200);
    }
  }

  async function wrapUpCapture(earlyExit = false) {
    cleanUpStyles();

    if (hudElement) {
      const statusText = hudElement.querySelector('#pdf-snapper-status-text');
      if (statusText) statusText.textContent = earlyExit ? 'Finishing capture...' : 'Capture Complete!';
    }

    await sleep(600);
    removeHUD();

    if (captureState.sessionId && captureState.currentIndex > 0) {
      await chrome.runtime.sendMessage({
        action: 'FINISH_SESSION',
        sessionId: captureState.sessionId,
        totalPages: captureState.currentIndex
      });
    }

    captureState.isRunning = false;
  }

  // -------------------------------------------------------------
  // 4. INTERACTIVE TARGET CONTAINER PICKER
  // -------------------------------------------------------------

  function enableElementPicker(callback) {
    if (pickerActive) return;
    pickerActive = true;

    // Create highlight box & instructions banner
    const outline = document.createElement('div');
    outline.id = 'pdf-snapper-picker-outline';

    const tagBadge = document.createElement('div');
    tagBadge.id = 'pdf-snapper-picker-tag';
    tagBadge.textContent = 'Target Container';
    outline.appendChild(tagBadge);

    const banner = document.createElement('div');
    banner.id = 'pdf-snapper-picker-instructions';
    banner.innerHTML = `<span>🎯 Click on the PDF container to select. Press <b>ESC</b> to cancel.</span>`;

    document.body.appendChild(outline);
    document.body.appendChild(banner);

    let currentHovered = null;

    function onMouseMove(e) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === outline || outline.contains(target) || banner.contains(target)) {
        return;
      }

      currentHovered = target;
      const rect = target.getBoundingClientRect();

      outline.style.top = `${rect.top}px`;
      outline.style.left = `${rect.left}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;

      const tag = target.tagName.toLowerCase();
      const cls = target.className && typeof target.className === 'string'
        ? '.' + target.className.trim().split(/\s+/)[0]
        : '';
      const scrollInfo = target.scrollHeight > target.clientHeight ? ` (Scroll: ${target.scrollHeight}px)` : '';
      tagBadge.textContent = `<${tag}${cls}>${scrollInfo}`;
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();

      const selected = currentHovered;
      tearDownPicker();

      if (selected) {
        const selector = getUniqueSelector(selected);
        const desc = `<${selected.tagName.toLowerCase()}> (Scroll: ${selected.scrollHeight}px)`;
        if (callback) callback({ selector, desc, success: true });
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        tearDownPicker();
        if (callback) callback({ success: false, cancelled: true });
      }
    }

    function tearDownPicker() {
      pickerActive = false;
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      outline.remove();
      banner.remove();
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  // -------------------------------------------------------------
  // 5. MESSAGE LISTENER (POPUP & BACKGROUND COMMANDS)
  // -------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PING') {
      sendResponse({ alive: true, isRunning: captureState.isRunning });
      return;
    }

    if (message.action === 'DETECT_TARGET') {
      const detected = detectPdfStructure(message.customSelector);
      sendResponse({
        detected: detected.detected,
        pageCount: detected.pageCount,
        mode: detected.mode,
        containerSelector: detected.containerSelector,
        desc: detected.desc,
        url: window.location.href,
        title: document.title
      });
      return;
    }

    if (message.action === 'START_CAPTURE') {
      startCapture(message.options || {}).then(() => {
        sendResponse({ started: true });
      }).catch(err => {
        sendResponse({ started: false, error: err.message });
      });
      return true; // async
    }

    if (message.action === 'PICK_CONTAINER') {
      enableElementPicker((res) => {
        sendResponse(res);
      });
      return true; // async
    }

    if (message.action === 'STOP_CAPTURE') {
      cancelCapture();
      sendResponse({ stopped: true });
      return;
    }
  });
})();
