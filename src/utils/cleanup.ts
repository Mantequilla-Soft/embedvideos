import { promises as fs } from 'fs';
import path from 'path';

export interface CleanupStats {
  filesScanned: number;
  filesDeleted: number;
  bytesFreed: number;
  errors: string[];
}

export class CleanupService {
  private uploadDir: string;
  private retentionDays: number;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(uploadDir: string, retentionDays: number) {
    this.uploadDir = uploadDir;
    this.retentionDays = retentionDays;
  }

  /**
   * Start automatic cleanup on a schedule
   */
  start(intervalHours: number = 24): void {
    if (this.isRunning) {
      console.log('Cleanup service already running');
      return;
    }

    this.isRunning = true;
    console.log(`Starting cleanup service (running every ${intervalHours} hours, retention: ${this.retentionDays} days)`);

    // Run immediately on start
    this.runCleanup().catch(err => console.error('Initial cleanup failed:', err));

    // Schedule periodic cleanup
    this.intervalId = setInterval(() => {
      this.runCleanup().catch(err => console.error('Scheduled cleanup failed:', err));
    }, intervalHours * 60 * 60 * 1000);
  }

  /**
   * Stop the cleanup service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('Cleanup service stopped');
    }
  }

  /**
   * Run cleanup manually
   */
  async runCleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = {
      filesScanned: 0,
      filesDeleted: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      console.log(`Starting cleanup: checking files older than ${this.retentionDays} days in ${this.uploadDir}`);
      
      const cutoffTime = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);
      
      // Read all files in upload directory
      const files = await fs.readdir(this.uploadDir);
      
      for (const file of files) {
        const filePath = path.join(this.uploadDir, file);
        
        try {
          const stat = await fs.stat(filePath);
          stats.filesScanned++;
          
          // Skip directories
          if (stat.isDirectory()) {
            continue;
          }
          
          // Check if file is old enough to delete
          const fileAge = Date.now() - stat.mtimeMs;
          if (stat.mtimeMs < cutoffTime) {
            const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2);
            const ageInDays = (fileAge / (24 * 60 * 60 * 1000)).toFixed(1);
            
            console.log(`Deleting old file: ${file} (${fileSizeMB}MB, ${ageInDays} days old)`);
            
            await fs.unlink(filePath);
            stats.filesDeleted++;
            stats.bytesFreed += stat.size;
          }
        } catch (error) {
          const errorMsg = `Failed to process ${file}: ${error instanceof Error ? error.message : String(error)}`;
          console.error(errorMsg);
          stats.errors.push(errorMsg);
        }
      }
      
      const mbFreed = (stats.bytesFreed / (1024 * 1024)).toFixed(2);
      console.log(`Cleanup completed: ${stats.filesDeleted}/${stats.filesScanned} files deleted, ${mbFreed}MB freed`);
      
      if (stats.errors.length > 0) {
        console.warn(`Cleanup had ${stats.errors.length} errors`);
      }
    } catch (error) {
      const errorMsg = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(errorMsg);
      stats.errors.push(errorMsg);
    }

    return stats;
  }

  /**
   * Get info about files that would be deleted without actually deleting them
   */
  async previewCleanup(): Promise<{ files: Array<{ name: string; size: number; age: number }>; totalSize: number }> {
    const cutoffTime = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);
    const filesToDelete: Array<{ name: string; size: number; age: number }> = [];
    let totalSize = 0;

    try {
      const files = await fs.readdir(this.uploadDir);
      
      for (const file of files) {
        const filePath = path.join(this.uploadDir, file);
        
        try {
          const stat = await fs.stat(filePath);
          
          if (stat.isDirectory()) {
            continue;
          }
          
          if (stat.mtimeMs < cutoffTime) {
            const ageInDays = (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
            filesToDelete.push({
              name: file,
              size: stat.size,
              age: ageInDays,
            });
            totalSize += stat.size;
          }
        } catch (error) {
          console.error(`Failed to stat file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Failed to preview cleanup:', error);
    }

    return { files: filesToDelete, totalSize };
  }
}
