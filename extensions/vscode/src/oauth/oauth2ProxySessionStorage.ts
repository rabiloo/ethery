import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  OAuth2ProxyConfig,
  OAuth2ProxyError,
  OAuth2ProxyErrorType,
  OAuth2ProxySession,
} from "./oauth2ProxyConfig";

/**
 * Session storage for oauth2-proxy cookie-based sessions
 */
export class OAuth2ProxySessionStorage {
  private static readonly SESSION_KEY = "oauth2_proxy_session";
  private static readonly SESSION_METADATA_KEY =
    "oauth2_proxy_session_metadata";
  private static readonly SESSIONS_FILE_NAME = "ethery.sessions.bin";

  private context: vscode.ExtensionContext;
  private config: OAuth2ProxyConfig;
  private encryptionKey: string;
  private sessionsFilePath: string;

  constructor(context: vscode.ExtensionContext, config: OAuth2ProxyConfig) {
    this.context = context;
    this.config = config;
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.sessionsFilePath = path.join(
      context.globalStorageUri.fsPath,
      OAuth2ProxySessionStorage.SESSIONS_FILE_NAME,
    );
    this.ensureGlobalStorageDirectory();
  }

  /**
   * Ensure the global storage directory exists
   */
  private ensureGlobalStorageDirectory(): void {
    try {
      const globalStorageDir = path.dirname(this.sessionsFilePath);
      if (!fs.existsSync(globalStorageDir)) {
        fs.mkdirSync(globalStorageDir, { recursive: true });
      }
    } catch (error) {
      console.error("Failed to create global storage directory:", error);
    }
  }

  /**
   * Get or create encryption key for additional security
   */
  private getOrCreateEncryptionKey(): string {
    const existingKey = this.context.globalState.get<string>(
      "oauth2_proxy_encryption_key",
    );
    if (existingKey) {
      return existingKey;
    }

    // Generate new encryption key
    const crypto = require("crypto");
    const newKey = crypto.randomBytes(32).toString("hex");
    this.context.globalState.update("oauth2_proxy_encryption_key", newKey);
    return newKey;
  }

