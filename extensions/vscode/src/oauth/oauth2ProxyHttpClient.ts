import * as https from "https";
import fetch, { RequestInit, Response } from "node-fetch";
import {
  OAuth2ProxyConfig,
  OAuth2ProxyConfigUtils,
  OAuth2ProxyError,
  OAuth2ProxyErrorType,
} from "./oauth2ProxyConfig";

/**
 * HTTP client for communicating with oauth2-proxy using cookie-based authentication
 */
export class OAuth2ProxyHttpClient {
  private config: OAuth2ProxyConfig;
  private httpsAgent?: https.Agent;

  constructor(config: OAuth2ProxyConfig) {
    this.config = config;
    this.setupHttpsAgent();
  }

  /**
   * Setup HTTPS agent with custom configuration
   */
  private setupHttpsAgent(): void {
    const agentOptions: https.AgentOptions = {
      rejectUnauthorized: this.config.security.validateCertificates,
      timeout: this.config.advanced.requestTimeout,
    };

    this.httpsAgent = new https.Agent(agentOptions);
  }

  /**
   * Make HTTP request with error handling
   */
  private async makeRequest(
    url: string,
    options: RequestInit = {},
    cookieValue?: string,
  ): Promise<Response> {
    // Declare timeout variables in outer scope
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const requestOptions: RequestInit = {
        ...options,
        // Note: timeout is handled by AbortController below
        agent: url.startsWith("https:") ? this.httpsAgent : undefined,
        headers: {
          "User-Agent": "VSCode-OAuth2-Proxy-Extension/1.0.0",
          Accept: "application/json",
          ...options.headers,
        },
      };

      // Add timeout using AbortController
      const controller = new AbortController();
      timeoutId = setTimeout(
        () => controller.abort(),
        this.config.advanced.requestTimeout,
      );
      requestOptions.signal = controller.signal;

      // Include OAuth2-Proxy cookie if provided
      if (cookieValue) {
        requestOptions.headers = {
          ...requestOptions.headers,
          Cookie: `${this.config.session.cookieName}=${cookieValue}`,
        };
      }

      if (this.config.advanced.debug) {
        console.log(`[OAuth2ProxyHttpClient] Making request to: ${url}`, {
          method: requestOptions.method || "GET",
          headers: requestOptions.headers,
        });
      }

      const response = await fetch(url, requestOptions);

      // Clear the timeout since request completed
      if (timeoutId) clearTimeout(timeoutId);

      if (this.config.advanced.debug) {
        console.log(`[OAuth2ProxyHttpClient] Response:`, {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
        });
      }

      return response;
    } catch (error) {
      // Clear the timeout in case of error
      if (timeoutId) clearTimeout(timeoutId);

      if (this.config.advanced.debug) {
        console.error(`[OAuth2ProxyHttpClient] Request failed:`, error);
      }

      throw new OAuth2ProxyError(
        `Request failed: ${error}`,
        OAuth2ProxyErrorType.NETWORK_ERROR,
        undefined,
        error,
      );
    }
  }

  /**
   * Handle HTTP response and extract JSON data
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type");

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorData: any = null;

      try {
        if (contentType?.includes("application/json")) {
          errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } else {
          errorData = await response.text();
          if (errorData) {
            errorMessage = errorData;
          }
        }
      } catch {
        // Ignore JSON parsing errors for error responses
      }

      const errorType = this.getErrorTypeFromStatus(response.status);
      throw new OAuth2ProxyError(
        errorMessage,
        errorType,
        response.status,
        errorData,
      );
    }

    try {
      if (contentType?.includes("application/json")) {
        return (await response.json()) as T;
      } else {
        // Return text response as string
        return (await response.text()) as unknown as T;
      }
    } catch (error) {
      throw new OAuth2ProxyError(
        "Failed to parse response",
        OAuth2ProxyErrorType.INVALID_RESPONSE,
        response.status,
        error,
      );
    }
  }

  /**
   * Map HTTP status codes to error types
   */
  private getErrorTypeFromStatus(status: number): OAuth2ProxyErrorType {
    switch (status) {
      case 401:
        return OAuth2ProxyErrorType.AUTHENTICATION_FAILED;
      case 408:
      case 504:
        return OAuth2ProxyErrorType.TIMEOUT;
      case 502:
      case 503:
        return OAuth2ProxyErrorType.PROXY_UNAVAILABLE;
      default:
        return OAuth2ProxyErrorType.NETWORK_ERROR;
    }
  }

  /**
   * Get authentication start URL
   */
  public getAuthStartUrl(): string {
    const callbackUrl = `http://localhost:${this.config.callbackPort}/callback`;
    const startUrl = OAuth2ProxyConfigUtils.getEndpointUrl(
      this.config,
      "start",
    );
    return `${startUrl}?rd=${encodeURIComponent(callbackUrl)}`;
  }

  /**
   * Check if oauth2-proxy is available
   */
  public async ping(): Promise<boolean> {
    try {
      const pingUrl = OAuth2ProxyConfigUtils.getEndpointUrl(
        this.config,
        "ping",
      );

      if (this.config.advanced.debug) {
        console.log(
          `[OAuth2ProxyHttpClient] Pinging OAuth2-Proxy at: ${pingUrl}`,
        );
      }

      const response = await this.makeRequest(pingUrl, { method: "GET" });

      if (this.config.advanced.debug) {
        console.log(
          `[OAuth2ProxyHttpClient] Ping response status: ${response.status}`,
        );
      }

      // OAuth2-Proxy ping endpoint returns 403 when not authenticated, which is still "available"
      // We consider 200 (OK), 401 (Unauthorized), and 403 (Forbidden) as "available" responses
      return (
        response.status === 200 ||
        response.status === 401 ||
        response.status === 403
      );
    } catch (error) {
      console.error("[OAuth2ProxyHttpClient] Ping failed:", {
        url: OAuth2ProxyConfigUtils.getEndpointUrl(this.config, "ping"),
        error: error instanceof Error ? error.message : String(error),
        config: {
          proxyUrl: this.config.proxyUrl,
          endpoints: this.config.endpoints,
        },
      });
      return false;
    }
  }

  /**
   * Get user information from oauth2-proxy using cookie authentication
   */
  public async getUserInfo(cookieValue: string): Promise<any> {
    const userInfoUrl = OAuth2ProxyConfigUtils.getEndpointUrl(
      this.config,
      "userinfo",
    );
    const response = await this.makeRequest(
      userInfoUrl,
      {
        method: "GET",
      },
      cookieValue,
    );

    return this.handleResponse(response);
  }

  /**
   * Sign out from oauth2-proxy
   */
  public async signOut(
    cookieValue: string,
    redirectUri?: string,
  ): Promise<string> {
    const signOutUrl = OAuth2ProxyConfigUtils.getEndpointUrl(
      this.config,
      "signOut",
    );
    const url = new URL(signOutUrl);

    if (redirectUri) {
      url.searchParams.append("rd", redirectUri);
    }

    const response = await this.makeRequest(
      url.toString(),
      {
        method: "GET",
        redirect: "manual", // Don't follow redirects automatically
      },
      cookieValue,
    );

    // Return the redirect location or the response URL
    return response.headers.get("location") || response.url;
  }

  /**
   * Validate session with oauth2-proxy using cookie
   */
  public async validateSession(cookieValue: string): Promise<boolean> {
    try {
      await this.getUserInfo(cookieValue);
      return true;
    } catch (error) {
      if (error instanceof OAuth2ProxyError) {
        if (error.type === OAuth2ProxyErrorType.AUTHENTICATION_FAILED) {
          return false;
        }
      }
      throw error;
    }
  }

  /**
   * Extract OAuth2-Proxy cookie from request headers
   */
  public static extractCookieFromHeaders(
    headers: Record<string, string | string[]>,
    cookieName: string,
  ): string | null {
    const cookieHeader = headers["cookie"] || headers["Cookie"];
    if (!cookieHeader) {
      return null;
    }

    const cookieString = Array.isArray(cookieHeader)
      ? cookieHeader.join("; ")
      : cookieHeader;
    const cookies = cookieString.split(";");

    for (const cookie of cookies) {
      const trimmedCookie = cookie.trim();
      if (trimmedCookie.startsWith(`${cookieName}=`)) {
        return trimmedCookie.substring(cookieName.length + 1);
      }
    }

    return null;
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: OAuth2ProxyConfig): void {
    this.config = newConfig;
    this.setupHttpsAgent();
  }

  /**
   * Get current configuration
   */
  public getConfig(): OAuth2ProxyConfig {
    return { ...this.config };
  }
}
