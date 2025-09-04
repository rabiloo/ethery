import * as vscode from "vscode";
import { OAuth2ProxyConfig } from "./oauth2ProxyConfig";
import { OAuth2ProxySessionStorage } from "./oauth2ProxySessionStorage";

/**
 * Cookie manager for handling authentication cookies across the extension
 */
export class CookieManager {
  private static instance: CookieManager | null = null;
  private sessionStorage: OAuth2ProxySessionStorage | null = null;
  private cachedCookies: string | null = null;
  private lastLoadTime: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): CookieManager {
    if (!CookieManager.instance) {
      CookieManager.instance = new CookieManager();
    }
    return CookieManager.instance;
  }

  /**
   * Initialize the cookie manager with VSCode context
   */
  public initialize(context: vscode.ExtensionContext): void {
    const config: OAuth2ProxyConfig = {
      proxyUrl: "http://localhost:4180",
      callbackPort: 8080,
      session: {
        type: "cookie" as const,
        cookieName: "_oauth2_proxy",
        timeout: 3600,
      },
      security: {
        validateCertificates: true,
        enableCSRF: true,
      },
      endpoints: {
        start: "/oauth2/start",
        userinfo: "/oauth2/userinfo",
        signOut: "/oauth2/sign_out",
        ping: "/oauth2/ping",
      },
      advanced: {
        debug: false,
        requestTimeout: 30000,
      },
    };

    this.sessionStorage = new OAuth2ProxySessionStorage(context, config);
  }

  /**
   * Get authentication cookies for HTTP requests
   */
  public async getCookies(): Promise<string | null> {
    if (!this.sessionStorage) {
      console.warn("CookieManager not initialized");
      return null;
    }

    // Use cached cookies if still valid
    if (
      this.cachedCookies &&
      Date.now() - this.lastLoadTime < this.CACHE_DURATION
    ) {
      return this.cachedCookies;
    }

    try {
      // Load cookies from file
      const cookies = await this.sessionStorage.loadCookiesFromFile();

      if (cookies) {
        this.cachedCookies = cookies;
        this.lastLoadTime = Date.now();
        console.log("Cookies loaded successfully for authentication");
      } else {
        this.cachedCookies = null;
        console.log("No valid cookies found");
      }

      return this.cachedCookies;
    } catch (error) {
      console.error("Failed to load cookies:", error);
      this.cachedCookies = null;
      return null;
    }
  }

  /**
   * Save authentication cookies
   */
  public async saveCookies(cookieValue: string): Promise<void> {
    if (!this.sessionStorage) {
      console.warn("CookieManager not initialized");
      return;
    }

    try {
      await this.sessionStorage.saveCookiesToFile(cookieValue);
      this.cachedCookies = cookieValue;
      this.lastLoadTime = Date.now();
      console.log("Cookies saved successfully");
    } catch (error) {
      console.error("Failed to save cookies:", error);
      throw error;
    }
  }

  /**
   * Clear authentication cookies
   */
  public async clearCookies(): Promise<void> {
    if (!this.sessionStorage) {
      console.warn("CookieManager not initialized");
      return;
    }

    try {
      await this.sessionStorage.clearCookiesFile();
      this.cachedCookies = null;
      this.lastLoadTime = 0;
      console.log("Cookies cleared successfully");
    } catch (error) {
      console.error("Failed to clear cookies:", error);
    }
  }

  /**
   * Get cookie headers for HTTP requests
   */
  public async getCookieHeaders(): Promise<Record<string, string>> {
    const cookies = await this.getCookies();
    if (!cookies) {
      return {};
    }

    return {
      Cookie: `_oauth2_proxy=${cookies}`,
    };
  }

  /**
   * Check if cookies are available
   */
  public async hasCookies(): Promise<boolean> {
    const cookies = await this.getCookies();
    return cookies !== null;
  }

  /**
   * Invalidate cached cookies (force reload on next request)
   */
  public invalidateCache(): void {
    this.cachedCookies = null;
    this.lastLoadTime = 0;
  }

  /**
   * Create a fallback token file if the encrypted token file is missing or corrupted
   */
  public async createFallbackTokenFile(apiKey: string): Promise<void> {
    if (!this.sessionStorage) {
      console.warn("CookieManager not initialized");
      return;
    }

    try {
      const fs = require('fs');
      const path = require('path');

      // Create .ethery directory if it doesn't exist
      const etheryDir = '.ethery';
      if (!fs.existsSync(etheryDir)) {
        fs.mkdirSync(etheryDir, { recursive: true });
        console.log(`Created ${etheryDir} directory`);
      }

      // Create a simple unencrypted fallback file
      const fallbackPath = path.join(etheryDir, 'fallback_token.json');
      const tokenData = {
        apiKey: apiKey,
        createdAt: new Date().toISOString(),
        source: 'fallback'
      };

      fs.writeFileSync(fallbackPath, JSON.stringify(tokenData, null, 2));
      console.log(`Created fallback token file: ${fallbackPath}`);
    } catch (error) {
      console.error("Failed to create fallback token file:", error);
    }
  }
}

/**
 * Global cookie manager instance
 */
export const cookieManager = CookieManager.getInstance();
