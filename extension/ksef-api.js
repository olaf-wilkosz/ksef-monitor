/**
 * ksef-api.js – Klient KSeF API 2.0
 *
 * Środowiska:
 *   production → https://api.ksef.mf.gov.pl/v2
 *   demo       → https://api-demo.ksef.mf.gov.pl/v2
 *   test       → https://api-test.ksef.mf.gov.pl/v2
 *
 * Przepływ autoryzacji tokenem KSeF:
 *   1. GET  /security/public-key-certificates  → certyfikat DER (KsefTokenEncryption)
 *   2. POST /auth/challenge                    → challenge + timestampMs
 *   3. RSA-OAEP encrypt("token|timestampMs")
 *   4. POST /auth/ksef-token                   → authenticationToken + referenceNumber
 *   5. GET  /auth/{referenceNumber}            → polling do status 200
 *   6. POST /auth/token/redeem                 → accessToken JWT + refreshToken
 *   7. POST /invoices/query/metadata           → metadane faktur zakupowych
 *   8. POST /auth/token/refresh                → odświeżenie accessToken
 */

import { encryptForKSeF } from './crypto-utils.js';

const BASE_URLS = {
	production: 'https://api.ksef.mf.gov.pl/v2',
	demo: 'https://api-demo.ksef.mf.gov.pl/v2',
	test: 'https://api-test.ksef.mf.gov.pl/v2',
};

// ── Klasa błędu ───────────────────────────────────────────────────────────────

export class KSeFError extends Error {
	constructor(status, code, message, retryAfter = null) {
		super(message);
		this.name = 'KSeFError';
		this.status = status;
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function apiRequest(baseUrl, path, options = {}) {
	const url = baseUrl + path;
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		...(options.headers || {}),
	};

	let res;
	try {
		res = await fetch(url, {
			method: options.method || 'GET',
			headers,
			body: options.body ? JSON.stringify(options.body) : undefined,
		});
	} catch (netErr) {
		throw new KSeFError(
			0,
			'NETWORK_ERROR',
			'Błąd sieci – sprawdź połączenie i dostępność serwera KSeF. Szczegóły: ' + netErr.message
		);
	}

	if (!res.ok) {
		const rawText = await res.text().catch(() => '');
		let body = {};
		try {
			body = JSON.parse(rawText);
		} catch {
			/* ignore */
		}

		if (res.status === 429) {
			const retryAfter = parseInt(res.headers.get('Retry-After') || '3600', 10);
			throw new KSeFError(429, 'RATE_LIMIT', 'Limit zapytań. Retry-After: ' + retryAfter + 's', retryAfter);
		}

		const detail =
			body.message ||
			body.description ||
			body.exceptionDescription ||
			body.exceptionDetailList?.[0]?.exceptionDescription ||
			body.error ||
			rawText.slice(0, 300) ||
			'Błąd HTTP ' + res.status;

		throw new KSeFError(res.status, body.code || body.exceptionCode || 'HTTP_' + res.status, detail);
	}

	if (res.status === 204) return null;
	return res.json();
}

// ── Klient KSeF ───────────────────────────────────────────────────────────────

export class KSeFClient {
	constructor(environment = 'production') {
		this.baseUrl = BASE_URLS[environment] || BASE_URLS.production;
		this.environment = environment;
	}

	// 1. Klucz publiczny MF
	async getPublicKey() {
		let data;
		try {
			data = await apiRequest(this.baseUrl, '/security/public-key-certificates');
		} catch (err) {
			if (err.code === 'NETWORK_ERROR') {
				throw new KSeFError(
					0,
					'NO_KEY',
					'Nie można połączyć się z API KSeF (' +
						this.baseUrl +
						'). ' +
						'Sprawdź środowisko i dostępność serwerów MF.'
				);
			}
			throw err;
		}

		if (!Array.isArray(data) || data.length === 0) {
			throw new KSeFError(0, 'NO_KEY', 'Brak certyfikatów w odpowiedzi API.');
		}

		const cert = data.find((c) => Array.isArray(c.usage) && c.usage.includes('KsefTokenEncryption')) || data[0];

		if (!cert?.certificate) {
			throw new KSeFError(0, 'NO_KEY', "Brak pola 'certificate' w odpowiedzi.");
		}
		return cert.certificate;
	}

	// 2. Challenge
	async getChallenge() {
		return await apiRequest(this.baseUrl, '/auth/challenge', { method: 'POST' });
	}

