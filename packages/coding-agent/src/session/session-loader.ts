import * as fs from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	ConcatSink,
	getBlobsDir,
	isEisdir,
	isEnoent,
	isEnotdir,
	jsonContainerEnd,
	parseJsonlLenient,
	peekFile,
	tryParseJson,
} from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Semaphore } from "../task/parallel";
import {
	BlobStore,
	isBlobRef,
	lazyImageDataSync,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
	resolveImageDataUrlSync,
} from "./blob-store";
import {
	buildSessionContextFromLeafPath,
	selectSessionContextEntriesFromLeafPath,
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "./session-context";
import {
	CURRENT_SESSION_VERSION,
	type CompactionEntry,
	type FileEntry,
	type RawFileEntry,
	type SessionEntry,
	type SessionHeader,
	sessionEntryLeafId,
} from "./session-entries";
import { sanitizeRehydratedOpenAIResponsesAssistantMessage } from "./messages";
import { generateId, migrateToCurrentVersion, migrateV1SessionEntry } from "./session-migrations";
import { isExternalizableImagePosition, isPersistenceTruncatedString } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { enotdir } from "./session-storage-errors";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const LF = new Uint8Array([0x0a]);

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
const BLOB_READ_CONCURRENCY = 8;

/**
 * Complete optional accounting fields from persisted/imported assistant turns.
 * Complete provider usage is left untouched; missing prices never discard reported tokens.
 */
export function normalizeAssistantUsage(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
	const usage = message.usage;
	if (
		usage &&
		usage.input !== undefined &&
		usage.output !== undefined &&
		usage.cacheRead !== undefined &&
		usage.cacheWrite !== undefined &&
		usage.totalTokens !== undefined &&
		usage.cost?.input !== undefined &&
		usage.cost.output !== undefined &&
		usage.cost.cacheRead !== undefined &&
		usage.cost.cacheWrite !== undefined &&
		usage.cost.total !== undefined
	) {
		return false;
	}
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cost = usage?.cost;
	message.usage = {
		...usage,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens:
			usage?.totalTokens ??
			input +
				output +
				cacheRead +
				cacheWrite +
				(usage?.orchestration?.input ?? 0) +
				(usage?.orchestration?.cacheRead ?? 0) +
				(usage?.orchestration?.output ?? 0),
		cost: {
			...cost,
			input: cost?.input ?? 0,
			output: cost?.output ?? 0,
			cacheRead: cost?.cacheRead ?? 0,
			cacheWrite: cost?.cacheWrite ?? 0,
			total:
				cost?.total ?? (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0),
		},
	};
	return true;
}

export interface VisitEntriesFromFileStreamOptions {
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
	/** Rethrow missing source instead of visiting nothing (fork backstop). */
	throwIfMissing?: boolean;
	/**
	 * Called with each stream chunk's byte length as it is consumed. Lets
	 * callers derive the exact snapshot size without re-stating the file.
	 */
	onBytesConsumed?: (bytes: number) => void;
	/** Physical UTF-8 byte range of each valid record (including its newline, when present). */
	onEntryPosition?: (entry: FileEntry, offset: number, length: number) => void;
	/** Borrow an already-open source so scanning and indexed reads share one inode. */
	sourceFd?: number;
}

/** Controls how a missing session file is handled. */
export interface LoadSessionOptions {
	/** Propagate ENOENT instead of treating the path as a new empty session. */
	throwIfMissing?: boolean;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Byte length of the snapshot actually parsed, or `null` when the path did not exist. */
	sourceSize?: number | null;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		sourceSize: Buffer.byteLength(content, "utf8"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
const SESSION_HEADER_READ_LIMIT = 1024 * 1024;
/** First read; holds the title slot and any real header, so the full limit is read only for outliers. */
const SESSION_HEADER_FIRST_READ = 16 * 1024;

/** {@link sessionHeaderIdFromPrefix} result when the window ends inside the first record. */
const HEADER_INCOMPLETE = Symbol("header-incomplete");

/**
 * The session id in `filePath`'s header, or `undefined` when there is no file
 * there or it does not start with a valid session header. Reads
 * {@link SESSION_HEADER_FIRST_READ} bytes, and up to
 * {@link SESSION_HEADER_READ_LIMIT} only when the first record runs past them.
 */
export async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	try {
		const id = await peekFile(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			sessionHeaderIdFromPrefix(prefix, prefix.length < SESSION_HEADER_FIRST_READ),
		);
		if (id !== HEADER_INCOMPLETE) return id;
		const full = await peekFile(filePath, SESSION_HEADER_READ_LIMIT, prefix =>
			sessionHeaderIdFromPrefix(prefix, true),
		);
		return full === HEADER_INCOMPLETE ? undefined : full;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/**
 * The header id from a file's leading bytes, past the optional title slot
 * line. Parses only the first record, which may span lines (a pretty-printed
 * header). {@link HEADER_INCOMPLETE} when that record runs past `prefix` and
 * `final` is false (more of the file can be read).
 */
function sessionHeaderIdFromPrefix(prefix: Uint8Array, final: boolean): string | undefined | typeof HEADER_INCOMPLETE {
	let records = prefix;
	const newline = prefix.indexOf(0x0a);
	if (newline !== -1) {
		const firstLine = new TextDecoder().decode(prefix.subarray(0, newline)).trim();
		if (firstLine && parseTitleSlotLine(firstLine)) records = prefix.subarray(newline + 1);
	}
	// Like the full parser, skip blank lines (and other JSON whitespace) before the first record.
	let start = 0;
	while (start < records.length) {
		const byte = records[start];
		if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) break;
		start++;
	}
	records = records.subarray(start);
	if (records.length === 0) return final ? undefined : HEADER_INCOMPLETE;
	// A header is an object; anything else is not a session file.
	if (records[0] !== 0x7b) return undefined;
	const text = new TextDecoder().decode(records);
	const end = jsonContainerEnd(text, 0);
	if (end === -1) return final ? undefined : HEADER_INCOMPLETE;
	const entry = tryParseJson<FileEntry>(text.slice(0, end)) ?? undefined;
	return isValidSessionHeader(entry) ? entry.id : undefined;
}

/**
 * How far {@link firstSettledNewline} has searched for the end of one value.
 * Offsets count from the value's start, which consumed bytes before it do not move.
 */
interface SettleSearch {
	/** How many newlines past the value's first newline have been tried, the value unfinished at each. */
	tried: number;
	/** The newlines found past the last one tried, short of the next one to try. */
	found: number[];
	/** Where the search for the next newline resumes. */
	scanned: number;
}

/**
 * The first newline at which the value starting at `start` completes or
 * fails, or -1 while it is still unfinished. Trying one newline at a time
 * re-parses the growing range once per line, quadratic for a record that
 * spans many lines, and trying the buffer's last newline first parses every
 * record after this one. So the 1st, 2nd, 4th, … newlines past the value's
 * first one are tried and the gap past the last unsettled one is bisected: no
 * parsed range runs past twice the record's lines. `search` keeps the
 * progress, so a value that spans stream chunks goes on where the last chunk
 * left it, and nothing is parsed again until the buffer reaches the next
 * newline to try or, `atEnd`, the end of the file.
 */
function firstSettledNewline(view: Uint8Array, start: number, search: SettleSearch, atEnd: boolean): number {
	const settles = (newline: number): boolean => {
		const { values, error, done } = Bun.JSONL.parseChunk(view, start, start + newline + 1);
		return values.length > 0 || Boolean(error) || done;
	};
	while (true) {
		const wanted = Math.max(1, search.tried * 2) - search.tried;
		while (search.found.length < wanted) {
			const next = view.indexOf(0x0a, start + search.scanned);
			if (next < 0) {
				search.scanned = view.length - start;
				break;
			}
			search.found.push(next - start);
			search.scanned = next - start + 1;
		}
		const gap = search.found;
		if (gap.length === 0 || (gap.length < wanted && !atEnd)) return -1;
		if (!settles(gap.at(-1)!)) {
			search.tried += gap.length;
			search.found = [];
			// At the end of the file there is no further newline to try.
			if (gap.length < wanted) return -1;
			continue;
		}
		let low = 0;
		let high = gap.length - 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (settles(gap[middle]!)) high = middle;
			else low = middle + 1;
		}
		return start + gap[low]!;
	}
}

/** Parse session JSONL and visit each entry without retaining prior entries. */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = false;
	let sawFirstEntry = false;
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	let sourceBytes = 0;
	let offset = 0;
	let stopped = false;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const sink = new ConcatSink();
	const decoder = new TextDecoder();
	const yieldToMacrotask = async (): Promise<void> => {
		if (
			(yieldEveryBytes > 0 && bytesSinceYield >= yieldEveryBytes) ||
			(yieldEveryEntries > 0 && entriesSinceYield >= yieldEveryEntries)
		) {
			bytesSinceYield = 0;
			entriesSinceYield = 0;
			await Bun.sleep(0);
		}
	};
	// The value the previous drain left unfinished, now first in the buffer,
	// and how far the search for its end has got.
	let unfinished: SettleSearch | undefined;
	// Fast path: a record that is valid JSON on its own physical line. Anything
	// else is decided by Bun.JSONL.parseChunk, as in the whole-buffer parsers:
	// a value left unfinished at a newline extends to the next newline; a valid
	// value followed by junk on its last line is visited with its exact byte
	// range (`read`), and the junk to the newline is one malformed record; a
	// value that never completes is one malformed record. The scanned range
	// always ends at the first newline that can end the value, so it never holds
	// more than one value.
	const drain = async (atEnd = false): Promise<void> => {
		const view = sink.flush();
		if (!view) return;
		let consumed = 0;
		const emit = async (entry: FileEntry, start: number, end: number): Promise<void> => {
			if (!sawFirstEntry) {
				sawFirstEntry = true;
				applyTitleSlot(entry, titleSlot);
			}
			options.onEntryPosition?.(entry, offset + start, Math.min(end - start, sourceBytes - offset - start));
			stopped = visit(entry) === false;
			recordsSeen++;
			entriesSinceYield++;
			if (recordsSeen >= maxRecords) stopped = true;
			await yieldToMacrotask();
		};
		const skipMalformed = (from: number, to: number): void => {
			for (let index = from; index < to; index++) {
				const byte = view[index];
				if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
					options.onMalformedRecord?.();
					break;
				}
			}
			recordsSeen++;
			if (recordsSeen >= maxRecords) stopped = true;
		};
		while (consumed < view.length && !stopped) {
			if (recordsSeen >= maxRecords || options.shouldContinue?.() === false) {
				stopped = true;
				break;
			}
			const start = consumed;
			let search = unfinished;
			unfinished = undefined;
			let recordEnd: number;
			if (search) recordEnd = firstSettledNewline(view, start, search, atEnd);
			else {
				const firstNewline = view.indexOf(0x0a, consumed);
				if (firstNewline < 0) break;
				const firstLine = decoder.decode(view.subarray(start, firstNewline)).trim();
				if (!sawFirstLine) {
					sawFirstLine = true;
					const slot = firstLine ? parseTitleSlotLine(firstLine) : undefined;
					if (slot) {
						titleSlot = titleUpdateFromSlot(slot);
						consumed = firstNewline + 1;
						continue;
					}
				}
				if (!firstLine) {
					consumed = firstNewline + 1;
					continue;
				}
				let lineEntry: FileEntry | undefined;
				try {
					lineEntry = JSON.parse(firstLine) as FileEntry;
				} catch {}
				if (lineEntry) {
					consumed = firstNewline + 1;
					await emit(lineEntry, start, consumed);
					continue;
				}
				recordEnd = firstNewline;
			}
			let settled = false;
			while (recordEnd >= 0 && !settled) {
				const { values, error, read, done } = Bun.JSONL.parseChunk(view, start, recordEnd + 1);
				if (values.length > 0) {
					// `read` is the absolute end of the parsed value. On success the
					// record keeps its trailing whitespace and newline.
					const valueEnd = error ? read : recordEnd + 1;
					consumed = recordEnd + 1;
					await emit(values[0] as FileEntry, start, valueEnd);
					if (error && !stopped) skipMalformed(read, recordEnd);
					settled = true;
				} else if (error || done) {
					// Malformed before any value: skip its physical line only.
					const errorStart = Math.max(start, read);
					const nextNewline = view.indexOf(0x0a, errorStart);
					consumed = nextNewline + 1;
					skipMalformed(errorStart, nextNewline);
					settled = true;
				} else {
					search ??= { tried: 0, found: [], scanned: recordEnd - start + 1 };
					recordEnd = firstSettledNewline(view, start, search, atEnd);
				}
			}
			if (settled) continue;
			if (!atEnd) {
				unfinished = search;
				break;
			}
			// The value never completes before EOF: one malformed record.
			consumed = view.length;
			skipMalformed(start, view.length);
		}
		sink.consume(consumed);
		offset += consumed;
	};
	let source: AsyncIterable<Uint8Array>;
	try {
		if (options.sourceFd === undefined) {
			source = Bun.file(filePath).stream();
		} else {
			source = fs.createReadStream(filePath, {
				fd: options.sourceFd,
				autoClose: false,
				start: 0,
			});
		}
		// Cap by hand: sliced Bun file streams can hang or ignore their bound.
		let unread = maxBytes;
		for await (const streamed of source) {
			if (stopped || recordsSeen >= maxRecords || unread === 0) break;
			const chunk = streamed.byteLength > unread ? streamed.subarray(0, unread) : streamed;
			unread -= chunk.byteLength;
			sourceBytes += chunk.byteLength;
			bytesSinceYield += chunk.byteLength;
			options.onBytesConsumed?.(chunk.byteLength);
			sink.append(chunk);
			if (chunk.includes(0x0a)) await drain();
			await yieldToMacrotask();
			if (unread === 0) break;
		}
	} catch (err) {
		if (!options.throwIfMissing && isEnoent(err) && sourceBytes === 0) return undefined;
		throw err;
	}
	if (!stopped && recordsSeen < maxRecords && !sink.isEmpty) {
		sink.append(LF);
		await drain(true);
	}
	return titleSlot;
}
/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<VisitEntriesFromFileStreamOptions, "throwIfMissing">,
): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let bytesConsumed = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			entries.push(entry);
		},
		{
			onMalformedRecord: () => {
				malformedRecords++;
			},
			throwIfMissing: options?.throwIfMissing,
			onBytesConsumed: bytes => {
				bytesConsumed += bytes;
			},
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		sourceSize: bytesConsumed,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}
function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage instanceof FileSessionStorage && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(
	filePath: string,
	storage: SessionStorage,
	size: number,
	options?: { throwIfMissing?: boolean },
): Promise<{ loaded: SessionLoadResult; sourceSize: number }> {
	if (shouldStreamEntries(storage, size)) {
		const loaded = await loadEntriesFromFileStream(filePath, { throwIfMissing: options?.throwIfMissing });
		const sourceSize = loaded.sourceSize ?? 0;
		return { loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded, sourceSize };
	}
	const content = await storage.readText(filePath);
	const loaded = parseSessionContent(content);
	return {
		loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded,
		sourceSize: Buffer.byteLength(content, "utf8"),
	};
}

