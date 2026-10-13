(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/lib/crypto.js
  var crypto_exports = {};
  __export(crypto_exports, {
    aesDecryptRaw: () => aesDecryptRaw,
    aesEncryptRaw: () => aesEncryptRaw,
    base64ToBytes: () => base64ToBytes,
    bytesToBase64: () => bytesToBase64,
    bytesToHex: () => bytesToHex,
    concatBytes: () => concatBytes,
    eapi: () => eapi,
    eapiDecrypt: () => eapiDecrypt,
    hexToBytes: () => hexToBytes,
    kugouSignature: () => kugouSignature,
    latin1Decode: () => latin1Decode,
    md5: () => md5,
    md5Bytes: () => md5Bytes,
    randomBytes: () => randomBytes,
    rsaEncryptNetease: () => rsaEncryptNetease,
    rsaEncryptRaw: () => rsaEncryptRaw,
    utf8Decode: () => utf8Decode,
    utf8Encode: () => utf8Encode,
    weapi: () => weapi
  });
  function bytesToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
    return out;
  }
  function hexToBytes(hex) {
    const n = hex.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      out += B64CHARS[b0 >> 2];
      out += B64CHARS[(b0 & 3) << 4 | (b1 === void 0 ? 0 : b1) >> 4];
      out += b1 === void 0 ? "=" : B64CHARS[(b1 & 15) << 2 | (b2 === void 0 ? 0 : b2) >> 6];
      out += b2 === void 0 ? "=" : B64CHARS[b2 & 63];
    }
    return out;
  }
  function base64ToBytes(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    const len = clean.length;
    const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const out = new Uint8Array((len * 3 >> 2) - pad);
    let p = 0;
    for (let i = 0; i < len; i += 4) {
      const c0 = B64CHARS.indexOf(clean[i]);
      const c1 = B64CHARS.indexOf(clean[i + 1]);
      const c2 = B64CHARS.indexOf(clean[i + 2]);
      const c3 = B64CHARS.indexOf(clean[i + 3]);
      out[p++] = c0 << 2 | c1 >> 4;
      if (p < out.length) out[p++] = (c1 & 15) << 4 | c2 >> 2;
      if (p < out.length) out[p++] = (c2 & 3) << 6 | c3;
    }
    return out;
  }
  function utf8Encode(str) {
    return new TextEncoder().encode(String(str));
  }
  function utf8Decode(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  function latin1Decode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function concatBytes(...arrs) {
    let total = 0;
    for (const a of arrs) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrs) {
      out.set(a, p);
      p += a.length;
    }
    return out;
  }
  function randomBytes(size) {
    const b = new Uint8Array(size);
    crypto.getRandomValues(b);
    return b;
  }
  var MD5_S = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21
  ];
  var MD5_K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  function md5Words(input) {
    let bytes = typeof input === "string" ? utf8Encode(input) : input;
    const bitLen = bytes.length * 8;
    const withPad = (bytes.length + 8 >> 6) * 64 + 64;
    const buf = new Uint8Array(withPad);
    buf.set(bytes);
    buf[bytes.length] = 128;
    const dv = new DataView(buf.buffer);
    dv.setUint32(withPad - 8, bitLen >>> 0, true);
    dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296) >>> 0, true);
    let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;
    const M = new Uint32Array(16);
    for (let off = 0; off < withPad; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) {
          F = B & C | ~B & D;
          g = i;
        } else if (i < 32) {
          F = D & B | ~D & C;
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = 7 * i % 16;
        }
        const tmp = D;
        D = C;
        C = B;
        const sum = A + F + MD5_K[i] + M[g] >>> 0;
        const rot = MD5_S[i];
        B = B + ((sum << rot | sum >>> 32 - rot) >>> 0) >>> 0;
        A = tmp;
      }
      a0 = a0 + A >>> 0;
      b0 = b0 + B >>> 0;
      c0 = c0 + C >>> 0;
      d0 = d0 + D >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true);
    odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true);
    odv.setUint32(12, d0, true);
    return out;
  }
  function md5(input) {
    return bytesToHex(md5Words(input));
  }
  function md5Bytes(input) {
    return md5Words(input);
  }
  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);
  function gmul(a, b) {
    let r = 0;
    while (b > 0) {
      if (b & 1) r ^= a;
      a <<= 1;
      if (a & 256) a ^= 283;
      b >>= 1;
    }
    return r & 255;
  }
  (function initSbox() {
    const rotl8 = (x, n) => (x << n | x >>> 8 - n) & 255;
    const inverse = new Uint8Array(256);
    for (let a = 1; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        if (gmul(a, b) === 1) {
          inverse[a] = b;
          break;
        }
      }
    }
    inverse[0] = 0;
    for (let a = 0; a < 256; a++) {
      const inv = inverse[a];
      SBOX[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 99) & 255;
    }
    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();
  function xtime(a) {
    return (a << 1 ^ (a & 128 ? 27 : 0)) & 255;
  }
  function mul(a, b) {
    let r = 0;
    while (b) {
      if (b & 1) r ^= a;
      a = xtime(a);
      b >>= 1;
    }
    return r & 255;
  }
  function expandKey(key) {
    const nk = key.length / 4;
    const nr = nk + 6;
    const w = new Uint8Array(16 * (nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = nk; i < 4 * (nr + 1); i++) {
      let t = w.slice((i - 1) * 4, i * 4);
      if (i % nk === 0) {
        t = new Uint8Array([t[1], t[2], t[3], t[0]]);
        t[0] = SBOX[t[0]];
        t[1] = SBOX[t[1]];
        t[2] = SBOX[t[2]];
        t[3] = SBOX[t[3]];
        t[0] ^= rcon;
        rcon = xtime(rcon);
      } else if (nk > 6 && i % nk === 4) {
        t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
      }
      for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
    }
    return { w, nr };
  }
  function addRoundKey(s, w, round) {
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
  }
  function subBytes(s, box) {
    for (let i = 0; i < 16; i++) s[i] = box[s[i]];
  }
  function shiftRows(s) {
    let t;
    t = s[1];
    s[1] = s[5];
    s[5] = s[9];
    s[9] = s[13];
    s[13] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[3];
    s[3] = s[15];
    s[15] = s[11];
    s[11] = s[7];
    s[7] = t;
  }
  function invShiftRows(s) {
    let t;
    t = s[13];
    s[13] = s[9];
    s[9] = s[5];
    s[5] = s[1];
    s[1] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[3];
    s[3] = s[7];
    s[7] = s[11];
    s[11] = s[15];
    s[15] = t;
  }
  function mixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
      s[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
      s[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
      s[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
    }
  }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
  function encryptBlock(block, ks) {
    const s = Uint8Array.from(block);
    addRoundKey(s, ks.w, 0);
    for (let r = 1; r < ks.nr; r++) {
      subBytes(s, SBOX);
      shiftRows(s);
      mixColumns(s);
      addRoundKey(s, ks.w, r);
    }
    subBytes(s, SBOX);
    shiftRows(s);
    addRoundKey(s, ks.w, ks.nr);
    return s;
  }
  function decryptBlock(block, ks) {
    const s = Uint8Array.from(block);
    addRoundKey(s, ks.w, ks.nr);
    for (let r = ks.nr - 1; r > 0; r--) {
      invShiftRows(s);
      subBytes(s, INV_SBOX);
      addRoundKey(s, ks.w, r);
      invMixColumns(s);
    }
    invShiftRows(s);
    subBytes(s, INV_SBOX);
    addRoundKey(s, ks.w, 0);
    return s;
  }
  function pkcs7Pad(data, blockSize = 16) {
    const pad = blockSize - data.length % blockSize;
    const out = new Uint8Array(data.length + pad);
    out.set(data);
    out.fill(pad, data.length);
    return out;
  }
  function pkcs7Unpad(data) {
    if (!data.length) return data;
    const pad = data[data.length - 1];
    if (pad < 1 || pad > 16 || pad > data.length) return data;
    return data.slice(0, data.length - pad);
  }
  function toKeyBytes(key) {
    if (typeof key === "string") return utf8Encode(key);
    return key;
  }
  function aesEncryptRaw(data, key, mode = "cbc", iv) {
    const kb = toKeyBytes(key);
    const ks = expandKey(kb);
    const padded = pkcs7Pad(data);
    const out = new Uint8Array(padded.length);
    if (mode === "cbc") {
      let prev = iv ? toKeyBytes(iv) : new Uint8Array(16);
      for (let i = 0; i < padded.length; i += 16) {
        const blk = new Uint8Array(16);
        for (let j = 0; j < 16; j++) blk[j] = padded[i + j] ^ prev[j];
        const enc = encryptBlock(blk, ks);
        out.set(enc, i);
        prev = enc;
      }
    } else {
      for (let i = 0; i < padded.length; i += 16) out.set(encryptBlock(padded.slice(i, i + 16), ks), i);
    }
    return out;
  }
  function aesDecryptRaw(data, key, mode = "cbc", iv) {
    const kb = toKeyBytes(key);
    const ks = expandKey(kb);
    const out = new Uint8Array(data.length);
    if (mode === "cbc") {
      let prev = iv ? toKeyBytes(iv) : new Uint8Array(16);
      for (let i = 0; i < data.length; i += 16) {
        const blk = data.slice(i, i + 16);
        const dec = decryptBlock(blk, ks);
        for (let j = 0; j < 16; j++) out[i + j] = dec[j] ^ prev[j];
        prev = blk;
      }
    } else {
      for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(data.slice(i, i + 16), ks), i);
    }
    return pkcs7Unpad(out);
  }
  function bytesToBigIntBE(bytes) {
    let hex = bytesToHex(bytes);
    return BigInt("0x" + (hex || "0"));
  }
  function bigIntToBytesBE(n, len) {
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const b = hexToBytes(hex);
    if (len && b.length < len) {
      const out = new Uint8Array(len);
      out.set(b, len - b.length);
      return out;
    }
    return b;
  }
  function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) result = result * base % mod;
      base = base * base % mod;
      exp >>= 1n;
    }
    return result;
  }
  function rsaEncryptNetease(keyHex, pubKeyHex = "010001", modulusHex = WY_MODULUS) {
    const hex = String(keyHex);
    if (hex.length === 0 || hex.length % 2 !== 0) throw new Error("netease secKey must be an even-length hex string");
    const reversed = hexToBytes(hex).reverse();
    const m = bytesToBigIntBE(reversed);
    const e = BigInt("0x" + pubKeyHex);
    const n = BigInt("0x" + modulusHex);
    return modPow(m, e, n).toString(16).padStart(256, "0");
  }
  function rsaEncryptRaw(data, pemKey) {
    const body = String(pemKey).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = base64ToBytes(body);
    const { modulus, exponent } = parseRsaPublicKey(der);
    const bytes = typeof data === "string" ? utf8Encode(data) : data;
    const k = modulus.length;
    const psLen = k - 3 - bytes.length;
    if (psLen < 8) throw new Error("RSA message too long");
    const ps = new Uint8Array(psLen);
    let filled = 0;
    while (filled < psLen) {
      const r = randomBytes(psLen - filled);
      for (let i = 0; i < r.length && filled < psLen; i++) if (r[i] !== 0) ps[filled++] = r[i];
    }
    const em = concatBytes(new Uint8Array([0, 2]), ps, new Uint8Array([0]), bytes);
    const c = modPow(bytesToBigIntBE(em), bytesToBigIntBE(exponent), bytesToBigIntBE(modulus));
    return bigIntToBytesBE(c, k);
  }
  function derReader(der) {
    let p = 0;
    return {
      get done() {
        return p >= der.length;
      },
      read() {
        const tag = der[p++];
        let len = der[p++];
        if (len & 128) {
          const n = len & 127;
          len = 0;
          for (let i = 0; i < n; i++) len = len << 8 | der[p++];
        }
        const val = der.slice(p, p + len);
        p += len;
        return { tag, val };
      }
    };
  }
  function parseRsaPublicKey(der) {
    const outer = derReader(der);
    const top = outer.read();
    if (top.tag !== 48) throw new Error("invalid RSA public key: expect SEQUENCE");
    const inner = derReader(top.val);
    const first = inner.read();
    let seq;
    if (first.tag === 48) {
      const bits = inner.read();
      if (bits.tag !== 3) throw new Error("invalid SPKI: expect BIT STRING");
      const pkcs1 = bits.val.slice(1);
      seq = derReader(pkcs1).read();
    } else {
      seq = first;
    }
    const intReader = derReader(seq.val);
    const mod = intReader.read();
    const exp = intReader.read();
    const strip = (b) => b.length > 1 && b[0] === 0 ? b.slice(1) : b;
    return { modulus: strip(mod.val), exponent: strip(exp.val) };
  }
  var WY_PRESET_KEY = "0CoJUm6Qyw8W8jud";
  var WY_IV = "0102030405060708";
  var WY_PUBKEY = "010001";
  var WY_MODULUS = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
  var EAPI_KEY = "e82ckenh8dichen8";
  function weapi(object) {
    const text = JSON.stringify(object);
    const secKey = bytesToHex(randomBytes(16)).slice(0, 16);
    const params = bytesToBase64(
      aesEncryptRaw(utf8Encode(bytesToBase64(aesEncryptRaw(utf8Encode(text), WY_PRESET_KEY, "cbc", WY_IV))), secKey, "cbc", WY_IV)
    );
    const encSecKey = rsaEncryptNetease(secKey, WY_PUBKEY, WY_MODULUS);
    return { params, encSecKey };
  }
  function eapi(path, object, extraHeader = {}) {
    const header = __spreadValues({
      osver: "15.0",
      deviceId: "unknown",
      appver: "9.1.28",
      versioncode: "140",
      mobilename: "unknown",
      buildver: String(Math.floor(Date.now() / 1e3)),
      resolution: "1920x1080",
      __csrf: "",
      os: "android",
      channel: "",
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1e3).toString().padStart(4, "0")}`
    }, extraHeader);
    const text = JSON.stringify(__spreadProps(__spreadValues({}, object), { header }));
    const message = `nobody${path}use${text}md5forencrypt`;
    const digest = md5(message);
    const data = `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    return bytesToHex(aesEncryptRaw(utf8Encode(data), EAPI_KEY, "ecb")).toUpperCase();
  }
  function eapiDecrypt(hexStr) {
    return utf8Decode(aesDecryptRaw(hexToBytes(hexStr), EAPI_KEY, "ecb"));
  }
  var KG_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
  function kugouSignature(params) {
    const keys = Object.keys(params).sort();
    const str = keys.map((k) => `${k}=${params[k]}`).join("");
    return md5(md5(str) + KG_SALT);
  }

  // src/lib/util.js
  var util_exports = {};
  __export(util_exports, {
    MIME_BY_FORMAT: () => MIME_BY_FORMAT,
    audioMime: () => audioMime,
    bufToString: () => bufToString,
    createBufferShim: () => createBufferShim,
    decodeName: () => decodeName,
    deflateRaw: () => deflateRaw,
    durationToSeconds: () => durationToSeconds,
    formatPlayTime: () => formatPlayTime,
    formatSingerName: () => formatSingerName,
    guessAudioFormat: () => guessAudioFormat,
    inflateRaw: () => inflateRaw,
    mapLimit: () => mapLimit,
    parseLooseJson: () => parseLooseJson,
    safeInt: () => safeInt,
    sizeFormate: () => sizeFormate,
    splitSingers: () => splitSingers,
    stableHash: () => stableHash,
    userError: () => userError
  });
  var ENTITY_MAP = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&#39;": "'",
    "&#34;": '"',
    "&ldquo;": "“",
    "&rdquo;": "”",
    "&hellip;": "…",
    "&mdash;": "—",
    "&ndash;": "–"
  };
  function decodeName(str) {
    if (str == null) return "";
    let s = String(str);
    if (/&[a-zA-Z#0-9]{2,8};/.test(s)) {
      s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
      s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      s = s.replace(/&[a-zA-Z]+;/g, (m) => ENTITY_MAP[m] !== void 0 ? ENTITY_MAP[m] : m);
    }
    if (s.includes("\\u")) {
      try {
        s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } catch (e) {
      }
    }
    return s;
  }
  function parseLooseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
    }
    try {
      const fixed = text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (e) {
      return null;
    }
  }
  function formatPlayTime(seconds, length = 2) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(length, "0")}:${String(sec).padStart(2, "0")}`;
  }
  function sizeFormate(bytes) {
    const n = Number(bytes) || 0;
    const units = ["B", "K", "M", "G", "T"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
  }
  function durationToSeconds(duration) {
    if (typeof duration === "number") return duration;
    const parts = String(duration || "00:00").split(":").map((n) => parseInt(n, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + (parts[1] || 0);
  }
  function formatSingerName(singers, nameKey = "name", join = "、") {
    if (Array.isArray(singers)) {
      const names = [];
      for (const it of singers) {
        const n = it && it[nameKey];
        if (n) names.push(n);
      }
      return decodeName(names.join(join));
    }
    return decodeName(String(singers != null ? singers : ""));
  }
  function splitSingers(str) {
    return String(str || "").split(/[、,&/]|\s+&\s+/).map((s) => s.trim()).filter(Boolean);
  }
  function createBufferShim() {
    class ByteBuf extends Uint8Array {
      static from(value, encoding = "utf8") {
        if (value instanceof Uint8Array) return new ByteBuf(value);
        if (value instanceof ArrayBuffer) return new ByteBuf(new Uint8Array(value));
        if (Array.isArray(value)) return new ByteBuf(Uint8Array.from(value));
        if (typeof value === "string") {
          if (encoding === "hex") return new ByteBuf(hexToBytes(value));
          if (encoding === "base64") return new ByteBuf(base64ToBytes(value));
          if (encoding === "latin1" || encoding === "binary") {
            const out = new Uint8Array(value.length);
            for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
            return new ByteBuf(out);
          }
          return new ByteBuf(utf8Encode(value));
        }
        return new ByteBuf(0);
      }
      static alloc(size) {
        return new ByteBuf(size);
      }
      static concat(list) {
        return new ByteBuf(concatBytes(...list.map((b) => b instanceof Uint8Array ? b : ByteBuf.from(b))));
      }
      static isBuffer(v) {
        return v instanceof ByteBuf || v instanceof Uint8Array;
      }
      toString(encoding = "utf8") {
        if (encoding === "hex") return bytesToHex(this);
        if (encoding === "base64") return bytesToBase64(this);
        if (encoding === "latin1" || encoding === "binary") return latin1Decode(this);
        return utf8Decode(this);
      }
      toStringUtf8() {
        return utf8Decode(this);
      }
    }
    return ByteBuf;
  }
  function bufToString(buf, format = "utf8") {
    if (buf == null) return "";
    if (typeof buf === "string") return buf;
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (format === "hex") return bytesToHex(bytes);
    if (format === "base64") return bytesToBase64(bytes);
    if (format === "latin1" || format === "binary") return latin1Decode(bytes);
    return utf8Decode(bytes);
  }
  async function streamThrough(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function inflateRaw(bytes) {
    try {
      return await streamThrough(bytes, new DecompressionStream("deflate-raw"));
    } catch (e) {
      return streamThrough(bytes, new DecompressionStream("deflate"));
    }
  }
  async function deflateRaw(bytes) {
    return streamThrough(bytes, new CompressionStream("deflate-raw"));
  }
  function guessAudioFormat(url, fallback = "mp3") {
    const clean = String(url || "").split("?")[0].toLowerCase();
    const m = clean.match(/\.(mp3|flac|m4a|aac|ogg|opus|wav|ape|wma)$/);
    return m ? m[1] : fallback;
  }
  var MIME_BY_FORMAT = {
    mp3: "audio/mpeg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    ape: "audio/x-ape",
    wma: "audio/x-ms-wma"
  };
  function audioMime(url, fallback = "mp3") {
    return MIME_BY_FORMAT[guessAudioFormat(url, fallback)] || "audio/mpeg";
  }
  function safeInt(v, def = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  }
  function userError(message) {
    const e = new Error(message);
    e.userError = true;
    return e;
  }
  function stableHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h << 5) + h + str.charCodeAt(i) >>> 0;
    return h.toString(36);
  }
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // lxcore-entry.js
  window.LXCore = {
    // Worker 源码以字符串内联：file:// 源下 new Worker('file://...') 会被同源策略拒绝，
    // 只能自己 Blob 一个。顺带也省掉一次文件读取。
    WORKER_SRC: '(() => {\n  var __defProp = Object.defineProperty;\n  var __defProps = Object.defineProperties;\n  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;\n  var __getOwnPropSymbols = Object.getOwnPropertySymbols;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __propIsEnum = Object.prototype.propertyIsEnumerable;\n  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;\n  var __spreadValues = (a, b) => {\n    for (var prop in b || (b = {}))\n      if (__hasOwnProp.call(b, prop))\n        __defNormalProp(a, prop, b[prop]);\n    if (__getOwnPropSymbols)\n      for (var prop of __getOwnPropSymbols(b)) {\n        if (__propIsEnum.call(b, prop))\n          __defNormalProp(a, prop, b[prop]);\n      }\n    return a;\n  };\n  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));\n\n  // public/js/lib/crypto.js\n  function bytesToHex(bytes) {\n    let out = "";\n    for (let i = 0; i < bytes.length; i++) out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);\n    return out;\n  }\n  function hexToBytes(hex) {\n    const n = hex.length >> 1;\n    const out = new Uint8Array(n);\n    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);\n    return out;\n  }\n  var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";\n  function bytesToBase64(bytes) {\n    let out = "";\n    for (let i = 0; i < bytes.length; i += 3) {\n      const b0 = bytes[i];\n      const b1 = bytes[i + 1];\n      const b2 = bytes[i + 2];\n      out += B64CHARS[b0 >> 2];\n      out += B64CHARS[(b0 & 3) << 4 | (b1 === void 0 ? 0 : b1) >> 4];\n      out += b1 === void 0 ? "=" : B64CHARS[(b1 & 15) << 2 | (b2 === void 0 ? 0 : b2) >> 6];\n      out += b2 === void 0 ? "=" : B64CHARS[b2 & 63];\n    }\n    return out;\n  }\n  function base64ToBytes(str) {\n    const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, "");\n    const len = clean.length;\n    const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;\n    const out = new Uint8Array((len * 3 >> 2) - pad);\n    let p = 0;\n    for (let i = 0; i < len; i += 4) {\n      const c0 = B64CHARS.indexOf(clean[i]);\n      const c1 = B64CHARS.indexOf(clean[i + 1]);\n      const c2 = B64CHARS.indexOf(clean[i + 2]);\n      const c3 = B64CHARS.indexOf(clean[i + 3]);\n      out[p++] = c0 << 2 | c1 >> 4;\n      if (p < out.length) out[p++] = (c1 & 15) << 4 | c2 >> 2;\n      if (p < out.length) out[p++] = (c2 & 3) << 6 | c3;\n    }\n    return out;\n  }\n  function utf8Encode(str) {\n    return new TextEncoder().encode(String(str));\n  }\n  function utf8Decode(bytes) {\n    return new TextDecoder("utf-8").decode(bytes);\n  }\n  function latin1Decode(bytes) {\n    let s = "";\n    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);\n    return s;\n  }\n  function concatBytes(...arrs) {\n    let total = 0;\n    for (const a of arrs) total += a.length;\n    const out = new Uint8Array(total);\n    let p = 0;\n    for (const a of arrs) {\n      out.set(a, p);\n      p += a.length;\n    }\n    return out;\n  }\n  function randomBytes(size) {\n    const b = new Uint8Array(size);\n    crypto.getRandomValues(b);\n    return b;\n  }\n  var MD5_S = [\n    7,\n    12,\n    17,\n    22,\n    7,\n    12,\n    17,\n    22,\n    7,\n    12,\n    17,\n    22,\n    7,\n    12,\n    17,\n    22,\n    5,\n    9,\n    14,\n    20,\n    5,\n    9,\n    14,\n    20,\n    5,\n    9,\n    14,\n    20,\n    5,\n    9,\n    14,\n    20,\n    4,\n    11,\n    16,\n    23,\n    4,\n    11,\n    16,\n    23,\n    4,\n    11,\n    16,\n    23,\n    4,\n    11,\n    16,\n    23,\n    6,\n    10,\n    15,\n    21,\n    6,\n    10,\n    15,\n    21,\n    6,\n    10,\n    15,\n    21,\n    6,\n    10,\n    15,\n    21\n  ];\n  var MD5_K = new Uint32Array(64);\n  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);\n  function md5Words(input) {\n    let bytes = typeof input === "string" ? utf8Encode(input) : input;\n    const bitLen = bytes.length * 8;\n    const withPad = (bytes.length + 8 >> 6) * 64 + 64;\n    const buf = new Uint8Array(withPad);\n    buf.set(bytes);\n    buf[bytes.length] = 128;\n    const dv = new DataView(buf.buffer);\n    dv.setUint32(withPad - 8, bitLen >>> 0, true);\n    dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296) >>> 0, true);\n    let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;\n    const M = new Uint32Array(16);\n    for (let off = 0; off < withPad; off += 64) {\n      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);\n      let A = a0, B = b0, C = c0, D = d0;\n      for (let i = 0; i < 64; i++) {\n        let F, g;\n        if (i < 16) {\n          F = B & C | ~B & D;\n          g = i;\n        } else if (i < 32) {\n          F = D & B | ~D & C;\n          g = (5 * i + 1) % 16;\n        } else if (i < 48) {\n          F = B ^ C ^ D;\n          g = (3 * i + 5) % 16;\n        } else {\n          F = C ^ (B | ~D);\n          g = 7 * i % 16;\n        }\n        const tmp = D;\n        D = C;\n        C = B;\n        const sum = A + F + MD5_K[i] + M[g] >>> 0;\n        const rot = MD5_S[i];\n        B = B + ((sum << rot | sum >>> 32 - rot) >>> 0) >>> 0;\n        A = tmp;\n      }\n      a0 = a0 + A >>> 0;\n      b0 = b0 + B >>> 0;\n      c0 = c0 + C >>> 0;\n      d0 = d0 + D >>> 0;\n    }\n    const out = new Uint8Array(16);\n    const odv = new DataView(out.buffer);\n    odv.setUint32(0, a0, true);\n    odv.setUint32(4, b0, true);\n    odv.setUint32(8, c0, true);\n    odv.setUint32(12, d0, true);\n    return out;\n  }\n  function md5(input) {\n    return bytesToHex(md5Words(input));\n  }\n  var SBOX = new Uint8Array(256);\n  var INV_SBOX = new Uint8Array(256);\n  function gmul(a, b) {\n    let r = 0;\n    while (b > 0) {\n      if (b & 1) r ^= a;\n      a <<= 1;\n      if (a & 256) a ^= 283;\n      b >>= 1;\n    }\n    return r & 255;\n  }\n  (function initSbox() {\n    const rotl8 = (x, n) => (x << n | x >>> 8 - n) & 255;\n    const inverse = new Uint8Array(256);\n    for (let a = 1; a < 256; a++) {\n      for (let b = 1; b < 256; b++) {\n        if (gmul(a, b) === 1) {\n          inverse[a] = b;\n          break;\n        }\n      }\n    }\n    inverse[0] = 0;\n    for (let a = 0; a < 256; a++) {\n      const inv = inverse[a];\n      SBOX[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 99) & 255;\n    }\n    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;\n  })();\n  function xtime(a) {\n    return (a << 1 ^ (a & 128 ? 27 : 0)) & 255;\n  }\n  function mul(a, b) {\n    let r = 0;\n    while (b) {\n      if (b & 1) r ^= a;\n      a = xtime(a);\n      b >>= 1;\n    }\n    return r & 255;\n  }\n  function expandKey(key) {\n    const nk = key.length / 4;\n    const nr = nk + 6;\n    const w = new Uint8Array(16 * (nr + 1));\n    w.set(key);\n    let rcon = 1;\n    for (let i = nk; i < 4 * (nr + 1); i++) {\n      let t = w.slice((i - 1) * 4, i * 4);\n      if (i % nk === 0) {\n        t = new Uint8Array([t[1], t[2], t[3], t[0]]);\n        t[0] = SBOX[t[0]];\n        t[1] = SBOX[t[1]];\n        t[2] = SBOX[t[2]];\n        t[3] = SBOX[t[3]];\n        t[0] ^= rcon;\n        rcon = xtime(rcon);\n      } else if (nk > 6 && i % nk === 4) {\n        t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);\n      }\n      for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];\n    }\n    return { w, nr };\n  }\n  function addRoundKey(s, w, round) {\n    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];\n  }\n  function subBytes(s, box) {\n    for (let i = 0; i < 16; i++) s[i] = box[s[i]];\n  }\n  function shiftRows(s) {\n    let t;\n    t = s[1];\n    s[1] = s[5];\n    s[5] = s[9];\n    s[9] = s[13];\n    s[13] = t;\n    t = s[2];\n    s[2] = s[10];\n    s[10] = t;\n    t = s[6];\n    s[6] = s[14];\n    s[14] = t;\n    t = s[3];\n    s[3] = s[15];\n    s[15] = s[11];\n    s[11] = s[7];\n    s[7] = t;\n  }\n  function invShiftRows(s) {\n    let t;\n    t = s[13];\n    s[13] = s[9];\n    s[9] = s[5];\n    s[5] = s[1];\n    s[1] = t;\n    t = s[2];\n    s[2] = s[10];\n    s[10] = t;\n    t = s[6];\n    s[6] = s[14];\n    s[14] = t;\n    t = s[3];\n    s[3] = s[7];\n    s[7] = s[11];\n    s[11] = s[15];\n    s[15] = t;\n  }\n  function mixColumns(s) {\n    for (let c = 0; c < 4; c++) {\n      const i = c * 4;\n      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];\n      s[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;\n      s[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;\n      s[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);\n      s[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);\n    }\n  }\n  function invMixColumns(s) {\n    for (let c = 0; c < 4; c++) {\n      const i = c * 4;\n      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];\n      s[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);\n      s[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);\n      s[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);\n      s[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);\n    }\n  }\n  function encryptBlock(block, ks) {\n    const s = Uint8Array.from(block);\n    addRoundKey(s, ks.w, 0);\n    for (let r = 1; r < ks.nr; r++) {\n      subBytes(s, SBOX);\n      shiftRows(s);\n      mixColumns(s);\n      addRoundKey(s, ks.w, r);\n    }\n    subBytes(s, SBOX);\n    shiftRows(s);\n    addRoundKey(s, ks.w, ks.nr);\n    return s;\n  }\n  function decryptBlock(block, ks) {\n    const s = Uint8Array.from(block);\n    addRoundKey(s, ks.w, ks.nr);\n    for (let r = ks.nr - 1; r > 0; r--) {\n      invShiftRows(s);\n      subBytes(s, INV_SBOX);\n      addRoundKey(s, ks.w, r);\n      invMixColumns(s);\n    }\n    invShiftRows(s);\n    subBytes(s, INV_SBOX);\n    addRoundKey(s, ks.w, 0);\n    return s;\n  }\n  function pkcs7Pad(data, blockSize = 16) {\n    const pad = blockSize - data.length % blockSize;\n    const out = new Uint8Array(data.length + pad);\n    out.set(data);\n    out.fill(pad, data.length);\n    return out;\n  }\n  function pkcs7Unpad(data) {\n    if (!data.length) return data;\n    const pad = data[data.length - 1];\n    if (pad < 1 || pad > 16 || pad > data.length) return data;\n    return data.slice(0, data.length - pad);\n  }\n  function toKeyBytes(key) {\n    if (typeof key === "string") return utf8Encode(key);\n    return key;\n  }\n  function aesEncryptRaw(data, key, mode = "cbc", iv) {\n    const kb = toKeyBytes(key);\n    const ks = expandKey(kb);\n    const padded = pkcs7Pad(data);\n    const out = new Uint8Array(padded.length);\n    if (mode === "cbc") {\n      let prev = iv ? toKeyBytes(iv) : new Uint8Array(16);\n      for (let i = 0; i < padded.length; i += 16) {\n        const blk = new Uint8Array(16);\n        for (let j = 0; j < 16; j++) blk[j] = padded[i + j] ^ prev[j];\n        const enc = encryptBlock(blk, ks);\n        out.set(enc, i);\n        prev = enc;\n      }\n    } else {\n      for (let i = 0; i < padded.length; i += 16) out.set(encryptBlock(padded.slice(i, i + 16), ks), i);\n    }\n    return out;\n  }\n  function aesDecryptRaw(data, key, mode = "cbc", iv) {\n    const kb = toKeyBytes(key);\n    const ks = expandKey(kb);\n    const out = new Uint8Array(data.length);\n    if (mode === "cbc") {\n      let prev = iv ? toKeyBytes(iv) : new Uint8Array(16);\n      for (let i = 0; i < data.length; i += 16) {\n        const blk = data.slice(i, i + 16);\n        const dec = decryptBlock(blk, ks);\n        for (let j = 0; j < 16; j++) out[i + j] = dec[j] ^ prev[j];\n        prev = blk;\n      }\n    } else {\n      for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(data.slice(i, i + 16), ks), i);\n    }\n    return pkcs7Unpad(out);\n  }\n  function bytesToBigIntBE(bytes) {\n    let hex = bytesToHex(bytes);\n    return BigInt("0x" + (hex || "0"));\n  }\n  function bigIntToBytesBE(n, len) {\n    let hex = n.toString(16);\n    if (hex.length % 2) hex = "0" + hex;\n    const b = hexToBytes(hex);\n    if (len && b.length < len) {\n      const out = new Uint8Array(len);\n      out.set(b, len - b.length);\n      return out;\n    }\n    return b;\n  }\n  function modPow(base, exp, mod) {\n    let result = 1n;\n    base %= mod;\n    while (exp > 0n) {\n      if (exp & 1n) result = result * base % mod;\n      base = base * base % mod;\n      exp >>= 1n;\n    }\n    return result;\n  }\n  function rsaEncryptRaw(data, pemKey) {\n    const body = String(pemKey).replace(/-----[^-]+-----/g, "").replace(/\\s+/g, "");\n    const der = base64ToBytes(body);\n    const { modulus, exponent } = parseRsaPublicKey(der);\n    const bytes = typeof data === "string" ? utf8Encode(data) : data;\n    const k = modulus.length;\n    const psLen = k - 3 - bytes.length;\n    if (psLen < 8) throw new Error("RSA message too long");\n    const ps = new Uint8Array(psLen);\n    let filled = 0;\n    while (filled < psLen) {\n      const r = randomBytes(psLen - filled);\n      for (let i = 0; i < r.length && filled < psLen; i++) if (r[i] !== 0) ps[filled++] = r[i];\n    }\n    const em = concatBytes(new Uint8Array([0, 2]), ps, new Uint8Array([0]), bytes);\n    const c = modPow(bytesToBigIntBE(em), bytesToBigIntBE(exponent), bytesToBigIntBE(modulus));\n    return bigIntToBytesBE(c, k);\n  }\n  function derReader(der) {\n    let p = 0;\n    return {\n      get done() {\n        return p >= der.length;\n      },\n      read() {\n        const tag = der[p++];\n        let len = der[p++];\n        if (len & 128) {\n          const n = len & 127;\n          len = 0;\n          for (let i = 0; i < n; i++) len = len << 8 | der[p++];\n        }\n        const val = der.slice(p, p + len);\n        p += len;\n        return { tag, val };\n      }\n    };\n  }\n  function parseRsaPublicKey(der) {\n    const outer = derReader(der);\n    const top = outer.read();\n    if (top.tag !== 48) throw new Error("invalid RSA public key: expect SEQUENCE");\n    const inner = derReader(top.val);\n    const first = inner.read();\n    let seq;\n    if (first.tag === 48) {\n      const bits = inner.read();\n      if (bits.tag !== 3) throw new Error("invalid SPKI: expect BIT STRING");\n      const pkcs1 = bits.val.slice(1);\n      seq = derReader(pkcs1).read();\n    } else {\n      seq = first;\n    }\n    const intReader = derReader(seq.val);\n    const mod = intReader.read();\n    const exp = intReader.read();\n    const strip = (b) => b.length > 1 && b[0] === 0 ? b.slice(1) : b;\n    return { modulus: strip(mod.val), exponent: strip(exp.val) };\n  }\n\n  // public/js/lib/util.js\n  function createBufferShim() {\n    class ByteBuf2 extends Uint8Array {\n      static from(value, encoding = "utf8") {\n        if (value instanceof Uint8Array) return new ByteBuf2(value);\n        if (value instanceof ArrayBuffer) return new ByteBuf2(new Uint8Array(value));\n        if (Array.isArray(value)) return new ByteBuf2(Uint8Array.from(value));\n        if (typeof value === "string") {\n          if (encoding === "hex") return new ByteBuf2(hexToBytes(value));\n          if (encoding === "base64") return new ByteBuf2(base64ToBytes(value));\n          if (encoding === "latin1" || encoding === "binary") {\n            const out = new Uint8Array(value.length);\n            for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;\n            return new ByteBuf2(out);\n          }\n          return new ByteBuf2(utf8Encode(value));\n        }\n        return new ByteBuf2(0);\n      }\n      static alloc(size) {\n        return new ByteBuf2(size);\n      }\n      static concat(list) {\n        return new ByteBuf2(concatBytes(...list.map((b) => b instanceof Uint8Array ? b : ByteBuf2.from(b))));\n      }\n      static isBuffer(v) {\n        return v instanceof ByteBuf2 || v instanceof Uint8Array;\n      }\n      toString(encoding = "utf8") {\n        if (encoding === "hex") return bytesToHex(this);\n        if (encoding === "base64") return bytesToBase64(this);\n        if (encoding === "latin1" || encoding === "binary") return latin1Decode(this);\n        return utf8Decode(this);\n      }\n      toStringUtf8() {\n        return utf8Decode(this);\n      }\n    }\n    return ByteBuf2;\n  }\n  function bufToString(buf, format = "utf8") {\n    if (buf == null) return "";\n    if (typeof buf === "string") return buf;\n    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);\n    if (format === "hex") return bytesToHex(bytes);\n    if (format === "base64") return bytesToBase64(bytes);\n    if (format === "latin1" || format === "binary") return latin1Decode(bytes);\n    return utf8Decode(bytes);\n  }\n  async function streamThrough(bytes, transform) {\n    const stream = new Blob([bytes]).stream().pipeThrough(transform);\n    return new Uint8Array(await new Response(stream).arrayBuffer());\n  }\n  async function inflateRaw(bytes) {\n    try {\n      return await streamThrough(bytes, new DecompressionStream("deflate-raw"));\n    } catch (e) {\n      return streamThrough(bytes, new DecompressionStream("deflate"));\n    }\n  }\n  async function deflateRaw(bytes) {\n    return streamThrough(bytes, new CompressionStream("deflate-raw"));\n  }\n\n  // public/js/lxworker.js\n  var EVENT_NAMES = { request: "request", inited: "inited", updateAlert: "updateAlert" };\n  var handlers = /* @__PURE__ */ new Map();\n  var pendingHttp = /* @__PURE__ */ new Map();\n  var httpSeq = 0;\n  var state = { inited: null, updateAlert: null };\n  var ByteBuf = createBufferShim();\n  function toBytes(v) {\n    if (v == null) return new Uint8Array(0);\n    if (v instanceof Uint8Array) return v;\n    if (v instanceof ArrayBuffer) return new Uint8Array(v);\n    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);\n    if (typeof v === "string") return utf8Encode(v);\n    if (Array.isArray(v)) return Uint8Array.from(v);\n    return utf8Encode(String(v));\n  }\n  function normalizeMode(mode) {\n    return String(mode || "cbc").toLowerCase().includes("ecb") ? "ecb" : "cbc";\n  }\n  var lx = {\n    version: "2.0.0",\n    env: "desktop",\n    EVENT_NAMES,\n    currentScriptInfo: null,\n    on(eventName, handler) {\n      if (typeof handler === "function") handlers.set(eventName, handler);\n    },\n    send(eventName, data) {\n      if (eventName === EVENT_NAMES.inited) state.inited = data || null;\n      else if (eventName === EVENT_NAMES.updateAlert) {\n        if (!state.updateAlert) state.updateAlert = data || null;\n      }\n    },\n    request(url, options, callback) {\n      let cancelled = false;\n      const id = ++httpSeq;\n      const payload = sanitizeOptions(options || {});\n      pendingHttp.set(id, (result) => {\n        if (cancelled) return;\n        if (result.error) return callback(new Error(result.error), null, null);\n        const resp = {\n          statusCode: result.status,\n          status: result.status,\n          headers: result.headers || {},\n          raw: result.raw,\n          body: result.body\n        };\n        callback(null, resp, resp.body);\n      });\n      self.postMessage({ type: "http", id, url: String(url), options: payload });\n      return function cancelHttp() {\n        cancelled = true;\n        pendingHttp.delete(id);\n      };\n    },\n    utils: {\n      buffer: {\n        from: (value, encoding) => ByteBuf.from(value, encoding),\n        bufToString: (buf, format) => bufToString(buf, format)\n      },\n      crypto: {\n        md5: (str) => md5(typeof str === "string" ? str : bufToString(str)),\n        randomBytes: (size) => ByteBuf.from(randomBytes(Number(size) || 16)),\n        aesEncrypt(buffer, mode, key, iv) {\n          return ByteBuf.from(aesEncryptRaw(toBytes(buffer), toBytes(key), normalizeMode(mode), iv ? toBytes(iv) : void 0));\n        },\n        aesDecrypt(buffer, mode, key, iv) {\n          return ByteBuf.from(aesDecryptRaw(toBytes(buffer), toBytes(key), normalizeMode(mode), iv ? toBytes(iv) : void 0));\n        },\n        rsaEncrypt(buffer, key) {\n          return ByteBuf.from(rsaEncryptRaw(toBytes(buffer), bufToString(key, "utf8")));\n        }\n      },\n      zlib: {\n        async inflate(buffer) {\n          return ByteBuf.from(await inflateRaw(toBytes(buffer)));\n        },\n        async deflate(buffer) {\n          return ByteBuf.from(await deflateRaw(toBytes(buffer)));\n        }\n      }\n    }\n  };\n  function sanitizeOptions(options) {\n    const out = {};\n    for (const key of ["method", "headers", "body", "form", "formData", "timeout", "json"]) {\n      const v = options[key];\n      if (v === void 0 || typeof v === "function") continue;\n      if (key === "headers" || key === "form" || key === "formData") {\n        if (v && typeof v === "object") {\n          const o = {};\n          for (const [k, val] of Object.entries(v)) {\n            if (val === void 0 || typeof val === "function") continue;\n            o[k] = typeof val === "string" ? val : String(val);\n          }\n          out[key] = o;\n        }\n        continue;\n      }\n      if (key === "body") {\n        out.body = typeof v === "string" ? v : safeStringify(v);\n        continue;\n      }\n      out[key] = v;\n    }\n    return out;\n  }\n  function safeStringify(v) {\n    try {\n      return JSON.stringify(v);\n    } catch (e) {\n      return String(v);\n    }\n  }\n  function waitForInited(timeout) {\n    const limit = Math.max(1e3, Number(timeout) || 8e3);\n    return new Promise((resolve) => {\n      const t0 = Date.now();\n      const tick = () => {\n        if (state.inited) return resolve(state.inited);\n        if (Date.now() - t0 >= limit) return resolve(null);\n        setTimeout(tick, 50);\n      };\n      tick();\n    });\n  }\n  function parseMeta(script) {\n    const head = String(script).slice(0, 4e3);\n    const block = head.match(/\\/\\*\\*([\\s\\S]*?)\\*\\//) || head.match(/\\/\\*([\\s\\S]*?)\\*\\//);\n    const region = block ? block[1] : head;\n    const meta = {};\n    for (const line of region.split("\\n")) {\n      const m = line.match(/@(\\w+)\\s+(.*)/);\n      if (!m) continue;\n      const key = m[1].toLowerCase();\n      if (["name", "version", "author", "description", "homepage", "repository"].includes(key)) {\n        meta[key] = m[2].trim().replace(/\\*\\/\\s*$/, "").trim();\n      }\n    }\n    return {\n      name: meta.name || "未命名音源",\n      version: meta.version || "1.0.0",\n      author: meta.author || "未知",\n      description: meta.description || "",\n      homepage: meta.homepage || meta.repository || ""\n    };\n  }\n  self.onmessage = async (event) => {\n    const msg = event.data || {};\n    try {\n      if (msg.type === "load") {\n        handlers.clear();\n        state = { inited: null, updateAlert: null };\n        const meta = parseMeta(msg.script);\n        lx.currentScriptInfo = __spreadProps(__spreadValues({}, meta), { rawScript: null });\n        globalThis.lx = lx;\n        const fn = new Function(String(msg.script));\n        fn.call(globalThis);\n        const inited = state.inited || await waitForInited(msg.initTimeout || 8e3);\n        if (!inited || !inited.sources || typeof inited.sources !== "object") {\n          throw new Error("脚本未发送 inited 事件或未声明 sources");\n        }\n        self.postMessage({\n          type: "loaded",\n          id: msg.id,\n          meta,\n          sources: inited.sources,\n          updateAlert: state.updateAlert || null\n        });\n        return;\n      }\n      if (msg.type === "invoke") {\n        const handler = handlers.get(EVENT_NAMES.request);\n        if (!handler) throw new Error("插件未注册 request 处理器");\n        const result = await Promise.resolve(handler({ source: msg.source, action: msg.action, info: msg.info }));\n        self.postMessage({ type: "result", id: msg.id, result });\n        return;\n      }\n      if (msg.type === "httpResponse") {\n        const resolve = pendingHttp.get(msg.id);\n        if (resolve) {\n          pendingHttp.delete(msg.id);\n          resolve(msg.result || { error: "empty" });\n        }\n        return;\n      }\n    } catch (e) {\n      self.postMessage({ type: "error", id: msg.id, error: String(e && e.message || e), stage: msg.type });\n    }\n  };\n  self.postMessage({ type: "ready" });\n})();\n',
    crypto: crypto_exports,
    util: util_exports,
    // 便于「APK 里的运行时是不是当前源码」一眼可比（同 build-app.mjs 的源摘要思路）
    SOURCE_DIGEST: "591c544b99fc8066",
    TARGET: "es2017"
  };
})();
