/**
 * background.js – KSeF Monitor Service Worker (MV3)
 *
 * Odpowiedzialności:
 *  - Utrzymanie alarmu chrome.alarms
 *  - Pełny cykl pollingu: odczyt tokenu → auth → zapytanie → powiadomienie
 *  - Obsługa 429 z backoffem
 *  - Obsługa wygasłej sesji: needsPin = true, ZERO backoffu
 *  - Badge z licznikiem nieprzejrzanych faktur
 */

import { decryptToken, encryptToken } from './crypto-utils.js';
import { KSeFClient, KSeFError, authenticateWithToken } from './ksef-api.js';
import {
	getConfig,
	saveConfig,
	getEncryptedToken,
	saveEncryptedToken,
	hasToken,
	getAuthState,
	saveAuthState,
	clearAuthState,
	getPollState,
	savePollState,
	recordPollSuccess,
	recordPollError,
	recordNeedsPin,
	recordNeedsNewToken,
	recordRateLimit,
	getInvoiceState,
	saveInvoiceState,
	updateInvoices,
	initializeArchive,
	ensureArchiveBackfill,
	markNoticed,
	undoNoticed,
	markAllNoticed,
	dismissFromArchive,
	undoDismissArchive,
} from './storage.js';

const ALARM_NAME = 'ksef-poll';

// ─── Session storage – token KSeF w pamięci (czyszczony przy zamknięciu przeglądarki) ──

const SESSION_KEY = 'ksefTokenPlain';

async function getSessionToken() {
	try {
		const r = await chrome.storage.session.get(SESSION_KEY);
		return r[SESSION_KEY] ?? null;
	} catch {
		return null;
	}
}

async function saveSessionToken(plainToken) {
	try {
		await chrome.storage.session.set({ [SESSION_KEY]: plainToken });
	} catch {
		/* ignoruj */
	}
}

// ─── Start ────────────────────────────────────────────────────────────────────

chrome.alarms.get(ALARM_NAME, async (alarm) => {
	if (!alarm) {
		const config = await getConfig();
		await createPollAlarm(config.pollIntervalMinutes);
	}
});

// Przywróć badge po restarcie przeglądarki (zimny start SW)
chrome.runtime.onStartup.addListener(async () => {
	await restoreBadgeFromState();
	const alarm = await chrome.alarms.get(ALARM_NAME);
	if (!alarm) {
		const config = await getConfig();
		await createPollAlarm(config.pollIntervalMinutes);
	}
	await runPoll();
});

// ─── Alarm ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === ALARM_NAME) {
		if (!(await hasToken())) return;
		await runPoll();
	} else if (alarm.name === RESTORE_ALARM) {
		const config = await getConfig();
		await chrome.alarms.clear(ALARM_NAME);
		await createPollAlarm(config.pollIntervalMinutes);
	}
});