/**
 * Windows reports ENOENT when a path component is a regular file, where POSIX
 * yields ENOTDIR. Inspecting the leaf itself and then climbing to the first
 * existing ancestor distinguishes that path error from a genuinely missing
 * file.
 */
export async function hasFileAsPathComponent(filePath: string): Promise<boolean> {
	let current = path.resolve(filePath);
	for (;;) {
		try {
			return !(await fsp.stat(current)).isDirectory();
		} catch {
			// Missing component: climb to the first existing ancestor.
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** Load and validate a session while retaining malformed-record diagnostics. */
export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult> {
	try {
		const statSize = storage.statSync(filePath).size;
		const { loaded, sourceSize } = await loadWithKnownSize(filePath, storage, statSize, options);
		return { ...loaded, sourceSize };
	} catch (caught) {
		// Windows reports ENOENT where POSIX reports ENOTDIR for a path running
		// through a regular file; restore ENOTDIR so that path error is never
		// masked as a missing session.
		const err =
			isEnoent(caught) &&
			process.platform === "win32" &&
			storage instanceof FileSessionStorage &&
			(await hasFileAsPathComponent(filePath))
				? enotdir(filePath)
				: caught;
		if (options?.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return {
				entries: [],
				titleSlot: undefined,
				malformedRecords: 0,
				sourceSize: null,
				invalidHeader: false,
			};
		}
		throw err;
	}
}

/**
 * Load the valid entries from a session file, skipping malformed records.
 * Each call returns freshly parsed entries owned by the caller.
 */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options?: { throwIfMissing?: boolean },
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage, options)).entries;
}

