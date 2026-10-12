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
    cropMode: 'container',
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

  function detectPdfStructure(customSelector) {
    if (customSelector) {
      const customEl = document.querySelector(customSelector);
      if (customEl) {
        // Check if custom container has page elements
        const pageSelectors = ['.page', '[data-page-number]', '.pdf-page', '.canvasWrapper', 'canvas'];
        let foundPages = [];
        for (const sel of pageSelectors) {
          const list = Array.from(customEl.querySelectorAll(sel));
          if (list.length >= 2) {
            foundPages = list;
            break;
          }
        }
        return {
          detected: true,
          container: customEl,
          containerSelector: customSelector,
          pages: foundPages,
          mode: foundPages.length >= 2 ? 'pages' : 'continuous',
          pageCount: foundPages.length,
          desc: `Custom Target (${customEl.tagName.toLowerCase()})`
        };
      }
    }

    // Common PDF page selectors across major web viewers (PDF.js, Google Drive, DocSend, Scribd, etc.)
    const pageSelectors = [
      '.page[data-page-number]',
      '.pdfViewer .page',
      '.page',
      '[data-page-number]',
      '.pdf-page',
      '.page-container',
      '.page-view',
      '.canvasWrapper',
      'div[role="region"][aria-label*="page" i]',
      '.ndfHFb-c4YZDc-Wrql6b' // Google Drive preview page class
    ];

    let detectedPages = [];
    for (const sel of pageSelectors) {
      const matches = Array.from(document.querySelectorAll(sel)).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 100 && (rect.height > 100 || el.offsetHeight > 100);
      });
      if (matches.length >= 2) {
        detectedPages = matches;
        break;
      }
    }

    // If no distinct page elements, check for standalone large canvas elements
    if (detectedPages.length < 2) {
      const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => {
        return c.width > 300 && c.height > 300;
      });
      if (canvases.length >= 2) {
        detectedPages = canvases;
      }
    }

    let container = null;
    let mode = 'continuous';

    if (detectedPages.length >= 2) {
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
      mode = 'continuous';
    }

    const containerSelector = container ? getUniqueSelector(container) : 'window';

    return {
      detected: detectedPages.length >= 2 || (container && container !== document.documentElement),
      container: container,
      containerSelector: containerSelector,
      pages: detectedPages,
      mode: mode,
      pageCount: detectedPages.length,
      desc: detectedPages.length >= 2
        ? `${detectedPages.length} PDF pages detected`
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
  async function waitForPageContentReady(targetEl, maxWaitMs = 1200) {
    const startTime = Date.now();

    // Check if there are canvases still in loading state
    const canvases = Array.from(targetEl.querySelectorAll('canvas'));
    const images = Array.from(targetEl.querySelectorAll('img'));

    // Wait until at least all images have loaded
    for (const img of images) {
      if (!img.complete && Date.now() - startTime < maxWaitMs) {
        await new Promise(r => {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', r, { once: true });
          setTimeout(r, Math.max(100, maxWaitMs - (Date.now() - startTime)));
        });
      }
    }

    // Give browser a short tick for layout and canvas paint
    await sleep(Math.min(250, maxWaitMs));
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
    captureState.cropMode = options.cropMode || 'container'; // 'container' | 'page' | 'full'
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

  async function capturePageByPageLoop() {
    const { elements, container, renderDelay, cropMode } = captureState;
    const isWindowScroll = container === document.documentElement || container === document.body;

    for (let i = 0; i < elements.length; i++) {
      if (captureState.isAborted) break;
      await waitWhilePaused();
      if (captureState.isAborted) break;

      const pageEl = elements[i];

      // Scroll element cleanly into view
      if (isWindowScroll) {
        const rect = pageEl.getBoundingClientRect();
        const targetY = window.pageYOffset + rect.top;
        window.scrollTo({ top: targetY, behavior: 'instant' });
      } else {
        // Scroll inside container
        pageEl.scrollIntoView({ block: 'start', behavior: 'instant' });
      }

      // Wait for lazy render / canvas render
      await sleep(renderDelay);
      await waitForPageContentReady(pageEl);

      // Hide HUD during tab screenshot
      if (hudElement) hudElement.classList.add('hidden-for-capture');
      await sleep(60); // Brief paint delay for HUD hide

      // Compute bounding crop rectangle in CSS pixels relative to viewport
      let targetForCrop = (cropMode === 'page' ? pageEl : (cropMode === 'container' ? container : null));
      let cropRect = null;

      if (cropMode !== 'full' && targetForCrop) {
        const r = targetForCrop.getBoundingClientRect();
        cropRect = {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        };
      }

      // Send capture request to background
      const captureRes = await chrome.runtime.sendMessage({
        action: 'CAPTURE_PAGE',
        sessionId: captureState.sessionId,
        pageIndex: i,
        totalPages: elements.length,
        cropRect: cropRect,
        dpr: window.devicePixelRatio || 1
      });

      // Restore HUD
      if (hudElement) hudElement.classList.remove('hidden-for-capture');

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

      // Grace period before next page
      await sleep(150);
    }
  }

  async function captureContinuousLoop() {
    const { container, renderDelay, scrollStepPercent, cropMode } = captureState;
    const isWindowScroll = container === document.documentElement || container === document.body;

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

    const clientHeight = getClientHeight();
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

      // Hide HUD during capture
      if (hudElement) hudElement.classList.add('hidden-for-capture');
      await sleep(60);

      let cropRect = null;
      if (cropMode === 'container' && container && !isWindowScroll) {
        const r = container.getBoundingClientRect();
        cropRect = {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        };
      }

      const captureRes = await chrome.runtime.sendMessage({
        action: 'CAPTURE_PAGE',
        sessionId: captureState.sessionId,
        pageIndex: pageIdx,
        totalPages: totalEstPages,
        cropRect: cropRect,
        dpr: window.devicePixelRatio || 1
      });

      if (hudElement) hudElement.classList.remove('hidden-for-capture');

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
