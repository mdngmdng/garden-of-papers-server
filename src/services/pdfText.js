const MAX_PAGES = 2_000;

async function extractPdfText(pdfBuffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    const count = Math.min(document.numPages, MAX_PAGES);
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => typeof item?.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(`[Page ${pageNumber}]\n${text}`);
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages.join('\n\n');
}

module.exports = { extractPdfText };
