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
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { PDFDocument } from 'pdf-lib';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import archiver from 'archiver';
import { uploadToR2, generateR2Key, testR2Connection, R2_ENABLED } from './r2-client.js';
// Initialize Express app
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0'; // Bind to all interfaces for Railway
// Job registry for tracking temporary directories
const jobRegistry = new Map();
// Job retention time: 60 minutes
const JOB_RETENTION_MS = 60 * 60 * 1000;
// Graceful shutdown state
let isShuttingDown = false;
let server;
// Configure middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Middleware to reject requests during shutdown
app.use((req, res, next) => {
    if (isShuttingDown) {
        res.setHeader('Connection', 'close');
        return res.status(503).json({
            success: false,
            error: 'Server is shutting down',
        });
    }
    next();
});
// Configure multer for file uploads (store in memory for processing)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        }
        else {
            cb(new Error('Only PDF files are allowed'));
        }
    },
});
/**
 * Validates a page range against the total page count
 * @throws Error if validation fails
 */
function validatePageRange(range, totalPages, index) {
    const { submission_id, start_page, end_page } = range;
    // Validate submission_id is not empty
    if (!submission_id || submission_id.trim() === '') {
        throw new Error(`Range at index ${index}: submission_id cannot be empty`);
    }
    // Validate start_page is at least 1
    if (start_page < 1) {
        throw new Error(`Range "${submission_id}": start_page must be >= 1, got ${start_page}`);
    }
    // Validate end_page is >= start_page
    if (end_page < start_page) {
        throw new Error(`Range "${submission_id}": end_page (${end_page}) must be >= start_page (${start_page})`);
    }
    // Validate pages are within document bounds
    if (start_page > totalPages) {
        throw new Error(`Range "${submission_id}": start_page (${start_page}) exceeds total pages (${totalPages})`);
    }
    if (end_page > totalPages) {
        throw new Error(`Range "${submission_id}": end_page (${end_page}) exceeds total pages (${totalPages})`);
    }
}
/**
 * Ensures the output directory exists, creating it if necessary
 */
async function ensureOutputDirectory(outputDir) {
    if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true });
    }
}
/**
 * Validates jobId to prevent path traversal attacks
 */
function isValidJobId(jobId) {
    // Only allow alphanumeric characters and hyphens
    return /^[a-zA-Z0-9-]+$/.test(jobId);
}
/**
 * Validates fileName to prevent path traversal attacks
 */
function isValidFileName(fileName) {
    // Only allow alphanumeric, dash, underscore, and .pdf extension
    return /^[a-zA-Z0-9_-]+\.pdf$/.test(fileName);
}
/**
 * Cleans up old job directories (older than JOB_RETENTION_MS)
 * NOTE: R2 files are NOT deleted - they remain persistent for user access
 */
async function cleanupOldJobs() {
    const now = Date.now();
    const jobsToDelete = [];
    // Find jobs older than retention time
    for (const [jobId, job] of jobRegistry.entries()) {
        if (now - job.createdAt > JOB_RETENTION_MS) {
            jobsToDelete.push(jobId);
        }
    }
    // Delete old jobs
    for (const jobId of jobsToDelete) {
        const job = jobRegistry.get(jobId);
        if (job) {
            try {
                // NOTE: We do NOT delete R2 files here - they remain persistent
                // Only local temporary files are cleaned up
                // Delete local directory only
                await rm(job.directory, { recursive: true, force: true });
                jobRegistry.delete(jobId);
                console.log(`✓ Cleaned up old job: ${jobId} (local files only, R2 files preserved)`);
            }
            catch (err) {
                console.error(`Failed to clean up job ${jobId}:`, err);
            }
        }
    }
    if (jobsToDelete.length > 0) {
        console.log(`✓ Cleaned up ${jobsToDelete.length} old job(s) - R2 files preserved for persistent access`);
    }
}
/**
 * Deletes a specific job by jobId
 * NOTE: R2 files are NOT deleted - they remain persistent for user access
 */
