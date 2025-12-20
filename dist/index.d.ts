/**
 * PDF Splitter API - Production-ready HTTP endpoint for splitting multi-page PDFs
 *
 * Uses pdf-lib for PDF manipulation because:
 * - Pure JavaScript implementation (no external dependencies like Poppler)
 * - Well-maintained and actively developed
 * - Excellent API for page-level operations
 * - Works seamlessly in Node.js environments
 * - Perfect for automation tools like n8n
 *
 * Hosted on Railway and callable from n8n workflows
 */
/**
 * Represents a page range for splitting the PDF
 * Page numbers are 1-indexed (first page = 1)
 */
export type PageRange = {
    submission_id: string;
    start_page: number;
    end_page: number;
};
/**
 * Result of a successful PDF split operation
 */
export type SplitResult = {
    submission_id: string;
    outputPath: string;
    fileName: string;
    pageCount: number;
};
declare const app: import("express-serve-static-core").Express;
/**
 * Splits a multi-page PDF buffer into multiple PDFs based on specified page ranges
 *
 * @param pdfBuffer - Buffer containing the input PDF data
 * @param ranges - Array of page ranges to extract (1-indexed)
 * @param outputDir - Directory where split PDFs will be saved
 * @returns Object containing total pages and array of split results
 * @throws Error if PDF cannot be parsed or any range is invalid
 */
declare function splitPdfFromBuffer(pdfBuffer: Buffer, ranges: PageRange[], outputDir: string): Promise<{
    totalPages: number;
    results: SplitResult[];
}>;
export { app, splitPdfFromBuffer };
//# sourceMappingURL=index.d.ts.map