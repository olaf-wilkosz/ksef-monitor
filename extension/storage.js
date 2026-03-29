/**
 * storage.js – warstwa dostępu do chrome.storage.local
 *
 * Schemat invoiceState (v0.3):
 *   allSeenIds:      string[]   – wszystkie ID jakie kiedykolwiek pobraliśmy (deduplikacja)
 *   pendingInvoices: Invoice[]  – nowe, nieprzejrzane (licznik + badge)
 *   recentArchive:   Invoice[]  – ostatnio przejrzane (TTL 90 dni, bez limitu ilościowego)
 *   lastQueryTime:   string|null
 */

const KEYS = {
	ENCRYPTED_TOKEN: 'encryptedToken',
	CONFIG: 'config',
	AUTH_STATE: 'authState',
	POLL_STATE: 'pollState',
	INVOICE_STATE: 'invoiceState',
	ERROR_LOG: 'errorLog',
	ARCHIVE_UNDO_BUFFER: 'archiveUndoBuffer',
	PIN_LOCKOUT: 'pinLockout',
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

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig() {
	return (
		(await get(KEYS.CONFIG)) ?? {
			nip: null,
			environment: 'production',
			pollIntervalMinutes: 60,
			notificationsEnabled: false,
			pendingDaysThreshold: 'month',
		}
	);
}
export async function saveConfig(config) {
	await set(KEYS.CONFIG, config);
}

// ─── Token KSeF ───────────────────────────────────────────────────────────────

export async function getEncryptedToken() {
	return await get(KEYS.ENCRYPTED_TOKEN);
}
export async function saveEncryptedToken(data) {
	await set(KEYS.ENCRYPTED_TOKEN, data);
}
export async function hasToken() {
	return (await get(KEYS.ENCRYPTED_TOKEN)) !== null;
}
export async function clearToken() {
	await remove(KEYS.ENCRYPTED_TOKEN);
	await remove(KEYS.AUTH_STATE);
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState() {
	const local = (await get(KEYS.AUTH_STATE)) ?? { refreshToken: null, refreshTokenExpiry: 0 };
	const session = await chrome.storage.session
		.get('accessTokenState')
		.then((r) => r.accessTokenState ?? { accessToken: null, accessTokenExpiry: 0 })
		.catch(() => ({ accessToken: null, accessTokenExpiry: 0 }));
	return {
		accessToken: session.accessToken,
		accessTokenExpiry: session.accessTokenExpiry,
		refreshToken: local.refreshToken,
		refreshTokenExpiry: local.refreshTokenExpiry,
	};
}
export async function saveAuthState(state) {
	await set(KEYS.AUTH_STATE, { refreshToken: state.refreshToken, refreshTokenExpiry: state.refreshTokenExpiry });
	await chrome.storage.session.set({
		accessTokenState: { accessToken: state.accessToken, accessTokenExpiry: state.accessTokenExpiry },
	});
}
export async function clearAuthState() {
	await remove(KEYS.AUTH_STATE);
	await chrome.storage.session.remove('accessTokenState').catch(() => {});
}

// ─── Poll state ───────────────────────────────────────────────────────────────

export async function getPollState() {
	return (
		(await get(KEYS.POLL_STATE)) ?? {
			lastPollTime: null,
			lastSuccessTime: null,
			consecutiveErrors: 0,
			backoffUntil: null,
			needsPin: false,
			needsNewToken: false,
			lastError: null,
		}
	);
}
export async function savePollState(state) {
	await set(KEYS.POLL_STATE, state);
}

export async function recordPollSuccess() {
	const cur = await getPollState();
	await savePollState({
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
export async function recordNeedsPin() {
	const cur = await getPollState();
	await savePollState({
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
export async function recordNeedsNewToken(message) {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		needsNewToken: true,
		needsPin: false,
		backoffUntil: null,
		consecutiveErrors: 0,
		lastError: { code: 'TOKEN_INVALID', message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code: 'AUTH_FAILED_450', message });
}

/** Błąd sieciowy/serwera. Backoff: 1h → 2h → 4h → max 24h. */
export async function recordPollError(code, message) {
	const cur = await getPollState();
	const errors = (cur.consecutiveErrors ?? 0) + 1;
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		consecutiveErrors: errors,
		backoffUntil: new Date(Date.now() + Math.min(24, Math.pow(2, errors - 1)) * 3_600_000).toISOString(),
		needsPin: false,
		lastError: { code, message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code, message });
}

export async function recordRateLimit(seconds) {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		backoffUntil: new Date(Date.now() + seconds * 1000).toISOString(),
		lastError: { code: 429, message: `Rate limit – retry after ${seconds}s`, time: new Date().toISOString() },
	});
}

// ─── Invoice state ────────────────────────────────────────────────────────────

export async function saveInvoiceState(state) {
	await set(KEYS.INVOICE_STATE, state);
}

export async function getInvoiceState() {
	const raw = await get(KEYS.INVOICE_STATE);
	if (raw && (raw.lastSeenIds || raw.newCount != null) && !raw.allSeenIds) {
		return {
			allSeenIds: raw.lastSeenIds ?? [],
			pendingInvoices: [],
			recentArchive: [],
			lastQueryTime: raw.lastQueryTime ?? null,
		};
	}
	return (
		raw ?? {
			allSeenIds: [],
			pendingInvoices: [],
			recentArchive: [],
			lastQueryTime: null,
		}
	);
}

/** Normalizuje surowy obiekt faktury z KSeF API. */
export function normalizeInvoice(raw) {
	const ref =
		raw.ksefNumber ||
		raw.ksefReferenceNumber ||
		raw.KsefReferenceNumber ||
		raw.referenceNumber ||
		raw.invoiceId ||
		raw.id ||
		'';

	const sellerName =
		raw.seller?.name ||
		raw.subjectBy?.subjectName ||
		raw.subjectBy?.name ||
		raw.sellerName ||
		raw.issuerName ||
		'Nieznany wystawca';

	const sellerNip =
		raw.seller?.nip ||
		raw.subjectBy?.issuedToIdentifier?.value ||
		raw.subjectBy?.identifier?.value ||
		raw.sellerNip ||
		raw.issuerNip ||
		'';

	const invoiceNumber = raw.invoiceReferenceNumber || raw.invoiceNumber || raw.number || '';
	const issueDate = raw.invoicingDate || raw.issueDate || raw.issuedAt || raw.dateOfIssue || '';

	return {
		id: ref,
		ksefRef: ref,
		sellerName,
		sellerNip,
		invoiceNumber,
		issueDate,
		grossAmount: raw.grossAmount ?? raw.totalAmountWithTax ?? raw.totalGrossAmount ?? null,
		currency: raw.currency || 'PLN',
		fetchedAt: new Date().toISOString(),
		_raw: undefined,
	};
}

/**
 * Inicjalizuje stan po onboardingu.
 * Faktury z progu pendingDaysThreshold → pendingInvoices.
 * Starsze → recentArchive (bez limitu ilościowego, TTL 90 dni).
 * @returns {number} liczba faktur w pending
 */
export async function initializeArchive(rawInvoices) {
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

	await set(KEYS.INVOICE_STATE, {
		allSeenIds: [...new Set(normalized.map((inv) => inv.id))],
		pendingInvoices: pending,
		recentArchive: older,
		lastQueryTime: oldestDate,
	});

	return pending.length;
}

/**
 * Aktualizuje stan podczas regularnego pollingu.
 * Nowe faktury (nieznane) → pendingInvoices.
 * Przycina recentArchive do wpisów młodszych niż 90 dni.
 * @returns {number} liczba nowych faktur
 */
export async function updateInvoices(rawInvoices) {
	const state = await getInvoiceState();
	const seenSet = new Set(state.allSeenIds);

	const normalized = rawInvoices.map(normalizeInvoice).filter((inv) => inv.id);
	const trulyNew = normalized.filter((inv) => !seenSet.has(inv.id));

	const newAllIds = [...new Set([...state.allSeenIds, ...normalized.map((inv) => inv.id)])];

	const cutoff = Date.now() - ARCHIVE_TTL_MS;
	const prunedArchive = state.recentArchive.filter(
		(inv) => new Date(inv.fetchedAt || inv.issueDate || 0).getTime() > cutoff
	);

	await set(KEYS.INVOICE_STATE, {
		allSeenIds: newAllIds,
		pendingInvoices: [...state.pendingInvoices, ...trulyNew],
		recentArchive: prunedArchive,
		lastQueryTime: new Date().toISOString(),
	});

	return trulyNew.length;
}

/**
 * Przenosi fakturę z pendingInvoices → recentArchive.
 * @returns {Invoice|null} przeniesiona faktura (do undo)
 */
export async function markNoticed(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.pendingInvoices.find((inv) => inv.id === invoiceId);
	if (!invoice) return null;

	await set(KEYS.INVOICE_STATE, {
		...state,
		pendingInvoices: state.pendingInvoices.filter((inv) => inv.id !== invoiceId),
		recentArchive: [invoice, ...state.recentArchive],
	});
	return invoice;
}

/**
 * Cofa markNoticed – przenosi z recentArchive z powrotem do pendingInvoices.
 */
export async function undoNoticed(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (!invoice) return;

	await set(KEYS.INVOICE_STATE, {
		...state,
		pendingInvoices: [invoice, ...state.pendingInvoices],
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/**
 * Wypełnia recentArchive najnowszymi fakturami jeśli jest puste.
 */
export async function ensureArchiveBackfill(rawInvoices) {
	const state = await getInvoiceState();
	if (state.recentArchive.length > 0) return;
	if (!rawInvoices || rawInvoices.length === 0) return;

	const seenSet = new Set(state.allSeenIds);
	const archive = rawInvoices
		.map(normalizeInvoice)
		.filter((inv) => inv.id && seenSet.has(inv.id))
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));

	if (archive.length === 0) return;
	await set(KEYS.INVOICE_STATE, { ...state, recentArchive: archive });
}

/** Usuwa fakturę z archiwum. */
export async function dismissFromArchive(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (invoice) await set(KEYS.ARCHIVE_UNDO_BUFFER, invoice);
	await set(KEYS.INVOICE_STATE, {
		...state,
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/** Cofa dismissFromArchive. */
export async function undoDismissArchive(invoiceId) {
	const undoBuffer = await get(KEYS.ARCHIVE_UNDO_BUFFER);
	if (!undoBuffer || undoBuffer.id !== invoiceId) return;
	const state = await getInvoiceState();
	const merged = [undoBuffer, ...state.recentArchive].sort((a, b) =>
		(b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || '')
	);
	await set(KEYS.INVOICE_STATE, { ...state, recentArchive: merged });
	await remove(KEYS.ARCHIVE_UNDO_BUFFER);
}

/** Oznacza wszystkie oczekujące jako przejrzane. */
export async function markAllNoticed() {
	const state = await getInvoiceState();
	await set(KEYS.INVOICE_STATE, {
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

// ─── PIN lockout ───────────────────────────────────────────────────────────────

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
