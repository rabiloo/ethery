import * as http from "http";
import * as url from "url";
import * as vscode from "vscode";
import {
  OAuth2ProxyConfig,
  OAuth2ProxyConfigUtils,
  OAuth2ProxyError,
  OAuth2ProxyErrorType,
  OAuth2ProxySession,
} from "./oauth2ProxyConfig";
import { OAuth2ProxyHttpClient } from "./oauth2ProxyHttpClient";
import { OAuth2ProxySessionStorage } from "./oauth2ProxySessionStorage";

// Maintain backward compatibility with existing interfaces
export interface OAuthConfig {
  proxyUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
  oauth2Proxy?: Partial<OAuth2ProxyConfig>;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
  groups?: string[];
  roles?: string[];
}

export interface AuthState {
  isAuthenticated: boolean;
  user?: UserInfo;
  sessionExpiresAt?: Date;
}

/**
 * OAuth2-Proxy service with callback server implementation
 */
export class OAuth2ProxyService {
  private config: OAuth2ProxyConfig;
  private httpClient: OAuth2ProxyHttpClient;
  private sessionStorage: OAuth2ProxySessionStorage;
  private currentUser: UserInfo | undefined;
  private authStateChangeEmitter = new vscode.EventEmitter<AuthState>();
  private callbackServer: http.Server | null = null;

  public readonly onAuthStateChanged = this.authStateChangeEmitter.event;

  constructor(context: vscode.ExtensionContext, config: OAuthConfig) {
    // Convert legacy config to OAuth2ProxyConfig
    this.config = this.convertLegacyConfig(config);

    // Only validate proxyUrl as required
    if (!this.config.proxyUrl) {
      throw new OAuth2ProxyError(
        `OAuth2-Proxy configuration is incomplete: proxyUrl is required`,
        OAuth2ProxyErrorType.INVALID_CONFIGURATION,
      );
    }

    this.httpClient = new OAuth2ProxyHttpClient(this.config);
    this.sessionStorage = new OAuth2ProxySessionStorage(context, this.config);
  }

  /**
   * Convert legacy OAuthConfig to OAuth2ProxyConfig
   */
  private convertLegacyConfig(legacyConfig: OAuthConfig): OAuth2ProxyConfig {
    const baseConfig: Partial<OAuth2ProxyConfig> = {
      proxyUrl: legacyConfig.proxyUrl || "http://localhost:4180",
      callbackPort: legacyConfig.callbackPort || 8080,
    };

    // Merge with OAuth2-Proxy specific config if provided
    if (legacyConfig.oauth2Proxy) {
      Object.assign(baseConfig, legacyConfig.oauth2Proxy);
    }

    return OAuth2ProxyConfigUtils.mergeWithDefaults(baseConfig);
  }

  /**
   * Start the OAuth authorization flow with callback server
   */
  public async startAuthFlow(): Promise<boolean> {
    try {
      // Check if oauth2-proxy is available
      const isAvailable = await this.httpClient.ping();
      if (!isAvailable) {
        throw new OAuth2ProxyError(
          "OAuth2-Proxy is not available. Please check your configuration.",
          OAuth2ProxyErrorType.PROXY_UNAVAILABLE,
        );
      }

      // Start callback server
      await this.startCallbackServer();

      // Get authentication URL from oauth2-proxy
      const authUrl = this.httpClient.getAuthStartUrl();

      // Show message to user
      vscode.window
        .showInformationMessage(
          "Opening browser for OAuth2-Proxy authentication...",
          "Cancel",
        )
        .then((selection) => {
          if (selection === "Cancel") {
            this.stopCallbackServer();
          }
        });

      // Open browser for authentication
      await vscode.env.openExternal(vscode.Uri.parse(authUrl));

      return true;
    } catch (error) {
      this.stopCallbackServer();
      const errorMessage =
        error instanceof OAuth2ProxyError
          ? error.message
          : `Failed to start OAuth flow: ${error}`;
      vscode.window.showErrorMessage(errorMessage);
      return false;
    }
  }

