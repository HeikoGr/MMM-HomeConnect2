// Vendored single-file version of home-connect-js (utils + main combined)
const EventSource = require('eventsource');
// use built-in fetch when available (Node 18+). If not present, this will throw
const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const EventEmitter = require('events');

// URLs used by the library
global.urls = {
    simulation: {
        base: 'https://simulator.home-connect.com/',
        api: 'https://apiclient.home-connect.com/hcsdk.yaml',
    },
    physical: {
        base: 'https://api.home-connect.com/',
        api: 'https://apiclient.home-connect.com/hcsdk-production.yaml',
    },
};

// --- utils ---
// Note: The interactive browser OAuth flow has been removed.
// This module expects a refresh token to be available (headless/device flow).

function getClient(accessToken) {
    // Return a simple client object that mimics the swagger-client API structure
    // but uses fetch directly for API calls
    return Promise.resolve({
        accessToken: accessToken,
        baseUrl: isSimulated ? urls.simulation.base : urls.physical.base,
        apis: {
            appliances: {
                get_home_appliances: () => makeApiRequest('GET', 'api/homeappliances', accessToken),
            },
            status: {
                get_status: (params) => makeApiRequest('GET', `api/homeappliances/${params.haId}/status`, accessToken),
            },
            settings: {
                get_settings: (params) => makeApiRequest('GET', `api/homeappliances/${params.haId}/settings`, accessToken),
            },
        },
    });
}

function makeApiRequest(method, path, accessToken, body = null) {
    if (!fetch) {
        return Promise.reject(new Error('Global fetch is not available in this Node runtime'));
    }

    const baseUrl = isSimulated ? urls.simulation.base : urls.physical.base;
    const url = baseUrl + path;
    const options = {
        method: method,
        headers: {
            'accept': 'application/vnd.bsh.sdk.v1+json',
            'authorization': 'Bearer ' + accessToken,
        },
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    return fetch(url, options)
        .then(checkResponseStatus)
        .then((res) => res.json())
        .then((json) => ({ body: json })); // Wrap in body to match swagger-client response format
}

function refreshToken(clientSecret, refreshToken) {
    return new Promise((resolve, reject) => {
        if (!fetch) {
            return reject(new Error('Global fetch is not available in this Node runtime'));
        }
        fetch((isSimulated ? urls.simulation.base : urls.physical.base) + 'security/oauth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&client_secret=' + clientSecret + '&refresh_token=' + refreshToken,
        })
            .then(checkResponseStatus)
            .then((res) => res.json())
            .then((json) =>
                resolve({
                    access_token: json.access_token,
                    refresh_token: json.refresh_token,
                    expires_in: json.expires_in,
                    timestamp: Math.floor(Date.now() / 1000),
                }),
            )
            .catch((err) => reject(err));
    });
}

// Interactive OAuth helpers removed. Use the device (headless) flow instead.

