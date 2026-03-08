/**
 * crypto-utils.js – KSeF Watcher
 *
 * 1. AES-256-GCM  – lokalny storage (klucz z PIN-u przez PBKDF2)
 * 2. RSA-OAEP     – szyfrowanie tokenu kluczem publicznym KSeF (auth API)
 *
 * Uwaga dot. formatu klucza z API:
 *  GET /security/public-key-certificates może zwrócić:
 *   a) pełny certyfikat X.509 w DER (Base64) – trzeba wyciągnąć SPKI
 *   b) sam SPKI w DER (Base64) – używamy bezpośrednio
 *   c) PEM (z nagłówkiem "-----BEGIN...") – usuwamy nagłówki
 *
 *  extractSPKIFromDER używa prawdziwego parsera TLV (ASN.1 BER/DER),
 *  a nie heurystycznego szukania offsetów.
 */

// ═══════════════════════════════════════════════════════════════════
// 1. AES-256-GCM
// ═══════════════════════════════════════════════════════════════════

export async function deriveKey(pin, salt) {
	const enc = new TextEncoder();
	const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptToken(plaintext, pin) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(pin, salt);
	const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
	return { ciphertext: bufToB64(buf), iv: bufToB64(iv.buffer), salt: bufToB64(salt.buffer) };
}

export async function decryptToken(stored, pin) {
	const key = await deriveKey(pin, b64ToBuf(stored.salt));
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64ToBuf(stored.iv) },
			key,
			b64ToBuf(stored.ciphertext),
		);
		return new TextDecoder().decode(plain);
	} catch {
		throw new Error("INVALID_PIN");
	}
}

// ═══════════════════════════════════════════════════════════════════
// 2. RSA-OAEP – szyfrowanie dla KSeF
// ═══════════════════════════════════════════════════════════════════

/**
 * Szyfruje "token|isoTimestamp" kluczem publicznym KSeF.
 * @param {string} ksefToken   – 40-znakowy token z portalu
 * @param {string} keyMaterial – Base64 lub PEM z certyfikatem/kluczem z API
 */
/**
 * Szyfruje token KSeF kluczem publicznym MF.
 * Wg spec KSeF API 2.0: RSA-OAEP z SHA-256, payload: "token|isoTimestamp"
 */
export async function encryptForKSeF(ksefToken, keyMaterial, timestamp) {
	const plaintext = `${ksefToken}|${timestamp}`;

	const spkiBytes = await resolveToSPKI(keyMaterial);

	let publicKey;
	try {
		publicKey = await crypto.subtle.importKey("spki", spkiBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
			"encrypt",
		]);
	} catch (e) {
		const hex = bufToHex(spkiBytes, 32);
		throw new Error(`importKey SPKI nieudany: ${e.message} | hex[:32]: ${hex}`);
	}

	const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, new TextEncoder().encode(plaintext));
	return bufToB64(encrypted);
}

/**
 * Rozwiązuje różne formaty wejściowe → ArrayBuffer z SPKI DER.
 * Obsługuje:
 *   • PEM (-----BEGIN CERTIFICATE----- lub -----BEGIN PUBLIC KEY-----)
 *   • raw Base64 DER (certyfikat X.509 lub goły SPKI)
 *   • ArrayBuffer / Uint8Array
 */
async function resolveToSPKI(material) {
	let derBytes;

	if (typeof material === "string") {
		const trimmed = material.trim();

		if (trimmed.startsWith("-----")) {
			// PEM → usuń nagłówki i zdekoduj Base64
			const b64 = trimmed.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
			derBytes = b64ToBuf(b64);
		} else {
			// Zakładamy Base64 DER
			derBytes = b64ToBuf(trimmed);
		}
	} else if (material instanceof ArrayBuffer) {
		derBytes = material;
	} else if (ArrayBuffer.isView(material)) {
		derBytes = material.buffer;
	} else {
		throw new Error("Nieznany format klucza publicznego z API KSeF");
	}

	const bytes = new Uint8Array(derBytes);

	// Sprawdź czy to już SPKI (zaczyna się od SEQUENCE zawierającego AlgorithmIdentifier RSA)
	if (looksLikeSPKI(bytes)) {
		return derBytes;
	}

	// Spróbuj wyodrębnić SPKI z pełnego certyfikatu X.509
	return extractSPKIFromCertDER(derBytes);
}

// ─── Parsowanie ASN.1 DER ────────────────────────────────────────────────────

/**
 * Czyta TLV (Tag-Length-Value) pod danym offsetem.
 * @returns {{ tag, valueStart, len, end, headerLen }}
 */
