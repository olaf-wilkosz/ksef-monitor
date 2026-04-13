/**
 * storage.js – warstwa dostępu do chrome.storage.local
 *
 * Schemat v1.1 (multi-NIP):
 *
 *   accounts: {
 *     [nip: string]: {
 *       encryptedToken:  { ciphertext, iv, salt }
 *       companyName:     string | null
 *       environment:     "production" | "demo" | "test"
 *       pollOffset:      number   – ms offset od pełnej godziny (rozłożenie pollingu)
 *       authState:       { refreshToken, refreshTokenExpiry }
 *       pollState:       { lastPollTime, lastSuccessTime, consecutiveErrors, backoffUntil, needsPin, needsNewToken, lastError }
 *       invoiceState:    { allSeenIds, pendingInvoices, recentArchive, lastQueryTime }
 *     }
 *   }
 *   activeNip:   string | null
 *   config:      { pollIntervalMinutes, notificationsEnabled, pendingDaysThreshold }
 *   pinLockout:  { attempts, lockedUntil }
 *   errorLog:    Array<{ time, code, message }>
 *   archiveUndoBuffer: { nip, invoice } | null
 *
 * Migracja v0.x/v1.0.x → v1.1:
 *   Stare klucze (encryptedToken, authState, pollState, invoiceState) przepisywane
 *   do accounts[nip] przy pierwszym starcie.
 */

const KEYS = {
	ACCOUNTS: 'accounts',
	ACTIVE_NIP: 'activeNip',
	CONFIG: 'config',
	ERROR_LOG: 'errorLog',
	ARCHIVE_UNDO_BUFFER: 'archiveUndoBuffer',
	PIN_LOCKOUT: 'pinLockout',
	// Legacy keys (v1.0.x) – używane tylko przy migracji
	_ENCRYPTED_TOKEN: 'encryptedToken',
	_AUTH_STATE: 'authState',
	_POLL_STATE: 'pollState',
	_INVOICE_STATE: 'invoiceState',
};

const ARCHIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 dni

// ─── Primitives ───────────────────────────────────────────────────────────────

async function get(key) {
	return new Promise((res, rej) => {
		chrome.storage.local.get(key, (result) => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res(result[key] ?? null);
		});
	});
}

