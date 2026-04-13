/**
 * background.js – KSeF Monitor Service Worker (MV3)
 *
 * Odpowiedzialności:
 *  - Utrzymanie alarmów chrome.alarms (per NIP: ksef-poll-{nip})
 *  - Pełny cykl pollingu dla każdego NIP-a: auth → zapytanie → powiadomienie
 *  - Badge = zagregowana liczba nowych faktur ze wszystkich NIP-ów
 *  - Obsługa 429 z backoffem
 *  - Obsługa wygasłej sesji: needsPin = true, ZERO backoffu
 */

import { decryptToken, encryptToken }                    from './crypto-utils.js';
import { KSeFClient, KSeFError, authenticateWithToken }  from './ksef-api.js';
import {
	migrateToMultiNip,
	getConfig,
	saveConfig,
	getAccount,
	addAccount,
	removeAccount,
	getNipList,
	hasAnyAccount,
	getActiveNip,
	setActiveNip,
	getEncryptedToken,
	saveEncryptedToken,
	hasToken,
	getAuthState,
	saveAuthState,
	clearAuthState,
	getKsefTokenPlain,
	saveKsefTokenPlain,
	clearKsefTokenPlain,
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

const ALARM_PREFIX  = 'ksef-poll-';
const RESTORE_ALARM = 'ksef-poll-restore';

// ─── Start ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
	await migrateToMultiNip();
	await setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
	await migrateToMultiNip();
	await restoreBadgeFromState();
	await setupAlarms();
	// Poll wszystkich NIP-ów przy starcie
	const nips = await getNipList();
	for (const nip of nips) {
		await runPoll(nip);
	}
});

// Uruchom migrację przy pierwszym załadowaniu SW (np. po aktualizacji)
(async () => {
	await migrateToMultiNip();
	await setupAlarms();
})();

// ─── Alarm helpers ────────────────────────────────────────────────────────────

function alarmName(nip) {
	return `${ALARM_PREFIX}${nip}`;
}

function nipFromAlarm(name) {
	return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

async function setupAlarms() {
	if (!(await hasAnyAccount())) return;
	const config = await getConfig();
	const nips   = await getNipList();
	for (const nip of nips) {
		const account = await getAccount(nip);
		await ensureAlarm(nip, config.pollIntervalMinutes, account.pollOffset ?? 0);
	}
}

async function ensureAlarm(nip, intervalMinutes, offsetMs = 0) {
	const existing = await chrome.alarms.get(alarmName(nip));
	if (existing) return;
	const delayMs = intervalMinutes * 60_000 + offsetMs;
	await chrome.alarms.create(alarmName(nip), {
		delayInMinutes:  delayMs / 60_000,
		periodInMinutes: intervalMinutes,
	});
}

async function clearAlarm(nip) {
	await chrome.alarms.clear(alarmName(nip));
}

// ─── Alarm ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
	const nip = nipFromAlarm(alarm.name);
	if (nip) {
		if (!(await hasToken(nip))) return;
		await runPoll(nip);
		return;
	}
	if (alarm.name === RESTORE_ALARM) {
		// Przywróć normalne alarmy po backoffie
		await setupAlarms();
	}
});

