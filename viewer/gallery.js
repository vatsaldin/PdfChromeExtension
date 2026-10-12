/**
 * PDF Page Snapper - Offline Document Gallery & Manager
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const sessionListEl = document.getElementById('session-list');
  const pagesGridEl = document.getElementById('pages-grid');
  const emptyStateEl = document.getElementById('empty-state');
  const docTitleInput = document.getElementById('doc-title-input');
  const titleSaveStatus = document.getElementById('title-save-status');
  const metaPageCount = document.getElementById('meta-page-count');
  const metaDate = document.getElementById('meta-date');
  const sidebarStorage = document.getElementById('sidebar-storage');
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const sidebarEl = document.getElementById('sidebar');
  const btnRefreshLib = document.getElementById('btn-refresh-library');

  // Action buttons
  const btnExportPdf = document.getElementById('btn-export-pdf');
  const btnExportZip = document.getElementById('btn-export-zip');
  const btnDeleteSession = document.getElementById('btn-delete-session');

  // Filters & Grid Zoom
  const filterAll = document.getElementById('filter-all');
  const filterIncluded = document.getElementById('filter-included');
  const filterExcluded = document.getElementById('filter-excluded');
  const countAll = document.getElementById('count-all');
  const countIncluded = document.getElementById('count-included');
  const countExcluded = document.getElementById('count-excluded');
  const gridZoom = document.getElementById('grid-zoom');

  // Lightbox
  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxBackdrop = document.getElementById('lightbox-backdrop');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxTitle = document.getElementById('lightbox-title');
  const btnLightboxClose = document.getElementById('btn-lightbox-close');
  const btnLightboxPrev = document.getElementById('btn-lightbox-prev');
  const btnLightboxNext = document.getElementById('btn-lightbox-next');
  const btnLightboxRotate = document.getElementById('btn-lightbox-rotate');
  const btnLightboxDownload = document.getElementById('btn-lightbox-download');

  // Progress Modal
  const progressModal = document.getElementById('progress-modal');
  const progressTitle = document.getElementById('progress-modal-title');
  const progressDesc = document.getElementById('progress-modal-desc');
  const progressBar = document.getElementById('progress-modal-bar');

  // State
  let currentSessionId = null;
  let currentSession = null;
  let currentPages = [];
  let currentFilter = 'all'; // 'all' | 'included' | 'excluded'
  let lightboxPageIndex = 0;
  let objectUrls = new Set();

  // 1. Initial URL param check
  const urlParams = new URLSearchParams(window.location.search);
  const paramSessionId = urlParams.get('sessionId');

  // Initialize
  await refreshLibrary(paramSessionId);

  // -------------------------------------------------------------
  // LIBRARY & SESSIONS
  // -------------------------------------------------------------

  async function refreshLibrary(targetSessionIdToSelect = null) {
    const sessions = await PdfDB.getAllSessions();
    sessionListEl.innerHTML = '';

    if (sessions.length === 0) {
      currentSessionId = null;
      currentSession = null;
      currentPages = [];
      renderPages();
      docTitleInput.value = 'No documents yet';
      docTitleInput.disabled = true;
      metaPageCount.textContent = '0 Pages';
      metaDate.textContent = 'None';
      updateStorageInfo();
      return;
    }

    docTitleInput.disabled = false;

    // Pick target session
    let targetSession = null;
    if (targetSessionIdToSelect) {
      targetSession = sessions.find(s => s.id === targetSessionIdToSelect);
    }
    if (!targetSession) {
      targetSession = sessions[0];
    }

    currentSessionId = targetSession.id;
    currentSession = targetSession;

    // Render session items
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = `session-item ${session.id === currentSessionId ? 'active' : ''}`;
      item.dataset.sessionId = session.id;

      const dateStr = new Date(session.createdAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      item.innerHTML = `
        <div class="session-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</div>
        <div class="session-meta">
          <span>${dateStr}</span>
          <span class="session-badge">${session.pageCount || 0} pages</span>
        </div>
      `;

      item.addEventListener('click', () => {
        selectSession(session.id);
      });

      sessionListEl.appendChild(item);
    });

    await loadSessionPages(currentSessionId);
    updateStorageInfo();
  }

  async function selectSession(sessionId) {
    if (sessionId === currentSessionId) return;

    currentSessionId = sessionId;
    currentSession = await PdfDB.getSession(sessionId);

    // Update active class in sidebar
    document.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.sessionId === sessionId);
    });

    // Update URL without full reload
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('sessionId', sessionId);
    window.history.replaceState({}, '', newUrl);

    await loadSessionPages(sessionId);
  }

  async function loadSessionPages(sessionId) {
    cleanupObjectUrls();
    currentPages = await PdfDB.getPagesForSession(sessionId);

    if (currentSession) {
      docTitleInput.value = currentSession.title;
      const dateFormatted = new Date(currentSession.createdAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      metaDate.textContent = dateFormatted;
    }

    renderPages();
  }

  // -------------------------------------------------------------
  // RENDERING PAGE CARDS
  // -------------------------------------------------------------

  function renderPages() {
    pagesGridEl.innerHTML = '';

    // Update counts
    const total = currentPages.length;
    const included = currentPages.filter(p => !p.excluded).length;
    const excluded = total - included;

    countAll.textContent = total;
    countIncluded.textContent = included;
    countExcluded.textContent = excluded;
    metaPageCount.textContent = `${included} / ${total} Pages Included`;

    if (total === 0) {
      emptyStateEl.style.display = 'flex';
      btnExportPdf.disabled = true;
      btnExportZip.disabled = true;
      return;
    } else {
      emptyStateEl.style.display = 'none';
      btnExportPdf.disabled = included === 0;
      btnExportZip.disabled = included === 0;
    }

    currentPages.forEach((page, index) => {
      // Filter logic
      if (currentFilter === 'included' && page.excluded) return;
      if (currentFilter === 'excluded' && !page.excluded) return;

      const card = document.createElement('div');
      card.className = `page-card ${page.excluded ? 'excluded' : ''}`;
      card.dataset.pageId = page.id;
      card.dataset.index = index;

      // Image source: prefer imageBlob via objectURL, fallback to thumbnailDataUrl
      let imgSrc = page.thumbnailDataUrl;
      if (page.imageBlob) {
        const objUrl = URL.createObjectURL(page.imageBlob);
        objectUrls.add(objUrl);
        imgSrc = objUrl;
      }

      const rot = page.rotation || 0;

      card.innerHTML = `
        <div class="page-card-header">
          <span class="page-card-number">Page ${index + 1}</span>
          <span class="page-card-dim">${page.width} × ${page.height}</span>
        </div>
        <div class="page-card-preview" title="Click to inspect page full resolution">
          <img class="page-card-img" src="${imgSrc}" style="transform: rotate(${rot}deg);" alt="Page ${index + 1}" />
          <div class="page-card-hover-overlay">
            <button class="btn-hover-zoom">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              View Full
            </button>
          </div>
        </div>
        <div class="page-card-toolbar">
          <div style="display: flex; gap: 4px;">
            <button class="btn-card-tool btn-move-left" title="Move earlier" ${index === 0 ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="btn-card-tool btn-move-right" title="Move later" ${index === currentPages.length - 1 ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
          <div style="display: flex; gap: 4px;">
            <button class="btn-card-tool btn-rotate" title="Rotate 90° Clockwise">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
              </svg>
            </button>
            <button class="btn-card-tool btn-toggle-exclude ${page.excluded ? 'active-warn' : ''}" title="${page.excluded ? 'Include in export' : 'Exclude from export'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${page.excluded
                  ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
                  : '<polyline points="20 6 9 17 4 12"/>'}
              </svg>
            </button>
            <button class="btn-card-tool danger btn-delete-page" title="Delete page">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              </svg>
            </button>
          </div>
        </div>
      `;

      // Event Listeners for Card
      card.querySelector('.page-card-preview').addEventListener('click', () => {
        openLightbox(index);
      });

      card.querySelector('.btn-rotate').addEventListener('click', async (e) => {
        e.stopPropagation();
        page.rotation = ((page.rotation || 0) + 90) % 360;
        await PdfDB.updatePage(page.id, { rotation: page.rotation });
        const img = card.querySelector('.page-card-img');
        img.style.transform = `rotate(${page.rotation}deg)`;
      });

      card.querySelector('.btn-toggle-exclude').addEventListener('click', async (e) => {
        e.stopPropagation();
        page.excluded = !page.excluded;
        await PdfDB.updatePage(page.id, { excluded: page.excluded });
        renderPages();
      });

      const moveLeft = card.querySelector('.btn-move-left');
      if (moveLeft) {
        moveLeft.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (index > 0) {
            swapPages(index, index - 1);
          }
        });
      }

      const moveRight = card.querySelector('.btn-move-right');
      if (moveRight) {
        moveRight.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (index < currentPages.length - 1) {
            swapPages(index, index + 1);
          }
        });
      }

      card.querySelector('.btn-delete-page').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete Page ${index + 1}?`)) {
          await PdfDB.deletePage(page.id);
          currentPages.splice(index, 1);
          // Re-index remaining pages
          const ids = currentPages.map(p => p.id);
          await PdfDB.reorderPages(currentSessionId, ids);
          await PdfDB.updateSession(currentSessionId, { pageCount: currentPages.length });
          renderPages();
        }
      });

      pagesGridEl.appendChild(card);
    });
  }

  async function swapPages(idx1, idx2) {
    const temp = currentPages[idx1];
    currentPages[idx1] = currentPages[idx2];
    currentPages[idx2] = temp;

    const ids = currentPages.map(p => p.id);
    await PdfDB.reorderPages(currentSessionId, ids);
    renderPages();
  }

  // -------------------------------------------------------------
  // TITLE AUTO-SAVE
  // -------------------------------------------------------------

  let titleDebounce = null;
  docTitleInput.addEventListener('input', () => {
    clearTimeout(titleDebounce);
    titleDebounce = setTimeout(async () => {
      if (!currentSessionId) return;
      const newTitle = docTitleInput.value.trim() || 'Untitled Document';
      await PdfDB.updateSession(currentSessionId, { title: newTitle });
      titleSaveStatus.classList.add('show');
      setTimeout(() => titleSaveStatus.classList.remove('show'), 1500);

      // Update sidebar title
      const sidebarItem = document.querySelector(`.session-item[data-session-id="${currentSessionId}"] .session-title`);
      if (sidebarItem) sidebarItem.textContent = newTitle;
    }, 500);
  });

  // -------------------------------------------------------------
  // LIGHTBOX MODAL
  // -------------------------------------------------------------

  function openLightbox(index) {
    if (index < 0 || index >= currentPages.length) return;
    lightboxPageIndex = index;
    const page = currentPages[index];

    lightboxTitle.textContent = `Page ${index + 1} of ${currentPages.length} (${page.width} × ${page.height} px)`;

    const objUrl = URL.createObjectURL(page.imageBlob);
    objectUrls.add(objUrl);
    lightboxImg.src = objUrl;
    lightboxImg.style.transform = `rotate(${page.rotation || 0}deg)`;

    lightboxModal.style.display = 'flex';
  }

  function closeLightbox() {
    lightboxModal.style.display = 'none';
  }

  btnLightboxClose.addEventListener('click', closeLightbox);
  lightboxBackdrop.addEventListener('click', closeLightbox);

  btnLightboxPrev.addEventListener('click', () => {
    if (lightboxPageIndex > 0) openLightbox(lightboxPageIndex - 1);
  });

  btnLightboxNext.addEventListener('click', () => {
    if (lightboxPageIndex < currentPages.length - 1) openLightbox(lightboxPageIndex + 1);
  });

  btnLightboxRotate.addEventListener('click', async () => {
    const page = currentPages[lightboxPageIndex];
    page.rotation = ((page.rotation || 0) + 90) % 360;
    await PdfDB.updatePage(page.id, { rotation: page.rotation });
    lightboxImg.style.transform = `rotate(${page.rotation}deg)`;
    renderPages();
  });

  btnLightboxDownload.addEventListener('click', async () => {
    const page = currentPages[lightboxPageIndex];
    const renderedBlob = await getRotatedBlob(page);
    downloadBlob(renderedBlob, `${cleanFileName(currentSession.title)}_Page_${lightboxPageIndex + 1}.png`);
  });

  window.addEventListener('keydown', (e) => {
    if (lightboxModal.style.display === 'flex') {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft' && lightboxPageIndex > 0) openLightbox(lightboxPageIndex - 1);
      if (e.key === 'ArrowRight' && lightboxPageIndex < currentPages.length - 1) openLightbox(lightboxPageIndex + 1);
    }
  });

  // -------------------------------------------------------------
  // EXPORT: OFFLINE PDF (jsPDF)
  // -------------------------------------------------------------

  btnExportPdf.addEventListener('click', async () => {
    const exportPages = currentPages.filter(p => !p.excluded);
    if (exportPages.length === 0) {
      alert('No included pages to export. Please include at least one page.');
      return;
    }

    showProgress('Generating High-Resolution PDF...', 'Processing pages with exact aspect ratios...', 0);

    try {
      const { jsPDF } = window.jspdf;
      let pdf = null;

      for (let i = 0; i < exportPages.length; i++) {
        const page = exportPages[i];
        const pct = Math.round(((i + 1) / exportPages.length) * 100);
        updateProgress(`Processing Page ${i + 1} of ${exportPages.length}...`, pct);

        // Get rotated base64 Data URL and dimensions
        const { dataUrl, width, height } = await getRotatedImageData(page);

        const orientation = width > height ? 'landscape' : 'portrait';

        if (i === 0) {
          // Initialize PDF with first page dimensions
          pdf = new jsPDF({
            orientation: orientation,
            unit: 'px',
            format: [width, height],
            hotfixes: ['px_scaling']
          });
        } else {
          pdf.addPage([width, height], orientation);
        }

        pdf.addImage(dataUrl, 'PNG', 0, 0, width, height, undefined, 'FAST');

        // Allow UI to update
        await new Promise(r => setTimeout(r, 20));
      }

      updateProgress('Finalizing & Saving PDF...', 100);
      const fileName = `${cleanFileName(currentSession.title)}.pdf`;
      pdf.save(fileName);
    } catch (err) {
      console.error('Failed to generate PDF:', err);
      alert('Error generating PDF: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // -------------------------------------------------------------
  // EXPORT: ZIP ARCHIVE (JSZip)
  // -------------------------------------------------------------

  btnExportZip.addEventListener('click', async () => {
    const exportPages = currentPages.filter(p => !p.excluded);
    if (exportPages.length === 0) {
      alert('No included pages to export.');
      return;
    }

    showProgress('Creating ZIP Archive...', 'Packaging high-resolution page screenshots...', 0);

    try {
      const zip = new JSZip();
      const folderName = cleanFileName(currentSession.title);
      const folder = zip.folder(folderName);

      for (let i = 0; i < exportPages.length; i++) {
        const page = exportPages[i];
        const pct = Math.round(((i + 1) / exportPages.length) * 70);
        updateProgress(`Compressing Page ${i + 1} of ${exportPages.length}...`, pct);

        const blob = await getRotatedBlob(page);
        const fileName = `Page_${String(i + 1).padStart(3, '0')}.png`;
        folder.file(fileName, blob);
      }

      updateProgress('Building ZIP download package...', 85);
      const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        updateProgress('Compressing archive...', 85 + Math.round(metadata.percent * 0.15));
      });

      downloadBlob(zipBlob, `${folderName}_Pages.zip`);
    } catch (err) {
      console.error('Failed to create ZIP:', err);
      alert('Error creating ZIP: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  // -------------------------------------------------------------
  // DELETE SESSION
  // -------------------------------------------------------------

  btnDeleteSession.addEventListener('click', async () => {
    if (!currentSessionId) return;
    if (confirm(`Permanently delete document "${currentSession.title}" (${currentPages.length} pages)?`)) {
      await PdfDB.deleteSession(currentSessionId);
      await refreshLibrary();
    }
  });

  // -------------------------------------------------------------
  // FILTERS & UI CONTROLS
  // -------------------------------------------------------------

  filterAll.addEventListener('click', () => setFilter('all', filterAll));
  filterIncluded.addEventListener('click', () => setFilter('included', filterIncluded));
  filterExcluded.addEventListener('click', () => setFilter('excluded', filterExcluded));

  function setFilter(filter, activeBtn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
    renderPages();
  }

  gridZoom.addEventListener('input', () => {
    document.documentElement.style.setProperty('--card-width', `${gridZoom.value}px`);
  });

  btnToggleSidebar.addEventListener('click', () => {
    sidebarEl.classList.toggle('collapsed');
  });

  btnRefreshLib.addEventListener('click', () => {
    refreshLibrary(currentSessionId);
  });

  // -------------------------------------------------------------
  // HELPER FUNCTIONS (ROTATION & DOWNLOAD)
  // -------------------------------------------------------------

  async function getRotatedBlob(page) {
    if (!page.rotation || page.rotation === 0) {
      return page.imageBlob;
    }

    return new Promise(async (resolve) => {
      const img = new Image();
      const tempUrl = URL.createObjectURL(page.imageBlob);
      img.onload = () => {
        const rot = page.rotation;
        const is90or270 = rot === 90 || rot === 270;
        const cw = is90or270 ? img.height : img.width;
        const ch = is90or270 ? img.width : img.height;

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        URL.revokeObjectURL(tempUrl);

        canvas.toBlob((blob) => resolve(blob), 'image/png');
      };
      img.src = tempUrl;
    });
  }

  async function getRotatedImageData(page) {
    const rot = page.rotation || 0;
    return new Promise(async (resolve) => {
      const img = new Image();
      const tempUrl = URL.createObjectURL(page.imageBlob);
      img.onload = () => {
        const is90or270 = rot === 90 || rot === 270;
        const cw = is90or270 ? img.height : img.width;
        const ch = is90or270 ? img.width : img.height;

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (rot !== 0) {
          ctx.translate(cw / 2, ch / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(img, -img.width / 2, -img.height / 2);
        } else {
          ctx.drawImage(img, 0, 0);
        }
        URL.revokeObjectURL(tempUrl);

        const dataUrl = canvas.toDataURL('image/png');
        resolve({ dataUrl, width: cw, height: ch });
      };
      img.src = tempUrl;
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
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

  function cleanupObjectUrls() {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls.clear();
  }

  async function updateStorageInfo() {
    const stats = await PdfDB.getStorageStats();
    const mb = (stats.approxBytes / (1024 * 1024)).toFixed(1);
    sidebarStorage.textContent = `Storage: ~${mb} MB (${stats.totalPageCount} pages)`;
  }

  function cleanFileName(str) {
    return (str || 'PDF_Document').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 50);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
