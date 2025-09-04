import * as crypto from "crypto";
import * as fs from "fs";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;

export class Decryptor {
  private infoPath: string;

  constructor(infoPath = ".ethery/info.json") {
    this.infoPath = infoPath;
  }

  private getKeyForFile(filePath: string, info: any): Buffer {
    if (!fs.existsSync(this.infoPath)) {
      throw new Error(`Key info file not found: ${this.infoPath}`);
    }
    const hexKey = info[filePath];
    if (!hexKey) {
      throw new Error(
        `Encryption key for file "${filePath}" not found in ${this.infoPath}`,
      );
    }

    const key = Buffer.from(hexKey, "hex");
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Invalid key length. Expected ${KEY_LENGTH} bytes.`);
    }

    return key; // chuyển sang Uint8Array
  }

  public decryptFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Encrypted file not found: ${filePath}`);
    }

    let info;
    try {
      info = JSON.parse(fs.readFileSync(this.infoPath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to read or parse info file ${this.infoPath}: ${error}`);
    }

    const encryptPath = Object.keys(info)[0];
    if (!encryptPath) {
      throw new Error(`No encryption path found in ${this.infoPath}`);
    }

    if (!fs.existsSync(encryptPath)) {
      throw new Error(`Encrypted data file not found: ${encryptPath}`);
    }

    const encryptedData = fs.readFileSync(encryptPath);

    // Validate file size
    const minSize = SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
    if (encryptedData.length < minSize) {
      throw new Error(`Encrypted file is too small. Expected at least ${minSize} bytes, got ${encryptedData.length}`);
    }

    const salt = encryptedData.subarray(0, SALT_LENGTH); // không dùng
    const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = encryptedData.subarray(
      SALT_LENGTH + IV_LENGTH,
      SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
    );
    const encrypted = encryptedData.subarray(
      SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
    );

    const key = this.getKeyForFile(encryptPath, info);

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch (error) {
      throw new Error(`Decryption failed: ${error}. The file may be corrupted or encrypted with a different key.`);
    }
  }

  /**
   * Safely attempt to decrypt and get token with fallback options
   */
  public safeGetToken(fallbackApiKey?: string): string | null {
    try {
      const decryptedContent = this.decryptFile(".ethery/info.json");
      const token = JSON.parse(decryptedContent);
      console.log("Token loaded successfully from encrypted file");
      return token;
    } catch (error) {
      console.warn("Failed to decrypt token file:", error);

      if (fallbackApiKey) {
        console.log("Using fallback API key");
        return fallbackApiKey;
      }

      console.warn("No fallback API key available");
      return null;
    }
  }

  /**
   * Check if the encrypted token file exists and is readable
   */
  public isTokenFileAvailable(): boolean {
    try {
      return fs.existsSync(this.infoPath) && fs.existsSync(".ethery/info.json");
    } catch {
      return false;
    }
  }

  /**
   * Get diagnostic information about the token file
   */
  public getTokenFileDiagnostics(): {
    infoFileExists: boolean;
    infoFileReadable: boolean;
    encryptedFileExists: boolean;
    encryptedFileSize: number;
    error?: string;
  } {
    const diagnostics = {
      infoFileExists: false,
      infoFileReadable: false,
      encryptedFileExists: false,
      encryptedFileSize: 0,
      error: undefined as string | undefined,
    };

    try {
      diagnostics.infoFileExists = fs.existsSync(this.infoPath);

      if (diagnostics.infoFileExists) {
        try {
          const info = JSON.parse(fs.readFileSync(this.infoPath, "utf8"));
          diagnostics.infoFileReadable = true;

          const encryptPath = Object.keys(info)[0];
          if (encryptPath) {
            diagnostics.encryptedFileExists = fs.existsSync(encryptPath);
            if (diagnostics.encryptedFileExists) {
              const stats = fs.statSync(encryptPath);
              diagnostics.encryptedFileSize = stats.size;
            }
          }
        } catch (error) {
          diagnostics.error = `Failed to read info file: ${error}`;
        }
      }
    } catch (error) {
      diagnostics.error = `Diagnostic check failed: ${error}`;
    }

    return diagnostics;
  }
}