// ─── Wiadomości ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	(async () => {
		try {
			// Większość wiadomości operuje na activeNip – pobieramy go raz
			const activeNip = await getActiveNip();

			switch (message.type) {
				case 'POLL_NOW': {
					const nip = message.nip ?? activeNip;
					if (!nip) { sendResponse({ ok: false, error: 'Brak aktywnego NIP-a' }); break; }
					await runPoll(nip, message.pin);
					const psAfter = await getPollState(nip);
					sendResponse({ ok: !psAfter.needsPin && !psAfter.needsNewToken });
					break;
				}

				case 'TEST_TOKEN_PLAIN': {
					try {
						const { token: plainToken, environment, nip } = message;
						await authenticateWithToken(plainToken, nip, environment);
						sendResponse({ ok: true, message: 'Token prawidłowy. Możesz ustawić PIN.' });
					} catch (err) {
						const is450 = err.status === 450 || err.code === 'AUTH_FAILED_450';
						sendResponse({
							ok:    false,
							error: is450
								? 'Token unieważniony lub błędny. Wygeneruj nowy token w portalu KSeF.'
								: err.message || 'Błąd autoryzacji',
							code:  err.code || (is450 ? 'AUTH_FAILED_450' : 'AUTH_ERROR'),
						});
					}
					break;
				}

				case 'SETUP_TOKEN': {
					// Onboarding: zaszyfruj token, dodaj konto, zainicjalizuj archiwum
					const { pin, nip, environment, companyName } = message;
					try {
						const cfg        = await getConfig();
						const encrypted  = await getEncryptedToken(nip);
						// encryptedToken już zapisany przez onboarding.js przed wysłaniem wiadomości
						const result     = await testConnection(nip, pin);
						sendResponse({ ok: true, ...result });
					} catch (err) {
						sendResponse({ ok: false, error: err.message });
					}
					break;
				}

				case 'ADD_ACCOUNT': {
					// Dodaje nowe konto i uruchamia dla niego alarm
					const { nip, encryptedToken, companyName, environment } = message;
					// Blokuj duplikaty
					const existing = await getAccount(nip);
					if (existing) {
						sendResponse({ ok: false, error: `NIP ${nip} jest już skonfigurowany.` });
						break;
					}
					const cfg = await getConfig();
					await addAccount(nip, {
						encryptedToken,
						companyName,
						environment,
						intervalMs: cfg.pollIntervalMinutes * 60_000,
					});
					// Ustaw ten NIP jako aktywny jeśli to pierwszy
					const nips = await getNipList();
					if (nips.length === 1) await setActiveNip(nip);
					const account = await getAccount(nip);
					await ensureAlarm(nip, cfg.pollIntervalMinutes, account.pollOffset ?? 0);
					sendResponse({ ok: true });
					break;
				}

				case 'REMOVE_ACCOUNT': {
					const { nip } = message;
					await clearAlarm(nip);
					await clearKsefTokenPlain(nip);
					await clearAuthState(nip);
					const remaining = await removeAccount(nip);
					// Jeśli brak kont – wyczyść badge
					if (remaining.length === 0) {
						await chrome.action.setBadgeText({ text: '' });
					} else {
						await restoreBadgeFromState();
					}
					sendResponse({ ok: true, remaining });
					break;
				}

				case 'OPEN_ONBOARDING': {
					const { mode } = message;
					const url = chrome.runtime.getURL(`onboarding.html${mode === 'add' ? '?mode=add' : ''}`);
					const W = 580, H = 680, MARGIN = 16;
					let left = 100, top = 60;
					try {
						const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
						if (win) {
							left = (win.left ?? 0) + (win.width ?? 1200) - W - MARGIN;
							top  = (win.top  ?? 0) + MARGIN;
						}
					} catch {}
					await chrome.windows.create({ url, type: 'popup', width: W, height: H, left, top, focused: true });
					sendResponse({ ok: true });
					break;
				}

				case 'SET_ACTIVE_NIP': {
					await setActiveNip(message.nip);
					sendResponse({ ok: true });
					break;
				}

				case 'UPDATE_INTERVAL': {
					const cfg = await getConfig();
					cfg.pollIntervalMinutes = message.minutes;
					await saveConfig(cfg);
					// Przelicz alarmy dla wszystkich NIP-ów
					const nips = await getNipList();
					for (const nip of nips) {
						await clearAlarm(nip);
					}
					await setupAlarms();
					sendResponse({ ok: true });
					break;
				}

				case 'CLEAR_BACKOFF': {
					const nip = message.nip ?? activeNip;
					if (!nip) { sendResponse({ ok: true }); break; }
					const ps = await getPollState(nip);
					await savePollState(nip, {
						...ps,
						consecutiveErrors: 0,
						backoffUntil:      null,
						needsPin:          false,
						lastError:         null,
					});
					sendResponse({ ok: true });
					break;
				}

				case 'VERIFY_PIN': {
					// Weryfikacja PIN przez próbę deszyfrowania – używana przy UI-lock
					const nip = activeNip ?? (await getNipList())[0];
					if (!nip) { sendResponse({ ok: false, error: 'Brak konta' }); break; }
					try {
						const encrypted = await getEncryptedToken(nip);
						if (!encrypted) { sendResponse({ ok: false, error: 'Brak tokenu' }); break; }
						await decryptToken(encrypted, message.pin);
						sendResponse({ ok: true });
					} catch {
						sendResponse({ ok: false, error: 'INVALID_PIN' });
					}
					break;
				}

				case 'UPDATE_TOKEN': {
					// Nowy token po unieważnieniu (viewNewToken)
					const { token: newKsefToken, pin: tokenPin, nip: msgNip } = message;
					const nip = msgNip ?? activeNip;
					if (!newKsefToken || !tokenPin || !nip) {
						sendResponse({ ok: false, error: 'Brak tokenu, PIN-u lub NIP-a.' });
						break;
					}
					const encrypted = await encryptToken(newKsefToken, tokenPin);
					await saveEncryptedToken(nip, encrypted);
					await clearAuthState(nip);
					const ps = await getPollState(nip);
					await savePollState(nip, { ...ps, needsNewToken: false, needsPin: false });
					sendResponse({ ok: true });
					break;
				}

				case 'REINITIALIZE_ARCHIVE': {
					const nip = message.nip ?? activeNip;
					if (!nip) { sendResponse({ ok: false, error: 'Brak aktywnego NIP-a' }); break; }
					const { count, pendingCount } = await reinitializeArchive(nip, message.pin ?? null);
					await updateTotalBadge();
					sendResponse({ ok: true, count });
					break;
				}

				case 'UNDO_DISMISS_ARCHIVE': {
					const nip = message.nip ?? activeNip;
					await undoDismissArchive(nip, message.invoiceId);
					sendResponse({ ok: true });
					break;
				}

				case 'DISMISS_ARCHIVE': {
					const nip = message.nip ?? activeNip;
					await dismissFromArchive(nip, message.invoiceId);
					sendResponse({ ok: true });
					break;
				}

				case 'MARK_NOTICED': {
					const nip = message.nip ?? activeNip;
					await markNoticed(nip, message.invoiceId);
					await updateTotalBadge();
					sendResponse({ ok: true });
					break;
				}

				case 'UNDO_NOTICED': {
					const nip = message.nip ?? activeNip;
					await undoNoticed(nip, message.invoiceId);
					await updateTotalBadge();
					sendResponse({ ok: true });
					break;
				}

				case 'MARK_ALL_NOTICED': {
					const nip = message.nip ?? activeNip;
					await markAllNoticed(nip);
					await updateTotalBadge();
					sendResponse({ ok: true });
					break;
				}

				case 'UNDO_MARK_ALL': {
					const nip      = message.nip ?? activeNip;
					const invState = await getInvoiceState(nip);
					const restored = message.invoices ?? [];
					const restoredIds = new Set(restored.map((i) => i.id));
					await saveInvoiceState(nip, {
						...invState,
						pendingInvoices: [...restored, ...invState.pendingInvoices],
						recentArchive:   invState.recentArchive.filter((i) => !restoredIds.has(i.id)),
					});
					await updateTotalBadge();
					sendResponse({ ok: true });
					break;
				}

			// Zwraca listę NIP-ów z ich pollState i liczbą pending – dla popup NipSelector
				case 'GET_ACCOUNTS_SUMMARY': {
					const nips    = await getNipList();
					const summary = await Promise.all(nips.map(async (nip) => {
						const account = await getAccount(nip);
						return {
							nip,
							companyName:  account.companyName,
							environment:  account.environment,
							pendingCount: account.invoiceState?.pendingInvoices?.length ?? 0,
							pollState:    account.pollState,
							authState:    account.authState,
							invoiceState: account.invoiceState ?? { allSeenIds: [], pendingInvoices: [], recentArchive: [], lastQueryTime: null },
						};
					}));
					sendResponse({ ok: true, accounts: summary, activeNip });
					break;
				}

				default:
					sendResponse({ ok: false, error: 'Nieznany typ wiadomości' });
			}
		} catch (err) {
			console.error('[KSeF Monitor] Błąd obsługi wiadomości:', err);
			sendResponse({
				ok:     false,
				error:  [err.message, err.code ? `[${err.code}]` : '', err.status ? `HTTP ${err.status}` : '']
					.filter(Boolean)
					.join(' '),
				code:   err.code,
				status: err.status,
			});
		}
	})();
	return true;
});

