import {
  AuthType,
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
  window,
} from "vscode";

// OAuth2-Proxy integration imports
import { OAuth2ProxyService } from "../oauth/oauth2ProxyService";

import { UriEventHandler } from "./uriHandler";

const AUTH_NAME = "Ethery";

const controlPlaneEnv = getControlPlaneEnvSync(true ? "production" : "none");

interface EtheryRAuthenticationSession extends AuthenticationSession {
  cookie?: string;
  expiresInMs: number;
  loginNeeded: boolean;
}

export class RAuthProvider implements AuthenticationProvider, Disposable {
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
      proxyUrl: "http://localhost", // Default OAuth2-Proxy URL
      callbackPort: 80,
      oauth2Proxy: {
        proxyUrl: "http://localhost",
        callbackPort: 80,
        session: {
          type: "cookie" as const,
          cookieName: "_oauth2_proxy",
          timeout: 3600,
        },
      },
    };

    this.oauth2ProxyService = new OAuth2ProxyService(context, oauthConfig);

    void this.refreshSessions();

    this._refreshInterval = setInterval(() => {
      void this.refreshSessions();
    }, RAuthProvider.REFRESH_INTERVAL_MS);
  }

  // JWT methods removed - OAuth2ProxyService handles token management

  // storeSessions method removed - OAuth2ProxyService handles session storage

  public async getSessions(
    scopes?: string[],
  ): Promise<EtheryRAuthenticationSession[]> {
    try {
      // Get OAuth2-Proxy session and convert to VS Code session format
      const authState = await this.oauth2ProxyService.getAuthState();

      if (!authState.isAuthenticated || !authState.user) {
        return [];
      }

      // Get the cookie value for backward compatibility
      const cookieValue = await this.oauth2ProxyService.getValidAccessToken();

      const session: EtheryRAuthenticationSession = {
        id: uuidv4(),
        accessToken: cookieValue || "", // Use cookie as access token for backward compatibility
        cookie: cookieValue || undefined,
        expiresInMs: authState.sessionExpiresAt
          ? authState.sessionExpiresAt.getTime() - Date.now()
          : RAuthProvider.EXPIRATION_TIME_MS,
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

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  get ideRedirectUri() {
    return "http://localhost";
  }

  public static useOnboardingUri: boolean = false;
  get redirectUri() {
    if (RAuthProvider.useOnboardingUri) {
      return `http://localhost`;
    }
    return this.ideRedirectUri;
  }

  async refreshSessions() {
    try {
      await this._refreshSessions();
    } catch (e) {
      console.error(`Error refreshing sessions: ${e}`);
    }
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

  // _refreshSession method removed - OAuth2ProxyService handles token refresh

  // _formatProfileLabel method removed - OAuth2ProxyService handles user info formatting

  public async createSession(
    scopes: string[],
  ): Promise<EtheryRAuthenticationSession> {
    try {
      if (!isHubEnv(controlPlaneEnv)) {
        throw new Error("Login is disabled");
      }

      // Use OAuth2ProxyService for authentication
      const success = await this.oauth2ProxyService.startAuthFlow();
      if (!success) {
        throw new Error("OAuth2-Proxy authentication failed");
      }

      // Wait for authentication to complete and get the auth state
      const authState = await this.oauth2ProxyService.getAuthState();
      if (!authState.isAuthenticated || !authState.user) {
        throw new Error("Authentication was not successful");
      }

      // Get the cookie value for backward compatibility
      const cookieValue = await this.oauth2ProxyService.getValidAccessToken();

      const session: EtheryRAuthenticationSession = {
        id: uuidv4(),
        accessToken: cookieValue || "",
        cookie: cookieValue || undefined,
        expiresInMs: authState.sessionExpiresAt
          ? authState.sessionExpiresAt.getTime() - Date.now()
          : RAuthProvider.EXPIRATION_TIME_MS,
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
      void window.showErrorMessage(`Sign in failed: ${e}`);
      throw e;
    }
  }

  public async removeSession(sessionId: string): Promise<void> {
    try {
      // Get current session for event firing
      const sessions = await this.getSessions();
      const session = sessions.find((s) => s.id === sessionId);

      console.log("Remove Session: ", sessionId);

      // Sign out from OAuth2ProxyService
      await this.oauth2ProxyService.signOut();

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

  public async dispose() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }

    // Dispose of OAuth2ProxyService
    this.oauth2ProxyService.dispose();

    this._disposable.dispose();
  }

  // Legacy authentication methods removed - OAuth2ProxyService handles authentication flow
}

export async function getControlPlaneSessionInfo(
  silent: boolean,
  useOnboarding: boolean,
): Promise<ControlPlaneSessionInfo | undefined> {
  if (!isHubEnv(controlPlaneEnv)) {
    return {
      AUTH_TYPE: AuthType.OnPrem,
    };
  }

  try {
    if (useOnboarding) {
      RAuthProvider.useOnboardingUri = true;
    }

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
  } finally {
    RAuthProvider.useOnboardingUri = false;
  }
}