/** Physical payload source and migrated identity shared by resume and read-only history. */
export interface PositionedSessionEntry extends SessionContextEntryMetadata {
	offset: number;
	length: number;
	firstKeptEntryId?: string;
}

/** Stream canonical migrations; caller owns the returned source descriptor and must close or adopt it. */
export async function visitSessionFileForResume(
	filePath: string,
	visit: (entry: SessionEntry, position: PositionedSessionEntry) => void,
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult & { migrated: boolean; sourceFd?: number }> {
	let sourceFd: number;
	try {
		sourceFd = fs.openSync(filePath, "r");
	} catch (error) {
		const err =
			isEnoent(error) && process.platform === "win32" && (await hasFileAsPathComponent(filePath))
				? enotdir(filePath)
				: error;
		if (options.throwIfMissing || !isEnoent(err)) throw err;
		return {
			entries: [],
			titleSlot: undefined,
			malformedRecords: 0,
			sourceSize: null,
			invalidHeader: false,
			migrated: false,
		};
	}
	let transferred = false;
	try {
		let header: SessionHeader | undefined;
		let version = CURRENT_SESSION_VERSION;
		let malformedRecords = 0;
		let sourceSize = 0;
		let invalidHeader = false;
		let migrated = false;
		let parentId: string | null = null;
		const ids = new Set<string>();
		const legacyIds: Array<string | undefined> = [undefined];
		const rawIds: Array<string | undefined> = [undefined];
		const forwardReferences: Array<{ position: PositionedSessionEntry; target: number }> = [];
		const titleSlot = await visitEntriesFromFileStream(filePath, () => !invalidHeader, {
			sourceFd,
			throwIfMissing: options.throwIfMissing,
			onBytesConsumed: bytes => {
				sourceSize += bytes;
			},
			onMalformedRecord: () => {
				malformedRecords++;
			},
			onEntryPosition: (entry, offset, length) => {
				if (!header) {
					if (!isValidSessionHeader(entry)) {
						invalidHeader = true;
						return;
					}
					header = entry;
					version = header.version ?? 1;
					header.version = Math.max(version, CURRENT_SESSION_VERSION);
					migrated = version < CURRENT_SESSION_VERSION;
					return;
				}
				const arrayIndex = legacyIds.length;
				rawIds.push(entry.type === "session" ? undefined : entry.id);
				if (entry.type === "session") {
					legacyIds.push(undefined);
					return;
				}
				const target =
					version < 2 && entry.type === "compaction"
						? (entry as CompactionEntry & { firstKeptEntryIndex?: number }).firstKeptEntryIndex
						: undefined;
				if (version < 2) {
					const id = generateId(ids);
					migrateV1SessionEntry(
						entry,
						id,
						parentId,
						target === arrayIndex ? id : target === undefined ? undefined : legacyIds[target],
					);
				}
				legacyIds.push(entry.id);
				ids.add(entry.id);
				parentId = entry.id;
				migrateToCurrentVersion([{ ...header, version: Math.max(version, 2) }, entry]);
				if (entry.type === "message" && entry.message.role === "assistant") {
					const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
					if (sanitized !== entry.message) {
						entry.message = sanitized;
						migrated = true;
					}
				}
				const position: PositionedSessionEntry = {
					...sessionContextEntryMetadata(entry),
					offset,
					length,
					firstKeptEntryId: entry.type === "compaction" ? entry.firstKeptEntryId : undefined,
				};
				if (target !== undefined && target > arrayIndex) forwardReferences.push({ position, target });
				visit(entry, position);
			},
		});
		// Array migration reads a forward target's original id before that target is
		// migrated. Preserve that exact behavior rather than inventing a future id.
		for (const { position, target } of forwardReferences) {
			if (rawIds[target] !== undefined) position.firstKeptEntryId = rawIds[target];
		}
		if (sourceSize > 0 && header && !invalidHeader) {
			const lastByte = Buffer.allocUnsafe(1);
			if (fs.readSync(sourceFd, lastByte, 0, 1, sourceSize - 1) === 1 && lastByte[0] !== 0x0a) migrated = true;
			transferred = true;
		}
		return {
			entries: header && !invalidHeader ? [header] : [],
			titleSlot,
			malformedRecords,
			sourceSize,
			sourceFd: transferred ? sourceFd : undefined,
			invalidHeader: invalidHeader || (!header && malformedRecords > 0),
			migrated,
		};
	} finally {
		if (!transferred) fs.closeSync(sourceFd);
	}
}

/** Read one record from an open inode; atomic replacement cannot invalidate its offsets. */
export function readPositionedSessionEntry(fd: number, position: PositionedSessionEntry): SessionEntry {
	const bytes = Buffer.allocUnsafe(position.length);
	let read = 0;
	while (read < bytes.length) {
		const count = fs.readSync(fd, bytes, read, bytes.length - read, position.offset + read);
		if (count === 0) throw new Error(`Session entry ${position.id} was truncated`);
		read += count;
	}
	const entry = JSON.parse(bytes.toString("utf8")) as SessionEntry;
	entry.id = position.id;
	entry.parentId = position.parentId;
	if (entry.type === "compaction") {
		entry.firstKeptEntryId = position.firstKeptEntryId!;
		delete (entry as CompactionEntry & { firstKeptEntryIndex?: number }).firstKeptEntryIndex;
	}
	migrateToCurrentVersion([{ type: "session", version: 2 } as SessionHeader, entry]);
	if (entry.type === "message" && entry.message.role === "assistant") {
		entry.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
	}
	repairTruncatedSnapcompactFrames(entry);
	return entry;
}

/**
 * Visit session entries, using bounded streaming for large file-backed journals.
 * Small files and non-file backends keep the existing full-load path.
 */
export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<void> {
	const size = storage.statSync(filePath).size;
	if (shouldStreamEntries(storage, size)) {
		let sawFirstEntry = false;
		await visitEntriesFromFileStream(filePath, entry => {
			if (!sawFirstEntry) {
				sawFirstEntry = true;
				if (!isValidSessionHeader(entry)) return false;
			}
			return visit(entry);
		});
		return;
	}

	for (const entry of (await loadWithKnownSize(filePath, storage, size)).loaded.entries) {
		if (visit(entry) === false) return;
	}
}

function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

/** A persisted blob reference and the field that holds it. */
interface BlobRefSite {
	holder: Record<string, unknown>;
	key: string;
	ref: string;
	/** Provider image URLs persist the whole data URL; image payloads persist bare base64. */
	asDataUrl: boolean;
}

/**
 * Collect the blob references in session image blocks and provider image URLs.
 * Snapcompact frames stay as references until context rebuilding selects them.
 */
function collectBlobRefSites(value: unknown, sites: BlobRefSite[], key?: string): void {
	if (key !== "frames" && isExternalizableImagePosition(value, key) && isBlobRef(value.data)) {
		sites.push({ holder: value, key: "data", ref: value.data, asDataUrl: false });
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) collectBlobRefSites(item, sites, key);
		return;
	}

	if (typeof value !== "object" || value === null) return;
	const holder = value as Record<string, unknown>;
	if (holder.type === "image_generation_call" && typeof holder.result === "string" && isBlobRef(holder.result)) {
		sites.push({ holder, key: "result", ref: holder.result, asDataUrl: false });
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		sites.push({ holder, key: "image_url", ref: value.image_url, asDataUrl: true });
	}

	for (const childKey in holder) collectBlobRefSites(holder[childKey], sites, childKey);
}