// ─── Wiadomości ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	(async () => {
		try {
			switch (message.type) {
				case 'POLL_NOW':
					await runPoll(message.pin);
					sendResponse({ ok: true });
					break;

				case 'TEST_TOKEN_PLAIN': {
					// Testuje plain token bez szyfrowania – używane w onboardingu przed krokiem PIN
					try {
						const { token: plainToken, environment, nip } = message;
						const auth = await authenticateWithToken(plainToken, nip, environment);
						// Szybki test – nie zapisujemy authState, nie inicjalizujemy archiwum
						sendResponse({ ok: true, message: 'Token prawidłowy. Możesz ustawić PIN.' });
					} catch (err) {
						const is450 = err.status === 450 || err.code === 'AUTH_FAILED_450';
						sendResponse({
							ok: false,
							error: is450
								? 'Token unieważniony lub błędny. Wygeneruj nowy token w portalu KSeF.'
								: err.message || 'Błąd autoryzacji',
							code: err.code || (is450 ? 'AUTH_FAILED_450' : 'AUTH_ERROR'),
						});
					}
					break;
				}

				case 'SETUP_TOKEN': {
					await chrome.alarms.clear(ALARM_NAME);
					try {
						const result = await testConnection(message.pin);
						sendResponse({ ok: true, ...result });
					} finally {
						const cfg = await getConfig();
						await createPollAlarm(cfg.pollIntervalMinutes);
					}
					break;
				}

				case 'UPDATE_INTERVAL': {
					const config = await getConfig();
					config.pollIntervalMinutes = message.minutes;
					await chrome.storage.local.set({ config });
					await chrome.alarms.clear(ALARM_NAME);
					await createPollAlarm(message.minutes);
					sendResponse({ ok: true });
					break;
				}

				case 'CLEAR_BACKOFF':
					await chrome.storage.local.set({
						pollState: {
							consecutiveErrors: 0,
							backoffUntil: null,
							needsPin: false,
							lastPollTime: null,
							lastSuccessTime: null,
							lastError: null,
						},
					});
					sendResponse({ ok: true });
					break;

				case 'UPDATE_TOKEN': {
					// Zaszyfruj nowy token tym samym PIN-em i zapisz
					const { token: newKsefToken, pin: tokenPin, nip: newNip } = message;
					if (!newKsefToken || !tokenPin) {
						sendResponse({ ok: false, error: 'Brak tokenu lub PIN-u.' });
						break;
					}
					const encrypted = await encryptToken(newKsefToken, tokenPin);
					await saveEncryptedToken(encrypted);
					if (newNip) {
						const cfg = await getConfig();
						await saveConfig({ ...cfg, nip: newNip });
					}
					// Wyczyść stary stan sesji i needsNewToken
					await clearAuthState();
					const ps = await getPollState();
					await savePollState({ ...ps, needsNewToken: false, needsPin: false });
					sendResponse({ ok: true });
					break;
				}

				case 'REINITIALIZE_ARCHIVE': {
					const { count, pendingCount } = await reinitializeArchive(message.pin ?? null);
					await setBadge(pendingCount);
					sendResponse({ ok: true, count });
					break;
				}

				case 'UNDO_DISMISS_ARCHIVE': {
					await undoDismissArchive(message.invoiceId);
					sendResponse({ ok: true });
					break;
				}

				case 'DISMISS_ARCHIVE': {
					await dismissFromArchive(message.invoiceId);
					sendResponse({ ok: true });
					break;
				}

				case 'MARK_NOTICED': {
					const invoice = await markNoticed(message.invoiceId);
					const inv = await getInvoiceState();
					await setBadge(inv.pendingInvoices.length);
					sendResponse({ ok: true, invoice });
					break;
				}

				case 'UNDO_NOTICED': {
					await undoNoticed(message.invoiceId);
					const inv = await getInvoiceState();
					await setBadge(inv.pendingInvoices.length);
					sendResponse({ ok: true });
					break;
				}

				case 'MARK_ALL_NOTICED': {
					await markAllNoticed();
					await setBadge(0);
					sendResponse({ ok: true });
					break;
				}

				case 'UNDO_MARK_ALL': {
					const invState = await getInvoiceState();
					const restoredInvoices = message.invoices ?? [];
					const restoredIds = new Set(restoredInvoices.map((i) => i.id));
					await saveInvoiceState({
						...invState,
						pendingInvoices: [...restoredInvoices, ...invState.pendingInvoices],
						recentArchive: invState.recentArchive.filter((i) => !restoredIds.has(i.id)),
					});
					await setBadge(restoredInvoices.length + invState.pendingInvoices.length);
					sendResponse({ ok: true });
					break;
				}

				default:
					sendResponse({ ok: false, error: 'Nieznany typ wiadomości' });
			}
		} catch (err) {
			console.error('[KSeF Monitor] Błąd obsługi wiadomości:', err);
			sendResponse({
				ok: false,
				error: [err.message, err.code ? `[${err.code}]` : '', err.status ? `HTTP ${err.status}` : '']
					.filter(Boolean)
					.join(' '),
				code: err.code,
				status: err.status,
			});
		}
	})();
	return true;
});

