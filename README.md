# PDF Splitter API

Production-ready HTTP API for splitting multi-page PDFs by page ranges. Designed for automation tools like n8n and deployable on Railway.

## Features

- Split PDFs by custom page ranges
- RESTful API endpoint
- File upload support (up to 50MB)
- 1-indexed page numbers (page 1 = first page)
- Comprehensive validation
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

### Split PDF

**POST** `/split`

Splits a PDF file into multiple PDFs based on page ranges.

**Request:**
- **Content-Type:** `multipart/form-data`
- **Parameters:**
  - `file` (required): PDF file to split
  - `ranges` (required): JSON array of page ranges

**Page Range Format:**
```typescript
{
  "submission_id": string,  // Unique identifier (becomes filename)
  "start_page": number,     // First page (1-indexed)
  "end_page": number        // Last page (1-indexed, inclusive)
}
```

**Example Request (curl):**
```bash
curl -X POST http://localhost:3000/split \
  -F "file=@./input/class_merged.pdf" \
  -F 'ranges=[
    {"submission_id":"0356","start_page":1,"end_page":2},
    {"submission_id":"0342","start_page":3,"end_page":4},
    {"submission_id":"0335","start_page":5,"end_page":6}
  ]'
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Successfully split PDF into 3 files",
  "totalPages": 6,
  "results": [
    {
      "submission_id": "0356",
      "outputPath": "/tmp/pdf-splitter-output/1234567890/0356.pdf",
      "fileName": "0356.pdf",
      "pageCount": 2
    },
    {
      "submission_id": "0342",
      "outputPath": "/tmp/pdf-splitter-output/1234567890/0342.pdf",
      "fileName": "0342.pdf",
      "pageCount": 2
    },
    {
      "submission_id": "0335",
      "outputPath": "/tmp/pdf-splitter-output/1234567890/0335.pdf",
      "fileName": "0335.pdf",
      "pageCount": 2
    }
  ]
}
```

**Error Response (400/500):**
```json
{
  "success": false,
  "error": "Error message here"
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

### Method 1: HTTP Request Node

1. Add an **HTTP Request** node
2. Configure:
   - **Method:** POST
   - **URL:** `https://your-railway-app.railway.app/split`
   - **Body Content Type:** Form-Data (Multipart)
   - **Body Parameters:**
     - Add `file` parameter with binary file data
     - Add `ranges` parameter with JSON array

### Method 2: Code Node Example

```javascript
// In n8n Code node
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

// Make request
const response = await axios.post(
  'https://your-railway-app.railway.app/split',
  form,
  { headers: form.getHeaders() }
);

return response.data;
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

# Split PDF (replace with your file path)
curl -X POST http://localhost:3000/split \
  -F "file=@./path/to/your.pdf" \
  -F 'ranges=[{"submission_id":"test","start_page":1,"end_page":1}]'
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

## Response File Paths

The API returns file paths to the split PDFs. These are stored in the system's temp directory:
- **Local:** `/tmp/pdf-splitter-output/<timestamp>/`
- **Railway:** Ephemeral storage (files cleared on restart)

**Note:** For production use, consider integrating cloud storage (S3, Google Cloud Storage) to persist the split PDFs and return download URLs instead of local paths.

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
