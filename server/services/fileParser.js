/**
 * File Parser — Extracts text from PDF, DOCX, TXT, MD files
 */

import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Parse a file and extract its text content
 * @param {string} filePath - Path to the uploaded file
 * @param {string} originalName - Original filename
 * @returns {{ filename: string, content: string, type: string, charCount: number }}
 */
export async function parseFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  let content = '';
  let type = ext.replace('.', '').toUpperCase();

  switch (ext) {
    case '.pdf':
      content = await parsePDF(filePath);
      break;
    case '.docx':
      content = await parseDOCX(filePath);
      break;
    case '.txt':
    case '.md':
      content = fs.readFileSync(filePath, 'utf-8');
      break;
    default:
      throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .docx, .txt, .md`);
  }

  // Clean up the text
  content = content
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  return {
    filename: originalName,
    content,
    type,
    charCount: content.length,
  };
}

async function parsePDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  
  const text = data.text.trim();
  const numPages = data.numpages;
  const sizeBytes = buffer.byteLength;
  
  // If it extracts almost no text, classify the failure reason
  if (text.length < 50) {
    // If it's a large file (>50KB) or has multiple pages, it's almost certainly an image scan
    if (sizeBytes > 50000 || numPages > 1) {
      throw new Error('Flat Scanned PDF detected. Please use <a href="https://www.ilovepdf.com/ocr-pdf" target="_blank">iLovePDF OCR</a> to convert this image-based PDF into searchable text before uploading.');
    } else {
      throw new Error('Completely Empty PDF. No text could be extracted.');
    }
  }
  
  return data.text;
}

async function parseDOCX(filePath) {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Get supported file extensions
 */
export function getSupportedExtensions() {
  return ['.pdf', '.docx', '.txt', '.md'];
}
