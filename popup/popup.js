/**
 * PDF Page Snapper - Popup Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const statusTitle = document.getElementById('status-title');
  const statusDetails = document.getElementById('status-details');
  const btnStart = document.getElementById('btn-start-capture');
  const btnPick = document.getElementById('btn-pick-area');
  const btnGallery = document.getElementById('btn-open-gallery');
  const btnReader = document.getElementById('btn-open-in-reader');
  const linkReader = document.getElementById('link-reader');
  const nativePdfBanner = document.getElementById('native-pdf-banner');
  const customTargetBadge = document.getElementById('custom-target-badge');
  const customTargetText = document.getElementById('custom-target-text');
  const btnClearTarget = document.getElementById('btn-clear-target');
  const modePagesBtn = document.getElementById('mode-pages');
  const modeContinuousBtn = document.getElementById('mode-continuous');
  const selectCrop = document.getElementById('select-crop');
  const sliderDelay = document.getElementById('slider-delay');
  const valDelay = document.getElementById('val-delay');
  const toggleScrollbars = document.getElementById('toggle-scrollbars');
  const storageStats = document.getElementById('storage-stats');

  let activeTab = null;
  let detectedInfo = null;
  let customSelector = null;
  let currentMode = 'pages';

  // 1. Load active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  // Check saved custom selector from storage
  const stored = await chrome.storage.local.get(['lastCustomSelector', 'userSettings']);
  if (stored.lastCustomSelector) {
    customSelector = stored.lastCustomSelector;
    showCustomTargetBadge(customSelector);
  }

  // Restore user settings if available
  if (stored.userSettings) {
    const s = stored.userSettings;
    if (s.mode) setCaptureMode(s.mode);
    if (s.cropMode) selectCrop.value = s.cropMode;
    if (s.renderDelay) {
      sliderDelay.value = s.renderDelay;
      valDelay.textContent = `${s.renderDelay} ms`;
    }
    if (s.hideScrollbars !== undefined) toggleScrollbars.checked = s.hideScrollbars;
  }

  // Check storage stats
  updateStorageStats();

  // 2. Check tab URL type
  if (!activeTab || !activeTab.url) {
    setStatus('error', 'Cannot inspect page', 'This tab has no accessible URL.');
    return;
  }

  const url = activeTab.url.toLowerCase();
  const isRestrictedUrl = url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://');
  const isDirectPdf = url.endsWith('.pdf') || url.includes('.pdf?') || url.includes('/pdf/');

  if (isRestrictedUrl) {
    setStatus('warning', 'Browser Page', 'Extensions cannot capture internal browser pages.');
    return;
  }

  if (isDirectPdf && (url.startsWith('file://') || !url.startsWith('http'))) {
    // Show banner recommendation
    nativePdfBanner.style.display = 'flex';
  }

  // 3. Inject content script dynamically to ensure it is active
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: activeTab.id },
      files: ['content/content.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/content.js']
    });
  } catch (err) {
    console.warn('Script injection note (may already be injected or restricted tab):', err);
    if (isDirectPdf) {
      nativePdfBanner.style.display = 'flex';
      setStatus('warning', 'Native Chrome PDF Viewer', 'Chrome isolates direct PDF tabs. Click button above to open in our Extension Reader.');
      return;
    }
  }

  // 4. Send DETECT_TARGET to content script
  checkTabTarget();

  // Mode button toggle handlers
  modePagesBtn.addEventListener('click', () => setCaptureMode('pages'));
  modeContinuousBtn.addEventListener('click', () => setCaptureMode('continuous'));

  // Slider change
  sliderDelay.addEventListener('input', () => {
    valDelay.textContent = `${sliderDelay.value} ms`;
    saveSettings();
  });

  selectCrop.addEventListener('change', saveSettings);
  toggleScrollbars.addEventListener('change', saveSettings);

  // Clear custom target
  btnClearTarget.addEventListener('click', async () => {
    customSelector = null;
    await chrome.storage.local.remove('lastCustomSelector');
    customTargetBadge.style.display = 'none';
    checkTabTarget();
  });

  // Start Capture
  btnStart.addEventListener('click', async () => {
    if (!activeTab) return;

    btnStart.disabled = true;
    btnStart.innerHTML = `<span>Starting...</span>`;

    const options = {
      mode: currentMode,
      cropMode: selectCrop.value,
      renderDelay: parseInt(sliderDelay.value, 10),
      hideScrollbars: toggleScrollbars.checked,
      customSelector: customSelector,
      scrollStepPercent: 90
    };

    saveSettings();

    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        action: 'START_CAPTURE',
        options
      });
      // Close popup so user can view interactive HUD on tab
      window.close();
    } catch (err) {
      console.error('Failed to start capture:', err);
      btnStart.disabled = false;
      btnStart.innerHTML = `<span>Start Auto-Capture</span>`;
      setStatus('error', 'Capture Failed', err.message || 'Could not communicate with page.');
    }
  });

  // Pick Area
  btnPick.addEventListener('click', async () => {
    if (!activeTab) return;

    try {
      chrome.tabs.sendMessage(activeTab.id, { action: 'PICK_CONTAINER' }, (res) => {
        if (res && res.selector) {
          customSelector = res.selector;
          chrome.storage.local.set({ lastCustomSelector: customSelector });
          showCustomTargetBadge(customSelector);
          checkTabTarget();
        }
      });
      // Close popup so user can pick on the page
      window.close();
    } catch (err) {
      console.error('Failed to trigger element picker:', err);
    }
  });

  // Navigation Links
  btnGallery.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_GALLERY' });
    window.close();
  });

  btnReader.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_READER', pdfUrl: activeTab ? activeTab.url : null });
    window.close();
  });

  linkReader.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: 'OPEN_READER' });
    window.close();
  });

  // Helper functions
  function setCaptureMode(mode) {
    currentMode = mode;
    if (mode === 'pages') {
      modePagesBtn.classList.add('active');
      modeContinuousBtn.classList.remove('active');
    } else {
      modeContinuousBtn.classList.add('active');
      modePagesBtn.classList.remove('active');
    }
    saveSettings();
  }

  function setStatus(type, title, details) {
    statusDot.className = 'pulse-indicator ' + type;
    statusTitle.textContent = title;
    statusDetails.textContent = details;
  }

  function showCustomTargetBadge(sel) {
    customTargetText.textContent = `Target: ${sel}`;
    customTargetBadge.style.display = 'flex';
  }

  async function checkTabTarget() {
    try {
      const res = await chrome.tabs.sendMessage(activeTab.id, {
        action: 'DETECT_TARGET',
        customSelector: customSelector
      });

      if (res) {
        detectedInfo = res;
        if (res.detected) {
          statusDot.className = 'pulse-indicator success';
          statusTitle.textContent = 'Ready to Capture';
          statusDetails.textContent = res.desc || `Target: ${res.containerSelector}`;
          btnStart.disabled = false;

          // Auto-select recommended mode
          if (!stored.userSettings || !stored.userSettings.mode) {
            setCaptureMode(res.mode || 'pages');
          }
        } else {
          statusDot.className = 'pulse-indicator';
          statusTitle.textContent = 'Window Viewport Ready';
          statusDetails.textContent = 'Will scroll and capture entire page viewport.';
          btnStart.disabled = false;
        }
      }
    } catch (e) {
      if (!isRestrictedUrl) {
        statusDot.className = 'pulse-indicator';
        statusTitle.textContent = 'Ready (Standard Viewport)';
        statusDetails.textContent = 'Click Start to scroll and capture all pages.';
        btnStart.disabled = false;
      }
    }
  }

  function saveSettings() {
    chrome.storage.local.set({
      userSettings: {
        mode: currentMode,
        cropMode: selectCrop.value,
        renderDelay: parseInt(sliderDelay.value, 10),
        hideScrollbars: toggleScrollbars.checked
      }
    });
  }

  async function updateStorageStats() {
    try {
      const stats = await PdfDB.getStorageStats();
      const mb = (stats.approxBytes / (1024 * 1024)).toFixed(1);
      storageStats.innerHTML = `<span><b>${stats.sessionCount}</b> docs offline (${stats.totalPageCount} pages, ~${mb} MB)</span>`;
    } catch (e) {
      storageStats.textContent = 'Offline storage ready';
    }
  }
});