  /**
   * Encrypt sensitive data
   */
  private encrypt(data: string): string {
    const crypto = require("crypto");
    const algorithm = "aes-256-cbc";
    const key = crypto.scryptSync(this.encryptionKey, "salt", 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");

    // Prepend IV to encrypted data
    return iv.toString("hex") + ":" + encrypted;
  }

  /**
   * Decrypt sensitive data
   */
  private decrypt(encryptedData: string): string {
    const crypto = require("crypto");
    const algorithm = "aes-256-cbc";
    const key = crypto.scryptSync(this.encryptionKey, "salt", 32);

    try {
      // Try new format first (IV:encrypted)
      const parts = encryptedData.split(":");
      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], "hex");
        const encrypted = parts[1];

        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encrypted, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      }
    } catch (error) {
      // If new format fails, the data might be corrupted or in old format
      console.warn(
        "Failed to decrypt with new format, clearing session data:",
        error,
      );
      throw new Error(
        "Unable to decrypt session data. Session will be cleared.",
      );
    }

    // If we get here, the format is invalid
    throw new Error("Invalid encrypted data format");
  }

  /**
   * Save cookies to ethery.sessions.bin file
   */
  public async saveCookiesToFile(cookieValue: string): Promise<void> {
    try {
      const sessionData = {
        cookieValue,
        timestamp: Date.now(),
        expiresAt: Date.now() + this.config.session.timeout * 1000,
      };

      const encryptedData = this.encrypt(JSON.stringify(sessionData));
      await fs.promises.writeFile(this.sessionsFilePath, encryptedData, "utf8");

      console.log(`Cookies saved to ${this.sessionsFilePath}`);
    } catch (error) {
      console.error("Failed to save cookies to file:", error);
      throw new OAuth2ProxyError(
        `Failed to save cookies to file: ${error}`,
        OAuth2ProxyErrorType.INVALID_CONFIGURATION,
      );
    }
  }

  /**
   * Load cookies from ethery.sessions.bin file
   */
  public async loadCookiesFromFile(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.sessionsFilePath)) {
        console.log(`Sessions file does not exist: ${this.sessionsFilePath}`);
        return null;
      }

      const encryptedData = await fs.promises.readFile(
        this.sessionsFilePath,
        "utf8",
      );
      const decryptedData = this.decrypt(encryptedData);
      const sessionData = JSON.parse(decryptedData);

      // Check if session is expired
      if (Date.now() > sessionData.expiresAt) {
        console.log("Session in file has expired, removing file");
        await this.clearCookiesFile();
        return null;
      }

      console.log(`Cookies loaded from ${this.sessionsFilePath}`);
      return sessionData.cookieValue;
    } catch (error) {
      console.error("Failed to load cookies from file:", error);
      // If file is corrupted, remove it
      await this.clearCookiesFile();
      return null;
    }
  }

  /**
   * Clear the cookies file
   */
  public async clearCookiesFile(): Promise<void> {
    try {
      if (fs.existsSync(this.sessionsFilePath)) {
        await fs.promises.unlink(this.sessionsFilePath);
        console.log(`Cleared cookies file: ${this.sessionsFilePath}`);
      }
    } catch (error) {
      console.error("Failed to clear cookies file:", error);
    }
  }

  /**
   * Store OAuth2-Proxy session securely
   */
  public async storeSession(session: OAuth2ProxySession): Promise<void> {
    try {
      // Encrypt the session cookie value
      const encryptedSession = this.encrypt(
        JSON.stringify({
          cookieValue: session.cookieValue,
          user: session.user,
        }),
      );

      // Store encrypted session in SecretStorage
      await this.context.secrets.store(
        OAuth2ProxySessionStorage.SESSION_KEY,
        encryptedSession,
      );

      // Store session metadata (non-sensitive information)
      const metadata = {
        expiresAt: session.expiresAt.toISOString(),
        storedAt: new Date().toISOString(),
        userId: session.user?.id,
        userEmail: session.user?.email,
      };

      await this.context.secrets.store(
        OAuth2ProxySessionStorage.SESSION_METADATA_KEY,
        JSON.stringify(metadata),
      );

      // Also save cookies to file for OpenAI provider integration
      if (session.cookieValue) {
        await this.saveCookiesToFile(session.cookieValue);
      }
    } catch (error) {
      throw new OAuth2ProxyError(
        `Failed to store session: ${error}`,
        OAuth2ProxyErrorType.INVALID_CONFIGURATION,
      );
    }
  }

  /**
   * Retrieve OAuth2-Proxy session
   */
  public async getSession(): Promise<OAuth2ProxySession | null> {
    try {
      const encryptedSession = await this.context.secrets.get(
        OAuth2ProxySessionStorage.SESSION_KEY,
      );
      if (!encryptedSession) {
        return null;
      }

      const metadataJson = await this.context.secrets.get(
        OAuth2ProxySessionStorage.SESSION_METADATA_KEY,
      );
      if (!metadataJson) {
        return null;
      }

      const metadata = JSON.parse(metadataJson);
      const sessionData = JSON.parse(this.decrypt(encryptedSession));

      return {
        cookieValue: sessionData.cookieValue,
        expiresAt: new Date(metadata.expiresAt),
        user: sessionData.user,
      };
    } catch (error) {
      console.error("Failed to retrieve session:", error);

      // If decryption failed, clear the corrupted session data
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes("decrypt")
      ) {
        console.log("Clearing corrupted session data");
        await this.clearSession().catch(() => {
          // Ignore errors when clearing session
        });
      }

      return null;
    }
  }

  /**
   * Get session cookie value for HTTP requests
   */
  public async getSessionCookie(): Promise<string | null> {
    const session = await this.getSession();
    if (!session || this.isSessionExpired(session)) {
      return null;
    }
    return session.cookieValue;
  }

  /**
   * Check if session exists
   */
  public async hasSession(): Promise<boolean> {
    const session = await this.context.secrets.get(
      OAuth2ProxySessionStorage.SESSION_KEY,
    );
    return !!session;
  }

  /**
   * Clear stored session
   */
  public async clearSession(): Promise<void> {
    try {
      await this.context.secrets.delete(OAuth2ProxySessionStorage.SESSION_KEY);
      await this.context.secrets.delete(
        OAuth2ProxySessionStorage.SESSION_METADATA_KEY,
      );

      // Also clear the cookies file
      await this.clearCookiesFile();
    } catch (error) {
      console.error("Failed to clear session:", error);
    }
  }

  /**
   * Check if session is expired
   */
  public isSessionExpired(session: OAuth2ProxySession): boolean {
    return Date.now() >= session.expiresAt.getTime() - 60000; // 1 minute buffer
  }

  /**
   * Check if current stored session is expired
   */
  public async isCurrentSessionExpired(): Promise<boolean> {
    const session = await this.getSession();
    if (!session) {
      return true;
    }
    return this.isSessionExpired(session);
  }

  /**
   * Get session expiration info
   */
  public async getSessionExpirationInfo(): Promise<{
    expiresAt: Date;
    isExpired: boolean;
  } | null> {
    try {
      const metadataJson = await this.context.secrets.get(
        OAuth2ProxySessionStorage.SESSION_METADATA_KEY,
      );
      if (!metadataJson) {
        return null;
      }

      const metadata = JSON.parse(metadataJson);
      const expiresAt = new Date(metadata.expiresAt);
      const isExpired = Date.now() >= expiresAt.getTime() - 60000; // 1 minute buffer

      return { expiresAt, isExpired };
    } catch (error) {
      console.error("Failed to get session expiration info:", error);
      return null;
    }
  }

  /**
   * Update session expiration time
   */
  public async updateSessionExpiration(newExpirationTime: Date): Promise<void> {
    const session = await this.getSession();
    if (!session) {
      return;
    }

    session.expiresAt = newExpirationTime;
    await this.storeSession(session);
  }

  /**
   * Get user information from stored session
   */
  public async getStoredUserInfo(): Promise<any | null> {
    const session = await this.getSession();
    return session?.user || null;
  }

  /**
   * Validate session integrity
   */
  public async validateSessionIntegrity(): Promise<boolean> {
    try {
      const session = await this.getSession();
      return (
        session !== null &&
        typeof session.cookieValue === "string" &&
        session.cookieValue.length > 0
      );
    } catch (error) {
      console.error("Session integrity validation failed:", error);
      return false;
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: OAuth2ProxyConfig): void {
    this.config = newConfig;
  }

  /**
   * Get current configuration
   */
  public getConfig(): OAuth2ProxyConfig {
    return { ...this.config };
  }

  /**
   * Store temporary data (for OAuth flow state management)
   */
  public async storeTemporary(key: string, value: string): Promise<void> {
    const tempKey = `temp_oauth2_proxy_${key}`;
    await this.context.globalState.update(tempKey, {
      value: this.encrypt(value),
      timestamp: Date.now(),
    });
  }

  /**
   * Get temporary data
   */
  public async getTemporary(key: string): Promise<string | null> {
    const tempKey = `temp_oauth2_proxy_${key}`;
    const data = this.context.globalState.get<{
      value: string;
      timestamp: number;
    }>(tempKey);

    if (!data) {
      return null;
    }

    // Check if data is expired (5 minutes)
    if (Date.now() - data.timestamp > 5 * 60 * 1000) {
      await this.removeTemporary(key);
      return null;
    }

    try {
      return this.decrypt(data.value);
    } catch (error) {
      console.error("Failed to decrypt temporary data:", error);
      await this.removeTemporary(key);
      return null;
    }
  }

  /**
   * Remove temporary data
   */
  public async removeTemporary(key: string): Promise<void> {
    const tempKey = `temp_oauth2_proxy_${key}`;
    await this.context.globalState.update(tempKey, undefined);
  }

  /**
   * Clean up expired temporary data
   */
  public async cleanupTemporaryData(): Promise<void> {
    const keys = this.context.globalState.keys();
    const tempKeys = keys.filter((key) => key.startsWith("temp_oauth2_proxy_"));

    for (const key of tempKeys) {
      const data = this.context.globalState.get<{
        value: string;
        timestamp: number;
      }>(key);
      if (data && Date.now() - data.timestamp > 5 * 60 * 1000) {
        await this.context.globalState.update(key, undefined);
      }
    }
  }
}
