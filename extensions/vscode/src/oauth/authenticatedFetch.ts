import { cookieManager } from "./cookieManager";

/**
 * Custom fetch function that automatically includes authentication cookies
 */
export async function authenticatedFetch(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    // Get authentication cookies
    const cookieHeaders = await cookieManager.getCookieHeaders();
    
    // Merge headers with existing ones
    const headers = {
      ...init?.headers,
      ...cookieHeaders,
    };

    // Create new request init with authentication headers
    const authenticatedInit: RequestInit = {
      ...init,
      headers,
    };

    console.log(`Making authenticated request to: ${url}`);
    if (Object.keys(cookieHeaders).length > 0) {
      console.log("Including authentication cookies in request");
    } else {
      console.log("No authentication cookies available");
    }

    // Make the request with authentication
    return fetch(url, authenticatedInit);
  } catch (error) {
    console.error("Error in authenticated fetch:", error);
    // Fallback to regular fetch if authentication fails
    return fetch(url, init);
  }
}

/**
 * Check if authentication cookies are available
 */
export async function hasAuthenticationCookies(): Promise<boolean> {
  return await cookieManager.hasCookies();
}

/**
 * Load authentication cookies (useful for initialization)
 */
export async function loadAuthenticationCookies(): Promise<string | null> {
  return await cookieManager.getCookies();
}

/**
 * Clear authentication cookies
 */
export async function clearAuthenticationCookies(): Promise<void> {
  await cookieManager.clearCookies();
}