/**
 * Cheap synchronous precheck: does this value's tree contain any `blob:sha256:` string?
 * Early-exits on the first hit, so blob-free entries skip the
 * {@link collectBlobRefSites} descent entirely. Conservative — a blob ref in a
 * non-resolved position still returns true, which only costs an extra (no-op) walk.
 */
function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value) {
		if (containsBlobRef((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}

/**
 * Older persistence versions truncated oversized frame base64 in place. Recover
 * those archives from their retained source text so an already-wedged session
 * resumes as text instead of sending malformed image data to the provider.
 */
function repairTruncatedSnapcompactFrames(entry: FileEntry): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive?.frames.some(frame => isPersistenceTruncatedString(frame.data))) return;
	const slot = entry.preserveData?.[snapcompact.PRESERVE_KEY];
	if (typeof slot !== "object" || slot === null) return;

	if (archive.text) {
		Object.assign(slot, { frames: [], textHead: archive.text, textTail: "" });
		return;
	}
	Object.assign(slot, {
		frames: archive.frames.filter(frame => !isPersistenceTruncatedString(frame.data)),
	});
}

function blobRefSites(values: readonly unknown[]): BlobRefSite[] {
	const sites: BlobRefSite[] = [];
	for (const value of values) {
		if (containsBlobRef(value)) collectBlobRefSites(value, sites);
	}
	return sites;
}

function blobSiteKey(site: BlobRefSite): string {
	return `${site.asDataUrl ? "url" : "base64"}:${site.ref}`;
}

async function resolveBlobRefs(values: readonly unknown[], blobStore: BlobStore): Promise<void> {
	const semaphore = new Semaphore(BLOB_READ_CONCURRENCY);
	const resolved = new Map<string, Promise<string>>();
	await Promise.all(
		blobRefSites(values).map(async site => {
			const key = blobSiteKey(site);
			let data = resolved.get(key);
			if (!data) {
				data = (async () => {
					await semaphore.acquire();
					try {
						return await (site.asDataUrl
							? resolveImageDataUrl(blobStore, site.ref)
							: resolveImageData(blobStore, site.ref));
					} finally {
						semaphore.release();
					}
				})();
				resolved.set(key, data);
			}
			site.holder[site.key] = await data;
		}),
	);
}

/** The non-header entries, with legacy truncated snapcompact frames repaired before their blobs resolve. */
function entriesForBlobResolution(entries: FileEntry[]): FileEntry[] {
	const sessionEntries = entries.filter(entry => entry.type !== "session");
	for (const entry of sessionEntries) repairTruncatedSnapcompactFrames(entry);
	return sessionEntries;
}

/** Restore the image data that persistence externalized to the blob store, in place. */
export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await resolveBlobRefs(entriesForBlobResolution(entries), blobStore);
}

