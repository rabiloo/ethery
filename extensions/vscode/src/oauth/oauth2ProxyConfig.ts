import * as vscode from 'vscode';

/**
 * OAuth2-Proxy configuration interface
 */
export interface OAuth2ProxyConfig {
    /** Base URL of the oauth2-proxy instance (e.g., 'http://localhost:4180') */
    proxyUrl: string;

    /** Client ID (for backward compatibility) */
    clientId?: string;

    /** OAuth scopes (for backward compatibility) */
    scopes?: string[];

    /** Callback server port for receiving OAuth redirects */
    callbackPort: number;
    
    /** Session management configuration */
    session: {
        /** Session type */
        type: 'cookie' | 'jwt';

        /** Cookie name for session storage */
        cookieName: string;

        /** Session timeout in seconds */
        timeout: number;
    };
    
    /** Security configuration */
    security: {
        /** Validate SSL certificates */
        validateCertificates: boolean;
        
        /** Enable CSRF protection */
        enableCSRF: boolean;
    };
    
    /** OAuth2-Proxy endpoints configuration */
    endpoints: {
        /** Authentication start endpoint */
        start: string;
        
        /** User info endpoint */
        userinfo: string;
        
        /** Sign out endpoint */
        signOut: string;
        
        /** Health check endpoint */
        ping: string;
    };
    
    /** Advanced configuration */
    advanced: {
        /** Request timeout in milliseconds */
        requestTimeout: number;
        
        /** Enable debug logging */
        debug: boolean;
    };
}

/**
 * Default OAuth2-Proxy configuration
 */
export const DEFAULT_OAUTH2_PROXY_CONFIG: Partial<OAuth2ProxyConfig> = {
    callbackPort: 8080,
    session: {
        type: 'cookie',
        cookieName: '_oauth2_proxy',
        timeout: 3600 // 1 hour
    },
    security: {
        validateCertificates: true,
        enableCSRF: true
    },
    endpoints: {
        start: '/oauth2/start',
        userinfo: '/oauth2/userinfo',
        signOut: '/oauth2/sign_out',
        ping: '/oauth2/ping'
    },
    advanced: {
        requestTimeout: 30000, // 30 seconds
        debug: false
    }
};

/**
 * OAuth2-Proxy session information
 */
export interface OAuth2ProxySession {
    /** Session cookie value */
    cookieValue: string;

    /** Session ID (for backward compatibility) */
    sessionId?: string;

    /** Session type (for backward compatibility) */
    type?: 'cookie' | 'jwt';

    /** Session expiration time */
    expiresAt: Date;

    /** Associated user information */
    user?: {
        id: string;
        email: string;
        name: string;
        picture?: string;
        groups?: string[];
        roles?: string[];
    };
}

/**
 * OAuth2-Proxy authentication state
 */
export interface OAuth2ProxyAuthState {
    /** Whether the user is authenticated */
    isAuthenticated: boolean;
    
    /** User information */
    user?: {
        id: string;
        email: string;
        name: string;
        picture?: string;
        groups?: string[];
        roles?: string[];
    };
    
    /** Session expiration time */
    sessionExpiresAt?: Date;
    
    /** Last authentication time */
    lastAuthTime?: Date;
}

/**
 * OAuth2-Proxy error types
 */
export enum OAuth2ProxyErrorType {
    NETWORK_ERROR = 'NETWORK_ERROR',
    AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
    SESSION_EXPIRED = 'SESSION_EXPIRED',
    INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
    PROXY_UNAVAILABLE = 'PROXY_UNAVAILABLE',
    CALLBACK_SERVER_ERROR = 'CALLBACK_SERVER_ERROR',
    INVALID_RESPONSE = 'INVALID_RESPONSE',
    TIMEOUT = 'TIMEOUT'
}

/**
 * OAuth2-Proxy specific error class
 */
export class OAuth2ProxyError extends Error {
    public readonly type: OAuth2ProxyErrorType;
    public readonly statusCode?: number;
    public readonly response?: any;
    
    constructor(
        message: string,
        type: OAuth2ProxyErrorType,
        statusCode?: number,
        response?: any
    ) {
        super(message);
        this.name = 'OAuth2ProxyError';
        this.type = type;
        this.statusCode = statusCode;
        this.response = response;
    }
}

/**
 * Utility functions for OAuth2-Proxy configuration
 */
export class OAuth2ProxyConfigUtils {
    /**
     * Merge user configuration with defaults
     */
    static mergeWithDefaults(userConfig: Partial<OAuth2ProxyConfig>): OAuth2ProxyConfig {
        return {
            ...DEFAULT_OAUTH2_PROXY_CONFIG,
            ...userConfig,
            session: {
                ...DEFAULT_OAUTH2_PROXY_CONFIG.session,
                ...userConfig.session
            },
            security: {
                ...DEFAULT_OAUTH2_PROXY_CONFIG.security,
                ...userConfig.security
            },
            endpoints: {
                ...DEFAULT_OAUTH2_PROXY_CONFIG.endpoints,
                ...userConfig.endpoints
            },
            advanced: {
                ...DEFAULT_OAUTH2_PROXY_CONFIG.advanced,
                ...userConfig.advanced
            }
        } as OAuth2ProxyConfig;
    }
    
    /**
     * Validate OAuth2-Proxy configuration
     */
    static validateConfig(config: OAuth2ProxyConfig): string[] {
        const errors: string[] = [];
        
        if (!config.proxyUrl) {
            errors.push('proxyUrl is required');
        } else {
            try {
                new URL(config.proxyUrl);
            } catch {
                errors.push('proxyUrl must be a valid URL');
            }
        }
        
        if (!config.callbackPort || config.callbackPort < 1 || config.callbackPort > 65535) {
            errors.push('callbackPort must be a valid port number (1-65535)');
        }
        
        return errors;
    }
    
    /**
     * Get full endpoint URL
     */
    static getEndpointUrl(config: OAuth2ProxyConfig, endpoint: keyof OAuth2ProxyConfig['endpoints']): string {
        const baseUrl = config.proxyUrl.endsWith('/') ? config.proxyUrl.slice(0, -1) : config.proxyUrl;
        const endpointPath = config.endpoints[endpoint];
        return `${baseUrl}${endpointPath}`;
    }
}

/**
 * VS Code configuration integration
 */
export class OAuth2ProxyVSCodeConfig {
    /**
     * Get OAuth2-Proxy configuration from VS Code settings
     */
    static getFromVSCodeSettings(): Partial<OAuth2ProxyConfig> {
        const config = vscode.workspace.getConfiguration('oauth2Proxy');
        
        return {
            proxyUrl: config.get<string>('proxyUrl'),
            clientId: config.get<string>('clientId'),
            scopes: config.get<string[]>('scopes'),
            callbackPort: config.get<number>('callbackPort') || 8080,
            session: {
                type: config.get<'cookie' | 'jwt'>('session.type') || 'cookie',
                cookieName: config.get<string>('session.cookieName') || '_oauth2_proxy',
                timeout: config.get<number>('session.timeout') || 3600
            },
            security: {
                validateCertificates: config.get<boolean>('security.validateCertificates') ?? true,
                enableCSRF: config.get<boolean>('security.enableCSRF') ?? true
            },
            advanced: {
                debug: config.get<boolean>('advanced.debug') ?? false,
                requestTimeout: config.get<number>('advanced.requestTimeout') || 30000
            }
        };
    }
}
