import { jwtDecode } from 'jwt-decode';

// copied from utils
function isBytes(a) {
    return (a instanceof Uint8Array ||
        (a != null && typeof a === 'object' && a.constructor.name === 'Uint8Array'));
}
function bytes(b, ...lengths) {
    if (!isBytes(b))
        throw new Error('Uint8Array expected');
    if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error(`Uint8Array expected of length ${lengths}, not of length=${b.length}`);
}
function exists(instance, checkFinished = true) {
    if (instance.destroyed)
        throw new Error('Hash instance has been destroyed');
    if (checkFinished && instance.finished)
        throw new Error('Hash#digest() has already been called');
}
function output(out, instance) {
    bytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
        throw new Error(`digestInto() expects output buffer of length at least ${min}`);
    }
}

/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// We use WebCrypto aka globalThis.crypto, which exists in browsers and node.js 16+.
// node.js versions earlier than v19 don't declare it in global scope.
// For node.js, package.json#exports field mapping rewrites import
// from `crypto` to `cryptoNode`, which imports native module.
// Makes the utils un-importable in browsers without a bundler.
// Once node.js 18 is deprecated (2025-04-30), we can just drop the import.
// Cast array to view
const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
// The rotate right (circular right shift) operation for uint32
const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);
new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
/**
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
function utf8ToBytes(str) {
    if (typeof str !== 'string')
        throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
/**
 * Normalizes (non-hex) string or Uint8Array to Uint8Array.
 * Warning: when Uint8Array is passed, it would NOT get copied.
 * Keep in mind for future mutable operations.
 */
function toBytes(data) {
    if (typeof data === 'string')
        data = utf8ToBytes(data);
    bytes(data);
    return data;
}
// For runtime check if class implements interface
class Hash {
    // Safe version that clones internal state
    clone() {
        return this._cloneInto();
    }
}
function wrapConstructor(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
}

// Polyfill for Safari 14
function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function')
        return view.setBigUint64(byteOffset, value, isLE);
    const _32n = BigInt(32);
    const _u32_max = BigInt(0xffffffff);
    const wh = Number((value >> _32n) & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
}
// Choice: a ? b : c
const Chi = (a, b, c) => (a & b) ^ (~a & c);
// Majority function, true if any two inpust is true
const Maj = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
/**
 * Merkle-Damgard hash construction base class.
 * Could be used to create MD5, RIPEMD, SHA1, SHA2.
 */
class HashMD extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
    }
    update(data) {
        exists(this);
        const { view, buffer, blockLen } = this;
        data = toBytes(data);
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            // Fast path: we have at least one block in input, cast it to view and process
            if (take === blockLen) {
                const dataView = createView(data);
                for (; blockLen <= len - pos; pos += blockLen)
                    this.process(dataView, pos);
                continue;
            }
            buffer.set(data.subarray(pos, pos + take), this.pos);
            this.pos += take;
            pos += take;
            if (this.pos === blockLen) {
                this.process(view, 0);
                this.pos = 0;
            }
        }
        this.length += data.length;
        this.roundClean();
        return this;
    }
    digestInto(out) {
        exists(this);
        output(out, this);
        this.finished = true;
        // Padding
        // We can avoid allocation of buffer for padding completely if it
        // was previously not allocated here. But it won't change performance.
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        // append the bit '1' to the message
        buffer[pos++] = 0b10000000;
        this.buffer.subarray(pos).fill(0);
        // we have less than padOffset left in buffer, so we cannot put length in
        // current block, need process it and pad again
        if (this.padOffset > blockLen - pos) {
            this.process(view, 0);
            pos = 0;
        }
        // Pad until full block byte with zeros
        for (let i = pos; i < blockLen; i++)
            buffer[i] = 0;
        // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
        // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
        // So we just write lowest 64 bits of that value.
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = createView(out);
        const len = this.outputLen;
        // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
        if (len % 4)
            throw new Error('_sha2: outputLen should be aligned to 32bit');
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
            throw new Error('_sha2: outputLen bigger than state');
        for (let i = 0; i < outLen; i++)
            oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
    }
    _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.length = length;
        to.pos = pos;
        to.finished = finished;
        to.destroyed = destroyed;
        if (length % blockLen)
            to.buffer.set(buffer);
        return to;
    }
}

// SHA2-256 need to try 2^128 hashes to execute birthday attack.
// BTC network is doing 2^67 hashes/sec as per early 2023.
// Round constants:
// first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
// prettier-ignore
const SHA256_K = /* @__PURE__ */ new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
// Initial state:
// first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19
// prettier-ignore
const SHA256_IV = /* @__PURE__ */ new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
// Temporary buffer, not used to store anything between runs
// Named this way because it matches specification.
const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
class SHA256 extends HashMD {
    constructor() {
        super(64, 32, 8, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        this.A = SHA256_IV[0] | 0;
        this.B = SHA256_IV[1] | 0;
        this.C = SHA256_IV[2] | 0;
        this.D = SHA256_IV[3] | 0;
        this.E = SHA256_IV[4] | 0;
        this.F = SHA256_IV[5] | 0;
        this.G = SHA256_IV[6] | 0;
        this.H = SHA256_IV[7] | 0;
    }
    get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4)
            SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
            const W15 = SHA256_W[i - 15];
            const W2 = SHA256_W[i - 2];
            const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ (W15 >>> 3);
            const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ (W2 >>> 10);
            SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
        }
        // Compression function main loop, 64 rounds
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
            const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
            const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
            const T2 = (sigma0 + Maj(A, B, C)) | 0;
            H = G;
            G = F;
            F = E;
            E = (D + T1) | 0;
            D = C;
            C = B;
            B = A;
            A = (T1 + T2) | 0;
        }
        // Add the compressed chunk to the current hash value
        A = (A + this.A) | 0;
        B = (B + this.B) | 0;
        C = (C + this.C) | 0;
        D = (D + this.D) | 0;
        E = (E + this.E) | 0;
        F = (F + this.F) | 0;
        G = (G + this.G) | 0;
        H = (H + this.H) | 0;
        this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
        SHA256_W.fill(0);
    }
    destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        this.buffer.fill(0);
    }
}
/**
 * SHA2-256 hash function
 * @param message - data that would be hashed
 */
const sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

