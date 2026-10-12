/**
 * PDF Page Snapper - IndexedDB Storage Layer
 * Supports Service Workers, Extension Pages, and Window contexts.
 */

(function (global) {
  const DB_NAME = 'PdfSnapperDB';
  const DB_VERSION = 1;
  let dbInstance = null;

  function openDB() {
    if (dbInstance) {
      return Promise.resolve(dbInstance);
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Sessions store
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Pages store
        if (!db.objectStoreNames.contains('pages')) {
          const pageStore = db.createObjectStore('pages', { keyPath: 'id' });
          pageStore.createIndex('sessionId', 'sessionId', { unique: false });
          pageStore.createIndex('sessionPageIndex', ['sessionId', 'pageIndex'], { unique: true });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  const PdfDB = {
    async createSession(sessionData) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const session = {
          id: sessionData.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          title: sessionData.title || 'Untitled Document',
          url: sessionData.url || '',
          createdAt: sessionData.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pageCount: sessionData.pageCount || 0,
          status: sessionData.status || 'capturing',
          settings: sessionData.settings || {}
        };
        const req = store.put(session);
        req.onsuccess = () => resolve(session);
        req.onerror = () => reject(req.error);
      });
    },

    async updateSession(id, updates) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const getReq = store.get(id);

        getReq.onsuccess = () => {
          if (!getReq.result) {
            reject(new Error(`Session not found: ${id}`));
            return;
          }
          const updated = {
            ...getReq.result,
            ...updates,
            updatedAt: new Date().toISOString()
          };
          const putReq = store.put(updated);
          putReq.onsuccess = () => resolve(updated);
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    },

    async getSession(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async getAllSessions() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const req = store.getAll();
        req.onsuccess = () => {
          const sessions = req.result || [];
          sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          resolve(sessions);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async deleteSession(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'pages'], 'readwrite');
        const sessionStore = tx.objectStore('sessions');
        const pageStore = tx.objectStore('pages');

        sessionStore.delete(id);

        const pageIndex = pageStore.index('sessionId');
        const req = pageIndex.openCursor(IDBKeyRange.only(id));

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    },

    async savePage(pageData) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['pages', 'sessions'], 'readwrite');
        const pageStore = tx.objectStore('pages');
        const sessionStore = tx.objectStore('sessions');

        const pageId = pageData.id || `${pageData.sessionId}_${String(pageData.pageIndex).padStart(4, '0')}`;
        const record = {
          id: pageId,
          sessionId: pageData.sessionId,
          pageIndex: pageData.pageIndex,
          imageBlob: pageData.imageBlob, // Blob object
          thumbnailDataUrl: pageData.thumbnailDataUrl || '',
          width: pageData.width || 0,
          height: pageData.height || 0,
          rotation: pageData.rotation || 0,
          excluded: pageData.excluded || false,
          capturedAt: new Date().toISOString()
        };

        const pageReq = pageStore.put(record);

        // Also update pageCount in session if needed
        const sessionReq = sessionStore.get(pageData.sessionId);
        sessionReq.onsuccess = () => {
          if (sessionReq.result) {
            const current = sessionReq.result;
            const newCount = Math.max(current.pageCount || 0, pageData.pageIndex + 1);
            current.pageCount = newCount;
            current.updatedAt = new Date().toISOString();
            sessionStore.put(current);
          }
        };

        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      });
    },

    async getPagesForSession(sessionId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readonly');
        const store = tx.objectStore('pages');
        const index = store.index('sessionId');
        const req = index.getAll(IDBKeyRange.only(sessionId));

        req.onsuccess = () => {
          const pages = req.result || [];
          pages.sort((a, b) => a.pageIndex - b.pageIndex);
          resolve(pages);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async updatePage(id, updates) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');
        const getReq = store.get(id);

        getReq.onsuccess = () => {
          if (!getReq.result) {
            reject(new Error(`Page not found: ${id}`));
            return;
          }
          const updated = {
            ...getReq.result,
            ...updates
          };
          const putReq = store.put(updated);
          putReq.onsuccess = () => resolve(updated);
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    },

    async deletePage(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    },

    async reorderPages(sessionId, orderedIds) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');

        let completed = 0;
        orderedIds.forEach((id, newIndex) => {
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            if (getReq.result) {
              const item = getReq.result;
              item.pageIndex = newIndex;
              store.put(item);
            }
            completed++;
            if (completed === orderedIds.length) {
              // Finish
            }
          };
        });

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    },

    async getStorageStats() {
      const sessions = await this.getAllSessions();
      let totalPages = 0;
      let approxBytes = 0;

      for (const s of sessions) {
        totalPages += (s.pageCount || 0);
      }

      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        approxBytes = estimate.usage || 0;
      }

      return {
        sessionCount: sessions.length,
        totalPageCount: totalPages,
        approxBytes: approxBytes
      };
    }
  };

  global.PdfDB = PdfDB;
})(typeof self !== 'undefined' ? self : this);