// ─── Polling ──────────────────────────────────────────────────────────────────

async function runPoll(pin = null) {
	if (!(await hasToken())) return;

	const ps = await getPollState();
	if (ps.needsPin && !pin) return;
	if (ps.backoffUntil && new Date(ps.backoffUntil) > new Date()) return;

	const config = await getConfig();
	const client = new KSeFClient(config.environment);

	try {
		const accessToken = await getOrRefreshAccessToken(config, pin, client, ps);

		const invState = await getInvoiceState();
		const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3_600_000);
		// since = lastQueryTime ale nie starszy niż 90 dni
		const since = invState.lastQueryTime
			? new Date(Math.max(new Date(invState.lastQueryTime).getTime(), ninetyDaysAgo.getTime()))
			: ninetyDaysAgo;

		const { invoices } = await client.queryInvoiceMetadata(accessToken, since);
		const newCount = await updateInvoices(invoices);

		// Jeśli archiwum jest puste (migracja / pierwsze uruchomienie bez onboardingu),
		// backfilluj je z faktur które już znamy – bez wpływu na licznik
		await ensureArchiveBackfill(invoices);
		const updated = await getInvoiceState();

		await setBadge(updated.pendingInvoices.length);

		if (newCount > 0) {
			await maybeNotify(newCount, updated.pendingInvoices.slice(-newCount));
		}

		await recordPollSuccess();
	} catch (err) {
		if (err instanceof KSeFError) {
			if (err.status === 450 || err.code === 'AUTH_FAILED_450') {
				await clearAuthState();
				await recordNeedsNewToken(err.message ?? 'Token unieważniony lub błędny.');
			} else if (err.status === 401 || err.status === 403 || err.code === 'AUTH_REQUIRED') {
				await clearAuthState();
				await recordNeedsPin();
				// Nie nadpisujemy badge czerwonym ! – pokazujemy ostatni znany stan faktur.
				// Użytkownik zobaczy prośbę o PIN dopiero gdy otworzy popup.
				await restoreBadgeFromState();
				await maybeNotifyNeedsPin();
				return;
			}
			if (err.status === 429) {
				await recordRateLimit(err.retryAfter ?? 3600);
				await rescheduleAlarmAfterBackoff(err.retryAfter ?? 3600);
				return;
			}
		}
		await recordPollError(err.code ?? 'UNKNOWN', err.message ?? 'Nieznany błąd');
		const pollState = await getPollState();
		if (pollState.consecutiveErrors >= 3) {
			await notifyError('❌ KSeF Monitor: błąd połączenia', err.message?.substring(0, 80) ?? '');
		}
	}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getOrRefreshAccessToken(config, pin, client, ps) {
	const auth = await getAuthState();
	const pinRequired = ps.needsPin; // ps przekazany z runPoll – bez podwójnego odczytu

	// Jeśli użytkownik podał PIN (tzn. ekran viewPin), zawsze weryfikuj go przez
	// deszyfrowanie – nie używaj cache'owanego tokenu. Inaczej dowolny PIN przejdzie.
	if (!pin || !pinRequired) {
		if (auth.accessToken && auth.accessTokenExpiry > Date.now() + 60_000) {
			return auth.accessToken;
		}

		if (auth.refreshToken && auth.refreshTokenExpiry > Date.now() + 60_000) {
			// Retry 3× z 30s przerwą – łapie chwilowy błąd sieci lub przejściowy 401
			// przy wybudzeniu komputera / krótkim zaniku połączenia.
			// Dopiero po wyczerpaniu prób ustawiamy needsPin.
			const REFRESH_RETRIES = 3;
			const REFRESH_DELAY_MS = 5_000; // krótki delay – SW może zasnąć przy długim setTimeout
			let lastRefreshErr;
			for (let attempt = 1; attempt <= REFRESH_RETRIES; attempt++) {
				try {
					const newAuth = await client.refreshAccessToken(auth.refreshToken);
					await saveAuthState(newAuth);

					return newAuth.accessToken;
				} catch (err) {
					lastRefreshErr = err;
					const retriable =
						!(err instanceof KSeFError) || // błąd sieci
						(err instanceof KSeFError && err.status >= 500) || // błąd serwera KSeF
						(err instanceof KSeFError && (err.status === 401 || err.status === 403)); // auth – też retry
					if (retriable && attempt < REFRESH_RETRIES) {
						await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
						continue;
					}
					break;
				}
			}
			// Po wyczerpaniu prób: błąd auth → needsPin, błąd sieci → propaguj (recordPollError)
			if (
				lastRefreshErr instanceof KSeFError &&
				(lastRefreshErr.status === 401 || lastRefreshErr.status === 403)
			) {
				throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
			}
			throw lastRefreshErr;
		}

		// Krok 3: refreshToken wygasł – spróbuj token KSeF z session storage (pamięć RAM)
		// Dostępny tylko gdy przeglądarka była otwarta nieprzerwanie od ostatniego PIN.
		// Przy zamknięciu przeglądarki session jest czyszczony → krok 4.
		const sessionToken = await getSessionToken();
		if (sessionToken) {
			try {
				await clearAuthState();
				const newAuth = await authenticateWithToken(sessionToken, config.nip, config.environment);
				await saveAuthState(newAuth);

				return newAuth.accessToken;
			} catch (err) {
				// Session token nieważny (unieważniony w portalu itp.) → wyczyść i idź do PIN

				await chrome.storage.session.remove(SESSION_KEY);
				if (err instanceof KSeFError && (err.status === 401 || err.status === 403 || err.status === 450)) {
					throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
				}
				throw err;
			}
		}
	}

	if (!pin) {
		throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
	}

	// Weryfikacja PIN: deszyfrowanie rzuci INVALID_PIN jeśli PIN błędny
	const encrypted = await getEncryptedToken();
	const ksefToken = await decryptToken(encrypted, pin);
	// PIN poprawny – wyczyść stary stan sesji i zaloguj od nowa
	await clearAuthState();
	const newAuth = await authenticateWithToken(ksefToken, config.nip, config.environment);
	await saveAuthState(newAuth);

	// Zapisz odszyfrowany token w session storage – umożliwi ciche re-auth po wygaśnięciu refreshToken
	await saveSessionToken(ksefToken);
	return newAuth.accessToken;
}

