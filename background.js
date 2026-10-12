/**
 * PDF Page Snapper - Background Service Worker
 * Manages tab screenshots, cropping, IndexedDB persistence, and session lifecycle.
 */

importScripts('viewer/db.js');

// Track active capture state per tab
const activeCaptures = new Map();

// Helper to convert Blob to Data URL in service worker
async function blobToDataUrl(blob) {
  try {
    if (typeof FileReader !== 'undefined') {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (e) {
    // Fall back to ArrayBuffer encoding
  }

  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// Process and crop captured tab image
async function processAndCrop(dataUrl, cropRect, dpr) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;

  if (cropRect && cropRect.width > 20 && cropRect.height > 20) {
    const scale = dpr || (bitmap.width / (cropRect.viewportWidth || (bitmap.width / (dpr || 1))));
    sx = Math.max(0, Math.floor(cropRect.x * scale));
    sy = Math.max(0, Math.floor(cropRect.y * scale));
    sw = Math.min(bitmap.width - sx, Math.ceil(cropRect.width * scale));
    sh = Math.min(bitmap.height - sy, Math.ceil(cropRect.height * scale));

    // Guard against out-of-bounds or invalid dimensions
    if (sw <= 0 || sh <= 0) {
      sx = 0;
      sy = 0;
      sw = bitmap.width;
      sh = bitmap.height;
    }
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });

  // Generate lightweight thumbnail for HUD and gallery previews
  const thumbW = 180;
  const thumbH = Math.max(1, Math.round(sh * (thumbW / sw)));
  const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
  const tctx = thumbCanvas.getContext('2d');
  tctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, thumbW, thumbH);
  const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  const thumbDataUrl = await blobToDataUrl(thumbBlob);

  return {
    croppedBlob,
    thumbnailDataUrl: thumbDataUrl,
    width: sw,
    height: sh
  };
}

// Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message.action;

  // Handle async messages
  (async () => {
    try {
      if (action === 'START_SESSION') {
        const session = await PdfDB.createSession({
          title: message.title || (sender.tab ? sender.tab.title : 'PDF Capture Document'),
          url: message.url || (sender.tab ? sender.tab.url : ''),
          settings: message.settings || {}
        });

        if (sender.tab) {
          activeCaptures.set(sender.tab.id, {
            sessionId: session.id,
            startTime: Date.now()
          });
        }

        sendResponse({ success: true, sessionId: session.id, session });
        return;
      }

      if (action === 'CAPTURE_PAGE') {
        const tabId = (sender.tab && sender.tab.id) || message.tabId;
        const windowId = (sender.tab && sender.tab.windowId) || null;

        if (!tabId) {
          throw new Error('No target tab specified for capture');
        }

        // Capture visible tab
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });

        // Crop according to target container bounds
        const processed = await processAndCrop(dataUrl, message.cropRect, message.dpr || 1);

        // Store into IndexedDB
        const pageRecord = await PdfDB.savePage({
          sessionId: message.sessionId,
          pageIndex: message.pageIndex,
          imageBlob: processed.croppedBlob,
          thumbnailDataUrl: processed.thumbnailDataUrl,
          width: processed.width,
          height: processed.height,
          rotation: 0
        });

        sendResponse({
          success: true,
          pageIndex: message.pageIndex,
          thumbnailDataUrl: processed.thumbnailDataUrl,
          width: processed.width,
          height: processed.height
        });
        return;
      }

      if (action === 'FINISH_SESSION') {
        const { sessionId, totalPages } = message;
        if (sessionId) {
          await PdfDB.updateSession(sessionId, {
            status: 'completed',
            pageCount: totalPages
          });
        }

        if (sender.tab) {
          activeCaptures.delete(sender.tab.id);
        }

        // Open Gallery viewer in a new tab
        const galleryUrl = chrome.runtime.getURL(`viewer/gallery.html?sessionId=${encodeURIComponent(sessionId)}`);
        await chrome.tabs.create({ url: galleryUrl });

        sendResponse({ success: true, galleryUrl });
        return;
      }

      if (action === 'CANCEL_SESSION') {
        const { sessionId } = message;
        if (sessionId) {
          await PdfDB.updateSession(sessionId, { status: 'cancelled' });
        }
        if (sender.tab) {
          activeCaptures.delete(sender.tab.id);
        }
        sendResponse({ success: true });
        return;
      }

      if (action === 'OPEN_GALLERY') {
        const url = message.sessionId
          ? chrome.runtime.getURL(`viewer/gallery.html?sessionId=${encodeURIComponent(message.sessionId)}`)
          : chrome.runtime.getURL('viewer/gallery.html');
        await chrome.tabs.create({ url });
        sendResponse({ success: true });
        return;
      }

      if (action === 'OPEN_READER') {
        const targetUrl = message.pdfUrl
          ? chrome.runtime.getURL(`reader/reader.html?pdf=${encodeURIComponent(message.pdfUrl)}`)
          : chrome.runtime.getURL('reader/reader.html');
        await chrome.tabs.create({ url: targetUrl });
        sendResponse({ success: true });
        return;
      }

      if (action === 'GET_ACTIVE_CAPTURE') {
        const tabId = message.tabId;
        const active = activeCaptures.get(tabId);
        sendResponse({ active: !!active, captureInfo: active || null });
        return;
      }

      sendResponse({ error: `Unknown action: ${action}` });
    } catch (err) {
      console.error('Background worker error processing action:', action, err);
      sendResponse({ success: false, error: err.message || String(err) });
    }
  })();

  return true; // Keep channel open for async response
});

// Clean up state if tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCaptures.has(tabId)) {
    activeCaptures.delete(tabId);
  }
});