  /**
   * Start HTTP callback server to receive OAuth2-Proxy redirect
   */
  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Stop existing server if running
      this.stopCallbackServer();

      this.callbackServer = http.createServer((req, res) => {
        this.handleCallbackRequest(req, res);
      });

      this.callbackServer.on("error", (error: any) => {
        if (error.code === "EADDRINUSE") {
          reject(
            new OAuth2ProxyError(
              `Callback server port ${this.config.callbackPort} is already in use`,
              OAuth2ProxyErrorType.CALLBACK_SERVER_ERROR,
            ),
          );
        } else {
          reject(
            new OAuth2ProxyError(
              `Failed to start callback server: ${error.message}`,
              OAuth2ProxyErrorType.CALLBACK_SERVER_ERROR,
            ),
          );
        }
      });

      this.callbackServer.listen(this.config.callbackPort, "localhost", () => {
        if (this.config.advanced.debug) {
          console.log(
            `[OAuth2ProxyService] Callback server started on port ${this.config.callbackPort}`,
          );
        }
        resolve();
      });

      // Auto-close server after 5 minutes to prevent hanging
      setTimeout(
        () => {
          if (this.callbackServer) {
            this.stopCallbackServer();
            vscode.window.showWarningMessage(
              "Authentication timeout. Please try again.",
            );
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  /**
   * Handle incoming callback request from OAuth2-Proxy
   */
  private async handleCallbackRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const parsedUrl = url.parse(req.url || "", true);

      if (parsedUrl.pathname === "/callback") {
        // Extract OAuth2-Proxy cookie from request headers
        const cookieValue = OAuth2ProxyHttpClient.extractCookieFromHeaders(
          req.headers as Record<string, string | string[]>,
          this.config.session.cookieName,
        );

        if (cookieValue) {
          // Validate the cookie by getting user info
          try {
            const userInfo = await this.httpClient.getUserInfo(cookieValue);

            // Create and store session
            const session: OAuth2ProxySession = {
              cookieValue: cookieValue,
              expiresAt: new Date(
                Date.now() + this.config.session.timeout * 1000,
              ),
              user: this.mapUserInfo(userInfo),
            };

            await this.sessionStorage.storeSession(session);
            this.currentUser = session.user;

            // Redirect to VS Code extension with cookie parameter
            const extensionUrl = `vscode://extension/Rabiloo.ethery/?&cookie=${encodeURIComponent(cookieValue)}`;

            res.writeHead(302, {
              Location: extensionUrl,
              "Content-Type": "text/html",
            });
            res.end(`
                            <html>
                                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                                    <h2>✅ Authentication Successful!</h2>
                                    <p>Redirecting to VS Code...</p>
                                    <p>If the redirect doesn't work, you can close this window and return to VS Code.</p>
                                    <script>
                                        // Fallback redirect after 2 seconds
                                        setTimeout(() => {
                                            window.location.href = '${extensionUrl}';
                                        }, 2000);
                                    </script>
                                </body>
                            </html>
                        `);

            // Emit auth state change
            this.emitAuthStateChange();

            // Show success message
            vscode.window.showInformationMessage(
              `Successfully authenticated as ${session.user?.name || "User"}!`,
            );
          } catch (error) {
            // Cookie validation failed
            res.writeHead(401, { "Content-Type": "text/html" });
            res.end(`
                            <html>
                                <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                                    <h2>❌ Authentication Failed</h2>
                                    <p>Failed to validate authentication with OAuth2-Proxy.</p>
                                    <p>Please try again.</p>
                                </body>
                            </html>
                        `);

            vscode.window.showErrorMessage(
              "Authentication validation failed. Please try again.",
            );
          }
        } else {
          // No cookie found
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
                        <html>
                            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                                <h2>❌ Authentication Failed</h2>
                                <p>No authentication cookie received from OAuth2-Proxy.</p>
                                <p>Please ensure OAuth2-Proxy is configured correctly.</p>
                            </body>
                        </html>
                    `);

          vscode.window.showErrorMessage(
            "No authentication cookie received. Please check OAuth2-Proxy configuration.",
          );
        }
      } else {
        // Invalid callback path
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }

      // Stop callback server after handling request
      setTimeout(() => this.stopCallbackServer(), 1000);
    } catch (error) {
      console.error("Error handling callback request:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");

      vscode.window.showErrorMessage(
        "Authentication callback failed. Please try again.",
      );
      this.stopCallbackServer();
    }
  }

  /**
   * Stop the callback server
   */
  private stopCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;

      if (this.config.advanced.debug) {
        console.log("[OAuth2ProxyService] Callback server stopped");
      }
    }
  }

  /**
   * Map oauth2-proxy user info to our UserInfo interface
   */
  private mapUserInfo(proxyUserInfo: any): UserInfo {
    return {
      id:
        proxyUserInfo.sub ||
        proxyUserInfo.id ||
        proxyUserInfo.user ||
        "unknown",
      email: proxyUserInfo.email || "unknown@oauth2-proxy.local",
      name:
        proxyUserInfo.name ||
        proxyUserInfo.preferred_username ||
        proxyUserInfo.user ||
        "OAuth2-Proxy User",
      picture: proxyUserInfo.picture,
      groups: proxyUserInfo.groups,
      roles: proxyUserInfo.roles,
    };
  }

  /**
   * Get current authentication state
   */
  public async getAuthState(): Promise<AuthState> {
    try {
      const session = await this.sessionStorage.getSession();
      const isExpired = session
        ? this.sessionStorage.isSessionExpired(session)
        : true;

      return {
        isAuthenticated: !!session && !isExpired,
        user: this.currentUser || session?.user,
        sessionExpiresAt: session?.expiresAt,
      };
    } catch (error) {
      console.error("Failed to get auth state:", error);
      return {
        isAuthenticated: false,
      };
    }
  }

  /**
   * Get valid access token (returns cookie value for backward compatibility)
   */
  public async getValidAccessToken(): Promise<string | null> {
    try {
      const cookieValue = await this.sessionStorage.getSessionCookie();
      if (!cookieValue) {
        return null;
      }

      // Validate the cookie is still valid
      const isValid = await this.httpClient.validateSession(cookieValue);
      return isValid ? cookieValue : null;
    } catch (error) {
      console.error("Failed to get valid access token:", error);
      return null;
    }
  }

  /**
   * Refresh session/token (OAuth2-Proxy handles refresh automatically)
   */
  public async refreshToken(): Promise<boolean> {
    try {
      const cookieValue = await this.sessionStorage.getSessionCookie();
      if (!cookieValue) {
        return false;
      }

      // Try to validate current session - OAuth2-Proxy handles refresh internally
      const isValid = await this.httpClient.validateSession(cookieValue);
      if (isValid) {
        // Update session expiration
        const newExpirationTime = new Date(
          Date.now() + this.config.session.timeout * 1000,
        );
        await this.sessionStorage.updateSessionExpiration(newExpirationTime);

        this.emitAuthStateChange();
        return true;
      }

      return false;
    } catch (error) {
      if (this.config.advanced.debug) {
        console.error("Token refresh failed:", error);
      }
      return false;
    }
  }

  /**
   * Sign out user
   */
  public async signOut(): Promise<void> {
    try {
      const cookieValue = await this.sessionStorage.getSessionCookie();

      // Sign out from oauth2-proxy if we have a session
      if (cookieValue) {
        try {
          await this.httpClient.signOut(cookieValue);
        } catch (error) {
          // Continue with local cleanup even if remote signout fails
          if (this.config.advanced.debug) {
            console.error("Remote signout failed:", error);
          }
        }
      }

      // Clear local session
      await this.sessionStorage.clearSession();
      this.currentUser = undefined;

      // Stop callback server if running
      this.stopCallbackServer();

      this.emitAuthStateChange();
      vscode.window.showInformationMessage("Successfully signed out");
    } catch (error) {
      console.error("Signout failed:", error);
      vscode.window.showErrorMessage("Failed to sign out completely");
    }
  }

  /**
   * Initialize service and check existing authentication
   */
  public async initialize(): Promise<void> {
    try {
      // Check if we have a stored session
      const session = await this.sessionStorage.getSession();
      if (session && !this.sessionStorage.isSessionExpired(session)) {
        // Validate session with oauth2-proxy
        try {
          const isValid = await this.httpClient.validateSession(
            session.cookieValue,
          );
          if (isValid) {
            // Fetch fresh user info
            const userInfo = await this.httpClient.getUserInfo(
              session.cookieValue,
            );
            if (userInfo) {
              this.currentUser = this.mapUserInfo(userInfo);
            } else {
              this.currentUser = session.user;
            }
          } else {
            // Session is invalid, clear it
            await this.sessionStorage.clearSession();
            this.currentUser = undefined;
          }
        } catch (error) {
          // If validation fails, assume session is invalid
          await this.sessionStorage.clearSession();
          this.currentUser = undefined;
        }
      }

      this.emitAuthStateChange();
    } catch (error) {
      console.error("Failed to initialize OAuth2ProxyService:", error);
    }
  }

  /**
   * Emit authentication state change event
   */
  private async emitAuthStateChange(): Promise<void> {
    const authState = await this.getAuthState();
    this.authStateChangeEmitter.fire(authState);
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopCallbackServer();
    this.authStateChangeEmitter.dispose();
  }

  /**
   * Get oauth2-proxy configuration
   */
  public getConfig(): OAuth2ProxyConfig {
    return { ...this.config };
  }

  /**
   * Update oauth2-proxy configuration
   */
  public updateConfig(newConfig: Partial<OAuth2ProxyConfig>): void {
    this.config = OAuth2ProxyConfigUtils.mergeWithDefaults({
      ...this.config,
      ...newConfig,
    });

    this.httpClient.updateConfig(this.config);
    this.sessionStorage.updateConfig(this.config);
  }

  /**
   * Check if oauth2-proxy is available
   */
  public async isProxyAvailable(): Promise<boolean> {
    return await this.httpClient.ping();
  }

  /**
   * Validate current session
   */
  public async validateSession(): Promise<boolean> {
    try {
      const cookieValue = await this.sessionStorage.getSessionCookie();
      if (!cookieValue) {
        return false;
      }

      return await this.httpClient.validateSession(cookieValue);
    } catch (error) {
      console.error("Session validation failed:", error);
      return false;
    }
  }

  /**
   * Handle cookie parameter from VS Code extension URL
   */
  public async handleCookieFromUrl(cookieValue: string): Promise<boolean> {
    try {
      if (!cookieValue) {
        console.error("No cookie value provided");
        return false;
      }

      // Validate the cookie by getting user info
      const userInfo = await this.httpClient.getUserInfo(cookieValue);

      // Create and store session
      const session: OAuth2ProxySession = {
        cookieValue: cookieValue,
        expiresAt: new Date(Date.now() + this.config.session.timeout * 1000),
        user: this.mapUserInfo(userInfo),
      };

      await this.sessionStorage.storeSession(session);
      this.currentUser = session.user;

      // Emit auth state change
      this.emitAuthStateChange();

      if (this.config.advanced.debug) {
        console.log(
          "[OAuth2ProxyService] Cookie from URL processed successfully:",
          {
            userId: session.user?.id,
            userEmail: session.user?.email,
          },
        );
      }

      return true;
    } catch (error) {
      console.error("Failed to handle cookie from URL:", error);
      return false;
    }
  }
}
