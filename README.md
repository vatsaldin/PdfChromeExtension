# 📸 PDF Page Snapper - Chrome Extension

> **Capture, scroll, and store every page of any PDF offline without downloading the original PDF file.**

A powerful, high-precision Google Chrome extension (Manifest V3) that automatically scrolls through any open PDF document, online viewer, or web reader, captures high-resolution screenshots of each page, and compiles them into a clean offline document.

---

## 🌟 Key Features

- **⚡ Autonomous Page-by-Page Snapping:** Automatically detects PDF page elements (`.page`, `[data-page-number]`, `<canvas>`, `.pdf-page`, etc.) and scrolls through each page with clean framing.
- **🔄 Continuous Viewport Fallback:** If individual page elements are not present, it intelligently scrolls down the document container step-by-step to capture the entire document.
- **🎯 Interactive Container Picker:** Allows you to click any element on the page to target its specific scroll container (ideal for embedded modals or custom iframe readers).
- **🪟 Clean Cropping & Scrollbar Removal:** Automatically crops screenshots to the PDF viewer container (removing website navigation bars, headers, ads, and sidebars) and hides ugly scrollbars during capture.
- **⏱️ Lazy-Load & Render Synchronization:** Configurable render wait delays (300ms – 3000ms) ensuring high-resolution canvas tiles and images finish rendering before each screenshot is taken.
- **🔴 Floating Live HUD:** Sleek on-page overlay during capture showing progress (`Page 4 of 20`), live thumbnail preview, and buttons to **Pause**, **Resume**, **Finish & View**, or **Cancel**.
- **💾 100% Offline IndexedDB Storage:** Large document captures are stored directly as binary image blobs in your browser's IndexedDB. No network uploads, 100% private.
- **📑 Offline Document Gallery & Editor (`gallery.html`):**
  - Card grid view of all captured pages with resolution badges.
  - Fullscreen lightbox zoom viewer.
  - Reorder pages (move left/right).
  - Rotate individual pages by 90° clockwise.
  - Exclude/include or delete unwanted pages.
  - Rename document titles.
- **📦 Multi-Format Offline Exporting:**
  - **Export to PDF:** Bundles all high-res screenshots into a multi-page PDF matching exact page dimensions and aspect ratios using client-side `jsPDF`.
  - **Download ZIP:** Packages all pages into a `.zip` archive containing numbered PNG files (`Page_001.png`, `Page_002.png`, etc.) using `JSZip`.
  - **Single PNG Download:** Extract any specific page image.
- **📖 Built-in Offline PDF Reader (`reader.html`):** Direct `.pdf` URLs in Chrome are isolated by Chrome's native viewer. The extension includes a Mozilla PDF.js-powered offline reader where you can drop or open any PDF file or URL to snap all pages with 1 click.

---

## 🚀 How to Install in Google Chrome

1. Open Google Chrome.
2. Navigate to `chrome://extensions/` in your address bar.
3. Toggle on **"Developer mode"** in the top-right corner.
4. Click the **"Load unpacked"** button in the top-left corner.
5. Select the project directory:
   ```
   /mnt/hdd1/ProjectsExtDrive/PdfChromeExtension
   ```
6. The extension **"PDF Page Snapper - Offline Capture & Archiver"** will appear in your extensions list. Pin it to your Chrome toolbar for quick access!

---

## 📖 How to Use

### 1. Capturing from an Open Web Page / Online PDF Viewer
1. Open any webpage containing a PDF viewer (e.g. Google Drive PDF preview, DocSend, Scribd, Canvas LMS, PDF.js, or any web reader where downloading is disabled).
2. Click the **PDF Snapper** icon in the Chrome toolbar.
3. The popup will automatically analyze the page and display the detected status (e.g., `Ready to Capture: 14 PDF pages detected`).
4. Click **"Start Auto-Capture"**.
5. The popup closes, and a **floating HUD** appears in the top-right corner of the tab.
6. The extension will automatically scroll page-by-page, wait for each page to render, and take a clean screenshot.
7. When finished, it automatically opens the **Offline Document Gallery** in a new tab!