async function deleteJob(jobId) {
    const job = jobRegistry.get(jobId);
    if (!job) {
        return false;
    }
    try {
        // NOTE: We do NOT delete R2 files here - they remain persistent
        // Only local temporary files are cleaned up
        // Delete local directory only
        await rm(job.directory, { recursive: true, force: true });
        jobRegistry.delete(jobId);
        console.log(`✓ Deleted job: ${jobId} (local files only, R2 files preserved)`);
        return true;
    }
    catch (err) {
        console.error(`Failed to delete job ${jobId}:`, err);
        throw err;
    }
}
/**
 * Builds the base URL from the request
 */
function getBaseUrl(req) {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('host') || `localhost:${PORT}`;
    return `${protocol}://${host}`;
}
/**
 * Splits a multi-page PDF buffer into multiple PDFs based on specified page ranges
 *
 * @param pdfBuffer - Buffer containing the input PDF data
 * @param ranges - Array of page ranges to extract (1-indexed)
 * @param outputDir - Directory where split PDFs will be saved
 * @param jobId - Job ID for R2 storage path
 * @param uploadToR2Storage - Whether to upload to R2 (true for JSON mode, false for ZIP mode)
 * @returns Object containing total pages and array of split results
 * @throws Error if PDF cannot be parsed or any range is invalid
 */
async function splitPdfFromBuffer(pdfBuffer, ranges, outputDir, jobId, uploadToR2Storage = true) {
    // Step 1: Load the PDF document from buffer
    let sourcePdf;
    try {
        sourcePdf = await PDFDocument.load(pdfBuffer);
    }
    catch (error) {
        throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
    const totalPages = sourcePdf.getPageCount();
    console.log(`Loaded PDF with ${totalPages} pages`);
    // Step 2: Validate all ranges before processing
    for (let i = 0; i < ranges.length; i++) {
        validatePageRange(ranges[i], totalPages, i);
    }
    // Step 3: Ensure output directory exists
    await ensureOutputDirectory(outputDir);
    // Step 4: Process each range and create split PDFs
    const results = [];
    for (const range of ranges) {
        const { submission_id, start_page, end_page } = range;
        console.log(`Processing ${submission_id}: pages ${start_page}-${end_page}`);
        // Create a new PDF document for this range
        const newPdf = await PDFDocument.create();
        // Copy pages from source PDF (convert from 1-indexed to 0-indexed)
        // pdf-lib uses 0-indexed page numbers internally
        const pageIndices = Array.from({ length: end_page - start_page + 1 }, (_, i) => start_page - 1 + i);
        // Copy each page to the new document
        const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
        copiedPages.forEach((page) => {
            newPdf.addPage(page);
        });
        // Step 5: Save the new PDF to disk
        const fileName = `${submission_id}.pdf`;
        const outputPath = join(outputDir, fileName);
        const pdfBytes = await newPdf.save();
        try {
            await writeFile(outputPath, pdfBytes);
            console.log(`  ✓ Saved locally: ${outputPath}`);
        }
        catch (error) {
            throw new Error(`Failed to write output PDF "${outputPath}": ${error instanceof Error ? error.message : String(error)}`);
        }
        // Step 6: Upload to R2 if requested (for persistent storage in JSON mode)
        let r2Url;
        let r2Key;
        if (uploadToR2Storage && R2_ENABLED) {
            try {
                r2Key = generateR2Key(jobId, fileName);
                r2Url = await uploadToR2(r2Key, Buffer.from(pdfBytes));
                console.log(`  ✓ Uploaded to R2: ${r2Url}`);
            }
            catch (error) {
                console.error(`  ✗ Failed to upload ${fileName} to R2:`);
                console.error(`    Error: ${error instanceof Error ? error.message : String(error)}`);
                if (error instanceof Error && error.stack) {
                    console.error(`    Stack: ${error.stack}`);
                }
                // Don't fail the whole operation if R2 upload fails
                // Fall back to local file serving
            }
        }
        else if (uploadToR2Storage && !R2_ENABLED) {
            console.log(`  ⚠ R2 disabled - using local storage for ${fileName}`);
        }
        results.push({
            submission_id,
            outputPath,
            fileName,
            pageCount: end_page - start_page + 1,
            r2Url,
            r2Key,
        });
    }
    return { totalPages, results };
}
/**
 * Health check endpoint - must respond quickly without blocking operations
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'pdf-splitter-api',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});
/**
 * Readiness check endpoint - indicates if service is ready to accept requests
 */
app.get('/ready', (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            status: 'not ready',
            reason: 'shutting down',
        });
    }
    res.json({
        status: 'ready',
        service: 'pdf-splitter-api',
    });
});
/**
 * Main PDF splitting endpoint
 *
 * POST /split
 *
 * Accepts:
 * - file: PDF file (multipart/form-data)
 * - ranges: JSON array of page ranges (can be sent as form field or in request body)
 * - format: Optional query param "zip" for ZIP format (default: JSON with URLs)
 *
 * Returns:
 * - Default: JSON with download URLs for each PDF
 * - ?format=zip: ZIP file containing split PDFs and manifest.json
 *
 * Example curl request (JSON mode):
 * curl -X POST http://localhost:3000/split \
 *   -F "file=@./input/class_merged.pdf" \
 *   -F 'ranges=[{"submission_id":"0356","start_page":1,"end_page":2}]'
 *
 * Example curl request (ZIP mode):
 * curl -X POST "http://localhost:3000/split?format=zip" \
 *   -F "file=@./input/class_merged.pdf" \
 *   -F 'ranges=[{"submission_id":"0356","start_page":1,"end_page":2}]' \
 *   -o output.zip
 */