	// 5. Polling statusu autoryzacji
	async waitForAuth(referenceNumber, authToken, maxAttempts = 12) {
		for (let i = 0; i < maxAttempts; i++) {
			const data = await apiRequest(this.baseUrl, '/auth/' + referenceNumber, {
				headers: { Authorization: 'Bearer ' + authToken },
			});
			const statusCode = data?.status?.code || data?.statusCode || data?.processingCode;

			if (!statusCode || statusCode === 200 || data?.sessionToken || data?.accessToken) {
				return data;
			}
			if (statusCode >= 400) {
				throw new KSeFError(
					statusCode,
					'AUTH_FAILED_' + statusCode,
					'Autoryzacja odrzucona: ' + (data?.status?.description || String(statusCode))
				);
			}
			if (i < maxAttempts - 1) await sleep(3000);
		}
		throw new KSeFError(0, 'AUTH_TIMEOUT', 'Autoryzacja nie ukończyła się w czasie 36s.');
	}

	// 6. Odbierz access + refresh token
	async redeemToken(authToken, waitResult) {
		const sessionToken = waitResult?.sessionToken?.token || waitResult?.sessionToken || waitResult?.accessToken;
		if (sessionToken && typeof sessionToken === 'string' && sessionToken.startsWith('eyJ')) {
			return {
				accessToken: sessionToken,
				refreshToken: waitResult?.refreshToken?.token || waitResult?.refreshToken || null,
				accessTokenExpiry: getJWTExpiry(sessionToken),
				refreshTokenExpiry: Date.now() + 86_400_000,
			};
		}

		const data = await apiRequest(this.baseUrl, '/auth/token/redeem', {
			method: 'POST',
			headers: { Authorization: 'Bearer ' + authToken },
		});
		const access = data.accessToken?.token || data.accessToken;
		const refresh = data.refreshToken?.token || data.refreshToken;
		return {
			accessToken: access,
			refreshToken: refresh,
			accessTokenExpiry: getJWTExpiry(access),
			refreshTokenExpiry: data.refreshTokenExpiry
				? new Date(data.refreshTokenExpiry).getTime()
				: Date.now() + 86_400_000,
		};
	}

	// Odświeżenie accessToken
	async refreshAccessToken(refreshToken) {
		const data = await apiRequest(this.baseUrl, '/auth/token/refresh', {
			method: 'POST',
			body: { refreshToken },
		});
		return {
			accessToken: data.accessToken,
			refreshToken: data.refreshToken || refreshToken,
			accessTokenExpiry: getJWTExpiry(data.accessToken),
			refreshTokenExpiry: data.refreshTokenExpiry
				? new Date(data.refreshTokenExpiry).getTime()
				: Date.now() + 86_400_000,
		};
	}

	// 7. Metadane faktur zakupowych (Subject2 = nabywca)
	async queryInvoiceMetadata(accessToken, since) {
		const now = new Date();
		const threeMonAgo = new Date(now.getTime() - 90 * 24 * 3_600_000);
		const from = since > threeMonAgo ? since : threeMonAgo;

		const allInvoices = [];
		let continuationToken = null;
		let page = 0;

		do {
			const body = {
				subjectType: 'Subject2',
				dateRange: {
					from: from.toISOString(),
					to: now.toISOString(),
					dateType: 'Issue',
				},
				pageSize: 100,
			};
			if (continuationToken) body.continuationToken = continuationToken;

			const data = await apiRequest(this.baseUrl, '/invoices/query/metadata', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + accessToken },
				body,
			});

			if (data?.invoices) allInvoices.push(...data.invoices);
			else if (data?.items) allInvoices.push(...data.items);

			continuationToken = data?.continuationToken || null;
			if (++page > 20) break;
		} while (continuationToken);

		return { invoices: allInvoices, totalCount: allInvoices.length };
	}
}

// ── Pełny przepływ autoryzacji ────────────────────────────────────────────────

export async function authenticateWithToken(ksefToken, nip, environment) {
	const client = new KSeFClient(environment);
	const derB64 = await client.getPublicKey();
	const challenge = await client.getChallenge();

	// Payload: "token|timestampMs" – Unix timestamp w ms (nie ISO string!)
	// Źródło: CIRFMF/ksef-client-csharp → challenge.Timestamp.ToUnixTimeMilliseconds()
	const tsMs = String(challenge.timestampMs);
	const encryptedToken = await encryptForKSeF(ksefToken, derB64, tsMs);

	const authResponse = await apiRequest(client.baseUrl, '/auth/ksef-token', {
		method: 'POST',
		body: {
			contextIdentifier: { type: 'nip', value: nip },
			encryptedToken,
			challenge: challenge.challenge,
		},
	});

	const authTokenObj = authResponse.authenticationToken || authResponse.authToken;
	const authToken =
		authTokenObj && typeof authTokenObj === 'object'
			? authTokenObj.token || authTokenObj.value || String(authTokenObj)
			: authTokenObj;
	const refNo = authResponse.referenceNumber;

	const waitResult = await client.waitForAuth(refNo, authToken);
	return await client.redeemToken(authToken, waitResult);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function getJWTExpiry(jwt) {
	try {
		const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
		return payload.exp ? payload.exp * 1000 : Date.now() + 900_000;
	} catch {
		return Date.now() + 900_000;
	}
}
