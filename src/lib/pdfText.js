// lib/pdfText.js — read a PDF manuscript in the browser. pdf.js supplies the
// positioned text; lib/pdfLayout.js turns it into manuscript text. Loaded on
// demand so the PDF library is only fetched when someone uploads a PDF.

import { layoutToText } from './pdfLayout.js'

export const PDF_PAGE_CAP = 80

export function itemsFromTextContent(textContent) {
  return textContent.items
    .filter((item) => typeof item.str === 'string')
    .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], w: item.width, h: item.height }))
}

export async function extractPdfText(arrayBuffer) {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  let doc
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
  } catch (err) {
    throw new Error(err?.name === 'PasswordException' ? 'This PDF is password-protected.' : 'This file could not be read as a PDF.', { cause: err })
  }
  const pages = []
  for (let n = 1; n <= Math.min(doc.numPages, PDF_PAGE_CAP); n += 1) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 1 })
    pages.push({ width: viewport.width, height: viewport.height, items: itemsFromTextContent(await page.getTextContent()) })
  }
  const text = layoutToText(pages)
  if (text.replace(/\s/g, '').length < 500) {
    throw new Error('No text was found in this PDF — it looks like a scan. Upload the .docx, or a PDF with selectable text.')
  }
  return text
}