app.post('/split', upload.single('file'), async (req, res, next) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let outputDir = null;
    let jobId = null;
    console.log(`[${requestId}] New split request received`);
    try {
        // Clean up old jobs before processing
        await cleanupOldJobs();
        // Validate file upload
        if (!req.file) {
            console.log(`[${requestId}] Error: No file uploaded`);
            return res.status(400).json({
                success: false,
                error: 'No PDF file uploaded. Please include a file in the "file" field.',
            });
        }
        // Parse ranges from request
        let ranges;
        try {
            // Ranges can come from form field or JSON body
            const rangesData = req.body.ranges || req.body;
            ranges = typeof rangesData === 'string' ? JSON.parse(rangesData) : rangesData;
            if (!Array.isArray(ranges) || ranges.length === 0) {
                throw new Error('Ranges must be a non-empty array');
            }
        }
        catch (error) {
            console.log(`[${requestId}] Error: Invalid ranges format`);
            return res.status(400).json({
                success: false,
                error: `Invalid ranges format: ${error instanceof Error ? error.message : String(error)}. Expected JSON array of {submission_id, start_page, end_page} objects.`,
            });
        }
        // Determine response format
        const format = req.query.format;
        const useZipFormat = format === 'zip';
        // Create job ID and output directory
        jobId = Date.now().toString();
        outputDir = join(tmpdir(), 'pdf-splitter-output', jobId);
        await ensureOutputDirectory(outputDir);
        console.log(`[${requestId}] Processing PDF split:`);
        console.log(`  - Job ID: ${jobId}`);
        console.log(`  - File size: ${req.file.size} bytes`);
        console.log(`  - Ranges count: ${ranges.length}`);
        console.log(`  - Format: ${useZipFormat ? 'ZIP' : 'JSON'}`);
        console.log(`  - Output dir: ${outputDir}`);
        // Process the PDF split
        // Upload to R2 in JSON mode, skip in ZIP mode (for faster streaming)
        const { totalPages, results } = await splitPdfFromBuffer(req.file.buffer, ranges, outputDir, jobId, !useZipFormat // Upload to R2 only in JSON mode
        );
        console.log(`[${requestId}] ✓ Split complete: ${results.length} files created`);
        // Build base URL for download links (fallback for local files)
        const baseUrl = getBaseUrl(req);
        // Create manifest with download URLs
        // Use R2 URLs if available, otherwise use local file URLs
        const manifest = {
            totalPages,
            submissionCount: results.length,
            results: results.map(r => ({
                submission_id: r.submission_id,
                fileName: r.fileName,
                pageCount: r.pageCount,
                download_url: r.r2Url || `${baseUrl}/jobs/${jobId}/${r.fileName}`,
            })),
        };
        if (useZipFormat) {
            // ZIP MODE: Stream ZIP file and clean up immediately after
            console.log(`[${requestId}] ✓ Returning ZIP format`);
            // Set response headers for ZIP download
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="split_submissions.zip"');
            // Create ZIP archive
            const archive = archiver('zip', {
                zlib: { level: 9 }, // Maximum compression
            });
            // Handle archive errors
            archive.on('error', (err) => {
                console.error(`[${requestId}] Archive error:`, err);
                throw err;
            });
            // Pipe archive to response
            archive.pipe(res);
            // Add each PDF to the ZIP
            for (const result of results) {
                archive.file(result.outputPath, { name: result.fileName });
            }
            // Add manifest.json to the ZIP (without download_url in ZIP mode)
            const zipManifest = {
                totalPages: manifest.totalPages,
                submissionCount: manifest.submissionCount,
                results: manifest.results.map(r => ({
                    submission_id: r.submission_id,
                    fileName: r.fileName,
                    pageCount: r.pageCount,
                })),
            };
            archive.append(JSON.stringify(zipManifest, null, 2), { name: 'manifest.json' });
            console.log(`[${requestId}] ✓ Streaming ZIP with ${results.length} PDFs + manifest.json`);
            // Finalize the archive (this will trigger streaming to the client)
            await archive.finalize();
            console.log(`[${requestId}] ✓ ZIP sent successfully`);
            // Clean up temp files immediately in ZIP mode
            setImmediate(async () => {
                if (outputDir) {
                    try {
                        await rm(outputDir, { recursive: true, force: true });
                        console.log(`[${requestId}] ✓ Cleaned up temp directory: ${outputDir}`);
                    }
                    catch (err) {
                        console.error(`[${requestId}] Failed to clean up ${outputDir}:`, err);
                    }
                }
            });
        }
        else {
            // JSON MODE: Register job and return URLs
            console.log(`[${requestId}] ✓ Returning JSON format with download URLs`);
            // Collect R2 keys for cleanup
            const r2Keys = results
                .map(r => r.r2Key)
                .filter((key) => key !== undefined);
            // Register the job in the registry
            jobRegistry.set(jobId, {
                jobId,
                directory: outputDir,
                createdAt: Date.now(),
                manifest,
                r2Keys,
            });
            // Return JSON response with download URLs
            const response = {
                job_id: jobId,
                totalPages: manifest.totalPages,
                submissionCount: manifest.submissionCount,
                results: manifest.results,
            };
            console.log(`[${requestId}] ✓ Job registered: ${jobId}`);
            console.log(`[${requestId}] ✓ Files available at: ${r2Keys.length > 0 ? 'R2 (permanent/persistent)' : 'local (60 minutes)'}`);
            console.log(`[${requestId}] ✓ Files stored in R2: ${r2Keys.length} of ${results.length}`);
            res.json(response);
        }
    }
    catch (error) {
        console.error(`[${requestId}] Error processing request:`, error);
        // Clean up on error
        if (outputDir && !jobId) {
            // Only clean up if job wasn't registered
            try {
                await rm(outputDir, { recursive: true, force: true });
            }
            catch (err) {
                console.error(`[${requestId}] Failed to clean up ${outputDir}:`, err);
            }
        }
        next(error);
    }
});
/**
 * Download a specific PDF file from a job
 *
 * GET /jobs/:jobId/:fileName
 *
 * Returns the PDF file with proper content-type headers
 */
