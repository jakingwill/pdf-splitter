# PDF Splitter API

Production-ready HTTP API for splitting multi-page PDFs by page ranges. Designed for automation tools like n8n and deployable on Railway.

## Features

- Split PDFs by custom page ranges
- **Two response modes:**
  - JSON with direct download URLs (default, ideal for n8n)
  - ZIP file with all PDFs (optional)
- **Automatic cleanup** of old jobs (60-minute retention)
- **Direct file streaming** for memory efficiency
- RESTful API endpoints (split, download, manifest, delete)
- File upload support (up to 50MB)
- 1-indexed page numbers (page 1 = first page)
- Comprehensive validation and security (path traversal protection)
- CORS enabled
- Railway-ready deployment

## Technology Stack

**pdf-lib** was chosen for PDF manipulation because:
- Pure JavaScript (no native dependencies)
- Well-maintained and actively developed
- Excellent page-level operations
- Works seamlessly in Node.js
- Perfect for automation tools like n8n

## Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start
```

## Development

```bash
# Build and run in one command
npm run dev
```

## API Endpoints

### Health Check

**GET** `/health`

Returns server status.

**Response:**
```json
{
  "status": "healthy",
  "service": "pdf-splitter-api",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Split PDF (Default: JSON with Download URLs)

**POST** `/split`

Splits a PDF file into multiple PDFs based on page ranges and returns JSON with direct download URLs for each file.

**Request:**
- **Content-Type:** `multipart/form-data`
- **Parameters:**
  - `file` (required): PDF file to split
  - `ranges` (required): JSON array of page ranges
- **Query Parameters:**
  - `format` (optional): Set to `zip` for ZIP file response (default: JSON)

**Page Range Format:**
```typescript
{
  "submission_id": string,  // Unique identifier (becomes filename)
  "start_page": number,     // First page (1-indexed)
  "end_page": number        // Last page (1-indexed, inclusive)
}
```

**Example Request (JSON mode - default):**
```bash
curl -X POST http://localhost:3000/split \
  -F "file=@./input/class_merged.pdf" \
  -F 'ranges=[
    {"submission_id":"0356","start_page":1,"end_page":2},
    {"submission_id":"0342","start_page":3,"end_page":4},
    {"submission_id":"0335","start_page":5,"end_page":6}
  ]'
```

**Success Response (200) - JSON Mode:**
```json
{
  "job_id": "1234567890123",
  "totalPages": 6,
  "submissionCount": 3,
  "results": [
    {
      "submission_id": "0356",
      "fileName": "0356.pdf",
      "pageCount": 2,
      "download_url": "http://localhost:3000/jobs/1234567890123/0356.pdf"
    },
    {
      "submission_id": "0342",
      "fileName": "0342.pdf",
      "pageCount": 2,
      "download_url": "http://localhost:3000/jobs/1234567890123/0342.pdf"
    },
    {
      "submission_id": "0335",
      "fileName": "0335.pdf",
      "pageCount": 2,
      "download_url": "http://localhost:3000/jobs/1234567890123/0335.pdf"
    }
  ]
}
```

**Example Request (ZIP mode - optional):**
```bash
curl -X POST "http://localhost:3000/split?format=zip" \
  -F "file=@./input/class_merged.pdf" \
  -F 'ranges=[
    {"submission_id":"0356","start_page":1,"end_page":2},
    {"submission_id":"0342","start_page":3,"end_page":4},
    {"submission_id":"0335","start_page":5,"end_page":6}
  ]' \
  -o split_submissions.zip
```

**Success Response (200) - ZIP Mode:**
- **Content-Type:** `application/zip`
- **Content-Disposition:** `attachment; filename="split_submissions.zip"`
- **Body:** Binary ZIP file containing all PDFs and manifest.json

**Error Response (400/500):**
```json
{
  "success": false,
  "error": "Error message here"
}
```

### Download PDF File

**GET** `/jobs/:jobId/:fileName`

Download a specific split PDF file from a job.

**Example:**
```bash
curl -O http://localhost:3000/jobs/1234567890123/0356.pdf
```

**Response:**
- **Content-Type:** `application/pdf`
- Binary PDF file stream

**Error Response (404):**
```json
{
  "success": false,
  "error": "Job 1234567890123 not found. It may have expired (jobs are kept for 60 minutes)."
}
```

### Get Job Manifest

**GET** `/jobs/:jobId/manifest.json`

Retrieve the manifest for a specific job containing metadata about all split PDFs.

**Example:**
```bash
curl http://localhost:3000/jobs/1234567890123/manifest.json
```

**Response:**
```json
{
  "totalPages": 6,
  "submissionCount": 3,
  "results": [
    {
      "submission_id": "0356",
      "fileName": "0356.pdf",
      "pageCount": 2,
      "download_url": "http://localhost:3000/jobs/1234567890123/0356.pdf"
    }
  ]
}
```

### Delete Job

**DELETE** `/jobs/:jobId`

Manually delete a job and its associated files before automatic expiration.

**Example:**
```bash
curl -X DELETE http://localhost:3000/jobs/1234567890123
```

**Response:**
```json
{
  "success": true,
  "message": "Job 1234567890123 deleted successfully"
}
```

## Validation Rules

The API validates all inputs:

1. **submission_id**: Cannot be empty
2. **start_page**: Must be >= 1
3. **end_page**: Must be >= start_page
4. **Page bounds**: Both pages must exist in the PDF
5. **File type**: Must be a valid PDF
6. **File size**: Maximum 50MB

## Usage with n8n

The JSON mode (default) is the most efficient for n8n workflows since you get direct download URLs for each PDF without needing to unzip files.

### Method 1: HTTP Request Node (Recommended)

1. Add an **HTTP Request** node
2. Configure:
   - **Method:** POST
   - **URL:** `https://your-railway-app.railway.app/split`
   - **Body Content Type:** Form-Data (Multipart)
   - **Body Parameters:**
     - Add `file` parameter with binary file data
     - Add `ranges` parameter with JSON array
3. The response will contain download URLs for each PDF
4. Use another HTTP Request node to download individual PDFs as needed

### Method 2: Code Node Example (JSON Mode)

```javascript
// In n8n Code node - Split PDF and get download URLs
const FormData = require('form-data');
const form = new FormData();

// Add PDF file
form.append('file', Buffer.from(items[0].binary.data.data), {
  filename: 'input.pdf',
  contentType: 'application/pdf'
});

// Add ranges
const ranges = [
  { submission_id: '0356', start_page: 1, end_page: 2 },
  { submission_id: '0342', start_page: 3, end_page: 4 }
];
form.append('ranges', JSON.stringify(ranges));

// Make request (default JSON mode)
const response = await axios.post(
  'https://your-railway-app.railway.app/split',
  form,
  { headers: form.getHeaders() }
);

// response.data contains job_id and download URLs
// {
//   job_id: "1234567890123",
//   totalPages: 4,
//   submissionCount: 2,
//   results: [
//     { submission_id: "0356", fileName: "0356.pdf", pageCount: 2, download_url: "..." },
//     { submission_id: "0342", fileName: "0342.pdf", pageCount: 2, download_url: "..." }
//   ]
// }

return response.data.results.map(result => ({
  json: {
    submission_id: result.submission_id,
    download_url: result.download_url,
    pageCount: result.pageCount
  }
}));
```

### Method 3: Download Individual PDFs in n8n

After getting the JSON response, use an HTTP Request node to download specific PDFs:

```javascript
// In n8n HTTP Request node
// URL: {{ $json.download_url }}
// Method: GET
// Response Format: File

// This will download the PDF file directly
```

### Method 4: ZIP Mode (Optional)

If you prefer ZIP files, add `?format=zip` to the URL:

```javascript
// Make request with ZIP format
const response = await axios.post(
  'https://your-railway-app.railway.app/split?format=zip',
  form,
  {
    headers: form.getHeaders(),
    responseType: 'arraybuffer'
  }
);

// response.data contains the ZIP file as a buffer
return [{
  binary: {
    data: Buffer.from(response.data),
    fileName: 'split_submissions.zip',
    mimeType: 'application/zip'
  }
}];
```

## Deployment to Railway

### Option 1: GitHub Integration (Recommended)

1. Push code to GitHub
2. Go to [Railway](https://railway.app)
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway auto-detects Node.js and deploys
6. Your API will be live at: `https://your-app.railway.app`

### Option 2: Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Deploy
railway up
```

### Railway Configuration

Railway automatically detects the build and start commands from `package.json`. No additional configuration needed!

The app uses `process.env.PORT` which Railway provides automatically.

### Environment Variables (Optional)

Set in Railway dashboard:
- `NODE_ENV=production`

## Testing Locally

1. **Install dependencies:**
```bash
npm install
```

2. **Build the project:**
```bash
npm run build
```

3. **Start the server:**
```bash
npm start
```

4. **Test with curl:**
```bash
# Health check
curl http://localhost:3000/health

# Split PDF and get download URLs (JSON mode - default)
curl -X POST http://localhost:3000/split \
  -F "file=@./path/to/your.pdf" \
  -F 'ranges=[{"submission_id":"test","start_page":1,"end_page":1}]'

# Response will contain:
# {
#   "job_id": "1234567890123",
#   "totalPages": 1,
#   "submissionCount": 1,
#   "results": [
#     {
#       "submission_id": "test",
#       "fileName": "test.pdf",
#       "pageCount": 1,
#       "download_url": "http://localhost:3000/jobs/1234567890123/test.pdf"
#     }
#   ]
# }

# Download a specific PDF
curl -O http://localhost:3000/jobs/1234567890123/test.pdf

# Get the job manifest
curl http://localhost:3000/jobs/1234567890123/manifest.json

# Clean up the job
curl -X DELETE http://localhost:3000/jobs/1234567890123

# Or use ZIP mode
curl -X POST "http://localhost:3000/split?format=zip" \
  -F "file=@./path/to/your.pdf" \
  -F 'ranges=[{"submission_id":"test","start_page":1,"end_page":1}]' \
  -o result.zip
```

## Project Structure

```
pdf-splitter/
├── src/
│   └── index.ts          # Main API server
├── dist/                 # Compiled JavaScript (generated)
├── input/                # Sample input directory
├── output/               # Sample output directory
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

## Response Formats

The API supports two response formats:

### Default: JSON with Download URLs (Recommended for n8n)

Returns JSON with direct download URLs for each split PDF. This is the most efficient format for automation workflows since you can:
- Download only the PDFs you need
- Process PDFs individually in your workflow
- Retry individual downloads if needed

**Job Lifecycle:**
- Each split operation creates a unique `job_id`
- PDFs are stored in `/tmp/pdf-splitter-output/<job_id>/`
- Jobs are automatically deleted after **60 minutes**
- You can manually delete a job using `DELETE /jobs/:jobId`

**Automatic Cleanup:**
- On each new split request, the API automatically cleans up jobs older than 60 minutes
- This prevents disk space accumulation on Railway or other hosting platforms
- No manual intervention required

### Optional: ZIP Format

Use `?format=zip` query parameter to get a ZIP file containing all PDFs and manifest.json. The ZIP is streamed directly to the client, avoiding large memory usage. Files are cleaned up immediately after the ZIP is sent.

## Error Handling

The API returns clear error messages for common issues:

- Missing file: `"No PDF file uploaded"`
- Invalid ranges: `"Invalid ranges format: ..."`
- Page out of bounds: `"start_page (10) exceeds total pages (6)"`
- Invalid PDF: `"Failed to parse PDF: ..."`

## License

MIT

## Support

For issues or questions, refer to the API documentation above or check the console logs for detailed error messages.