// ─── Polling ──────────────────────────────────────────────────────────────────

async function runPoll(nip, pin = null) {
	if (!(await hasToken(nip))) return;

	const ps = await getPollState(nip);
	if (ps.needsPin && !pin) return;
	if (ps.backoffUntil && new Date(ps.backoffUntil) > new Date()) return;

	const account = await getAccount(nip);
	const config  = await getConfig();
	const client  = new KSeFClient(account.environment);

	try {
		const accessToken = await getOrRefreshAccessToken(nip, config, pin, client, ps);

		const invState     = await getInvoiceState(nip);
		const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3_600_000);
		const since = invState.lastQueryTime
			? new Date(Math.max(new Date(invState.lastQueryTime).getTime(), ninetyDaysAgo.getTime()))
			: ninetyDaysAgo;

		const { invoices } = await client.queryInvoiceMetadata(accessToken, since);
		const newCount     = await updateInvoices(nip, invoices);

		await ensureArchiveBackfill(nip, invoices);
		const updated = await getInvoiceState(nip);

		await updateTotalBadge();

		if (newCount > 0) {
			await maybeNotify(newCount, updated.pendingInvoices.slice(-newCount), account.companyName);
		}

		await recordPollSuccess(nip);
	} catch (err) {
		if (err instanceof KSeFError) {
			if (err.status === 450 || err.code === 'AUTH_FAILED_450') {
				await clearAuthState(nip);
				await recordNeedsNewToken(nip, err.message ?? 'Token unieważniony lub błędny.');
			} else if (err.status === 401 || err.status === 403 || err.code === 'AUTH_REQUIRED') {
				await recordNeedsPin(nip);
				await restoreBadgeFromState();
				await maybeNotifyNeedsPin(account.companyName);
				return;
			}
			if (err.status === 429) {
				await recordRateLimit(nip, err.retryAfter ?? 3600);
				await rescheduleAlarmAfterBackoff(nip, err.retryAfter ?? 3600);
				return;
			}
		}
		await recordPollError(nip, err.code ?? 'UNKNOWN', err.message ?? 'Nieznany błąd');
		const ps = await getPollState(nip);
		if (ps.consecutiveErrors >= 3) {
			await notifyError('❌ KSeF Monitor: błąd połączenia', err.message?.substring(0, 80) ?? '');
		}
	}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getOrRefreshAccessToken(nip, config, pin, client, ps) {
	const auth       = await getAuthState(nip);
	const account    = await getAccount(nip);
	const pinRequired = ps.needsPin;

	if (!pin || !pinRequired) {
		// 1. accessToken z session storage
		if (auth.accessToken && auth.accessTokenExpiry > Date.now() + 60_000) {
			return auth.accessToken;
		}

		// 2. refreshToken z local storage
		if (auth.refreshToken && auth.refreshTokenExpiry > Date.now() + 60_000) {
			const REFRESH_RETRIES  = 3;
			const REFRESH_DELAY_MS = 5_000;
			let lastRefreshErr;
			for (let attempt = 1; attempt <= REFRESH_RETRIES; attempt++) {
				try {
					const newAuth = await client.refreshAccessToken(auth.refreshToken);
					await saveAuthState(nip, newAuth);
					return newAuth.accessToken;
				} catch (err) {
					lastRefreshErr = err;
					const retriable =
						!(err instanceof KSeFError) ||
						(err instanceof KSeFError && err.status >= 500);
					if (retriable && attempt < REFRESH_RETRIES) {
						await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
						continue;
					}
					break;
				}
			}
			if (
				lastRefreshErr instanceof KSeFError &&
				(lastRefreshErr.status === 401 || lastRefreshErr.status === 403)
			) {
				throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
			}
			throw lastRefreshErr;
		}

		// 3. ksefTokenPlain z session storage (RAM)
		const sessionToken = await getKsefTokenPlain(nip);
		if (sessionToken) {
			try {
				await clearAuthState(nip);
				const newAuth = await authenticateWithToken(sessionToken, nip, account.environment);
				await saveAuthState(nip, newAuth);
				return newAuth.accessToken;
			} catch (err) {
				await clearKsefTokenPlain(nip);
				if (err instanceof KSeFError && (err.status === 401 || err.status === 403 || err.status === 450)) {
					throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
				}
				throw err;
			}
		}
	}

	// 4. Deszyfrowanie przez PIN
	if (!pin) {
		throw new KSeFError(401, 'AUTH_REQUIRED', 'Sesja wygasła. Otwórz rozszerzenie i wprowadź PIN.');
	}

	const encrypted  = await getEncryptedToken(nip);
	const ksefToken  = await decryptToken(encrypted, pin);
	await clearAuthState(nip);
	const newAuth = await authenticateWithToken(ksefToken, nip, account.environment);
	await saveAuthState(nip, newAuth);
	await saveKsefTokenPlain(nip, ksefToken);
	return newAuth.accessToken;
}