app.get('/jobs/:jobId/:fileName', async (req, res, next) => {
    try {
        const { jobId, fileName } = req.params;
        // Validate jobId and fileName to prevent path traversal
        if (!isValidJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid job ID format',
            });
        }
        if (!isValidFileName(fileName)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid file name format',
            });
        }
        // Check if job exists
        const job = jobRegistry.get(jobId);
        if (!job) {
            return res.status(404).json({
                success: false,
                error: `Job ${jobId} not found. It may have expired (jobs are kept for 60 minutes).`,
            });
        }
        // Build file path
        const filePath = join(job.directory, fileName);
        // Check if file exists
        if (!existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: `File ${fileName} not found in job ${jobId}`,
            });
        }
        // Stream the PDF file
        console.log(`✓ Streaming file: ${fileName} from job ${jobId}`);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        const fileStream = createReadStream(filePath);
        fileStream.pipe(res);
        fileStream.on('error', (err) => {
            console.error(`Error streaming file ${fileName}:`, err);
            next(err);
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * Get the manifest for a specific job
 *
 * GET /jobs/:jobId/manifest.json
 *
 * Returns the manifest JSON with metadata about all split PDFs
 */
app.get('/jobs/:jobId/manifest.json', async (req, res) => {
    try {
        const { jobId } = req.params;
        // Validate jobId
        if (!isValidJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid job ID format',
            });
        }
        // Check if job exists
        const job = jobRegistry.get(jobId);
        if (!job) {
            return res.status(404).json({
                success: false,
                error: `Job ${jobId} not found. It may have expired (jobs are kept for 60 minutes).`,
            });
        }
        // Return the manifest
        console.log(`✓ Returning manifest for job ${jobId}`);
        res.json(job.manifest);
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to retrieve manifest',
        });
    }
});
/**
 * Delete a specific job and its files
 *
 * DELETE /jobs/:jobId
 *
 * Manually clean up a job before the automatic 60-minute expiration
 */