async function set(key, value) {
	return new Promise((res, rej) => {
		chrome.storage.local.set({ [key]: value }, () => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}

async function remove(key) {
	return new Promise((res, rej) => {
		chrome.storage.local.remove(key, () => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}

// ─── Migracja v1.0.x → v1.1 ──────────────────────────────────────────────────

/**
 * Sprawdza czy dane są w starym formacie i przepisuje do accounts[nip].
 * Wywołać raz przy starcie background.js przed jakimkolwiek odczytem.
 */
export async function migrateToMultiNip() {
	const accounts = await get(KEYS.ACCOUNTS);
	if (accounts !== null) return; // już zmigrowane

	const oldToken = await get(KEYS._ENCRYPTED_TOKEN);
	if (!oldToken) return; // brak danych do migracji (świeża instalacja)

	const oldConfig = await get(KEYS.CONFIG);
	const oldAuth = await get(KEYS._AUTH_STATE);
	const oldPoll = await get(KEYS._POLL_STATE);
	const oldInvoice = await get(KEYS._INVOICE_STATE);

	const nip = oldConfig?.nip ?? null;
	if (!nip) return; // nie da się zmigrować bez NIP-a

	const newAccounts = {
		[nip]: {
			encryptedToken: oldToken,
			companyName: oldConfig?.companyName ?? null,
			environment: oldConfig?.environment ?? 'production',
			pollOffset: 0,
			authState: oldAuth ?? { refreshToken: null, refreshTokenExpiry: 0 },
			pollState: oldPoll ?? defaultPollState(),
			invoiceState: migrateInvoiceStateSchema(oldInvoice),
		},
	};

	await set(KEYS.ACCOUNTS, newAccounts);
	await set(KEYS.ACTIVE_NIP, nip);

	// Nowy config bez pól per-NIP
	const newConfig = {
		pollIntervalMinutes: oldConfig?.pollIntervalMinutes ?? 60,
		notificationsEnabled: oldConfig?.notificationsEnabled ?? false,
		pendingDaysThreshold: oldConfig?.pendingDaysThreshold ?? 'month',
	};
	await set(KEYS.CONFIG, newConfig);

	// Wyczyść stare klucze
	await chrome.storage.local.remove([KEYS._ENCRYPTED_TOKEN, KEYS._AUTH_STATE, KEYS._POLL_STATE, KEYS._INVOICE_STATE]);
}

function migrateInvoiceStateSchema(raw) {
	if (!raw) return defaultInvoiceState();
	if (raw.allSeenIds !== undefined) return raw; // v0.3 – OK
	// v0.2.0 / v0.1.x
	return {
		allSeenIds: raw.lastSeenIds ?? [],
		pendingInvoices: raw.pendingInvoices ?? [],
		recentArchive: [],
		lastQueryTime: raw.lastQueryTime ?? null,
	};
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

async function getAccounts() {
	return (await get(KEYS.ACCOUNTS)) ?? {};
}

async function saveAccounts(accounts) {
	await set(KEYS.ACCOUNTS, accounts);
}

/** Zwraca dane konta dla danego NIP-a lub null jeśli nie istnieje. */
export async function getAccount(nip) {
	const accounts = await getAccounts();
	return accounts[nip] ?? null;
}

/** Zapisuje dane konta dla danego NIP-a. */
export async function saveAccount(nip, data) {
	const accounts = await getAccounts();
	accounts[nip] = { ...accounts[nip], ...data };
	await saveAccounts(accounts);
}

/** Zwraca listę wszystkich NIP-ów. */
export async function getNipList() {
	const accounts = await getAccounts();
	return Object.keys(accounts);
}

/** Zwraca czy istnieje co najmniej jeden NIP. */
export async function hasAnyAccount() {
	const nips = await getNipList();
	return nips.length > 0;
}

/** Dodaje nowe konto. Oblicza pollOffset na podstawie pozycji w kolejce. */
export async function addAccount(nip, { encryptedToken, companyName, environment, intervalMs }) {
	const accounts = await getAccounts();
	const count = Object.keys(accounts).length;
	const pollOffset = count * Math.floor(intervalMs / (count + 1));

	accounts[nip] = {
		encryptedToken,
		companyName: companyName ?? null,
		environment: environment ?? 'production',
		pollOffset,
		authState: { refreshToken: null, refreshTokenExpiry: 0 },
		pollState: defaultPollState(),
		invoiceState: defaultInvoiceState(),
	};

	// Przelicz offsety wszystkich kont równomiernie
	const nips = Object.keys(accounts);
	nips.forEach((n, i) => {
		accounts[n].pollOffset = i * Math.floor(intervalMs / nips.length);
	});

	await saveAccounts(accounts);
}

/** Usuwa konto. Zwraca listę pozostałych NIP-ów. */
export async function removeAccount(nip) {
	const accounts = await getAccounts();
	delete accounts[nip];

	// Przelicz offsety pozostałych
	const cfg = await getConfig();
	const intervalMs = (cfg.pollIntervalMinutes ?? 60) * 60_000;
	const nips = Object.keys(accounts);
	nips.forEach((n, i) => {
		accounts[n].pollOffset = i * Math.floor(intervalMs / nips.length);
	});

	await saveAccounts(accounts);

	// Jeśli usunięto aktywny NIP, ustaw pierwszy dostępny
	const activeNip = await getActiveNip();
	if (activeNip === nip) {
		await setActiveNip(nips[0] ?? null);
	}

	return nips;
}

// ─── Active NIP ───────────────────────────────────────────────────────────────

export async function getActiveNip() {
	return await get(KEYS.ACTIVE_NIP);
}

export async function setActiveNip(nip) {
	await set(KEYS.ACTIVE_NIP, nip);
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig() {
	return (
		(await get(KEYS.CONFIG)) ?? {
			pollIntervalMinutes: 60,
			notificationsEnabled: false,
			pendingDaysThreshold: 'month',
		}
	);
}
export async function saveConfig(config) {
	await set(KEYS.CONFIG, config);
}

// ─── Token KSeF (per NIP) ─────────────────────────────────────────────────────

export async function getEncryptedToken(nip) {
	const account = await getAccount(nip);
	return account?.encryptedToken ?? null;
}
export async function saveEncryptedToken(nip, data) {
	await saveAccount(nip, { encryptedToken: data });
}
export async function hasToken(nip) {
	return (await getEncryptedToken(nip)) !== null;
}
export async function clearToken(nip) {
	await saveAccount(nip, { encryptedToken: null, authState: { refreshToken: null, refreshTokenExpiry: 0 } });
	await clearAuthStateSession(nip);
}

// ─── Auth state (per NIP) ────────────────────────────────────────────────────

const sessionKey = (nip) => `accessTokenState_${nip}`;

export async function getAuthState(nip) {
	const account = await getAccount(nip);
	const local = account?.authState ?? { refreshToken: null, refreshTokenExpiry: 0 };
	const session = await chrome.storage.session
		.get(sessionKey(nip))
		.then((r) => r[sessionKey(nip)] ?? { accessToken: null, accessTokenExpiry: 0 })
		.catch(() => ({ accessToken: null, accessTokenExpiry: 0 }));
	return {
		accessToken: session.accessToken,
		accessTokenExpiry: session.accessTokenExpiry,
		refreshToken: local.refreshToken,
		refreshTokenExpiry: local.refreshTokenExpiry,
	};
}

export async function saveAuthState(nip, state) {
	await saveAccount(nip, {
		authState: { refreshToken: state.refreshToken, refreshTokenExpiry: state.refreshTokenExpiry },
	});
	await chrome.storage.session.set({
		[sessionKey(nip)]: { accessToken: state.accessToken, accessTokenExpiry: state.accessTokenExpiry },
	});
}

export async function clearAuthState(nip) {
	await saveAccount(nip, { authState: { refreshToken: null, refreshTokenExpiry: 0 } });
	await clearAuthStateSession(nip);
}

async function clearAuthStateSession(nip) {
	await chrome.storage.session.remove(sessionKey(nip)).catch(() => {});
}

// ─── KSeF token plain (session, per NIP) ──────────────────────────────────────

const sessionTokenKey = (nip) => `ksefTokenPlain_${nip}`;

export async function getKsefTokenPlain(nip) {
	const r = await chrome.storage.session.get(sessionTokenKey(nip)).catch(() => ({}));
	return r[sessionTokenKey(nip)] ?? null;
}

export async function saveKsefTokenPlain(nip, token) {
	await chrome.storage.session.set({ [sessionTokenKey(nip)]: token });
}

export async function clearKsefTokenPlain(nip) {
	await chrome.storage.session.remove(sessionTokenKey(nip)).catch(() => {});
}

// ─── Poll state (per NIP) ────────────────────────────────────────────────────

function defaultPollState() {
	return {
		lastPollTime: null,
		lastSuccessTime: null,
		consecutiveErrors: 0,
		backoffUntil: null,
		needsPin: false,
		needsNewToken: false,
		lastError: null,
	};
}

export async function getPollState(nip) {
	const account = await getAccount(nip);
	return account?.pollState ?? defaultPollState();
}

export async function savePollState(nip, state) {
	await saveAccount(nip, { pollState: state });
}

export async function recordPollSuccess(nip) {
	const cur = await getPollState(nip);
	await savePollState(nip, {
		...cur,
		lastPollTime: new Date().toISOString(),
		lastSuccessTime: new Date().toISOString(),
		consecutiveErrors: 0,
		backoffUntil: null,
		needsPin: false,
		needsNewToken: false,
		lastError: null,
	});
}

/** Wygasła sesja – czeka na PIN. Zero backoffu, zero counter. */
export async function recordNeedsPin(nip) {
	const cur = await getPollState(nip);
	await savePollState(nip, {
		...cur,
		lastPollTime: new Date().toISOString(),
		needsPin: true,
		needsNewToken: false,
		backoffUntil: null,
		consecutiveErrors: 0,
		lastError: null,
	});
}

/** Token unieważniony lub błędny (450) – wymaga wprowadzenia nowego tokenu. */
export async function recordNeedsNewToken(nip, message) {
	const cur = await getPollState(nip);
	await savePollState(nip, {
		...cur,
		lastPollTime: new Date().toISOString(),
		needsNewToken: true,
		needsPin: false,
		backoffUntil: null,
		consecutiveErrors: 0,
		lastError: { code: 'TOKEN_INVALID', message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code: 'AUTH_FAILED_450', message, nip });
}

/** Błąd sieciowy/serwera. Backoff: 1h → 2h → 4h → max 24h. */
export async function recordPollError(nip, code, message) {
	const cur = await getPollState(nip);
	const errors = (cur.consecutiveErrors ?? 0) + 1;
	await savePollState(nip, {
		...cur,
		lastPollTime: new Date().toISOString(),
		consecutiveErrors: errors,
		backoffUntil: new Date(Date.now() + Math.min(24, Math.pow(2, errors - 1)) * 3_600_000).toISOString(),
		needsPin: false,
		lastError: { code, message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code, message, nip });
}

export async function recordRateLimit(nip, seconds) {
	const cur = await getPollState(nip);
	await savePollState(nip, {
		...cur,
		lastPollTime: new Date().toISOString(),
		backoffUntil: new Date(Date.now() + seconds * 1000).toISOString(),
		lastError: { code: 429, message: `Rate limit – retry after ${seconds}s`, time: new Date().toISOString() },
	});
}

// ─── Invoice state (per NIP) ─────────────────────────────────────────────────

function defaultInvoiceState() {
	return {
		allSeenIds: [],
		pendingInvoices: [],
		recentArchive: [],
		lastQueryTime: null,
	};
}

export async function getInvoiceState(nip) {
	const account = await getAccount(nip);
	return account?.invoiceState ?? defaultInvoiceState();
}

export async function saveInvoiceState(nip, state) {
	await saveAccount(nip, { invoiceState: state });
}

/** Normalizuje surowy obiekt faktury z KSeF API.
 *
 * Pola zweryfikowane na produkcji (KSeF API 2.0):
 *   ID:      ksefNumber
 *   Seller:  seller.name, seller.nip
 *   Numer:   invoiceReferenceNumber
 *   Data:    invoicingDate
 *   Kwota:   grossAmount
 *
 * TODO: zweryfikować pola dla tokenów spółek/pieczęci – możliwy inny schemat seller.
 */
export function normalizeInvoice(raw) {
	const ref = raw.ksefNumber || '';

	const sellerName = raw.seller?.name || 'Nieznany wystawca';
	const sellerNip = raw.seller?.nip || '';

	const invoiceNumber = raw.invoiceReferenceNumber || '';
	const issueDate = raw.invoicingDate || '';

	return {
		id: ref,
		ksefRef: ref,
		sellerName,
		sellerNip,
		invoiceNumber,
		issueDate,
		grossAmount: raw.grossAmount ?? null,
		currency: raw.currency || 'PLN',
		fetchedAt: new Date().toISOString(),
	};
}

/**
 * Inicjalizuje stan po onboardingu NIP-a.
 * @returns {number} liczba faktur w pending
 */
export async function initializeArchive(nip, rawInvoices) {
	const cfg = await getConfig();
	const threshold = cfg.pendingDaysThreshold ?? 'month';
	const cutoff =
		threshold === 'month'
			? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
			: new Date(Date.now() - Number(threshold) * 24 * 3_600_000);

	const normalized = rawInvoices
		.map(normalizeInvoice)
		.filter((inv) => inv.id)
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));

	const pending = normalized.filter((inv) => inv.issueDate && new Date(inv.issueDate) >= cutoff);
	const older = normalized.filter((inv) => !inv.issueDate || new Date(inv.issueDate) < cutoff);

	const oldestDate =
		normalized.length > 0
			? normalized[normalized.length - 1].issueDate || new Date(Date.now() - 90 * 24 * 3_600_000).toISOString()
			: new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();

	await saveInvoiceState(nip, {
		allSeenIds: [...new Set(normalized.map((inv) => inv.id))],
		pendingInvoices: pending,
		recentArchive: older,
		lastQueryTime: oldestDate,
	});

	return pending.length;
}

/**
 * Aktualizuje stan podczas regularnego pollingu.
 * @returns {number} liczba nowych faktur
 */
export async function updateInvoices(nip, rawInvoices) {
	const state = await getInvoiceState(nip);
	const seenSet = new Set(state.allSeenIds);

	const normalized = rawInvoices.map(normalizeInvoice).filter((inv) => inv.id);
	const trulyNew = normalized.filter((inv) => !seenSet.has(inv.id));

	const newAllIds = [...new Set([...state.allSeenIds, ...normalized.map((inv) => inv.id)])];

	const cutoff = Date.now() - ARCHIVE_TTL_MS;
	const prunedArchive = state.recentArchive.filter(
		(inv) => new Date(inv.fetchedAt || inv.issueDate || 0).getTime() > cutoff
	);

	await saveInvoiceState(nip, {
		allSeenIds: newAllIds,
		pendingInvoices: [...state.pendingInvoices, ...trulyNew],
		recentArchive: prunedArchive,
		lastQueryTime: new Date().toISOString(),
	});

	return trulyNew.length;
}

/** Przenosi fakturę z pendingInvoices → recentArchive. */
export async function markNoticed(nip, invoiceId) {
	const state = await getInvoiceState(nip);
	const invoice = state.pendingInvoices.find((inv) => inv.id === invoiceId);
	if (!invoice) return null;

	await saveInvoiceState(nip, {
		...state,
		pendingInvoices: state.pendingInvoices.filter((inv) => inv.id !== invoiceId),
		recentArchive: [invoice, ...state.recentArchive],
	});
	return invoice;
}

/** Cofa markNoticed. */
export async function undoNoticed(nip, invoiceId) {
	const state = await getInvoiceState(nip);
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (!invoice) return;

	await saveInvoiceState(nip, {
		...state,
		pendingInvoices: [invoice, ...state.pendingInvoices],
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/** Wypełnia recentArchive najnowszymi fakturami jeśli jest puste. */
export async function ensureArchiveBackfill(nip, rawInvoices) {
	const state = await getInvoiceState(nip);
	if (state.recentArchive.length > 0) return;
	if (!rawInvoices || rawInvoices.length === 0) return;

	const seenSet = new Set(state.allSeenIds);
	const archive = rawInvoices
		.map(normalizeInvoice)
		.filter((inv) => inv.id && seenSet.has(inv.id))
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));

	if (archive.length === 0) return;
	await saveInvoiceState(nip, { ...state, recentArchive: archive });
}

/** Usuwa fakturę z archiwum. */
export async function dismissFromArchive(nip, invoiceId) {
	const state = await getInvoiceState(nip);
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (invoice) await set(KEYS.ARCHIVE_UNDO_BUFFER, { nip, invoice });
	await saveInvoiceState(nip, {
		...state,
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/** Cofa dismissFromArchive. */
export async function undoDismissArchive(nip, invoiceId) {
	const undoBuffer = await get(KEYS.ARCHIVE_UNDO_BUFFER);
	if (!undoBuffer || undoBuffer.invoice?.id !== invoiceId || undoBuffer.nip !== nip) return;
	const state = await getInvoiceState(nip);
	const merged = [undoBuffer.invoice, ...state.recentArchive].sort((a, b) =>
		(b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || '')
	);
	await saveInvoiceState(nip, { ...state, recentArchive: merged });
	await remove(KEYS.ARCHIVE_UNDO_BUFFER);
}

/** Oznacza wszystkie oczekujące jako przejrzane. */
export async function markAllNoticed(nip) {
	const state = await getInvoiceState(nip);
	await saveInvoiceState(nip, {
		...state,
		pendingInvoices: [],
		recentArchive: [...state.pendingInvoices, ...state.recentArchive],
	});
}

// ─── Error log ────────────────────────────────────────────────────────────────

async function appendErrorLog(entry) {
	const log = (await get(KEYS.ERROR_LOG)) ?? [];
	log.unshift({ ...entry, time: new Date().toISOString() });
	if (log.length > 50) log.length = 50;
	await set(KEYS.ERROR_LOG, log);
}
export async function getErrorLog() {
	return (await get(KEYS.ERROR_LOG)) ?? [];
}

// ─── PIN lockout ──────────────────────────────────────────────────────────────

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30_000; // 30 sekund

export async function getPinLockout() {
	return (await get(KEYS.PIN_LOCKOUT)) ?? { attempts: 0, lockedUntil: null };
}

export async function recordPinFailure() {
	const state = await getPinLockout();
	const attempts = state.attempts + 1;
	const lockedUntil = attempts >= PIN_MAX_ATTEMPTS ? Date.now() + PIN_LOCKOUT_MS : null;
	await set(KEYS.PIN_LOCKOUT, { attempts, lockedUntil });
	return { attempts, lockedUntil };
}

export async function clearPinLockout() {
	await remove(KEYS.PIN_LOCKOUT);
}

export async function clearAll() {
	return new Promise((res, rej) => {
		chrome.storage.local.clear(() => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}
