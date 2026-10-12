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

// Map to hold in-progress multi-slice stitching: sessionId_pageIndex -> { canvas, ctx, targetW, targetH, scaleX, scaleY, slicesCount }
const sliceBuilders = new Map();

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
    const scaleX = (cropRect.viewportWidth && cropRect.viewportWidth > 0)
      ? (bitmap.width / cropRect.viewportWidth)
      : (dpr || 1);
    const scaleY = (cropRect.viewportHeight && cropRect.viewportHeight > 0)
      ? (bitmap.height / cropRect.viewportHeight)
      : (dpr || 1);

    sx = Math.max(0, Math.floor(cropRect.x * scaleX));
    sy = Math.max(0, Math.floor(cropRect.y * scaleY));
    sw = Math.min(bitmap.width - sx, Math.round(cropRect.width * scaleX));
    sh = Math.min(bitmap.height - sy, Math.round(cropRect.height * scaleY));

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

        // Check if this is part of a multi-slice capture for tall pages
        if (message.totalSlices && message.totalSlices > 1) {
          const resp = await fetch(dataUrl);
          const blob = await resp.blob();
          const bitmap = await createImageBitmap(blob);

          const cropRect = message.cropRect;
          const scaleX = (cropRect && cropRect.viewportWidth > 0)
            ? (bitmap.width / cropRect.viewportWidth)
            : (message.dpr || 1);
          const scaleY = (cropRect && cropRect.viewportHeight > 0)
            ? (bitmap.height / cropRect.viewportHeight)
            : (message.dpr || 1);

          const sx = Math.max(0, Math.floor((cropRect ? cropRect.x : 0) * scaleX));
          const sy = Math.max(0, Math.floor((cropRect ? cropRect.y : 0) * scaleY));
          const sw = Math.min(bitmap.width - sx, Math.round((cropRect ? cropRect.width : bitmap.width) * scaleX));
          const sh = Math.min(bitmap.height - sy, Math.round((cropRect ? cropRect.height : bitmap.height) * scaleY));

          const builderKey = `${message.sessionId}_${message.pageIndex}`;
          let builder = sliceBuilders.get(builderKey);

          if (!builder || message.sliceIndex === 0) {
            const targetW = Math.max(1, Math.round((message.fullWidth || (cropRect ? cropRect.width : sw)) * scaleX));
            const targetH = Math.max(1, Math.round((message.fullHeight || (cropRect ? cropRect.height : sh)) * scaleY));
            const canvas = new OffscreenCanvas(targetW, targetH);
            const ctx = canvas.getContext('2d');
            builder = {
              canvas,
              ctx,
              targetW,
              targetH,
              scaleX,
              scaleY,
              slicesCount: 0
            };
            sliceBuilders.set(builderKey, builder);
          }

          const dy = Math.max(0, Math.round((message.destY || 0) * builder.scaleY));
          const dw = Math.min(builder.targetW, sw);
          const dh = Math.min(builder.targetH - dy, sh);

          if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
            builder.ctx.drawImage(bitmap, sx, sy, dw, dh, 0, dy, dw, dh);
          }
          builder.slicesCount++;

          // If this is the final slice, complete and persist the composite page
          if (message.sliceIndex === message.totalSlices - 1) {
            sliceBuilders.delete(builderKey);

            const croppedBlob = await builder.canvas.convertToBlob({ type: 'image/png' });
            const thumbW = 180;
            const thumbH = Math.max(1, Math.round(builder.targetH * (thumbW / builder.targetW)));
            const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
            const tctx = thumbCanvas.getContext('2d');
            tctx.drawImage(builder.canvas, 0, 0, builder.targetW, builder.targetH, 0, 0, thumbW, thumbH);
            const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
            const thumbnailDataUrl = await blobToDataUrl(thumbBlob);

            await PdfDB.savePage({
              sessionId: message.sessionId,
              pageIndex: message.pageIndex,
              imageBlob: croppedBlob,
              thumbnailDataUrl,
              width: builder.targetW,
              height: builder.targetH,
              rotation: 0
            });

            sendResponse({
              success: true,
              pageIndex: message.pageIndex,
              thumbnailDataUrl,
              width: builder.targetW,
              height: builder.targetH
            });
            return;
          } else {
            // Intermediate slice captured
            sendResponse({
              success: true,
              pageIndex: message.pageIndex,
              sliceIndex: message.sliceIndex,
              isPartial: true
            });
            return;
          }
        }

        // Standard single-shot capture
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
          // Clean up any stale slice builders for this session
          for (const key of sliceBuilders.keys()) {
            if (key.startsWith(`${sessionId}_`)) {
              sliceBuilders.delete(key);
            }
          }
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
          for (const key of sliceBuilders.keys()) {
            if (key.startsWith(`${sessionId}_`)) {
              sliceBuilders.delete(key);
            }
          }
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
