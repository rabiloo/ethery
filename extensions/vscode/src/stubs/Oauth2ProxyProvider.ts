import {
  ControlPlaneSessionInfo,
  isHubEnv,
} from "core/control-plane/AuthTypes";
import { getControlPlaneEnvSync } from "core/control-plane/env";
import { v4 as uuidv4 } from "uuid";
import {
  authentication,
  AuthenticationProvider,
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationSession,
  Disposable,
  EventEmitter,
  ExtensionContext,
  Uri,
  window,
} from "vscode";

// OAuth2-Proxy integration imports
import { cookieManager } from "../oauth/cookieManager";
import { OAuth2ProxyService } from "../oauth/oauth2ProxyService";

import { UriEventHandler } from "./uriHandler";

const AUTH_NAME = "Ethery OAuth2-Proxy";

const controlPlaneEnv = getControlPlaneEnvSync(true ? "production" : "none");

interface EtheryOAuth2ProxyAuthenticationSession extends AuthenticationSession {
  cookie?: string;
  expiresInMs: number;
  loginNeeded: boolean;
}

export class Oauth2ProxyProvider implements AuthenticationProvider, Disposable {
  private _sessionChangeEmitter =
    new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: Disposable;
  private _refreshInterval: NodeJS.Timeout | null = null;

  private static EXPIRATION_TIME_MS = 1000 * 60 * 15; // 15 minutes
  private static REFRESH_INTERVAL_MS = 1000 * 60 * 10; // 10 minutes

  private oauth2ProxyService: OAuth2ProxyService;