// ─── Test połączenia (onboarding) ─────────────────────────────────────────────

async function testConnection(pin) {
	const config = await getConfig();
	const encrypted = await getEncryptedToken();
	if (!encrypted) throw new Error('Brak zapisanego tokenu.');

	const ksefToken = await decryptToken(encrypted, pin);
	const auth = await authenticateWithToken(ksefToken, config.nip, config.environment);
	await saveAuthState(auth);
	await saveSessionToken(ksefToken);

	const client = new KSeFClient(config.environment);
	// Pobieramy ostatnie 90 dni na potrzeby inicjalizacji archiwum
	const since = new Date(Date.now() - 90 * 24 * 3_600_000);
	const result = await client.queryInvoiceMetadata(auth.accessToken, since);

	// Faktury z ostatnich 7 dni → pending (licznik), starsze → archive (szare)
	const pendingCount = await initializeArchive(result.invoices);
	await setBadge(pendingCount);
	await recordPollSuccess(); // żeby popup pokazał poprawny czas "Sprawdzono"

	return {
		authenticated: true,
		invoiceCount: pendingCount,
		message: `Połączono pomyślnie. Faktur z ostatnich 7 dni: ${pendingCount}`,
	};
}

// ─── Badge ────────────────────────────────────────────────────────────────────

