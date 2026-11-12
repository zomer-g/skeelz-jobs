import { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } from 'pdf-lib';
import { AxiosError } from 'axios';
import { FilesErrorCodes, FilesErrorMessages } from '../i18n/i18n.js';

/**
 * Validates a PDF for JavaScript, embedded files, and suspicious metadata.
 * @param fileBuffer - The PDF file as a Buffer.
 * @returns {Promise<boolean>} - Returns true if sanitization is needed.
 */
export const validatePDF = async (fileBuffer: Buffer): Promise<boolean> => {
  try {
    // Convert Node Buffer to Uint8Array for pdf-lib
    const pdfData = new Uint8Array(fileBuffer);
    const pdfDoc = await PDFDocument.load(pdfData);
    const catalog = pdfDoc.catalog;

    // Check for JavaScript execution triggers in the catalog.
    if (catalog.has(PDFName.of('OpenAction')) || catalog.has(PDFName.of('AA'))) {
      return true;
    }

    // Check for JavaScript references and embedded files in the Names dictionary.
    const namesObj = catalog.get(PDFName.of('Names'));
    if (namesObj && namesObj instanceof PDFDict) {
      if (namesObj.has(PDFName.of('JavaScript'))) {
        return true;
      }
      if (namesObj.has(PDFName.of('EmbeddedFiles'))) {
        return true;
      }
    }

    // Check for suspicious metadata.
    const title = pdfDoc.getTitle();
    const author = pdfDoc.getAuthor();
    if ((title && title.includes('<script>')) || (author && author.includes('<script>'))) {
      return true;
    }

    return false;
  } catch (error) {
    console.log('Error validating PDF: ' + (error as Error).message);
    return true;
  }
};

/**
 * Sanitizes a PDF by removing JavaScript, metadata, embedded files, annotations,
 * and rewriting streams.
 * @param fileBuffer - The PDF file as a Buffer.
 * @returns {Promise<Buffer>} - The sanitized PDF as a Buffer.
 */
export const sanitizePDF = async (fileBuffer: Buffer): Promise<Buffer> => {
  try {
    // Convert Node Buffer to Uint8Array for pdf-lib
    const pdfData = new Uint8Array(fileBuffer);
    const pdfDoc = await PDFDocument.load(pdfData);
    const catalog = pdfDoc.catalog;

    // Create a PDF null object from the document's context.
    const pdfNull = pdfDoc.context.obj(null);

    // Remove JavaScript execution triggers from the catalog.
    ['OpenAction', 'AA', 'JS', 'JavaScript'].forEach((action) => {
      if (catalog.has(PDFName.of(action))) {
        catalog.delete(PDFName.of(action));
      }
    });

    // Remove JavaScript and EmbeddedFiles from the Names dictionary.
    const namesObj = catalog.get(PDFName.of('Names'));
    if (namesObj && namesObj instanceof PDFDict) {
      if (namesObj.has(PDFName.of('JavaScript'))) {
        namesObj.set(PDFName.of('JavaScript'), pdfNull);
      }
      if (namesObj.has(PDFName.of('EmbeddedFiles'))) {
        namesObj.set(PDFName.of('EmbeddedFiles'), pdfNull);
      }
    }

    // Clear all metadata.
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    // Remove annotations on each page.
    const pages = pdfDoc.getPages();
    for (const page of pages) {
      if (page.node.has(PDFName.of('Annots'))) {
        page.node.set(PDFName.of('Annots'), pdfNull);
      }
    }

    // Remove form fields (AcroForm) if present.
    const acroFormObj = catalog.get(PDFName.of('AcroForm'));
    if (acroFormObj && acroFormObj instanceof PDFDict) {
      catalog.set(PDFName.of('AcroForm'), pdfNull);
    }

    // Process page content streams: remove 'Filter' entries if they exist.
    for (const page of pages) {
      const contentStream = page.node.get(PDFName.of('Contents'));
      if (contentStream instanceof PDFArray) {
        contentStream.asArray().forEach((stream) => {
          if (stream instanceof PDFStream) {
            // Access the underlying dictionary via stream.dict
            const filter = stream.dict.get(PDFName.of('Filter'));
            if (filter) {
              stream.dict.set(PDFName.of('Filter'), pdfNull);
            }
          }
        });
      } else if (contentStream instanceof PDFStream) {
        const filter = contentStream.dict.get(PDFName.of('Filter'));
        if (filter) {
          contentStream.dict.set(PDFName.of('Filter'), pdfNull);
        }
      }
    }

    // Save and return the sanitized PDF as a Node Buffer.
    const sanitizedUint8Array = await pdfDoc.save();
    return Buffer.from(sanitizedUint8Array);
  } catch (error) {
    console.log('Error sanitizing PDF: ' + (error as Error).message);
    throw new AxiosError(
      FilesErrorMessages.PDF_FILE_SANITIZATION_FAILED,
      FilesErrorCodes.PDF_FILE_SANITIZATION_FAILED
    );
  }
};

export function getFileType(mimetype: string): "pdf" | "doc" | "docx"  {
  switch (mimetype) {
    case 'application/pdf':
      return 'pdf';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    default:
      return 'pdf';
  }
}