  constructor(
    private readonly context: ExtensionContext,
    private readonly _uriHandler: UriEventHandler,
  ) {
    this._disposable = Disposable.from(
      authentication.registerAuthenticationProvider(
        controlPlaneEnv.AUTH_TYPE,
        AUTH_NAME,
        this,
        { supportsMultipleAccounts: false },
      ),
      window.registerUriHandler(this._uriHandler),
    );

    // Initialize OAuth2ProxyService with configuration
    const oauthConfig = {
      proxyUrl: "http://localhost:4180", // Default OAuth2-Proxy URL
      callbackPort: 8080,
      oauth2Proxy: {
        proxyUrl: "http://localhost:4180",
        callbackPort: 8080,
        session: {
          type: "cookie" as const,
          cookieName: "_oauth2_proxy",
          timeout: 3600,
        },
      },
    };

    this.oauth2ProxyService = new OAuth2ProxyService(context, oauthConfig);

    // Initialize cookie manager
    cookieManager.initialize(context);

    // Initialize the service
    void this.oauth2ProxyService.initialize();

    // Set up session refresh
    void this.refreshSessions();

    this._refreshInterval = setInterval(() => {
      void this.refreshSessions();
    }, Oauth2ProxyProvider.REFRESH_INTERVAL_MS);

    // Listen to OAuth2ProxyService auth state changes
    this.oauth2ProxyService.onAuthStateChanged((authState) => {
      // Convert auth state change to VSCode session change event
      this.handleAuthStateChange(authState);
    });

    // Listen for URI events (callback from browser)
    this._uriHandler.event((uri) => {
      this.handleUriCallback(uri);
    });
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  /**
   * Handle auth state changes from OAuth2ProxyService
   */
  private async handleAuthStateChange(authState: any): Promise<void> {
    try {
      const sessions = await this.getSessions();

      if (authState.isAuthenticated && sessions.length > 0) {
        // User authenticated - fire changed event
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [],
          changed: sessions,
        });
      } else if (!authState.isAuthenticated && sessions.length === 0) {
        // User signed out - sessions already cleared
        // No need to fire event as removeSession already handles this
      }
    } catch (error) {
      console.error("Error handling auth state change:", error);
    }
  }

  /**
   * Wait for authentication to complete by listening for auth state changes
   */
  private async waitForAuthentication(
    timeoutMs: number = 5 * 60 * 1000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        disposable.dispose();
        reject(new Error("Authentication timeout. Please try again."));
      }, timeoutMs);

      // Listen for auth state changes
      const disposable = this.oauth2ProxyService.onAuthStateChanged(
        (authState) => {
          if (authState.isAuthenticated && authState.user) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(authState);
          }
        },
      );

      // Check if already authenticated (in case auth completed before we started listening)
      this.oauth2ProxyService
        .getAuthState()
        .then((currentState) => {
          if (currentState.isAuthenticated && currentState.user) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(currentState);
          }
        })
        .catch((error) => {
          console.warn("Error checking current auth state:", error);
          // Continue waiting for auth state change event
        });
    });
  }

  /**
   * Handle URI callback from browser after OAuth authentication
   */
  private async handleUriCallback(uri: Uri): Promise<void> {
    try {
      // Parse query parameters from the URI
      const query = new URLSearchParams(uri.query);
      const cookieValue = query.get("cookie");

      if (cookieValue) {
        // Handle the cookie from the callback URL
        const success =
          await this.oauth2ProxyService.handleCookieFromUrl(cookieValue);
        if (success) {
          console.log(
            "OAuth2-Proxy authentication completed successfully via URI callback",
          );
        } else {
          console.error(
            "Failed to process OAuth2-Proxy cookie from URI callback",
          );
        }
      }
    } catch (error) {
      console.error("Error handling URI callback:", error);
    }
  }

  /**
   * Get current authentication sessions
   */
  public async getSessions(
    scopes?: string[],
  ): Promise<EtheryOAuth2ProxyAuthenticationSession[]> {
    try {
      // Get OAuth2-Proxy session and convert to VS Code session format
      const authState = await this.oauth2ProxyService.getAuthState();

      if (!authState.isAuthenticated || !authState.user) {
        return [];
      }

      // Get the cookie value for backward compatibility
      const cookieValue = await this.oauth2ProxyService.getValidAccessToken();

      const session: EtheryOAuth2ProxyAuthenticationSession = {
        id: uuidv4(),
        accessToken: cookieValue || "", // Use cookie as access token for backward compatibility
        cookie: cookieValue || undefined,
        expiresInMs: authState.sessionExpiresAt
          ? authState.sessionExpiresAt.getTime() - Date.now()
          : Oauth2ProxyProvider.EXPIRATION_TIME_MS,
        loginNeeded: false,
        account: {
          label: authState.user.name || authState.user.email,
          id: authState.user.email || authState.user.id,
        },
        scopes: scopes || [],
      };

      return [session];
    } catch (e: any) {
      console.warn(`Error getting OAuth2-Proxy sessions: ${e}`);
      return [];
    }
  }

  /**
   * Refresh existing sessions
   */
  public async refreshSessions(): Promise<void> {
    await this._refreshSessions();
  }

  private async _refreshSessions(): Promise<void> {
    try {
      // OAuth2ProxyService handles session refresh internally
      const refreshed = await this.oauth2ProxyService.refreshToken();

      if (refreshed) {
        // Get updated sessions after refresh
        const sessions = await this.getSessions();
        console.log(
          "Sessions refreshed via OAuth2ProxyService:",
          sessions.length,
        );

        this._sessionChangeEmitter.fire({
          added: [],
          removed: [],
          changed: sessions,
        });
      } else {
        // If refresh failed, check if we still have valid sessions
        const sessions = await this.getSessions();
        if (sessions.length === 0) {
          console.log("No valid sessions after refresh attempt");
        }
      }
    } catch (error) {
      console.error("Error refreshing OAuth2-Proxy sessions:", error);
    }
  }

  /**
   * Create a new authentication session
   */
  public async createSession(
    scopes: string[],
  ): Promise<EtheryOAuth2ProxyAuthenticationSession> {
    try {
      if (!isHubEnv(controlPlaneEnv)) {
        throw new Error("Login is disabled");
      }

      // Use OAuth2ProxyService for authentication
      const success = await this.oauth2ProxyService.startAuthFlow();
      if (!success) {
        throw new Error("OAuth2-Proxy authentication failed");
      }

      // Wait for authentication to complete by listening for auth state changes
      const authState = await this.waitForAuthentication();
      if (!authState.isAuthenticated || !authState.user) {
        throw new Error("Authentication was not successful");
      }

      // Get the cookie value for backward compatibility
      const cookieValue = await this.oauth2ProxyService.getValidAccessToken();

      // Save cookies to file for OpenAI provider integration
      if (cookieValue) {
        try {
          await cookieManager.saveCookies(cookieValue);
        } catch (error) {
          console.error("Failed to save cookies to file:", error);
        }
      }

      const session: EtheryOAuth2ProxyAuthenticationSession = {
        id: uuidv4(),
        accessToken: cookieValue || "",
        cookie: cookieValue || undefined,
        expiresInMs: authState.sessionExpiresAt
          ? authState.sessionExpiresAt.getTime() - Date.now()
          : Oauth2ProxyProvider.EXPIRATION_TIME_MS,
        loginNeeded: false,
        account: {
          label: authState.user.name || authState.user.email,
          id: authState.user.email || authState.user.id,
        },
        scopes: scopes || [],
      };

      console.log("OAuth2-Proxy session created:", {
        userId: session.account.id,
        userLabel: session.account.label,
      });

      this._sessionChangeEmitter.fire({
        added: [session],
        removed: [],
        changed: [],
      });

      return session;
    } catch (e) {
      window.showErrorMessage(`OAuth2-Proxy sign in failed: ${e}`);
      throw e;
    }
  }

  /**
   * Remove an existing session
   */
  public async removeSession(sessionId: string): Promise<void> {
    try {
      // Get current session for event firing
      const sessions = await this.getSessions();
      const session = sessions.find((s) => s.id === sessionId);

      console.log("Remove Session: ", sessionId);

      // Sign out from OAuth2ProxyService
      await this.oauth2ProxyService.signOut();

      // Clear cookies from file
      try {
        await cookieManager.clearCookies();
      } catch (error) {
        console.error("Failed to clear cookies from file:", error);
      }

      if (session) {
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
      }
    } catch (error) {
      console.error("Error removing session:", error);
      // Still fire the event to update UI
      const sessions = await this.getSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
      }
    }
  }

  /**
   * Dispose the registered services
   */
  public async dispose() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    this._disposable.dispose();
  }
}

/**
 * Get control plane session info using OAuth2ProxyProvider
 */
export async function getControlPlaneSessionInfo(
  silent: boolean = false,
  useOnboarding: boolean = false,
): Promise<ControlPlaneSessionInfo | undefined> {
  if (!isHubEnv(controlPlaneEnv)) {
    return {
      AUTH_TYPE: controlPlaneEnv.AUTH_TYPE,
    };
  }

  try {
    const session = await authentication.getSession(
      controlPlaneEnv.AUTH_TYPE,
      [],
      silent ? { silent: true } : { createIfNone: true },
    );
    if (!session) {
      return undefined;
    }

    // The session now comes from OAuth2ProxyService integration
    // The accessToken field contains the OAuth2-Proxy cookie value
    return {
      AUTH_TYPE: controlPlaneEnv.AUTH_TYPE,
      accessToken: session.accessToken,
      account: {
        id: session.account.id,
        label: session.account.label,
      },
    };
  } catch (error) {
    console.error("Error getting control plane session info:", error);
    return undefined;
  }
}