// Odczytuje stan z storage i przywraca badge – używane przy zimnym starcie
// i przy przejściu w tryb needsPin (zamiast czerwonego !).
async function restoreBadgeFromState() {
	if (!(await hasToken())) return;
	const ps = await getPollState();
	if (ps.needsNewToken) {
		await setBadge(-1);
		return;
	}
	const inv = await getInvoiceState();
	await setBadge(inv.pendingInvoices.length);
}

async function setBadge(count) {
	if (count < 0) {
		await chrome.action.setBadgeText({ text: '!' });
		await chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
		return;
	}
	if (count === 0) {
		await chrome.action.setBadgeText({ text: '' });
		return;
	}
	await chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
	await chrome.action.setBadgeBackgroundColor({ color: '#1565c0' });
}

// ─── Powiadomienia ────────────────────────────────────────────────────────────

async function maybeNotify(count, invoices) {
	const config = await getConfig();
	if (!config.notificationsEnabled) return;

	const noun = count === 1 ? 'nowa faktura' : count < 5 ? 'nowe faktury' : 'nowych faktur';
	const items = invoices.slice(0, 4).map((inv) => ({
		title: truncate(inv.sellerName, 40),
		message: inv.invoiceNumber || inv.issueDate?.substring(0, 10) || '',
	}));

	await chrome.notifications.create('ksef-new-invoices', {
		type: items.length > 1 ? 'list' : 'basic',
		iconUrl: 'icons/icon48.png',
		title: `📄 KSeF: ${count} ${noun}`,
		message: items[0]?.title ?? 'Otwórz rozszerzenie, aby zobaczyć',
		items: items.length > 1 ? items : undefined,
		requireInteraction: false,
	});
}

async function maybeNotifyNeedsPin() {
	const config = await getConfig();
	if (!config.notificationsEnabled) return;
	await chrome.notifications.create('ksef-needs-pin', {
		type: 'basic',
		iconUrl: 'icons/icon48.png',
		title: '🔑 KSeF Monitor: wymagane zalogowanie',
		message: 'Sesja wygasła. Kliknij ikonę rozszerzenia i wprowadź PIN.',
		requireInteraction: true,
	});
}

async function notifyError(title, message) {
	await chrome.notifications.create('ksef-error', {
		type: 'basic',
		iconUrl: 'icons/icon48.png',
		title,
		message,
	});
}

// ─── Alarm helpers ────────────────────────────────────────────────────────────

async function createPollAlarm(intervalMinutes) {
	await chrome.alarms.create(ALARM_NAME, {
		delayInMinutes: intervalMinutes,
		periodInMinutes: intervalMinutes,
	});
}

async function reinitializeArchive(pin = null) {
	const config = await getConfig();
	const client = new KSeFClient(config.environment);
	const token = await getOrRefreshAccessToken(config, pin, client);
	const since = new Date(Date.now() - 90 * 24 * 3_600_000);
	const result = await client.queryInvoiceMetadata(token, since);
	const pendingCount = await initializeArchive(result.invoices);
	return { count: result.invoices.length, pendingCount };
}

const RESTORE_ALARM = 'ksef-poll-restore';

// RESTORE_ALARM obsługiwany w głównym listenerze onAlarm powyżej

async function rescheduleAlarmAfterBackoff(retryAfterSeconds) {
	await chrome.alarms.clear(ALARM_NAME);
	const config = await getConfig();
	const backoffMin = Math.max(config.pollIntervalMinutes, Math.ceil(retryAfterSeconds / 60));
	await createPollAlarm(backoffMin);
	// Zaplanuj przywrócenie normalnego interwału przez alarm (nie setTimeout – SW może zasnąć)
	await chrome.alarms.create(RESTORE_ALARM, {
		delayInMinutes: backoffMin + 1,
	});
}

function truncate(str, max) {
	if (!str) return '';
	return str.length <= max ? str : str.substring(0, max - 1) + '…';
}