// ─── Test połączenia (onboarding) ─────────────────────────────────────────────

async function testConnection(nip, pin) {
	const account   = await getAccount(nip);
	const encrypted = await getEncryptedToken(nip);
	if (!encrypted) throw new Error('Brak zapisanego tokenu.');

	const ksefToken = await decryptToken(encrypted, pin);
	const auth      = await authenticateWithToken(ksefToken, nip, account.environment);
	await saveAuthState(nip, auth);
	await saveKsefTokenPlain(nip, ksefToken);

	const client = new KSeFClient(account.environment);
	const since  = new Date(Date.now() - 90 * 24 * 3_600_000);
	const result = await client.queryInvoiceMetadata(auth.accessToken, since);

	const pendingCount = await initializeArchive(nip, result.invoices);
	await updateTotalBadge();
	await recordPollSuccess(nip);

	return {
		authenticated: true,
		invoiceCount:  pendingCount,
		message:       `Połączono pomyślnie. Faktur z bieżącego miesiąca: ${pendingCount}`,
	};
}

// ─── Badge (zagregowany) ──────────────────────────────────────────────────────

async function updateTotalBadge() {
	const nips  = await getNipList();
	let total   = 0;
	let hasAnyNeedsNewToken = false;

	for (const nip of nips) {
		const account = await getAccount(nip);
		if (account?.pollState?.needsNewToken) { hasAnyNeedsNewToken = true; break; }
		total += account?.invoiceState?.pendingInvoices?.length ?? 0;
	}

	if (hasAnyNeedsNewToken) {
		await setBadge(-1);
	} else {
		await setBadge(total);
	}
}