function readTLV(bytes, offset) {
	if (offset >= bytes.length) throw new Error(`ASN.1: offset ${offset} poza zakresem`);
	const tag = bytes[offset];
	let pos = offset + 1;

	let len;
	if (bytes[pos] < 0x80) {
		len = bytes[pos++];
	} else {
		const n = bytes[pos++] & 0x7f;
		if (n === 0 || n > 4) throw new Error(`ASN.1: nieprawidłowa długość (n=${n}) @ ${offset}`);
		len = 0;
		for (let i = 0; i < n; i++) len = (len << 8) | bytes[pos++];
	}

	return { tag, valueStart: pos, headerLen: pos - offset, len, end: pos + len };
}

/** Sprawdza czy bajty to SPKI (SEQUENCE zawierający AlgorithmIdentifier z OID RSA). */
function looksLikeSPKI(bytes) {
	if (bytes[0] !== 0x30) return false;
	try {
		const seq = readTLV(bytes, 0);
		// Pierwszy element SPKI to SEQUENCE (AlgorithmIdentifier)
		if (bytes[seq.valueStart] !== 0x30) return false;
		const alg = readTLV(bytes, seq.valueStart);
		// AlgorithmIdentifier zaczyna się od OID
		if (bytes[alg.valueStart] !== 0x06) return false;
		const oid = readTLV(bytes, alg.valueStart);
		// RSA OID: 2a 86 48 86 f7 0d 01 01 01
		const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
		if (oid.len !== RSA_OID.length) return false;
		return RSA_OID.every((b, i) => bytes[oid.valueStart + i] === b);
	} catch {
		return false;
	}
}

/**
 * Wyodrębnia SubjectPublicKeyInfo z pełnego certyfikatu X.509 DER.
 *
 * X.509 DER:
 *   SEQUENCE {              ← Certificate
 *     SEQUENCE {            ← TBSCertificate
 *       [0] version?
 *       INTEGER serial
 *       SEQUENCE sigAlg
 *       SEQUENCE issuer
 *       SEQUENCE validity
 *       SEQUENCE subject
 *       SEQUENCE spki       ← chcemy to
 *       ...
 *     }
 *     ...
 *   }
 */
function extractSPKIFromCertDER(derBuffer) {
	const bytes = new Uint8Array(derBuffer);

	// Wejdź do Certificate SEQUENCE
	if (bytes[0] !== 0x30) throw new Error("DER: oczekiwano SEQUENCE na początku certyfikatu");
	const cert = readTLV(bytes, 0);

	// Wejdź do TBSCertificate SEQUENCE
	if (bytes[cert.valueStart] !== 0x30) throw new Error("DER: oczekiwano TBSCertificate SEQUENCE");
	const tbs = readTLV(bytes, cert.valueStart);

	// Przejdź przez pola TBSCertificate aż znajdziemy SPKI
	let pos = tbs.valueStart;
	const tbsEnd = tbs.end;

	while (pos < tbsEnd) {
		const tlv = readTLV(bytes, pos);

		// SPKI to SEQUENCE zawierający AlgorithmIdentifier z OID RSA
		if (tlv.tag === 0x30) {
			const candidate = new Uint8Array(derBuffer, pos, tlv.headerLen + tlv.len);
			if (looksLikeSPKI(candidate)) {
				return derBuffer.slice(pos, pos + tlv.headerLen + tlv.len);
			}
		}

		pos = tlv.end;
		if (pos > tbsEnd) break;
	}

	// Fallback: szukaj SPKI w całym buforze
	for (let i = 0; i < bytes.length - 20; i++) {
		if (bytes[i] === 0x30) {
			try {
				const tlv = readTLV(bytes, i);
				const candidate = new Uint8Array(derBuffer, i, tlv.headerLen + tlv.len);
				if (looksLikeSPKI(candidate)) {
					return derBuffer.slice(i, i + tlv.headerLen + tlv.len);
				}
			} catch {}
		}
	}

	throw new Error(
		"Nie można wyodrębnić SPKI z certyfikatu. " +
			"Pierwsze bajty (hex): " +
			bufToHex(new Uint8Array(derBuffer), 16),
	);
}

// ─── Pomocnicze ──────────────────────────────────────────────────────────────

export function bufToB64(buffer) {
	const bytes = new Uint8Array(buffer);
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str);
}

export function b64ToBuf(b64) {
	const bin = atob(b64.replace(/\s/g, ""));
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}

function bufToHex(bytesOrBuf, limit = 16) {
	const bytes = bytesOrBuf instanceof Uint8Array ? bytesOrBuf : new Uint8Array(bytesOrBuf);
	return Array.from(bytes.slice(0, limit))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(" ");
}