app.delete('/jobs/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        // Validate jobId
        if (!isValidJobId(jobId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid job ID format',
            });
        }
        // Delete the job
        const deleted = await deleteJob(jobId);
        if (!deleted) {
            return res.status(404).json({
                success: false,
                error: `Job ${jobId} not found`,
            });
        }
        res.json({
            success: true,
            message: `Job ${jobId} deleted successfully`,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete job',
        });
    }
});
/**
 * 404 handler
 */
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found. Available endpoints: GET /health, GET /ready, POST /split, GET /jobs/:jobId/:fileName, GET /jobs/:jobId/manifest.json, DELETE /jobs/:jobId',
    });
});
/**
 * Global error handler
 */
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({
        success: false,
        error: err.message || 'An unexpected error occurred',
    });
});
/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received - starting graceful shutdown`);
    isShuttingDown = true;
    // Stop accepting new connections
    server.close(async () => {
        console.log('✓ HTTP server closed');
        // Clean up resources
        try {
            console.log('Cleaning up resources...');
            // Add any cleanup logic here if needed
            console.log('✓ Resources cleaned up');
            process.exit(0);
        }
        catch (error) {
            console.error('Error during cleanup:', error);
            process.exit(1);
        }
    });
    // Force shutdown after 30 seconds if graceful shutdown hangs
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 30000);
}
// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});
/**
 * Start the server
 */
server = app.listen(PORT, HOST, async () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║              PDF Splitter API - Running                   ║
╠════════════════════════════════════════════════════════════╣
║  Port:        ${PORT.toString().padEnd(43)}║
║  Host:        ${HOST.padEnd(43)}║
║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(43)}║
║  Health:      http://localhost:${PORT}/health${' '.repeat(24)}║
║  Ready:       http://localhost:${PORT}/ready${' '.repeat(25)}║
║  Split API:   POST http://localhost:${PORT}/split${' '.repeat(20)}║
╚════════════════════════════════════════════════════════════╝
  `);
    // Test R2 connection on startup (non-blocking)
    console.log('Testing R2 connection...');
    testR2Connection()
        .then(r2Connected => {
        if (r2Connected) {
            console.log('✓ R2 storage is enabled - PDFs will be persisted\n');
        }
        else {
            console.log('⚠️  R2 storage is disabled - PDFs will use local storage only\n');
        }
    })
        .catch(err => {
        console.error('⚠️  R2 connection test failed:', err.message);
        console.log('⚠️  R2 storage is disabled - PDFs will use local storage only\n');
    });
});
// Export for testing
export { app, splitPdfFromBuffer };
//# sourceMappingURL=index.js.map