function checkResponseStatus(res) {
    if (res.ok) {
        return res;
    } else {
        // Try to get response body text for better debugging
        return res.text().then((text) => {
            const truncated = typeof text === 'string' && text.length > 1000 ? text.slice(0, 1000) + '... (truncated)' : text;
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${truncated}`);
        });
    }
}

const utils = {
    getClient,
    refreshToken,
};

// --- HomeConnect class ---
class HomeConnect extends EventEmitter {
    constructor(clientId, clientSecret, refreshToken) {
        super();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.tokens = {};
        this.tokens.refresh_token = refreshToken;
        this.eventSources = {};
        this.eventListeners = {};
        this.eventSource = null;
        this.eventListener = new Map();
        this.tokenRefreshTimeout = null;
    }

    async init(options) {
        global.isSimulated = options != undefined && 'isSimulated' in options && typeof options.isSimulated === 'boolean' ? options.isSimulated : false;

        try {
            // refresh tokens
            if (this.tokens.refresh_token) {
                this.tokens = await utils.refreshToken(this.clientSecret, this.tokens.refresh_token);
            } else {
                // The module no longer supports the interactive browser OAuth flow.
                throw new Error('No refresh token available. This module requires headless authentication (device flow).');
            }

            // schedule token refresh
            clearTimeout(this.tokenRefreshTimeout);
            const timeToNextTokenRefresh = this.tokens.timestamp + this.tokens.expires_in * 0.9 - Math.floor(Date.now() / 1000);
            this.tokenRefreshTimeout = setTimeout(() => this.refreshTokens(), timeToNextTokenRefresh * 1000);
            this.client = await utils.getClient(this.tokens.access_token);
            this.emit('newRefreshToken', this.tokens.refresh_token);
        } catch (error) {
            throw error;
        }
    }

    async command(tag, operationId, haId, body) {
        try {
            return this.client.apis[tag][operationId]({ haId, body });
        } catch (error) {
            throw error;
        }
    }

    subscribe(haid, event, callback) {
        if (this.eventSources && !(haid in this.eventSources)) {
            const url = isSimulated ? urls.simulation.base : urls.physical.base;
            const eventSource = new EventSource(url + 'api/homeappliances/' + haid + '/events', {
                headers: {
                    accept: 'text/event-stream',
                    authorization: 'Bearer ' + this.tokens.access_token,
                },
            });
            this.eventSources = { ...this.eventSources, [haid]: eventSource };
        }

        if (this.eventListeners && !(haid in this.eventListeners)) {
            const listeners = new Map();
            listeners.set(event, callback);
            this.eventListeners = { ...this.eventListeners, [haid]: listeners };
        }

        this.eventSources[haid].addEventListener(event, callback);
        this.eventListeners[haid].set(event, callback);
    }

    subscribe(event, callback) {
        if (!this.eventSource) {
            const url = isSimulated ? urls.simulation.base : urls.physical.base;
            this.eventSource = new EventSource(url + 'api/homeappliances/events', {
                headers: {
                    accept: 'text/event-stream',
                    authorization: 'Bearer ' + this.tokens.access_token,
                },
            });
        }

        this.eventSource.addEventListener(event, callback);
        this.eventListener.set(event, callback);
    }

    unsubscribe(event, callback) {
        if (this.eventSource) {
            this.eventSource.removeEventListener(event, callback);
        }
        if (this.eventListener) {
            this.eventListener.delete(event);
        }
    }

    async refreshTokens() {
        clearTimeout(this.tokenRefreshTimeout);
        let timeToNextTokenRefresh;
        try {
            this.tokens = await utils.refreshToken(this.clientSecret, this.tokens.refresh_token);
            this.emit('newRefreshToken', this.tokens.refresh_token);
            this.client = await utils.getClient(this.tokens.access_token);
            this.recreateEventSources();
            timeToNextTokenRefresh = this.tokens.timestamp + this.tokens.expires_in * 0.9 - Math.floor(Date.now() / 1000);
        } catch (error) {
            timeToNextTokenRefresh = 60;
            console.error('Could not refresh tokens: ' + error.message);
            console.error('Retrying in 60 seconds');
        }
        this.tokenRefreshTimeout = setTimeout(() => this.refreshTokens(), timeToNextTokenRefresh * 1000);
    }

    recreateEventSources() {
        for (const haid of Object.keys(this.eventSources)) {
            this.eventSources[haid].close();
            for (const [event, callback] of this.eventListeners[haid]) {
                this.eventSources[haid].removeEventListener(event, callback);
            }
            const url = isSimulated ? urls.simulation.base : urls.physical.base;
            this.eventSources[haid] = new EventSource(url + 'api/homeappliances/' + haid + '/events', {
                headers: {
                    accept: 'text/event-stream',
                    authorization: 'Bearer ' + this.tokens.access_token,
                },
            });
            for (const [event, callback] of this.eventListeners[haid]) {
                this.eventSources[haid].addEventListener(event, callback);
            }
        }
        if (this.eventSource) {
            this.eventSource.close();
            for (const [event, callback] of this.eventListener) {
                this.eventSource.removeEventListener(event, callback);
            }
            const url = isSimulated ? urls.simulation.base : urls.physical.base;
            this.eventSource = new EventSource(url + 'api/homeappliances/events', {
                headers: {
                    accept: 'text/event-stream',
                    authorization: 'Bearer ' + this.tokens.access_token,
                },
            });
            for (const [event, callback] of this.eventListener) {
                this.eventSource.addEventListener(event, callback);
            }
        }
    }
}

module.exports = HomeConnect;