### 2. Capturing Nested or Complex Scroll Containers
If the PDF is inside a tricky container:
1. Open the PDF Snapper popup.
2. Click **"Pick Specific PDF Container"**.
3. Hover your cursor over the PDF document container on the web page (a blue outline with container dimensions will highlight it).
4. Click to select that container.
5. Click **"Start Auto-Capture"** to begin scrolling and snapping that exact container.

### 3. Managing Captures & Exporting in the Gallery
In the **Offline Gallery (`viewer/gallery.html`)**:
- **Edit Title:** Click on the document title at the top to rename it.
- **Inspect:** Click any page card to open the fullscreen zoom lightbox.
- **Rotate:** Click the rotate icon on any card or in the lightbox to rotate the image 90°.
- **Reorder:** Use the left/right arrows to swap page positions.
- **Exclude:** Click the checkmark/cross icon to exclude a page from export without deleting it.
- **Export to PDF:** Click **"Export to PDF"** to create a multi-page PDF file with high resolution and download it directly.
- **Download ZIP:** Click **"Download ZIP"** to download all page screenshots as a zipped archive of PNGs.

### 4. Direct `.pdf` Files & Chrome's Native Viewer
Because Chrome security isolates direct `.pdf` tabs (`file:///...pdf` or `https://.../doc.pdf`) from extension content scripts:
1. Click the **PDF Snapper** icon.
2. The popup will detect the native viewer and show **"Open in Snapper Reader"**.
3. In the Snapper Reader, the document will render offline with a 1-click **"Snap All Pages"** button!

---

## 🧪 Testing with the Included Mock Viewer

A full test environment is bundled in the extension:
1. Open Chrome and press `Ctrl + O` (or enter `file:///mnt/hdd1/ProjectsExtDrive/PdfChromeExtension/test_page/mock_viewer.html`).
2. Click the **PDF Snapper** extension icon in your Chrome toolbar.
3. Click **"Start Auto-Capture"**.
4. Observe the automatic scrolling, real-time HUD progress, and automatic transition into the Offline Gallery!

---

## 📂 Project Architecture

```
PdfChromeExtension/
├── manifest.json              # Chrome Manifest V3 configuration
├── background.js              # Service Worker: tab capture, OffscreenCanvas crop & lifecycle
├── icons/                     # 16px, 32px, 48px, 128px high-res icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── popup/                     # Extension popup interface
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/                   # Content scripts injected into web pages
│   ├── content.js             # Page detector, auto-scroller, element picker & HUD
│   └── content.css            # Styles for floating HUD and picker highlights
├── viewer/                    # Offline Document Gallery & Manager
│   ├── gallery.html           # Gallery interface with lightbox & sidebar
│   ├── gallery.css            # Responsive dark/indigo dashboard styles
│   ├── gallery.js             # Reordering, rotation, jsPDF & JSZip exporter
│   └── db.js                  # Shared IndexedDB binary storage layer
├── reader/                    # Built-in Offline PDF Viewer
│   ├── reader.html            # Drag-and-drop PDF reader
│   ├── reader.css             # Reader styling
│   └── reader.js              # Mozilla PDF.js rendering & batch page snapper
├── libs/                      # Bundled offline libraries (Zero CDN dependencies)
│   ├── jspdf.umd.min.js       # Client-side PDF generator
│   ├── jszip.min.js           # Client-side ZIP archive builder
│   ├── pdf.min.js             # Mozilla PDF.js document parser
│   └── pdf.worker.min.js      # Mozilla PDF.js web worker
└── test_page/
    └── mock_viewer.html       # 5-page mock PDF reader for immediate local testing
```

---

## 🔒 Privacy & Permissions

- **activeTab & scripting:** Used exclusively to scroll the document in your open window and capture visible pixels.
- **unlimitedStorage:** Allows storing documents with dozens or hundreds of high-res pages offline in IndexedDB without quota limits.
- **downloads:** Allows saving generated PDF and ZIP files directly to your machine.
- **100% Offline:** The extension operates entirely within your browser. No page data, images, or documents are ever sent to external servers.