async function restoreBadgeFromState() {
	if (!(await hasAnyAccount())) return;
	await updateTotalBadge();
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

async function maybeNotify(count, invoices, companyName) {
	const config = await getConfig();
	if (!config.notificationsEnabled) return;

	const noun  = count === 1 ? 'nowa faktura' : count < 5 ? 'nowe faktury' : 'nowych faktur';
	const title = companyName
		? `📄 ${companyName}: ${count} ${noun}`
		: `📄 KSeF: ${count} ${noun}`;
	const items = invoices.slice(0, 4).map((inv) => ({
		title:   truncate(inv.sellerName, 40),
		message: inv.invoiceNumber || inv.issueDate?.substring(0, 10) || '',
	}));

	await chrome.notifications.create(`ksef-new-invoices-${Date.now()}`, {
		type:               items.length > 1 ? 'list' : 'basic',
		iconUrl:            'icons/icon48.png',
		title,
		message:            items[0]?.title ?? 'Otwórz rozszerzenie, aby zobaczyć',
		items:              items.length > 1 ? items : undefined,
		requireInteraction: false,
	});
}

async function maybeNotifyNeedsPin(companyName) {
	const config = await getConfig();
	if (!config.notificationsEnabled) return;
	const title = companyName
		? `🔑 KSeF Monitor (${companyName}): wymagane zalogowanie`
		: '🔑 KSeF Monitor: wymagane zalogowanie';
	await chrome.notifications.create(`ksef-needs-pin-${Date.now()}`, {
		type:               'basic',
		iconUrl:            'icons/icon48.png',
		title,
		message:            'Sesja wygasła. Kliknij ikonę rozszerzenia i wprowadź PIN.',
		requireInteraction: true,
	});
}

async function notifyError(title, message) {
	await chrome.notifications.create('ksef-error', {
		type:    'basic',
		iconUrl: 'icons/icon48.png',
		title,
		message,
	});
}

// ─── Alarm helpers ────────────────────────────────────────────────────────────

async function reinitializeArchive(nip, pin = null) {
	const account = await getAccount(nip);
	const config  = await getConfig();
	const client  = new KSeFClient(account.environment);
	const ps      = await getPollState(nip);
	const token   = await getOrRefreshAccessToken(nip, config, pin, client, ps);
	const since   = new Date(Date.now() - 90 * 24 * 3_600_000);
	const result  = await client.queryInvoiceMetadata(token, since);
	const pendingCount = await initializeArchive(nip, result.invoices);
	return { count: result.invoices.length, pendingCount };
}

async function rescheduleAlarmAfterBackoff(nip, retryAfterSeconds) {
	await clearAlarm(nip);
	const config     = await getConfig();
	const backoffMin = Math.max(config.pollIntervalMinutes, Math.ceil(retryAfterSeconds / 60));
	await chrome.alarms.create(alarmName(nip), {
		delayInMinutes:  backoffMin,
		periodInMinutes: config.pollIntervalMinutes,
	});
	// Zaplanuj przywrócenie normalnego interwału przez alarm (nie setTimeout – SW może zasnąć)
	await chrome.alarms.create(RESTORE_ALARM, {
		delayInMinutes: backoffMin + 1,
	});
}

function truncate(str, max) {
	if (!str) return '';
	return str.length <= max ? str : str.substring(0, max - 1) + '…';
}