/** Synchronous {@link resolveBlobRefsInEntries}. */
export function resolveBlobRefsInEntriesSync(entries: FileEntry[], blobStore: BlobStore): void {
	const resolved = new Map<string, string>();
	for (const site of blobRefSites(entriesForBlobResolution(entries))) {
		const key = blobSiteKey(site);
		let data = resolved.get(key);
		if (data === undefined) {
			data = site.asDataUrl
				? resolveImageDataUrlSync(blobStore, site.ref)
				: resolveImageDataSync(blobStore, site.ref);
			resolved.set(key, data);
		}
		site.holder[site.key] = data;
	}
}

/**
 * Read-only transcript view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the display transcript along
 * the replayed leaf path (including late usage's captured leaf). Uses transcript mode (collapsed to the
 * latest compaction) so failed/aborted tail turns stay visible, unlike the
 * provider-context builder which drops them. Does NOT create a writer or take
 * the session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const blobs = new BlobStore(getBlobsDir());
	const byId = new Map<string, PositionedSessionEntry>();
	let leafId: string | null = null;
	let lastSelfSelected: string | null = null;
	const loaded = await visitSessionFileForResume(filePath, (entry, position) => {
		byId.set(position.id, position);
		leafId = sessionEntryLeafId(entry);
		if (leafId === entry.id) lastSelfSelected = leafId;
	});
	if (leafId !== null && !byId.has(leafId)) leafId = lastSelfSelected;
	let leaf = leafId === null ? undefined : byId.get(leafId);
	if (loaded.invalidHeader || loaded.entries.length === 0 || loaded.sourceFd === undefined) return [];
	const fd = loaded.sourceFd;
	let messages: AgentMessage[];
	try {
		const path: PositionedSessionEntry[] = [];
		const seen = new Set<string>();
		while (leaf && !seen.has(leaf.id)) {
			seen.add(leaf.id);
			path.push(leaf);
			leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
		}
		const options = {
			transcript: true,
			collapseCompactedHistory: true,
			resolveFrameData: (data: string) => lazyImageDataSync(blobs, data),
		};
		const selected = selectSessionContextEntriesFromLeafPath(
			path,
			id => readPositionedSessionEntry(fd, byId.get(id)!),
			options,
		);
		({ messages } = buildSessionContextFromLeafPath(selected, options));
	} finally {
		fs.closeSync(fd);
	}
	// A collapsed summary carries the remote-compaction replacement history for
	// provider replay only; this transcript is never replayed, and the renderer
	// reads just the summary. Dropping it keeps hydration off every image blob
	// buried in that hidden history.
	const displayMessages = messages.map(message =>
		message.role === "compactionSummary" && message.providerPayload !== undefined
			? { ...message, providerPayload: undefined }
			: message,
	);
	await resolveBlobRefs(displayMessages, blobs);
	return displayMessages;
}
