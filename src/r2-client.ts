/**
 * Cloudflare R2 Storage Client Configuration
 *
 * This module configures the AWS SDK to work with Cloudflare R2
 * for persistent storage of split PDF files.
 *
 * IMPORTANT: Files uploaded to R2 are PERSISTENT and will NOT be automatically deleted.
 * They remain available for users to access indefinitely.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

// R2 Configuration from environment variables
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'f5356646acd5bdb980d4f90195ba873a';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '2f8caf290402d4045c073c4c2828cc55';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'b8822af2eb9d3e5689d2d5af0460e48c3f3b8e13dfbbfe8081666dc696484292';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'pdf-splitter-storage';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-bee39d9da3be44ad88f107fe87be5a16.r2.dev';

// Validate configuration on startup
function validateR2Config(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!R2_ACCOUNT_ID) errors.push('R2_ACCOUNT_ID is not set');
  if (!R2_ACCESS_KEY_ID) errors.push('R2_ACCESS_KEY_ID is not set');
  if (!R2_SECRET_ACCESS_KEY) errors.push('R2_SECRET_ACCESS_KEY is not set');
  if (!R2_BUCKET_NAME) errors.push('R2_BUCKET_NAME is not set');
  if (!R2_PUBLIC_URL) errors.push('R2_PUBLIC_URL is not set');

  return {
    valid: errors.length === 0,
    errors
  };
}

const configValidation = validateR2Config();
if (!configValidation.valid) {
  console.error('⚠️  R2 Configuration Issues:');
  configValidation.errors.forEach(err => console.error(`   - ${err}`));
  console.error('⚠️  R2 storage will not be available. Files will use local storage only.');
}

export const R2_ENABLED = configValidation.valid;

// Create S3 client configured for Cloudflare R2
export const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export const R2_CONFIG = {
  bucketName: R2_BUCKET_NAME,
  publicUrl: R2_PUBLIC_URL,
  accountId: R2_ACCOUNT_ID,
};

/**
 * Tests R2 connection by checking bucket access
 * @returns true if connection successful, false otherwise
 */
export async function testR2Connection(): Promise<boolean> {
  if (!R2_ENABLED) {
    return false;
  }

  try {
    const command = new HeadBucketCommand({
      Bucket: R2_CONFIG.bucketName,
    });
    await r2Client.send(command);
    console.log(`✓ R2 connection successful: ${R2_CONFIG.bucketName}`);
    return true;
  } catch (error) {
    console.error(`✗ R2 connection failed:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Uploads a PDF buffer to R2 storage
 * @param key - The object key (path) in R2
 * @param buffer - The PDF file buffer
 * @returns The public URL of the uploaded file
 */
export async function uploadToR2(key: string, buffer: Buffer): Promise<string> {
  if (!R2_ENABLED) {
    throw new Error('R2 is not properly configured');
  }

  const command = new PutObjectCommand({
    Bucket: R2_CONFIG.bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  });

  await r2Client.send(command);

  // Return public URL
  return `${R2_CONFIG.publicUrl}/${key}`;
}

/**
 * Deletes a file from R2 storage
 * @param key - The object key (path) in R2
 */
export async function deleteFromR2(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: R2_CONFIG.bucketName,
    Key: key,
  });

  await r2Client.send(command);
}

/**
 * Generates a storage key for a PDF file
 * @param jobId - The job ID
 * @param fileName - The file name
 * @returns The R2 storage key
 */
export function generateR2Key(jobId: string, fileName: string): string {
  return `jobs/${jobId}/${fileName}`;
}
