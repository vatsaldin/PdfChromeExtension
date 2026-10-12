/**
 * PDF Snapper - Built-in Reader Controller
 * Powered by Mozilla PDF.js for 100% offline direct PDF snapping
 */

document.addEventListener('DOMContentLoaded', () => {
  // Setup PDF.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../libs/pdf.worker.min.js';
  }

  // Elements
  const fileInput = document.getElementById('file-input');
  const urlInput = document.getElementById('pdf-url-input');
  const btnLoadUrl = document.getElementById('btn-load-url');
  const btnSnapAll = document.getElementById('btn-snap-all');
  const btnViewGallery = document.getElementById('btn-view-gallery');
  const dropZone = document.getElementById('drop-zone');
  const pagesContainer = document.getElementById('pdf-pages-scroll');
  const readerTitle = document.getElementById('reader-title');

  // Progress modal
  const progressModal = document.getElementById('snap-progress-modal');
  const progressTitle = document.getElementById('snap-status-title');
  const progressDesc = document.getElementById('snap-status-desc');
  const progressBar = document.getElementById('snap-bar-fill');

  // State
  let currentPdfDoc = null;
  let currentDocTitle = 'Document';
  let renderedCanvases = [];

  // Check URL param for PDF URL
  const urlParams = new URLSearchParams(window.location.search);
  const initialPdfUrl = urlParams.get('pdf');
  if (initialPdfUrl) {
    urlInput.value = initialPdfUrl;
    loadPdfFromUrl(initialPdfUrl);
  }

  // -------------------------------------------------------------
  // EVENT LISTENERS
  // -------------------------------------------------------------

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      loadPdfFromFile(file);
    }
  });

  btnLoadUrl.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) {
      loadPdfFromUrl(url);
    }
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      if (url) loadPdfFromUrl(url);
    }
  });

  // Drag and drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropZone.classList.remove('dragover');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFromFile(file);
    }
  });

  btnViewGallery.addEventListener('click', () => {
    window.location.href = '../viewer/gallery.html';
  });

  btnSnapAll.addEventListener('click', async () => {
    if (!currentPdfDoc || renderedCanvases.length === 0) return;
    await snapAllPagesToGallery();
  });

  // -------------------------------------------------------------
  // PDF LOADING & RENDERING
  // -------------------------------------------------------------

  function loadPdfFromFile(file) {
    currentDocTitle = file.name.replace(/\.[^/.]+$/, "");
    readerTitle.textContent = currentDocTitle;
    const reader = new FileReader();
    reader.onload = function () {
      const typedArray = new Uint8Array(this.result);
      renderPdfDocument(typedArray);
    };
    reader.readAsArrayBuffer(file);
  }

  async function loadPdfFromUrl(url) {
    try {
      currentDocTitle = url.split('/').pop().split('?')[0].replace(/\.[^/.]+$/, "") || 'Remote Document';
      readerTitle.textContent = currentDocTitle;
      const resp = await fetch(url);
      const arrayBuffer = await resp.arrayBuffer();
      renderPdfDocument(new Uint8Array(arrayBuffer));
    } catch (err) {
      alert('Could not load PDF from URL: ' + err.message);
    }
  }

  async function renderPdfDocument(data) {
    try {
      dropZone.style.display = 'none';
      pagesContainer.style.display = 'flex';
      pagesContainer.innerHTML = '<div style="color: #94a3b8; padding: 20px;">Rendering PDF pages...</div>';
      btnSnapAll.disabled = true;

      const loadingTask = pdfjsLib.getDocument({ data });
      currentPdfDoc = await loadingTask.promise;

      pagesContainer.innerHTML = '';
      renderedCanvases = [];

      const totalPages = currentPdfDoc.numPages;

      // Render each page at high DPI (scale = 1.6)
      const scale = 1.6;

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await currentPdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        const pageWrap = document.createElement('div');
        pageWrap.className = 'pdf-page-container';

        const tag = document.createElement('div');
        tag.className = 'page-num-tag';
        tag.textContent = `Page ${pageNum}`;
        pageWrap.appendChild(tag);

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');

        pageWrap.appendChild(canvas);
        pagesContainer.appendChild(pageWrap);

        await page.render({
          canvasContext: ctx,
          viewport: viewport
        }).promise;

        renderedCanvases.push(canvas);
      }

      btnSnapAll.disabled = false;
      btnSnapAll.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        <span>Snap All ${totalPages} Pages</span>
      `;
    } catch (err) {
      console.error('Failed to render PDF:', err);
      pagesContainer.innerHTML = `<div style="color: #ef4444; padding: 20px;">Failed to load PDF: ${err.message}</div>`;
    }
  }

  // -------------------------------------------------------------
  // SNAPPING DIRECT TO INDEXEDDB GALLERY
  // -------------------------------------------------------------

  async function snapAllPagesToGallery() {
    showProgress('Capturing All Pages...', 'Saving to offline storage...', 0);

    try {
      const session = await PdfDB.createSession({
        title: currentDocTitle,
        url: window.location.href,
        status: 'capturing'
      });

      const total = renderedCanvases.length;

      for (let i = 0; i < total; i++) {
        const canvas = renderedCanvases[i];
        const pct = Math.round(((i + 1) / total) * 100);
        updateProgress(`Snapping Page ${i + 1} of ${total}...`, pct);

        // Convert canvas to Blob
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));

        // Lightweight thumbnail
        const thumbW = 180;
        const thumbH = Math.round(canvas.height * (thumbW / canvas.width));
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = thumbW;
        thumbCanvas.height = thumbH;
        thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbW, thumbH);
        const thumbDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.75);

        await PdfDB.savePage({
          sessionId: session.id,
          pageIndex: i,
          imageBlob: blob,
          thumbnailDataUrl: thumbDataUrl,
          width: canvas.width,
          height: canvas.height,
          rotation: 0
        });

        await new Promise(r => setTimeout(r, 10));
      }

      await PdfDB.updateSession(session.id, {
        status: 'completed',
        pageCount: total
      });

      updateProgress('Done! Redirecting to Offline Gallery...', 100);
      await new Promise(r => setTimeout(r, 400));

      window.location.href = `../viewer/gallery.html?sessionId=${encodeURIComponent(session.id)}`;
    } catch (err) {
      console.error('Error saving snapshots:', err);
      alert('Error saving snapshots: ' + err.message);
    } finally {
      hideProgress();
    }
  }

  function showProgress(title, desc, pct) {
    progressTitle.textContent = title;
    progressDesc.textContent = desc;
    progressBar.style.width = `${pct}%`;
    progressModal.style.display = 'flex';
  }

  function updateProgress(desc, pct) {
    progressDesc.textContent = desc;
    progressBar.style.width = `${pct}%`;
  }

  function hideProgress() {
    progressModal.style.display = 'none';
  }
});