/*
 * Copyright 2016 Red Hat, Inc. and/or its affiliates
 * and other contributors as indicated by the @author tags.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

if (typeof Promise === 'undefined') {
    throw Error('Keycloak requires an environment that supports Promises. Make sure that you include the appropriate polyfill.');
}

function Keycloak (config) {
    if (!(this instanceof Keycloak)) {
        throw new Error("The 'Keycloak' constructor must be invoked with 'new'.")
    }

    var kc = this;
    var adapter;
    var refreshQueue = [];
    var callbackStorage;

    var loginIframe = {
        enable: true,
        callbackList: [],
        interval: 5
    };

    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
        if ((scripts[i].src.indexOf('keycloak.js') !== -1 || scripts[i].src.indexOf('keycloak.min.js') !== -1) && scripts[i].src.indexOf('version=') !== -1) {
            kc.iframeVersion = scripts[i].src.substring(scripts[i].src.indexOf('version=') + 8).split('&')[0];
        }
    }

    var useNonce = true;
    var logInfo = createLogger(console.info);
    var logWarn = createLogger(console.warn);

    kc.init = function (initOptions) {
        if (kc.didInitialize) {
            throw new Error("A 'Keycloak' instance can only be initialized once.");
        }

        kc.didInitialize = true;

        kc.authenticated = false;

        callbackStorage = createCallbackStorage();
        var adapters = ['default', 'cordova', 'cordova-native'];

        if (initOptions && adapters.indexOf(initOptions.adapter) > -1) {
            adapter = loadAdapter(initOptions.adapter);
        } else if (initOptions && typeof initOptions.adapter === "object") {
            adapter = initOptions.adapter;
        } else {
            if (window.Cordova || window.cordova) {
                adapter = loadAdapter('cordova');
            } else {
                adapter = loadAdapter();
            }
        }

        if (initOptions) {
            if (typeof initOptions.useNonce !== 'undefined') {
                useNonce = initOptions.useNonce;
            }

            if (typeof initOptions.checkLoginIframe !== 'undefined') {
                loginIframe.enable = initOptions.checkLoginIframe;
            }

            if (initOptions.checkLoginIframeInterval) {
                loginIframe.interval = initOptions.checkLoginIframeInterval;
            }

            if (initOptions.onLoad === 'login-required') {
                kc.loginRequired = true;
            }

            if (initOptions.responseMode) {
                if (initOptions.responseMode === 'query' || initOptions.responseMode === 'fragment') {
                    kc.responseMode = initOptions.responseMode;
                } else {
                    throw 'Invalid value for responseMode';
                }
            }

            if (initOptions.flow) {
                switch (initOptions.flow) {
                    case 'standard':
                        kc.responseType = 'code';
                        break;
                    case 'implicit':
                        kc.responseType = 'id_token token';
                        break;
                    case 'hybrid':
                        kc.responseType = 'code id_token token';
                        break;
                    default:
                        throw 'Invalid value for flow';
                }
                kc.flow = initOptions.flow;
            }

            if (initOptions.timeSkew != null) {
                kc.timeSkew = initOptions.timeSkew;
            }

            if(initOptions.redirectUri) {
                kc.redirectUri = initOptions.redirectUri;
            }

            if (initOptions.silentCheckSsoRedirectUri) {
                kc.silentCheckSsoRedirectUri = initOptions.silentCheckSsoRedirectUri;
            }

            if (typeof initOptions.silentCheckSsoFallback === 'boolean') {
                kc.silentCheckSsoFallback = initOptions.silentCheckSsoFallback;
            } else {
                kc.silentCheckSsoFallback = true;
            }

            if (typeof initOptions.pkceMethod !== "undefined") {
                if (initOptions.pkceMethod !== "S256" && initOptions.pkceMethod !== false) {
                    throw new TypeError(`Invalid value for pkceMethod', expected 'S256' or false but got ${initOptions.pkceMethod}.`);
                }

                kc.pkceMethod = initOptions.pkceMethod;
            } else {
                kc.pkceMethod = "S256";
            }

            if (typeof initOptions.enableLogging === 'boolean') {
                kc.enableLogging = initOptions.enableLogging;
            } else {
                kc.enableLogging = false;
            }

            if (initOptions.logoutMethod === 'POST') {
                kc.logoutMethod = 'POST';
            } else {
                kc.logoutMethod = 'GET';
            }

            if (typeof initOptions.scope === 'string') {
                kc.scope = initOptions.scope;
            }

            if (typeof initOptions.acrValues === 'string') {
                kc.acrValues = initOptions.acrValues;
            }

            if (typeof initOptions.messageReceiveTimeout === 'number' && initOptions.messageReceiveTimeout > 0) {
                kc.messageReceiveTimeout = initOptions.messageReceiveTimeout;
            } else {
                kc.messageReceiveTimeout = 10000;
            }
        }

        if (!kc.responseMode) {
            kc.responseMode = 'fragment';
        }
        if (!kc.responseType) {
            kc.responseType = 'code';
            kc.flow = 'standard';
        }

        var promise = createPromise();

        var initPromise = createPromise();
        initPromise.promise.then(function() {
            kc.onReady && kc.onReady(kc.authenticated);
            promise.setSuccess(kc.authenticated);
        }).catch(function(error) {
            promise.setError(error);
        });

        var configPromise = loadConfig();

        function onLoad() {
            var doLogin = function(prompt) {
                if (!prompt) {
                    options.prompt = 'none';
                }

                if (initOptions && initOptions.locale) {
                    options.locale = initOptions.locale;
                }
                kc.login(options).then(function () {
                    initPromise.setSuccess();
                }).catch(function (error) {
                    initPromise.setError(error);
                });
            };

            var checkSsoSilently = function() {
                var ifrm = document.createElement("iframe");
                var src = kc.createLoginUrl({prompt: 'none', redirectUri: kc.silentCheckSsoRedirectUri});
                ifrm.setAttribute("src", src);
                ifrm.setAttribute("sandbox", "allow-storage-access-by-user-activation allow-scripts allow-same-origin");
                ifrm.setAttribute("title", "keycloak-silent-check-sso");
                ifrm.style.display = "none";
                document.body.appendChild(ifrm);

                var messageCallback = function(event) {
                    if (event.origin !== window.location.origin || ifrm.contentWindow !== event.source) {
                        return;
                    }

                    var oauth = parseCallback(event.data);
                    processCallback(oauth, initPromise);

                    document.body.removeChild(ifrm);
                    window.removeEventListener("message", messageCallback);
                };

                window.addEventListener("message", messageCallback);
            };

            var options = {};
            switch (initOptions.onLoad) {
                case 'check-sso':
                    if (loginIframe.enable) {
                        setupCheckLoginIframe().then(function() {
                            checkLoginIframe().then(function (unchanged) {
                                if (!unchanged) {
                                    kc.silentCheckSsoRedirectUri ? checkSsoSilently() : doLogin(false);
                                } else {
                                    initPromise.setSuccess();
                                }
                            }).catch(function (error) {
                                initPromise.setError(error);
                            });
                        });
                    } else {
                        kc.silentCheckSsoRedirectUri ? checkSsoSilently() : doLogin(false);
                    }
                    break;
                case 'login-required':
                    doLogin(true);
                    break;
                default:
                    throw 'Invalid value for onLoad';
            }
        }

        function processInit() {
            var callback = parseCallback(window.location.href);

            if (callback) {
                window.history.replaceState(window.history.state, null, callback.newUrl);
            }

            if (callback && callback.valid) {
                return setupCheckLoginIframe().then(function() {
                    processCallback(callback, initPromise);
                }).catch(function (error) {
                    initPromise.setError(error);
                });
            } else if (initOptions) {
                if (initOptions.token && initOptions.refreshToken) {
                    setToken(initOptions.token, initOptions.refreshToken, initOptions.idToken);

                    if (loginIframe.enable) {
                        setupCheckLoginIframe().then(function() {
                            checkLoginIframe().then(function (unchanged) {
                                if (unchanged) {
                                    kc.onAuthSuccess && kc.onAuthSuccess();
                                    initPromise.setSuccess();
                                    scheduleCheckIframe();
                                } else {
                                    initPromise.setSuccess();
                                }
                            }).catch(function (error) {
                                initPromise.setError(error);
                            });
                        });
                    } else {
                        kc.updateToken(-1).then(function() {
                            kc.onAuthSuccess && kc.onAuthSuccess();
                            initPromise.setSuccess();
                        }).catch(function(error) {
                            kc.onAuthError && kc.onAuthError();
                            if (initOptions.onLoad) {
                                onLoad();
                            } else {
                                initPromise.setError(error);
                            }
                        });
                    }
                } else if (initOptions.onLoad) {
                    onLoad();
                } else {
                    initPromise.setSuccess();
                }
            } else {
                initPromise.setSuccess();
            }
        }

        function domReady() {
            var promise = createPromise();

            var checkReadyState = function () {
                if (document.readyState === 'interactive' || document.readyState === 'complete') {
                    document.removeEventListener('readystatechange', checkReadyState);
                    promise.setSuccess();
                }
            };
            document.addEventListener('readystatechange', checkReadyState);

            checkReadyState(); // just in case the event was already fired and we missed it (in case the init is done later than at the load time, i.e. it's done from code)

            return promise.promise;
        }

        configPromise.then(function () {
            domReady()
                .then(check3pCookiesSupported)
                .then(processInit)
                .catch(function (error) {
                    promise.setError(error);
                });
        });
        configPromise.catch(function (error) {
            promise.setError(error);
        });

        return promise.promise;
    };

    kc.login = function (options) {
        return adapter.login(options);
    };

    function generateRandomData(len) {
        // use web crypto APIs if possible
        var array = null;
        var crypto = window.crypto || window.msCrypto;
        if (crypto && crypto.getRandomValues && window.Uint8Array) {
            array = new Uint8Array(len);
            crypto.getRandomValues(array);
            return array;
        }

        // fallback to Math random
        array = new Array(len);
        for (var j = 0; j < array.length; j++) {
            array[j] = Math.floor(256 * Math.random());
        }
        return array;
    }

    function generateCodeVerifier(len) {
        return generateRandomString(len, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    }

    function generateRandomString(len, alphabet){
        var randomData = generateRandomData(len);
        var chars = new Array(len);
        for (var i = 0; i < len; i++) {
            chars[i] = alphabet.charCodeAt(randomData[i] % alphabet.length);
        }
        return String.fromCharCode.apply(null, chars);
    }

    function generatePkceChallenge(pkceMethod, codeVerifier) {
        if (pkceMethod !== "S256") {
            throw new TypeError(`Invalid value for 'pkceMethod', expected 'S256' but got '${pkceMethod}'.`);
        }

        // hash codeVerifier, then encode as url-safe base64 without padding
        const hashBytes = sha256(codeVerifier);
        const encodedHash = bytesToBase64(hashBytes)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/\=/g, '');

        return encodedHash;
    }

    function buildClaimsParameter(requestedAcr){
        var claims = {
            id_token: {
                acr: requestedAcr
            }
        };
        return JSON.stringify(claims);
    }

    kc.createLoginUrl = function(options) {
        var state = createUUID();
        var nonce = createUUID();

        var redirectUri = adapter.redirectUri(options);

        var callbackState = {
            state: state,
            nonce: nonce,
            redirectUri: encodeURIComponent(redirectUri),
            loginOptions: options
        };

        if (options && options.prompt) {
            callbackState.prompt = options.prompt;
        }

        var baseUrl;
        if (options && options.action == 'register') {
            baseUrl = kc.endpoints.register();
        } else {
            baseUrl = kc.endpoints.authorize();
        }

        var scope = options && options.scope || kc.scope;
        if (!scope) {
            // if scope is not set, default to "openid"
            scope = "openid";
        } else if (scope.indexOf("openid") === -1) {
            // if openid scope is missing, prefix the given scopes with it
            scope = "openid " + scope;
        }

        var url = baseUrl
            + '?client_id=' + encodeURIComponent(kc.clientId)
            + '&redirect_uri=' + encodeURIComponent(redirectUri)
            + '&state=' + encodeURIComponent(state)
            + '&response_mode=' + encodeURIComponent(kc.responseMode)
            + '&response_type=' + encodeURIComponent(kc.responseType)
            + '&scope=' + encodeURIComponent(scope);
        if (useNonce) {
            url = url + '&nonce=' + encodeURIComponent(nonce);
        }

        if (options && options.prompt) {
            url += '&prompt=' + encodeURIComponent(options.prompt);
        }

        if (options && options.maxAge) {
            url += '&max_age=' + encodeURIComponent(options.maxAge);
        }

        if (options && options.loginHint) {
            url += '&login_hint=' + encodeURIComponent(options.loginHint);
        }

        if (options && options.idpHint) {
            url += '&kc_idp_hint=' + encodeURIComponent(options.idpHint);
        }

        if (options && options.action && options.action != 'register') {
            url += '&kc_action=' + encodeURIComponent(options.action);
        }

        if (options && options.locale) {
            url += '&ui_locales=' + encodeURIComponent(options.locale);
        }

        if (options && options.acr) {
            var claimsParameter = buildClaimsParameter(options.acr);
            url += '&claims=' + encodeURIComponent(claimsParameter);
        }

        if ((options && options.acrValues) || kc.acrValues) {
            url += '&acr_values=' + encodeURIComponent(options.acrValues || kc.acrValues);
        }

        if (kc.pkceMethod) {
            var codeVerifier = generateCodeVerifier(96);
            callbackState.pkceCodeVerifier = codeVerifier;
            var pkceChallenge = generatePkceChallenge(kc.pkceMethod, codeVerifier);
            url += '&code_challenge=' + pkceChallenge;
            url += '&code_challenge_method=' + kc.pkceMethod;
        }

        callbackStorage.add(callbackState);

        return url;
    };

    kc.logout = function(options) {
        return adapter.logout(options);
    };

    kc.createLogoutUrl = function(options) {

        const logoutMethod = options?.logoutMethod ?? kc.logoutMethod;
        if (logoutMethod === 'POST') {
            return kc.endpoints.logout();
        }

        var url = kc.endpoints.logout()
            + '?client_id=' + encodeURIComponent(kc.clientId)
            + '&post_logout_redirect_uri=' + encodeURIComponent(adapter.redirectUri(options, false));

        if (kc.idToken) {
            url += '&id_token_hint=' + encodeURIComponent(kc.idToken);
        }

        return url;
    };

    kc.register = function (options) {
        return adapter.register(options);
    };

    kc.createRegisterUrl = function(options) {
        if (!options) {
            options = {};
        }
        options.action = 'register';
        return kc.createLoginUrl(options);
    };

    kc.createAccountUrl = function(options) {
        var realm = getRealmUrl();
        var url = undefined;
        if (typeof realm !== 'undefined') {
            url = realm
            + '/account'
            + '?referrer=' + encodeURIComponent(kc.clientId)
            + '&referrer_uri=' + encodeURIComponent(adapter.redirectUri(options));
        }
        return url;
    };

    kc.accountManagement = function() {
        return adapter.accountManagement();
    };

    kc.hasRealmRole = function (role) {
        var access = kc.realmAccess;
        return !!access && access.roles.indexOf(role) >= 0;
    };

    kc.hasResourceRole = function(role, resource) {
        if (!kc.resourceAccess) {
            return false;
        }

        var access = kc.resourceAccess[resource || kc.clientId];
        return !!access && access.roles.indexOf(role) >= 0;
    };

    kc.loadUserProfile = function() {
        var url = getRealmUrl() + '/account';
        var req = new XMLHttpRequest();
        req.open('GET', url, true);
        req.setRequestHeader('Accept', 'application/json');
        req.setRequestHeader('Authorization', 'bearer ' + kc.token);

        var promise = createPromise();

        req.onreadystatechange = function () {
            if (req.readyState == 4) {
                if (req.status == 200) {
                    kc.profile = JSON.parse(req.responseText);
                    promise.setSuccess(kc.profile);
                } else {
                    promise.setError();
                }
            }
        };

        req.send();

        return promise.promise;
    };

    kc.loadUserInfo = function() {
        var url = kc.endpoints.userinfo();
        var req = new XMLHttpRequest();
        req.open('GET', url, true);
        req.setRequestHeader('Accept', 'application/json');
        req.setRequestHeader('Authorization', 'bearer ' + kc.token);

        var promise = createPromise();

        req.onreadystatechange = function () {
            if (req.readyState == 4) {
                if (req.status == 200) {
                    kc.userInfo = JSON.parse(req.responseText);
                    promise.setSuccess(kc.userInfo);
                } else {
                    promise.setError();
                }
            }
        };

        req.send();

        return promise.promise;
    };

    kc.isTokenExpired = function(minValidity) {
        if (!kc.tokenParsed || (!kc.refreshToken && kc.flow != 'implicit' )) {
            throw 'Not authenticated';
        }

        if (kc.timeSkew == null) {
            logInfo('[KEYCLOAK] Unable to determine if token is expired as timeskew is not set');
            return true;
        }

        var expiresIn = kc.tokenParsed['exp'] - Math.ceil(new Date().getTime() / 1000) + kc.timeSkew;
        if (minValidity) {
            if (isNaN(minValidity)) {
                throw 'Invalid minValidity';
            }
            expiresIn -= minValidity;
        }
        return expiresIn < 0;
    };

    kc.updateToken = function(minValidity) {
        var promise = createPromise();

        if (!kc.refreshToken) {
            promise.setError();
            return promise.promise;
        }

        minValidity = minValidity || 5;

        var exec = function() {
            var refreshToken = false;
            if (minValidity == -1) {
                refreshToken = true;
                logInfo('[KEYCLOAK] Refreshing token: forced refresh');
            } else if (!kc.tokenParsed || kc.isTokenExpired(minValidity)) {
                refreshToken = true;
                logInfo('[KEYCLOAK] Refreshing token: token expired');
            }

            if (!refreshToken) {
                promise.setSuccess(false);
            } else {
                var params = 'grant_type=refresh_token&' + 'refresh_token=' + kc.refreshToken;
                var url = kc.endpoints.token();

                refreshQueue.push(promise);

                if (refreshQueue.length == 1) {
                    var req = new XMLHttpRequest();
                    req.open('POST', url, true);
                    req.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
                    req.withCredentials = true;

                    params += '&client_id=' + encodeURIComponent(kc.clientId);

                    var timeLocal = new Date().getTime();

                    req.onreadystatechange = function () {
                        if (req.readyState == 4) {
                            if (req.status == 200) {
                                logInfo('[KEYCLOAK] Token refreshed');

                                timeLocal = (timeLocal + new Date().getTime()) / 2;

                                var tokenResponse = JSON.parse(req.responseText);

                                setToken(tokenResponse['access_token'], tokenResponse['refresh_token'], tokenResponse['id_token'], timeLocal);

                                kc.onAuthRefreshSuccess && kc.onAuthRefreshSuccess();
                                for (var p = refreshQueue.pop(); p != null; p = refreshQueue.pop()) {
                                    p.setSuccess(true);
                                }
                            } else {
                                logWarn('[KEYCLOAK] Failed to refresh token');

                                if (req.status == 400) {
                                    kc.clearToken();
                                }

                                kc.onAuthRefreshError && kc.onAuthRefreshError();
                                for (var p = refreshQueue.pop(); p != null; p = refreshQueue.pop()) {
                                    p.setError(true);
                                }
                            }
                        }
                    };

                    req.send(params);
                }
            }
        };

        if (loginIframe.enable) {
            var iframePromise = checkLoginIframe();
            iframePromise.then(function() {
                exec();
            }).catch(function(error) {
                promise.setError(error);
            });
        } else {
            exec();
        }

        return promise.promise;
    };

    kc.clearToken = function() {
        if (kc.token) {
            setToken(null, null, null);
            kc.onAuthLogout && kc.onAuthLogout();
            if (kc.loginRequired) {
                kc.login();
            }
        }
    };

    function getRealmUrl() {
        if (typeof kc.authServerUrl !== 'undefined') {
            if (kc.authServerUrl.charAt(kc.authServerUrl.length - 1) == '/') {
                return kc.authServerUrl + 'realms/' + encodeURIComponent(kc.realm);
            } else {
                return kc.authServerUrl + '/realms/' + encodeURIComponent(kc.realm);
            }
        } else {
            return undefined;
        }
    }

    function getOrigin() {
        if (!window.location.origin) {
            return window.location.protocol + "//" + window.location.hostname + (window.location.port ? ':' + window.location.port: '');
        } else {
            return window.location.origin;
        }
    }

    function processCallback(oauth, promise) {
        var code = oauth.code;
        var error = oauth.error;
        var prompt = oauth.prompt;

        var timeLocal = new Date().getTime();

        if (oauth['kc_action_status']) {
            kc.onActionUpdate && kc.onActionUpdate(oauth['kc_action_status']);
        }

        if (error) {
            if (prompt != 'none') {
                if (oauth.error_description && oauth.error_description === "authentication_expired") {
                    kc.login(oauth.loginOptions);
                } else {
                    var errorData = { error: error, error_description: oauth.error_description };
                    kc.onAuthError && kc.onAuthError(errorData);
                    promise && promise.setError(errorData);
                }
            } else {
                promise && promise.setSuccess();
            }
            return;
        } else if ((kc.flow != 'standard') && (oauth.access_token || oauth.id_token)) {
            authSuccess(oauth.access_token, null, oauth.id_token, true);
        }

        if ((kc.flow != 'implicit') && code) {
            var params = 'code=' + code + '&grant_type=authorization_code';
            var url = kc.endpoints.token();

            var req = new XMLHttpRequest();
            req.open('POST', url, true);
            req.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');

            params += '&client_id=' + encodeURIComponent(kc.clientId);
            params += '&redirect_uri=' + oauth.redirectUri;

            if (oauth.pkceCodeVerifier) {
                params += '&code_verifier=' + oauth.pkceCodeVerifier;
            }

            req.withCredentials = true;

            req.onreadystatechange = function() {
                if (req.readyState == 4) {
                    if (req.status == 200) {

                        var tokenResponse = JSON.parse(req.responseText);
                        authSuccess(tokenResponse['access_token'], tokenResponse['refresh_token'], tokenResponse['id_token'], kc.flow === 'standard');
                        scheduleCheckIframe();
                    } else {
                        kc.onAuthError && kc.onAuthError();
                        promise && promise.setError();
                    }
                }
            };

            req.send(params);
        }

        function authSuccess(accessToken, refreshToken, idToken, fulfillPromise) {
            timeLocal = (timeLocal + new Date().getTime()) / 2;

            setToken(accessToken, refreshToken, idToken, timeLocal);

            if (useNonce && (kc.idTokenParsed && kc.idTokenParsed.nonce != oauth.storedNonce)) {
                logInfo('[KEYCLOAK] Invalid nonce, clearing token');
                kc.clearToken();
                promise && promise.setError();
            } else {
                if (fulfillPromise) {
                    kc.onAuthSuccess && kc.onAuthSuccess();
                    promise && promise.setSuccess();
                }
            }
        }

    }

    function loadConfig(url) {
        var promise = createPromise();
        var configUrl;

        if (!config) {
            configUrl = 'keycloak.json';
        } else if (typeof config === 'string') {
            configUrl = config;
        }

        function setupOidcEndoints(oidcConfiguration) {
            if (! oidcConfiguration) {
                kc.endpoints = {
                    authorize: function() {
                        return getRealmUrl() + '/protocol/openid-connect/auth';
                    },
                    token: function() {
                        return getRealmUrl() + '/protocol/openid-connect/token';
                    },
                    logout: function() {
                        return getRealmUrl() + '/protocol/openid-connect/logout';
                    },
                    checkSessionIframe: function() {
                        var src = getRealmUrl() + '/protocol/openid-connect/login-status-iframe.html';
                        if (kc.iframeVersion) {
                            src = src + '?version=' + kc.iframeVersion;
                        }
                        return src;
                    },
                    thirdPartyCookiesIframe: function() {
                        var src = getRealmUrl() + '/protocol/openid-connect/3p-cookies/step1.html';
                        if (kc.iframeVersion) {
                            src = src + '?version=' + kc.iframeVersion;
                        }
                        return src;
                    },
                    register: function() {
                        return getRealmUrl() + '/protocol/openid-connect/registrations';
                    },
                    userinfo: function() {
                        return getRealmUrl() + '/protocol/openid-connect/userinfo';
                    }
                };
            } else {
                kc.endpoints = {
                    authorize: function() {
                        return oidcConfiguration.authorization_endpoint;
                    },
                    token: function() {
                        return oidcConfiguration.token_endpoint;
                    },
                    logout: function() {
                        if (!oidcConfiguration.end_session_endpoint) {
                            throw "Not supported by the OIDC server";
                        }
                        return oidcConfiguration.end_session_endpoint;
                    },
                    checkSessionIframe: function() {
                        if (!oidcConfiguration.check_session_iframe) {
                            throw "Not supported by the OIDC server";
                        }
                        return oidcConfiguration.check_session_iframe;
                    },
                    register: function() {
                        throw 'Redirection to "Register user" page not supported in standard OIDC mode';
                    },
                    userinfo: function() {
                        if (!oidcConfiguration.userinfo_endpoint) {
                            throw "Not supported by the OIDC server";
                        }
                        return oidcConfiguration.userinfo_endpoint;
                    }
                };
            }
        }

        if (configUrl) {
            var req = new XMLHttpRequest();
            req.open('GET', configUrl, true);
            req.setRequestHeader('Accept', 'application/json');

            req.onreadystatechange = function () {
                if (req.readyState == 4) {
                    if (req.status == 200 || fileLoaded(req)) {
                        var config = JSON.parse(req.responseText);

                        kc.authServerUrl = config['auth-server-url'];
                        kc.realm = config['realm'];
                        kc.clientId = config['resource'];
                        setupOidcEndoints(null);
                        promise.setSuccess();
                    } else {
                        promise.setError();
                    }
                }
            };

            req.send();
        } else {
            if (!config.clientId) {
                throw 'clientId missing';
            }

            kc.clientId = config.clientId;

            var oidcProvider = config['oidcProvider'];
            if (!oidcProvider) {
                if (!config['url']) {
                    var scripts = document.getElementsByTagName('script');
                    for (var i = 0; i < scripts.length; i++) {
                        if (scripts[i].src.match(/.*keycloak\.js/)) {
                            config.url = scripts[i].src.substr(0, scripts[i].src.indexOf('/js/keycloak.js'));
                            break;
                        }
                    }
                }
                if (!config.realm) {
                    throw 'realm missing';
                }

                kc.authServerUrl = config.url;
                kc.realm = config.realm;
                setupOidcEndoints(null);
                promise.setSuccess();
            } else {
                if (typeof oidcProvider === 'string') {
                    var oidcProviderConfigUrl;
                    if (oidcProvider.charAt(oidcProvider.length - 1) == '/') {
                        oidcProviderConfigUrl = oidcProvider + '.well-known/openid-configuration';
                    } else {
                        oidcProviderConfigUrl = oidcProvider + '/.well-known/openid-configuration';
                    }
                    var req = new XMLHttpRequest();
                    req.open('GET', oidcProviderConfigUrl, true);
                    req.setRequestHeader('Accept', 'application/json');

                    req.onreadystatechange = function () {
                        if (req.readyState == 4) {
                            if (req.status == 200 || fileLoaded(req)) {
                                var oidcProviderConfig = JSON.parse(req.responseText);
                                setupOidcEndoints(oidcProviderConfig);
                                promise.setSuccess();
                            } else {
                                promise.setError();
                            }
                        }
                    };

                    req.send();
                } else {
                    setupOidcEndoints(oidcProvider);
                    promise.setSuccess();
                }
            }
        }

        return promise.promise;
    }

    function fileLoaded(xhr) {
        return xhr.status == 0 && xhr.responseText && xhr.responseURL.startsWith('file:');
    }

    function setToken(token, refreshToken, idToken, timeLocal) {
        if (kc.tokenTimeoutHandle) {
            clearTimeout(kc.tokenTimeoutHandle);
            kc.tokenTimeoutHandle = null;
        }

        if (refreshToken) {
            kc.refreshToken = refreshToken;
            kc.refreshTokenParsed = jwtDecode(refreshToken);
        } else {
            delete kc.refreshToken;
            delete kc.refreshTokenParsed;
        }

        if (idToken) {
            kc.idToken = idToken;
            kc.idTokenParsed = jwtDecode(idToken);
        } else {
            delete kc.idToken;
            delete kc.idTokenParsed;
        }

        if (token) {
            kc.token = token;
            kc.tokenParsed = jwtDecode(token);
            kc.sessionId = kc.tokenParsed.sid;
            kc.authenticated = true;
            kc.subject = kc.tokenParsed.sub;
            kc.realmAccess = kc.tokenParsed.realm_access;
            kc.resourceAccess = kc.tokenParsed.resource_access;

            if (timeLocal) {
                kc.timeSkew = Math.floor(timeLocal / 1000) - kc.tokenParsed.iat;
            }

            if (kc.timeSkew != null) {
                logInfo('[KEYCLOAK] Estimated time difference between browser and server is ' + kc.timeSkew + ' seconds');

                if (kc.onTokenExpired) {
                    var expiresIn = (kc.tokenParsed['exp'] - (new Date().getTime() / 1000) + kc.timeSkew) * 1000;
                    logInfo('[KEYCLOAK] Token expires in ' + Math.round(expiresIn / 1000) + ' s');
                    if (expiresIn <= 0) {
                        kc.onTokenExpired();
                    } else {
                        kc.tokenTimeoutHandle = setTimeout(kc.onTokenExpired, expiresIn);
                    }
                }
            }
        } else {
            delete kc.token;
            delete kc.tokenParsed;
            delete kc.subject;
            delete kc.realmAccess;
            delete kc.resourceAccess;

            kc.authenticated = false;
        }
    }

    function createUUID() {
        var hexDigits = '0123456789abcdef';
        var s = generateRandomString(36, hexDigits).split("");
        s[14] = '4';
        s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);
        s[8] = s[13] = s[18] = s[23] = '-';
        var uuid = s.join('');
        return uuid;
    }

    function parseCallback(url) {
        var oauth = parseCallbackUrl(url);
        if (!oauth) {
            return;
        }

        var oauthState = callbackStorage.get(oauth.state);

        if (oauthState) {
            oauth.valid = true;
            oauth.redirectUri = oauthState.redirectUri;
            oauth.storedNonce = oauthState.nonce;
            oauth.prompt = oauthState.prompt;
            oauth.pkceCodeVerifier = oauthState.pkceCodeVerifier;
            oauth.loginOptions = oauthState.loginOptions;
        }

        return oauth;
    }

    function parseCallbackUrl(url) {
        var supportedParams;
        switch (kc.flow) {
            case 'standard':
                supportedParams = ['code', 'state', 'session_state', 'kc_action_status', 'iss'];
                break;
            case 'implicit':
                supportedParams = ['access_token', 'token_type', 'id_token', 'state', 'session_state', 'expires_in', 'kc_action_status', 'iss'];
                break;
            case 'hybrid':
                supportedParams = ['access_token', 'token_type', 'id_token', 'code', 'state', 'session_state', 'expires_in', 'kc_action_status', 'iss'];
                break;
        }

        supportedParams.push('error');
        supportedParams.push('error_description');
        supportedParams.push('error_uri');

        var queryIndex = url.indexOf('?');
        var fragmentIndex = url.indexOf('#');

        var newUrl;
        var parsed;

        if (kc.responseMode === 'query' && queryIndex !== -1) {
            newUrl = url.substring(0, queryIndex);
            parsed = parseCallbackParams(url.substring(queryIndex + 1, fragmentIndex !== -1 ? fragmentIndex : url.length), supportedParams);
            if (parsed.paramsString !== '') {
                newUrl += '?' + parsed.paramsString;
            }
            if (fragmentIndex !== -1) {
                newUrl += url.substring(fragmentIndex);
            }
        } else if (kc.responseMode === 'fragment' && fragmentIndex !== -1) {
            newUrl = url.substring(0, fragmentIndex);
            parsed = parseCallbackParams(url.substring(fragmentIndex + 1), supportedParams);
            if (parsed.paramsString !== '') {
                newUrl += '#' + parsed.paramsString;
            }
        }

        if (parsed && parsed.oauthParams) {
            if (kc.flow === 'standard' || kc.flow === 'hybrid') {
                if ((parsed.oauthParams.code || parsed.oauthParams.error) && parsed.oauthParams.state) {
                    parsed.oauthParams.newUrl = newUrl;
                    return parsed.oauthParams;
                }
            } else if (kc.flow === 'implicit') {
                if ((parsed.oauthParams.access_token || parsed.oauthParams.error) && parsed.oauthParams.state) {
                    parsed.oauthParams.newUrl = newUrl;
                    return parsed.oauthParams;
                }
            }
        }
    }

    function parseCallbackParams(paramsString, supportedParams) {
        var p = paramsString.split('&');
        var result = {
            paramsString: '',
            oauthParams: {}
        };
        for (var i = 0; i < p.length; i++) {
            var split = p[i].indexOf("=");
            var key = p[i].slice(0, split);
            if (supportedParams.indexOf(key) !== -1) {
                result.oauthParams[key] = p[i].slice(split + 1);
            } else {
                if (result.paramsString !== '') {
                    result.paramsString += '&';
                }
                result.paramsString += p[i];
            }
        }
        return result;
    }

    function createPromise() {
        // Need to create a native Promise which also preserves the
        // interface of the custom promise type previously used by the API
        var p = {
            setSuccess: function(result) {
                p.resolve(result);
            },

            setError: function(result) {
                p.reject(result);
            }
        };
        p.promise = new Promise(function(resolve, reject) {
            p.resolve = resolve;
            p.reject = reject;
        });

        return p;
    }

    // Function to extend existing native Promise with timeout
    function applyTimeoutToPromise(promise, timeout, errorMessage) {
        var timeoutHandle = null;
        var timeoutPromise = new Promise(function (resolve, reject) {
            timeoutHandle = setTimeout(function () {
                reject({ "error": errorMessage });
            }, timeout);
        });

        return Promise.race([promise, timeoutPromise]).finally(function () {
            clearTimeout(timeoutHandle);
        });
    }

    function setupCheckLoginIframe() {
        var promise = createPromise();

        if (!loginIframe.enable) {
            promise.setSuccess();
            return promise.promise;
        }

        if (loginIframe.iframe) {
            promise.setSuccess();
            return promise.promise;
        }

        var iframe = document.createElement('iframe');
        loginIframe.iframe = iframe;

        iframe.onload = function() {
            var authUrl = kc.endpoints.authorize();
            if (authUrl.charAt(0) === '/') {
                loginIframe.iframeOrigin = getOrigin();
            } else {
                loginIframe.iframeOrigin = authUrl.substring(0, authUrl.indexOf('/', 8));
            }
            promise.setSuccess();
        };

        var src = kc.endpoints.checkSessionIframe();
        iframe.setAttribute('src', src );
        iframe.setAttribute('sandbox', 'allow-storage-access-by-user-activation allow-scripts allow-same-origin');
        iframe.setAttribute('title', 'keycloak-session-iframe' );
        iframe.style.display = 'none';
        document.body.appendChild(iframe);

        var messageCallback = function(event) {
            if ((event.origin !== loginIframe.iframeOrigin) || (loginIframe.iframe.contentWindow !== event.source)) {
                return;
            }

            if (!(event.data == 'unchanged' || event.data == 'changed' || event.data == 'error')) {
                return;
            }


            if (event.data != 'unchanged') {
                kc.clearToken();
            }

            var callbacks = loginIframe.callbackList.splice(0, loginIframe.callbackList.length);

            for (var i = callbacks.length - 1; i >= 0; --i) {
                var promise = callbacks[i];
                if (event.data == 'error') {
                    promise.setError();
                } else {
                    promise.setSuccess(event.data == 'unchanged');
                }
            }
        };

        window.addEventListener('message', messageCallback, false);

        return promise.promise;
    }

    function scheduleCheckIframe() {
        if (loginIframe.enable) {
            if (kc.token) {
                setTimeout(function() {
                    checkLoginIframe().then(function(unchanged) {
                        if (unchanged) {
                            scheduleCheckIframe();
                        }
                    });
                }, loginIframe.interval * 1000);
            }
        }
    }

    function checkLoginIframe() {
        var promise = createPromise();

        if (loginIframe.iframe && loginIframe.iframeOrigin ) {
            var msg = kc.clientId + ' ' + (kc.sessionId ? kc.sessionId : '');
            loginIframe.callbackList.push(promise);
            var origin = loginIframe.iframeOrigin;
            if (loginIframe.callbackList.length == 1) {
                loginIframe.iframe.contentWindow.postMessage(msg, origin);
            }
        } else {
            promise.setSuccess();
        }

        return promise.promise;
    }

    function check3pCookiesSupported() {
        var promise = createPromise();

        if (loginIframe.enable || kc.silentCheckSsoRedirectUri) {
            var iframe = document.createElement('iframe');
            iframe.setAttribute('src', kc.endpoints.thirdPartyCookiesIframe());
            iframe.setAttribute('sandbox', 'allow-storage-access-by-user-activation allow-scripts allow-same-origin');
            iframe.setAttribute('title', 'keycloak-3p-check-iframe' );
            iframe.style.display = 'none';
            document.body.appendChild(iframe);

            var messageCallback = function(event) {
                if (iframe.contentWindow !== event.source) {
                    return;
                }

                if (event.data !== "supported" && event.data !== "unsupported") {
                    return;
                } else if (event.data === "unsupported") {
                    logWarn(
                        "[KEYCLOAK] Your browser is blocking access to 3rd-party cookies, this means:\n\n" +
                        " - It is not possible to retrieve tokens without redirecting to the Keycloak server (a.k.a. no support for silent authentication).\n" +
                        " - It is not possible to automatically detect changes to the session status (such as the user logging out in another tab).\n\n" +
                        "For more information see: https://www.keycloak.org/docs/latest/securing_apps/#_modern_browsers"
                    );

                    loginIframe.enable = false;
                    if (kc.silentCheckSsoFallback) {
                        kc.silentCheckSsoRedirectUri = false;
                    }
                }

                document.body.removeChild(iframe);
                window.removeEventListener("message", messageCallback);
                promise.setSuccess();
            };

            window.addEventListener('message', messageCallback, false);
        } else {
            promise.setSuccess();
        }

        return applyTimeoutToPromise(promise.promise, kc.messageReceiveTimeout, "Timeout when waiting for 3rd party check iframe message.");
    }

    function loadAdapter(type) {
        if (!type || type == 'default') {
            return {
                login: function(options) {
                    window.location.assign(kc.createLoginUrl(options));
                    return createPromise().promise;
                },

                logout: async function(options) {

                    const logoutMethod = options?.logoutMethod ?? kc.logoutMethod;
                    if (logoutMethod === "GET") {
                        window.location.replace(kc.createLogoutUrl(options));
                        return;
                    }

                    const logoutUrl = kc.createLogoutUrl(options);
                    const response = await fetch(logoutUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                        body: new URLSearchParams({
                            id_token_hint: kc.idToken,
                            client_id: kc.clientId,
                            post_logout_redirect_uri: adapter.redirectUri(options, false)
                        })
                    });

                    if (response.redirected) {
                        window.location.href = response.url;
                        return;
                    }

                    if (response.ok) {
                        window.location.reload();
                        return;
                    }

                    throw new Error("Logout failed, request returned an error code.");
                },

                register: function(options) {
                    window.location.assign(kc.createRegisterUrl(options));
                    return createPromise().promise;
                },

                accountManagement : function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        window.location.href = accountUrl;
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                    return createPromise().promise;
                },

                redirectUri: function(options, encodeHash) {

                    if (options && options.redirectUri) {
                        return options.redirectUri;
                    } else if (kc.redirectUri) {
                        return kc.redirectUri;
                    } else {
                        return location.href;
                    }
                }
            };
        }

        if (type == 'cordova') {
            loginIframe.enable = false;
            var cordovaOpenWindowWrapper = function(loginUrl, target, options) {
                if (window.cordova && window.cordova.InAppBrowser) {
                    // Use inappbrowser for IOS and Android if available
                    return window.cordova.InAppBrowser.open(loginUrl, target, options);
                } else {
                    return window.open(loginUrl, target, options);
                }
            };

            var shallowCloneCordovaOptions = function (userOptions) {
                if (userOptions && userOptions.cordovaOptions) {
                    return Object.keys(userOptions.cordovaOptions).reduce(function (options, optionName) {
                        options[optionName] = userOptions.cordovaOptions[optionName];
                        return options;
                    }, {});
                } else {
                    return {};
                }
            };

            var formatCordovaOptions = function (cordovaOptions) {
                return Object.keys(cordovaOptions).reduce(function (options, optionName) {
                    options.push(optionName+"="+cordovaOptions[optionName]);
                    return options;
                }, []).join(",");
            };

            var createCordovaOptions = function (userOptions) {
                var cordovaOptions = shallowCloneCordovaOptions(userOptions);
                cordovaOptions.location = 'no';
                if (userOptions && userOptions.prompt == 'none') {
                    cordovaOptions.hidden = 'yes';
                }
                return formatCordovaOptions(cordovaOptions);
            };

            var getCordovaRedirectUri = function() {
                return kc.redirectUri || 'http://localhost';
            };
            
            return {
                login: function(options) {
                    var promise = createPromise();

                    var cordovaOptions = createCordovaOptions(options);
                    var loginUrl = kc.createLoginUrl(options);
                    var ref = cordovaOpenWindowWrapper(loginUrl, '_blank', cordovaOptions);
                    var completed = false;

                    var closed = false;
                    var closeBrowser = function() {
                        closed = true;
                        ref.close();
                    };

                    ref.addEventListener('loadstart', function(event) {
                        if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                            var callback = parseCallback(event.url);
                            processCallback(callback, promise);
                            closeBrowser();
                            completed = true;
                        }
                    });

                    ref.addEventListener('loaderror', function(event) {
                        if (!completed) {
                            if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                                var callback = parseCallback(event.url);
                                processCallback(callback, promise);
                                closeBrowser();
                                completed = true;
                            } else {
                                promise.setError();
                                closeBrowser();
                            }
                        }
                    });

                    ref.addEventListener('exit', function(event) {
                        if (!closed) {
                            promise.setError({
                                reason: "closed_by_user"
                            });
                        }
                    });

                    return promise.promise;
                },

                logout: function(options) {
                    var promise = createPromise();

                    var logoutUrl = kc.createLogoutUrl(options);
                    var ref = cordovaOpenWindowWrapper(logoutUrl, '_blank', 'location=no,hidden=yes,clearcache=yes');

                    var error;

                    ref.addEventListener('loadstart', function(event) {
                        if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                            ref.close();
                        }
                    });

                    ref.addEventListener('loaderror', function(event) {
                        if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                            ref.close();
                        } else {
                            error = true;
                            ref.close();
                        }
                    });

                    ref.addEventListener('exit', function(event) {
                        if (error) {
                            promise.setError();
                        } else {
                            kc.clearToken();
                            promise.setSuccess();
                        }
                    });

                    return promise.promise;
                },

                register : function(options) {
                    var promise = createPromise();
                    var registerUrl = kc.createRegisterUrl();
                    var cordovaOptions = createCordovaOptions(options);
                    var ref = cordovaOpenWindowWrapper(registerUrl, '_blank', cordovaOptions);
                    ref.addEventListener('loadstart', function(event) {
                        if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                            ref.close();
                            var oauth = parseCallback(event.url);
                            processCallback(oauth, promise);
                        }
                    });
                    return promise.promise;
                },

                accountManagement : function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        var ref = cordovaOpenWindowWrapper(accountUrl, '_blank', 'location=no');
                        ref.addEventListener('loadstart', function(event) {
                            if (event.url.indexOf(getCordovaRedirectUri()) == 0) {
                                ref.close();
                            }
                        });
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                },

                redirectUri: function(options) {
                    return getCordovaRedirectUri();
                }
            }
        }

        if (type == 'cordova-native') {
            loginIframe.enable = false;

            return {
                login: function(options) {
                    var promise = createPromise();
                    var loginUrl = kc.createLoginUrl(options);

                    universalLinks.subscribe('keycloak', function(event) {
                        universalLinks.unsubscribe('keycloak');
                        window.cordova.plugins.browsertab.close();
                        var oauth = parseCallback(event.url);
                        processCallback(oauth, promise);
                    });

                    window.cordova.plugins.browsertab.openUrl(loginUrl);
                    return promise.promise;
                },

                logout: function(options) {
                    var promise = createPromise();
                    var logoutUrl = kc.createLogoutUrl(options);

                    universalLinks.subscribe('keycloak', function(event) {
                        universalLinks.unsubscribe('keycloak');
                        window.cordova.plugins.browsertab.close();
                        kc.clearToken();
                        promise.setSuccess();
                    });

                    window.cordova.plugins.browsertab.openUrl(logoutUrl);
                    return promise.promise;
                },

                register : function(options) {
                    var promise = createPromise();
                    var registerUrl = kc.createRegisterUrl(options);
                    universalLinks.subscribe('keycloak' , function(event) {
                        universalLinks.unsubscribe('keycloak');
                        window.cordova.plugins.browsertab.close();
                        var oauth = parseCallback(event.url);
                        processCallback(oauth, promise);
                    });
                    window.cordova.plugins.browsertab.openUrl(registerUrl);
                    return promise.promise;

                },

                accountManagement : function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        window.cordova.plugins.browsertab.openUrl(accountUrl);
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                },

                redirectUri: function(options) {
                    if (options && options.redirectUri) {
                        return options.redirectUri;
                    } else if (kc.redirectUri) {
                        return kc.redirectUri;
                    } else {
                        return "http://localhost";
                    }
                }
            }
        }

        throw 'invalid adapter type: ' + type;
    }

    var LocalStorage = function() {
        if (!(this instanceof LocalStorage)) {
            return new LocalStorage();
        }

        localStorage.setItem('kc-test', 'test');
        localStorage.removeItem('kc-test');

        var cs = this;

        function clearExpired() {
            var time = new Date().getTime();
            for (var i = 0; i < localStorage.length; i++)  {
                var key = localStorage.key(i);
                if (key && key.indexOf('kc-callback-') == 0) {
                    var value = localStorage.getItem(key);
                    if (value) {
                        try {
                            var expires = JSON.parse(value).expires;
                            if (!expires || expires < time) {
                                localStorage.removeItem(key);
                            }
                        } catch (err) {
                            localStorage.removeItem(key);
                        }
                    }
                }
            }
        }

        cs.get = function(state) {
            if (!state) {
                return;
            }

            var key = 'kc-callback-' + state;
            var value = localStorage.getItem(key);
            if (value) {
                localStorage.removeItem(key);
                value = JSON.parse(value);
            }

            clearExpired();
            return value;
        };

        cs.add = function(state) {
            clearExpired();

            var key = 'kc-callback-' + state.state;
            state.expires = new Date().getTime() + (60 * 60 * 1000);
            localStorage.setItem(key, JSON.stringify(state));
        };
    };

    var CookieStorage = function() {
        if (!(this instanceof CookieStorage)) {
            return new CookieStorage();
        }

        var cs = this;

        cs.get = function(state) {
            if (!state) {
                return;
            }

            var value = getCookie('kc-callback-' + state);
            setCookie('kc-callback-' + state, '', cookieExpiration(-100));
            if (value) {
                return JSON.parse(value);
            }
        };

        cs.add = function(state) {
            setCookie('kc-callback-' + state.state, JSON.stringify(state), cookieExpiration(60));
        };

        cs.removeItem = function(key) {
            setCookie(key, '', cookieExpiration(-100));
        };

        var cookieExpiration = function (minutes) {
            var exp = new Date();
            exp.setTime(exp.getTime() + (minutes*60*1000));
            return exp;
        };

        var getCookie = function (key) {
            var name = key + '=';
            var ca = document.cookie.split(';');
            for (var i = 0; i < ca.length; i++) {
                var c = ca[i];
                while (c.charAt(0) == ' ') {
                    c = c.substring(1);
                }
                if (c.indexOf(name) == 0) {
                    return c.substring(name.length, c.length);
                }
            }
            return '';
        };

        var setCookie = function (key, value, expirationDate) {
            var cookie = key + '=' + value + '; '
                + 'expires=' + expirationDate.toUTCString() + '; ';
            document.cookie = cookie;
        };
    };

    function createCallbackStorage() {
        try {
            return new LocalStorage();
        } catch (err) {
        }

        return new CookieStorage();
    }

    function createLogger(fn) {
        return function() {
            if (kc.enableLogging) {
                fn.apply(console, Array.prototype.slice.call(arguments));
            }
        };
    }
}

// See: https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem
function bytesToBase64(bytes) {
    const binString = String.fromCodePoint(...bytes);
    return btoa(binString);
}

export { Keycloak as default };